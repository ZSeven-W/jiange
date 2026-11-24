// Package slidessync streams presentation revision notifications and online
// collaborator active-slide presence over WebSocket.
package slidessync

import (
	"cmp"
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/coder/websocket"
)

const (
	outBuffer                = 256
	checkTTL                 = 2 * time.Second
	cursorMinInterval        = 30 * time.Millisecond
	presenterSyncMinInterval = 25 * time.Millisecond
	maxPresenterAnimStep     = 200
)

type Collaborator struct {
	UserID int64  `json:"userId"`
	Name   string `json:"name"`
	PageID int64  `json:"pageId,omitempty"`
}

// PresenterState tracks the active live presenter broadcast for a slides room.
type PresenterState struct {
	PresenterID   int64    `json:"presenterId"`
	PresenterName string   `json:"presenterName"`
	Active        bool     `json:"active"`
	PageID        int64    `json:"pageId"`
	AnimStep      int      `json:"animStep"`
	LaserX        *float64 `json:"laserX,omitempty"`
	LaserY        *float64 `json:"laserY,omitempty"`
}

type Hub struct {
	Log            *slog.Logger
	OriginPatterns []string
	PingInterval   time.Duration
	SweepInterval  time.Duration

	mu    sync.Mutex
	rooms map[int64]*room
}

type room struct {
	hub           *Hub
	id            int64
	refs          int
	seq           int64
	stop          chan struct{}
	mu            sync.Mutex
	conns         map[*conn]struct{}
	presenter     *PresenterState
	presenterConn *conn
}

type conn struct {
	out    chan []byte
	cancel context.CancelFunc
	userID int64
	name   string
	cursor *Collaborator
}

func (h *Hub) log() *slog.Logger {
	if h.Log == nil {
		return slog.New(slog.DiscardHandler)
	}
	return h.Log
}

func (h *Hub) pingInterval() time.Duration {
	if h.PingInterval > 0 {
		return h.PingInterval
	}
	return 20 * time.Second
}

func (h *Hub) sweepInterval() time.Duration {
	if h.SweepInterval > 0 {
		return h.SweepInterval
	}
	return checkTTL
}

func (h *Hub) acquireRoom(id int64) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms == nil {
		h.rooms = map[int64]*room{}
	}
	r := h.rooms[id]
	if r == nil {
		r = &room{
			hub:   h,
			id:    id,
			stop:  make(chan struct{}),
			conns: map[*conn]struct{}{},
		}
		h.rooms[id] = r
	}
	r.refs++
	return r
}

func (h *Hub) releaseRoom(r *room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r.refs--
	if r.refs <= 0 && h.rooms[r.id] == r {
		delete(h.rooms, r.id)
		close(r.stop)
	}
}

// Rooms returns the active room count for tests.
func (h *Hub) Rooms() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms)
}

// Notify broadcasts a deck revision signal to all connected clients in a slides room.
func (h *Hub) Notify(deckID, actorID int64) {
	h.mu.Lock()
	r := h.rooms[deckID]
	h.mu.Unlock()
	if r == nil {
		return
	}
	r.mu.Lock()
	r.seq++
	frame := mustJSON(map[string]any{
		"type":    "revision",
		"seq":     r.seq,
		"actorId": actorID,
	})
	for c := range r.conns {
		c.send(frame)
	}
	r.mu.Unlock()
}

func (r *room) addConn(c *conn) {
	r.mu.Lock()
	r.conns[c] = struct{}{}
	frame := r.presenceLocked()
	for existing := range r.conns {
		existing.send(frame)
	}
	if r.presenter != nil && r.presenter.Active {
		c.send(presenterSyncFrame(*r.presenter))
	}
	r.mu.Unlock()
}

func (r *room) removeConn(c *conn) {
	r.mu.Lock()
	delete(r.conns, c)
	var stopPresenterFrame []byte
	if r.presenterConn == c {
		ended := PresenterState{
			PresenterID:   c.userID,
			PresenterName: c.name,
			Active:        false,
		}
		r.presenter = nil
		r.presenterConn = nil
		stopPresenterFrame = presenterSyncFrame(ended)
	}
	frame := r.presenceLocked()
	for existing := range r.conns {
		existing.send(frame)
		if stopPresenterFrame != nil {
			existing.send(stopPresenterFrame)
		}
	}
	r.mu.Unlock()
}

func clampUnitFloat(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return math.Round(v*10000) / 10000
}

func presenterSyncFrame(state PresenterState) []byte {
	payload := map[string]any{
		"type":          "presenter_sync",
		"presenterId":   state.PresenterID,
		"presenterName": state.PresenterName,
		"active":        state.Active,
		"pageId":        state.PageID,
		"animStep":      state.AnimStep,
	}
	if state.LaserX != nil && state.LaserY != nil {
		payload["laserX"] = *state.LaserX
		payload["laserY"] = *state.LaserY
	}
	return mustJSON(payload)
}

func (r *room) updatePresenterSync(c *conn, active bool, pageID int64, animStep int, laserX, laserY *float64) {
	if pageID < 0 {
		pageID = 0
	}
	if animStep < 0 {
		animStep = 0
	} else if animStep > maxPresenterAnimStep {
		animStep = maxPresenterAnimStep
	}
	var cleanX, cleanY *float64
	if active && laserX != nil && laserY != nil &&
		!math.IsNaN(*laserX) && !math.IsInf(*laserX, 0) &&
		!math.IsNaN(*laserY) && !math.IsInf(*laserY, 0) {
		vx := clampUnitFloat(*laserX)
		vy := clampUnitFloat(*laserY)
		cleanX = &vx
		cleanY = &vy
	}

	r.mu.Lock()
	var state PresenterState
	if active {
		state = PresenterState{
			PresenterID:   c.userID,
			PresenterName: c.name,
			Active:        true,
			PageID:        pageID,
			AnimStep:      animStep,
			LaserX:        cleanX,
			LaserY:        cleanY,
		}
		copied := state
		r.presenter = &copied
		r.presenterConn = c
	} else {
		if r.presenterConn != c && (r.presenter == nil || r.presenter.PresenterID != c.userID) {
			r.mu.Unlock()
			return
		}
		state = PresenterState{
			PresenterID:   c.userID,
			PresenterName: c.name,
			Active:        false,
			PageID:        0,
			AnimStep:      0,
		}
		r.presenter = nil
		r.presenterConn = nil
	}
	frame := presenterSyncFrame(state)
	for existing := range r.conns {
		existing.send(frame)
	}
	r.mu.Unlock()
}

func (r *room) updateCursor(c *conn, pageID int64) {
	r.mu.Lock()
	c.cursor = &Collaborator{
		UserID: c.userID,
		Name:   c.name,
		PageID: pageID,
	}
	frame := r.presenceLocked()
	for existing := range r.conns {
		existing.send(frame)
	}
	r.mu.Unlock()
}

func (r *room) presenceLocked() []byte {
	byUser := map[int64]Collaborator{}
	for c := range r.conns {
		if c.cursor != nil {
			byUser[c.userID] = *c.cursor
		} else if _, exists := byUser[c.userID]; !exists {
			byUser[c.userID] = Collaborator{UserID: c.userID, Name: c.name}
		}
	}
	list := make([]Collaborator, 0, len(byUser))
	for _, col := range byUser {
		list = append(list, col)
	}
	slices.SortFunc(list, func(a, b Collaborator) int {
		return cmp.Compare(a.UserID, b.UserID)
	})
	return mustJSON(map[string]any{
		"type":          "presence",
		"collaborators": list,
	})
}

func (c *conn) send(frame []byte) {
	select {
	case c.out <- frame:
	default:
		c.cancel()
	}
}

// Serve upgrades the HTTP connection and streams deck presence and revision invalidations.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, deckID int64, user store.User, check func(context.Context) error) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: h.OriginPatterns,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(16 << 10)
	defer ws.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	rm := h.acquireRoom(deckID)
	defer h.releaseRoom(rm)

	c := &conn{
		out:    make(chan []byte, outBuffer),
		cancel: cancel,
		userID: user.ID,
		name:   user.Name,
	}
	rm.addConn(c)
	defer rm.removeConn(c)

	done := make(chan struct{})
	go func() {
		defer close(done)
		ping := time.NewTicker(h.pingInterval())
		defer ping.Stop()
		verify := time.NewTicker(h.sweepInterval())
		defer verify.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-c.out:
				wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
				err := ws.Write(wctx, websocket.MessageText, msg)
				wcancel()
				if err != nil {
					cancel()
					return
				}
			case <-ping.C:
				pctx, pcancel := context.WithTimeout(ctx, 5*time.Second)
				err := ws.Ping(pctx)
				pcancel()
				if err != nil {
					cancel()
					return
				}
			case <-verify.C:
				if check != nil {
					cctx, ccancel := context.WithTimeout(ctx, 3*time.Second)
					err := check(cctx)
					ccancel()
					if err != nil {
						_ = ws.Close(websocket.StatusPolicyViolation, "access revoked")
						cancel()
						return
					}
				}
			}
		}
	}()

	var (
		lastCursor         time.Time
		lastPresenterSync  time.Time
		lastPresenterState struct {
			has      bool
			active   bool
			pageID   int64
			animStep int
		}
	)
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			cancel()
			break
		}
		var in struct {
			Type     string   `json:"type"`
			PageID   int64    `json:"pageId"`
			Active   *bool    `json:"active"`
			AnimStep int      `json:"animStep"`
			LaserX   *float64 `json:"laserX"`
			LaserY   *float64 `json:"laserY"`
		}
		if json.Unmarshal(data, &in) != nil {
			continue
		}
		if in.Type == "cursor" && in.PageID >= 0 {
			now := time.Now()
			if now.Sub(lastCursor) < cursorMinInterval {
				continue
			}
			lastCursor = now
			rm.updateCursor(c, in.PageID)
		} else if in.Type == "presenter_sync" {
			active := in.Active != nil && *in.Active
			now := time.Now()
			// Only rate-limit high-frequency laser-only updates; never drop active/page/step changes.
			sameSlideStep := lastPresenterState.has &&
				lastPresenterState.active == active &&
				active &&
				lastPresenterState.pageID == in.PageID &&
				lastPresenterState.animStep == in.AnimStep
			if sameSlideStep && now.Sub(lastPresenterSync) < presenterSyncMinInterval {
				continue
			}
			lastPresenterSync = now
			lastPresenterState.has = true
			lastPresenterState.active = active
			lastPresenterState.pageID = in.PageID
			lastPresenterState.animStep = in.AnimStep
			rm.updatePresenterSync(c, active, in.PageID, in.AnimStep, in.LaserX, in.LaserY)
		}
	}
	<-done
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

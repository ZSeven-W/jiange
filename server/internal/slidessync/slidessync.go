// Package slidessync streams presentation revision notifications and online
// collaborator active-slide presence over WebSocket.
package slidessync

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
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
	// RealtimeChannel is the Postgres LISTEN/NOTIFY channel used for cross-replica slides sync.
	RealtimeChannel = store.RealtimeChannelSlides

	outBuffer                = 256
	checkTTL                 = 2 * time.Second
	cursorMinInterval        = 30 * time.Millisecond
	presenterSyncMinInterval = 25 * time.Millisecond
	maxPresenterAnimStep     = 200
	publishTimeout           = 5 * time.Second
	maxBusPayloadBytes       = 7500
	remotePresenceTTL        = 90 * time.Second
)

type slidesBusEvent struct {
	Origin       string          `json:"origin"`
	Kind         string          `json:"kind"` // "revision" | "cursor" | "leave" | "presenter"
	DeckID       int64           `json:"deckId"`
	ActorID      int64           `json:"actorId,omitempty"`
	Collaborator *Collaborator   `json:"collaborator,omitempty"`
	UserID       int64           `json:"userId,omitempty"`
	Presenter    *PresenterState `json:"presenter,omitempty"`
}

type remotePeerKey struct {
	origin string
	userID int64
}

type remoteCollaborator struct {
	collaborator Collaborator
	updatedAt    time.Time
}

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
	// Bus enables multi-replica fan-out over Postgres LISTEN/NOTIFY (or an in-process bus in tests).
	Bus            store.RealtimeBus
	Log            *slog.Logger
	OriginPatterns []string
	PingInterval   time.Duration
	SweepInterval  time.Duration

	mu         sync.Mutex
	instanceID string
	rooms      map[int64]*room
}

type room struct {
	hub             *Hub
	id              int64
	refs            int
	seq             int64
	stop            chan struct{}
	mu              sync.Mutex
	conns           map[*conn]struct{}
	remote          map[remotePeerKey]remoteCollaborator
	presenter       *PresenterState
	presenterConn   *conn
	presenterOrigin string
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
			hub:    h,
			id:     id,
			stop:   make(chan struct{}),
			conns:  map[*conn]struct{}{},
			remote: map[remotePeerKey]remoteCollaborator{},
		}
		h.rooms[id] = r
	}
	r.refs++
	return r
}

func (h *Hub) originID() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.instanceID == "" {
		var buf [12]byte
		_, _ = rand.Read(buf[:])
		h.instanceID = hex.EncodeToString(buf[:])
	}
	return h.instanceID
}

func (h *Hub) publishEvent(ev slidesBusEvent) {
	if h.Bus == nil || ev.DeckID <= 0 {
		return
	}
	ev.Origin = h.originID()
	raw := mustJSON(ev)
	if len(raw) == 0 || len(raw) > maxBusPayloadBytes {
		return
	}
	payload := string(raw)
	bus := h.Bus
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), publishTimeout)
		defer cancel()
		if err := bus.PublishRealtime(ctx, RealtimeChannel, payload); err != nil {
			h.log().Warn("slides realtime publish", "deck", ev.DeckID, "kind", ev.Kind, "err", err)
		}
	}()
}

// Run consumes cross-replica presentation revision, collaborator presence, and
// live presenter sync events from Bus until ctx ends.
func (h *Hub) Run(ctx context.Context) error {
	if h.Bus == nil {
		<-ctx.Done()
		return nil
	}
	origin := h.originID()
	return h.Bus.ListenRealtime(ctx, RealtimeChannel, func(payload string) {
		var ev slidesBusEvent
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			return
		}
		if ev.Origin == origin || ev.DeckID <= 0 {
			return
		}
		switch ev.Kind {
		case "revision":
			h.applyRevisionLocal(ev.DeckID, ev.ActorID)
		case "cursor":
			if ev.Collaborator != nil && ev.Collaborator.UserID > 0 {
				h.applyRemoteCursor(ev.DeckID, ev.Origin, *ev.Collaborator)
			}
		case "leave":
			if ev.UserID > 0 {
				h.applyRemoteLeave(ev.DeckID, ev.Origin, ev.UserID)
			}
		case "presenter":
			if ev.Presenter != nil {
				h.applyRemotePresenter(ev.DeckID, ev.Origin, *ev.Presenter)
			}
		}
	})
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

func (h *Hub) applyRevisionLocal(deckID, actorID int64) {
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

// Notify broadcasts a deck revision signal to all connected clients in a slides room
// and publishes it to Bus for remote replicas.
func (h *Hub) Notify(deckID, actorID int64) {
	h.applyRevisionLocal(deckID, actorID)
	h.publishEvent(slidesBusEvent{
		Kind:    "revision",
		DeckID:  deckID,
		ActorID: actorID,
	})
}

func (h *Hub) applyRemoteCursor(deckID int64, origin string, col Collaborator) {
	h.mu.Lock()
	r := h.rooms[deckID]
	h.mu.Unlock()
	if r == nil {
		return
	}
	r.mu.Lock()
	if r.remote == nil {
		r.remote = map[remotePeerKey]remoteCollaborator{}
	}
	r.remote[remotePeerKey{origin: origin, userID: col.UserID}] = remoteCollaborator{
		collaborator: col,
		updatedAt:    time.Now(),
	}
	frame := r.presenceLocked()
	for existing := range r.conns {
		existing.send(frame)
	}
	r.mu.Unlock()
}

func (h *Hub) applyRemoteLeave(deckID int64, origin string, userID int64) {
	h.mu.Lock()
	r := h.rooms[deckID]
	h.mu.Unlock()
	if r == nil {
		return
	}
	r.mu.Lock()
	key := remotePeerKey{origin: origin, userID: userID}
	if _, ok := r.remote[key]; !ok {
		r.mu.Unlock()
		return
	}
	delete(r.remote, key)
	frame := r.presenceLocked()
	for existing := range r.conns {
		existing.send(frame)
	}
	r.mu.Unlock()
}

func sanitizePresenterState(in PresenterState) PresenterState {
	if in.PageID < 0 {
		in.PageID = 0
	}
	if in.AnimStep < 0 {
		in.AnimStep = 0
	} else if in.AnimStep > maxPresenterAnimStep {
		in.AnimStep = maxPresenterAnimStep
	}
	var cleanX, cleanY *float64
	if in.Active && in.LaserX != nil && in.LaserY != nil &&
		!math.IsNaN(*in.LaserX) && !math.IsInf(*in.LaserX, 0) &&
		!math.IsNaN(*in.LaserY) && !math.IsInf(*in.LaserY, 0) {
		vx := clampUnitFloat(*in.LaserX)
		vy := clampUnitFloat(*in.LaserY)
		cleanX = &vx
		cleanY = &vy
	}
	in.LaserX = cleanX
	in.LaserY = cleanY
	return in
}

func (h *Hub) applyRemotePresenter(deckID int64, origin string, incoming PresenterState) {
	h.mu.Lock()
	r := h.rooms[deckID]
	h.mu.Unlock()
	if r == nil {
		return
	}
	state := sanitizePresenterState(incoming)
	r.mu.Lock()
	if state.Active {
		copied := state
		r.presenter = &copied
		r.presenterConn = nil
		r.presenterOrigin = origin
	} else {
		if r.presenter != nil && r.presenter.PresenterID != state.PresenterID && r.presenterOrigin != origin {
			r.mu.Unlock()
			return
		}
		r.presenter = nil
		r.presenterConn = nil
		r.presenterOrigin = ""
	}
	frame := presenterSyncFrame(state)
	for existing := range r.conns {
		existing.send(frame)
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
	cur := Collaborator{UserID: c.userID, Name: c.name}
	r.mu.Unlock()
	r.hub.publishEvent(slidesBusEvent{
		Kind:         "cursor",
		DeckID:       r.id,
		Collaborator: &cur,
	})
}

func (r *room) removeConn(c *conn) {
	r.mu.Lock()
	delete(r.conns, c)
	var stopPresenterFrame []byte
	var endedPresenter *PresenterState
	if r.presenterConn == c {
		ended := PresenterState{
			PresenterID:   c.userID,
			PresenterName: c.name,
			Active:        false,
		}
		r.presenter = nil
		r.presenterConn = nil
		r.presenterOrigin = ""
		stopPresenterFrame = presenterSyncFrame(ended)
		endedPresenter = &ended
	}
	var remaining *Collaborator
	for other := range r.conns {
		if other.userID == c.userID {
			if other.cursor != nil {
				cp := *other.cursor
				remaining = &cp
				break
			}
			if remaining == nil {
				cp := Collaborator{UserID: other.userID, Name: other.name}
				remaining = &cp
			}
		}
	}
	frame := r.presenceLocked()
	for existing := range r.conns {
		existing.send(frame)
		if stopPresenterFrame != nil {
			existing.send(stopPresenterFrame)
		}
	}
	r.mu.Unlock()
	if endedPresenter != nil {
		r.hub.publishEvent(slidesBusEvent{
			Kind:      "presenter",
			DeckID:    r.id,
			Presenter: endedPresenter,
		})
	}
	if remaining != nil {
		r.hub.publishEvent(slidesBusEvent{
			Kind:         "cursor",
			DeckID:       r.id,
			Collaborator: remaining,
		})
	} else {
		r.hub.publishEvent(slidesBusEvent{
			Kind:   "leave",
			DeckID: r.id,
			UserID: c.userID,
		})
	}
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
	clean := sanitizePresenterState(PresenterState{
		PresenterID:   c.userID,
		PresenterName: c.name,
		Active:        active,
		PageID:        pageID,
		AnimStep:      animStep,
		LaserX:        laserX,
		LaserY:        laserY,
	})

	r.mu.Lock()
	var state PresenterState
	if active {
		state = clean
		copied := state
		r.presenter = &copied
		r.presenterConn = c
		r.presenterOrigin = r.hub.originID()
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
		r.presenterOrigin = ""
	}
	frame := presenterSyncFrame(state)
	for existing := range r.conns {
		existing.send(frame)
	}
	r.mu.Unlock()

	copied := state
	r.hub.publishEvent(slidesBusEvent{
		Kind:      "presenter",
		DeckID:    r.id,
		Presenter: &copied,
	})
}

func (r *room) updateCursor(c *conn, pageID int64) {
	r.mu.Lock()
	cur := Collaborator{
		UserID: c.userID,
		Name:   c.name,
		PageID: pageID,
	}
	c.cursor = &cur
	frame := r.presenceLocked()
	for existing := range r.conns {
		existing.send(frame)
	}
	r.mu.Unlock()
	r.hub.publishEvent(slidesBusEvent{
		Kind:         "cursor",
		DeckID:       r.id,
		Collaborator: &cur,
	})
}

func (r *room) presenceLocked() []byte {
	now := time.Now()
	for k, entry := range r.remote {
		if now.Sub(entry.updatedAt) > remotePresenceTTL {
			delete(r.remote, k)
		}
	}
	byUser := map[int64]Collaborator{}
	for c := range r.conns {
		if c.cursor != nil {
			byUser[c.userID] = *c.cursor
		} else if _, exists := byUser[c.userID]; !exists {
			byUser[c.userID] = Collaborator{UserID: c.userID, Name: c.name}
		}
	}
	for _, entry := range r.remote {
		col := entry.collaborator
		if existing, exists := byUser[col.UserID]; !exists || (col.PageID > 0 && existing.PageID == 0) {
			byUser[col.UserID] = col
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

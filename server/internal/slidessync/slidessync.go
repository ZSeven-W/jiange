// Package slidessync streams presentation revision notifications and online
// collaborator active-slide presence over WebSocket.
package slidessync

import (
	"cmp"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/coder/websocket"
)

const (
	outBuffer         = 256
	checkTTL          = 2 * time.Second
	cursorMinInterval = 30 * time.Millisecond
)

type Collaborator struct {
	UserID int64  `json:"userId"`
	Name   string `json:"name"`
	PageID int64  `json:"pageId,omitempty"`
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
	hub   *Hub
	id    int64
	refs  int
	seq   int64
	stop  chan struct{}
	mu    sync.Mutex
	conns map[*conn]struct{}
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
	r.mu.Unlock()
}

func (r *room) removeConn(c *conn) {
	r.mu.Lock()
	delete(r.conns, c)
	frame := r.presenceLocked()
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

	var lastCursor time.Time
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			cancel()
			break
		}
		var in struct {
			Type   string `json:"type"`
			PageID int64  `json:"pageId"`
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
		}
	}
	<-done
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

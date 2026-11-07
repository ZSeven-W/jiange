// Package btsync streams bitable change events over WebSocket. One room per
// open base: every REST mutation appends an event to bt_events and pokes the
// room, which fans the log out to connections in seq order. Clients apply
// events in order, so concurrent writes to a cell converge everywhere with
// the last committed write winning. After a disconnect a client resends its
// last seen seq and the room replays everything after it.
package btsync

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	catchUpChunk = 500
	outBuffer    = 512
)

type Hub struct {
	Store store.DocStore
	Log   *slog.Logger
	// OriginPatterns are extra allowed browser origins (host[:port]).
	OriginPatterns []string
	PingInterval   time.Duration

	mu    sync.Mutex
	rooms map[int64]*room
}

func (h *Hub) log() *slog.Logger {
	if h.Log == nil {
		return slog.New(slog.DiscardHandler)
	}
	return h.Log
}

func (h *Hub) room(id int64) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms == nil {
		h.rooms = map[int64]*room{}
	}
	r := h.rooms[id]
	if r == nil {
		r = &room{hub: h, id: id, conns: map[*conn]struct{}{}, stop: make(chan struct{})}
		// history before the room existed is only fetched per-client on replay
		r.head, _ = h.Store.BtHead(context.Background(), id)
		h.rooms[id] = r
		go r.sweepLoop()
	}
	r.refs++
	return r
}

func (h *Hub) release(r *room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r.refs--
	if r.refs == 0 && h.rooms[r.id] == r {
		delete(h.rooms, r.id)
		close(r.stop)
	}
}

// Notify pokes a base's room so it streams newly appended events.
func (h *Hub) Notify(baseID int64) {
	h.mu.Lock()
	r := h.rooms[baseID]
	h.mu.Unlock()
	if r != nil {
		r.catchUp()
	}
}

// Rooms reports the number of open rooms (tests and metrics).
func (h *Hub) Rooms() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms)
}

// Serve upgrades an authenticated request for one base and blocks until the
// connection ends. Messages from the client are only hello {lastSeq}.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, baseID int64, checks ...func(context.Context) error) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.OriginPatterns})
	if err != nil {
		return
	}
	ws.SetReadLimit(1 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	var check func(context.Context) error
	if len(checks) > 0 {
		check = checks[0]
	}
	c := &conn{out: make(chan []byte, outBuffer)}
	go c.writeLoop(ctx, ws, check, cancel)
	room := h.room(baseID)
	defer h.release(room)
	room.join(c)
	defer room.remove(c)
	go func() {
		// read loop: client messages are just hello replays
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				cancel()
				return
			}
			var msg struct {
				T       string `json:"t"`
				LastSeq int64  `json:"lastSeq"`
			}
			if json.Unmarshal(data, &msg) == nil && msg.T == "hello" {
				if check != nil && check(ctx) != nil {
					cancel()
					return
				}
				room.replay(c, msg.LastSeq)
			}
		}
	}()
	ping := time.NewTicker(h.pingInterval())
	defer ping.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-ping.C:
				if check != nil && check(ctx) != nil {
					cancel()
					return
				}
				if err := ws.Ping(ctx); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	<-ctx.Done()
	ws.Close(websocket.StatusNormalClosure, "")
}

func (h *Hub) pingInterval() time.Duration {
	if h.PingInterval > 0 {
		return h.PingInterval
	}
	return 20 * time.Second
}

type room struct {
	hub   *Hub
	id    int64
	refs  int // guarded by hub.mu
	stop  chan struct{}
	mu    sync.Mutex
	head  int64
	conns map[*conn]struct{}
}

// join registers a connection and tells it the room's current head. The
// client answers with its own lastSeq; replay fills the gap.
func (r *room) join(c *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.conns[c] = struct{}{}
	c.send(mustJSON(map[string]any{"t": "hello", "head": r.head}))
}

func (r *room) remove(c *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.conns, c)
}

// replay sends everything after lastSeq to one connection. Serialized
// against catchUp by the room lock, so events arrive in seq order.
func (r *room) replay(c *conn, lastSeq int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if lastSeq > r.head {
		lastSeq = r.head
	}
	for from := lastSeq; from < r.head; {
		events, err := r.hub.Store.BtEventsAfter(context.Background(), r.id, from, catchUpChunk)
		if err != nil {
			r.hub.log().Error("bt replay", "base", r.id, "err", err)
			return
		}
		if len(events) == 0 {
			return
		}
		c.send(mustJSON(map[string]any{"t": "events", "events": events}))
		from = events[len(events)-1].Seq
	}
}

// catchUp streams newly persisted events to every connection.
func (r *room) catchUp() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for {
		events, err := r.hub.Store.BtEventsAfter(context.Background(), r.id, r.head, catchUpChunk)
		if err != nil {
			r.hub.log().Error("bt catch up", "base", r.id, "err", err)
			return
		}
		if len(events) == 0 {
			return
		}
		msg := mustJSON(map[string]any{"t": "events", "events": events})
		for c := range r.conns {
			c.send(msg)
		}
		r.head = events[len(events)-1].Seq
		if len(events) < catchUpChunk {
			return
		}
	}
}

// sweepLoop periodically catches up so events appended by other instances
// (or missed notifies) still reach connections.
func (r *room) sweepLoop() {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-t.C:
			r.catchUp()
		}
	}
}

type conn struct {
	out chan []byte
}

// send queues a frame; a slow consumer is dropped instead of stalling the room.
func (c *conn) send(b []byte) {
	select {
	case c.out <- b:
	default:
	}
}

func (c *conn) writeLoop(ctx context.Context, ws *websocket.Conn, check func(context.Context) error, cancel context.CancelFunc) {
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-c.out:
			// Re-evaluate access immediately before every replay or live frame.
			// The payload can include the complete row, including hidden fields.
			if check != nil && check(ctx) != nil {
				cancel()
				return
			}
			if err := ws.Write(ctx, websocket.MessageText, b); err != nil {
				cancel()
				return
			}
		}
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

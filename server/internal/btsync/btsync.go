// Package btsync streams bitable change events over WebSocket. One room per
// open base: every REST mutation appends an event to bt_events and pokes the
// room, which fans the log out to connections in ID order. IDs are global,
// so gaps do not indicate missing events for this Base. Clients should use
// events as invalidation hints and fetch an authorized snapshot until the
// protocol has per-Base sequencing and an atomic snapshot/head.
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
	catchUpChunk   = 500
	catchUpBatches = 8
	outBuffer      = 512
	storeTimeout   = 5 * time.Second
	replayTimeout  = 15 * time.Second
)

type Hub struct {
	Store store.DocStore
	Log   *slog.Logger
	// OriginPatterns are extra allowed browser origins (host[:port]).
	OriginPatterns []string
	PingInterval   time.Duration
	// StoreTimeout bounds head/replay queries so a stalled store cannot keep a
	// room or request blocked indefinitely. Zero uses the default.
	StoreTimeout time.Duration
	// ReplayTimeout bounds the whole replay, including waiting for the room.
	ReplayTimeout time.Duration

	mu           sync.Mutex
	rooms        map[int64]*room
	initializing map[int64]*roomInit
}

type roomInit struct {
	done     chan struct{}
	head     int64
	err      error
	waiters  int
	finished bool
}

func (h *Hub) log() *slog.Logger {
	if h.Log == nil {
		return slog.New(slog.DiscardHandler)
	}
	return h.Log
}

func (h *Hub) room(ctx context.Context, id int64) (*room, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	h.mu.Lock()
	if h.rooms == nil {
		h.rooms = map[int64]*room{}
	}
	r := h.rooms[id]
	if r != nil {
		r.refs++
		h.mu.Unlock()
		return r, nil
	}
	if h.initializing == nil {
		h.initializing = map[int64]*roomInit{}
	}
	pending := h.initializing[id]
	if pending == nil {
		pending = &roomInit{done: make(chan struct{})}
		h.initializing[id] = pending
		go h.initializeHead(id, pending)
	}
	pending.waiters++
	h.mu.Unlock()
	select {
	case <-ctx.Done():
	case <-pending.done:
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	pending.waiters--
	if pending.finished && pending.waiters == 0 && h.initializing[id] == pending {
		delete(h.initializing, id)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if pending.err != nil {
		return nil, pending.err
	}
	// Another waiter may already have created the room. Conversely, all
	// waiters may have canceled; in that case no idle room is created.
	r = h.rooms[id]
	if r == nil {
		r = &room{hub: h, id: id, head: pending.head, conns: map[*conn]struct{}{}, stop: make(chan struct{}), wake: make(chan struct{}, 1)}
		h.rooms[id] = r
		go r.sweepLoop()
	}
	r.refs++
	return r, nil
}

func (h *Hub) initializeHead(id int64, pending *roomInit) {
	// Share one bounded query across simultaneous connections. Its lifetime is
	// independent of any single caller, so one disconnect cannot cancel it for
	// every other client; it never creates a room unless a waiter claims it.
	ctx, cancel := context.WithTimeout(context.Background(), h.storeTimeout())
	head, err := h.Store.BtHead(ctx, id)
	cancel()
	h.mu.Lock()
	defer h.mu.Unlock()
	pending.head, pending.err, pending.finished = head, err, true
	if pending.waiters == 0 && h.initializing[id] == pending {
		delete(h.initializing, id)
	}
	close(pending.done)
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
		// Coalesce notifications without making the mutating HTTP request wait
		// on a slow store. The periodic sweep remains the missed-wakeup fallback.
		select {
		case r.wake <- struct{}{}:
		default:
		}
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
	c := &conn{out: make(chan []byte, outBuffer), cancel: cancel}
	go c.writeLoop(ctx, ws, check, cancel)
	room, err := h.room(ctx, baseID)
	if err != nil {
		h.log().Error("bt room head", "base", baseID, "err", err)
		ws.Close(websocket.StatusInternalError, "unable to load Base state")
		return
	}
	defer h.release(room)
	if !room.join(ctx, c) {
		return
	}
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
				room.replay(ctx, c, msg.LastSeq)
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

func (h *Hub) storeTimeout() time.Duration {
	if h.StoreTimeout > 0 {
		return h.StoreTimeout
	}
	return storeTimeout
}

func (h *Hub) replayTimeout() time.Duration {
	if h.ReplayTimeout > 0 {
		return h.ReplayTimeout
	}
	return replayTimeout
}

type room struct {
	hub   *Hub
	id    int64
	refs  int // guarded by hub.mu
	stop  chan struct{}
	wake  chan struct{}
	mu    sync.Mutex
	head  int64
	conns map[*conn]struct{}
}

// join registers a connection and tells it the room's current head. The
// client answers with its own lastSeq; replay fills the gap.
func (r *room) join(ctx context.Context, c *conn) bool {
	ctx, stop := context.WithTimeout(ctx, r.hub.replayTimeout())
	defer stop()
	if !lockRoom(ctx, &r.mu) {
		if c.cancel != nil {
			c.cancel()
		}
		return false
	}
	defer r.mu.Unlock()
	if ctx.Err() != nil {
		if c.cancel != nil {
			c.cancel()
		}
		return false
	}
	r.conns[c] = struct{}{}
	if !c.send(mustJSON(map[string]any{"t": "hello", "head": r.head})) {
		delete(r.conns, c)
		return false
	}
	return true
}

func (r *room) remove(c *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.conns, c)
}

// replay sends everything after lastSeq to one connection. Serialized
// against catchUp by the room lock, so events arrive in seq order.
func (r *room) replay(ctx context.Context, c *conn, lastSeq int64) {
	ctx, stop := context.WithTimeout(ctx, r.hub.replayTimeout())
	defer stop()
	if !lockRoom(ctx, &r.mu) {
		if c.cancel != nil {
			c.cancel()
		}
		return
	}
	defer r.mu.Unlock()
	if ctx.Err() != nil {
		if c.cancel != nil {
			c.cancel()
		}
		return
	}
	if lastSeq > r.head {
		lastSeq = r.head
	}
	for from := lastSeq; from < r.head; {
		queryCtx, cancel := context.WithTimeout(ctx, r.hub.storeTimeout())
		events, err := r.hub.Store.BtEventsAfter(queryCtx, r.id, from, catchUpChunk)
		cancel()
		if err != nil {
			r.hub.log().Error("bt replay", "base", r.id, "err", err)
			// A partial replay cannot establish a safe checkpoint. Reconnect
			// forces the client to fetch a fresh authorized snapshot.
			if c.cancel != nil {
				c.cancel()
			}
			return
		}
		if len(events) == 0 {
			if c.cancel != nil {
				c.cancel()
			}
			return
		}
		if !c.send(invalidationFrame(events)) {
			return
		}
		from = events[len(events)-1].Seq
	}
}

// A disconnected client must not remain queued behind a long replay or
// catch-up while keeping its goroutine alive. TryLock is only polled when the
// room is contended; the context bounds both queueing and storage work.
func lockRoom(ctx context.Context, mu *sync.Mutex) bool {
	if mu.TryLock() {
		return true
	}
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			if mu.TryLock() {
				return true
			}
		}
	}
}

// catchUp streams newly persisted events to every connection.
func (r *room) catchUp() {
	r.mu.Lock()
	defer r.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), r.hub.storeTimeout())
	defer cancel()
	for batch := 0; batch < catchUpBatches; batch++ {
		events, err := r.hub.Store.BtEventsAfter(ctx, r.id, r.head, catchUpChunk)
		if err != nil {
			r.hub.log().Error("bt catch up", "base", r.id, "err", err)
			return
		}
		if len(events) == 0 {
			return
		}
		msg := invalidationFrame(events)
		for c := range r.conns {
			c.send(msg)
		}
		r.head = events[len(events)-1].Seq
		if len(events) < catchUpChunk {
			return
		}
	}
	// Yield the room lock after a bounded amount of work. If writes continue
	// faster than one sweep, arrange another pass without starving join/replay.
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// Store events can contain full cells, including links to other Bases the
// receiver cannot access. Never send raw payloads: even unrestricted Base
// readers may not have permission to those targets. Preserve sequence IDs and
// the existing reload kind so older clients refetch an authorized snapshot.
func invalidationFrame(events []store.BtEvent) []byte {
	type hint struct {
		Seq  int64          `json:"seq"`
		Body map[string]any `json:"body"`
	}
	hints := make([]hint, 0, len(events))
	for _, event := range events {
		hints = append(hints, hint{Seq: event.Seq, Body: map[string]any{"kind": "reload"}})
	}
	return mustJSON(map[string]any{"t": "events", "events": hints})
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
		case <-r.wake:
			r.catchUp()
		case <-t.C:
			r.catchUp()
		}
	}
}

type conn struct {
	out    chan []byte
	cancel context.CancelFunc
}

// send queues a frame; a slow consumer is dropped instead of stalling the room.
func (c *conn) send(b []byte) bool {
	select {
	case c.out <- b:
		return true
	default:
		if c.cancel != nil {
			c.cancel()
		}
		return false
	}
}

func (c *conn) writeLoop(ctx context.Context, ws *websocket.Conn, check func(context.Context) error, cancel context.CancelFunc) {
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-c.out:
			if ctx.Err() != nil {
				return
			}
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

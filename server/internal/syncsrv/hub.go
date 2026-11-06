// Package syncsrv is Jiange's self-written realtime sync server: one room per
// open document, server-assigned sequence numbers, acks, catch-up, presence,
// snapshots with tombstone compaction, and cross-instance fan-out via the
// store's notifications (Postgres LISTEN/NOTIFY). See spec/PROTOCOL.md §Sync.
package syncsrv

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// InitialOps returns the ops every new document starts with: a title block
// (holding title, if any) and one empty paragraph, authored by the reserved client 0.
func InitialOps(title string) []store.RawOp {
	d := collab.NewDoc()
	ops := []collab.Op{
		d.CreateBlock(0, collab.Root, "U", "title"),
		d.CreateBlock(0, collab.Root, "V", "paragraph"),
	}
	if title != "" {
		ops = append(ops, d.InsertText(0, ops[0].ID, 0, title))
	}
	out := make([]store.RawOp, len(ops))
	for i, op := range ops {
		b, _ := collab.EncodeOps([]collab.Op{op})
		out[i] = store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b}
	}
	return out
}

type Hub struct {
	Store store.DocStore
	Log   *slog.Logger
	// OriginPatterns are extra allowed browser origins (host[:port]); same-origin is always allowed.
	OriginPatterns []string
	// SnapshotEvery ops since the last snapshot trigger a new one (default 200).
	SnapshotEvery int64
	// GCWindow: clients unseen for longer don't hold back the GC horizon (default 30 days).
	GCWindow     time.Duration
	PingInterval time.Duration
	Now          func() time.Time

	mu    sync.Mutex
	rooms map[int64]*room
}

func (h *Hub) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

func (h *Hub) defaults() {
	if h.SnapshotEvery == 0 {
		h.SnapshotEvery = 200
	}
	if h.GCWindow == 0 {
		h.GCWindow = 30 * 24 * time.Hour
	}
	if h.PingInterval == 0 {
		h.PingInterval = 20 * time.Second
	}
	if h.Log == nil {
		h.Log = slog.New(slog.DiscardHandler)
	}
}

// Run consumes store notifications until ctx ends (multi-instance fan-out).
func (h *Hub) Run(ctx context.Context) error {
	return h.Store.Listen(ctx, func(doc, head int64) {
		h.mu.Lock()
		r := h.rooms[doc]
		h.mu.Unlock()
		if r != nil {
			go r.remoteHead(head)
		}
	})
}

func (h *Hub) room(id int64) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms == nil {
		h.rooms = map[int64]*room{}
	}
	r := h.rooms[id]
	if r == nil {
		r = &room{hub: h, id: id, conns: map[*conn]struct{}{}}
		h.rooms[id] = r
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
	}
}

// Rooms reports the number of open rooms (for tests and metrics).
func (h *Hub) Rooms() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms)
}

// Serve upgrades an authenticated request to a sync connection and blocks until it ends.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, user store.User, authenticate func(context.Context) error) {
	h.defaults()
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.OriginPatterns})
	if err != nil {
		return
	}
	ws.SetReadLimit(8 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &conn{hub: h, ws: ws, user: user, out: make(chan []byte, 512), owned: map[uint64]bool{}, cancel: cancel, authenticate: authenticate}
	wctx, stopWriter := context.WithCancel(context.Background())
	writerDone := make(chan struct{})
	go func() { c.writeLoop(wctx, ctx); close(writerDone) }()
	err = c.readLoop(ctx)
	status := websocket.StatusNormalClosure
	var ce websocket.CloseError
	if err != nil && !errors.As(err, &ce) && ctx.Err() == nil {
		h.Log.Debug("sync conn ended", "err", err)
		status = websocket.StatusInternalError
	}
	if c.room != nil {
		c.room.leave(c)
		h.release(c.room)
	}
	stopWriter()
	<-writerDone
	// flush frames queued before the end (e.g. a final ERROR) without blocking long
	fctx, cancelFlush := context.WithTimeout(context.Background(), time.Second)
	for flushing := true; flushing; {
		select {
		case b := <-c.out:
			// The writer may have stopped because access was revoked. Never
			// bypass its authorization check while draining queued frames.
			if _, err := c.currentRole(fctx); err != nil || ws.Write(fctx, websocket.MessageBinary, b) != nil {
				flushing = false
			}
		default:
			flushing = false
		}
	}
	cancelFlush()
	ws.Close(status, "")
}

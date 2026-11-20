// Package sheetsync streams standalone spreadsheet revision invalidations and
// collaborator cursor presence over WebSocket.
package sheetsync

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/coder/websocket"
)

const (
	outBuffer         = 256
	storeTimeout      = 5 * time.Second
	checkTTL          = 2 * time.Second
	cursorMinInterval = 30 * time.Millisecond
)

type Collaborator struct {
	UserID      int64  `json:"userId"`
	Name        string `json:"name"`
	WorksheetID int64  `json:"worksheetId,omitempty"`
	Row         int    `json:"row"`
	Col         int    `json:"col"`
	AnchorRow   int    `json:"anchorRow"`
	AnchorCol   int    `json:"anchorCol"`
	Editing     bool   `json:"editing,omitempty"`
}

type Hub struct {
	Store          store.SheetStore
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
	head  int64
	stop  chan struct{}
	wake  chan struct{}
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
	return 3 * time.Second
}

func (h *Hub) acquireRoom(id int64) *room {
	var initial int64
	if h.Store != nil {
		ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
		if rev, err := h.Store.SheetHead(ctx, id); err == nil {
			initial = rev
		}
		cancel()
	}
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
			head:  initial,
			stop:  make(chan struct{}),
			wake:  make(chan struct{}, 1),
			conns: map[*conn]struct{}{},
		}
		h.rooms[id] = r
		go r.sweepLoop()
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

// Notify broadcasts a workbook revision update to all connected clients in a sheet room.
func (h *Hub) Notify(sheetID, workbookRevision, actorID int64) {
	h.NotifyCells(sheetID, workbookRevision, actorID, 0, nil)
}

// NotifyCells broadcasts a workbook revision update along with an optional
// incremental cell delta (up to 200 cells) so connected collaborators apply
// cell edits in place without refetching the full workbook snapshot.
func (h *Hub) NotifyCells(sheetID, workbookRevision, actorID, worksheetID int64, cells []store.SheetCellRevision) {
	h.mu.Lock()
	r := h.rooms[sheetID]
	h.mu.Unlock()
	if r == nil {
		return
	}
	payload := map[string]any{
		"type":             "revision",
		"workbookRevision": workbookRevision,
		"actorId":          actorID,
	}
	if worksheetID > 0 && len(cells) > 0 && len(cells) <= 200 {
		payload["worksheetId"] = worksheetID
		payload["cellDelta"] = cells
	}
	frame := mustJSON(payload)
	r.mu.Lock()
	if workbookRevision > r.head {
		r.head = workbookRevision
	}
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
	if _, ok := r.conns[c]; !ok {
		r.mu.Unlock()
		return
	}
	delete(r.conns, c)
	frame := r.presenceLocked()
	for existing := range r.conns {
		existing.send(frame)
	}
	r.mu.Unlock()
}

func (r *room) updateCursor(c *conn, worksheetID int64, row, col, anchorRow, anchorCol int, editing bool) {
	r.mu.Lock()
	if _, ok := r.conns[c]; !ok {
		r.mu.Unlock()
		return
	}
	c.cursor = &Collaborator{
		UserID:      c.userID,
		Name:        c.name,
		WorksheetID: worksheetID,
		Row:         row,
		Col:         col,
		AnchorRow:   anchorRow,
		AnchorCol:   anchorCol,
		Editing:     editing,
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
		cur := Collaborator{UserID: c.userID, Name: c.name, Row: 0, Col: 0}
		if c.cursor != nil {
			cur = *c.cursor
		}
		if existing, exists := byUser[c.userID]; !exists || (cur.WorksheetID > 0 && existing.WorksheetID == 0) {
			byUser[c.userID] = cur
		}
	}
	list := make([]Collaborator, 0, len(byUser))
	for _, item := range byUser {
		list = append(list, item)
	}
	return mustJSON(map[string]any{"type": "presence", "collaborators": list})
}

func (r *room) sweepLoop() {
	t := time.NewTicker(r.hub.sweepInterval())
	defer t.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-r.wake:
		case <-t.C:
		}
		if r.hub.Store == nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
		rev, err := r.hub.Store.SheetHead(ctx, r.id)
		cancel()
		if err != nil {
			continue
		}
		r.mu.Lock()
		if rev > r.head {
			r.head = rev
			frame := mustJSON(map[string]any{
				"type":             "revision",
				"workbookRevision": rev,
				"actorId":          int64(0),
			})
			for c := range r.conns {
				c.send(frame)
			}
		}
		r.mu.Unlock()
	}
}

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

// Serve upgrades an authenticated viewer/editor connection for a spreadsheet.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, sheetID int64, user store.User, check func(context.Context) error) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.OriginPatterns})
	if err != nil {
		return
	}
	ws.SetReadLimit(64 * 1024)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Re-authorizing on every frame turns each cursor move into N database
	// reads (one per receiving connection). Cache a successful check briefly;
	// the ping loop always forces a fresh check, so revocation still closes
	// the socket within checkTTL or one ping interval.
	var checkMu sync.Mutex
	var lastOK time.Time
	authorize := func(ctx context.Context, force bool) error {
		if check == nil {
			return nil
		}
		checkMu.Lock()
		defer checkMu.Unlock()
		if !force && !lastOK.IsZero() && time.Since(lastOK) < checkTTL {
			return nil
		}
		if err := check(ctx); err != nil {
			lastOK = time.Time{}
			return err
		}
		lastOK = time.Now()
		return nil
	}
	cachedCheck := func(ctx context.Context) error { return authorize(ctx, false) }

	c := &conn{
		out:    make(chan []byte, outBuffer),
		cancel: cancel,
		userID: user.ID,
		name:   user.Name,
	}
	go c.writeLoop(ctx, ws, cachedCheck, cancel)

	room := h.acquireRoom(sheetID)
	defer h.releaseRoom(room)
	room.addConn(c)
	defer room.removeConn(c)

	go func() {
		var lastCursor time.Time
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				cancel()
				return
			}
			var msg struct {
				Type        string `json:"type"`
				WorksheetID int64  `json:"worksheetId"`
				Row         int    `json:"row"`
				Col         int    `json:"col"`
				AnchorRow   *int   `json:"anchorRow"`
				AnchorCol   *int   `json:"anchorCol"`
				Editing     bool   `json:"editing"`
			}
			if json.Unmarshal(data, &msg) != nil {
				continue
			}
			if cachedCheck(ctx) != nil {
				cancel()
				return
			}
			// Throttle presence fan-out: each accepted cursor frame is
			// broadcast to every connection in the room.
			if msg.Type == "cursor" && msg.WorksheetID > 0 && msg.Row >= 0 && msg.Row < 10000 && msg.Col >= 0 && msg.Col < 256 && time.Since(lastCursor) >= cursorMinInterval {
				anchorRow := msg.Row
				if msg.AnchorRow != nil && *msg.AnchorRow >= 0 && *msg.AnchorRow < 10000 {
					anchorRow = *msg.AnchorRow
				}
				anchorCol := msg.Col
				if msg.AnchorCol != nil && *msg.AnchorCol >= 0 && *msg.AnchorCol < 256 {
					anchorCol = *msg.AnchorCol
				}
				lastCursor = time.Now()
				room.updateCursor(c, msg.WorksheetID, msg.Row, msg.Col, anchorRow, anchorCol, msg.Editing)
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
				if authorize(ctx, true) != nil {
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

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

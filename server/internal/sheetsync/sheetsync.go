// Package sheetsync streams standalone spreadsheet revision invalidations and
// collaborator cursor presence over WebSocket.
package sheetsync

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/coder/websocket"
)

const (
	// RealtimeChannel is the Postgres LISTEN/NOTIFY channel used for cross-replica sheet sync.
	RealtimeChannel = store.RealtimeChannelSheet

	outBuffer          = 256
	storeTimeout       = 5 * time.Second
	checkTTL           = 2 * time.Second
	cursorMinInterval  = 30 * time.Millisecond
	maxBusPayloadBytes = 7500
	remotePresenceTTL  = 90 * time.Second
)

type sheetBusEvent struct {
	Origin           string                    `json:"origin"`
	Kind             string                    `json:"kind"` // "rev" | "cells" | "cursor" | "leave"
	SheetID          int64                     `json:"sheetId"`
	WorkbookRevision int64                     `json:"rev,omitempty"`
	ActorID          int64                     `json:"actorId,omitempty"`
	WorksheetID      int64                     `json:"worksheetId,omitempty"`
	CellDelta        []store.SheetCellRevision `json:"cellDelta,omitempty"`
	Collaborator     *Collaborator             `json:"collaborator,omitempty"`
	UserID           int64                     `json:"userId,omitempty"`
}

type remotePeerKey struct {
	origin string
	userID int64
}

type remoteCursor struct {
	collaborator Collaborator
	updatedAt    time.Time
}

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
	Store store.SheetStore
	// Bus optionally overrides the RealtimeBus used for cross-replica fan-out.
	// When nil, Hub automatically uses Store if Store implements store.RealtimeBus.
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
	hub    *Hub
	id     int64
	refs   int
	head   int64
	stop   chan struct{}
	wake   chan struct{}
	mu     sync.Mutex
	conns  map[*conn]struct{}
	remote map[remotePeerKey]remoteCursor
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
			hub:    h,
			id:     id,
			head:   initial,
			stop:   make(chan struct{}),
			wake:   make(chan struct{}, 1),
			conns:  map[*conn]struct{}{},
			remote: map[remotePeerKey]remoteCursor{},
		}
		h.rooms[id] = r
		go r.sweepLoop()
	}
	r.refs++
	return r
}

func (h *Hub) bus() store.RealtimeBus {
	if h.Bus != nil {
		return h.Bus
	}
	if b, ok := h.Store.(store.RealtimeBus); ok {
		return b
	}
	return nil
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

func (h *Hub) publishRaw(payload string) {
	bus := h.bus()
	if bus == nil || len(payload) == 0 || len(payload) > store.MaxRealtimePayloadBytes {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
		defer cancel()
		if err := bus.PublishRealtime(ctx, RealtimeChannel, payload); err != nil {
			h.log().Warn("sheet realtime publish", "err", err)
		}
	}()
}

// Run consumes cross-replica spreadsheet revision and cursor presence events
// from the RealtimeBus until ctx ends.
func (h *Hub) Run(ctx context.Context) error {
	bus := h.bus()
	if bus == nil {
		<-ctx.Done()
		return nil
	}
	origin := h.originID()
	return bus.ListenRealtime(ctx, RealtimeChannel, func(payload string) {
		var ev sheetBusEvent
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			return
		}
		if ev.Origin == origin || ev.SheetID <= 0 {
			return
		}
		switch ev.Kind {
		case "rev":
			h.applyRevisionLocal(ev.SheetID, ev.WorkbookRevision, ev.ActorID, 0, nil)
		case "cells":
			h.applyRevisionLocal(ev.SheetID, ev.WorkbookRevision, ev.ActorID, ev.WorksheetID, ev.CellDelta)
		case "cursor":
			if ev.Collaborator != nil && ev.Collaborator.UserID > 0 {
				h.applyRemoteCursor(ev.SheetID, ev.Origin, *ev.Collaborator)
			}
		case "leave":
			if ev.UserID > 0 {
				h.applyRemoteLeave(ev.SheetID, ev.Origin, ev.UserID)
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

// Notify broadcasts a workbook revision update to all connected clients in a sheet room.
func (h *Hub) Notify(sheetID, workbookRevision, actorID int64) {
	h.NotifyCells(sheetID, workbookRevision, actorID, 0, nil)
}

func (h *Hub) applyRevisionLocal(sheetID, workbookRevision, actorID, worksheetID int64, cells []store.SheetCellRevision) {
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

// NotifyCells broadcasts a workbook revision update along with an optional
// incremental cell delta (up to 200 cells) so connected collaborators apply
// cell edits in place without refetching the full workbook snapshot.
// When a RealtimeBus is attached, it also publishes the delta (falling back to
// a compact revision invalidation when the JSON exceeds Postgres's 8000-byte
// NOTIFY ceiling).
func (h *Hub) NotifyCells(sheetID, workbookRevision, actorID, worksheetID int64, cells []store.SheetCellRevision) {
	h.applyRevisionLocal(sheetID, workbookRevision, actorID, worksheetID, cells)
	if sheetID <= 0 || h.bus() == nil {
		return
	}
	origin := h.originID()
	if worksheetID > 0 && len(cells) > 0 && len(cells) <= 200 {
		raw := mustJSON(sheetBusEvent{
			Origin:           origin,
			Kind:             "cells",
			SheetID:          sheetID,
			WorkbookRevision: workbookRevision,
			ActorID:          actorID,
			WorksheetID:      worksheetID,
			CellDelta:        cells,
		})
		if len(raw) <= maxBusPayloadBytes {
			h.publishRaw(string(raw))
			return
		}
	}
	compact := mustJSON(sheetBusEvent{
		Origin:           origin,
		Kind:             "rev",
		SheetID:          sheetID,
		WorkbookRevision: workbookRevision,
		ActorID:          actorID,
	})
	h.publishRaw(string(compact))
}

func (h *Hub) applyRemoteCursor(sheetID int64, origin string, col Collaborator) {
	h.mu.Lock()
	r := h.rooms[sheetID]
	h.mu.Unlock()
	if r == nil {
		return
	}
	r.mu.Lock()
	if r.remote == nil {
		r.remote = map[remotePeerKey]remoteCursor{}
	}
	r.remote[remotePeerKey{origin: origin, userID: col.UserID}] = remoteCursor{
		collaborator: col,
		updatedAt:    time.Now(),
	}
	frame := r.presenceLocked()
	for existing := range r.conns {
		existing.send(frame)
	}
	r.mu.Unlock()
}

func (h *Hub) applyRemoteLeave(sheetID int64, origin string, userID int64) {
	h.mu.Lock()
	r := h.rooms[sheetID]
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

func (r *room) publishCursor(col Collaborator) {
	if r.hub.bus() == nil {
		return
	}
	raw := mustJSON(sheetBusEvent{
		Origin:       r.hub.originID(),
		Kind:         "cursor",
		SheetID:      r.id,
		Collaborator: &col,
	})
	if len(raw) <= maxBusPayloadBytes {
		r.hub.publishRaw(string(raw))
	}
}

func (r *room) publishLeave(userID int64) {
	if r.hub.bus() == nil || userID <= 0 {
		return
	}
	raw := mustJSON(sheetBusEvent{
		Origin:  r.hub.originID(),
		Kind:    "leave",
		SheetID: r.id,
		UserID:  userID,
	})
	r.hub.publishRaw(string(raw))
}

func (r *room) addConn(c *conn) {
	r.mu.Lock()
	r.conns[c] = struct{}{}
	frame := r.presenceLocked()
	for existing := range r.conns {
		existing.send(frame)
	}
	cur := Collaborator{UserID: c.userID, Name: c.name}
	r.mu.Unlock()
	r.publishCursor(cur)
}

func (r *room) removeConn(c *conn) {
	r.mu.Lock()
	if _, ok := r.conns[c]; !ok {
		r.mu.Unlock()
		return
	}
	delete(r.conns, c)
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
	}
	r.mu.Unlock()
	if remaining != nil {
		r.publishCursor(*remaining)
	} else {
		r.publishLeave(c.userID)
	}
}

func (r *room) updateCursor(c *conn, worksheetID int64, row, col, anchorRow, anchorCol int, editing bool) {
	r.mu.Lock()
	if _, ok := r.conns[c]; !ok {
		r.mu.Unlock()
		return
	}
	cur := Collaborator{
		UserID:      c.userID,
		Name:        c.name,
		WorksheetID: worksheetID,
		Row:         row,
		Col:         col,
		AnchorRow:   anchorRow,
		AnchorCol:   anchorCol,
		Editing:     editing,
	}
	c.cursor = &cur
	frame := r.presenceLocked()
	for existing := range r.conns {
		existing.send(frame)
	}
	r.mu.Unlock()
	r.publishCursor(cur)
}

func (r *room) pruneExpiredRemoteLocked(now time.Time) bool {
	removed := false
	for k, entry := range r.remote {
		if now.Sub(entry.updatedAt) > remotePresenceTTL {
			delete(r.remote, k)
			removed = true
		}
	}
	return removed
}

func (r *room) presenceLocked() []byte {
	r.pruneExpiredRemoteLocked(time.Now())
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
	for _, entry := range r.remote {
		cur := entry.collaborator
		if existing, exists := byUser[cur.UserID]; !exists || (cur.WorksheetID > 0 && existing.WorksheetID == 0) {
			byUser[cur.UserID] = cur
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
		r.mu.Lock()
		if r.pruneExpiredRemoteLocked(time.Now()) {
			frame := r.presenceLocked()
			for c := range r.conns {
				c.send(frame)
			}
		}
		r.mu.Unlock()
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

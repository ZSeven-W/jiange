package sync

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	gosync "sync"
	"sync/atomic"
	"time"
)

var (
	// ErrSeqConflict is returned when an op's baseSeq does not match the room's latest sequence.
	ErrSeqConflict = errors.New("sync: sequence conflict")
	// ErrConnClosed is returned when sending on a closed TransportConn.
	ErrConnClosed = errors.New("sync: connection closed")
	// ErrSendBufferFull is returned when a ChanConn buffer cannot accept another message.
	ErrSendBufferFull = errors.New("sync: send buffer full")
)

// TransportConn is a minimal transport interface for bridging SSE, WebSocket, or custom streams.
type TransportConn interface {
	Send(data []byte) error
	Close() error
}

// ChanConn implements TransportConn backed by a buffered channel.
type ChanConn struct {
	mu     gosync.RWMutex
	ch     chan []byte
	closed bool
}

// NewChanConn constructs a ChanConn with the given buffer capacity (defaults to 64).
func NewChanConn(bufSize int) *ChanConn {
	if bufSize <= 0 {
		bufSize = 64
	}
	return &ChanConn{ch: make(chan []byte, bufSize)}
}

// Events returns the read-only message channel.
func (c *ChanConn) Events() <-chan []byte {
	return c.ch
}

// Send enqueues a copy of data without blocking.
func (c *ChanConn) Send(data []byte) error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.closed {
		return ErrConnClosed
	}
	cp := append([]byte(nil), data...)
	select {
	case c.ch <- cp:
		return nil
	default:
		return ErrSendBufferFull
	}
}

// Close closes the underlying channel idempotently.
func (c *ChanConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.ch)
	}
	return nil
}

// Op is a sequenced collaboration operation in a room.
type Op struct {
	Seq       int64           `json:"seq"`
	RoomID    string          `json:"roomId"`
	ClientID  string          `json:"clientId"`
	Type      string          `json:"type,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
}

// Presence represents live awareness state (cursor, selection, identity) for a participant.
type Presence struct {
	ClientID  string         `json:"clientId"`
	UserName  string         `json:"userName,omitempty"`
	Color     string         `json:"color,omitempty"`
	Cursor    map[string]any `json:"cursor,omitempty"`
	UpdatedAt time.Time      `json:"updatedAt"`
}

// RoomSnapshot captures bounded history and active presence for initial room hydration.
type RoomSnapshot struct {
	RoomID   string     `json:"roomId"`
	Seq      int64      `json:"seq"`
	Ops      []Op       `json:"ops"`
	Presence []Presence `json:"presence"`
}

// EventFrame is the JSON envelope fanned out to room subscribers.
type EventFrame struct {
	Event    string    `json:"event"`
	RoomID   string    `json:"roomId"`
	Op       *Op       `json:"op,omitempty"`
	Presence *Presence `json:"presence,omitempty"`
}

// HubOption configures a RoomHub.
type HubOption func(*RoomHub)

// WithMaxHistory bounds how many recent ops are retained per room.
func WithMaxHistory(n int) HubOption {
	return func(h *RoomHub) {
		if n > 0 {
			h.maxHistory = n
		}
	}
}

// WithPresenceTTL configures the expiration window for presence entries.
func WithPresenceTTL(ttl time.Duration) HubOption {
	return func(h *RoomHub) {
		if ttl > 0 {
			h.presenceTTL = ttl
		}
	}
}

// WithClock overrides the clock used for timestamps and TTL eviction.
func WithClock(now func() time.Time) HubOption {
	return func(h *RoomHub) {
		if now != nil {
			h.now = now
		}
	}
}

type roomState struct {
	seq      int64
	ops      []Op
	subs     map[string]TransportConn
	presence map[string]Presence
}

// RoomHub coordinates multi-room real-time collaboration logs, fan-out, and presence awareness.
type RoomHub struct {
	mu          gosync.RWMutex
	rooms       map[string]*roomState
	maxHistory  int
	presenceTTL time.Duration
	now         func() time.Time
	subSeq      atomic.Uint64
}

// NewRoomHub creates a RoomHub with sensible defaults (maxHistory=500, presenceTTL=30s).
func NewRoomHub(opts ...HubOption) *RoomHub {
	h := &RoomHub{
		rooms:       make(map[string]*roomState),
		maxHistory:  500,
		presenceTTL: 30 * time.Second,
		now:         func() time.Time { return time.Now().UTC() },
	}
	for _, opt := range opts {
		opt(h)
	}
	return h
}

func (h *RoomHub) getOrCreateRoomLocked(roomID string) *roomState {
	rm, ok := h.rooms[roomID]
	if !ok {
		rm = &roomState{
			subs:     make(map[string]TransportConn),
			presence: make(map[string]Presence),
		}
		h.rooms[roomID] = rm
	}
	return rm
}

func (h *RoomHub) evictPresenceLocked(rm *roomState, now time.Time) {
	for id, p := range rm.presence {
		if now.Sub(p.UpdatedAt) > h.presenceTTL {
			delete(rm.presence, id)
		}
	}
}

type subEntry struct {
	id   string
	conn TransportConn
}

func (h *RoomHub) broadcast(roomID string, subs []subEntry, frame EventFrame) {
	if len(subs) == 0 {
		return
	}
	raw, _ := json.Marshal(frame)
	var failed []string
	for _, s := range subs {
		if err := s.conn.Send(raw); err != nil {
			failed = append(failed, s.id)
		}
	}
	if len(failed) > 0 {
		h.mu.Lock()
		if rm, ok := h.rooms[roomID]; ok {
			for _, id := range failed {
				if conn, exists := rm.subs[id]; exists {
					delete(rm.subs, id)
					_ = conn.Close()
				}
			}
		}
		h.mu.Unlock()
	}
}

func snapshotSubsLocked(rm *roomState) []subEntry {
	subs := make([]subEntry, 0, len(rm.subs))
	for id, c := range rm.subs {
		subs = append(subs, subEntry{id: id, conn: c})
	}
	return subs
}

// Append appends an operation if baseSeq matches the room's current sequence number.
func (h *RoomHub) Append(roomID string, baseSeq int64, clientID, opType string, payload json.RawMessage) (Op, error) {
	h.mu.Lock()
	rm := h.getOrCreateRoomLocked(roomID)
	if baseSeq != rm.seq {
		h.mu.Unlock()
		return Op{}, ErrSeqConflict
	}
	rm.seq++
	op := Op{
		Seq:       rm.seq,
		RoomID:    roomID,
		ClientID:  clientID,
		Type:      opType,
		Payload:   append(json.RawMessage(nil), payload...),
		CreatedAt: h.now(),
	}
	rm.ops = append(rm.ops, op)
	if len(rm.ops) > h.maxHistory {
		rm.ops = append([]Op(nil), rm.ops[len(rm.ops)-h.maxHistory:]...)
	}
	subs := snapshotSubsLocked(rm)
	h.mu.Unlock()

	h.broadcast(roomID, subs, EventFrame{Event: "op", RoomID: roomID, Op: &op})
	return op, nil
}

// PullSince returns retained operations with Seq > afterSeq along with the room's latest sequence.
func (h *RoomHub) PullSince(roomID string, afterSeq int64) ([]Op, int64) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	rm, ok := h.rooms[roomID]
	if !ok {
		return []Op{}, 0
	}
	out := make([]Op, 0, len(rm.ops))
	for _, op := range rm.ops {
		if op.Seq > afterSeq {
			out = append(out, op)
		}
	}
	return out, rm.seq
}

// Snapshot returns the room's current sequence, bounded op history, and active presence.
func (h *RoomHub) Snapshot(roomID string) RoomSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	rm, ok := h.rooms[roomID]
	if !ok {
		return RoomSnapshot{RoomID: roomID, Ops: []Op{}, Presence: []Presence{}}
	}
	h.evictPresenceLocked(rm, h.now())
	ops := append([]Op(nil), rm.ops...)
	if ops == nil {
		ops = []Op{}
	}
	return RoomSnapshot{
		RoomID:   roomID,
		Seq:      rm.seq,
		Ops:      ops,
		Presence: sortedPresence(rm.presence),
	}
}

// Subscribe registers conn to receive room events and returns a subscriber ID.
func (h *RoomHub) Subscribe(roomID string, conn TransportConn) string {
	id := fmt.Sprintf("sub-%d", h.subSeq.Add(1))
	h.mu.Lock()
	rm := h.getOrCreateRoomLocked(roomID)
	rm.subs[id] = conn
	h.mu.Unlock()
	return id
}

// Unsubscribe removes subscriber subID from roomID and closes its connection.
func (h *RoomHub) Unsubscribe(roomID, subID string) {
	h.mu.Lock()
	var conn TransportConn
	if rm, ok := h.rooms[roomID]; ok {
		conn = rm.subs[subID]
		delete(rm.subs, subID)
	}
	h.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

// UpdatePresence records or refreshes a participant's awareness state and fans it out.
func (h *RoomHub) UpdatePresence(roomID string, p Presence) Presence {
	h.mu.Lock()
	rm := h.getOrCreateRoomLocked(roomID)
	now := h.now()
	h.evictPresenceLocked(rm, now)
	p.UpdatedAt = now
	if p.Cursor != nil {
		cp := make(map[string]any, len(p.Cursor))
		for k, v := range p.Cursor {
			cp[k] = v
		}
		p.Cursor = cp
	}
	rm.presence[p.ClientID] = p
	subs := snapshotSubsLocked(rm)
	h.mu.Unlock()

	h.broadcast(roomID, subs, EventFrame{Event: "presence", RoomID: roomID, Presence: &p})
	return p
}

// ListPresence evicts stale awareness entries and returns active participants sorted by ClientID.
func (h *RoomHub) ListPresence(roomID string) []Presence {
	h.mu.Lock()
	defer h.mu.Unlock()
	rm, ok := h.rooms[roomID]
	if !ok {
		return []Presence{}
	}
	h.evictPresenceLocked(rm, h.now())
	return sortedPresence(rm.presence)
}

func sortedPresence(m map[string]Presence) []Presence {
	out := make([]Presence, 0, len(m))
	for _, p := range m {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ClientID < out[j].ClientID })
	return out
}

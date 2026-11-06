package syncsrv

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const catchUpChunk = 1000

type room struct {
	hub  *Hub
	id   int64
	refs int // guarded by hub.mu

	mu      sync.Mutex
	doc     *collab.Doc // nil until loaded
	head    int64       // last seq integrated into doc and fanned out
	snapSeq int64
	conns   map[*conn]struct{}
}

func (r *room) load(ctx context.Context) error {
	if r.doc != nil {
		return nil
	}
	st := r.hub.Store
	seq, state, err := st.LatestSnapshot(ctx, r.id)
	switch {
	case err == nil:
		d, derr := collab.DecodeState(state)
		if derr != nil {
			return fmt.Errorf("snapshot %d@%d: %w", r.id, seq, derr)
		}
		r.doc, r.head, r.snapSeq = d, seq, seq
	case errors.Is(err, store.ErrNotFound):
		r.doc, r.head, r.snapSeq = collab.NewDoc(), 0, 0
	default:
		return err
	}
	return r.catchUp(ctx)
}

// catchUp integrates ops persisted (by any instance) after r.head and fans
// them out to every connection in seq order. Caller holds r.mu.
func (r *room) catchUp(ctx context.Context) error {
	target, err := r.hub.Store.Head(ctx, r.id)
	if err != nil {
		return err
	}
	if target < r.head {
		return fmt.Errorf("catch up %d: persistent head %d is behind room head %d", r.id, target, r.head)
	}
	for r.head < target {
		rows, err := r.hub.Store.OpsAfter(ctx, r.id, r.head, int(min(target-r.head, catchUpChunk)))
		if err != nil {
			return err
		}
		if err := validateLogRows(r.id, r.head, target, rows); err != nil {
			return err
		}
		batch, ops, err := joinRows(rows)
		if err != nil {
			return err
		}
		for _, op := range ops {
			r.doc.Apply(op)
		}
		msg := collab.EncodeServerOps(uint64(rows[0].Seq), batch)
		for c := range r.conns {
			c.send(msg)
		}
		r.head = rows[len(rows)-1].Seq
	}
	if r.doc.Pending() != 0 {
		return fmt.Errorf("catch up %d: %d operations have unresolved dependencies at seq %d", r.id, r.doc.Pending(), target)
	}
	return nil
}

// Each stored sequence belongs to exactly one operation; bounds are captured
// before reading so a concurrent append cannot leak into an earlier welcome.
func validateLogRows(doc, after, target int64, rows []store.SeqOp) error {
	if len(rows) == 0 {
		return fmt.Errorf("document %d: missing operation after seq %d (target %d)", doc, after, target)
	}
	for _, row := range rows {
		if row.Seq != after+1 || row.Seq > target {
			return fmt.Errorf("document %d: expected seq %d through %d, got %d", doc, after+1, target, row.Seq)
		}
		after = row.Seq
	}
	return nil
}

func joinRows(rows []store.SeqOp) ([]byte, []collab.Op, error) {
	var ops []collab.Op
	for _, row := range rows {
		o, err := collab.DecodeOps(row.Bytes)
		if err != nil {
			return nil, nil, fmt.Errorf("op seq %d: %w", row.Seq, err)
		}
		if len(o) != 1 {
			return nil, nil, fmt.Errorf("op seq %d: expected one operation, got %d", row.Seq, len(o))
		}
		ops = append(ops, o...)
	}
	b, err := collab.EncodeOps(ops)
	return b, ops, err
}

func (r *room) remoteHead(head int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.doc == nil || head <= r.head {
		return
	}
	if err := r.catchUp(context.Background()); err != nil {
		r.hub.Log.Error("catch up", "doc", r.id, "err", err)
		r.reset()
	}
}

// reset drops in-memory state after a storage failure; connections reconnect
// and the room reloads from the database.
func (r *room) reset() {
	r.doc = nil
	for c := range r.conns {
		c.send(collab.EncodeError("internal", "room reset"))
		c.cancel()
	}
}

func (r *room) sendErr(c *conn, code, msg string) {
	r.mu.Lock()
	c.send(collab.EncodeError(code, msg))
	r.mu.Unlock()
}

func (r *room) join(ctx context.Context, c *conn, lastSeq int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.load(ctx); err != nil {
		r.doc = nil
		c.send(collab.EncodeError("internal", "could not load document"))
		return err
	}
	if err := r.catchUp(ctx); err != nil {
		r.reset()
		return err
	}
	target := r.head
	from := lastSeq
	switch {
	case lastSeq > target:
		// replica is ahead of us (e.g. restored database): resync from current state
		c.send(collab.EncodeWelcome(c.clientID, uint64(target), uint64(target), r.doc.EncodeState()))
		from = target
	case r.snapSeq > 0 && lastSeq < r.snapSeq:
		seq, state, err := r.hub.Store.LatestSnapshot(ctx, r.id)
		if err != nil {
			return err
		}
		if seq > target {
			// Another instance snapshotted a newer head after our catch-up.
			// Use our own complete state, never label future state as this head.
			seq, state = target, r.doc.EncodeState()
		} else if _, err := collab.DecodeState(state); err != nil {
			return fmt.Errorf("snapshot %d@%d: %w", r.id, seq, err)
		}
		c.send(collab.EncodeWelcome(c.clientID, uint64(target), uint64(seq), state))
		from = seq
	default:
		c.send(collab.EncodeWelcome(c.clientID, uint64(target), 0, nil))
	}
	for from < target {
		rows, err := r.hub.Store.OpsAfter(ctx, r.id, from, int(min(target-from, catchUpChunk)))
		if err != nil {
			return err
		}
		if err := validateLogRows(r.id, from, target, rows); err != nil {
			return err
		}
		batch, _, err := joinRows(rows)
		if err != nil {
			return err
		}
		c.send(collab.EncodeServerOps(uint64(rows[0].Seq), batch))
		from = rows[len(rows)-1].Seq
	}
	c.acked = min(lastSeq, target)
	c.dbAcked = 0
	for o := range r.conns {
		if o.aware != "" {
			c.send(collab.EncodeServerAware(o.clientID, o.aware))
		}
	}
	r.conns[c] = struct{}{}
	return nil
}

func (r *room) leave(c *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.conns[c]; !ok {
		return
	}
	delete(r.conns, c)
	c.closed = true
	if c.aware != "" {
		msg := collab.EncodeServerAware(c.clientID, "")
		for o := range r.conns {
			o.send(msg)
		}
	}
	if c.acked > c.dbAcked {
		_ = r.hub.Store.SetAck(context.Background(), int64(c.clientID), c.acked, r.hub.now())
	}
}

// No further batch may be processed on a connection after rejecting one:
// older clients can have several batches inflight and ACKs lack batch IDs.
var errBatchRejected = errors.New("sync batch rejected")

// handleOps validates, sequences, persists and fans out a client batch.
func (r *room) handleOps(ctx context.Context, c *conn, ops []collab.Op) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.doc == nil {
		c.send(collab.EncodeError("internal", "room unavailable"))
		return errors.New("room unavailable")
	}
	if err := r.catchUp(ctx); err != nil {
		r.reset()
		return err
	}
	var accepted []collab.Op
	var raws []store.RawOp
	rejected := 0
	for _, op := range ops {
		switch err := r.doc.TryApply(op); err {
		case nil:
			b, _ := collab.EncodeOps([]collab.Op{op})
			accepted = append(accepted, op)
			raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
		case collab.ErrDuplicate:
		default:
			rejected++
		}
	}
	if len(raws) == 0 {
		if rejected > 0 {
			c.send(collab.EncodeError("not_ready", fmt.Sprintf("%d ops depend on unknown ops", rejected)))
			return errBatchRejected
		} else {
			c.send(collab.EncodeServerAck(uint64(r.head+1), 0))
		}
		return nil
	}
	seqs, err := r.hub.Store.AppendOps(ctx, r.id, raws)
	if err != nil {
		r.hub.Log.Error("append ops", "doc", r.id, "err", err)
		r.reset()
		return err
	}
	if len(seqs) != len(accepted) {
		r.reset()
		return fmt.Errorf("append ops %d: expected %d sequence results, got %d", r.id, len(accepted), len(seqs))
	}
	var mine []collab.Op
	var first int64
	var last int64
	for i, s := range seqs {
		if s == 0 {
			continue // persisted concurrently by another instance; arrives via catch-up
		}
		if first == 0 {
			first = s
		} else if s != last+1 {
			r.reset()
			return fmt.Errorf("append ops %d: noncontiguous sequence %d after %d", r.id, s, last)
		}
		last = s
		mine = append(mine, accepted[i])
	}
	if first == 0 {
		// A duplicate may have been sequenced by a different instance after
		// our initial catch-up. Deliver its history before acknowledging it.
		if err := r.catchUp(ctx); err != nil {
			r.reset()
			return err
		}
		if rejected > 0 {
			c.send(collab.EncodeError("not_ready", fmt.Sprintf("%d ops depend on unknown ops", rejected)))
			return errBatchRejected
		} else {
			c.send(collab.EncodeServerAck(uint64(r.head+1), 0))
		}
		return nil
	}
	// ops another instance sequenced before ours must reach everyone first
	if first <= r.head {
		r.reset()
		return fmt.Errorf("append ops %d: new sequence %d is not after room head %d", r.id, first, r.head)
	}
	for r.head < first-1 {
		rows, err := r.hub.Store.OpsAfter(ctx, r.id, r.head, int(min(first-1-r.head, catchUpChunk)))
		if err != nil {
			r.reset()
			return err
		}
		if err := validateLogRows(r.id, r.head, first-1, rows); err != nil {
			r.reset()
			return err
		}
		batch, rops, err := joinRows(rows)
		if err != nil {
			r.reset()
			return err
		}
		for _, op := range rops {
			r.doc.Apply(op)
		}
		msg := collab.EncodeServerOps(uint64(rows[0].Seq), batch)
		for o := range r.conns {
			o.send(msg)
		}
		r.head = rows[len(rows)-1].Seq
	}
	batch, _ := collab.EncodeOps(mine)
	msg := collab.EncodeServerOps(uint64(first), batch)
	for o := range r.conns {
		if o != c || rejected > 0 {
			o.send(msg)
		}
	}
	r.head = first + int64(len(mine)) - 1
	if rejected > 0 {
		// The ACK has no batch ID or rejection list. Sending it here would
		// make clients discard the rejected ops. Echo accepted ops to the
		// sender instead, then retain the entire batch for a later retry.
		c.send(collab.EncodeError("not_ready", fmt.Sprintf("%d ops depend on unknown ops", rejected)))
	} else {
		c.send(collab.EncodeServerAck(uint64(first), uint64(len(mine))))
	}
	if r.head-r.snapSeq >= r.hub.SnapshotEvery {
		if err := r.snapshot(ctx); err != nil {
			r.hub.Log.Error("snapshot", "doc", r.id, "err", err)
		}
	}
	if rejected > 0 {
		return errBatchRejected
	}
	return nil
}

func (r *room) handleAck(ctx context.Context, c *conn, seq int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if seq > r.head || seq <= c.acked {
		return
	}
	c.acked = seq
	if c.acked-c.dbAcked >= ackFlushGap {
		if r.hub.Store.SetAck(ctx, int64(c.clientID), c.acked, r.hub.now()) == nil {
			c.dbAcked = c.acked
		}
	}
}

func (r *room) handleAware(c *conn, state string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c.aware = state
	msg := collab.EncodeServerAware(c.clientID, state)
	for o := range r.conns {
		if o != c {
			o.send(msg)
		}
	}
}

// snapshot persists a compacted state at the GC horizon: the highest seq
// every recently active replica has acknowledged. Tombstones at or below it
// can no longer be referenced by ops still to come (clients resend unacked
// ops before acknowledging new ones), so Compact may drop them.
func (r *room) snapshot(ctx context.Context) error {
	st := r.hub.Store
	for c := range r.conns {
		if c.acked > c.dbAcked && st.SetAck(ctx, int64(c.clientID), c.acked, r.hub.now()) == nil {
			c.dbAcked = c.acked
		}
	}
	horizon, err := st.Horizon(ctx, r.id, r.hub.now().Add(-r.hub.GCWindow))
	if err != nil {
		return err
	}
	// Another server may have advanced the persistent head before this room
	// processes its notification. Do not publish a snapshot ahead of the
	// sequence this room has actually integrated.
	if horizon > r.head {
		horizon = r.head
	}
	if horizon <= r.snapSeq {
		return nil
	}
	base := collab.NewDoc()
	var from int64
	if seq, state, err := st.LatestSnapshot(ctx, r.id); err == nil {
		// A concurrently created newer snapshot cannot be used to reconstruct
		// an older horizon. It already supersedes the snapshot we planned.
		if seq >= horizon {
			return nil
		}
		if base, err = collab.DecodeState(state); err != nil {
			return err
		}
		from = seq
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	for from < horizon {
		rows, err := st.OpsAfter(ctx, r.id, from, int(min(horizon-from, catchUpChunk)))
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return fmt.Errorf("snapshot %d: missing operation after seq %d (horizon %d)", r.id, from, horizon)
		}
		for _, row := range rows {
			if row.Seq != from+1 || row.Seq > horizon {
				return fmt.Errorf("snapshot %d: expected seq %d through %d, got %d", r.id, from+1, horizon, row.Seq)
			}
			from = row.Seq
		}
		_, ops, err := joinRows(rows)
		if err != nil {
			return err
		}
		for _, op := range ops {
			base.Apply(op)
		}
	}
	// Pending operations are not encoded by Doc.EncodeState. Saving now would
	// silently discard unresolved content while advancing the snapshot seq.
	if base.Pending() != 0 {
		return fmt.Errorf("snapshot %d: %d operations have unresolved dependencies at seq %d", r.id, base.Pending(), horizon)
	}
	removed := base.Compact()
	if err := st.SaveSnapshot(ctx, r.id, horizon, base.EncodeState()); err != nil {
		return err
	}
	r.hub.Log.Info("snapshot", "doc", r.id, "seq", horizon, "gc", removed)
	r.snapSeq = horizon
	return nil
}

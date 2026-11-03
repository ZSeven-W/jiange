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
	for {
		rows, err := r.hub.Store.OpsAfter(ctx, r.id, r.head, catchUpChunk)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
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
		if len(rows) < catchUpChunk {
			return nil
		}
	}
}

func joinRows(rows []store.SeqOp) ([]byte, []collab.Op, error) {
	var ops []collab.Op
	for _, row := range rows {
		o, err := collab.DecodeOps(row.Bytes)
		if err != nil {
			return nil, nil, fmt.Errorf("op seq %d: %w", row.Seq, err)
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
	from := lastSeq
	switch {
	case lastSeq > r.head:
		// replica is ahead of us (e.g. restored database): resync from current state
		c.send(collab.EncodeWelcome(c.clientID, uint64(r.head), uint64(r.head), r.doc.EncodeState()))
		from = r.head
	case r.snapSeq > 0 && lastSeq < r.snapSeq:
		seq, state, err := r.hub.Store.LatestSnapshot(ctx, r.id)
		if err != nil {
			return err
		}
		c.send(collab.EncodeWelcome(c.clientID, uint64(r.head), uint64(seq), state))
		from = seq
	default:
		c.send(collab.EncodeWelcome(c.clientID, uint64(r.head), 0, nil))
	}
	for from < r.head {
		rows, err := r.hub.Store.OpsAfter(ctx, r.id, from, catchUpChunk)
		if err != nil || len(rows) == 0 {
			return err
		}
		batch, _, err := joinRows(rows)
		if err != nil {
			return err
		}
		c.send(collab.EncodeServerOps(uint64(rows[0].Seq), batch))
		from = rows[len(rows)-1].Seq
	}
	c.acked = min(lastSeq, r.head)
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
		c.send(collab.EncodeServerAck(uint64(r.head+1), 0))
		if rejected > 0 {
			c.send(collab.EncodeError("not_ready", fmt.Sprintf("%d ops depend on unknown ops", rejected)))
		}
		return nil
	}
	seqs, err := r.hub.Store.AppendOps(ctx, r.id, raws)
	if err != nil {
		r.hub.Log.Error("append ops", "doc", r.id, "err", err)
		r.reset()
		return err
	}
	var mine []collab.Op
	var first int64
	for i, s := range seqs {
		if s == 0 {
			continue // persisted concurrently by another instance; arrives via catch-up
		}
		if first == 0 {
			first = s
		}
		mine = append(mine, accepted[i])
	}
	if first == 0 {
		c.send(collab.EncodeServerAck(uint64(r.head+1), 0))
		return nil
	}
	// ops another instance sequenced before ours must reach everyone first
	if r.head < first-1 {
		save := r.head
		rows, err := r.hub.Store.OpsAfter(ctx, r.id, r.head, int(first-1-r.head))
		if err != nil {
			r.reset()
			return err
		}
		if len(rows) > 0 {
			batch, rops, err := joinRows(rows)
			if err != nil {
				return err
			}
			for _, op := range rops {
				r.doc.Apply(op)
			}
			msg := collab.EncodeServerOps(uint64(save+1), batch)
			for o := range r.conns {
				o.send(msg)
			}
		}
	}
	batch, _ := collab.EncodeOps(mine)
	msg := collab.EncodeServerOps(uint64(first), batch)
	for o := range r.conns {
		if o != c {
			o.send(msg)
		}
	}
	c.send(collab.EncodeServerAck(uint64(first), uint64(len(mine))))
	r.head = first + int64(len(mine)) - 1
	if rejected > 0 {
		c.send(collab.EncodeError("not_ready", fmt.Sprintf("%d ops depend on unknown ops", rejected)))
	}
	if r.head-r.snapSeq >= r.hub.SnapshotEvery {
		if err := r.snapshot(ctx); err != nil {
			r.hub.Log.Error("snapshot", "doc", r.id, "err", err)
		}
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
	if err != nil || horizon <= r.snapSeq {
		return err
	}
	base := collab.NewDoc()
	if seq, state, err := st.LatestSnapshot(ctx, r.id); err == nil {
		if base, err = collab.DecodeState(state); err != nil {
			return err
		}
		if seq != r.snapSeq {
			r.snapSeq = seq
		}
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	for from := r.snapSeq; from < horizon; {
		rows, err := st.OpsAfter(ctx, r.id, from, int(min(horizon-from, catchUpChunk)))
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			break
		}
		_, ops, err := joinRows(rows)
		if err != nil {
			return err
		}
		for _, op := range ops {
			base.Apply(op)
		}
		from = rows[len(rows)-1].Seq
	}
	removed := base.Compact()
	if err := st.SaveSnapshot(ctx, r.id, horizon, base.EncodeState()); err != nil {
		return err
	}
	r.hub.Log.Info("snapshot", "doc", r.id, "seq", horizon, "gc", removed)
	r.snapSeq = horizon
	return nil
}

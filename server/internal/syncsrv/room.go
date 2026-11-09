package syncsrv

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const catchUpChunk = 1000

// A busy multi-instance document can advance between our read and conditional
// write. Retry without dropping the other clients in this room, but bound the
// work per incoming batch so a contended room cannot monopolize its mutex.
const maxAppendAttempts = 128

type room struct {
	hub  *Hub
	id   int64
	refs int // guarded by hub.mu

	mu      sync.Mutex
	doc     *collab.Doc // nil until loaded
	head    int64       // last seq integrated into doc and fanned out
	snapSeq int64
	// fullLog is set when doc was rebuilt from the complete operation log in
	// this room's lifetime, so it holds every tombstone ever created.
	fullLog bool
	conns   map[*conn]struct{}
}

// errUnresolved reports operations whose dependencies are missing from the
// state they were replayed onto.
var errUnresolved = errors.New("operations have unresolved dependencies")

// replayLog rebuilds a replica from the complete operation log (seq 1..upTo)
// without fanning anything out. Operations are never pruned, so this is the
// lossless authority when a snapshot written by the legacy tombstone GC
// cannot resolve later operations. Anything still unresolved is reported,
// never dropped.
func (r *room) replayLog(ctx context.Context, upTo int64) (*collab.Doc, error) {
	d := collab.NewDoc()
	var from int64
	for from < upTo {
		rows, err := r.hub.Store.OpsAfter(ctx, r.id, from, int(min(upTo-from, catchUpChunk)))
		if err != nil {
			return nil, err
		}
		if err := validateLogRows(r.id, from, upTo, rows); err != nil {
			return nil, err
		}
		_, ops, err := joinRows(rows)
		if err != nil {
			return nil, err
		}
		for _, op := range ops {
			d.Apply(op)
		}
		from = rows[len(rows)-1].Seq
	}
	if d.Pending() != 0 {
		return nil, fmt.Errorf("replay %d: %d %w in the full log at seq %d", r.id, d.Pending(), errUnresolved, upTo)
	}
	return d, nil
}

// repairFromLog replaces the room replica with a full-log replay at r.head and
// persists it as a lossless snapshot so later joins and cold loads use it.
func (r *room) repairFromLog(ctx context.Context, cause error) error {
	d, err := r.replayLog(ctx, r.head)
	if err != nil {
		r.hub.Log.Error("document history cannot be resolved", "doc", r.id, "cause", cause, "err", err)
		return err
	}
	r.hub.Log.Warn("rebuilt document from full operation log", "doc", r.id, "seq", r.head, "snapshot", r.snapSeq, "cause", cause)
	r.doc, r.fullLog = d, true
	if r.head > r.snapSeq {
		if err := r.hub.Store.SaveSnapshot(ctx, r.id, r.head, d.EncodeState()); err != nil {
			r.hub.Log.Error("save repaired snapshot", "doc", r.id, "err", err)
		} else {
			r.snapSeq = r.head
		}
	}
	return nil
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
	r.fullLog = r.snapSeq == 0
	err = r.catchUp(ctx)
	if errors.Is(err, errUnresolved) && !r.fullLog {
		// A snapshot from the legacy tombstone GC lacks characters that
		// later operations reference. Rebuild losslessly from the log.
		return r.repairFromLog(ctx, err)
	}
	return err
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
		return fmt.Errorf("catch up %d: %d %w at seq %d", r.id, r.doc.Pending(), errUnresolved, target)
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

// join sends the welcome (v2 with the history epoch to epoch-aware clients)
// and replays the log after lastSeq.
func (r *room) join(ctx context.Context, c *conn, lastSeq int64, v2 bool, epoch uint64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.load(ctx); err != nil {
		r.doc = nil
		r.hub.Log.Error("load document", "doc", r.id, "err", err)
		c.send(collab.EncodeError("internal", "could not load document"))
		return err
	}
	if err := r.catchUp(ctx); err != nil {
		r.reset()
		return err
	}
	if !v2 && r.doc.HasTables() {
		// 该文档已含表格子 CRDT 载荷：v1 对端无法解码快照/重放，拒绝加入
		// 而不是让其断线失步。
		c.send(collab.EncodeError("v2_required", "该文档包含新版表格内容，请升级客户端"))
		return errors.New("v1 peer joined a table-bearing document")
	}
	welcome := func(head, snapSeq uint64, state []byte) {
		if v2 {
			c.send(collab.EncodeWelcomeV2(c.clientID, head, snapSeq, state, epoch))
		} else {
			c.send(collab.EncodeWelcome(c.clientID, head, snapSeq, state))
		}
	}
	target := r.head
	from := lastSeq
	switch {
	case lastSeq > target:
		// replica is ahead of us (e.g. restored database): resync from current state
		welcome(uint64(target), uint64(target), r.doc.EncodeState())
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
		welcome(uint64(target), uint64(seq), state)
		from = seq
	default:
		welcome(uint64(target), 0, nil)
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
	// 表格子 CRDT 载荷（ttable）：只有 v2 协商（epoch HELLO）的连接可提交，
	// 且房间内不能有 v1 成员——v1 解码器会拒绝该字节并断线/失步。
	// 状态集成（Doc 应用与快照版本）落地前，门控在应用之前拒绝。
	for _, op := range ops {
		if op.T != collab.TTable {
			continue
		}
		if !c.v2 {
			c.send(collab.EncodeError("bad_ops", "表格操作需要 v2 同步协议"))
			return errBatchRejected
		}
		for member := range r.conns {
			if !member.v2 {
				c.send(collab.EncodeError("bad_ops", "房间内存在旧协议客户端，无法应用表格操作"))
				return errBatchRejected
			}
		}
	}
	var accepted []collab.Op
	var raws []store.RawOp
	var seqs []int64
	var rejected int
	committed := false
	for attempt := 0; attempt < maxAppendAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := r.catchUp(ctx); err != nil {
			r.reset()
			return err
		}
		accepted, raws, rejected = nil, nil, 0
		// Check the durable log before applying a retry: compacted snapshots
		// no longer contain every original operation or deleted character.
		lookup := make([]store.RawOp, len(ops))
		for i, op := range ops {
			lookup[i] = store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock)}
		}
		existing, err := r.hub.Store.ExistingOpIDs(ctx, r.id, lookup)
		if err != nil || len(existing) != len(ops) {
			r.reset()
			if err != nil {
				return err
			}
			return fmt.Errorf("operation lookup %d: expected %d results, got %d", r.id, len(ops), len(existing))
		}
		tx := r.doc.BeginTryTransaction()
		batchIDs := make(map[collab.OpID]bool)
		for i, op := range ops {
			if existing[i] || batchIDs[op.ID] {
				b, _ := collab.EncodeOps([]collab.Op{op})
				accepted = append(accepted, op)
				raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
				continue
			}
			switch err := tx.TryApply(op); err {
			case nil:
				b, _ := collab.EncodeOps([]collab.Op{op})
				accepted = append(accepted, op)
				raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
				batchIDs[op.ID] = true
			case collab.ErrDuplicate:
				// The store must compare the persisted payload before ACK.
				b, _ := collab.EncodeOps([]collab.Op{op})
				accepted = append(accepted, op)
				raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
			default:
				rejected++
			}
		}
		if rejected > 0 && !r.fullLog {
			// The replica came from a snapshot that may have been written by
			// the legacy tombstone GC, so a dependency may only be missing
			// there. Rebuild losslessly from the log and re-check the batch.
			tx.Rollback()
			if err := r.repairFromLog(ctx, fmt.Errorf("%d ops depend on unknown ops", rejected)); err != nil {
				r.reset()
				return err
			}
			continue
		}
		if len(raws) == 0 {
			tx.Rollback()
			// A concurrently committed dependency may have arrived since
			// catchUp; retry it rather than rejecting an otherwise valid batch.
			if rejected > 0 {
				head, err := r.hub.Store.Head(ctx, r.id)
				if err != nil {
					r.reset()
					return err
				}
				if head > r.head {
					continue
				}
				c.send(collab.EncodeError("not_ready", fmt.Sprintf("%d ops depend on unknown ops", rejected)))
				return errBatchRejected
			}
			c.send(collab.EncodeServerAck(uint64(r.head+1), 0))
			return nil
		}
		writeCtx := store.WithDocumentActor(ctx, c.user.ID)
		if c.writeGuard != nil {
			seqs, err = r.hub.Store.AppendOpsAtHeadGuarded(writeCtx, *c.writeGuard, r.id, r.head, raws)
		} else {
			// Direct room fixtures do not pass through Hub.Serve.
			seqs, err = r.hub.Store.AppendOpsAtHead(writeCtx, r.id, r.head, raws)
		}
		if err != nil {
			tx.Rollback()
			if errors.Is(err, store.ErrConflict) {
				// Give other instances time to finish their bursts; vary the
				// delay by replica so competing rooms do not retry in lockstep.
				delay := time.Duration(1+(attempt*5+int(c.clientID%7))%8) * time.Millisecond
				timer := time.NewTimer(delay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return ctx.Err()
				case <-timer.C:
				}
				continue
			}
			if errors.Is(err, store.ErrOpIdentityConflict) {
				// A single invalid client must not reset other collaborators.
				// The rollback left this room at its last durable head.
				c.send(collab.EncodeError("bad_ops", "operation identity conflicts with document history"))
				return errBatchRejected
			}
			if errors.Is(err, store.ErrForbidden) || errors.Is(err, store.ErrUnauthenticated) || errors.Is(err, store.ErrNotFound) {
				c.send(collab.EncodeError("read_only", "session or edit access is no longer valid"))
				return errBatchRejected
			}
			r.hub.Log.Error("append ops", "doc", r.id, "err", err)
			r.reset()
			return err
		}
		tx.Commit()
		committed = true
		break
	}
	if !committed {
		// The connection will retry its unacknowledged batch on reconnect;
		// the room and all other connections retain their correct state.
		c.send(collab.EncodeError("retry", "document is busy; retry the batch"))
		return errBatchRejected
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

// snapshot persists the state at the horizon: the highest seq every recently
// active replica has acknowledged. Compact keeps every character tombstone,
// because replicas that acknowledged a deletion still reference its tombstone
// in later ops (PROTOCOL.md §11), so the snapshot is lossless.
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
		// The previous snapshot was written by the legacy tombstone GC.
		// Rebuild this one from the complete log instead.
		if base, err = r.replayLog(ctx, horizon); err != nil {
			return fmt.Errorf("snapshot %d: %w", r.id, err)
		}
	}
	removed := base.Compact()
	if err := st.SaveSnapshot(ctx, r.id, horizon, base.EncodeState()); err != nil {
		return err
	}
	r.hub.Log.Info("snapshot", "doc", r.id, "seq", horizon, "gc", removed)
	r.snapSeq = horizon
	return nil
}

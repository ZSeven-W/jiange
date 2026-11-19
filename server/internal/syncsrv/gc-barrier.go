package syncsrv

import (
	"context"
	"errors"
	"fmt"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// SafeGCResult reports the outcome of a client-participating safe tombstone GC pass.
type SafeGCResult struct {
	Horizon      int64
	BarrierClock uint64
	Removed      int
	Skipped      string
}

// CompactSnapshotAtSafeHorizon performs client-participating safe tombstone GC
// at the acknowledged horizon:
//  1. Flushes every connected client's latest ACK to the store.
//  2. Computes the horizon across all clients active within GCWindow.
//  3. Verifies EVERY currently connected client in the room has ACKed >= horizon
//     (refusing to compact if any live replica is still behind the horizon).
//  4. Reconstructs the state at `horizon`, determines the deterministic
//     `barrierClock`, compacts leaf tombstones via `CompactAtBarrier(barrierClock)`
//     on both the snapshot candidate and the live room replica, and persists the
//     compacted snapshot at `horizon`.
//
// Because the operation log itself is never pruned, any offline replica that
// reconnects past GCWindow with a stale tombstone reference is still recovered
// losslessly via room.repairFromLog.
func (r *room) CompactSnapshotAtSafeHorizon(ctx context.Context) (SafeGCResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.load(ctx); err != nil {
		return SafeGCResult{}, err
	}
	st := r.hub.Store
	for c := range r.conns {
		if c.acked > c.dbAcked && st.SetAck(ctx, int64(c.clientID), c.acked, r.hub.now()) == nil {
			c.dbAcked = c.acked
		}
	}
	horizon, err := st.Horizon(ctx, r.id, r.hub.now().Add(-r.hub.GCWindow))
	if err != nil {
		return SafeGCResult{}, err
	}
	if horizon > r.head {
		horizon = r.head
	}
	if horizon <= 0 {
		return SafeGCResult{Skipped: "no_horizon"}, nil
	}
	for c := range r.conns {
		if c.acked < horizon {
			return SafeGCResult{Horizon: horizon, Skipped: "client_behind_horizon"}, nil
		}
	}
	base := collab.NewDoc()
	var from int64
	if seq, state, err := st.LatestSnapshot(ctx, r.id); err == nil {
		if seq > horizon {
			return SafeGCResult{Horizon: horizon, Skipped: "newer_snapshot_exists"}, nil
		}
		if base, err = collab.DecodeState(state); err != nil {
			return SafeGCResult{}, err
		}
		from = seq
	} else if !errors.Is(err, store.ErrNotFound) {
		return SafeGCResult{}, err
	}
	barrierClock := base.Clock()
	for from < horizon {
		rows, err := st.OpsAfter(ctx, r.id, from, int(min(horizon-from, catchUpChunk)))
		if err != nil {
			return SafeGCResult{}, err
		}
		if len(rows) == 0 {
			return SafeGCResult{}, fmt.Errorf("safe gc %d: missing operation after seq %d (horizon %d)", r.id, from, horizon)
		}
		for _, row := range rows {
			if row.Seq != from+1 || row.Seq > horizon {
				return SafeGCResult{}, fmt.Errorf("safe gc %d: expected seq %d through %d, got %d", r.id, from+1, horizon, row.Seq)
			}
			from = row.Seq
		}
		_, ops, err := joinRows(rows)
		if err != nil {
			return SafeGCResult{}, err
		}
		for _, op := range ops {
			base.Apply(op)
			if op.ID.Clock > barrierClock {
				barrierClock = op.ID.Clock
			}
		}
	}
	if base.Pending() != 0 {
		if base, err = r.replayLog(ctx, horizon); err != nil {
			return SafeGCResult{}, fmt.Errorf("safe gc %d: %w", r.id, err)
		}
		barrierClock = base.Clock()
	}
	removed := base.CompactAtBarrier(barrierClock)
	if removed > 0 {
		// Mirror the identical barrier compaction on the live room replica.
		r.doc.CompactAtBarrier(barrierClock)
		r.fullLog = false
	}
	if err := st.SaveSnapshot(ctx, r.id, horizon, base.EncodeState()); err != nil {
		return SafeGCResult{}, err
	}
	r.snapSeq = horizon
	r.hub.Log.Info("safe tombstone gc snapshot", "doc", r.id, "horizon", horizon, "barrier_clock", barrierClock, "removed", removed)
	return SafeGCResult{Horizon: horizon, BarrierClock: barrierClock, Removed: removed}, nil
}

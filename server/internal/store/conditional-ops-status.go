package store

import (
	"context"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"
)

func conditionalStatus(doc, user int64, request string, epoch, head int64, receipt *conditionalOpsReceipt) (ConditionalOpsStatus, error) {
	if epoch < 1 || epoch > maxConditionalInteger || head < 0 || head > maxConditionalInteger {
		return ConditionalOpsStatus{}, ErrConflict
	}
	out := ConditionalOpsStatus{DocID: doc, UserID: user, RequestID: request, State: "unknown", CurrentEpoch: epoch, CurrentHead: head}
	if receipt == nil {
		return out, nil
	}
	if receipt.count <= 0 || receipt.count > maxConditionalOps || receipt.first <= 0 || receipt.head < 0 || receipt.head >= maxConditionalInteger || receipt.first != receipt.head+1 || receipt.epoch < 1 || receipt.epoch > maxConditionalInteger {
		return ConditionalOpsStatus{}, ErrConflict
	}
	if receipt.count > maxConditionalInteger-receipt.head || (receipt.epoch == epoch && head < receipt.head+receipt.count) {
		return ConditionalOpsStatus{}, ErrConflict
	}
	out.State = "committed"
	if receipt.epoch != epoch {
		out.State = "history_changed"
	}
	out.Epoch, out.BaseHead, out.First, out.Count = receipt.epoch, receipt.head, receipt.first, receipt.count
	out.Digest = hex.EncodeToString(receipt.digest[:])
	return out, nil
}

func (m *Memory) ConditionalOpsStatus(ctx context.Context, guard RestoreGuard, doc int64, request string) (ConditionalOpsStatus, error) {
	if !versionRequestPattern.MatchString(request) {
		return ConditionalOpsStatus{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return ConditionalOpsStatus{}, err
	}
	d := m.doc(doc)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "doc" {
		return ConditionalOpsStatus{}, ErrNotFound
	}
	if !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleView) {
		return ConditionalOpsStatus{}, ErrForbidden
	}
	epoch := d.historyEpoch
	if epoch < 1 {
		epoch = 1
	}
	var receipt *conditionalOpsReceipt
	if value, ok := d.conditionalOps[conditionalOpsKey{doc: doc, user: guard.UserID, request: request}]; ok {
		receipt = &value
	}
	out, err := conditionalStatus(doc, guard.UserID, request, epoch, int64(len(d.ops)), receipt)
	if err != nil {
		return ConditionalOpsStatus{}, err
	}
	if err = driveMemoryEnd(ctx, guard, expires); err != nil {
		return ConditionalOpsStatus{}, err
	}
	return out, nil
}

func (p *Postgres) ConditionalOpsStatus(ctx context.Context, guard RestoreGuard, doc int64, request string) (out ConditionalOpsStatus, err error) {
	if !versionRequestPattern.MatchString(request) {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var epoch, head int64
		if e := tx.QueryRow(ctx, `SELECT history_epoch,seq FROM doc_heads WHERE doc_id=$1 FOR SHARE`, doc).Scan(&epoch, &head); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		role, _, kind, e := lockCopySource(ctx, tx, doc, guard.UserID)
		if errors.Is(e, ErrNotFound) {
			return ErrForbidden
		}
		if e != nil {
			return e
		}
		if kind != "doc" || RoleRank(role) < RoleRank(RoleView) {
			return ErrForbidden
		}
		ws, e := drivePGNodeWorkspace(ctx, tx, doc)
		if e != nil {
			return e
		}
		if e = drivePGValidChain(ctx, tx, doc, ws); errors.Is(e, ErrConflict) {
			return ErrForbidden
		} else if e != nil {
			return e
		}
		var value conditionalOpsReceipt
		var digest []byte
		e = tx.QueryRow(ctx, `SELECT history_epoch,base_seq,first_seq,op_count,digest FROM doc_conditional_ops_receipts WHERE doc_id=$1 AND user_id=$2 AND request_id=$3`, doc, guard.UserID, request).Scan(&value.epoch, &value.head, &value.first, &value.count, &digest)
		var receipt *conditionalOpsReceipt
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if e == nil {
			if len(digest) != len(value.digest) {
				return ErrConflict
			}
			copy(value.digest[:], digest)
			receipt = &value
		}
		out, e = conditionalStatus(doc, guard.UserID, request, epoch, head, receipt)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		return ConditionalOpsStatus{}, err
	}
	return out, nil
}

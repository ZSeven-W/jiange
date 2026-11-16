package store

import (
	"context"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"
)

func cancellationStatus(doc, user int64, request string, epoch, head int64, cancel conditionalCancellation) (ConditionalOpsStatus, error) {
	if epoch < 1 || epoch > maxConditionalInteger || head < 0 || head > maxConditionalInteger || cancel.epoch < 1 || cancel.epoch > maxConditionalInteger || cancel.head < 0 || cancel.head >= maxConditionalInteger || cancel.count <= 0 || cancel.count > maxConditionalOps || cancel.count > maxConditionalInteger-cancel.head || cancel.client <= 0 || cancel.client > maxConditionalInteger {
		return ConditionalOpsStatus{}, ErrConflict
	}
	state := "cancelled"
	if cancel.epoch != epoch {
		state = "history_changed"
	}
	return ConditionalOpsStatus{DocID: doc, UserID: user, RequestID: request, State: state, CurrentEpoch: epoch, CurrentHead: head, Epoch: cancel.epoch, BaseHead: cancel.head, First: cancel.head + 1, Count: cancel.count, ClientID: cancel.client, Digest: hex.EncodeToString(cancel.digest[:])}, nil
}
func matchesCancellation(a, b conditionalCancellation) bool {
	return a.epoch == b.epoch && a.head == b.head && a.count == b.count && a.client == b.client && a.digest == b.digest
}
func matchesCancellationReceipt(c conditionalCancellation, r conditionalOpsReceipt) bool {
	return c.epoch == r.epoch && c.head == r.head && c.count == r.count && c.digest == r.digest
}
func validCancellation(c conditionalCancellation, request string) bool {
	return versionRequestPattern.MatchString(request) && c.epoch > 0 && c.epoch <= maxConditionalInteger && c.head >= 0 && c.head < maxConditionalInteger && c.count > 0 && c.count <= maxConditionalOps && c.count <= maxConditionalInteger-c.head && c.client > 0 && c.client <= maxConditionalInteger
}

func (m *Memory) CancelConditionalOps(ctx context.Context, guard RestoreGuard, doc, epoch, head, count, client int64, request string, digest [32]byte) (ConditionalOpsStatus, error) {
	candidate := conditionalCancellation{epoch: epoch, head: head, count: count, client: client, digest: digest}
	if !validCancellation(candidate, request) {
		return ConditionalOpsStatus{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return ConditionalOpsStatus{}, err
	}
	d := m.doc(doc)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "doc" || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleEdit) {
		return ConditionalOpsStatus{}, ErrForbidden
	}
	if client > int64(len(m.d.clients)) {
		return ConditionalOpsStatus{}, ErrForbidden
	}
	author := m.d.clients[client-1]
	if author.user != guard.UserID || author.doc != doc {
		return ConditionalOpsStatus{}, ErrForbidden
	}
	currentEpoch := d.historyEpoch
	if currentEpoch < 1 {
		currentEpoch = 1
	}
	currentHead := int64(len(d.ops))
	if currentEpoch != epoch || currentHead < head {
		return ConditionalOpsStatus{}, ErrConflict
	}
	key := conditionalOpsKey{doc: doc, user: guard.UserID, request: request}
	receipt, hasReceipt := d.conditionalOps[key]
	existing, hasCancel := d.conditionalCancels[key]
	if hasReceipt && hasCancel {
		return ConditionalOpsStatus{}, ErrConflict
	}
	if hasReceipt {
		if !matchesCancellationReceipt(candidate, receipt) || receipt.first < 1 || receipt.first > int64(len(d.ops)) || d.ops[receipt.first-1].ClientID != client {
			return ConditionalOpsStatus{}, ErrConflict
		}
		if err = driveMemoryEnd(ctx, guard, expires); err != nil {
			return ConditionalOpsStatus{}, err
		}
		return conditionalStatus(doc, guard.UserID, request, currentEpoch, currentHead, &receipt)
	}
	if hasCancel && !matchesCancellation(candidate, existing) {
		return ConditionalOpsStatus{}, ErrConflict
	}
	result, err := cancellationStatus(doc, guard.UserID, request, currentEpoch, currentHead, candidate)
	if err != nil {
		return ConditionalOpsStatus{}, err
	}
	if err = driveMemoryEnd(ctx, guard, expires); err != nil {
		return ConditionalOpsStatus{}, err
	}
	if !hasCancel {
		if d.conditionalCancels == nil {
			d.conditionalCancels = make(map[conditionalOpsKey]conditionalCancellation)
		}
		d.conditionalCancels[key] = candidate
	}
	return result, nil
}

func (p *Postgres) CancelConditionalOps(ctx context.Context, guard RestoreGuard, doc, epoch, head, count, client int64, request string, digest [32]byte) (out ConditionalOpsStatus, err error) {
	candidate := conditionalCancellation{epoch: epoch, head: head, count: count, client: client, digest: digest}
	if !validCancellation(candidate, request) {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var currentEpoch, currentHead int64
		if e := tx.QueryRow(ctx, `SELECT history_epoch,seq FROM doc_heads WHERE doc_id=$1 FOR UPDATE`, doc).Scan(&currentEpoch, &currentHead); errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		} else if e != nil {
			return e
		}
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		var ws int64
		var kind string
		var deleted bool
		if e = tx.QueryRow(ctx, `SELECT workspace_id,kind,deleted_at IS NOT NULL FROM nodes WHERE id=$1 FOR UPDATE`, doc).Scan(&ws, &kind, &deleted); errors.Is(e, pgx.ErrNoRows) {
			return ErrForbidden
		} else if e != nil {
			return e
		}
		if kind != "doc" || deleted {
			return ErrForbidden
		}
		role, _, _, e := lockCopySource(ctx, tx, doc, guard.UserID)
		if errors.Is(e, ErrNotFound) {
			return ErrForbidden
		}
		if e != nil {
			return e
		}
		if RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		if e = drivePGValidChain(ctx, tx, doc, ws); errors.Is(e, ErrConflict) {
			return ErrForbidden
		} else if e != nil {
			return e
		}
		var authorUser, authorDoc int64
		if e = tx.QueryRow(ctx, `SELECT user_id,doc_id FROM doc_clients WHERE id=$1 FOR SHARE`, client).Scan(&authorUser, &authorDoc); errors.Is(e, pgx.ErrNoRows) {
			return ErrForbidden
		} else if e != nil {
			return e
		}
		if authorUser != guard.UserID || authorDoc != doc {
			return ErrForbidden
		}
		if currentEpoch != epoch || currentHead < head {
			return ErrConflict
		}
		var receipt conditionalOpsReceipt
		var receiptDigest []byte
		e = tx.QueryRow(ctx, `SELECT history_epoch,base_seq,first_seq,op_count,digest FROM doc_conditional_ops_receipts WHERE doc_id=$1 AND user_id=$2 AND request_id=$3`, doc, guard.UserID, request).Scan(&receipt.epoch, &receipt.head, &receipt.first, &receipt.count, &receiptDigest)
		hasReceipt := e == nil
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if hasReceipt {
			if len(receiptDigest) != 32 {
				return ErrConflict
			}
			copy(receipt.digest[:], receiptDigest)
		}
		var existing conditionalCancellation
		var cancelDigest []byte
		e = tx.QueryRow(ctx, `SELECT history_epoch,base_seq,op_count,client_id,digest FROM doc_conditional_ops_cancellations WHERE doc_id=$1 AND user_id=$2 AND request_id=$3`, doc, guard.UserID, request).Scan(&existing.epoch, &existing.head, &existing.count, &existing.client, &cancelDigest)
		hasCancel := e == nil
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if hasCancel {
			if len(cancelDigest) != 32 {
				return ErrConflict
			}
			copy(existing.digest[:], cancelDigest)
		}
		if hasReceipt && hasCancel {
			return ErrConflict
		}
		if hasReceipt {
			if !matchesCancellationReceipt(candidate, receipt) {
				return ErrConflict
			}
			var firstAuthor int64
			if e = tx.QueryRow(ctx, `SELECT client_id FROM doc_ops WHERE doc_id=$1 AND seq=$2`, doc, receipt.first).Scan(&firstAuthor); errors.Is(e, pgx.ErrNoRows) {
				return ErrConflict
			} else if e != nil {
				return e
			}
			if firstAuthor != client {
				return ErrConflict
			}
			out, e = conditionalStatus(doc, guard.UserID, request, currentEpoch, currentHead, &receipt)
			if e != nil {
				return e
			}
			return drivePGEnd(ctx, guard, expires)
		}
		if hasCancel && !matchesCancellation(candidate, existing) {
			return ErrConflict
		}
		if !hasCancel {
			if _, e = tx.Exec(ctx, `INSERT INTO doc_conditional_ops_cancellations(doc_id,user_id,request_id,history_epoch,base_seq,op_count,client_id,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, doc, guard.UserID, request, epoch, head, count, client, digest[:]); e != nil {
				return e
			}
		}
		out, e = cancellationStatus(doc, guard.UserID, request, currentEpoch, currentHead, candidate)
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

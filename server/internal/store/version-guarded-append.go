package store

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// VersionGuardedAppender is a storage primitive for future conditional edits.
// Callers must separately validate operation authorship and dependencies. Exact
// retries are rejected rather than assumed to have succeeded; this interface
// does not provide an idempotency receipt.
type VersionGuardedAppender interface {
	AppendOpsAtVersionGuarded(context.Context, RestoreGuard, int64, int64, int64, []RawOp) ([]int64, error)
}

// AppendOpsAtVersionGuarded checks both log generation and sequence while
// holding the same lock as ordinary writes, access changes, and epoch bumps.
func (m *Memory) AppendOpsAtVersionGuarded(ctx context.Context, guard RestoreGuard, doc, expectedEpoch, expectedHead int64, ops []RawOp) ([]int64, error) {
	return m.appendVersionGuarded(ctx, guard, doc, expectedEpoch, expectedHead, ops, nil)
}

type conditionalRequest struct {
	request string
	digest  [32]byte
	probe   bool
	title   *conditionalTitle
}

type conditionalTitle struct{ expected, value string }

func (m *Memory) CommitConditionalTitleOps(ctx context.Context, guard RestoreGuard, doc, expectedEpoch, expectedHead int64, request string, ops []RawOp, expected, value string) ([]int64, error) {
	digest, err := conditionalDigest(expectedEpoch, expectedHead, request, ops)
	if err != nil {
		return nil, err
	}
	return m.appendVersionGuarded(ctx, guard, doc, expectedEpoch, expectedHead, ops, &conditionalRequest{request: request, digest: digest, title: &conditionalTitle{expected: expected, value: value}})
}

func (m *Memory) CommitConditionalOps(ctx context.Context, guard RestoreGuard, doc, expectedEpoch, expectedHead int64, request string, ops []RawOp) ([]int64, error) {
	digest, err := conditionalDigest(expectedEpoch, expectedHead, request, ops)
	if err != nil {
		return nil, err
	}
	return m.appendVersionGuarded(ctx, guard, doc, expectedEpoch, expectedHead, ops, &conditionalRequest{request: request, digest: digest})
}

// LookupConditionalOps returns ErrNotFound when no receipt exists yet. A
// concurrent submission may still commit after that observation.
func (m *Memory) LookupConditionalOps(ctx context.Context, guard RestoreGuard, doc, expectedEpoch, expectedHead int64, request string, ops []RawOp) ([]int64, error) {
	digest, err := conditionalDigest(expectedEpoch, expectedHead, request, ops)
	if err != nil {
		return nil, err
	}
	return m.appendVersionGuarded(ctx, guard, doc, expectedEpoch, expectedHead, ops, &conditionalRequest{request: request, digest: digest, probe: true})
}

func (m *Memory) appendVersionGuarded(ctx context.Context, guard RestoreGuard, doc, expectedEpoch, expectedHead int64, ops []RawOp, request *conditionalRequest) ([]int64, error) {
	m.mu.Lock()
	d := m.doc(doc)
	if d == nil {
		m.mu.Unlock()
		return nil, ErrNotFound
	}
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		m.mu.Unlock()
		return nil, err
	}
	if d.meta.Kind != "doc" || d.deleted || d.purged || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleEdit) {
		m.mu.Unlock()
		return nil, ErrForbidden
	}
	epoch := d.historyEpoch
	if epoch < 1 {
		epoch = 1
	}
	if expectedEpoch < 1 || epoch != expectedEpoch || expectedHead < 0 {
		m.mu.Unlock()
		return nil, ErrConflict
	}
	if request != nil {
		key := conditionalOpsKey{doc: doc, user: guard.UserID, request: request.request}
		if old, ok := d.conditionalOps[key]; ok {
			if _, cancelled := d.conditionalCancels[key]; cancelled {
				m.mu.Unlock()
				return nil, ErrConflict
			}
			if old.epoch != expectedEpoch || old.head != expectedHead || old.digest != request.digest || old.count != int64(len(ops)) || int64(len(d.ops)) < old.first+old.count-1 {
				m.mu.Unlock()
				return nil, ErrConflict
			}
			if err := driveMemoryEnd(ctx, guard, expires); err != nil {
				m.mu.Unlock()
				return nil, err
			}
			m.mu.Unlock()
			return conditionalSequences(old), nil
		}
		if _, cancelled := d.conditionalCancels[key]; cancelled {
			m.mu.Unlock()
			return nil, ErrConflict
		}
		if request.probe {
			if err := driveMemoryEnd(ctx, guard, expires); err != nil {
				m.mu.Unlock()
				return nil, err
			}
			m.mu.Unlock()
			return nil, ErrNotFound
		}
	}
	if int64(len(d.ops)) != expectedHead {
		m.mu.Unlock()
		return nil, ErrConflict
	}
	if request != nil && request.title != nil && d.meta.Title != request.title.expected {
		m.mu.Unlock()
		return nil, ErrConflict
	}
	batch, err := prepareMemoryIdentityBatch(d, ops)
	if err != nil {
		m.mu.Unlock()
		return nil, err
	}
	for _, duplicate := range batch.duplicate {
		if duplicate {
			m.mu.Unlock()
			return nil, ErrConflict
		}
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	seqs := make([]int64, len(ops))
	if len(ops) == 0 {
		m.mu.Unlock()
		return seqs, nil
	}
	batch.commit(d)
	now := time.Now()
	for i, op := range ops {
		seqs[i] = int64(len(d.ops) + 1)
		d.ids[[2]int64{op.ClientID, op.Clock}] = true
		d.ops = append(d.ops, SeqOp{seqs[i], op.ClientID, slices.Clone(op.Bytes)})
		d.opAt = append(d.opAt, now)
	}
	d.meta.UpdatedAt = now
	if request != nil && request.title != nil {
		d.meta.Title = request.title.value
	}
	m.setDocumentModifierLocked(d, guard.UserID)
	head, subscribers := int64(len(d.ops)), slices.Clone(m.d.subs)
	if request != nil {
		if d.conditionalOps == nil {
			d.conditionalOps = make(map[conditionalOpsKey]conditionalOpsReceipt)
		}
		d.conditionalOps[conditionalOpsKey{doc: doc, user: guard.UserID, request: request.request}] = conditionalOpsReceipt{epoch: expectedEpoch, head: expectedHead, first: seqs[0], count: int64(len(seqs)), digest: request.digest}
	}
	m.mu.Unlock()
	for _, fn := range subscribers {
		fn(doc, head)
	}
	return seqs, nil
}

func (p *Postgres) AppendOpsAtVersionGuarded(ctx context.Context, guard RestoreGuard, doc, expectedEpoch, expectedHead int64, ops []RawOp) (seqs []int64, err error) {
	return p.appendVersionGuarded(ctx, guard, doc, expectedEpoch, expectedHead, ops, nil)
}

func (p *Postgres) CommitConditionalOps(ctx context.Context, guard RestoreGuard, doc, expectedEpoch, expectedHead int64, request string, ops []RawOp) ([]int64, error) {
	digest, err := conditionalDigest(expectedEpoch, expectedHead, request, ops)
	if err != nil {
		return nil, err
	}
	return p.appendVersionGuarded(ctx, guard, doc, expectedEpoch, expectedHead, ops, &conditionalRequest{request: request, digest: digest})
}

func (p *Postgres) CommitConditionalTitleOps(ctx context.Context, guard RestoreGuard, doc, expectedEpoch, expectedHead int64, request string, ops []RawOp, expected, value string) ([]int64, error) {
	digest, err := conditionalDigest(expectedEpoch, expectedHead, request, ops)
	if err != nil {
		return nil, err
	}
	return p.appendVersionGuarded(ctx, guard, doc, expectedEpoch, expectedHead, ops, &conditionalRequest{request: request, digest: digest, title: &conditionalTitle{expected: expected, value: value}})
}

func (p *Postgres) LookupConditionalOps(ctx context.Context, guard RestoreGuard, doc, expectedEpoch, expectedHead int64, request string, ops []RawOp) ([]int64, error) {
	digest, err := conditionalDigest(expectedEpoch, expectedHead, request, ops)
	if err != nil {
		return nil, err
	}
	return p.appendVersionGuarded(ctx, guard, doc, expectedEpoch, expectedHead, ops, &conditionalRequest{request: request, digest: digest, probe: true})
}

func (p *Postgres) appendVersionGuarded(ctx context.Context, guard RestoreGuard, doc, expectedEpoch, expectedHead int64, ops []RawOp, request *conditionalRequest) (seqs []int64, err error) {
	seqs = make([]int64, len(ops))
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var epoch, head int64
		if err := tx.QueryRow(ctx, `SELECT history_epoch,seq FROM doc_heads WHERE doc_id=$1 FOR UPDATE`, doc).Scan(&epoch, &head); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		expires, err := drivePGSession(ctx, tx, guard)
		if err != nil {
			return err
		}
		var ws int64
		var kind, directoryTitle string
		var deleted bool
		err = tx.QueryRow(ctx, `SELECT workspace_id,kind,title,deleted_at IS NOT NULL FROM nodes WHERE id=$1 FOR UPDATE`, doc).Scan(&ws, &kind, &directoryTitle, &deleted)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if kind != "doc" || deleted {
			return ErrForbidden
		}
		role, _, _, err := lockCopySource(ctx, tx, doc, guard.UserID)
		if errors.Is(err, ErrNotFound) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		if err = drivePGValidChain(ctx, tx, doc, ws); errors.Is(err, ErrConflict) {
			return ErrForbidden
		} else if err != nil {
			return err
		}
		if expectedEpoch < 1 || epoch != expectedEpoch || expectedHead < 0 {
			return ErrConflict
		}
		if request != nil {
			var old conditionalOpsReceipt
			var digest []byte
			err = tx.QueryRow(ctx, `SELECT history_epoch,base_seq,first_seq,op_count,digest FROM doc_conditional_ops_receipts WHERE doc_id=$1 AND user_id=$2 AND request_id=$3`, doc, guard.UserID, request.request).Scan(&old.epoch, &old.head, &old.first, &old.count, &digest)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if err == nil {
				var cancelled bool
				if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM doc_conditional_ops_cancellations WHERE doc_id=$1 AND user_id=$2 AND request_id=$3)`, doc, guard.UserID, request.request).Scan(&cancelled); err != nil {
					return err
				}
				if cancelled {
					return ErrConflict
				}
				if len(digest) != len(old.digest) {
					return ErrConflict
				}
				copy(old.digest[:], digest)
				if old.epoch != expectedEpoch || old.head != expectedHead || old.digest != request.digest || old.count != int64(len(ops)) || head < old.first+old.count-1 {
					return ErrConflict
				}
				seqs = conditionalSequences(old)
				return drivePGEnd(ctx, guard, expires)
			}
			var cancelled bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM doc_conditional_ops_cancellations WHERE doc_id=$1 AND user_id=$2 AND request_id=$3)`, doc, guard.UserID, request.request).Scan(&cancelled); err != nil {
				return err
			}
			if cancelled {
				return ErrConflict
			}
			if request.probe {
				if err := drivePGEnd(ctx, guard, expires); err != nil {
					return err
				}
				return ErrNotFound
			}
		}
		if head != expectedHead {
			return ErrConflict
		}
		if request != nil && request.title != nil && directoryTitle != request.title.expected {
			return ErrConflict
		}
		for i, op := range ops {
			duplicate, err := checkOperationIdentity(ctx, tx, doc, op)
			if err != nil {
				return err
			}
			if duplicate {
				return ErrConflict
			}
			tag, err := tx.Exec(ctx, `INSERT INTO doc_ops (doc_id,seq,client_id,clock,op) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (doc_id,client_id,clock) DO NOTHING`, doc, head+1, op.ClientID, op.Clock, op.Bytes)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return ErrOpIdentityConflict
			}
			head++
			if err = insertOperationRange(ctx, tx, doc, head, op); err != nil {
				return err
			}
			seqs[i] = head
		}
		if len(ops) > 0 {
			if _, err = tx.Exec(ctx, `UPDATE doc_heads SET seq=$2 WHERE doc_id=$1`, doc, head); err != nil {
				return err
			}
			if request != nil && request.title != nil {
				_, err = tx.Exec(ctx, `UPDATE nodes SET title=$2, updated_at=now() WHERE id=$1`, doc, request.title.value)
			} else {
				_, err = tx.Exec(ctx, `UPDATE nodes SET updated_at=now() WHERE id=$1`, doc)
			}
			if err != nil {
				return err
			}
			if err = recordDocumentModifier(ctx, tx, doc, guard.UserID); err != nil {
				return err
			}
			if request != nil {
				_, err = tx.Exec(ctx, `INSERT INTO doc_conditional_ops_receipts(doc_id,user_id,request_id,history_epoch,base_seq,first_seq,op_count,digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, doc, guard.UserID, request.request, expectedEpoch, expectedHead, seqs[0], len(seqs), request.digest[:])
				if err != nil {
					return err
				}
			}
			if _, err = tx.Exec(ctx, `SELECT pg_notify($1,$2)`, NotifyChannel, strconv.FormatInt(doc, 10)+":"+strconv.FormatInt(head, 10)); err != nil {
				return err
			}
		}
		return drivePGEnd(ctx, guard, expires)
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		return nil, err
	}
	return seqs, nil
}

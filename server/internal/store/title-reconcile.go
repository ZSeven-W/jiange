package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// TitleReconciler compares both history identity and the directory name while
// holding the same locks used for edits, access changes, and renames.
type TitleReconciler interface {
	ReconcileDocumentTitle(context.Context, RestoreGuard, int64, int64, int64, string, string) error
}

func (m *Memory) ReconcileDocumentTitle(ctx context.Context, guard RestoreGuard, id, epoch, head int64, expected, title string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return err
	}
	d := m.doc(id)
	if d == nil || d.meta.Kind != "doc" || d.deleted || d.purged || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleEdit) {
		return ErrForbidden
	}
	actualEpoch := d.historyEpoch
	if actualEpoch < 1 {
		actualEpoch = 1
	}
	if epoch < 1 || epoch != actualEpoch || head != int64(len(d.ops)) || d.meta.Title != expected {
		return ErrConflict
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	if d.meta.Title != title {
		d.meta.Title = title
		d.meta.UpdatedAt = time.Now()
		m.setDocumentModifierLocked(d, guard.UserID)
	}
	return nil
}

func (p *Postgres) ReconcileDocumentTitle(ctx context.Context, guard RestoreGuard, id, epoch, head int64, expected, title string) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var actualEpoch, actualHead int64
		if err := tx.QueryRow(ctx, `SELECT history_epoch,seq FROM doc_heads WHERE doc_id=$1 FOR UPDATE`, id).Scan(&actualEpoch, &actualHead); errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		expires, err := drivePGSession(ctx, tx, guard)
		if err != nil {
			return err
		}
		var ws int64
		var kind, old string
		var deleted bool
		if err = tx.QueryRow(ctx, `SELECT workspace_id,kind,title,deleted_at IS NOT NULL FROM nodes WHERE id=$1 FOR UPDATE`, id).Scan(&ws, &kind, &old, &deleted); errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		} else if err != nil {
			return err
		}
		if kind != "doc" || deleted {
			return ErrForbidden
		}
		role, _, _, err := lockCopySource(ctx, tx, id, guard.UserID)
		if errors.Is(err, ErrNotFound) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		if err = drivePGValidChain(ctx, tx, id, ws); errors.Is(err, ErrConflict) {
			return ErrForbidden
		} else if err != nil {
			return err
		}
		if epoch < 1 || actualEpoch != epoch || actualHead != head || old != expected {
			return ErrConflict
		}
		if old != title {
			if _, err = tx.Exec(ctx, `UPDATE nodes SET title=$2, updated_at=now() WHERE id=$1`, id, title); err != nil {
				return err
			}
			if err = recordDocumentModifier(ctx, tx, id, guard.UserID); err != nil {
				return err
			}
		}
		return drivePGEnd(ctx, guard, expires)
	})
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}

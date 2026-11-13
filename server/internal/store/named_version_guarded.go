package store

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

// CreateNamedVersion publishes a server-materialized snapshot only while the
// original session, effective edit role, history epoch and head still match.
// A retry with the same author and label is safe; a different label never
// silently renames a version already occupying the same sequence.
func (m *Memory) CreateNamedVersion(ctx context.Context, guard RestoreGuard, docID, epoch, head int64, state []byte, label string) (Version, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return Version{}, err
	}
	d := m.doc(docID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "doc" {
		return Version{}, ErrNotFound
	}
	if !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) {
		return Version{}, ErrForbidden
	}
	if RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleEdit) {
		return Version{}, ErrForbidden
	}
	currentEpoch := d.historyEpoch
	if currentEpoch < 1 {
		currentEpoch = 1
	}
	if epoch != currentEpoch || head <= 0 || int64(len(d.ops)) != head {
		return Version{}, ErrConflict
	}
	if existing, ok := d.snaps[head]; ok && !bytes.Equal(existing, state) {
		return Version{}, ErrConflict
	}
	if v, ok := d.versions[head]; ok {
		if v.Label != label || v.UserID != guard.UserID {
			return Version{}, ErrConflict
		}
		if err = ctx.Err(); err != nil {
			return Version{}, err
		}
		if !guard.currentTime().Before(expires) {
			return Version{}, ErrUnauthenticated
		}
		return Version{Seq: head, Label: v.Label, CreatedBy: v.UserID, CreatedByName: m.users[v.UserID-1].Name, CreatedAt: v.At}, nil
	}
	if err = ctx.Err(); err != nil {
		return Version{}, err
	}
	if !guard.currentTime().Before(expires) {
		return Version{}, ErrUnauthenticated
	}
	d.snaps[head] = slices.Clone(state)
	at := time.Now()
	d.versions[head] = memVersion{Label: label, UserID: guard.UserID, At: at}
	return Version{Seq: head, Label: label, CreatedBy: guard.UserID, CreatedByName: m.users[guard.UserID-1].Name, CreatedAt: at}, nil
}

func (p *Postgres) CreateNamedVersion(ctx context.Context, guard RestoreGuard, docID, epoch, head int64, state []byte, label string) (out Version, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var actualEpoch, actualHead int64
		e := tx.QueryRow(ctx, `SELECT history_epoch,seq FROM doc_heads WHERE doc_id=$1 FOR UPDATE`, docID).Scan(&actualEpoch, &actualHead)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		role, _, kind, e := lockCopySource(ctx, tx, docID, guard.UserID)
		if e != nil {
			return e
		}
		if kind != "doc" || RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		ws, e := drivePGNodeWorkspace(ctx, tx, docID)
		if e != nil {
			return e
		}
		if e = drivePGValidChain(ctx, tx, docID, ws); e != nil {
			return ErrForbidden
		}
		if epoch != actualEpoch || head <= 0 || actualHead != head {
			return ErrConflict
		}
		_, e = tx.Exec(ctx, `INSERT INTO doc_snapshots (doc_id,seq,state) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, docID, head, compressState(state))
		if e != nil {
			return e
		}
		var oldState []byte
		var existing bool
		var oldLabel string
		var creator *int64
		var createdAt time.Time
		e = tx.QueryRow(ctx, `SELECT state,is_version,label,created_by,created_at FROM doc_snapshots WHERE doc_id=$1 AND seq=$2 FOR UPDATE`, docID, head).Scan(&oldState, &existing, &oldLabel, &creator, &createdAt)
		if e != nil {
			return e
		}
		if !bytes.Equal(decompressState(oldState), state) {
			return ErrConflict
		}
		if existing {
			if creator == nil || *creator != guard.UserID || oldLabel != label {
				return ErrConflict
			}
		} else {
			e = tx.QueryRow(ctx, `UPDATE doc_snapshots SET is_version=true,label=$3,created_by=$4,created_at=now() WHERE doc_id=$1 AND seq=$2 RETURNING created_at`, docID, head, label, guard.UserID).Scan(&createdAt)
			if e != nil {
				return e
			}
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		var name string
		if e = tx.QueryRow(ctx, `SELECT name FROM users WHERE id=$1`, guard.UserID).Scan(&name); e != nil {
			return e
		}
		out = Version{Seq: head, Label: label, CreatedBy: guard.UserID, CreatedByName: name, CreatedAt: createdAt}
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	return
}

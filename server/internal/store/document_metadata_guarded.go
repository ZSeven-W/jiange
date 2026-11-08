package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type DocMetadataPatch struct {
	Title    *string
	Move     bool
	ParentID *int64
}

func (m *Memory) PatchDocMetadataGuarded(ctx context.Context, guard RestoreGuard, docID int64, patch DocMetadataPatch) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return err
	}
	doc := m.doc(docID)
	if doc == nil || doc.deleted || doc.purged || doc.meta.Kind == "file" || doc.meta.Kind == "folder" || !m.driveValidChainLocked(doc, doc.meta.WorkspaceID, false) {
		return ErrForbidden
	}
	minimum := RoleEdit
	if patch.Move {
		minimum = RoleManage
	}
	if RoleRank(m.roleLocked(guard.UserID, doc)) < RoleRank(minimum) {
		return ErrForbidden
	}
	if patch.Move {
		if m.driveFolderAncestorLocked(doc) {
			return ErrConflict
		}
		if patch.ParentID != nil {
			parent := m.doc(*patch.ParentID)
			if parent == nil || parent.deleted || parent.meta.Kind == "file" || parent.meta.WorkspaceID != doc.meta.WorkspaceID || parent.personal != doc.personal || !m.driveValidChainLocked(parent, doc.meta.WorkspaceID, false) || RoleRank(m.roleLocked(guard.UserID, parent)) < RoleRank(RoleView) {
				return ErrForbidden
			}
			if m.driveFolderAncestorLocked(parent) {
				return ErrConflict
			}
			for node := parent; node != nil; {
				if node.meta.ID == docID {
					return ErrConflict
				}
				if node.meta.ParentID == nil {
					break
				}
				node = m.doc(*node.meta.ParentID)
			}
		}
	}
	if err = driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	if patch.Move {
		doc.meta.ParentID = cloneDriveParent(patch.ParentID)
	}
	if patch.Title != nil {
		doc.meta.Title = *patch.Title
	}
	if patch.Move || patch.Title != nil {
		doc.meta.UpdatedAt = time.Now()
		m.setDocumentModifierLocked(doc, guard.UserID)
	}
	return nil
}

func driveMemoryEnd(ctx context.Context, guard RestoreGuard, expires time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !guard.currentTime().Before(expires) {
		return ErrUnauthenticated
	}
	return nil
}

func (p *Postgres) PatchDocMetadataGuarded(ctx context.Context, guard RestoreGuard, docID int64, patch DocMetadataPatch) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		ws, e := drivePGNodeWorkspace(ctx, tx, docID)
		if e != nil {
			return e
		}
		if e = drivePGLockWorkspace(ctx, tx, ws); e != nil {
			return e
		}
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		var currentWS int64
		var personal, deleted bool
		var kind string
		if e = tx.QueryRow(ctx, `SELECT workspace_id,personal,deleted_at IS NOT NULL,kind FROM nodes WHERE id=$1 FOR UPDATE`, docID).Scan(&currentWS, &personal, &deleted, &kind); errors.Is(e, pgx.ErrNoRows) {
			return ErrForbidden
		} else if e != nil {
			return e
		}
		if currentWS != ws || deleted || kind == "file" || kind == "folder" {
			return ErrForbidden
		}
		if e = drivePGValidChain(ctx, tx, docID, ws); e != nil {
			return e
		}
		role, _, _, e := lockCopySource(ctx, tx, docID, guard.UserID)
		if errors.Is(e, ErrNotFound) {
			return ErrForbidden
		}
		if e != nil {
			return e
		}
		minimum := RoleEdit
		if patch.Move {
			minimum = RoleManage
		}
		if RoleRank(role) < RoleRank(minimum) {
			return ErrForbidden
		}
		if patch.Move && patch.ParentID != nil {
			var parentWS int64
			var parentPersonal, parentDeleted bool
			var parentKind string
			if e = tx.QueryRow(ctx, `SELECT workspace_id,personal,deleted_at IS NOT NULL,kind FROM nodes WHERE id=$1 FOR SHARE`, *patch.ParentID).Scan(&parentWS, &parentPersonal, &parentDeleted, &parentKind); errors.Is(e, pgx.ErrNoRows) {
				return ErrForbidden
			} else if e != nil {
				return e
			}
			if parentWS != ws || parentDeleted || parentPersonal != personal || parentKind == "file" {
				return ErrForbidden
			}
			if e = drivePGValidChain(ctx, tx, *patch.ParentID, ws); e != nil {
				return e
			}
			parentRole, _, _, e := lockCopySource(ctx, tx, *patch.ParentID, guard.UserID)
			if errors.Is(e, ErrNotFound) {
				return ErrForbidden
			}
			if e != nil {
				return e
			}
			if RoleRank(parentRole) < RoleRank(RoleView) {
				return ErrForbidden
			}
			var cycle bool
			if e = tx.QueryRow(ctx, `WITH RECURSIVE a AS (SELECT id,parent_id,ARRAY[id] seen FROM nodes WHERE id=$1 UNION ALL SELECT n.id,n.parent_id,a.seen||n.id FROM nodes n JOIN a ON n.id=a.parent_id WHERE NOT n.id=ANY(a.seen)) SELECT EXISTS(SELECT 1 FROM a WHERE id=$2)`, *patch.ParentID, docID).Scan(&cycle); e != nil {
				return e
			}
			if cycle {
				return ErrConflict
			}
		}
		if e = drivePGEnd(ctx, guard, expires); e != nil {
			return e
		}
		switch {
		case patch.Move && patch.Title != nil:
			_, e = tx.Exec(ctx, `UPDATE nodes SET parent_id=$2,title=$3,updated_at=now() WHERE id=$1`, docID, patch.ParentID, *patch.Title)
		case patch.Move:
			_, e = tx.Exec(ctx, `UPDATE nodes SET parent_id=$2,updated_at=now() WHERE id=$1`, docID, patch.ParentID)
		case patch.Title != nil:
			_, e = tx.Exec(ctx, `UPDATE nodes SET title=$2,updated_at=now() WHERE id=$1`, docID, *patch.Title)
		}
		if e != nil {
			return e
		}
		if patch.Move || patch.Title != nil {
			if e = recordDocumentModifier(ctx, tx, docID, guard.UserID); e != nil {
				return e
			}
		}
		return drivePGEnd(ctx, guard, expires)
	})
	var pgErr *pgconn.PgError
	if retryableRestoreConflict(err) || errors.As(err, &pgErr) && pgErr.Code == "23514" {
		return ErrConflict
	}
	return err
}

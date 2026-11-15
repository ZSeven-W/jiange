package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// SlidesTitleStore applies a title edit only to the exact state that was shown
// to the editor. Legacy metadata updates do not always advance drive_revision.
type SlidesTitleStore interface {
	RenameSlidesTitle(context.Context, RestoreGuard, int64, string, string, int64) (DriveEntry, error)
}

func (m *Memory) RenameSlidesTitle(ctx context.Context, g RestoreGuard, id int64, title, expectedTitle string, expectedRevision int64) (DriveEntry, error) {
	if !validDriveTitle(title) {
		return DriveEntry{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return DriveEntry{}, err
	}
	d := m.doc(id)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "slides" || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(g.UserID, d)) < RoleRank(RoleEdit) {
		return DriveEntry{}, ErrForbidden
	}
	if d.driveRevision != expectedRevision || d.driveRevision >= maxDriveRevision || d.meta.Title != expectedTitle {
		return DriveEntry{}, ErrConflict
	}
	if err := driveMemoryEnd(ctx, g, expires); err != nil {
		return DriveEntry{}, err
	}
	d.meta.Title = title
	d.driveRevision++
	d.meta.DriveRevision = d.driveRevision
	d.meta.UpdatedAt = time.Now()
	m.setDocumentModifierLocked(d, g.UserID)
	return driveMemoryEntry(m, d, g.UserID), nil
}

func (p *Postgres) RenameSlidesTitle(ctx context.Context, g RestoreGuard, id int64, title, expectedTitle string, expectedRevision int64) (out DriveEntry, err error) {
	if !validDriveTitle(title) {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		ws, e := drivePGNodeWorkspace(ctx, tx, id)
		if e != nil {
			return e
		}
		if e = drivePGLockWorkspace(ctx, tx, ws); e != nil {
			return e
		}
		expires, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		var currentWS, revision int64
		var currentTitle, kind string
		var deleted bool
		e = tx.QueryRow(ctx, `SELECT workspace_id,drive_revision,title,kind,deleted_at IS NOT NULL FROM nodes WHERE id=$1 FOR UPDATE`, id).Scan(&currentWS, &revision, &currentTitle, &kind, &deleted)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if currentWS != ws || deleted || kind != "slides" {
			return ErrForbidden
		}
		if e = drivePGValidChain(ctx, tx, id, ws); e != nil {
			return e
		}
		role, _, _, e := lockCopySource(ctx, tx, id, g.UserID)
		if e != nil {
			return e
		}
		if RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		if revision != expectedRevision || revision >= maxDriveRevision || currentTitle != expectedTitle {
			return ErrConflict
		}
		if e = drivePGEnd(ctx, g, expires); e != nil {
			return e
		}
		e = tx.QueryRow(ctx, `UPDATE nodes SET title=$2,drive_revision=drive_revision+1,updated_at=now() WHERE id=$1 RETURNING id,workspace_id,parent_id,kind,title,icon,creator_id,COALESCE((SELECT u.name FROM users u WHERE u.id=nodes.creator_id),''),drive_revision,personal,created_at,updated_at`, id, title).
			Scan(&out.ID, &out.WorkspaceID, &out.ParentID, &out.Kind, &out.Title, &out.Icon, &out.CreatorID, &out.CreatorName, &out.Revision, &out.Personal, &out.CreatedAt, &out.UpdatedAt)
		if e != nil {
			return e
		}
		if e = recordDocumentModifier(ctx, tx, id, g.UserID); e != nil {
			return e
		}
		out.Role = role
		return drivePGEnd(ctx, g, expires)
	})
	if err != nil {
		return DriveEntry{}, drivePGError(err)
	}
	return out, nil
}

package store

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/jackc/pgx/v5"
)

// BaseWriteGuard identifies the authenticated caller; it never carries the
// raw cookie. The caller must recheck expiry immediately before committing.
type BaseWriteGuard = RestoreGuard

// lockBaseNode serializes view configuration with guarded writes for this
// base. All PostgreSQL view mutations must hold this lock until commit.
func lockBaseNode(ctx context.Context, tx pgx.Tx, baseID int64) error {
	var id int64
	err := tx.QueryRow(ctx, `SELECT id FROM nodes WHERE id=$1 AND kind='base' AND deleted_at IS NULL FOR UPDATE`, baseID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// lockBaseWrite protects the session and every existing grant used to grant
// access, and keeps the Base's view list stable until transaction commit.
// It must be followed by an expiry check immediately before committing.
func lockBaseWrite(ctx context.Context, tx pgx.Tx, guard BaseWriteGuard, baseID int64) (string, time.Time, error) {
	if err := lockBaseNode(ctx, tx, baseID); err != nil {
		if errors.Is(err, ErrNotFound) {
			return "", time.Time{}, ErrForbidden
		}
		return "", time.Time{}, err
	}
	var sessionUser int64
	var expires time.Time
	err := tx.QueryRow(ctx, `SELECT user_id,expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, guard.SessionHash).Scan(&sessionUser, &expires)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (sessionUser != guard.UserID || !guard.currentTime().Before(expires)) {
		return "", time.Time{}, ErrUnauthenticated
	}
	if err != nil {
		return "", time.Time{}, err
	}
	role, _, kind, err := lockCopySource(ctx, tx, baseID, guard.UserID)
	if errors.Is(err, ErrNotFound) || err == nil && (kind != "base" || RoleRank(role) < RoleRank(RoleEdit)) {
		return "", time.Time{}, ErrForbidden
	}
	if err != nil {
		return "", time.Time{}, err
	}
	// An inconsistent tree must never authorize writes through a deleted or
	// missing ancestor. lockCopySource has already locked the parent chain.
	var invalidAncestor bool
	err = tx.QueryRow(ctx, `WITH RECURSIVE a AS (
		SELECT id,parent_id,workspace_id,deleted_at,ARRAY[id] AS seen FROM nodes WHERE id=$1
		UNION ALL SELECT n.id,n.parent_id,n.workspace_id,n.deleted_at,a.seen||n.id
		FROM nodes n JOIN a ON n.id=a.parent_id WHERE NOT n.id=ANY(a.seen)
	) SELECT EXISTS(SELECT 1 FROM a WHERE deleted_at IS NOT NULL OR workspace_id<>(SELECT workspace_id FROM nodes WHERE id=$1))
		OR EXISTS(SELECT 1 FROM a WHERE parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id=a.parent_id))`, baseID).Scan(&invalidAncestor)
	if err != nil {
		return "", time.Time{}, err
	}
	if invalidAncestor {
		return "", time.Time{}, ErrForbidden
	}
	if role == RoleManage {
		return role, expires, nil
	}
	rows, err := tx.Query(ctx, `SELECT config FROM bt_views WHERE base_id=$1`, baseID)
	if err != nil {
		return "", time.Time{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return "", time.Time{}, err
		}
		var cfg btquery.Config
		if len(raw) > 0 && string(raw) != "null" && json.Unmarshal(raw, &cfg) != nil {
			return "", time.Time{}, ErrForbidden
		}
		if cfg.Locked {
			return "", time.Time{}, ErrForbidden
		}
	}
	if err := rows.Err(); err != nil {
		return "", time.Time{}, err
	}
	return role, expires, nil
}

// lockBaseWrites obtains source and linked targets in a deterministic base ID
// order. A changed ancestry or conflicting lock can still cause PostgreSQL to
// abort with a deadlock/serialization error; the outer transaction must roll
// back and report a retryable conflict, never perform a partial mutation.
func lockBaseWrites(ctx context.Context, tx pgx.Tx, guard BaseWriteGuard, ids []int64) (time.Time, error) {
	ids = slices.Clone(ids)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	if len(ids) == 0 {
		return time.Time{}, ErrForbidden
	}
	var expires time.Time
	for _, id := range ids {
		if id <= 0 {
			return time.Time{}, ErrForbidden
		}
		_, exp, err := lockBaseWrite(ctx, tx, guard, id)
		if err != nil {
			return time.Time{}, err
		}
		if expires.IsZero() || exp.Before(expires) {
			expires = exp
		}
	}
	return expires, nil
}

// checkBaseWriteLocked is the in-memory equivalent; the caller must hold m.mu
// continuously through the guarded mutation.
func (m *Memory) checkBaseWriteLocked(guard BaseWriteGuard, baseID int64) (string, time.Time, error) {
	s, ok := m.sessions[string(guard.SessionHash)]
	if !ok || s.userID != guard.UserID || !guard.currentTime().Before(s.expires) {
		return "", time.Time{}, ErrUnauthenticated
	}
	d := m.doc(baseID)
	if d == nil || d.deleted || d.meta.Kind != "base" {
		return "", time.Time{}, ErrForbidden
	}
	seen := map[int64]bool{}
	for current := d; current != nil; {
		if seen[current.meta.ID] || current.deleted || current.meta.WorkspaceID != d.meta.WorkspaceID {
			return "", time.Time{}, ErrForbidden
		}
		seen[current.meta.ID] = true
		if current.meta.ParentID == nil {
			break
		}
		current = m.doc(*current.meta.ParentID)
		if current == nil {
			return "", time.Time{}, ErrForbidden
		}
	}
	role := m.roleLocked(guard.UserID, d)
	if RoleRank(role) < RoleRank(RoleEdit) {
		return "", time.Time{}, ErrForbidden
	}
	if role != RoleManage {
		for _, v := range m.b.views {
			if v.BaseID != baseID {
				continue
			}
			var cfg btquery.Config
			if len(v.Config) > 0 && string(v.Config) != "null" && json.Unmarshal(v.Config, &cfg) != nil {
				return "", time.Time{}, ErrForbidden
			}
			if cfg.Locked {
				return "", time.Time{}, ErrForbidden
			}
		}
	}
	return role, s.expires, nil
}

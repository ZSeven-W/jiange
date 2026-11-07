package store

import (
	"context"
	"errors"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const maxIconRevision = int64(9007199254740991)

// DocIcon is a document's directory icon and its independent CAS revision.
type DocIcon struct {
	Icon     string `json:"icon"`
	Revision int64  `json:"revision"`
}

// ValidDocIcon allows a short visible text/emoji sequence, never markup or a URL.
// The joiner and variation selectors are needed by common composed emoji.
func ValidDocIcon(icon string) bool {
	if icon == "" {
		return true
	}
	if !utf8.ValidString(icon) || len(icon) > 128 || utf8.RuneCountInString(icon) > 16 {
		return false
	}
	visible := false
	for _, r := range icon {
		if r == '\u200d' || r == '\ufe0e' || r == '\ufe0f' {
			continue
		}
		if unicode.IsSpace(r) || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == '<' || r == '>' || r == '&' || r == '/' || r == '\\' || r == ':' || r == '"' || r == '\'' {
			return false
		}
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsSymbol(r) {
			visible = true
		} else if !unicode.IsMark(r) {
			return false
		}
	}
	return visible
}

func (m *Memory) checkIconAccessLocked(ctx context.Context, guard RestoreGuard, id int64, minimum string) (*memDoc, time.Time, error) {
	if err := ctx.Err(); err != nil {
		return nil, time.Time{}, err
	}
	s, ok := m.sessions[string(guard.SessionHash)]
	if !ok || s.userID != guard.UserID || !guard.currentTime().Before(s.expires) {
		return nil, time.Time{}, ErrUnauthenticated
	}
	d := m.doc(id)
	if d == nil || d.deleted || d.meta.Kind != "doc" {
		return nil, time.Time{}, ErrForbidden
	}
	seen := map[int64]bool{}
	for current := d; current != nil; {
		if seen[current.meta.ID] || current.deleted || current.meta.WorkspaceID != d.meta.WorkspaceID {
			return nil, time.Time{}, ErrForbidden
		}
		seen[current.meta.ID] = true
		if current.meta.ParentID == nil {
			break
		}
		current = m.doc(*current.meta.ParentID)
		if current == nil {
			return nil, time.Time{}, ErrForbidden
		}
	}
	if RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(minimum) {
		return nil, time.Time{}, ErrForbidden
	}
	return d, s.expires, nil
}

func (m *Memory) DocIconGuarded(ctx context.Context, guard RestoreGuard, id int64) (DocIcon, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, expiry, err := m.checkIconAccessLocked(ctx, guard, id, RoleView)
	if err != nil {
		return DocIcon{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return DocIcon{}, ErrUnauthenticated
	}
	return DocIcon{Icon: d.meta.Icon, Revision: d.iconRevision}, nil
}

func (m *Memory) SetDocIconGuarded(ctx context.Context, guard RestoreGuard, id int64, icon string, expected int64) (DocIcon, error) {
	if !ValidDocIcon(icon) || expected < 0 || expected >= maxIconRevision {
		return DocIcon{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, expiry, err := m.checkIconAccessLocked(ctx, guard, id, RoleEdit)
	if err != nil {
		return DocIcon{}, err
	}
	if d.iconRevision != expected {
		return DocIcon{}, ErrConflict
	}
	if err := ctx.Err(); err != nil {
		return DocIcon{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return DocIcon{}, ErrUnauthenticated
	}
	d.meta.Icon = icon
	d.iconRevision++
	d.meta.UpdatedAt = time.Now()
	return DocIcon{Icon: icon, Revision: d.iconRevision}, nil
}

func lockIconAccess(ctx context.Context, tx pgx.Tx, guard RestoreGuard, id int64, minimum string, write bool) (DocIcon, time.Time, error) {
	var out DocIcon
	var kind string
	query := `SELECT icon,icon_revision,kind FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR SHARE`
	if write {
		query = `SELECT icon,icon_revision,kind FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`
	}
	err := tx.QueryRow(ctx, query, id).Scan(&out.Icon, &out.Revision, &kind)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && kind != "doc" {
		return DocIcon{}, time.Time{}, ErrForbidden
	}
	if err != nil {
		return DocIcon{}, time.Time{}, err
	}
	var uid int64
	var expiry time.Time
	err = tx.QueryRow(ctx, `SELECT user_id,expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, guard.SessionHash).Scan(&uid, &expiry)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (uid != guard.UserID || !guard.currentTime().Before(expiry)) {
		return DocIcon{}, time.Time{}, ErrUnauthenticated
	}
	if err != nil {
		return DocIcon{}, time.Time{}, err
	}
	role, _, _, err := lockCopySource(ctx, tx, id, guard.UserID)
	if errors.Is(err, ErrNotFound) || err == nil && RoleRank(role) < RoleRank(minimum) {
		return DocIcon{}, time.Time{}, ErrForbidden
	}
	if err != nil {
		return DocIcon{}, time.Time{}, err
	}
	// Positive grants on a deleted or corrupt ancestor must not authorize.
	var invalid bool
	err = tx.QueryRow(ctx, `WITH RECURSIVE a AS (
        SELECT id,parent_id,workspace_id,deleted_at,ARRAY[id] AS seen FROM nodes WHERE id=$1
        UNION ALL SELECT n.id,n.parent_id,n.workspace_id,n.deleted_at,a.seen||n.id
        FROM nodes n JOIN a ON n.id=a.parent_id WHERE NOT n.id=ANY(a.seen)
    ) SELECT EXISTS(SELECT 1 FROM a WHERE deleted_at IS NOT NULL OR workspace_id<>(SELECT workspace_id FROM nodes WHERE id=$1))
        OR EXISTS(SELECT 1 FROM a WHERE parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id=a.parent_id))`, id).Scan(&invalid)
	if err != nil {
		return DocIcon{}, time.Time{}, err
	}
	if invalid {
		return DocIcon{}, time.Time{}, ErrForbidden
	}
	return out, expiry, nil
}

func (p *Postgres) DocIconGuarded(ctx context.Context, guard RestoreGuard, id int64) (result DocIcon, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var expiry time.Time
		result, expiry, err = lockIconAccess(ctx, tx, guard, id, RoleView, false)
		if err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		result = DocIcon{}
	}
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	return result, err
}

func (p *Postgres) SetDocIconGuarded(ctx context.Context, guard RestoreGuard, id int64, icon string, expected int64) (result DocIcon, err error) {
	if !ValidDocIcon(icon) || expected < 0 || expected >= maxIconRevision {
		return DocIcon{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		current, expiry, err := lockIconAccess(ctx, tx, guard, id, RoleEdit, true)
		if err != nil {
			return err
		}
		if current.Revision != expected {
			return ErrConflict
		}
		if _, err = tx.Exec(ctx, `UPDATE nodes SET icon=$2,icon_revision=icon_revision+1,updated_at=now() WHERE id=$1`, id, icon); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		result = DocIcon{Icon: icon, Revision: expected + 1}
		return nil
	})
	if err != nil {
		result = DocIcon{}
	}
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	return result, err
}

package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type PasteShareTarget struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
	Role  string `json:"-"`
}

type PasteShareTargetReader interface {
	ResolvePasteShareTarget(context.Context, RestoreGuard, string) (PasteShareTarget, error)
}

func pasteShareRoleAllowed(role string) bool {
	switch role {
	case "anon", "view", "edit", LinkWorkspaceView, LinkWorkspaceEdit:
		return true
	}
	return false
}

func validPasteShareToken(token string) bool {
	if len(token) == 0 || len(token) > 256 {
		return false
	}
	for _, c := range token {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// ResolvePasteShareTarget reads a currently eligible link without joining it.
// The caller must protect the returned metadata like the original link token.
func (m *Memory) ResolvePasteShareTarget(ctx context.Context, guard RestoreGuard, token string) (PasteShareTarget, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return PasteShareTarget{}, err
	}
	if !validPasteShareToken(token) {
		return PasteShareTarget{}, ErrNotFound
	}
	for id, link := range m.sh.links {
		if link.Token != token || !pasteShareRoleAllowed(link.Role) {
			continue
		}
		d := m.doc(id)
		if d == nil || d.deleted || d.purged || d.meta.Kind != "doc" || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || isWorkspaceLink(link.Role) && !m.member(guard.UserID, d.meta.WorkspaceID) {
			return PasteShareTarget{}, ErrNotFound
		}
		if err := driveMemoryEnd(ctx, guard, expires); err != nil {
			return PasteShareTarget{}, err
		}
		return PasteShareTarget{ID: id, Title: d.meta.Title, Role: link.Role}, nil
	}
	return PasteShareTarget{}, ErrNotFound
}

func (p *Postgres) ResolvePasteShareTarget(ctx context.Context, guard RestoreGuard, token string) (out PasteShareTarget, err error) {
	if !validPasteShareToken(token) {
		return PasteShareTarget{}, ErrNotFound
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var role, kind string
		var ws int64
		e := tx.QueryRow(ctx, `SELECT id,link_role,workspace_id,kind,title FROM nodes WHERE link_token=$1 AND deleted_at IS NULL FOR UPDATE`, token).Scan(&out.ID, &role, &ws, &kind, &out.Title)
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
		if kind != "doc" || !pasteShareRoleAllowed(role) {
			return ErrNotFound
		}
		out.Role = role
		if e = drivePGValidChain(ctx, tx, out.ID, ws); errors.Is(e, ErrConflict) || errors.Is(e, ErrNotFound) {
			return ErrNotFound
		} else if e != nil {
			return e
		}
		if isWorkspaceLink(role) {
			var member int64
			e = tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, ws, guard.UserID).Scan(&member)
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if e != nil {
				return e
			}
		}
		return drivePGEnd(ctx, guard, expires)
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		return PasteShareTarget{}, err
	}
	return out, nil
}

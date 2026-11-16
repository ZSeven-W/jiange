package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// JoinLinkGuarded binds the join to the session and keeps membership locked
// until the link-derived grant has been committed.
func (m *Memory) JoinLinkGuarded(ctx context.Context, guard RestoreGuard, token string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return 0, err
	}
	if token == "" {
		return 0, ErrNotFound
	}
	for id, link := range m.sh.links {
		if link.Token != token || link.Role == "none" {
			continue
		}
		d := m.doc(id)
		if d == nil || d.deleted || d.purged || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || isWorkspaceLink(link.Role) && !m.member(guard.UserID, d.meta.WorkspaceID) {
			return 0, ErrNotFound
		}
		if err = ctx.Err(); err != nil {
			return 0, err
		}
		if !guard.currentTime().Before(expires) {
			return 0, ErrUnauthenticated
		}
		if m.sh.joins == nil {
			m.sh.joins = map[int64]map[int64]bool{}
		}
		if m.sh.joins[id] == nil {
			m.sh.joins[id] = map[int64]bool{}
		}
		m.sh.joins[id][guard.UserID] = true
		return id, nil
	}
	return 0, ErrNotFound
}

func (p *Postgres) JoinLinkGuarded(ctx context.Context, guard RestoreGuard, token string) (id int64, err error) {
	if token == "" {
		return 0, ErrNotFound
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var role string
		var ws int64
		e := tx.QueryRow(ctx, `SELECT id,link_role,workspace_id FROM nodes WHERE link_token=$1 AND link_role<>'none' AND deleted_at IS NULL FOR UPDATE`, token).Scan(&id, &role, &ws)
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
		if e = drivePGValidChain(ctx, tx, id, ws); errors.Is(e, ErrConflict) || errors.Is(e, ErrNotFound) {
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
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		_, e = tx.Exec(ctx, `INSERT INTO doc_link_joins(doc_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, id, guard.UserID)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		return 0, err
	}
	return id, nil
}

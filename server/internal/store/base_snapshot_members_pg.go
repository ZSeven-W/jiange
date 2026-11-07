package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// VisibleMemberNames returns only requested names belonging to this workspace.
// The caller must derive IDs from records already authorized for its user.
func (p *Postgres) VisibleMemberNames(ctx context.Context, workspaceID int64, ids []int64) (map[int64]string, error) {
	return pgVisibleMemberNames(ctx, p.Pool, workspaceID, ids)
}

func (r *pgBaseSnapshotReader) VisibleMemberNames(ctx context.Context, workspaceID int64, ids []int64) (map[int64]string, error) {
	return pgVisibleMemberNames(ctx, r.tx, workspaceID, ids)
}

func pgVisibleMemberNames(ctx context.Context, db pgBaseSnapshotQueryer, workspaceID int64, ids []int64) (map[int64]string, error) {
	out := make(map[int64]string)
	seen := make(map[int64]bool, len(ids))
	unique := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id > 0 && !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	for start := 0; start < len(unique); start += 1000 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		end := min(start+1000, len(unique))
		rows, err := db.Query(ctx, `SELECT u.id, u.name FROM users u JOIN workspace_members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND u.id=ANY($2)`, workspaceID, unique[start:end])
		if err != nil {
			return nil, err
		}
		members, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (struct {
			id   int64
			name string
		}, error) { var u struct {
			id   int64
			name string
		}; err := row.Scan(&u.id, &u.name); return u, err })
		if err != nil {
			return nil, err
		}
		for _, u := range members {
			out[u.id] = u.name
		}
	}
	return out, nil
}

package store

import (
	"context"
	"strings"
)

// SearchDocs matches the doc title, or any text inserted by the collaborative
// log (ops are CBOR; CAST to text is enough for substring matching). Access
// follows ListDocs (workspace membership) plus explicit shares.
func (p *Postgres) SearchDocs(ctx context.Context, uid int64, q string) ([]DocMeta, error) {
	like := "%" + strings.ReplaceAll(strings.ReplaceAll(q, "\\", "\\\\"), "%", "\\%") + "%"
	rows, err := p.Pool.Query(ctx, `SELECT DISTINCT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), (SELECT name FROM workspaces w WHERE w.id = n.workspace_id)
		FROM nodes n
		JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = $1
		WHERE n.deleted_at IS NULL AND (
			n.title ILIKE $2
			OR EXISTS (SELECT 1 FROM doc_ops o WHERE o.doc_id = n.id AND position(convert_to($3, 'UTF8') in o.op) > 0)
		)
		ORDER BY n.updated_at DESC LIMIT 50`, uid, like, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocMeta{}
	for rows.Next() {
		var d DocMeta
		if err := rows.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.WorkspaceName); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (p *Postgres) ListFavorites(ctx context.Context, uid int64) ([]DocMeta, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), `+roleSQL+`, (SELECT name FROM workspaces w WHERE w.id = n.workspace_id)
		FROM nodes n`+roleJoins+`
		JOIN favorites f ON f.node_id = n.id AND f.user_id = $1
		WHERE n.deleted_at IS NULL ORDER BY f.created_at DESC`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocMeta{}
	for rows.Next() {
		var d DocMeta
		if err := rows.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.Role, &d.WorkspaceName); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (p *Postgres) AddFavorite(ctx context.Context, uid, doc int64) error {
	_, err := p.Pool.Exec(ctx, `INSERT INTO favorites (user_id, node_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, uid, doc)
	return err
}

func (p *Postgres) RemoveFavorite(ctx context.Context, uid, doc int64) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM favorites WHERE user_id=$1 AND node_id=$2`, uid, doc)
	return err
}

// Ancestors returns the parent chain, root first, each with the caller's role.
func (p *Postgres) Ancestors(ctx context.Context, uid, doc int64) ([]DocMeta, error) {
	rows, err := p.Pool.Query(ctx, `WITH RECURSIVE up AS (
		SELECT id, parent_id FROM nodes WHERE id = $2
		UNION ALL
		SELECT n.id, n.parent_id FROM nodes n JOIN up ON n.id = up.parent_id
	)
	SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), `+roleSQL+`, (SELECT name FROM workspaces w WHERE w.id = n.workspace_id)
		FROM up c JOIN nodes n ON n.id = c.parent_id`+roleJoins+`
		ORDER BY n.id`, uid, doc)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocMeta{}
	for rows.Next() {
		var d DocMeta
		if err := rows.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.Role, &d.WorkspaceName); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

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
	rows, err := p.Pool.Query(ctx, `SELECT DISTINCT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), (SELECT name FROM workspaces w WHERE w.id = n.workspace_id), n.copy_protected, n.copy_min_role, n.download_min_role, n.comment_min_role, n.permissions_revision
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
		if err := rows.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.WorkspaceName, &d.CopyProtected, &d.CopyMinRole, &d.DownloadMinRole, &d.CommentMinRole, &d.PermissionsRevision); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (p *Postgres) ListFavorites(ctx context.Context, uid int64) ([]DocMeta, error) {
	return p.listMarked(ctx, uid, "favorites")
}

// ListPins returns the caller's pinned (置顶) docs, newest pin first.
func (p *Postgres) ListPins(ctx context.Context, uid int64) ([]DocMeta, error) {
	return p.listMarked(ctx, uid, "pins")
}

func (p *Postgres) AddPin(ctx context.Context, uid, doc int64) error {
	_, err := p.Pool.Exec(ctx, `INSERT INTO pins (user_id, node_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, uid, doc)
	return err
}

func (p *Postgres) RemovePin(ctx context.Context, uid, doc int64) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM pins WHERE user_id=$1 AND node_id=$2`, uid, doc)
	return err
}

// listMarked lists visible docs in a (user_id,node_id,created_at) table; table is a constant.
func (p *Postgres) listMarked(ctx context.Context, uid int64, table string) ([]DocMeta, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), `+roleSQL+`, (SELECT name FROM workspaces w WHERE w.id = n.workspace_id), n.copy_protected, n.copy_min_role, n.download_min_role, n.comment_min_role, n.permissions_revision
		FROM nodes n`+roleJoins+`
		JOIN `+table+` f ON f.node_id = n.id AND f.user_id = $1
		WHERE n.deleted_at IS NULL AND (`+roleSQL+`) <> '' ORDER BY f.created_at DESC, n.id DESC`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocMeta{}
	for rows.Next() {
		var d DocMeta
		if err := rows.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.Role, &d.WorkspaceName, &d.CopyProtected, &d.CopyMinRole, &d.DownloadMinRole, &d.CommentMinRole, &d.PermissionsRevision); err != nil {
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
	// Keep the store contract aligned with GetDoc. The SQL below repeats this
	// authorization as part of the same query that reads ancestor metadata, so
	// a grant revoked between the two checks cannot disclose an ancestor.
	if _, err := p.GetDoc(ctx, uid, doc); err != nil {
		return nil, err
	}
	rows, err := p.Pool.Query(ctx, `WITH RECURSIVE up AS (
		SELECT n.id, n.parent_id, 0 AS depth, ARRAY[n.id] AS visited
		FROM nodes n`+roleJoins+`
		WHERE n.id = $2 AND n.deleted_at IS NULL AND (`+roleSQL+`) <> ''
		UNION ALL
		SELECT n.id, n.parent_id, up.depth + 1, up.visited || n.id
		FROM nodes n JOIN up ON n.id = up.parent_id
		WHERE NOT n.id = ANY(up.visited)
	)
	SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), `+roleSQL+`, (SELECT name FROM workspaces w WHERE w.id = n.workspace_id), n.copy_protected, n.copy_min_role, n.download_min_role, n.comment_min_role, n.permissions_revision
		FROM up c JOIN nodes n ON n.id = c.id`+roleJoins+`
		WHERE c.depth > 0 AND n.deleted_at IS NULL AND (`+roleSQL+`) <> ''
		ORDER BY c.depth DESC`, uid, doc)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocMeta{}
	for rows.Next() {
		var d DocMeta
		if err := rows.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.Role, &d.WorkspaceName, &d.CopyProtected, &d.CopyMinRole, &d.DownloadMinRole, &d.CommentMinRole, &d.PermissionsRevision); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

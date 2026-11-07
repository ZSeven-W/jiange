package store

import (
	"context"
	"time"
)

func (p *Postgres) RecordVisit(ctx context.Context, uid, docID int64, at time.Time) error {
	// Authorization and insertion use the same statement snapshot. Listing
	// rechecks permissions, including inherited and link-derived grants.
	tag, err := p.Pool.Exec(ctx, `INSERT INTO recent_visits (user_id,node_id,viewed_at)
		SELECT $1,n.id,$3 FROM nodes n`+roleJoins+`
		WHERE n.id=$2 AND n.deleted_at IS NULL AND (`+roleSQL+`) <> ''
		ON CONFLICT (user_id,node_id) DO UPDATE SET viewed_at=GREATEST(recent_visits.viewed_at,EXCLUDED.viewed_at)`, uid, docID, at)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) RecentDocs(ctx context.Context, uid int64, limit int) ([]RecentDoc, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id=n.creator_id), `+roleSQL+`, (SELECT name FROM workspaces w WHERE w.id=n.workspace_id), n.copy_protected, n.copy_min_role, n.download_min_role, n.permissions_revision, v.viewed_at
		FROM recent_visits v JOIN nodes n ON n.id=v.node_id`+roleJoins+`
		WHERE v.user_id=$1 AND n.deleted_at IS NULL AND (`+roleSQL+`) <> ''
		ORDER BY v.viewed_at DESC,n.id DESC LIMIT $2`, uid, recentLimit(limit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]RecentDoc, 0)
	for rows.Next() {
		var d RecentDoc
		if err := rows.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.Role, &d.WorkspaceName, &d.CopyProtected, &d.CopyMinRole, &d.DownloadMinRole, &d.PermissionsRevision, &d.ViewedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

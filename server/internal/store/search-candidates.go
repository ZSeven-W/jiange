package store

import "context"

// SearchCandidates lists readable nodes without filtering against the op log.
func (m *Memory) SearchCandidates(ctx context.Context, uid, after int64, limit int) ([]DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []DocMeta{}
	if after < 0 {
		after = 0
	}
	if limit <= 0 || after >= int64(len(m.d.docs)) {
		return out, ctx.Err()
	}
	for _, d := range m.d.docs[after:] {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if d == nil || d.deleted {
			continue
		}
		role := m.roleLocked(uid, d)
		if RoleRank(role) < RoleRank(RoleView) {
			continue
		}
		meta := d.meta
		meta.Role = role
		meta.WorkspaceName = m.wsName(meta.WorkspaceID)
		out = append(out, meta)
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

func (p *Postgres) SearchCandidates(ctx context.Context, uid, after int64, limit int) ([]DocMeta, error) {
	if limit <= 0 {
		return []DocMeta{}, nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id=n.creator_id), `+roleSQL+`, (SELECT name FROM workspaces w WHERE w.id=n.workspace_id), n.copy_protected, n.copy_min_role, n.download_min_role, n.comment_min_role, n.permissions_revision
		FROM nodes n`+roleJoins+`
		WHERE n.deleted_at IS NULL AND n.id > $2 AND (`+roleSQL+`) <> '' ORDER BY n.id LIMIT $3`, uid, after, limit)
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

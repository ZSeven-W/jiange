package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// roleSQL computes the role of user $1 on node n (aliases m = workspace
// membership LEFT JOIN, sh.r = best inherited share rank, sh.inherits_ws =
// whether parent/workspace default inheritance remains unbroken). Personal-scope
// nodes (我的空间) grant nothing through membership — not even to workspace
// owners/admins; only the creator and explicit shares apply. When inheritance is
// turned off on a non-personal node/subtree, ordinary workspace members lose
// default edit access; only owners/admins, the creator, and explicit grants apply.
const roleSQL = `CASE
	WHEN n.personal THEN CASE
		WHEN n.creator_id = $1 OR sh.r = 3 THEN 'manage'
		WHEN sh.r = 2 THEN 'edit'
		WHEN sh.r = 1 THEN 'view'
		ELSE '' END
	WHEN n.wiki_space_id IS NOT NULL THEN CASE
		WHEN m.role IN ('owner','admin') OR (m.user_id IS NOT NULL AND n.creator_id = $1) OR sh.wiki_rank = 3 OR sh.r = 3 THEN 'manage'
		WHEN (COALESCE(sh.inherits_ws, true) AND sh.wiki_rank = 2) OR sh.r = 2 THEN 'edit'
		WHEN (COALESCE(sh.inherits_ws, true) AND sh.wiki_rank = 1) OR sh.r = 1 THEN 'view'
		ELSE '' END
	WHEN m.role IN ('owner','admin') OR (m.user_id IS NOT NULL AND n.creator_id = $1) OR sh.r = 3 THEN 'manage'
	WHEN (m.user_id IS NOT NULL AND COALESCE(sh.inherits_ws, true)) OR sh.r = 2 THEN 'edit'
	WHEN sh.r = 1 THEN 'view' ELSE '' END`

const roleJoins = ` LEFT JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = $1
	LEFT JOIN LATERAL (
		WITH RECURSIVE a AS (
			SELECT n.id, n.parent_id, n.inherit_parent_acl, ARRAY[n.id] AS visited
			UNION ALL
			SELECT x.id, x.parent_id, x.inherit_parent_acl, a.visited || x.id FROM nodes x JOIN a ON a.inherit_parent_acl AND x.id = a.parent_id
			WHERE NOT x.id = ANY(a.visited)
		),
		ud AS (
			SELECT d0.id, d0.parent_id, ARRAY[d0.id] AS seen
			FROM org_department_members dm
			JOIN org_departments d0 ON d0.id = dm.department_id AND d0.workspace_id = n.workspace_id
			WHERE dm.user_id = $1 AND m.user_id IS NOT NULL
			UNION ALL
			SELECT p.id, p.parent_id, ud.seen || p.id
			FROM org_departments p
			JOIN ud ON p.id = ud.parent_id
			WHERE p.workspace_id = n.workspace_id AND NOT p.id = ANY(ud.seen)
		)
		SELECT (SELECT max(grants.rank) FROM (
			SELECT CASE s.role WHEN 'view' THEN 1 WHEN 'edit' THEN 2 ELSE 3 END AS rank
			FROM doc_shares s JOIN a ON s.doc_id = a.id WHERE s.user_id = $1
			UNION ALL
			SELECT CASE ss.role WHEN 'view' THEN 1 WHEN 'edit' THEN 2 ELSE 3 END AS rank
			FROM node_subject_shares ss JOIN a ON ss.doc_id = a.id
			WHERE m.user_id IS NOT NULL AND (
				(ss.subject_type = 'department' AND EXISTS (SELECT 1 FROM ud WHERE ud.id = ss.subject_id))
				OR (ss.subject_type = 'group' AND EXISTS (SELECT 1 FROM org_group_members gm JOIN org_groups g ON g.id = gm.group_id WHERE gm.group_id = ss.subject_id AND gm.user_id = $1 AND g.workspace_id = n.workspace_id))
			)
			UNION ALL
			SELECT CASE ln.link_role WHEN 'anon' THEN 1 WHEN 'view' THEN 1 WHEN 'edit' THEN 2 WHEN 'workspace_view' THEN 1 WHEN 'workspace_edit' THEN 2 ELSE 0 END AS rank
			FROM doc_link_joins j JOIN a ON j.doc_id = a.id JOIN nodes ln ON ln.id = j.doc_id
			WHERE j.user_id = $1 AND ln.deleted_at IS NULL AND ln.link_role <> 'none'
			  AND (ln.link_role NOT IN ('workspace_view','workspace_edit') OR EXISTS (SELECT 1 FROM workspace_members lm WHERE lm.workspace_id=ln.workspace_id AND lm.user_id=$1))
		) grants) AS r,
		COALESCE((SELECT bool_and(a.inherit_parent_acl) FROM a), true) AS inherits_ws,
		CASE WHEN n.wiki_space_id IS NULL OR m.user_id IS NULL THEN 0 ELSE COALESCE((
			SELECT GREATEST(
				CASE WHEN m.role IN ('owner','admin') OR wsp.creator_id = $1 THEN 3
				     WHEN wsp.visibility = 'workspace' THEN 1
				     ELSE 0 END,
				COALESCE((
					SELECT max(CASE wg.role WHEN 'view' THEN 1 WHEN 'edit' THEN 2 WHEN 'manage' THEN 3 ELSE 0 END)
					FROM wiki_space_grants wg
					WHERE wg.space_id = wsp.id AND (
						(wg.subject_type = 'user' AND wg.subject_id = $1)
						OR (wg.subject_type = 'department' AND EXISTS (SELECT 1 FROM ud WHERE ud.id = wg.subject_id))
						OR (wg.subject_type = 'group' AND EXISTS (SELECT 1 FROM org_group_members gm JOIN org_groups g ON g.id = gm.group_id WHERE gm.group_id = wg.subject_id AND gm.user_id = $1 AND g.workspace_id = n.workspace_id))
					)
				), 0)
			)
			FROM wiki_spaces wsp
			WHERE wsp.id = n.wiki_space_id AND wsp.workspace_id = n.workspace_id
		), 0) END AS wiki_rank
	) sh ON true`

func (p *Postgres) ListShares(ctx context.Context, doc int64) ([]Share, error) {
	rows, err := p.Pool.Query(ctx, `SELECT u.id, u.name, u.email, s.role FROM doc_shares s JOIN users u ON u.id = s.user_id WHERE s.doc_id=$1 ORDER BY u.id`, doc)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (s Share, err error) {
		err = r.Scan(&s.UserID, &s.Name, &s.Email, &s.Role)
		return
	})
}

func (p *Postgres) SetShare(ctx context.Context, doc, uid int64, role string) error {
	if role == "" {
		_, err := p.Pool.Exec(ctx, `DELETE FROM doc_shares WHERE doc_id=$1 AND user_id=$2`, doc, uid)
		return err
	}
	_, err := p.Pool.Exec(ctx, `INSERT INTO doc_shares (doc_id, user_id, role) VALUES ($1,$2,$3)
		ON CONFLICT (doc_id, user_id) DO UPDATE SET role = EXCLUDED.role`, doc, uid, role)
	return err
}

func (p *Postgres) AddShare(ctx context.Context, doc, uid int64, role string) error {
	if RoleRank(role) == 0 {
		return ErrConflict
	}
	result, err := p.Pool.Exec(ctx, `INSERT INTO doc_shares (doc_id,user_id,role)
		SELECT n.id,$2,$3 FROM nodes n WHERE n.id=$1 AND n.creator_id<>$2 AND n.deleted_at IS NULL
		ON CONFLICT (doc_id,user_id) DO NOTHING`, doc, uid, role)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}

func (p *Postgres) GetLink(ctx context.Context, doc int64) (l Link, err error) {
	var tok *string
	err = p.Pool.QueryRow(ctx, `SELECT link_role, link_token, link_revision FROM nodes WHERE id=$1`, doc).Scan(&l.Role, &tok, &l.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	if tok != nil {
		l.Token = *tok
	}
	return
}

func (p *Postgres) SetLink(ctx context.Context, doc int64, l Link) error {
	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var oldToken *string
		if err := tx.QueryRow(ctx, `SELECT link_token FROM nodes WHERE id=$1 FOR UPDATE`, doc).Scan(&oldToken); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if l.Role == "none" || oldToken != nil && *oldToken != l.Token {
			if _, err := tx.Exec(ctx, `DELETE FROM doc_link_joins WHERE doc_id=$1`, doc); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `UPDATE nodes SET link_role=$2, link_token=NULLIF($3,'') WHERE id=$1`, doc, l.Role, l.Token)
		return err
	})
}

func (p *Postgres) ChangeLinkRole(ctx context.Context, doc int64, role, candidate string) (next Link, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var oldRole string
		var oldToken *string
		if err := tx.QueryRow(ctx, `SELECT link_role, link_token FROM nodes WHERE id=$1 FOR UPDATE`, doc).Scan(&oldRole, &oldToken); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		next.Role = role
		if oldToken != nil {
			next.Token = *oldToken
		}
		if role == "none" {
			next.Token = ""
		} else if oldRole == "none" || next.Token == "" || rotateWorkspaceLink(oldRole, role) {
			next.Token = candidate
		}
		if role == "none" || oldToken != nil && *oldToken != next.Token {
			if _, err := tx.Exec(ctx, `DELETE FROM doc_link_joins WHERE doc_id=$1`, doc); err != nil {
				return err
			}
		}
		return tx.QueryRow(ctx, `UPDATE nodes SET link_role=$2, link_token=NULLIF($3,'') WHERE id=$1 RETURNING link_revision`, doc, next.Role, next.Token).Scan(&next.Revision)
	})
	return
}

func (p *Postgres) DocByToken(ctx context.Context, tok string) (id int64, role string, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT id, link_role FROM nodes WHERE link_token=$1 AND link_role <> 'none' AND deleted_at IS NULL`, tok).Scan(&id, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

// Serialize link join and updates by locking the node row. This prevents a
// concurrent join from surviving a close or token change.
func (p *Postgres) JoinLink(ctx context.Context, tok string, uid int64) (id int64, err error) {
	if tok == "" {
		return 0, ErrNotFound
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var role string
		var workspaceID int64
		if err := tx.QueryRow(ctx, `SELECT id,link_role,workspace_id FROM nodes WHERE link_token=$1 AND link_role <> 'none' AND deleted_at IS NULL FOR UPDATE`, tok).Scan(&id, &role, &workspaceID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if isWorkspaceLink(role) {
			var member int64
			err := tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, workspaceID, uid).Scan(&member)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `INSERT INTO doc_link_joins (doc_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, uid)
		return err
	})
	return
}

func (p *Postgres) SharedWithMe(ctx context.Context, uid int64) ([]DocMeta, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), `+roleSQL+`, (SELECT name FROM workspaces w WHERE w.id = n.workspace_id), n.copy_protected, n.copy_min_role, n.download_min_role, n.comment_min_role, n.permissions_revision, n.inherit_parent_acl, n.wiki_space_id, COALESCE((SELECT ws.name FROM wiki_spaces ws WHERE ws.id = n.wiki_space_id), '') FROM nodes n`+roleJoins+`
		WHERE n.deleted_at IS NULL AND (m.user_id IS NULL OR (n.personal AND n.creator_id <> $1)) AND (`+roleSQL+`) <> '' AND (
		  EXISTS (SELECT 1 FROM doc_shares s WHERE s.doc_id = n.id AND s.user_id = $1)
		  OR (n.link_role <> 'none' AND EXISTS (SELECT 1 FROM doc_link_joins j WHERE j.doc_id = n.id AND j.user_id = $1))
		  OR (m.user_id IS NOT NULL AND EXISTS (
		    SELECT 1 FROM node_subject_shares ss WHERE ss.doc_id = n.id AND (
		      (ss.subject_type = 'group' AND EXISTS (SELECT 1 FROM org_group_members gm JOIN org_groups g ON g.id = gm.group_id WHERE gm.group_id = ss.subject_id AND gm.user_id = $1 AND g.workspace_id = n.workspace_id))
		      OR (ss.subject_type = 'department' AND EXISTS (
		        WITH RECURSIVE dm_up AS (
		          SELECT d0.id, d0.parent_id, ARRAY[d0.id] AS seen FROM org_department_members dm JOIN org_departments d0 ON d0.id = dm.department_id AND d0.workspace_id = n.workspace_id WHERE dm.user_id = $1
		          UNION ALL
		          SELECT p.id, p.parent_id, dm_up.seen || p.id FROM org_departments p JOIN dm_up ON p.id = dm_up.parent_id WHERE p.workspace_id = n.workspace_id AND NOT p.id = ANY(dm_up.seen)
		        ) SELECT 1 FROM dm_up WHERE dm_up.id = ss.subject_id
		      ))
		    )
		  ))
		)
		ORDER BY n.id`, uid)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (d DocMeta, err error) {
		err = r.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.DocType, &d.CreatorName, &d.Role, &d.WorkspaceName, &d.CopyProtected, &d.CopyMinRole, &d.DownloadMinRole, &d.CommentMinRole, &d.PermissionsRevision, &d.InheritParentACL, &d.WikiSpaceID, &d.WikiSpaceName)
		return
	})
}

func (p *Postgres) WorkspaceMembers(ctx context.Context, ws int64) ([]User, error) {
	rows, err := p.Pool.Query(ctx, `SELECT u.id, u.email, u.name, u.created_at FROM workspace_members m
		JOIN users u ON u.id = m.user_id WHERE m.workspace_id=$1 ORDER BY u.id`, ws)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (u User, err error) {
		err = r.Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt)
		return
	})
}

func (p *Postgres) CreateFile(ctx context.Context, f FileMeta) (FileMeta, error) {
	err := p.Pool.QueryRow(ctx, `INSERT INTO attachments (doc_id, uploader_id, name, mime, size, object_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
		f.DocID, f.UploaderID, f.Name, f.Mime, f.Size, f.ObjectKey).Scan(&f.ID, &f.CreatedAt)
	return f, err
}

// DeleteFile removes the attachment row and reports remaining references to
// its object key (copies share blobs; the object dies at zero references).
func (p *Postgres) DeleteFile(ctx context.Context, id int64) (string, int64, error) {
	var key string
	if err := p.Pool.QueryRow(ctx, `DELETE FROM attachments a WHERE a.id=$1 AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id=a.doc_id AND n.kind='slides') RETURNING object_key`, id).Scan(&key); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			var protected bool
			if e := p.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM attachments a JOIN nodes n ON n.id=a.doc_id WHERE a.id=$1 AND n.kind='slides')`, id).Scan(&protected); e != nil {
				return "", 0, e
			}
			if protected {
				return "", 0, ErrConflict
			}
			return "", 0, ErrNotFound
		}
		return "", 0, err
	}
	var refs int64
	if err := p.Pool.QueryRow(ctx, `SELECT count(*) FROM attachments WHERE object_key=$1`, key).Scan(&refs); err != nil {
		return key, 0, err
	}
	return key, refs, nil
}

func (p *Postgres) GetFile(ctx context.Context, id int64) (f FileMeta, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT id, doc_id, uploader_id, name, mime, size, object_key, created_at FROM attachments WHERE id=$1`, id).
		Scan(&f.ID, &f.DocID, &f.UploaderID, &f.Name, &f.Mime, &f.Size, &f.ObjectKey, &f.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

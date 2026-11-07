package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// roleSQL computes the role of user $1 on node n (aliases m = workspace
// membership LEFT JOIN, sh.r = best inherited share rank).
const roleSQL = `CASE
	WHEN m.role IN ('owner','admin') OR (m.user_id IS NOT NULL AND n.creator_id = $1) OR sh.r = 3 THEN 'manage'
	WHEN m.user_id IS NOT NULL OR sh.r = 2 THEN 'edit'
	WHEN sh.r = 1 THEN 'view' ELSE '' END`

const roleJoins = ` LEFT JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = $1
	LEFT JOIN LATERAL (
		WITH RECURSIVE a AS (
			SELECT n.id, n.parent_id, ARRAY[n.id] AS visited
			UNION ALL
			SELECT x.id, x.parent_id, a.visited || x.id FROM nodes x JOIN a ON x.id = a.parent_id
			WHERE NOT x.id = ANY(a.visited)
		)
		SELECT max(grants.rank) AS r FROM (
			SELECT CASE s.role WHEN 'view' THEN 1 WHEN 'edit' THEN 2 ELSE 3 END AS rank
			FROM doc_shares s JOIN a ON s.doc_id = a.id WHERE s.user_id = $1
			UNION ALL
			SELECT CASE ln.link_role WHEN 'anon' THEN 1 WHEN 'view' THEN 1 WHEN 'edit' THEN 2 ELSE 0 END AS rank
			FROM doc_link_joins j JOIN a ON j.doc_id = a.id JOIN nodes ln ON ln.id = j.doc_id
			WHERE j.user_id = $1 AND ln.deleted_at IS NULL AND ln.link_role <> 'none'
		) grants
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

func (p *Postgres) GetLink(ctx context.Context, doc int64) (l Link, err error) {
	var tok *string
	err = p.Pool.QueryRow(ctx, `SELECT link_role, link_token FROM nodes WHERE id=$1`, doc).Scan(&l.Role, &tok)
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
		} else if oldRole == "none" || next.Token == "" {
			next.Token = candidate
		}
		if role == "none" || oldToken != nil && *oldToken != next.Token {
			if _, err := tx.Exec(ctx, `DELETE FROM doc_link_joins WHERE doc_id=$1`, doc); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `UPDATE nodes SET link_role=$2, link_token=NULLIF($3,'') WHERE id=$1`, doc, next.Role, next.Token)
		return err
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
		if err := tx.QueryRow(ctx, `SELECT id FROM nodes WHERE link_token=$1 AND link_role <> 'none' AND deleted_at IS NULL FOR UPDATE`, tok).Scan(&id); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO doc_link_joins (doc_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, uid)
		return err
	})
	return
}

func (p *Postgres) SharedWithMe(ctx context.Context, uid int64) ([]DocMeta, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), `+roleSQL+`, (SELECT name FROM workspaces w WHERE w.id = n.workspace_id) FROM nodes n`+roleJoins+`
		WHERE n.deleted_at IS NULL AND m.user_id IS NULL AND (EXISTS (SELECT 1 FROM doc_shares s WHERE s.doc_id = n.id AND s.user_id = $1)
		 OR (n.link_role <> 'none' AND EXISTS (SELECT 1 FROM doc_link_joins j WHERE j.doc_id = n.id AND j.user_id = $1)))
		ORDER BY n.id`, uid)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (d DocMeta, err error) {
		err = r.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.Role, &d.WorkspaceName)
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

func (p *Postgres) GetFile(ctx context.Context, id int64) (f FileMeta, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT id, doc_id, uploader_id, name, mime, size, object_key, created_at FROM attachments WHERE id=$1`, id).
		Scan(&f.ID, &f.DocID, &f.UploaderID, &f.Name, &f.Mime, &f.Size, &f.ObjectKey, &f.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

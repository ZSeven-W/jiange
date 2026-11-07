package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// lockCopySource computes access only from rows held until commit. All nodes
// in the current parent chain are locked, so moves, deletion, protection and
// link setting changes cannot race a copy. Existing grant and membership rows
// are also locked; absent rows are never used to authorize the request.
func lockCopySource(ctx context.Context, tx pgx.Tx, docID, userID int64) (string, bool, string, error) {
	type ancestor struct {
		id      int64
		parent  *int64
		link    string
		deleted bool
	}
	var chain []ancestor
	seen := map[int64]bool{}
	current := docID
	var workspaceID, creatorID int64
	var protected bool
	var kind string
	for current != 0 {
		if seen[current] {
			return "", false, "", ErrConflict
		}
		seen[current] = true
		var a ancestor
		var ws, creator int64
		var nodeProtected bool
		var nodeKind string
		err := tx.QueryRow(ctx, `SELECT id,parent_id,workspace_id,creator_id,copy_protected,kind,link_role,deleted_at IS NOT NULL FROM nodes WHERE id=$1 FOR SHARE`, current).
			Scan(&a.id, &a.parent, &ws, &creator, &nodeProtected, &nodeKind, &a.link, &a.deleted)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, "", ErrNotFound
		}
		if err != nil {
			return "", false, "", err
		}
		if len(chain) == 0 {
			if a.deleted {
				return "", false, "", ErrNotFound
			}
			workspaceID, creatorID, protected, kind = ws, creator, nodeProtected, nodeKind
		}
		chain = append(chain, a)
		if a.parent == nil {
			break
		}
		current = *a.parent
	}
	best := ""
	var memberRole string
	err := tx.QueryRow(ctx, `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, workspaceID, userID).Scan(&memberRole)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", false, "", err
	}
	if err == nil {
		best = RoleEdit
		if memberRole == "owner" || memberRole == "admin" || creatorID == userID {
			best = RoleManage
		}
	}
	for _, a := range chain {
		var grant string
		err := tx.QueryRow(ctx, `SELECT role FROM doc_shares WHERE doc_id=$1 AND user_id=$2 FOR SHARE`, a.id, userID).Scan(&grant)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return "", false, "", err
		}
		if err == nil && RoleRank(grant) > RoleRank(best) {
			best = grant
		}
		var joined int
		err = tx.QueryRow(ctx, `SELECT 1 FROM doc_link_joins WHERE doc_id=$1 AND user_id=$2 FOR SHARE`, a.id, userID).Scan(&joined)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return "", false, "", err
		}
		if err == nil && !a.deleted {
			linkRole := a.link
			if linkRole == "anon" {
				linkRole = RoleView
			}
			if RoleRank(linkRole) > RoleRank(best) {
				best = linkRole
			}
		}
	}
	return best, protected, kind, nil
}

// CopyDoc publishes the node, attachment references, and initial operation
// log together. Attachment blobs are immutable and shared by object key.
func (p *Postgres) CopyDoc(ctx context.Context, c DocCopy, build DocCopyBuilder) (DocMeta, error) {
	if build == nil {
		return DocMeta{}, ErrConflict
	}
	var result DocMeta
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		sourceRole, protected, kind, err := lockCopySource(ctx, tx, c.SourceID, c.UserID)
		if err != nil {
			return err
		}
		var expiry time.Time
		if c.Guard != nil {
			guard := c.Guard
			var sessionUser int64
			err := tx.QueryRow(ctx, `SELECT user_id, expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, guard.SessionHash).Scan(&sessionUser, &expiry)
			if errors.Is(err, pgx.ErrNoRows) || err == nil && (guard.UserID != c.UserID || sessionUser != c.UserID || !guard.currentTime().Before(expiry)) {
				return ErrUnauthenticated
			}
			if err != nil {
				return err
			}
		}
		if RoleRank(sourceRole) < RoleRank(RoleView) {
			return ErrNotFound
		}
		if kind != "doc" {
			return ErrConflict
		}
		// lockCopySource holds the source node through commit, so the download
		// threshold cannot change between this read and publishing the copy.
		var downloadMinRole string
		if err := tx.QueryRow(ctx, `SELECT download_min_role FROM nodes WHERE id=$1`, c.SourceID).Scan(&downloadMinRole); err != nil {
			return err
		}
		if !DocumentDownloadAllowed(DocMeta{Kind: kind, CopyProtected: protected, DownloadMinRole: downloadMinRole}, sourceRole) {
			return ErrCopyProtected
		}
		var member int64
		if err := tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, c.WorkspaceID, c.UserID).Scan(&member); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrForbidden
			}
			return err
		}
		if c.ParentID != nil {
			var workspace int64
			if err := tx.QueryRow(ctx, `SELECT workspace_id FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, *c.ParentID).Scan(&workspace); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return ErrNotFound
				}
				return err
			}
			if workspace != c.WorkspaceID {
				return ErrNotFound
			}
		}
		result, err = scanDocWithPermissions(tx.QueryRow(ctx, `INSERT INTO nodes (workspace_id, parent_id, kind, sort_key, title, creator_id)
			VALUES ($1,$2,'doc','V',$3,$4) RETURNING `+docCols+creatorName+`, copy_protected, copy_min_role, download_min_role, comment_min_role, permissions_revision`, c.WorkspaceID, c.ParentID, c.Title, c.UserID))
		if err != nil {
			return err
		}
		mapping := make(map[int64]int64, len(c.FileIDs))
		for _, oldID := range c.FileIDs {
			if _, ok := mapping[oldID]; ok {
				continue
			}
			var newID int64
			err := tx.QueryRow(ctx, `INSERT INTO attachments (doc_id,uploader_id,name,mime,size,object_key)
				SELECT $1,$2,name,mime,size,object_key FROM attachments WHERE id=$3 AND doc_id=$4 RETURNING id`, result.ID, c.UserID, oldID, c.SourceID).Scan(&newID)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
			mapping[oldID] = newID
		}
		ops, err := build(mapping)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO doc_heads (doc_id,seq) VALUES ($1,$2)`, result.ID, len(ops)); err != nil {
			return err
		}
		for i, op := range ops {
			if _, err := tx.Exec(ctx, `INSERT INTO doc_ops (doc_id,seq,client_id,clock,op) VALUES ($1,$2,$3,$4,$5)`, result.ID, i+1, op.ClientID, op.Clock, op.Bytes); err != nil {
				return err
			}
		}
		if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		return DocMeta{}, err
	}
	return result, nil
}

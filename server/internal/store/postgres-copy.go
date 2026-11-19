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
		id        int64
		workspace int64
		parent    *int64
		link      string
		deleted   bool
	}
	var chain []ancestor
	seen := map[int64]bool{}
	current := docID
	var workspaceID, creatorID int64
	var wikiSpaceID *int64
	var protected, personal bool
	var kind string
	inheritsWS := true
	for current != 0 {
		if seen[current] {
			return "", false, "", ErrConflict
		}
		seen[current] = true
		var a ancestor
		var ws, creator int64
		var nodeProtected, nodePersonal bool
		var nodeKind string
		err := tx.QueryRow(ctx, `SELECT id,parent_id,workspace_id,creator_id,copy_protected,kind,link_role,deleted_at IS NOT NULL,personal FROM nodes WHERE id=$1 FOR SHARE`, current).
			Scan(&a.id, &a.parent, &ws, &creator, &nodeProtected, &nodeKind, &a.link, &a.deleted, &nodePersonal)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, "", ErrNotFound
		}
		if err != nil {
			return "", false, "", err
		}
		var inheritParent bool
		var nodeWikiSpace *int64
		if err := tx.QueryRow(ctx, `SELECT inherit_parent_acl, wiki_space_id FROM nodes WHERE id=$1 FOR SHARE`, current).Scan(&inheritParent, &nodeWikiSpace); err != nil {
			return "", false, "", err
		}
		if len(chain) == 0 {
			if a.deleted {
				return "", false, "", ErrNotFound
			}
			workspaceID, creatorID, protected, kind, personal, wikiSpaceID = ws, creator, nodeProtected, nodeKind, nodePersonal, nodeWikiSpace
		}
		a.workspace = ws
		chain = append(chain, a)
		if !inheritParent {
			inheritsWS = false
			break
		}
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
	isMember := err == nil
	if isMember {
		// 我的空间：成员身份不授予任何角色（与 roleSQL 一致），创建者保持 manage
		if personal {
			if creatorID == userID {
				best = RoleManage
			}
		} else if wikiSpaceID != nil {
			if memberRole == "owner" || memberRole == "admin" || creatorID == userID {
				best = RoleManage
			}
		} else {
			if memberRole == "owner" || memberRole == "admin" || creatorID == userID {
				best = RoleManage
			} else if inheritsWS {
				best = RoleEdit
			}
		}
	}
	deptSet := map[int64]bool{}
	groupSet := map[int64]bool{}
	if isMember {
		dmRows, e := tx.Query(ctx, `SELECT department_id FROM org_department_members WHERE user_id=$1 FOR SHARE`, userID)
		if e != nil {
			return "", false, "", e
		}
		var seedDepts []int64
		for dmRows.Next() {
			var did int64
			if e = dmRows.Scan(&did); e != nil {
				dmRows.Close()
				return "", false, "", e
			}
			seedDepts = append(seedDepts, did)
		}
		if e = dmRows.Err(); e != nil {
			dmRows.Close()
			return "", false, "", e
		}
		dmRows.Close()
		for _, startDept := range seedDepts {
			cur := startDept
			for cur != 0 && !deptSet[cur] {
				var dws int64
				var dparent *int64
				e = tx.QueryRow(ctx, `SELECT workspace_id, parent_id FROM org_departments WHERE id=$1 FOR SHARE`, cur).Scan(&dws, &dparent)
				if errors.Is(e, pgx.ErrNoRows) || (e == nil && dws != workspaceID) {
					break
				}
				if e != nil {
					return "", false, "", e
				}
				deptSet[cur] = true
				if dparent == nil {
					break
				}
				cur = *dparent
			}
		}
		gmRows, e := tx.Query(ctx, `SELECT gm.group_id FROM org_group_members gm JOIN org_groups g ON g.id = gm.group_id WHERE gm.user_id=$1 AND g.workspace_id=$2 FOR SHARE`, userID, workspaceID)
		if e != nil {
			return "", false, "", e
		}
		for gmRows.Next() {
			var gid int64
			if e = gmRows.Scan(&gid); e != nil {
				gmRows.Close()
				return "", false, "", e
			}
			groupSet[gid] = true
		}
		if e = gmRows.Err(); e != nil {
			gmRows.Close()
			return "", false, "", e
		}
		gmRows.Close()
		if wikiSpaceID != nil && !personal {
			var spaceWS, spaceCreator int64
			var visibility string
			e = tx.QueryRow(ctx, `SELECT workspace_id, visibility, creator_id FROM wiki_spaces WHERE id=$1 FOR SHARE`, *wikiSpaceID).Scan(&spaceWS, &visibility, &spaceCreator)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return "", false, "", e
			}
			if e == nil && spaceWS == workspaceID {
				wikiRank := 0
				if memberRole == "owner" || memberRole == "admin" || spaceCreator == userID {
					wikiRank = 3
				} else if visibility == WikiVisibilityWorkspace {
					wikiRank = 1
				}
				wgRows, we := tx.Query(ctx, `SELECT subject_type, subject_id, role FROM wiki_space_grants WHERE space_id=$1 FOR SHARE`, *wikiSpaceID)
				if we != nil {
					return "", false, "", we
				}
				for wgRows.Next() {
					var sType, sRole string
					var sID int64
					if we = wgRows.Scan(&sType, &sID, &sRole); we != nil {
						wgRows.Close()
						return "", false, "", we
					}
					matched := (sType == SubjectTypeUser && sID == userID) ||
						(sType == SubjectTypeDepartment && deptSet[sID]) ||
						(sType == SubjectTypeGroup && groupSet[sID])
					if matched && RoleRank(sRole) > wikiRank {
						wikiRank = RoleRank(sRole)
					}
				}
				if we = wgRows.Err(); we != nil {
					wgRows.Close()
					return "", false, "", we
				}
				wgRows.Close()
				if wikiRank == 3 {
					best = RoleManage
				} else if inheritsWS && wikiRank > RoleRank(best) {
					best = roleFromRank(wikiRank)
				}
			}
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
		if isMember {
			ssRows, e := tx.Query(ctx, `SELECT subject_type, subject_id, role FROM node_subject_shares WHERE doc_id=$1 FOR SHARE`, a.id)
			if e != nil {
				return "", false, "", e
			}
			for ssRows.Next() {
				var sType, sRole string
				var sID int64
				if e = ssRows.Scan(&sType, &sID, &sRole); e != nil {
					ssRows.Close()
					return "", false, "", e
				}
				matched := (sType == SubjectTypeDepartment && deptSet[sID]) || (sType == SubjectTypeGroup && groupSet[sID])
				if matched && RoleRank(sRole) > RoleRank(best) {
					best = sRole
				}
			}
			if e = ssRows.Err(); e != nil {
				ssRows.Close()
				return "", false, "", e
			}
			ssRows.Close()
		}
		var joined int
		err = tx.QueryRow(ctx, `SELECT 1 FROM doc_link_joins WHERE doc_id=$1 AND user_id=$2 FOR SHARE`, a.id, userID).Scan(&joined)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return "", false, "", err
		}
		if err == nil && !a.deleted {
			linkRole := a.link
			member := false
			if isWorkspaceLink(linkRole) {
				var memberID int64
				err = tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, a.workspace, userID).Scan(&memberID)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return "", false, "", err
				}
				member = err == nil
			}
			linkRole = linkGrantRole(linkRole, member)
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
		srcWS, e := drivePGNodeWorkspace(ctx, tx, c.SourceID)
		if e != nil {
			return e
		}
		if srcWS <= c.WorkspaceID {
			if e = drivePGLockWorkspace(ctx, tx, srcWS); e != nil {
				return e
			}
			if c.WorkspaceID != srcWS {
				if e = drivePGLockWorkspace(ctx, tx, c.WorkspaceID); e != nil {
					return e
				}
			}
		} else {
			if e = drivePGLockWorkspace(ctx, tx, c.WorkspaceID); e != nil {
				return e
			}
			if e = drivePGLockWorkspace(ctx, tx, srcWS); e != nil {
				return e
			}
		}
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
		if c.Cover != nil || c.Guard != nil {
			current, e := scanCover(tx.QueryRow(ctx, `SELECT cover_kind,cover_asset,cover_file_id,cover_position,cover_revision FROM nodes WHERE id=$1`, c.SourceID))
			if e != nil {
				return e
			}
			if c.Cover == nil && current.Kind != "none" || c.Cover != nil && current != *c.Cover {
				return ErrConflict
			}
		}
		// lockCopySource holds the source node through commit, so the download
		// threshold cannot change between this read and publishing the copy.
		var downloadMinRole, sourceDocType string
		var sourcePersonal bool
		if err := tx.QueryRow(ctx, `SELECT download_min_role, doc_type, personal FROM nodes WHERE id=$1`, c.SourceID).Scan(&downloadMinRole, &sourceDocType, &sourcePersonal); err != nil {
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
		personal := sourcePersonal
		if c.Personal != nil {
			personal = *c.Personal
		}
		if c.ParentID != nil {
			var workspace int64
			var parentKind string
			var parentWikiSpace *int64
			var parentPersonal bool
			if err := tx.QueryRow(ctx, `SELECT workspace_id,kind,wiki_space_id,personal FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, *c.ParentID).Scan(&workspace, &parentKind, &parentWikiSpace, &parentPersonal); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return ErrNotFound
				}
				return err
			}
			if workspace != c.WorkspaceID || parentKind == "file" || parentWikiSpace != nil {
				return ErrNotFound
			}
			if parentKind == "folder" {
				personal, err = drivePGDestination(ctx, tx, RestoreGuard{UserID: c.UserID}, c.WorkspaceID, c.ParentID, RoleEdit)
				if err != nil {
					return err
				}
			} else {
				personal = parentPersonal
			}
		}
		result, err = scanDocWithPermissions(tx.QueryRow(ctx, `INSERT INTO nodes (workspace_id, parent_id, kind, doc_type, sort_key, title, creator_id, drive_revision, personal)
			VALUES ($1,$2,'doc',$3,'V',$4,$5,1,$6) RETURNING `+docCols+creatorName+`, copy_protected, copy_min_role, download_min_role, comment_min_role, permissions_revision`, c.WorkspaceID, c.ParentID, sourceDocType, c.Title, c.UserID, personal))
		if err != nil {
			return err
		}
		// The source node is locked by lockCopySource; copy its display
		// preference in the same transaction as the new document.
		if _, err = tx.Exec(ctx, `INSERT INTO document_reference_visibility(doc_id,visible,revision) SELECT $1,false,1 FROM document_reference_visibility WHERE doc_id=$2 AND visible=false`, result.ID, c.SourceID); err != nil {
			return err
		}
		// Copies share immutable object keys. Lock all source attachment rows
		// before publishing any references, in a stable order. Deletion must
		// wait for this transaction before it counts references and removes a
		// blob. INSERT ... SELECT by itself does not lock the selected rows.
		uniqueFiles := make(map[int64]struct{}, len(c.FileIDs))
		for _, id := range c.FileIDs {
			uniqueFiles[id] = struct{}{}
		}
		if len(uniqueFiles) != 0 {
			rows, e := tx.Query(ctx, `SELECT id FROM attachments WHERE doc_id=$1 AND id=ANY($2) ORDER BY id FOR SHARE`, c.SourceID, c.FileIDs)
			if e != nil {
				return e
			}
			locked := 0
			for rows.Next() {
				var id int64
				if e = rows.Scan(&id); e != nil {
					rows.Close()
					return e
				}
				locked++
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return e
			}
			if locked != len(uniqueFiles) {
				return ErrNotFound
			}
		}
		mapping := make(map[int64]int64, len(c.FileIDs))
		for _, oldID := range c.FileIDs {
			if _, ok := mapping[oldID]; ok {
				continue
			}
			var newID int64
			err = tx.QueryRow(ctx, `INSERT INTO attachments (doc_id,uploader_id,name,mime,size,object_key)
				SELECT $1,$2,name,mime,size,object_key FROM attachments WHERE id=$3 AND doc_id=$4 RETURNING id`, result.ID, c.UserID, oldID, c.SourceID).Scan(&newID)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
			mapping[oldID] = newID
		}
		if c.Cover != nil && c.Cover.Kind != "none" {
			var fileID *int64
			if c.Cover.Kind == "file" {
				mapped, ok := mapping[c.Cover.FileID]
				if !ok {
					return ErrConflict
				}
				fileID = &mapped
			}
			if _, err := tx.Exec(ctx, `UPDATE nodes SET cover_kind=$2,cover_asset=$3,cover_file_id=$4,cover_position=$5,cover_revision=cover_revision+1 WHERE id=$1`, result.ID, c.Cover.Kind, c.Cover.Asset, fileID, c.Cover.Position); err != nil {
				return err
			}
		}
		ops, err := build(mapping)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO doc_heads (doc_id,seq) VALUES ($1,$2)`, result.ID, len(ops)); err != nil {
			return err
		}
		for i, op := range ops {
			duplicate, err := checkOperationIdentity(ctx, tx, result.ID, op)
			if err != nil {
				return err
			}
			if duplicate {
				return ErrOpIdentityConflict
			}
			if _, err := tx.Exec(ctx, `INSERT INTO doc_ops (doc_id,seq,client_id,clock,op) VALUES ($1,$2,$3,$4,$5)`, result.ID, i+1, op.ClientID, op.Clock, op.Bytes); err != nil {
				return err
			}
			if err := insertOperationRange(ctx, tx, result.ID, int64(i+1), op); err != nil {
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

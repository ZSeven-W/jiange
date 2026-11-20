package store

import (
	"context"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5"
)

const wikiSpaceRankSQL = `CASE WHEN m.user_id IS NULL THEN 0 ELSE GREATEST(
	CASE WHEN m.role IN ('owner','admin') OR s.creator_id = $1 THEN 3
	     WHEN s.visibility = 'workspace' THEN 1
	     ELSE 0 END,
	COALESCE((
		WITH RECURSIVE ud AS (
			SELECT d0.id, d0.parent_id, ARRAY[d0.id] AS seen
			FROM org_department_members dm
			JOIN org_departments d0 ON d0.id = dm.department_id AND d0.workspace_id = s.workspace_id
			WHERE dm.user_id = $1
			UNION ALL
			SELECT p.id, p.parent_id, ud.seen || p.id
			FROM org_departments p
			JOIN ud ON p.id = ud.parent_id
			WHERE p.workspace_id = s.workspace_id AND NOT p.id = ANY(ud.seen)
		)
		SELECT max(CASE wg.role WHEN 'view' THEN 1 WHEN 'edit' THEN 2 WHEN 'manage' THEN 3 ELSE 0 END)
		FROM wiki_space_grants wg
		WHERE wg.space_id = s.id AND (
			(wg.subject_type = 'user' AND wg.subject_id = $1)
			OR (wg.subject_type = 'department' AND EXISTS (SELECT 1 FROM ud WHERE ud.id = wg.subject_id))
			OR (wg.subject_type = 'group' AND EXISTS (SELECT 1 FROM org_group_members gm JOIN org_groups g ON g.id = gm.group_id WHERE gm.group_id = wg.subject_id AND gm.user_id = $1 AND g.workspace_id = s.workspace_id))
		)
	), 0)
) END`

func wikiPGSpaceAndRank(ctx context.Context, tx pgx.Tx, userID, spaceID int64, forUpdate bool) (WikiSpace, int, error) {
	lockClause := " FOR SHARE OF s"
	if forUpdate {
		lockClause = " FOR UPDATE OF s"
	}
	var sp WikiSpace
	var rank int
	err := tx.QueryRow(ctx, `SELECT s.id, s.workspace_id, s.name, s.description, s.icon, s.visibility, s.creator_id,
		COALESCE((SELECT u.name FROM users u WHERE u.id = s.creator_id), ''),
		s.created_at, s.updated_at, `+wikiSpaceRankSQL+`
		FROM wiki_spaces s
		LEFT JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = $1
		WHERE s.id = $2`+lockClause, userID, spaceID).
		Scan(&sp.ID, &sp.WorkspaceID, &sp.Name, &sp.Description, &sp.Icon, &sp.Visibility, &sp.CreatorID, &sp.CreatorName, &sp.CreatedAt, &sp.UpdatedAt, &rank)
	if errors.Is(err, pgx.ErrNoRows) {
		return WikiSpace{}, 0, ErrNotFound
	}
	return sp, rank, err
}

func wikiPGListGrants(ctx context.Context, tx pgx.Tx, spaceID int64) ([]WikiSpaceGrant, error) {
	rows, err := tx.Query(ctx, `
		SELECT 'user', u.id, u.name, u.email, 0, wg.role
		FROM wiki_space_grants wg
		JOIN users u ON wg.subject_type = 'user' AND u.id = wg.subject_id
		WHERE wg.space_id = $1
		UNION ALL
		SELECT 'department', d.id, d.name, '',
			(SELECT count(*) FROM org_department_members dm WHERE dm.department_id = d.id)::int,
			wg.role
		FROM wiki_space_grants wg
		JOIN org_departments d ON wg.subject_type = 'department' AND d.id = wg.subject_id
		WHERE wg.space_id = $1
		UNION ALL
		SELECT 'group', g.id, g.name, '',
			(SELECT count(*) FROM org_group_members gm WHERE gm.group_id = g.id)::int,
			wg.role
		FROM wiki_space_grants wg
		JOIN org_groups g ON wg.subject_type = 'group' AND g.id = wg.subject_id
		WHERE wg.space_id = $1
		ORDER BY 1, 2`, spaceID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (g WikiSpaceGrant, err error) {
		err = r.Scan(&g.SubjectType, &g.SubjectID, &g.Name, &g.Email, &g.MemberCount, &g.Role)
		return
	})
}

func bumpPGWikiSpaceNodesPermissionsRevision(ctx context.Context, tx pgx.Tx, spaceID int64) error {
	var exhausted bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM nodes WHERE wiki_space_id=$1 AND permissions_revision >= 9007199254740991)`, spaceID).Scan(&exhausted); err != nil {
		return err
	}
	if exhausted {
		return ErrConflict
	}
	_, err := tx.Exec(ctx, `UPDATE nodes SET permissions_revision = permissions_revision + 1 WHERE wiki_space_id=$1`, spaceID)
	return err
}

func (p *Postgres) ListWikiSpaces(ctx context.Context, guard RestoreGuard, wsID int64) (out []WikiSpace, err error) {
	out = []WikiSpace{}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, _, _, e := orgPGSessionAndMember(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `SELECT s.id, s.workspace_id, s.name, s.description, s.icon, s.visibility, s.creator_id,
			COALESCE((SELECT u.name FROM users u WHERE u.id = s.creator_id), ''),
			s.created_at, s.updated_at,
			`+wikiSpaceRankSQL+` AS rank,
			(SELECT count(*) FROM nodes n`+roleJoins+` WHERE n.wiki_space_id = s.id AND n.deleted_at IS NULL AND (`+roleSQL+`) <> '')::int AS node_count
			FROM wiki_spaces s
			LEFT JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = $1
			WHERE s.workspace_id = $2
			ORDER BY s.id`, guard.UserID, wsID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var sp WikiSpace
			var rank int
			if e = rows.Scan(&sp.ID, &sp.WorkspaceID, &sp.Name, &sp.Description, &sp.Icon, &sp.Visibility, &sp.CreatorID, &sp.CreatorName, &sp.CreatedAt, &sp.UpdatedAt, &rank, &sp.NodeCount); e != nil {
				return e
			}
			if rank == 0 && sp.NodeCount == 0 {
				continue
			}
			if rank == 0 {
				sp.CallerRole = RoleView
			} else {
				sp.CallerRole = roleFromRank(rank)
			}
			out = append(out, sp)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) GetWikiSpaceDetail(ctx context.Context, guard RestoreGuard, spaceID int64) (out WikiSpaceDetail, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		sp, rank, e := wikiPGSpaceAndRank(ctx, tx, guard.UserID, spaceID, false)
		if e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `SELECT n.id, n.workspace_id, n.wiki_space_id, n.parent_id, n.kind, n.doc_type, n.title, n.icon, n.sort_key,
			n.creator_id, COALESCE((SELECT u.name FROM users u WHERE u.id = n.creator_id), ''),
			`+roleSQL+`, n.drive_revision, n.inherit_parent_acl, n.created_at, n.updated_at
			FROM nodes n`+roleJoins+`
			WHERE n.wiki_space_id = $2 AND n.deleted_at IS NULL AND (`+roleSQL+`) <> ''
			ORDER BY n.sort_key, n.id`, guard.UserID, spaceID)
		if e != nil {
			return e
		}
		nodes, e := pgx.CollectRows(rows, func(r pgx.CollectableRow) (item WikiNodeEntry, err error) {
			err = r.Scan(&item.ID, &item.WorkspaceID, &item.WikiSpaceID, &item.ParentID, &item.Kind, &item.DocType, &item.Title, &item.Icon, &item.SortKey, &item.CreatorID, &item.CreatorName, &item.Role, &item.Revision, &item.InheritParentACL, &item.CreatedAt, &item.UpdatedAt)
			return
		})
		if e != nil {
			return e
		}
		if rank == 0 && len(nodes) == 0 {
			return ErrNotFound
		}
		visibleNodeIDs := make(map[int64]bool, len(nodes))
		for _, n := range nodes {
			visibleNodeIDs[n.ID] = true
		}
		shortcuts, e := wikiPGListShortcuts(ctx, tx, spaceID, rank > 0, visibleNodeIDs)
		if e != nil {
			return e
		}
		sp.NodeCount = len(nodes)
		if rank == 0 {
			sp.CallerRole = RoleView
		} else {
			sp.CallerRole = roleFromRank(rank)
		}
		grants := []WikiSpaceGrant{}
		if rank == 3 {
			grants, e = wikiPGListGrants(ctx, tx, spaceID)
			if e != nil {
				return e
			}
		}
		out = WikiSpaceDetail{Space: sp, Grants: grants, Nodes: nodes, Shortcuts: shortcuts}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) CreateWikiSpaceGuarded(ctx context.Context, guard RestoreGuard, wsID int64, rawName, rawDesc, rawIcon, visibility string) (out WikiSpace, err error) {
	name, ok := cleanWikiName(rawName)
	if !ok {
		return out, ErrConflict
	}
	desc, ok := cleanWikiDescription(rawDesc)
	if !ok {
		return out, ErrConflict
	}
	icon, ok := cleanWikiIcon(rawIcon)
	if !ok {
		return out, ErrConflict
	}
	if visibility == "" {
		visibility = WikiVisibilityWorkspace
	}
	if !validWikiVisibility(visibility) {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, _, _, e := orgPGSessionAndMember(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `INSERT INTO wiki_spaces (workspace_id, name, description, icon, visibility, creator_id)
			VALUES ($1,$2,$3,$4,$5,$6)
			RETURNING id, workspace_id, name, description, icon, visibility, creator_id,
				COALESCE((SELECT u.name FROM users u WHERE u.id = wiki_spaces.creator_id), ''),
				created_at, updated_at`,
			wsID, name, desc, icon, visibility, guard.UserID).
			Scan(&out.ID, &out.WorkspaceID, &out.Name, &out.Description, &out.Icon, &out.Visibility, &out.CreatorID, &out.CreatorName, &out.CreatedAt, &out.UpdatedAt); e != nil {
			return e
		}
		out.CallerRole = RoleManage
		out.NodeCount = 0
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) UpdateWikiSpaceGuarded(ctx context.Context, guard RestoreGuard, spaceID int64, rawName, rawDesc, rawIcon, rawVis *string) (out WikiSpace, err error) {
	var name, desc, icon, vis string
	if rawName != nil {
		var ok bool
		name, ok = cleanWikiName(*rawName)
		if !ok {
			return out, ErrConflict
		}
	}
	if rawDesc != nil {
		var ok bool
		desc, ok = cleanWikiDescription(*rawDesc)
		if !ok {
			return out, ErrConflict
		}
	}
	if rawIcon != nil {
		var ok bool
		icon, ok = cleanWikiIcon(*rawIcon)
		if !ok {
			return out, ErrConflict
		}
	}
	if rawVis != nil {
		if !validWikiVisibility(*rawVis) {
			return out, ErrConflict
		}
		vis = *rawVis
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		sp, rank, e := wikiPGSpaceAndRank(ctx, tx, guard.UserID, spaceID, true)
		if e != nil {
			return e
		}
		if rank < 3 {
			return ErrForbidden
		}
		nextName, nextDesc, nextIcon, nextVis := sp.Name, sp.Description, sp.Icon, sp.Visibility
		if rawName != nil {
			nextName = name
		}
		if rawDesc != nil {
			nextDesc = desc
		}
		if rawIcon != nil {
			nextIcon = icon
		}
		if rawVis != nil {
			nextVis = vis
		}
		if nextVis != sp.Visibility {
			if e = bumpPGWikiSpaceNodesPermissionsRevision(ctx, tx, spaceID); e != nil {
				return e
			}
		}
		if e = tx.QueryRow(ctx, `UPDATE wiki_spaces SET name=$2, description=$3, icon=$4, visibility=$5, updated_at=now() WHERE id=$1
			RETURNING id, workspace_id, name, description, icon, visibility, creator_id,
				COALESCE((SELECT u.name FROM users u WHERE u.id = wiki_spaces.creator_id), ''),
				created_at, updated_at`,
			spaceID, nextName, nextDesc, nextIcon, nextVis).
			Scan(&out.ID, &out.WorkspaceID, &out.Name, &out.Description, &out.Icon, &out.Visibility, &out.CreatorID, &out.CreatorName, &out.CreatedAt, &out.UpdatedAt); e != nil {
			return e
		}
		out.CallerRole = RoleManage
		if e = tx.QueryRow(ctx, `SELECT count(*)::int FROM nodes n`+roleJoins+` WHERE n.wiki_space_id=$2 AND n.deleted_at IS NULL AND (`+roleSQL+`) <> ''`, guard.UserID, spaceID).Scan(&out.NodeCount); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) DeleteWikiSpaceGuarded(ctx context.Context, guard RestoreGuard, spaceID int64) (freed []string, err error) {
	freed = []string{}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var ws int64
		if e := tx.QueryRow(ctx, `SELECT workspace_id FROM wiki_spaces WHERE id=$1`, spaceID).Scan(&ws); errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		} else if e != nil {
			return e
		}
		if e := drivePGLockWorkspace(ctx, tx, ws); e != nil {
			return e
		}
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		_, rank, e := wikiPGSpaceAndRank(ctx, tx, guard.UserID, spaceID, true)
		if e != nil {
			return e
		}
		if rank < 3 {
			return ErrForbidden
		}
		rows, e := tx.Query(ctx, `SELECT DISTINCT a.object_key FROM attachments a JOIN nodes n ON n.id = a.doc_id WHERE n.wiki_space_id = $1`, spaceID)
		if e != nil {
			return e
		}
		keys := []string{}
		for rows.Next() {
			var k string
			if e = rows.Scan(&k); e != nil {
				rows.Close()
				return e
			}
			keys = append(keys, k)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
		if _, e = tx.Exec(ctx, `DELETE FROM wiki_spaces WHERE id=$1`, spaceID); e != nil {
			return e
		}
		for _, k := range keys {
			var refs int64
			if e = tx.QueryRow(ctx, `SELECT count(*) FROM attachments WHERE object_key=$1`, k).Scan(&refs); e != nil {
				return e
			}
			if refs == 0 {
				freed = append(freed, k)
			}
		}
		sort.Strings(freed)
		return drivePGEnd(ctx, guard, expires)
	})
	return freed, orgPGError(err)
}

func (p *Postgres) SetWikiSpaceGrantGuarded(ctx context.Context, guard RestoreGuard, spaceID int64, subjectType string, subjectID int64, role string) (out []WikiSpaceGrant, err error) {
	if !validWikiGrantSubjectType(subjectType) || subjectID <= 0 || (role != "" && RoleRank(role) == 0) {
		return nil, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		// Lock department/group row first to match DeleteDepartment/DeleteUserGroup lock order.
		var subjectWS int64
		var subjectMissing bool
		if subjectType == SubjectTypeDepartment {
			e := tx.QueryRow(ctx, `SELECT workspace_id FROM org_departments WHERE id=$1 FOR SHARE`, subjectID).Scan(&subjectWS)
			subjectMissing = errors.Is(e, pgx.ErrNoRows)
			if e != nil && !subjectMissing {
				return e
			}
		} else if subjectType == SubjectTypeGroup {
			e := tx.QueryRow(ctx, `SELECT workspace_id FROM org_groups WHERE id=$1 FOR SHARE`, subjectID).Scan(&subjectWS)
			subjectMissing = errors.Is(e, pgx.ErrNoRows)
			if e != nil && !subjectMissing {
				return e
			}
		}
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		sp, rank, e := wikiPGSpaceAndRank(ctx, tx, guard.UserID, spaceID, true)
		if e != nil {
			return e
		}
		if rank < 3 {
			return ErrForbidden
		}
		if subjectType == SubjectTypeUser {
			var uid int64
			e = tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, sp.WorkspaceID, subjectID).Scan(&uid)
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if e != nil {
				return e
			}
			if subjectID == sp.CreatorID && role != RoleManage {
				return ErrForbidden
			}
		} else if subjectMissing || subjectWS != sp.WorkspaceID {
			return ErrNotFound
		}
		if role == "" {
			if _, e = tx.Exec(ctx, `DELETE FROM wiki_space_grants WHERE space_id=$1 AND subject_type=$2 AND subject_id=$3`, spaceID, subjectType, subjectID); e != nil {
				return e
			}
		} else {
			if _, e = tx.Exec(ctx, `INSERT INTO wiki_space_grants (space_id, subject_type, subject_id, role) VALUES ($1,$2,$3,$4)
				ON CONFLICT (space_id, subject_type, subject_id) DO UPDATE SET role=EXCLUDED.role`, spaceID, subjectType, subjectID, role); e != nil {
				return e
			}
		}
		if e = bumpPGWikiSpaceNodesPermissionsRevision(ctx, tx, spaceID); e != nil {
			return e
		}
		out, e = wikiPGListGrants(ctx, tx, spaceID)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) CreateWikiNodeGuarded(ctx context.Context, guard RestoreGuard, spaceID int64, parentID *int64, kind, docType, title string) (out WikiNodeEntry, err error) {
	if !validWikiNodeKind(kind) || !ValidDocType(docType) || (docType != "" && kind != "doc") || !validDriveTitle(title) {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var ws int64
		if e := tx.QueryRow(ctx, `SELECT workspace_id FROM wiki_spaces WHERE id=$1`, spaceID).Scan(&ws); errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		} else if e != nil {
			return e
		}
		if e := drivePGLockWorkspace(ctx, tx, ws); e != nil {
			return e
		}
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		sp, rank, e := wikiPGSpaceAndRank(ctx, tx, guard.UserID, spaceID, false)
		if e != nil {
			return e
		}
		var member int
		e = tx.QueryRow(ctx, `SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, sp.WorkspaceID, guard.UserID).Scan(&member)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if e != nil {
			return e
		}
		if parentID != nil {
			var pws int64
			var pKind string
			var pSpace *int64
			e = tx.QueryRow(ctx, `SELECT workspace_id, kind, wiki_space_id FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, *parentID).Scan(&pws, &pKind, &pSpace)
			if errors.Is(e, pgx.ErrNoRows) || (e == nil && (pws != sp.WorkspaceID || pSpace == nil || *pSpace != spaceID || pKind == "file")) {
				return ErrNotFound
			}
			if e != nil {
				return e
			}
			if kind == "folder" && pKind != "folder" {
				return ErrConflict
			}
			if e = drivePGValidChain(ctx, tx, *parentID, sp.WorkspaceID); e != nil {
				return e
			}
			role, _, _, e := lockCopySource(ctx, tx, *parentID, guard.UserID)
			if e != nil {
				return e
			}
			if RoleRank(role) < RoleRank(RoleEdit) {
				return ErrForbidden
			}
		} else if rank < 2 {
			return ErrForbidden
		}
		nextSortKey, e := wikiPGNextSiblingSortKey(ctx, tx, spaceID, parentID)
		if e != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `INSERT INTO nodes (workspace_id, parent_id, kind, doc_type, sort_key, title, creator_id, drive_revision, personal, wiki_space_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,1,false,$8)
			RETURNING id, workspace_id, wiki_space_id, parent_id, kind, doc_type, title, icon, sort_key, creator_id,
				COALESCE((SELECT u.name FROM users u WHERE u.id = nodes.creator_id), ''),
				drive_revision, inherit_parent_acl, created_at, updated_at`,
			sp.WorkspaceID, parentID, kind, docType, nextSortKey, title, guard.UserID, spaceID).
			Scan(&out.ID, &out.WorkspaceID, &out.WikiSpaceID, &out.ParentID, &out.Kind, &out.DocType, &out.Title, &out.Icon, &out.SortKey, &out.CreatorID, &out.CreatorName, &out.Revision, &out.InheritParentACL, &out.CreatedAt, &out.UpdatedAt); e != nil {
			return e
		}
		out.Role = RoleManage
		if kind == "doc" {
			initial := InitialDocOps(title)
			if _, e = tx.Exec(ctx, `INSERT INTO doc_heads (doc_id, seq) VALUES ($1, $2)`, out.ID, len(initial)); e != nil {
				return e
			}
			for i, op := range initial {
				duplicate, e := checkOperationIdentity(ctx, tx, out.ID, op)
				if e != nil {
					return e
				}
				if duplicate {
					return ErrOpIdentityConflict
				}
				if _, e = tx.Exec(ctx, `INSERT INTO doc_ops (doc_id, seq, client_id, clock, op) VALUES ($1, $2, $3, $4, $5)`, out.ID, i+1, op.ClientID, op.Clock, op.Bytes); e != nil {
					return e
				}
				if e = insertOperationRange(ctx, tx, out.ID, int64(i+1), op); e != nil {
					return e
				}
			}
		} else if kind == "base" {
			if _, e = tx.Exec(ctx, `INSERT INTO base_fields (base_id,name,type,position,is_primary) VALUES ($1,'文本','text',1,true)`, out.ID); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO bt_views (base_id,type,name,config,pos) VALUES ($1,'grid','表格','{}'::jsonb,1)`, out.ID); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO base_records (base_id,cells,position,creator_id)
				SELECT $1,'{}'::jsonb, n, $2 FROM generate_series(1,5) AS n`, out.ID, guard.UserID); e != nil {
				return e
			}
		} else if kind == "slides" {
			if _, e = tx.Exec(ctx, `INSERT INTO slides_pages (slides_id,pos) VALUES ($1,1)`, out.ID); e != nil {
				return e
			}
		} else if kind == "sheet" {
			if e = p.initSheetWorkbookPG(ctx, tx, out.ID); e != nil {
				return e
			}
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func wikiPGCheckSubtreeManage(ctx context.Context, tx pgx.Tx, userID, rootID int64, rejectFiles bool) error {
	rows, err := tx.Query(ctx, `WITH RECURSIVE t(id) AS (
		SELECT $1::bigint
		UNION ALL
		SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id
	) SELECT n.id, n.kind FROM nodes n JOIN t ON t.id = n.id WHERE n.deleted_at IS NULL ORDER BY n.id`, rootID)
	if err != nil {
		return err
	}
	type subNode struct {
		id   int64
		kind string
	}
	var items []subNode
	for rows.Next() {
		var s subNode
		if err := rows.Scan(&s.id, &s.kind); err != nil {
			rows.Close()
			return err
		}
		items = append(items, s)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, item := range items {
		if rejectFiles && item.kind == "file" {
			return ErrConflict
		}
		role, _, _, err := lockCopySource(ctx, tx, item.id, userID)
		if errors.Is(err, ErrNotFound) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if RoleRank(role) < RoleRank(RoleManage) {
			return ErrForbidden
		}
	}
	return nil
}

func (p *Postgres) MoveWikiNodeGuarded(ctx context.Context, guard RestoreGuard, nodeID, targetSpaceID int64, targetParentID *int64, expectedRevision int64) (out WikiNodeEntry, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		ws, e := drivePGNodeWorkspace(ctx, tx, nodeID)
		if e != nil {
			return e
		}
		if e = drivePGLockWorkspace(ctx, tx, ws); e != nil {
			return e
		}
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		var currentWS, rev int64
		var deleted bool
		var kind string
		var sourceSpaceID *int64
		e = tx.QueryRow(ctx, `SELECT workspace_id, drive_revision, deleted_at IS NOT NULL, kind, wiki_space_id FROM nodes WHERE id=$1 FOR UPDATE`, nodeID).
			Scan(&currentWS, &rev, &deleted, &kind, &sourceSpaceID)
		if e != nil {
			return notFound(e)
		}
		if deleted || sourceSpaceID == nil {
			return ErrNotFound
		}
		if currentWS != ws || rev != expectedRevision || rev >= maxDriveRevision {
			return ErrConflict
		}
		if e = drivePGValidChain(ctx, tx, nodeID, ws); e != nil {
			return e
		}
		targetSpace, targetRank, e := wikiPGSpaceAndRank(ctx, tx, guard.UserID, targetSpaceID, false)
		if e != nil {
			return e
		}
		if targetSpace.WorkspaceID != ws {
			return ErrNotFound
		}
		if *sourceSpaceID != targetSpaceID {
			if e = wikiPGCheckSubtreeManage(ctx, tx, guard.UserID, nodeID, false); e != nil {
				return e
			}
		} else {
			role, _, _, e := lockCopySource(ctx, tx, nodeID, guard.UserID)
			if e != nil {
				return e
			}
			if RoleRank(role) < RoleRank(RoleManage) {
				return ErrForbidden
			}
		}
		if targetParentID != nil {
			var pws int64
			var pKind string
			var pSpace *int64
			e = tx.QueryRow(ctx, `SELECT workspace_id, kind, wiki_space_id FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, *targetParentID).Scan(&pws, &pKind, &pSpace)
			if errors.Is(e, pgx.ErrNoRows) || (e == nil && (pws != ws || pSpace == nil || *pSpace != targetSpaceID || pKind == "file")) {
				return ErrNotFound
			}
			if e != nil {
				return e
			}
			if kind == "folder" && pKind != "folder" {
				return ErrConflict
			}
			if e = drivePGValidChain(ctx, tx, *targetParentID, ws); e != nil {
				return e
			}
			pRole, _, _, e := lockCopySource(ctx, tx, *targetParentID, guard.UserID)
			if e != nil {
				return e
			}
			if RoleRank(pRole) < RoleRank(RoleEdit) {
				return ErrForbidden
			}
			var cyc bool
			if e = tx.QueryRow(ctx, `WITH RECURSIVE a AS (SELECT id,parent_id,ARRAY[id] seen FROM nodes WHERE id=$1 UNION ALL SELECT n.id,n.parent_id,a.seen||n.id FROM nodes n JOIN a ON n.id=a.parent_id WHERE NOT n.id=ANY(a.seen)) SELECT EXISTS(SELECT 1 FROM a WHERE id=$2)`, *targetParentID, nodeID).Scan(&cyc); e != nil {
				return e
			}
			if cyc {
				return ErrConflict
			}
		} else if targetRank < 2 {
			return ErrForbidden
		}
		if e = bumpPGSubtreePermissionsRevision(ctx, tx, nodeID, true); e != nil {
			return e
		}
		nextSortKey, e := wikiPGNextSiblingSortKey(ctx, tx, targetSpaceID, targetParentID)
		if e != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `UPDATE nodes SET parent_id=$2, wiki_space_id=$3, sort_key=$4, drive_revision=drive_revision+1, updated_at=now() WHERE id=$1
			RETURNING id, workspace_id, wiki_space_id, parent_id, kind, doc_type, title, icon, sort_key, creator_id,
				COALESCE((SELECT u.name FROM users u WHERE u.id = nodes.creator_id), ''),
				drive_revision, inherit_parent_acl, created_at, updated_at`,
			nodeID, targetParentID, targetSpaceID, nextSortKey).
			Scan(&out.ID, &out.WorkspaceID, &out.WikiSpaceID, &out.ParentID, &out.Kind, &out.DocType, &out.Title, &out.Icon, &out.SortKey, &out.CreatorID, &out.CreatorName, &out.Revision, &out.InheritParentACL, &out.CreatedAt, &out.UpdatedAt); e != nil {
			return e
		}
		if *sourceSpaceID != targetSpaceID {
			if _, e = tx.Exec(ctx, `WITH RECURSIVE sub(id) AS (
				SELECT id FROM nodes WHERE parent_id=$1
				UNION ALL
				SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
			) UPDATE nodes SET wiki_space_id=$2 WHERE id IN (SELECT id FROM sub)`, nodeID, targetSpaceID); e != nil {
				return e
			}
		}
		if e = recordDocumentModifier(ctx, tx, nodeID, guard.UserID); e != nil {
			return e
		}
		newRole, _, _, e := lockCopySource(ctx, tx, nodeID, guard.UserID)
		if e != nil && !errors.Is(e, ErrNotFound) {
			return e
		}
		out.Role = newRole
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) ImportDriveNodeToWikiGuarded(ctx context.Context, guard RestoreGuard, sourceNodeID, targetSpaceID int64, targetParentID *int64, expectedRevision int64) (out WikiNodeEntry, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		ws, e := drivePGNodeWorkspace(ctx, tx, sourceNodeID)
		if e != nil {
			return e
		}
		if e = drivePGLockWorkspace(ctx, tx, ws); e != nil {
			return e
		}
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		var currentWS, rev int64
		var deleted bool
		var kind string
		var sourceSpaceID *int64
		e = tx.QueryRow(ctx, `SELECT workspace_id, drive_revision, deleted_at IS NOT NULL, kind, wiki_space_id FROM nodes WHERE id=$1 FOR UPDATE`, sourceNodeID).
			Scan(&currentWS, &rev, &deleted, &kind, &sourceSpaceID)
		if e != nil {
			return notFound(e)
		}
		if deleted {
			return ErrNotFound
		}
		if sourceSpaceID != nil || currentWS != ws || rev != expectedRevision || rev >= maxDriveRevision {
			return ErrConflict
		}
		if e = drivePGValidChain(ctx, tx, sourceNodeID, ws); e != nil {
			return e
		}
		targetSpace, targetRank, e := wikiPGSpaceAndRank(ctx, tx, guard.UserID, targetSpaceID, false)
		if e != nil {
			return e
		}
		if targetSpace.WorkspaceID != ws {
			return ErrNotFound
		}
		if e = wikiPGCheckSubtreeManage(ctx, tx, guard.UserID, sourceNodeID, true); e != nil {
			return e
		}
		if targetParentID != nil {
			var pws int64
			var pKind string
			var pSpace *int64
			e = tx.QueryRow(ctx, `SELECT workspace_id, kind, wiki_space_id FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, *targetParentID).Scan(&pws, &pKind, &pSpace)
			if errors.Is(e, pgx.ErrNoRows) || (e == nil && (pws != ws || pSpace == nil || *pSpace != targetSpaceID || pKind == "file")) {
				return ErrNotFound
			}
			if e != nil {
				return e
			}
			if kind == "folder" && pKind != "folder" {
				return ErrConflict
			}
			if e = drivePGValidChain(ctx, tx, *targetParentID, ws); e != nil {
				return e
			}
			pRole, _, _, e := lockCopySource(ctx, tx, *targetParentID, guard.UserID)
			if e != nil {
				return e
			}
			if RoleRank(pRole) < RoleRank(RoleEdit) {
				return ErrForbidden
			}
			var cyc bool
			if e = tx.QueryRow(ctx, `WITH RECURSIVE a AS (SELECT id,parent_id,ARRAY[id] seen FROM nodes WHERE id=$1 UNION ALL SELECT n.id,n.parent_id,a.seen||n.id FROM nodes n JOIN a ON n.id=a.parent_id WHERE NOT n.id=ANY(a.seen)) SELECT EXISTS(SELECT 1 FROM a WHERE id=$2)`, *targetParentID, sourceNodeID).Scan(&cyc); e != nil {
				return e
			}
			if cyc {
				return ErrConflict
			}
		} else if targetRank < 2 {
			return ErrForbidden
		}
		if e = bumpPGSubtreePermissionsRevision(ctx, tx, sourceNodeID, true); e != nil {
			return e
		}
		nextSortKey, e := wikiPGNextSiblingSortKey(ctx, tx, targetSpaceID, targetParentID)
		if e != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `UPDATE nodes SET parent_id=$2, wiki_space_id=$3, sort_key=$4, personal=false, drive_revision=drive_revision+1, updated_at=now() WHERE id=$1
			RETURNING id, workspace_id, wiki_space_id, parent_id, kind, doc_type, title, icon, sort_key, creator_id,
				COALESCE((SELECT u.name FROM users u WHERE u.id = nodes.creator_id), ''),
				drive_revision, inherit_parent_acl, created_at, updated_at`,
			sourceNodeID, targetParentID, targetSpaceID, nextSortKey).
			Scan(&out.ID, &out.WorkspaceID, &out.WikiSpaceID, &out.ParentID, &out.Kind, &out.DocType, &out.Title, &out.Icon, &out.SortKey, &out.CreatorID, &out.CreatorName, &out.Revision, &out.InheritParentACL, &out.CreatedAt, &out.UpdatedAt); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `WITH RECURSIVE sub(id) AS (
			SELECT id FROM nodes WHERE parent_id=$1
			UNION ALL
			SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
		) UPDATE nodes SET wiki_space_id=$2, personal=false WHERE id IN (SELECT id FROM sub)`, sourceNodeID, targetSpaceID); e != nil {
			return e
		}
		if e = recordDocumentModifier(ctx, tx, sourceNodeID, guard.UserID); e != nil {
			return e
		}
		newRole, _, _, e := lockCopySource(ctx, tx, sourceNodeID, guard.UserID)
		if e != nil && !errors.Is(e, ErrNotFound) {
			return e
		}
		out.Role = newRole
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

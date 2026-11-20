package store

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

func parseWikiNumericSortKey(raw string) (int, bool) {
	if !strings.HasPrefix(raw, "w") {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(raw, "w"))
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

func wikiPGNextSiblingSortKey(ctx context.Context, tx pgx.Tx, spaceID int64, parentID *int64) (string, error) {
	rows, err := tx.Query(ctx, `SELECT sort_key FROM nodes
		WHERE wiki_space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`, spaceID, parentID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	count := 0
	maxNum := 0
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return "", err
		}
		count++
		if num, ok := parseWikiNumericSortKey(key); ok && num > maxNum {
			maxNum = num
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	nextIdx := count
	if maxNum/10 > nextIdx {
		nextIdx = maxNum / 10
	}
	return wikiSortKeyForIndex(nextIdx), nil
}

func wikiPGNextShortcutSortKey(ctx context.Context, tx pgx.Tx, spaceID int64, parentID *int64) (string, error) {
	rows, err := tx.Query(ctx, `SELECT sort_key FROM wiki_shortcuts
		WHERE wiki_space_id = $1 AND parent_id IS NOT DISTINCT FROM $2`, spaceID, parentID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	count := 0
	maxNum := 0
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return "", err
		}
		count++
		if num, ok := parseWikiNumericSortKey(key); ok && num > maxNum {
			maxNum = num
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	nextIdx := count
	if maxNum/10 > nextIdx {
		nextIdx = maxNum / 10
	}
	return wikiSortKeyForIndex(nextIdx), nil
}

func wikiPGListShortcuts(ctx context.Context, tx pgx.Tx, spaceID int64, hasSpaceAccess bool, visibleNodes map[int64]bool) ([]WikiShortcut, error) {
	rows, err := tx.Query(ctx, `SELECT s.id, s.workspace_id, s.wiki_space_id, s.parent_id, s.target_node_id, s.title, s.sort_key,
		s.creator_id, COALESCE((SELECT u.name FROM users u WHERE u.id = s.creator_id), ''), s.created_at, s.updated_at
		FROM wiki_shortcuts s
		WHERE s.wiki_space_id = $1
		ORDER BY s.sort_key, s.id`, spaceID)
	if err != nil {
		return nil, err
	}
	all, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (sc WikiShortcut, e error) {
		e = r.Scan(&sc.ID, &sc.WorkspaceID, &sc.WikiSpaceID, &sc.ParentID, &sc.TargetNodeID, &sc.Title, &sc.SortKey, &sc.CreatorID, &sc.CreatorName, &sc.CreatedAt, &sc.UpdatedAt)
		return
	})
	if err != nil {
		return nil, err
	}
	out := make([]WikiShortcut, 0, len(all))
	for _, sc := range all {
		if sc.ParentID == nil {
			if !hasSpaceAccess {
				continue
			}
		} else if !visibleNodes[*sc.ParentID] {
			continue
		}
		out = append(out, sc)
	}
	return out, nil
}

func (p *Postgres) ReorderWikiNodeGuarded(ctx context.Context, guard RestoreGuard, spaceID, nodeID int64, targetParentID *int64, position int, expectedRevision int64) (out WikiNodeEntry, err error) {
	if position < 0 {
		return out, ErrConflict
	}
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
		var sourceSpaceID, currentParentID *int64
		e = tx.QueryRow(ctx, `SELECT workspace_id, drive_revision, deleted_at IS NOT NULL, kind, wiki_space_id, parent_id
			FROM nodes WHERE id = $1 FOR UPDATE`, nodeID).
			Scan(&currentWS, &rev, &deleted, &kind, &sourceSpaceID, &currentParentID)
		if e != nil {
			return notFound(e)
		}
		if deleted || sourceSpaceID == nil || *sourceSpaceID != spaceID {
			return ErrNotFound
		}
		if currentWS != ws || rev != expectedRevision || rev >= maxDriveRevision {
			return ErrConflict
		}
		if e = drivePGValidChain(ctx, tx, nodeID, ws); e != nil {
			return e
		}
		sp, spaceRank, e := wikiPGSpaceAndRank(ctx, tx, guard.UserID, spaceID, false)
		if e != nil {
			return e
		}
		if sp.WorkspaceID != ws {
			return ErrNotFound
		}
		sameParent := sameDriveParent(currentParentID, targetParentID)
		nodeRole, _, _, e := lockCopySource(ctx, tx, nodeID, guard.UserID)
		if e != nil {
			return e
		}
		if sameParent {
			if RoleRank(nodeRole) < RoleRank(RoleEdit) {
				return ErrForbidden
			}
		} else {
			if RoleRank(nodeRole) < RoleRank(RoleManage) {
				return ErrForbidden
			}
		}
		if targetParentID != nil {
			if *targetParentID == nodeID {
				return ErrConflict
			}
			var pws int64
			var pKind string
			var pSpace *int64
			e = tx.QueryRow(ctx, `SELECT workspace_id, kind, wiki_space_id FROM nodes WHERE id = $1 AND deleted_at IS NULL FOR SHARE`, *targetParentID).
				Scan(&pws, &pKind, &pSpace)
			if errors.Is(e, pgx.ErrNoRows) || (e == nil && (pws != ws || pSpace == nil || *pSpace != spaceID || pKind == "file")) {
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
			if e = tx.QueryRow(ctx, `WITH RECURSIVE a AS (
				SELECT id, parent_id, ARRAY[id] seen FROM nodes WHERE id = $1
				UNION ALL
				SELECT n.id, n.parent_id, a.seen || n.id FROM nodes n JOIN a ON n.id = a.parent_id WHERE NOT n.id = ANY(a.seen)
			) SELECT EXISTS(SELECT 1 FROM a WHERE id = $2)`, *targetParentID, nodeID).Scan(&cyc); e != nil {
				return e
			}
			if cyc {
				return ErrConflict
			}
		} else if spaceRank < 2 {
			return ErrForbidden
		}
		if !sameParent {
			if e = bumpPGSubtreePermissionsRevision(ctx, tx, nodeID, true); e != nil {
				return e
			}
		}
		rows, e := tx.Query(ctx, `SELECT id FROM nodes
			WHERE wiki_space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL AND id <> $3
			ORDER BY sort_key, id FOR UPDATE`, spaceID, targetParentID, nodeID)
		if e != nil {
			return e
		}
		siblings, e := pgx.CollectRows(rows, func(r pgx.CollectableRow) (int64, error) {
			var id int64
			return id, r.Scan(&id)
		})
		if e != nil {
			return e
		}
		pos := position
		if pos > len(siblings) {
			pos = len(siblings)
		}
		ordered := make([]int64, 0, len(siblings)+1)
		ordered = append(ordered, siblings[:pos]...)
		ordered = append(ordered, nodeID)
		ordered = append(ordered, siblings[pos:]...)
		movedKey := wikiSortKeyForIndex(pos)
		for i, sid := range ordered {
			key := wikiSortKeyForIndex(i)
			if sid == nodeID {
				continue
			}
			if _, e = tx.Exec(ctx, `UPDATE nodes SET sort_key = $2 WHERE id = $1`, sid, key); e != nil {
				return e
			}
		}
		if e = tx.QueryRow(ctx, `UPDATE nodes SET parent_id = $2, sort_key = $3, drive_revision = drive_revision + 1, updated_at = now()
			WHERE id = $1
			RETURNING id, workspace_id, wiki_space_id, parent_id, kind, doc_type, title, icon, sort_key, creator_id,
				COALESCE((SELECT u.name FROM users u WHERE u.id = nodes.creator_id), ''),
				drive_revision, inherit_parent_acl, created_at, updated_at`,
			nodeID, targetParentID, movedKey).
			Scan(&out.ID, &out.WorkspaceID, &out.WikiSpaceID, &out.ParentID, &out.Kind, &out.DocType, &out.Title, &out.Icon, &out.SortKey, &out.CreatorID, &out.CreatorName, &out.Revision, &out.InheritParentACL, &out.CreatedAt, &out.UpdatedAt); e != nil {
			return e
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

func (p *Postgres) CreateWikiShortcutGuarded(ctx context.Context, guard RestoreGuard, spaceID int64, parentID *int64, targetNodeID int64, rawTitle string) (out WikiShortcut, err error) {
	clean, ok := cleanShortcutTitle(rawTitle)
	if spaceID <= 0 || targetNodeID <= 0 || !ok {
		return out, ErrConflict
	}
	if parentID != nil && *parentID == targetNodeID {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var ws int64
		if e := tx.QueryRow(ctx, `SELECT workspace_id FROM wiki_spaces WHERE id = $1`, spaceID).Scan(&ws); errors.Is(e, pgx.ErrNoRows) {
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
		if parentID != nil {
			var pws int64
			var pKind string
			var pSpace *int64
			e = tx.QueryRow(ctx, `SELECT workspace_id, kind, wiki_space_id FROM nodes WHERE id = $1 AND deleted_at IS NULL FOR SHARE`, *parentID).
				Scan(&pws, &pKind, &pSpace)
			if errors.Is(e, pgx.ErrNoRows) || (e == nil && (pws != sp.WorkspaceID || pSpace == nil || *pSpace != spaceID || pKind == "file")) {
				return ErrNotFound
			}
			if e != nil {
				return e
			}
			if e = drivePGValidChain(ctx, tx, *parentID, sp.WorkspaceID); e != nil {
				return e
			}
			pRole, _, _, e := lockCopySource(ctx, tx, *parentID, guard.UserID)
			if e != nil {
				return e
			}
			if RoleRank(pRole) < RoleRank(RoleEdit) {
				return ErrForbidden
			}
		} else if rank < 2 {
			return ErrForbidden
		}
		var targetTitle string
		var targetDeleted bool
		var targetWS int64
		e = tx.QueryRow(ctx, `SELECT workspace_id, title, deleted_at IS NOT NULL FROM nodes WHERE id = $1`, targetNodeID).
			Scan(&targetWS, &targetTitle, &targetDeleted)
		if errors.Is(e, pgx.ErrNoRows) || (e == nil && targetDeleted) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if e = drivePGValidChain(ctx, tx, targetNodeID, targetWS); e != nil {
			return e
		}
		targetRole, _, _, e := lockCopySource(ctx, tx, targetNodeID, guard.UserID)
		if e != nil {
			return e
		}
		if RoleRank(targetRole) < RoleRank(RoleView) {
			return ErrNotFound
		}
		var dup bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM wiki_shortcuts
			WHERE wiki_space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND target_node_id = $3
		)`, spaceID, parentID, targetNodeID).Scan(&dup); e != nil {
			return e
		}
		if dup {
			return ErrConflict
		}
		if clean == "" {
			clean = targetTitle
		}
		sortKey, e := wikiPGNextShortcutSortKey(ctx, tx, spaceID, parentID)
		if e != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `INSERT INTO wiki_shortcuts (workspace_id, wiki_space_id, parent_id, target_node_id, title, sort_key, creator_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING id, workspace_id, wiki_space_id, parent_id, target_node_id, title, sort_key, creator_id,
				COALESCE((SELECT u.name FROM users u WHERE u.id = wiki_shortcuts.creator_id), ''), created_at, updated_at`,
			sp.WorkspaceID, spaceID, parentID, targetNodeID, clean, sortKey, guard.UserID).
			Scan(&out.ID, &out.WorkspaceID, &out.WikiSpaceID, &out.ParentID, &out.TargetNodeID, &out.Title, &out.SortKey, &out.CreatorID, &out.CreatorName, &out.CreatedAt, &out.UpdatedAt); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) DeleteWikiShortcutGuarded(ctx context.Context, guard RestoreGuard, spaceID, shortcutID int64) error {
	if spaceID <= 0 || shortcutID <= 0 {
		return ErrNotFound
	}
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var ws, creatorID int64
		var scSpaceID int64
		var parentID *int64
		e := tx.QueryRow(ctx, `SELECT workspace_id, wiki_space_id, parent_id, creator_id FROM wiki_shortcuts WHERE id = $1 FOR UPDATE`, shortcutID).
			Scan(&ws, &scSpaceID, &parentID, &creatorID)
		if errors.Is(e, pgx.ErrNoRows) || (e == nil && scSpaceID != spaceID) {
			return ErrNotFound
		}
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
		_, rank, e := wikiPGSpaceAndRank(ctx, tx, guard.UserID, spaceID, false)
		if e != nil {
			return e
		}
		allowed := creatorID == guard.UserID || rank >= 3 || (parentID == nil && rank >= 2)
		if !allowed && parentID != nil {
			if pRole, _, _, pe := lockCopySource(ctx, tx, *parentID, guard.UserID); pe == nil && RoleRank(pRole) >= RoleRank(RoleEdit) {
				allowed = true
			}
		}
		if !allowed {
			return ErrForbidden
		}
		if _, e = tx.Exec(ctx, `DELETE FROM wiki_shortcuts WHERE id = $1`, shortcutID); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return drivePGError(err)
}

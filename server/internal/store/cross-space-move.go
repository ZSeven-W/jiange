package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// CrossSpaceMoveStore provides an explicit opt-in drive move operation capable
// of moving a node and its entire descendant subtree between personal/shared
// scopes or across workspaces. Regular MoveDriveNode remains strictly scoped
// to prevent accidental visibility leaks.
type CrossSpaceMoveStore interface {
	CrossSpaceMoveNode(
		ctx context.Context,
		actorID int64,
		nodeID int64,
		targetWorkspaceID int64,
		targetParentID *int64,
		targetPersonal bool,
		expectedDriveRevision int64,
	) (DriveEntry, error)
}

var (
	_ CrossSpaceMoveStore = (*Memory)(nil)
	_ CrossSpaceMoveStore = (*Postgres)(nil)
)

func isValidCrossSpaceMemberRole(role string) bool {
	return role == WorkspaceRoleOwner || role == WorkspaceRoleAdmin || role == WorkspaceRoleMember
}

// CrossSpaceMoveNode atomically moves nodeID and its entire descendant subtree
// across personal/shared scopes and/or across workspaces on the in-memory store.
func (m *Memory) CrossSpaceMoveNode(
	ctx context.Context,
	actorID int64,
	nodeID int64,
	targetWorkspaceID int64,
	targetParentID *int64,
	targetPersonal bool,
	expectedDriveRevision int64,
) (DriveEntry, error) {
	if err := ctx.Err(); err != nil {
		return DriveEntry{}, err
	}
	if actorID <= 0 || nodeID <= 0 || targetWorkspaceID < 0 {
		return DriveEntry{}, ErrConflict
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	d := m.doc(nodeID)
	if d == nil || d.purged {
		return DriveEntry{}, ErrNotFound
	}
	if d.deleted {
		return DriveEntry{}, ErrConflict
	}
	sourceWS := d.meta.WorkspaceID
	if !m.driveValidChainLocked(d, sourceWS, false) {
		return DriveEntry{}, ErrConflict
	}
	if RoleRank(m.roleLocked(actorID, d)) < RoleRank(RoleManage) {
		return DriveEntry{}, ErrForbidden
	}
	if d.driveRevision != expectedDriveRevision || d.driveRevision >= maxDriveRevision {
		return DriveEntry{}, ErrConflict
	}

	if targetWorkspaceID == 0 {
		targetWorkspaceID = sourceWS
	}
	if targetWorkspaceID <= 0 || int(targetWorkspaceID) > len(m.workspaces) {
		return DriveEntry{}, ErrNotFound
	}
	if !isValidCrossSpaceMemberRole(m.workspaceRoleLocked(targetWorkspaceID, actorID)) {
		return DriveEntry{}, ErrForbidden
	}

	if targetParentID != nil {
		if *targetParentID <= 0 {
			return DriveEntry{}, ErrConflict
		}
		if *targetParentID == nodeID {
			return DriveEntry{}, ErrConflict
		}
		parent := m.doc(*targetParentID)
		if parent == nil || parent.purged || parent.deleted {
			return DriveEntry{}, ErrNotFound
		}
		if parent.meta.Kind != "folder" || parent.meta.WorkspaceID != targetWorkspaceID || parent.meta.WikiSpaceID != nil {
			return DriveEntry{}, ErrConflict
		}
		if !m.driveValidChainLocked(parent, targetWorkspaceID, false) {
			return DriveEntry{}, ErrConflict
		}
		if parent.personal != targetPersonal {
			return DriveEntry{}, ErrConflict
		}
		if RoleRank(m.roleLocked(actorID, parent)) < RoleRank(RoleEdit) {
			return DriveEntry{}, ErrForbidden
		}
		// Cycle guard: targetParentID must not be nodeID or a descendant of nodeID.
		for cur := parent; cur != nil; {
			if cur.meta.ID == nodeID {
				return DriveEntry{}, ErrConflict
			}
			if cur.meta.ParentID == nil {
				break
			}
			cur = m.doc(*cur.meta.ParentID)
		}
	}

	subtree, err := m.safeDriveSubtreeLocked(d)
	if err != nil {
		return DriveEntry{}, err
	}
	for _, item := range subtree {
		if item.driveRevision >= maxDriveRevision {
			return DriveEntry{}, ErrConflict
		}
	}
	if err := ctx.Err(); err != nil {
		return DriveEntry{}, err
	}
	if err := m.bumpSubtreePermissionRevisionLocked(nodeID, true); err != nil {
		return DriveEntry{}, err
	}

	crossSpace := targetWorkspaceID != sourceWS || targetPersonal != d.personal
	now := time.Now()
	d.meta.ParentID = cloneDriveParent(targetParentID)
	for _, item := range subtree {
		item.personal = targetPersonal
		item.meta.WorkspaceID = targetWorkspaceID
		if crossSpace {
			item.meta.WikiSpaceID = nil
			item.meta.WikiSpaceName = ""
		}
		item.driveRevision++
		item.meta.DriveRevision = item.driveRevision
		item.meta.UpdatedAt = now
	}
	m.setDocumentModifierLocked(d, actorID)

	return driveMemoryEntry(m, d, actorID), nil
}

// CrossSpaceMoveNode atomically moves nodeID and its entire descendant subtree
// across personal/shared scopes and/or across workspaces on Postgres.
func (p *Postgres) CrossSpaceMoveNode(
	ctx context.Context,
	actorID int64,
	nodeID int64,
	targetWorkspaceID int64,
	targetParentID *int64,
	targetPersonal bool,
	expectedDriveRevision int64,
) (out DriveEntry, err error) {
	if actorID <= 0 || nodeID <= 0 || targetWorkspaceID < 0 {
		return DriveEntry{}, ErrConflict
	}

	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		sourceWS, e := drivePGNodeWorkspace(ctx, tx, nodeID)
		if e != nil {
			return e
		}
		destWS := targetWorkspaceID
		if destWS == 0 {
			destWS = sourceWS
		}

		// Acquire workspace drive locks in ascending ID order to avoid lock inversion.
		if sourceWS <= destWS {
			if e = drivePGLockWorkspace(ctx, tx, sourceWS); e != nil {
				return e
			}
			if destWS != sourceWS {
				if e = drivePGLockWorkspace(ctx, tx, destWS); e != nil {
					return e
				}
			}
		} else {
			if e = drivePGLockWorkspace(ctx, tx, destWS); e != nil {
				return e
			}
			if e = drivePGLockWorkspace(ctx, tx, sourceWS); e != nil {
				return e
			}
		}

		var currentWS, rev int64
		var deleted, sourcePersonal bool
		e = tx.QueryRow(ctx,
			`SELECT workspace_id, drive_revision, deleted_at IS NOT NULL, personal
			   FROM nodes
			  WHERE id = $1 FOR UPDATE`, nodeID).
			Scan(&currentWS, &rev, &deleted, &sourcePersonal)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if currentWS != sourceWS || deleted || rev != expectedDriveRevision || rev >= maxDriveRevision {
			return ErrConflict
		}
		if e = drivePGValidChain(ctx, tx, nodeID, sourceWS); e != nil {
			return e
		}
		sourceRole, _, _, e := lockCopySource(ctx, tx, nodeID, actorID)
		if e != nil {
			return e
		}
		if RoleRank(sourceRole) < RoleRank(RoleManage) {
			return ErrForbidden
		}

		// Verify target workspace exists and actor is a valid member (not guest).
		var wsExists int
		e = tx.QueryRow(ctx, `SELECT 1 FROM workspaces WHERE id = $1 FOR SHARE`, destWS).Scan(&wsExists)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		var memberRole string
		e = tx.QueryRow(ctx,
			`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE`,
			destWS, actorID).Scan(&memberRole)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if e != nil {
			return e
		}
		if !isValidCrossSpaceMemberRole(memberRole) {
			return ErrForbidden
		}

		if targetParentID != nil {
			if *targetParentID <= 0 || *targetParentID == nodeID {
				return ErrConflict
			}
			var pKind string
			var pWS int64
			var pPersonal, pDeleted bool
			var pWiki *int64
			e = tx.QueryRow(ctx,
				`SELECT kind, workspace_id, personal, deleted_at IS NOT NULL, wiki_space_id
				   FROM nodes WHERE id = $1 FOR SHARE`, *targetParentID).
				Scan(&pKind, &pWS, &pPersonal, &pDeleted, &pWiki)
			if errors.Is(e, pgx.ErrNoRows) || (e == nil && pDeleted) {
				return ErrNotFound
			}
			if e != nil {
				return e
			}
			if pKind != "folder" || pWS != destWS || pWiki != nil || pPersonal != targetPersonal {
				return ErrConflict
			}
			if e = drivePGValidChain(ctx, tx, *targetParentID, destWS); e != nil {
				return e
			}
			parentRole, _, _, e := lockCopySource(ctx, tx, *targetParentID, actorID)
			if e != nil {
				return e
			}
			if RoleRank(parentRole) < RoleRank(RoleEdit) {
				return ErrForbidden
			}
			var cyc bool
			e = tx.QueryRow(ctx,
				`WITH RECURSIVE a AS (
					SELECT id, parent_id, ARRAY[id] AS seen FROM nodes WHERE id = $1
					UNION ALL
					SELECT n.id, n.parent_id, a.seen || n.id
					  FROM nodes n JOIN a ON n.id = a.parent_id
					 WHERE NOT n.id = ANY(a.seen)
				) SELECT EXISTS(SELECT 1 FROM a WHERE id = $2)`,
				*targetParentID, nodeID).Scan(&cyc)
			if e != nil {
				return e
			}
			if cyc {
				return ErrConflict
			}
		}

		// Collect entire subtree in breadth-first depth order (root at depth 0) and lock rows.
		rows, e := tx.Query(ctx,
			`WITH RECURSIVE sub AS (
				SELECT id, workspace_id, drive_revision, 0 AS depth, ARRAY[id] AS seen
				  FROM nodes WHERE id = $1
				UNION ALL
				SELECT n.id, n.workspace_id, n.drive_revision, sub.depth + 1, sub.seen || n.id
				  FROM nodes n JOIN sub ON n.parent_id = sub.id
				 WHERE NOT n.id = ANY(sub.seen)
			) SELECT id, workspace_id, drive_revision FROM sub ORDER BY depth ASC, id ASC`, nodeID)
		if e != nil {
			return e
		}
		var descendantIDs []int64
		for rows.Next() {
			var subID, subWS, subRev int64
			if e = rows.Scan(&subID, &subWS, &subRev); e != nil {
				rows.Close()
				return e
			}
			if subWS != sourceWS || subRev >= maxDriveRevision {
				rows.Close()
				return ErrConflict
			}
			if subID != nodeID {
				descendantIDs = append(descendantIDs, subID)
			}
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()

		if e = bumpPGSubtreePermissionsRevision(ctx, tx, nodeID, true); e != nil {
			return e
		}

		crossSpace := destWS != sourceWS || targetPersonal != sourcePersonal
		if destWS != sourceWS {
			if _, e = tx.Exec(ctx, `SET LOCAL jiange.allow_cross_workspace_move = 'on'`); e != nil {
				return e
			}
		}

		if crossSpace {
			e = tx.QueryRow(ctx,
				`UPDATE nodes
				    SET parent_id = $2,
				        workspace_id = $3,
				        personal = $4,
				        wiki_space_id = NULL,
				        drive_revision = drive_revision + 1,
				        updated_at = now()
				  WHERE id = $1
				  RETURNING id, workspace_id, parent_id, kind, doc_type, title, icon, creator_id,
				            COALESCE((SELECT u.name FROM users u WHERE u.id = nodes.creator_id), ''),
				            drive_revision, personal, created_at, updated_at`,
				nodeID, targetParentID, destWS, targetPersonal).
				Scan(&out.ID, &out.WorkspaceID, &out.ParentID, &out.Kind, &out.DocType, &out.Title, &out.Icon,
					&out.CreatorID, &out.CreatorName, &out.Revision, &out.Personal, &out.CreatedAt, &out.UpdatedAt)
		} else {
			e = tx.QueryRow(ctx,
				`UPDATE nodes
				    SET parent_id = $2,
				        drive_revision = drive_revision + 1,
				        updated_at = now()
				  WHERE id = $1
				  RETURNING id, workspace_id, parent_id, kind, doc_type, title, icon, creator_id,
				            COALESCE((SELECT u.name FROM users u WHERE u.id = nodes.creator_id), ''),
				            drive_revision, personal, created_at, updated_at`,
				nodeID, targetParentID).
				Scan(&out.ID, &out.WorkspaceID, &out.ParentID, &out.Kind, &out.DocType, &out.Title, &out.Icon,
					&out.CreatorID, &out.CreatorName, &out.Revision, &out.Personal, &out.CreatedAt, &out.UpdatedAt)
		}
		if e != nil {
			return e
		}

		// Update descendants top-down so parent workspace_id is already updated for each child.
		for _, descID := range descendantIDs {
			if crossSpace {
				_, e = tx.Exec(ctx,
					`UPDATE nodes
					    SET workspace_id = $2,
					        personal = $3,
					        wiki_space_id = NULL,
					        drive_revision = drive_revision + 1,
					        updated_at = now()
					  WHERE id = $1`,
					descID, destWS, targetPersonal)
			} else {
				_, e = tx.Exec(ctx,
					`UPDATE nodes
					    SET drive_revision = drive_revision + 1,
					        updated_at = now()
					  WHERE id = $1`,
					descID)
			}
			if e != nil {
				return e
			}
		}

		if e = recordDocumentModifier(ctx, tx, nodeID, actorID); e != nil {
			return e
		}
		if out.Kind == "doc" {
			_ = tx.QueryRow(ctx, `SELECT name FROM users WHERE id = $1`, actorID).Scan(&out.LastModifierName)
		}
		newRole, _, _, e := lockCopySource(ctx, tx, nodeID, actorID)
		if e == nil {
			out.Role = newRole
		}
		return ctx.Err()
	})
	if err != nil {
		return DriveEntry{}, drivePGError(err)
	}
	return out, nil
}

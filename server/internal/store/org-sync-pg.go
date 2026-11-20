package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func scanOrgSyncSource(row pgx.Row) (s OrgSyncSource, err error) {
	err = row.Scan(
		&s.ID, &s.WorkspaceID, &s.Name, &s.Provider, &s.Enabled, &s.TokenPrefix,
		&s.AutoInviteMissing, &s.PruneMissing, &s.LastSyncAt, &s.LastStatus, &s.LastSummary,
		&s.CreatedBy, &s.CreatedAt, &s.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return s, err
}

func (p *Postgres) ListOrgSyncState(ctx context.Context, guard RestoreGuard, wsID int64) (sources []OrgSyncSource, runs []OrgSyncRun, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		sRows, e := tx.Query(ctx, `SELECT id, workspace_id, name, provider, enabled, token_prefix,
			auto_invite_missing, prune_missing, last_sync_at, last_status, last_summary,
			created_by, created_at, updated_at
			FROM org_sync_sources WHERE workspace_id=$1 ORDER BY id`, wsID)
		if e != nil {
			return e
		}
		sources, e = pgx.CollectRows(sRows, func(r pgx.CollectableRow) (OrgSyncSource, error) {
			return scanOrgSyncSource(r)
		})
		if e != nil {
			return e
		}
		if sources == nil {
			sources = []OrgSyncSource{}
		}

		rRows, e := tx.Query(ctx, `SELECT r.id, r.workspace_id, r.source_id, COALESCE(s.name, ''), r.actor_user_id,
			r.trigger_mode, r.dry_run, r.status,
			r.departments_created, r.departments_updated, r.departments_removed,
			r.groups_created, r.groups_updated, r.groups_removed,
			r.members_linked, r.members_invited, r.memberships_updated,
			r.error_message, r.details_json, r.created_at
			FROM org_sync_runs r
			LEFT JOIN org_sync_sources s ON s.id = r.source_id
			WHERE r.workspace_id=$1
			ORDER BY r.created_at DESC, r.id DESC
			LIMIT 20`, wsID)
		if e != nil {
			return e
		}
		runs, e = pgx.CollectRows(rRows, func(row pgx.CollectableRow) (run OrgSyncRun, scanErr error) {
			var detailsRaw []byte
			scanErr = row.Scan(
				&run.ID, &run.WorkspaceID, &run.SourceID, &run.SourceName, &run.ActorUserID,
				&run.TriggerMode, &run.DryRun, &run.Status,
				&run.DepartmentsCreated, &run.DepartmentsUpdated, &run.DepartmentsRemoved,
				&run.GroupsCreated, &run.GroupsUpdated, &run.GroupsRemoved,
				&run.MembersLinked, &run.MembersInvited, &run.MembershipsUpdated,
				&run.ErrorMessage, &detailsRaw, &run.CreatedAt,
			)
			if scanErr == nil && len(detailsRaw) > 0 {
				var details struct {
					Warnings []string `json:"warnings"`
				}
				if json.Unmarshal(detailsRaw, &details) == nil && len(details.Warnings) > 0 {
					run.Warnings = details.Warnings
				}
			}
			return run, scanErr
		})
		if e != nil {
			return e
		}
		if runs == nil {
			runs = []OrgSyncRun{}
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return sources, runs, orgPGError(err)
}

func (p *Postgres) CreateOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID int64, name, provider string, autoInviteMissing, pruneMissing bool) (out OrgSyncSourceCreated, err error) {
	cleanName, ok := cleanOrgName(name)
	if !ok || !ValidOrgSyncProvider(provider) {
		return OrgSyncSourceCreated{}, ErrConflict
	}
	raw, prefix, hash, err := GenerateOrgSyncToken()
	if err != nil {
		return OrgSyncSourceCreated{}, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		src, e := scanOrgSyncSource(tx.QueryRow(ctx, `INSERT INTO org_sync_sources
			(workspace_id, name, provider, enabled, token_hash, token_prefix, auto_invite_missing, prune_missing, created_by)
			VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8)
			RETURNING id, workspace_id, name, provider, enabled, token_prefix,
			auto_invite_missing, prune_missing, last_sync_at, last_status, last_summary,
			created_by, created_at, updated_at`,
			wsID, cleanName, provider, hash, prefix, autoInviteMissing, pruneMissing, guard.UserID))
		if e != nil {
			return e
		}
		if e := drivePGEnd(ctx, guard, expires); e != nil {
			return e
		}
		out = OrgSyncSourceCreated{Source: src, Token: raw}
		return nil
	})
	return out, orgPGError(err)
}

func (p *Postgres) UpdateOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, patch OrgSyncSourcePatch) (out OrgSyncSourceCreated, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		var cur OrgSyncSource
		var curHash string
		e = tx.QueryRow(ctx, `SELECT id, workspace_id, name, provider, enabled, token_hash, token_prefix,
			auto_invite_missing, prune_missing, last_sync_at, last_status, last_summary,
			created_by, created_at, updated_at
			FROM org_sync_sources WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, sourceID, wsID).Scan(
			&cur.ID, &cur.WorkspaceID, &cur.Name, &cur.Provider, &cur.Enabled, &curHash, &cur.TokenPrefix,
			&cur.AutoInviteMissing, &cur.PruneMissing, &cur.LastSyncAt, &cur.LastStatus, &cur.LastSummary,
			&cur.CreatedBy, &cur.CreatedAt, &cur.UpdatedAt,
		)
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		if patch.Name != nil {
			cleanName, ok := cleanOrgName(*patch.Name)
			if !ok {
				return ErrConflict
			}
			cur.Name = cleanName
		}
		if patch.Enabled != nil {
			cur.Enabled = *patch.Enabled
		}
		if patch.AutoInviteMissing != nil {
			cur.AutoInviteMissing = *patch.AutoInviteMissing
		}
		if patch.PruneMissing != nil {
			cur.PruneMissing = *patch.PruneMissing
		}
		var rawToken string
		if patch.RotateToken {
			raw, prefix, hash, genErr := GenerateOrgSyncToken()
			if genErr != nil {
				return genErr
			}
			rawToken = raw
			curHash = hash
			cur.TokenPrefix = prefix
		}
		updated, e := scanOrgSyncSource(tx.QueryRow(ctx, `UPDATE org_sync_sources
			SET name=$3, enabled=$4, token_hash=$5, token_prefix=$6, auto_invite_missing=$7, prune_missing=$8, updated_at=now()
			WHERE id=$1 AND workspace_id=$2
			RETURNING id, workspace_id, name, provider, enabled, token_prefix,
			auto_invite_missing, prune_missing, last_sync_at, last_status, last_summary,
			created_by, created_at, updated_at`,
			sourceID, wsID, cur.Name, cur.Enabled, curHash, cur.TokenPrefix, cur.AutoInviteMissing, cur.PruneMissing))
		if e != nil {
			return e
		}
		if e := drivePGEnd(ctx, guard, expires); e != nil {
			return e
		}
		out = OrgSyncSourceCreated{Source: updated, Token: rawToken}
		return nil
	})
	return out, orgPGError(err)
}

func (p *Postgres) DeleteOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64) error {
	return orgPGError(pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `DELETE FROM org_sync_sources WHERE id=$1 AND workspace_id=$2`, sourceID, wsID)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return drivePGEnd(ctx, guard, expires)
	}))
}

func (p *Postgres) RunOrgDirectorySyncGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, payload OrgDirectorySyncPayload) (out OrgSyncRun, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		src, e := scanOrgSyncSource(tx.QueryRow(ctx, `SELECT id, workspace_id, name, provider, enabled, token_prefix,
			auto_invite_missing, prune_missing, last_sync_at, last_status, last_summary,
			created_by, created_at, updated_at
			FROM org_sync_sources WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, sourceID, wsID))
		if e != nil {
			return e
		}
		actor := guard.UserID
		out, e = p.applyOrgSyncTx(ctx, tx, src, &actor, OrgSyncTriggerManual, payload)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) PushOrgDirectorySyncByToken(ctx context.Context, tokenHash, triggerMode string, payload OrgDirectorySyncPayload) (out OrgSyncRun, err error) {
	if tokenHash == "" {
		return OrgSyncRun{}, ErrUnauthenticated
	}
	if triggerMode != OrgSyncTriggerPush && triggerMode != OrgSyncTriggerSCIM {
		triggerMode = OrgSyncTriggerPush
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		src, e := scanOrgSyncSource(tx.QueryRow(ctx, `SELECT id, workspace_id, name, provider, enabled, token_prefix,
			auto_invite_missing, prune_missing, last_sync_at, last_status, last_summary,
			created_by, created_at, updated_at
			FROM org_sync_sources WHERE token_hash=$1 FOR UPDATE`, tokenHash))
		if e != nil {
			if errors.Is(e, ErrNotFound) {
				return ErrUnauthenticated
			}
			return e
		}
		if !src.Enabled {
			return ErrForbidden
		}
		out, e = p.applyOrgSyncTx(ctx, tx, src, nil, triggerMode, payload)
		return e
	})
	return out, orgPGError(err)
}

func (p *Postgres) applyOrgSyncTx(ctx context.Context, tx pgx.Tx, src OrgSyncSource, actorID *int64, triggerMode string, payload OrgDirectorySyncPayload) (OrgSyncRun, error) {
	validated, errMsg, valErr := validateAndSortOrgSyncPayload(payload)
	if valErr != nil {
		run := OrgSyncRun{
			WorkspaceID:  src.WorkspaceID,
			SourceID:     src.ID,
			SourceName:   src.Name,
			ActorUserID:  actorID,
			TriggerMode:  triggerMode,
			DryRun:       payload.DryRun,
			Status:       "failed",
			ErrorMessage: errMsg,
			CreatedAt:    time.Now().UTC(),
		}
		// Record failed run outside rollback only if caller wants audit; return ErrConflict.
		return run, valErr
	}

	pruneMissing := src.PruneMissing
	if payload.PruneMissing != nil {
		pruneMissing = *payload.PruneMissing
	}

	run := OrgSyncRun{
		WorkspaceID: src.WorkspaceID,
		SourceID:    src.ID,
		SourceName:  src.Name,
		ActorUserID: actorID,
		TriggerMode: triggerMode,
		DryRun:      payload.DryRun,
		Status:      "ok",
	}
	addWarning := func(w string) {
		if len(run.Warnings) < 20 {
			run.Warnings = append(run.Warnings, w)
		}
	}

	// Load existing departments owned by this sync source.
	type existingDept struct {
		id        int64
		parentID  *int64
		name      string
		sortOrder int
	}
	extToDept := map[string]existingDept{}
	dRows, err := tx.Query(ctx, `SELECT id, parent_id, name, sort_order, external_id
		FROM org_departments
		WHERE workspace_id=$1 AND sync_source_id=$2 AND external_id IS NOT NULL
		ORDER BY id FOR UPDATE`, src.WorkspaceID, src.ID)
	if err != nil {
		return OrgSyncRun{}, err
	}
	for dRows.Next() {
		var ed existingDept
		var extID string
		if err := dRows.Scan(&ed.id, &ed.parentID, &ed.name, &ed.sortOrder, &extID); err != nil {
			dRows.Close()
			return OrgSyncRun{}, err
		}
		extToDept[extID] = ed
	}
	if err := dRows.Err(); err != nil {
		dRows.Close()
		return OrgSyncRun{}, err
	}
	dRows.Close()

	resolvedDeptID := make(map[string]int64, len(validated.departments))
	var nextDryID int64 = -1
	changedDeptIDs := map[int64]bool{}
	for _, in := range validated.departments {
		var wantParent *int64
		if in.ParentExternalID != "" {
			pid := resolvedDeptID[in.ParentExternalID]
			wantParent = &pid
		}
		if cur, ok := extToDept[in.ExternalID]; ok {
			sameParent := (cur.parentID == nil && wantParent == nil) || (cur.parentID != nil && wantParent != nil && *cur.parentID == *wantParent)
			if cur.name != in.Name || cur.sortOrder != in.SortOrder || !sameParent {
				run.DepartmentsUpdated++
				changedDeptIDs[cur.id] = true
				if !payload.DryRun {
					if _, err := tx.Exec(ctx, `UPDATE org_departments SET parent_id=$2, name=$3, sort_order=$4, updated_at=now() WHERE id=$1`,
						cur.id, wantParent, in.Name, in.SortOrder); err != nil {
						return OrgSyncRun{}, err
					}
				}
			}
			resolvedDeptID[in.ExternalID] = cur.id
		} else {
			run.DepartmentsCreated++
			if !payload.DryRun {
				var newID int64
				if err := tx.QueryRow(ctx, `INSERT INTO org_departments (workspace_id, parent_id, name, sort_order, sync_source_id, external_id)
					VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
					src.WorkspaceID, wantParent, in.Name, in.SortOrder, src.ID, in.ExternalID).Scan(&newID); err != nil {
					return OrgSyncRun{}, err
				}
				resolvedDeptID[in.ExternalID] = newID
				changedDeptIDs[newID] = true
			} else {
				resolvedDeptID[in.ExternalID] = nextDryID
				nextDryID--
			}
		}
	}

	if pruneMissing {
		for extID, cur := range extToDept {
			if validated.deptSet[extID] {
				continue
			}
			run.DepartmentsRemoved++
			changedDeptIDs[cur.id] = true
			if !payload.DryRun {
				if _, err := tx.Exec(ctx, `DELETE FROM node_subject_shares WHERE subject_type='department' AND subject_id=$1`, cur.id); err != nil {
					return OrgSyncRun{}, err
				}
				if _, err := tx.Exec(ctx, `DELETE FROM wiki_space_grants WHERE subject_type='department' AND subject_id=$1`, cur.id); err != nil {
					return OrgSyncRun{}, err
				}
				if _, err := tx.Exec(ctx, `DELETE FROM org_departments WHERE id=$1`, cur.id); err != nil {
					return OrgSyncRun{}, err
				}
			}
		}
	}

	// Load existing groups owned by this sync source.
	type existingGroup struct {
		id          int64
		name        string
		description string
	}
	extToGroup := map[string]existingGroup{}
	gRows, err := tx.Query(ctx, `SELECT id, name, description, external_id
		FROM org_groups
		WHERE workspace_id=$1 AND sync_source_id=$2 AND external_id IS NOT NULL
		ORDER BY id FOR UPDATE`, src.WorkspaceID, src.ID)
	if err != nil {
		return OrgSyncRun{}, err
	}
	for gRows.Next() {
		var eg existingGroup
		var extID string
		if err := gRows.Scan(&eg.id, &eg.name, &eg.description, &extID); err != nil {
			gRows.Close()
			return OrgSyncRun{}, err
		}
		extToGroup[extID] = eg
	}
	if err := gRows.Err(); err != nil {
		gRows.Close()
		return OrgSyncRun{}, err
	}
	gRows.Close()

	resolvedGroupID := make(map[string]int64, len(validated.groups))
	changedGroupIDs := map[int64]bool{}
	for _, in := range validated.groups {
		if cur, ok := extToGroup[in.ExternalID]; ok {
			if cur.name != in.Name || cur.description != in.Description {
				run.GroupsUpdated++
				if !payload.DryRun {
					if _, err := tx.Exec(ctx, `UPDATE org_groups SET name=$2, description=$3, updated_at=now() WHERE id=$1`,
						cur.id, in.Name, in.Description); err != nil {
						return OrgSyncRun{}, err
					}
				}
			}
			resolvedGroupID[in.ExternalID] = cur.id
		} else {
			run.GroupsCreated++
			if !payload.DryRun {
				var newID int64
				if err := tx.QueryRow(ctx, `INSERT INTO org_groups (workspace_id, name, description, sync_source_id, external_id)
					VALUES ($1, $2, $3, $4, $5) RETURNING id`,
					src.WorkspaceID, in.Name, in.Description, src.ID, in.ExternalID).Scan(&newID); err != nil {
					return OrgSyncRun{}, err
				}
				resolvedGroupID[in.ExternalID] = newID
			} else {
				resolvedGroupID[in.ExternalID] = nextDryID
				nextDryID--
			}
		}
	}

	if pruneMissing {
		for extID, cur := range extToGroup {
			if validated.groupSet[extID] {
				continue
			}
			run.GroupsRemoved++
			changedGroupIDs[cur.id] = true
			if !payload.DryRun {
				if _, err := tx.Exec(ctx, `DELETE FROM node_subject_shares WHERE subject_type='group' AND subject_id=$1`, cur.id); err != nil {
					return OrgSyncRun{}, err
				}
				if _, err := tx.Exec(ctx, `DELETE FROM wiki_space_grants WHERE subject_type='group' AND subject_id=$1`, cur.id); err != nil {
					return OrgSyncRun{}, err
				}
				if _, err := tx.Exec(ctx, `DELETE FROM org_groups WHERE id=$1`, cur.id); err != nil {
					return OrgSyncRun{}, err
				}
			}
		}
	}

	// Load workspace members by email.
	type wsMem struct {
		uid  int64
		role string
	}
	wsByEmail := map[string]wsMem{}
	mRows, err := tx.Query(ctx, `SELECT u.id, lower(btrim(u.email)), wm.role
		FROM workspace_members wm
		JOIN users u ON u.id = wm.user_id
		WHERE wm.workspace_id=$1`, src.WorkspaceID)
	if err != nil {
		return OrgSyncRun{}, err
	}
	for mRows.Next() {
		var uid int64
		var email, role string
		if err := mRows.Scan(&uid, &email, &role); err != nil {
			mRows.Close()
			return OrgSyncRun{}, err
		}
		wsByEmail[email] = wsMem{uid: uid, role: role}
	}
	if err := mRows.Err(); err != nil {
		mRows.Close()
		return OrgSyncRun{}, err
	}
	mRows.Close()

	// Load pending invitations for workspace.
	pendingInvites := map[string]bool{}
	invRows, err := tx.Query(ctx, `SELECT lower(email) FROM workspace_invitations WHERE workspace_id=$1`, src.WorkspaceID)
	if err != nil {
		return OrgSyncRun{}, err
	}
	for invRows.Next() {
		var em string
		if err := invRows.Scan(&em); err != nil {
			invRows.Close()
			return OrgSyncRun{}, err
		}
		pendingInvites[em] = true
	}
	if err := invRows.Err(); err != nil {
		invRows.Close()
		return OrgSyncRun{}, err
	}
	invRows.Close()
	pendingCount := len(pendingInvites)

	// Load current synced department & group memberships for managed IDs.
	managedDeptIDs := make([]int64, 0, len(resolvedDeptID))
	for _, id := range resolvedDeptID {
		if id > 0 {
			managedDeptIDs = append(managedDeptIDs, id)
		}
	}
	curDeptMem := map[int64]map[int64]bool{} // uid -> deptID -> isLeader
	if len(managedDeptIDs) > 0 {
		rows, err := tx.Query(ctx, `SELECT department_id, user_id, is_leader FROM org_department_members WHERE department_id = ANY($1)`, managedDeptIDs)
		if err != nil {
			return OrgSyncRun{}, err
		}
		for rows.Next() {
			var did, uid int64
			var leader bool
			if err := rows.Scan(&did, &uid, &leader); err != nil {
				rows.Close()
				return OrgSyncRun{}, err
			}
			if curDeptMem[uid] == nil {
				curDeptMem[uid] = map[int64]bool{}
			}
			curDeptMem[uid][did] = leader
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return OrgSyncRun{}, err
		}
		rows.Close()
	}

	managedGroupIDs := make([]int64, 0, len(resolvedGroupID))
	for _, id := range resolvedGroupID {
		if id > 0 {
			managedGroupIDs = append(managedGroupIDs, id)
		}
	}
	curGroupMem := map[int64]map[int64]bool{} // uid -> groupID -> true
	if len(managedGroupIDs) > 0 {
		rows, err := tx.Query(ctx, `SELECT group_id, user_id FROM org_group_members WHERE group_id = ANY($1)`, managedGroupIDs)
		if err != nil {
			return OrgSyncRun{}, err
		}
		for rows.Next() {
			var gid, uid int64
			if err := rows.Scan(&gid, &uid); err != nil {
				rows.Close()
				return OrgSyncRun{}, err
			}
			if curGroupMem[uid] == nil {
				curGroupMem[uid] = map[int64]bool{}
			}
			curGroupMem[uid][gid] = true
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return OrgSyncRun{}, err
		}
		rows.Close()
	}

	inviterID := src.CreatedBy
	if actorID != nil {
		inviterID = *actorID
	}

	seenMemberUIDs := map[int64]bool{}
	for _, mem := range validated.members {
		wm, inWS := wsByEmail[mem.Email]
		if !inWS {
			if src.AutoInviteMissing {
				if !pendingInvites[mem.Email] {
					if pendingCount >= maxPendingInvitations {
						addWarning("待接受邀请已达上限，部分新邮箱未创建邀请")
						continue
					}
					run.MembersInvited++
					pendingCount++
					pendingInvites[mem.Email] = true
					if !payload.DryRun {
						invRole := mem.Role
						if invRole == "" {
							invRole = WorkspaceRoleMember
						}
						if _, err := tx.Exec(ctx, `INSERT INTO workspace_invitations (workspace_id, email, role, inviter_id)
							VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, email) DO NOTHING`,
							src.WorkspaceID, mem.Email, invRole, inviterID); err != nil {
							return OrgSyncRun{}, err
						}
					}
				}
			} else {
				addWarning("未加入空间成员已跳过：" + mem.Email)
			}
			continue
		}

		seenMemberUIDs[wm.uid] = true
		run.MembersLinked++
		if mem.Role != "" && wm.role != WorkspaceRoleOwner && wm.role != mem.Role {
			run.MembershipsUpdated++
			if !payload.DryRun {
				if _, err := tx.Exec(ctx, `UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2`,
					src.WorkspaceID, wm.uid, mem.Role); err != nil {
					return OrgSyncRun{}, err
				}
			}
		}

		wantDeptLeader := map[int64]bool{}
		for _, extID := range mem.DepartmentExternalIDs {
			wantDeptLeader[resolvedDeptID[extID]] = containsString(mem.LeaderDepartmentExternalIDs, extID)
		}
		existingDepts := curDeptMem[wm.uid]
		for did, wantLeader := range wantDeptLeader {
			if did < 0 {
				run.MembershipsUpdated++
				continue
			}
			curLeader, exists := existingDepts[did]
			if !exists || curLeader != wantLeader {
				run.MembershipsUpdated++
				changedDeptIDs[did] = true
				if !payload.DryRun {
					if _, err := tx.Exec(ctx, `INSERT INTO org_department_members (department_id, user_id, is_leader)
						VALUES ($1, $2, $3)
						ON CONFLICT (department_id, user_id) DO UPDATE SET is_leader = EXCLUDED.is_leader`,
						did, wm.uid, wantLeader); err != nil {
						return OrgSyncRun{}, err
					}
				}
			}
		}
		for did := range existingDepts {
			if _, wanted := wantDeptLeader[did]; wanted {
				continue
			}
			run.MembershipsUpdated++
			changedDeptIDs[did] = true
			if !payload.DryRun {
				if _, err := tx.Exec(ctx, `DELETE FROM org_department_members WHERE department_id=$1 AND user_id=$2`, did, wm.uid); err != nil {
					return OrgSyncRun{}, err
				}
			}
		}

		wantGroups := map[int64]bool{}
		for _, extID := range mem.GroupExternalIDs {
			wantGroups[resolvedGroupID[extID]] = true
		}
		existingGroups := curGroupMem[wm.uid]
		for gid := range wantGroups {
			if gid < 0 {
				run.MembershipsUpdated++
				continue
			}
			if !existingGroups[gid] {
				run.MembershipsUpdated++
				changedGroupIDs[gid] = true
				if !payload.DryRun {
					if _, err := tx.Exec(ctx, `INSERT INTO org_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, gid, wm.uid); err != nil {
						return OrgSyncRun{}, err
					}
				}
			}
		}
		for gid := range existingGroups {
			if wantGroups[gid] {
				continue
			}
			run.MembershipsUpdated++
			changedGroupIDs[gid] = true
			if !payload.DryRun {
				if _, err := tx.Exec(ctx, `DELETE FROM org_group_members WHERE group_id=$1 AND user_id=$2`, gid, wm.uid); err != nil {
					return OrgSyncRun{}, err
				}
			}
		}
	}

	if pruneMissing {
		for uid, depts := range curDeptMem {
			if seenMemberUIDs[uid] {
				continue
			}
			for did := range depts {
				run.MembershipsUpdated++
				changedDeptIDs[did] = true
				if !payload.DryRun {
					if _, err := tx.Exec(ctx, `DELETE FROM org_department_members WHERE department_id=$1 AND user_id=$2`, did, uid); err != nil {
						return OrgSyncRun{}, err
					}
				}
			}
		}
		for uid, groups := range curGroupMem {
			if seenMemberUIDs[uid] {
				continue
			}
			for gid := range groups {
				run.MembershipsUpdated++
				changedGroupIDs[gid] = true
				if !payload.DryRun {
					if _, err := tx.Exec(ctx, `DELETE FROM org_group_members WHERE group_id=$1 AND user_id=$2`, gid, uid); err != nil {
						return OrgSyncRun{}, err
					}
				}
			}
		}
	}

	// Bump permissions_revision on nodes shared with modified departments/groups so active editors revalidate.
	if !payload.DryRun && (len(changedDeptIDs) > 0 || len(changedGroupIDs) > 0) {
		deptSlice := make([]int64, 0, len(changedDeptIDs))
		for id := range changedDeptIDs {
			if id > 0 {
				deptSlice = append(deptSlice, id)
			}
		}
		groupSlice := make([]int64, 0, len(changedGroupIDs))
		for id := range changedGroupIDs {
			if id > 0 {
				groupSlice = append(groupSlice, id)
			}
		}
		if len(deptSlice) > 0 {
			if _, err := tx.Exec(ctx, `UPDATE nodes SET permissions_revision = permissions_revision + 1
				WHERE id IN (
					SELECT DISTINCT a.node_id
					FROM node_subject_shares ss
					JOIN node_acl_ancestors a ON a.ancestor_id = ss.doc_id
					WHERE ss.subject_type = 'department'
					  AND ss.subject_id IN (SELECT ancestor_id FROM org_department_closure WHERE descendant_id = ANY($1))
				)`, deptSlice); err != nil {
				return OrgSyncRun{}, err
			}
		}
		if len(groupSlice) > 0 {
			if _, err := tx.Exec(ctx, `UPDATE nodes SET permissions_revision = permissions_revision + 1
				WHERE id IN (
					SELECT DISTINCT a.node_id
					FROM node_subject_shares ss
					JOIN node_acl_ancestors a ON a.ancestor_id = ss.doc_id
					WHERE ss.subject_type = 'group' AND ss.subject_id = ANY($1)
				)`, groupSlice); err != nil {
				return OrgSyncRun{}, err
			}
		}
	}

	detailsBytes, _ := json.Marshal(map[string]any{"warnings": run.Warnings})
	if err := tx.QueryRow(ctx, `INSERT INTO org_sync_runs (
		workspace_id, source_id, actor_user_id, trigger_mode, dry_run, status,
		departments_created, departments_updated, departments_removed,
		groups_created, groups_updated, groups_removed,
		members_linked, members_invited, memberships_updated,
		error_message, details_json
	) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
	RETURNING id, created_at`,
		run.WorkspaceID, run.SourceID, run.ActorUserID, run.TriggerMode, run.DryRun, run.Status,
		run.DepartmentsCreated, run.DepartmentsUpdated, run.DepartmentsRemoved,
		run.GroupsCreated, run.GroupsUpdated, run.GroupsRemoved,
		run.MembersLinked, run.MembersInvited, run.MembershipsUpdated,
		strings.TrimSpace(run.ErrorMessage), detailsBytes,
	).Scan(&run.ID, &run.CreatedAt); err != nil {
		return OrgSyncRun{}, err
	}

	if !payload.DryRun {
		if _, err := tx.Exec(ctx, `UPDATE org_sync_sources
			SET last_sync_at=now(), last_status=$2, last_summary=$3, updated_at=now()
			WHERE id=$1`, src.ID, run.Status, orgSyncRunSummary(run)); err != nil {
			return OrgSyncRun{}, err
		}
	}
	return run, nil
}

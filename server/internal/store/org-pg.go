package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func orgPGError(err error) error {
	var pgErr *pgconn.PgError
	if retryableRestoreConflict(err) || (errors.As(err, &pgErr) && (pgErr.Code == "23514" || pgErr.Code == "23505")) {
		return ErrConflict
	}
	return err
}

func orgPGSessionAndMember(ctx context.Context, tx pgx.Tx, guard RestoreGuard, wsID int64) (time.Time, string, string, error) {
	if wsID <= 0 {
		return time.Time{}, "", "", ErrNotFound
	}
	expires, err := drivePGSession(ctx, tx, guard)
	if err != nil {
		return time.Time{}, "", "", err
	}
	var wsName string
	if err := tx.QueryRow(ctx, `SELECT name FROM workspaces WHERE id=$1 FOR SHARE`, wsID).Scan(&wsName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return time.Time{}, "", "", ErrNotFound
		}
		return time.Time{}, "", "", err
	}
	var role string
	if err := tx.QueryRow(ctx, `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, wsID, guard.UserID).Scan(&role); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return time.Time{}, "", "", ErrForbidden
		}
		return time.Time{}, "", "", err
	}
	return expires, wsName, role, nil
}

func orgPGRequireAdmin(ctx context.Context, tx pgx.Tx, guard RestoreGuard, wsID int64) (time.Time, error) {
	expires, _, role, err := orgPGSessionAndMember(ctx, tx, guard, wsID)
	if err != nil {
		return time.Time{}, err
	}
	if !isWorkspaceAdminRole(role) {
		return time.Time{}, ErrForbidden
	}
	return expires, nil
}

func (p *Postgres) GetWorkspaceOrg(ctx context.Context, guard RestoreGuard, wsID int64) (out WorkspaceOrgSnapshot, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, wsName, callerRole, e := orgPGSessionAndMember(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		out = WorkspaceOrgSnapshot{
			WorkspaceID:   wsID,
			WorkspaceName: wsName,
			CallerRole:    callerRole,
			Members:       []WorkspaceMemberInfo{},
			Departments:   []OrgDepartment{},
			Groups:        []OrgGroup{},
		}

		mRows, e := tx.Query(ctx, `SELECT u.id, u.email, u.name, wm.role, u.created_at
			FROM workspace_members wm
			JOIN users u ON u.id = wm.user_id
			WHERE wm.workspace_id=$1
			ORDER BY u.id`, wsID)
		if e != nil {
			return e
		}
		out.Members, e = pgx.CollectRows(mRows, func(r pgx.CollectableRow) (m WorkspaceMemberInfo, err error) {
			err = r.Scan(&m.UserID, &m.Email, &m.Name, &m.Role, &m.CreatedAt)
			return
		})
		if e != nil {
			return e
		}

		dRows, e := tx.Query(ctx, `SELECT id, workspace_id, parent_id, name, sort_order, sync_source_id, COALESCE(external_id, ''), created_at, updated_at
			FROM org_departments
			WHERE workspace_id=$1
			ORDER BY sort_order, id`, wsID)
		if e != nil {
			return e
		}
		depts, e := pgx.CollectRows(dRows, func(r pgx.CollectableRow) (d OrgDepartment, err error) {
			d.Members = []OrgDepartmentMember{}
			err = r.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Name, &d.SortOrder, &d.SyncSourceID, &d.ExternalID, &d.CreatedAt, &d.UpdatedAt)
			return
		})
		if e != nil {
			return e
		}
		deptIdx := make(map[int64]int, len(depts))
		for i := range depts {
			deptIdx[depts[i].ID] = i
		}
		dmRows, e := tx.Query(ctx, `SELECT dm.department_id, u.id, u.name, u.email, dm.is_leader
			FROM org_department_members dm
			JOIN org_departments d ON d.id = dm.department_id
			JOIN users u ON u.id = dm.user_id
			WHERE d.workspace_id=$1
			ORDER BY dm.is_leader DESC, u.id`, wsID)
		if e != nil {
			return e
		}
		for dmRows.Next() {
			var deptID int64
			var mem OrgDepartmentMember
			if e = dmRows.Scan(&deptID, &mem.UserID, &mem.Name, &mem.Email, &mem.IsLeader); e != nil {
				dmRows.Close()
				return e
			}
			if idx, ok := deptIdx[deptID]; ok {
				depts[idx].Members = append(depts[idx].Members, mem)
			}
		}
		if e = dmRows.Err(); e != nil {
			dmRows.Close()
			return e
		}
		dmRows.Close()
		out.Departments = depts

		gRows, e := tx.Query(ctx, `SELECT id, workspace_id, name, description, sync_source_id, COALESCE(external_id, ''), created_at, updated_at
			FROM org_groups
			WHERE workspace_id=$1
			ORDER BY id`, wsID)
		if e != nil {
			return e
		}
		groups, e := pgx.CollectRows(gRows, func(r pgx.CollectableRow) (g OrgGroup, err error) {
			g.Members = []OrgGroupMember{}
			err = r.Scan(&g.ID, &g.WorkspaceID, &g.Name, &g.Description, &g.SyncSourceID, &g.ExternalID, &g.CreatedAt, &g.UpdatedAt)
			return
		})
		if e != nil {
			return e
		}
		groupIdx := make(map[int64]int, len(groups))
		for i := range groups {
			groupIdx[groups[i].ID] = i
		}
		gmRows, e := tx.Query(ctx, `SELECT gm.group_id, u.id, u.name, u.email
			FROM org_group_members gm
			JOIN org_groups g ON g.id = gm.group_id
			JOIN users u ON u.id = gm.user_id
			WHERE g.workspace_id=$1
			ORDER BY u.id`, wsID)
		if e != nil {
			return e
		}
		for gmRows.Next() {
			var groupID int64
			var mem OrgGroupMember
			if e = gmRows.Scan(&groupID, &mem.UserID, &mem.Name, &mem.Email); e != nil {
				gmRows.Close()
				return e
			}
			if idx, ok := groupIdx[groupID]; ok {
				groups[idx].Members = append(groups[idx].Members, mem)
			}
		}
		if e = gmRows.Err(); e != nil {
			gmRows.Close()
			return e
		}
		gmRows.Close()
		out.Groups = groups

		out.Invitations = []WorkspaceInvitation{}
		if isWorkspaceAdminRole(callerRole) {
			if out.Invitations, e = pgPendingInvitations(ctx, tx, wsID); e != nil {
				return e
			}
		}

		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) UpsertWorkspaceMemberGuarded(ctx context.Context, guard RestoreGuard, wsID int64, rawEmail, role string) (out WorkspaceMemberChange, err error) {
	email, ok := NormalizeInviteEmail(rawEmail)
	if !ok || (role != WorkspaceRoleMember && role != WorkspaceRoleAdmin && role != "remove") {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		// Serialize invitation writes per workspace so the pending cap holds.
		if _, e = tx.Exec(ctx, `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, wsID); e != nil {
			return e
		}
		// Only an existing member is resolved to an account; anyone else is
		// addressed purely by email so the response reveals no account data.
		var target WorkspaceMemberInfo
		e = tx.QueryRow(ctx, `SELECT u.id, u.email, u.name, u.created_at FROM workspace_members wm JOIN users u ON u.id = wm.user_id
			WHERE wm.workspace_id=$1 AND lower(u.email)=$2 FOR SHARE OF wm`, wsID, email).
			Scan(&target.UserID, &target.Email, &target.Name, &target.CreatedAt)
		isMember := e == nil
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if isMember {
			var ownerID int64
			if e = tx.QueryRow(ctx, `SELECT owner_id FROM workspaces WHERE id=$1`, wsID).Scan(&ownerID); e != nil {
				return e
			}
			if ownerID == target.UserID {
				return ErrForbidden
			}
		}
		if role == "remove" {
			if _, e = tx.Exec(ctx, `DELETE FROM workspace_invitations WHERE workspace_id=$1 AND email=$2`, wsID, email); e != nil {
				return e
			}
			if isMember {
				if _, e = tx.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, wsID, target.UserID); e != nil {
					return e
				}
				if _, e = tx.Exec(ctx, `DELETE FROM org_department_members WHERE department_id IN (SELECT id FROM org_departments WHERE workspace_id=$1) AND user_id=$2`, wsID, target.UserID); e != nil {
					return e
				}
				if _, e = tx.Exec(ctx, `DELETE FROM org_group_members WHERE group_id IN (SELECT id FROM org_groups WHERE workspace_id=$1) AND user_id=$2`, wsID, target.UserID); e != nil {
					return e
				}
				if _, e = tx.Exec(ctx, `DELETE FROM wiki_space_grants WHERE space_id IN (SELECT id FROM wiki_spaces WHERE workspace_id=$1) AND subject_type='user' AND subject_id=$2`, wsID, target.UserID); e != nil {
					return e
				}
			}
			out = WorkspaceMemberChange{Status: MemberChangeRemoved}
			return drivePGEnd(ctx, guard, expires)
		}
		if isMember {
			if _, e = tx.Exec(ctx, `UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2`, wsID, target.UserID, role); e != nil {
				return e
			}
			target.Role = role
			out = WorkspaceMemberChange{Status: MemberChangeUpdated, Member: &target}
			return drivePGEnd(ctx, guard, expires)
		}
		var pending int
		var exists bool
		if e = tx.QueryRow(ctx, `SELECT count(*), COALESCE(bool_or(email=$2), false) FROM workspace_invitations WHERE workspace_id=$1`, wsID, email).Scan(&pending, &exists); e != nil {
			return e
		}
		if !exists && pending >= maxPendingInvitations {
			return ErrConflict
		}
		inv := WorkspaceInvitation{WorkspaceID: wsID, Email: email, Role: role}
		if e = tx.QueryRow(ctx, `INSERT INTO workspace_invitations (workspace_id, email, role, inviter_id) VALUES ($1,$2,$3,$4)
			ON CONFLICT (workspace_id, email) DO UPDATE SET role=EXCLUDED.role, inviter_id=EXCLUDED.inviter_id
			RETURNING id, created_at, (SELECT name FROM users WHERE id=$4), (SELECT name FROM workspaces WHERE id=$1)`,
			wsID, email, role, guard.UserID).Scan(&inv.ID, &inv.CreatedAt, &inv.InviterName, &inv.WorkspaceName); e != nil {
			return e
		}
		out = WorkspaceMemberChange{Status: MemberChangeInvited, Invitation: &inv}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func pgPendingInvitations(ctx context.Context, tx pgx.Tx, wsID int64) ([]WorkspaceInvitation, error) {
	rows, err := tx.Query(ctx, `SELECT i.id, i.workspace_id, i.email, i.role, COALESCE(u.name,''), i.created_at
		FROM workspace_invitations i LEFT JOIN users u ON u.id = i.inviter_id
		WHERE i.workspace_id=$1 ORDER BY i.id`, wsID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (inv WorkspaceInvitation, err error) {
		err = r.Scan(&inv.ID, &inv.WorkspaceID, &inv.Email, &inv.Role, &inv.InviterName, &inv.CreatedAt)
		return
	})
}

func (p *Postgres) RevokeInvitationGuarded(ctx context.Context, guard RestoreGuard, wsID, invitationID int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `DELETE FROM workspace_invitations WHERE id=$1 AND workspace_id=$2`, invitationID, wsID)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return orgPGError(err)
}

func (p *Postgres) ListMyInvitations(ctx context.Context, guard RestoreGuard) (out []WorkspaceInvitation, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `SELECT i.id, i.workspace_id, w.name, i.email, i.role, COALESCE(inviter.name,''), i.created_at
			FROM workspace_invitations i
			JOIN users me ON me.id=$1 AND lower(me.email)=i.email
			JOIN workspaces w ON w.id = i.workspace_id
			LEFT JOIN users inviter ON inviter.id = i.inviter_id
			ORDER BY i.id`, guard.UserID)
		if e != nil {
			return e
		}
		out, e = pgx.CollectRows(rows, func(r pgx.CollectableRow) (inv WorkspaceInvitation, err error) {
			err = r.Scan(&inv.ID, &inv.WorkspaceID, &inv.WorkspaceName, &inv.Email, &inv.Role, &inv.InviterName, &inv.CreatedAt)
			return
		})
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	if out == nil {
		out = []WorkspaceInvitation{}
	}
	return out, orgPGError(err)
}

func (p *Postgres) RespondInvitationGuarded(ctx context.Context, guard RestoreGuard, invitationID int64, accept bool) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		var wsID int64
		var role string
		// Another account's invitation is indistinguishable from a missing one.
		e = tx.QueryRow(ctx, `DELETE FROM workspace_invitations i USING users me
			WHERE i.id=$1 AND me.id=$2 AND lower(me.email)=i.email
			RETURNING i.workspace_id, i.role`, invitationID, guard.UserID).Scan(&wsID, &role)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if accept {
			if _, e = tx.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO NOTHING`, wsID, guard.UserID, role); e != nil {
				return e
			}
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return orgPGError(err)
}

func (p *Postgres) CreateDepartmentGuarded(ctx context.Context, guard RestoreGuard, wsID int64, parentID *int64, rawName string, sortOrder int) (out OrgDepartment, err error) {
	name, ok := cleanOrgName(rawName)
	if !ok {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		if parentID != nil {
			var pws int64
			e = tx.QueryRow(ctx, `SELECT workspace_id FROM org_departments WHERE id=$1 FOR SHARE`, *parentID).Scan(&pws)
			if errors.Is(e, pgx.ErrNoRows) || (e == nil && pws != wsID) {
				return ErrNotFound
			}
			if e != nil {
				return e
			}
		}
		out.Members = []OrgDepartmentMember{}
		if e = tx.QueryRow(ctx, `INSERT INTO org_departments (workspace_id, parent_id, name, sort_order) VALUES ($1,$2,$3,$4)
			RETURNING id, workspace_id, parent_id, name, sort_order, created_at, updated_at`,
			wsID, parentID, name, sortOrder).Scan(&out.ID, &out.WorkspaceID, &out.ParentID, &out.Name, &out.SortOrder, &out.CreatedAt, &out.UpdatedAt); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) UpdateDepartmentGuarded(ctx context.Context, guard RestoreGuard, wsID, deptID int64, parentID *int64, moveParent bool, rawName *string, sortOrder *int) (out OrgDepartment, err error) {
	var cleanName string
	if rawName != nil {
		var ok bool
		cleanName, ok = cleanOrgName(*rawName)
		if !ok {
			return out, ErrConflict
		}
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		var dws int64
		var curParent *int64
		var curName string
		var curSort int
		e = tx.QueryRow(ctx, `SELECT workspace_id, parent_id, name, sort_order FROM org_departments WHERE id=$1 FOR UPDATE`, deptID).
			Scan(&dws, &curParent, &curName, &curSort)
		if errors.Is(e, pgx.ErrNoRows) || (e == nil && dws != wsID) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if moveParent {
			if parentID != nil {
				var pws int64
				e = tx.QueryRow(ctx, `SELECT workspace_id FROM org_departments WHERE id=$1 FOR SHARE`, *parentID).Scan(&pws)
				if errors.Is(e, pgx.ErrNoRows) || (e == nil && pws != wsID) {
					return ErrNotFound
				}
				if e != nil {
					return e
				}
				var cycle bool
				e = tx.QueryRow(ctx, `WITH RECURSIVE a AS (
					SELECT id, parent_id, ARRAY[id] AS seen FROM org_departments WHERE id=$1
					UNION ALL
					SELECT d.id, d.parent_id, a.seen || d.id FROM org_departments d JOIN a ON d.id = a.parent_id WHERE NOT d.id = ANY(a.seen)
				) SELECT EXISTS(SELECT 1 FROM a WHERE id=$2)`, *parentID, deptID).Scan(&cycle)
				if e != nil {
					return e
				}
				if cycle {
					return ErrConflict
				}
			}
			curParent = parentID
		}
		if rawName != nil {
			curName = cleanName
		}
		if sortOrder != nil {
			curSort = *sortOrder
		}
		if e = tx.QueryRow(ctx, `UPDATE org_departments SET parent_id=$2, name=$3, sort_order=$4, updated_at=now() WHERE id=$1
			RETURNING id, workspace_id, parent_id, name, sort_order, created_at, updated_at`,
			deptID, curParent, curName, curSort).Scan(&out.ID, &out.WorkspaceID, &out.ParentID, &out.Name, &out.SortOrder, &out.CreatedAt, &out.UpdatedAt); e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `SELECT u.id, u.name, u.email, dm.is_leader
			FROM org_department_members dm JOIN users u ON u.id = dm.user_id
			WHERE dm.department_id=$1 ORDER BY dm.is_leader DESC, u.id`, deptID)
		if e != nil {
			return e
		}
		out.Members, e = pgx.CollectRows(rows, func(r pgx.CollectableRow) (m OrgDepartmentMember, err error) {
			err = r.Scan(&m.UserID, &m.Name, &m.Email, &m.IsLeader)
			return
		})
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) DeleteDepartmentGuarded(ctx context.Context, guard RestoreGuard, wsID, deptID int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		var dws int64
		e = tx.QueryRow(ctx, `SELECT workspace_id FROM org_departments WHERE id=$1 FOR UPDATE`, deptID).Scan(&dws)
		if errors.Is(e, pgx.ErrNoRows) || (e == nil && dws != wsID) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `WITH RECURSIVE sub AS (
			SELECT id FROM org_departments WHERE id=$1 AND workspace_id=$2
			UNION ALL
			SELECT d.id FROM org_departments d JOIN sub ON d.parent_id = sub.id WHERE d.workspace_id=$2
		) DELETE FROM node_subject_shares WHERE subject_type='department' AND subject_id IN (SELECT id FROM sub)`, deptID, wsID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `WITH RECURSIVE sub AS (
			SELECT id FROM org_departments WHERE id=$1 AND workspace_id=$2
			UNION ALL
			SELECT d.id FROM org_departments d JOIN sub ON d.parent_id = sub.id WHERE d.workspace_id=$2
		) DELETE FROM wiki_space_grants WHERE subject_type='department' AND subject_id IN (SELECT id FROM sub)`, deptID, wsID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `DELETE FROM org_departments WHERE id=$1 AND workspace_id=$2`, deptID, wsID); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return orgPGError(err)
}

func (p *Postgres) SetDepartmentMemberGuarded(ctx context.Context, guard RestoreGuard, wsID, deptID, userID int64, present, isLeader bool) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		var dws int64
		e = tx.QueryRow(ctx, `SELECT workspace_id FROM org_departments WHERE id=$1 FOR SHARE`, deptID).Scan(&dws)
		if errors.Is(e, pgx.ErrNoRows) || (e == nil && dws != wsID) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if !present {
			if _, e = tx.Exec(ctx, `DELETE FROM org_department_members WHERE department_id=$1 AND user_id=$2`, deptID, userID); e != nil {
				return e
			}
			return drivePGEnd(ctx, guard, expires)
		}
		var member int64
		e = tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, wsID, userID).Scan(&member)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrConflict
		}
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO org_department_members (department_id, user_id, is_leader) VALUES ($1,$2,$3)
			ON CONFLICT (department_id, user_id) DO UPDATE SET is_leader=EXCLUDED.is_leader`, deptID, userID, isLeader); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return orgPGError(err)
}

func (p *Postgres) CreateUserGroupGuarded(ctx context.Context, guard RestoreGuard, wsID int64, rawName, rawDesc string) (out OrgGroup, err error) {
	name, ok := cleanOrgName(rawName)
	if !ok {
		return out, ErrConflict
	}
	desc, ok := cleanOrgDescription(rawDesc)
	if !ok {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		out.Members = []OrgGroupMember{}
		if e = tx.QueryRow(ctx, `INSERT INTO org_groups (workspace_id, name, description) VALUES ($1,$2,$3)
			RETURNING id, workspace_id, name, description, created_at, updated_at`,
			wsID, name, desc).Scan(&out.ID, &out.WorkspaceID, &out.Name, &out.Description, &out.CreatedAt, &out.UpdatedAt); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) UpdateUserGroupGuarded(ctx context.Context, guard RestoreGuard, wsID, groupID int64, rawName, rawDesc *string) (out OrgGroup, err error) {
	var cleanName, cleanDesc string
	if rawName != nil {
		var ok bool
		cleanName, ok = cleanOrgName(*rawName)
		if !ok {
			return out, ErrConflict
		}
	}
	if rawDesc != nil {
		var ok bool
		cleanDesc, ok = cleanOrgDescription(*rawDesc)
		if !ok {
			return out, ErrConflict
		}
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		var gws int64
		var curName, curDesc string
		e = tx.QueryRow(ctx, `SELECT workspace_id, name, description FROM org_groups WHERE id=$1 FOR UPDATE`, groupID).Scan(&gws, &curName, &curDesc)
		if errors.Is(e, pgx.ErrNoRows) || (e == nil && gws != wsID) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if rawName != nil {
			curName = cleanName
		}
		if rawDesc != nil {
			curDesc = cleanDesc
		}
		if e = tx.QueryRow(ctx, `UPDATE org_groups SET name=$2, description=$3, updated_at=now() WHERE id=$1
			RETURNING id, workspace_id, name, description, created_at, updated_at`,
			groupID, curName, curDesc).Scan(&out.ID, &out.WorkspaceID, &out.Name, &out.Description, &out.CreatedAt, &out.UpdatedAt); e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `SELECT u.id, u.name, u.email
			FROM org_group_members gm JOIN users u ON u.id = gm.user_id
			WHERE gm.group_id=$1 ORDER BY u.id`, groupID)
		if e != nil {
			return e
		}
		out.Members, e = pgx.CollectRows(rows, func(r pgx.CollectableRow) (m OrgGroupMember, err error) {
			err = r.Scan(&m.UserID, &m.Name, &m.Email)
			return
		})
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) DeleteUserGroupGuarded(ctx context.Context, guard RestoreGuard, wsID, groupID int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		var gws int64
		e = tx.QueryRow(ctx, `SELECT workspace_id FROM org_groups WHERE id=$1 FOR UPDATE`, groupID).Scan(&gws)
		if errors.Is(e, pgx.ErrNoRows) || (e == nil && gws != wsID) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `DELETE FROM node_subject_shares WHERE subject_type='group' AND subject_id=$1`, groupID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `DELETE FROM wiki_space_grants WHERE subject_type='group' AND subject_id=$1`, groupID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `DELETE FROM org_groups WHERE id=$1 AND workspace_id=$2`, groupID, wsID); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return orgPGError(err)
}

func (p *Postgres) SetUserGroupMemberGuarded(ctx context.Context, guard RestoreGuard, wsID, groupID, userID int64, present bool) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		var gws int64
		e = tx.QueryRow(ctx, `SELECT workspace_id FROM org_groups WHERE id=$1 FOR SHARE`, groupID).Scan(&gws)
		if errors.Is(e, pgx.ErrNoRows) || (e == nil && gws != wsID) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if !present {
			if _, e = tx.Exec(ctx, `DELETE FROM org_group_members WHERE group_id=$1 AND user_id=$2`, groupID, userID); e != nil {
				return e
			}
			return drivePGEnd(ctx, guard, expires)
		}
		var member int64
		e = tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, wsID, userID).Scan(&member)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrConflict
		}
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO org_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, groupID, userID); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return orgPGError(err)
}

func (p *Postgres) ListSubjectShares(ctx context.Context, docID int64) ([]SubjectShare, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT s.subject_type, s.subject_id, d.name,
			(SELECT count(*) FROM org_department_members dm WHERE dm.department_id = d.id)::int AS member_count,
			s.role
		FROM node_subject_shares s
		JOIN org_departments d ON s.subject_type = 'department' AND d.id = s.subject_id
		WHERE s.doc_id = $1
		UNION ALL
		SELECT s.subject_type, s.subject_id, g.name,
			(SELECT count(*) FROM org_group_members gm WHERE gm.group_id = g.id)::int AS member_count,
			s.role
		FROM node_subject_shares s
		JOIN org_groups g ON s.subject_type = 'group' AND g.id = s.subject_id
		WHERE s.doc_id = $1
		ORDER BY 1, 2`, docID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (s SubjectShare, err error) {
		err = r.Scan(&s.SubjectType, &s.SubjectID, &s.Name, &s.MemberCount, &s.Role)
		return
	})
}

func bumpPGSubtreePermissionsRevision(ctx context.Context, tx pgx.Tx, docID int64, includeRoot bool) error {
	var exhausted bool
	if err := tx.QueryRow(ctx, `WITH RECURSIVE sub AS (
		SELECT id, permissions_revision, ARRAY[id] AS seen FROM nodes WHERE id=$1
		UNION ALL
		SELECT n.id, n.permissions_revision, sub.seen || n.id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE NOT n.id = ANY(sub.seen)
	) SELECT EXISTS(SELECT 1 FROM sub WHERE ($2 OR id <> $1) AND permissions_revision >= 9007199254740991)`, docID, includeRoot).Scan(&exhausted); err != nil {
		return err
	}
	if exhausted {
		return ErrConflict
	}
	_, err := tx.Exec(ctx, `WITH RECURSIVE sub AS (
		SELECT id, ARRAY[id] AS seen FROM nodes WHERE id=$1
		UNION ALL
		SELECT n.id, sub.seen || n.id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE NOT n.id = ANY(sub.seen)
	) UPDATE nodes SET permissions_revision = permissions_revision + 1 WHERE id IN (SELECT id FROM sub WHERE $2 OR id <> $1)`, docID, includeRoot)
	return err
}

func (p *Postgres) SetSubjectShareGuarded(ctx context.Context, guard RestoreGuard, docID int64, subjectType string, subjectID int64, role string) error {
	if !validSubjectType(subjectType) || subjectID <= 0 || (role != "" && RoleRank(role) == 0) {
		return ErrConflict
	}
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		// Lock the subject row first, matching DeleteDepartment/Group (subject
		// FOR UPDATE, then node_subject_shares). lockShareManager below takes
		// FOR SHARE on existing share rows, so the reverse order can deadlock.
		var subjectWS int64
		var err error
		if subjectType == SubjectTypeDepartment {
			err = tx.QueryRow(ctx, `SELECT workspace_id FROM org_departments WHERE id=$1 FOR SHARE`, subjectID).Scan(&subjectWS)
		} else {
			err = tx.QueryRow(ctx, `SELECT workspace_id FROM org_groups WHERE id=$1 FOR SHARE`, subjectID).Scan(&subjectWS)
		}
		subjectMissing := errors.Is(err, pgx.ErrNoRows)
		if err != nil && !subjectMissing {
			return err
		}
		expiry, err := lockShareManager(ctx, tx, guard, docID)
		if err != nil {
			return err
		}
		var docWS, permRev int64
		if err := tx.QueryRow(ctx, `SELECT workspace_id, permissions_revision FROM nodes WHERE id=$1`, docID).Scan(&docWS, &permRev); err != nil {
			return err
		}
		if permRev >= maxDriveRevision {
			return ErrConflict
		}
		if subjectMissing || subjectWS != docWS {
			return ErrNotFound
		}
		if role == "" {
			if _, err := tx.Exec(ctx, `DELETE FROM node_subject_shares WHERE doc_id=$1 AND subject_type=$2 AND subject_id=$3`, docID, subjectType, subjectID); err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec(ctx, `INSERT INTO node_subject_shares (doc_id, subject_type, subject_id, role) VALUES ($1,$2,$3,$4)
				ON CONFLICT (doc_id, subject_type, subject_id) DO UPDATE SET role=EXCLUDED.role`, docID, subjectType, subjectID, role); err != nil {
				return err
			}
		}
		// 子孙节点继承该授权，整棵子树的权限版本一起前进
		if err := bumpPGSubtreePermissionsRevision(ctx, tx, docID, true); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	return orgPGError(err)
}

func (p *Postgres) SetNodeInheritParentACLGuarded(ctx context.Context, guard RestoreGuard, docID int64, inherit bool) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, err := lockShareManager(ctx, tx, guard, docID)
		if err != nil {
			return err
		}
		if err := bumpPGSubtreePermissionsRevision(ctx, tx, docID, true); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE nodes SET inherit_parent_acl=$2 WHERE id=$1`, docID, inherit); err != nil {
			return err
		}
		if !inherit {
			// Re-evaluate inside this transaction: a manager whose access came
			// only from an ancestor grant would otherwise lock themselves out.
			role, _, _, err := lockCopySource(ctx, tx, docID, guard.UserID)
			if err != nil {
				return err
			}
			if role != RoleManage {
				return ErrWouldLoseAccess
			}
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	return orgPGError(err)
}

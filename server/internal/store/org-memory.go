package store

import (
	"context"
	"sort"
	"strings"
	"time"
)

type subjectShareKey struct {
	subjectType string
	subjectID   int64
}

type memOrg struct {
	nextDeptID    int64
	depts         map[int64]OrgDepartment
	deptMembers   map[int64]map[int64]bool // deptID -> userID -> isLeader
	nextGroupID   int64
	groups        map[int64]OrgGroup
	groupMembers  map[int64]map[int64]bool // groupID -> userID -> true
	subjectShares map[int64]map[subjectShareKey]string
	nextInviteID  int64
	invitations   map[int64]WorkspaceInvitation
}

func (m *Memory) workspaceRoleLocked(ws, uid int64) string {
	if !m.member(uid, ws) {
		return ""
	}
	if ws >= 1 && int(ws) <= len(m.workspaces) && m.workspaces[ws-1].OwnerID == uid {
		return WorkspaceRoleOwner
	}
	if m.workspaceRoles != nil {
		if r := m.workspaceRoles[[2]int64{ws, uid}]; r != "" {
			return r
		}
	}
	return WorkspaceRoleMember
}

func (m *Memory) userDeptSetLocked(ws, uid int64) map[int64]bool {
	out := map[int64]bool{}
	if !m.member(uid, ws) || len(m.org.deptMembers) == 0 {
		return out
	}
	for deptID, members := range m.org.deptMembers {
		if _, ok := members[uid]; !ok {
			continue
		}
		cur, ok := m.org.depts[deptID]
		if !ok || cur.WorkspaceID != ws {
			continue
		}
		seen := map[int64]bool{}
		for {
			if seen[cur.ID] || cur.WorkspaceID != ws {
				break
			}
			seen[cur.ID] = true
			out[cur.ID] = true
			if cur.ParentID == nil {
				break
			}
			parent, exists := m.org.depts[*cur.ParentID]
			if !exists {
				break
			}
			cur = parent
		}
	}
	return out
}

func (m *Memory) userGroupSetLocked(ws, uid int64) map[int64]bool {
	out := map[int64]bool{}
	if !m.member(uid, ws) || len(m.org.groupMembers) == 0 {
		return out
	}
	for groupID, members := range m.org.groupMembers {
		if !members[uid] {
			continue
		}
		if g, ok := m.org.groups[groupID]; ok && g.WorkspaceID == ws {
			out[groupID] = true
		}
	}
	return out
}

func (m *Memory) subjectShareRankLocked(ws, docID int64, depts, groups map[int64]bool) string {
	grants := m.org.subjectShares[docID]
	if len(grants) == 0 {
		return ""
	}
	best := ""
	for k, r := range grants {
		matched := false
		if k.subjectType == SubjectTypeDepartment && depts[k.subjectID] {
			if d, ok := m.org.depts[k.subjectID]; ok && d.WorkspaceID == ws {
				matched = true
			}
		} else if k.subjectType == SubjectTypeGroup && groups[k.subjectID] {
			if g, ok := m.org.groups[k.subjectID]; ok && g.WorkspaceID == ws {
				matched = true
			}
		}
		if matched && RoleRank(r) > RoleRank(best) {
			best = r
		}
	}
	return best
}

func (m *Memory) checkWorkspaceAdminLocked(ctx context.Context, guard RestoreGuard, wsID int64) (time.Time, error) {
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return time.Time{}, err
	}
	if wsID <= 0 || int(wsID) > len(m.workspaces) {
		return time.Time{}, ErrNotFound
	}
	if !isWorkspaceAdminRole(m.workspaceRoleLocked(wsID, guard.UserID)) {
		return time.Time{}, ErrForbidden
	}
	return expires, nil
}

func (m *Memory) buildMemoryDeptLocked(d OrgDepartment) OrgDepartment {
	members := make([]OrgDepartmentMember, 0)
	for uid, isLeader := range m.org.deptMembers[d.ID] {
		u := m.userByID(uid)
		if u == nil {
			continue
		}
		members = append(members, OrgDepartmentMember{
			UserID:   u.ID,
			Name:     u.Name,
			Email:    u.Email,
			IsLeader: isLeader,
		})
	}
	sort.Slice(members, func(i, j int) bool {
		if members[i].IsLeader != members[j].IsLeader {
			return members[i].IsLeader
		}
		return members[i].UserID < members[j].UserID
	})
	d.Members = members
	d.ParentID = cloneDriveParent(d.ParentID)
	return d
}

func (m *Memory) buildMemoryGroupLocked(g OrgGroup) OrgGroup {
	members := make([]OrgGroupMember, 0)
	for uid := range m.org.groupMembers[g.ID] {
		u := m.userByID(uid)
		if u == nil {
			continue
		}
		members = append(members, OrgGroupMember{
			UserID: u.ID,
			Name:   u.Name,
			Email:  u.Email,
		})
	}
	sort.Slice(members, func(i, j int) bool { return members[i].UserID < members[j].UserID })
	g.Members = members
	return g
}

func (m *Memory) GetWorkspaceOrg(ctx context.Context, guard RestoreGuard, wsID int64) (WorkspaceOrgSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return WorkspaceOrgSnapshot{}, err
	}
	if wsID <= 0 || int(wsID) > len(m.workspaces) {
		return WorkspaceOrgSnapshot{}, ErrNotFound
	}
	callerRole := m.workspaceRoleLocked(wsID, guard.UserID)
	if callerRole == "" {
		return WorkspaceOrgSnapshot{}, ErrForbidden
	}
	members := make([]WorkspaceMemberInfo, 0)
	for _, u := range m.users {
		role := m.workspaceRoleLocked(wsID, u.ID)
		if role == "" {
			continue
		}
		members = append(members, WorkspaceMemberInfo{
			UserID:    u.ID,
			Email:     u.Email,
			Name:      u.Name,
			Role:      role,
			CreatedAt: u.CreatedAt,
		})
	}
	sort.Slice(members, func(i, j int) bool { return members[i].UserID < members[j].UserID })

	depts := make([]OrgDepartment, 0)
	for _, d := range m.org.depts {
		if d.WorkspaceID == wsID {
			depts = append(depts, m.buildMemoryDeptLocked(d))
		}
	}
	sort.Slice(depts, func(i, j int) bool {
		if depts[i].SortOrder != depts[j].SortOrder {
			return depts[i].SortOrder < depts[j].SortOrder
		}
		return depts[i].ID < depts[j].ID
	})

	groups := make([]OrgGroup, 0)
	for _, g := range m.org.groups {
		if g.WorkspaceID == wsID {
			groups = append(groups, m.buildMemoryGroupLocked(g))
		}
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].ID < groups[j].ID })

	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WorkspaceOrgSnapshot{}, err
	}
	invitations := []WorkspaceInvitation{}
	if isWorkspaceAdminRole(callerRole) {
		invitations = m.pendingInvitationsLocked(wsID)
	}
	return WorkspaceOrgSnapshot{
		WorkspaceID:   wsID,
		WorkspaceName: m.workspaces[wsID-1].Name,
		CallerRole:    callerRole,
		Members:       members,
		Departments:   depts,
		Groups:        groups,
		Invitations:   invitations,
	}, nil
}

func (m *Memory) UpsertWorkspaceMemberGuarded(ctx context.Context, guard RestoreGuard, wsID int64, rawEmail, role string) (WorkspaceMemberChange, error) {
	email, ok := NormalizeInviteEmail(rawEmail)
	if !ok || (role != WorkspaceRoleMember && role != WorkspaceRoleAdmin && role != "remove") {
		return WorkspaceMemberChange{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return WorkspaceMemberChange{}, err
	}
	var target *User
	for i := range m.users {
		if strings.EqualFold(m.users[i].Email, email) {
			target = &m.users[i]
			break
		}
	}
	// Only an existing member is treated as a member; anyone else is
	// addressed purely by email so the response reveals no account data.
	isMember := target != nil && m.member(target.ID, wsID)
	if isMember && m.workspaces[wsID-1].OwnerID == target.ID {
		return WorkspaceMemberChange{}, ErrForbidden
	}
	inviteID := int64(0)
	pending := 0
	for id, inv := range m.org.invitations {
		if inv.WorkspaceID != wsID {
			continue
		}
		pending++
		if inv.Email == email {
			inviteID = id
		}
	}
	if !isMember && role != "remove" && inviteID == 0 && pending >= maxPendingInvitations {
		return WorkspaceMemberChange{}, ErrConflict
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WorkspaceMemberChange{}, err
	}
	if role == "remove" {
		if inviteID != 0 {
			delete(m.org.invitations, inviteID)
		}
		if isMember {
			filtered := m.members[target.ID][:0]
			for _, id := range m.members[target.ID] {
				if id != wsID {
					filtered = append(filtered, id)
				}
			}
			m.members[target.ID] = filtered
			if m.workspaceRoles != nil {
				delete(m.workspaceRoles, [2]int64{wsID, target.ID})
			}
			for deptID, d := range m.org.depts {
				if d.WorkspaceID == wsID {
					delete(m.org.deptMembers[deptID], target.ID)
				}
			}
			for groupID, g := range m.org.groups {
				if g.WorkspaceID == wsID {
					delete(m.org.groupMembers[groupID], target.ID)
				}
			}
			for spaceID, sp := range m.wiki.spaces {
				if sp.WorkspaceID == wsID {
					delete(m.wiki.grants[spaceID], wikiGrantKey{SubjectTypeUser, target.ID})
				}
			}
		}
		return WorkspaceMemberChange{Status: MemberChangeRemoved}, nil
	}
	if isMember {
		if m.workspaceRoles == nil {
			m.workspaceRoles = map[[2]int64]string{}
		}
		m.workspaceRoles[[2]int64{wsID, target.ID}] = role
		return WorkspaceMemberChange{Status: MemberChangeUpdated, Member: &WorkspaceMemberInfo{
			UserID:    target.ID,
			Email:     target.Email,
			Name:      target.Name,
			Role:      role,
			CreatedAt: target.CreatedAt,
		}}, nil
	}
	if m.org.invitations == nil {
		m.org.invitations = map[int64]WorkspaceInvitation{}
	}
	inv, exists := m.org.invitations[inviteID]
	if !exists {
		m.org.nextInviteID++
		inv = WorkspaceInvitation{ID: m.org.nextInviteID, WorkspaceID: wsID, Email: email, CreatedAt: time.Now()}
	}
	inv.Role = role
	inv.InviterName = m.users[guard.UserID-1].Name
	m.org.invitations[inv.ID] = inv
	out := inv
	out.WorkspaceName = m.workspaces[wsID-1].Name
	return WorkspaceMemberChange{Status: MemberChangeInvited, Invitation: &out}, nil
}

func (m *Memory) pendingInvitationsLocked(wsID int64) []WorkspaceInvitation {
	out := make([]WorkspaceInvitation, 0)
	for _, inv := range m.org.invitations {
		if inv.WorkspaceID == wsID {
			out = append(out, inv)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (m *Memory) RevokeInvitationGuarded(ctx context.Context, guard RestoreGuard, wsID, invitationID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return err
	}
	inv, ok := m.org.invitations[invitationID]
	if !ok || inv.WorkspaceID != wsID {
		return ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	delete(m.org.invitations, invitationID)
	return nil
}

func (m *Memory) ListMyInvitations(ctx context.Context, guard RestoreGuard) ([]WorkspaceInvitation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return nil, err
	}
	u := m.userByID(guard.UserID)
	if u == nil {
		return nil, ErrUnauthenticated
	}
	out := make([]WorkspaceInvitation, 0)
	for _, inv := range m.org.invitations {
		if strings.EqualFold(inv.Email, u.Email) {
			inv.WorkspaceName = m.wsName(inv.WorkspaceID)
			out = append(out, inv)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	return out, nil
}

func (m *Memory) RespondInvitationGuarded(ctx context.Context, guard RestoreGuard, invitationID int64, accept bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return err
	}
	u := m.userByID(guard.UserID)
	inv, ok := m.org.invitations[invitationID]
	// Another account's invitation is indistinguishable from a missing one.
	if u == nil || !ok || !strings.EqualFold(inv.Email, u.Email) {
		return ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	delete(m.org.invitations, invitationID)
	if !accept || m.member(u.ID, inv.WorkspaceID) {
		return nil
	}
	m.members[u.ID] = append(m.members[u.ID], inv.WorkspaceID)
	if m.workspaceRoles == nil {
		m.workspaceRoles = map[[2]int64]string{}
	}
	m.workspaceRoles[[2]int64{inv.WorkspaceID, u.ID}] = inv.Role
	return nil
}

func (m *Memory) CreateDepartmentGuarded(ctx context.Context, guard RestoreGuard, wsID int64, parentID *int64, rawName string, sortOrder int) (OrgDepartment, error) {
	name, ok := cleanOrgName(rawName)
	if !ok {
		return OrgDepartment{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return OrgDepartment{}, err
	}
	if parentID != nil {
		p, exists := m.org.depts[*parentID]
		if !exists || p.WorkspaceID != wsID {
			return OrgDepartment{}, ErrNotFound
		}
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return OrgDepartment{}, err
	}
	m.org.nextDeptID++
	now := time.Now()
	d := OrgDepartment{
		ID:          m.org.nextDeptID,
		WorkspaceID: wsID,
		ParentID:    cloneDriveParent(parentID),
		Name:        name,
		SortOrder:   sortOrder,
		Members:     []OrgDepartmentMember{},
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if m.org.depts == nil {
		m.org.depts = map[int64]OrgDepartment{}
	}
	m.org.depts[d.ID] = d
	return d, nil
}

func (m *Memory) UpdateDepartmentGuarded(ctx context.Context, guard RestoreGuard, wsID, deptID int64, parentID *int64, moveParent bool, rawName *string, sortOrder *int) (OrgDepartment, error) {
	var cleanName string
	if rawName != nil {
		var ok bool
		cleanName, ok = cleanOrgName(*rawName)
		if !ok {
			return OrgDepartment{}, ErrConflict
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return OrgDepartment{}, err
	}
	d, ok := m.org.depts[deptID]
	if !ok || d.WorkspaceID != wsID {
		return OrgDepartment{}, ErrNotFound
	}
	if moveParent && parentID != nil {
		p, exists := m.org.depts[*parentID]
		if !exists || p.WorkspaceID != wsID {
			return OrgDepartment{}, ErrNotFound
		}
		seen := map[int64]bool{}
		for cur := p; ; {
			if cur.ID == deptID {
				return OrgDepartment{}, ErrConflict
			}
			if seen[cur.ID] || cur.ParentID == nil {
				break
			}
			seen[cur.ID] = true
			next, exists := m.org.depts[*cur.ParentID]
			if !exists {
				break
			}
			cur = next
		}
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return OrgDepartment{}, err
	}
	if moveParent {
		d.ParentID = cloneDriveParent(parentID)
	}
	if rawName != nil {
		d.Name = cleanName
	}
	if sortOrder != nil {
		d.SortOrder = *sortOrder
	}
	d.UpdatedAt = time.Now()
	m.org.depts[deptID] = d
	return m.buildMemoryDeptLocked(d), nil
}

func (m *Memory) DeleteDepartmentGuarded(ctx context.Context, guard RestoreGuard, wsID, deptID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return err
	}
	root, ok := m.org.depts[deptID]
	if !ok || root.WorkspaceID != wsID {
		return ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	subtree := map[int64]bool{deptID: true}
	changed := true
	for changed {
		changed = false
		for id, d := range m.org.depts {
			if d.WorkspaceID == wsID && !subtree[id] && d.ParentID != nil && subtree[*d.ParentID] {
				subtree[id] = true
				changed = true
			}
		}
	}
	for id := range subtree {
		delete(m.org.depts, id)
		delete(m.org.deptMembers, id)
		for _, shares := range m.org.subjectShares {
			delete(shares, subjectShareKey{SubjectTypeDepartment, id})
		}
		for _, grants := range m.wiki.grants {
			delete(grants, wikiGrantKey{SubjectTypeDepartment, id})
		}
	}
	return nil
}

func (m *Memory) SetDepartmentMemberGuarded(ctx context.Context, guard RestoreGuard, wsID, deptID, userID int64, present, isLeader bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return err
	}
	d, ok := m.org.depts[deptID]
	if !ok || d.WorkspaceID != wsID {
		return ErrNotFound
	}
	if present && !m.member(userID, wsID) {
		return ErrConflict
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	if m.org.deptMembers == nil {
		m.org.deptMembers = map[int64]map[int64]bool{}
	}
	if !present {
		delete(m.org.deptMembers[deptID], userID)
		return nil
	}
	if m.org.deptMembers[deptID] == nil {
		m.org.deptMembers[deptID] = map[int64]bool{}
	}
	m.org.deptMembers[deptID][userID] = isLeader
	return nil
}

func (m *Memory) CreateUserGroupGuarded(ctx context.Context, guard RestoreGuard, wsID int64, rawName, rawDesc string) (OrgGroup, error) {
	name, ok := cleanOrgName(rawName)
	if !ok {
		return OrgGroup{}, ErrConflict
	}
	desc, ok := cleanOrgDescription(rawDesc)
	if !ok {
		return OrgGroup{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return OrgGroup{}, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return OrgGroup{}, err
	}
	m.org.nextGroupID++
	now := time.Now()
	g := OrgGroup{
		ID:          m.org.nextGroupID,
		WorkspaceID: wsID,
		Name:        name,
		Description: desc,
		Members:     []OrgGroupMember{},
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if m.org.groups == nil {
		m.org.groups = map[int64]OrgGroup{}
	}
	m.org.groups[g.ID] = g
	return g, nil
}

func (m *Memory) UpdateUserGroupGuarded(ctx context.Context, guard RestoreGuard, wsID, groupID int64, rawName, rawDesc *string) (OrgGroup, error) {
	var name, desc string
	if rawName != nil {
		var ok bool
		name, ok = cleanOrgName(*rawName)
		if !ok {
			return OrgGroup{}, ErrConflict
		}
	}
	if rawDesc != nil {
		var ok bool
		desc, ok = cleanOrgDescription(*rawDesc)
		if !ok {
			return OrgGroup{}, ErrConflict
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return OrgGroup{}, err
	}
	g, ok := m.org.groups[groupID]
	if !ok || g.WorkspaceID != wsID {
		return OrgGroup{}, ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return OrgGroup{}, err
	}
	if rawName != nil {
		g.Name = name
	}
	if rawDesc != nil {
		g.Description = desc
	}
	g.UpdatedAt = time.Now()
	m.org.groups[groupID] = g
	return m.buildMemoryGroupLocked(g), nil
}

func (m *Memory) DeleteUserGroupGuarded(ctx context.Context, guard RestoreGuard, wsID, groupID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return err
	}
	g, ok := m.org.groups[groupID]
	if !ok || g.WorkspaceID != wsID {
		return ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	delete(m.org.groups, groupID)
	delete(m.org.groupMembers, groupID)
	for _, shares := range m.org.subjectShares {
		delete(shares, subjectShareKey{SubjectTypeGroup, groupID})
	}
	for _, grants := range m.wiki.grants {
		delete(grants, wikiGrantKey{SubjectTypeGroup, groupID})
	}
	return nil
}

func (m *Memory) SetUserGroupMemberGuarded(ctx context.Context, guard RestoreGuard, wsID, groupID, userID int64, present bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return err
	}
	g, ok := m.org.groups[groupID]
	if !ok || g.WorkspaceID != wsID {
		return ErrNotFound
	}
	if present && !m.member(userID, wsID) {
		return ErrConflict
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	if m.org.groupMembers == nil {
		m.org.groupMembers = map[int64]map[int64]bool{}
	}
	if !present {
		delete(m.org.groupMembers[groupID], userID)
		return nil
	}
	if m.org.groupMembers[groupID] == nil {
		m.org.groupMembers[groupID] = map[int64]bool{}
	}
	m.org.groupMembers[groupID][userID] = true
	return nil
}

func (m *Memory) ListSubjectShares(_ context.Context, docID int64) ([]SubjectShare, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]SubjectShare, 0)
	for key, role := range m.org.subjectShares[docID] {
		item := SubjectShare{
			SubjectType: key.subjectType,
			SubjectID:   key.subjectID,
			Role:        role,
		}
		if key.subjectType == SubjectTypeDepartment {
			d, ok := m.org.depts[key.subjectID]
			if !ok {
				continue
			}
			item.Name = d.Name
			item.MemberCount = len(m.org.deptMembers[d.ID])
		} else {
			g, ok := m.org.groups[key.subjectID]
			if !ok {
				continue
			}
			item.Name = g.Name
			item.MemberCount = len(m.org.groupMembers[g.ID])
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SubjectType != out[j].SubjectType {
			return out[i].SubjectType < out[j].SubjectType
		}
		return out[i].SubjectID < out[j].SubjectID
	})
	return out, nil
}

func (m *Memory) SetSubjectShareGuarded(ctx context.Context, guard RestoreGuard, docID int64, subjectType string, subjectID int64, role string) error {
	if !validSubjectType(subjectType) || subjectID <= 0 || (role != "" && RoleRank(role) == 0) {
		return ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkShareManagerLocked(ctx, guard, docID)
	if err != nil {
		return err
	}
	d := m.doc(docID)
	if subjectType == SubjectTypeDepartment {
		dept, ok := m.org.depts[subjectID]
		if !ok || dept.WorkspaceID != d.meta.WorkspaceID {
			return ErrNotFound
		}
	} else {
		group, ok := m.org.groups[subjectID]
		if !ok || group.WorkspaceID != d.meta.WorkspaceID {
			return ErrNotFound
		}
	}
	if d.meta.PermissionsRevision >= maxDriveRevision {
		return ErrConflict
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	// 子孙节点继承该授权：先确认整棵子树的版本都能前进，再写入
	if err := m.bumpSubtreePermissionRevisionLocked(docID, true); err != nil {
		return err
	}
	if m.org.subjectShares == nil {
		m.org.subjectShares = map[int64]map[subjectShareKey]string{}
	}
	if m.org.subjectShares[docID] == nil {
		m.org.subjectShares[docID] = map[subjectShareKey]string{}
	}
	key := subjectShareKey{subjectType, subjectID}
	if role == "" {
		delete(m.org.subjectShares[docID], key)
	} else {
		m.org.subjectShares[docID][key] = role
	}
	return nil
}

func (m *Memory) SetNodeInheritParentACLGuarded(ctx context.Context, guard RestoreGuard, docID int64, inherit bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkShareManagerLocked(ctx, guard, docID)
	if err != nil {
		return err
	}
	d := m.doc(docID)
	subtree := m.subtree(docID)
	for _, node := range subtree {
		if node.meta.PermissionsRevision >= maxDriveRevision {
			return ErrConflict
		}
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	prevNoInherit := d.noInheritParentACL
	d.noInheritParentACL = !inherit
	if !inherit && m.roleLocked(guard.UserID, d) != RoleManage {
		// A manager whose access came only from an ancestor grant would
		// otherwise lock themselves out.
		d.noInheritParentACL = prevNoInherit
		return ErrWouldLoseAccess
	}
	d.meta.InheritParentACL = inherit
	for _, node := range subtree {
		node.meta.PermissionsRevision++
	}
	return nil
}

func (m *Memory) bumpSubtreePermissionRevisionLocked(id int64, includeRoot bool) error {
	subtree := m.subtree(id)
	for _, node := range subtree {
		if node == nil || (!includeRoot && node.meta.ID == id) {
			continue
		}
		if node.meta.PermissionsRevision >= maxDriveRevision {
			return ErrConflict
		}
	}
	for _, node := range subtree {
		if node == nil || (!includeRoot && node.meta.ID == id) {
			continue
		}
		node.meta.PermissionsRevision++
	}
	return nil
}

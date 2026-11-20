package store

import (
	"context"
	"crypto/subtle"
	"sort"
	"strings"
	"time"
)

func (m *Memory) orgSyncAdminLocked(ctx context.Context, guard RestoreGuard, wsID int64) (time.Time, error) {
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return time.Time{}, err
	}
	if wsID <= 0 || int(wsID) > len(m.workspaces) {
		return time.Time{}, ErrNotFound
	}
	role := m.workspaceRoleLocked(wsID, guard.UserID)
	if !isWorkspaceAdminRole(role) {
		return time.Time{}, ErrForbidden
	}
	return expires, nil
}

func (m *Memory) ListOrgSyncState(ctx context.Context, guard RestoreGuard, wsID int64) ([]OrgSyncSource, []OrgSyncRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.orgSyncAdminLocked(ctx, guard, wsID)
	if err != nil {
		return nil, nil, err
	}
	sources := make([]OrgSyncSource, 0)
	sourceNames := map[int64]string{}
	for _, s := range m.org.syncSources {
		if s.WorkspaceID == wsID {
			sources = append(sources, s)
			sourceNames[s.ID] = s.Name
		}
	}
	sort.Slice(sources, func(i, j int) bool { return sources[i].ID < sources[j].ID })

	runs := make([]OrgSyncRun, 0)
	for i := len(m.org.syncRuns) - 1; i >= 0 && len(runs) < 20; i-- {
		r := m.org.syncRuns[i]
		if r.WorkspaceID != wsID {
			continue
		}
		if r.SourceName == "" {
			r.SourceName = sourceNames[r.SourceID]
		}
		runs = append(runs, r)
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, nil, err
	}
	return sources, runs, nil
}

func (m *Memory) CreateOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID int64, name, provider string, autoInviteMissing, pruneMissing bool) (OrgSyncSourceCreated, error) {
	cleanName, ok := cleanOrgName(name)
	if !ok || !ValidOrgSyncProvider(provider) {
		return OrgSyncSourceCreated{}, ErrConflict
	}
	raw, prefix, hash, err := GenerateOrgSyncToken()
	if err != nil {
		return OrgSyncSourceCreated{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.orgSyncAdminLocked(ctx, guard, wsID)
	if err != nil {
		return OrgSyncSourceCreated{}, err
	}
	if m.org.syncSources == nil {
		m.org.syncSources = map[int64]OrgSyncSource{}
	}
	if m.org.syncTokenHashes == nil {
		m.org.syncTokenHashes = map[int64]string{}
	}
	now := time.Now().UTC()
	m.org.nextSyncSourceID++
	src := OrgSyncSource{
		ID:                m.org.nextSyncSourceID,
		WorkspaceID:       wsID,
		Name:              cleanName,
		Provider:          provider,
		Enabled:           true,
		TokenPrefix:       prefix,
		AutoInviteMissing: autoInviteMissing,
		PruneMissing:      pruneMissing,
		CreatedBy:         guard.UserID,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return OrgSyncSourceCreated{}, err
	}
	m.org.syncSources[src.ID] = src
	m.org.syncTokenHashes[src.ID] = hash
	return OrgSyncSourceCreated{Source: src, Token: raw}, nil
}

func (m *Memory) UpdateOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, patch OrgSyncSourcePatch) (OrgSyncSourceCreated, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.orgSyncAdminLocked(ctx, guard, wsID)
	if err != nil {
		return OrgSyncSourceCreated{}, err
	}
	src, ok := m.org.syncSources[sourceID]
	if !ok || src.WorkspaceID != wsID {
		return OrgSyncSourceCreated{}, ErrNotFound
	}
	if patch.Name != nil {
		cleanName, valid := cleanOrgName(*patch.Name)
		if !valid {
			return OrgSyncSourceCreated{}, ErrConflict
		}
		src.Name = cleanName
	}
	if patch.Enabled != nil {
		src.Enabled = *patch.Enabled
	}
	if patch.AutoInviteMissing != nil {
		src.AutoInviteMissing = *patch.AutoInviteMissing
	}
	if patch.PruneMissing != nil {
		src.PruneMissing = *patch.PruneMissing
	}
	var rawToken string
	if patch.RotateToken {
		raw, prefix, hash, err := GenerateOrgSyncToken()
		if err != nil {
			return OrgSyncSourceCreated{}, err
		}
		rawToken = raw
		src.TokenPrefix = prefix
		m.org.syncTokenHashes[src.ID] = hash
	}
	src.UpdatedAt = time.Now().UTC()
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return OrgSyncSourceCreated{}, err
	}
	m.org.syncSources[src.ID] = src
	return OrgSyncSourceCreated{Source: src, Token: rawToken}, nil
}

func (m *Memory) DeleteOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.orgSyncAdminLocked(ctx, guard, wsID)
	if err != nil {
		return err
	}
	src, ok := m.org.syncSources[sourceID]
	if !ok || src.WorkspaceID != wsID {
		return ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	delete(m.org.syncSources, sourceID)
	delete(m.org.syncTokenHashes, sourceID)
	for id, d := range m.org.depts {
		if d.SyncSourceID != nil && *d.SyncSourceID == sourceID {
			d.SyncSourceID = nil
			m.org.depts[id] = d
		}
	}
	for id, g := range m.org.groups {
		if g.SyncSourceID != nil && *g.SyncSourceID == sourceID {
			g.SyncSourceID = nil
			m.org.groups[id] = g
		}
	}
	kept := m.org.syncRuns[:0]
	for _, r := range m.org.syncRuns {
		if r.SourceID != sourceID {
			kept = append(kept, r)
		}
	}
	m.org.syncRuns = kept
	return nil
}

func (m *Memory) RunOrgDirectorySyncGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, payload OrgDirectorySyncPayload) (OrgSyncRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.orgSyncAdminLocked(ctx, guard, wsID)
	if err != nil {
		return OrgSyncRun{}, err
	}
	src, ok := m.org.syncSources[sourceID]
	if !ok || src.WorkspaceID != wsID {
		return OrgSyncRun{}, ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return OrgSyncRun{}, err
	}
	actor := guard.UserID
	return m.applyOrgSyncLocked(src, &actor, OrgSyncTriggerManual, payload)
}

func (m *Memory) PushOrgDirectorySyncByToken(_ context.Context, tokenHash, triggerMode string, payload OrgDirectorySyncPayload) (OrgSyncRun, error) {
	if tokenHash == "" {
		return OrgSyncRun{}, ErrUnauthenticated
	}
	if triggerMode != OrgSyncTriggerPush && triggerMode != OrgSyncTriggerSCIM {
		triggerMode = OrgSyncTriggerPush
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var matched *OrgSyncSource
	for id, h := range m.org.syncTokenHashes {
		if len(h) == len(tokenHash) && subtle.ConstantTimeCompare([]byte(h), []byte(tokenHash)) == 1 {
			if s, ok := m.org.syncSources[id]; ok {
				cp := s
				matched = &cp
				break
			}
		}
	}
	if matched == nil {
		return OrgSyncRun{}, ErrUnauthenticated
	}
	if !matched.Enabled {
		return OrgSyncRun{}, ErrForbidden
	}
	return m.applyOrgSyncLocked(*matched, nil, triggerMode, payload)
}

func (m *Memory) applyOrgSyncLocked(src OrgSyncSource, actorID *int64, triggerMode string, payload OrgDirectorySyncPayload) (OrgSyncRun, error) {
	validated, errMsg, err := validateAndSortOrgSyncPayload(payload)
	now := time.Now().UTC()
	if err != nil {
		run := OrgSyncRun{
			WorkspaceID:  src.WorkspaceID,
			SourceID:     src.ID,
			SourceName:   src.Name,
			ActorUserID:  actorID,
			TriggerMode:  triggerMode,
			DryRun:       payload.DryRun,
			Status:       "failed",
			ErrorMessage: errMsg,
			CreatedAt:    now,
		}
		m.org.nextSyncRunID++
		run.ID = m.org.nextSyncRunID
		m.org.syncRuns = append(m.org.syncRuns, run)
		return run, err
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
		CreatedAt:   now,
	}
	addWarning := func(w string) {
		if len(run.Warnings) < 20 {
			run.Warnings = append(run.Warnings, w)
		}
	}

	// Map existing synced departments & groups for this source.
	extToDeptID := map[string]int64{}
	for id, d := range m.org.depts {
		if d.WorkspaceID == src.WorkspaceID && d.SyncSourceID != nil && *d.SyncSourceID == src.ID && d.ExternalID != "" {
			extToDeptID[d.ExternalID] = id
		}
	}
	extToGroupID := map[string]int64{}
	for id, g := range m.org.groups {
		if g.WorkspaceID == src.WorkspaceID && g.SyncSourceID != nil && *g.SyncSourceID == src.ID && g.ExternalID != "" {
			extToGroupID[g.ExternalID] = id
		}
	}

	// Track department IDs after sync (negative placeholders during dry-run for newly created depts).
	resolvedDeptID := make(map[string]int64, len(validated.departments))
	var nextDryID int64 = -1
	for _, in := range validated.departments {
		var wantParent *int64
		if in.ParentExternalID != "" {
			pid := resolvedDeptID[in.ParentExternalID]
			wantParent = &pid
		}
		if existingID, ok := extToDeptID[in.ExternalID]; ok {
			d := m.org.depts[existingID]
			sameParent := (d.ParentID == nil && wantParent == nil) || (d.ParentID != nil && wantParent != nil && *d.ParentID == *wantParent)
			if d.Name != in.Name || d.SortOrder != in.SortOrder || !sameParent {
				run.DepartmentsUpdated++
				if !payload.DryRun {
					d.Name = in.Name
					d.SortOrder = in.SortOrder
					d.ParentID = cloneDriveParent(wantParent)
					d.UpdatedAt = now
					m.org.depts[existingID] = d
				}
			}
			resolvedDeptID[in.ExternalID] = existingID
		} else {
			run.DepartmentsCreated++
			if !payload.DryRun {
				if m.org.depts == nil {
					m.org.depts = map[int64]OrgDepartment{}
				}
				m.org.nextDeptID++
				sid := src.ID
				m.org.depts[m.org.nextDeptID] = OrgDepartment{
					ID:           m.org.nextDeptID,
					WorkspaceID:  src.WorkspaceID,
					ParentID:     cloneDriveParent(wantParent),
					Name:         in.Name,
					SortOrder:    in.SortOrder,
					SyncSourceID: &sid,
					ExternalID:   in.ExternalID,
					CreatedAt:    now,
					UpdatedAt:    now,
				}
				resolvedDeptID[in.ExternalID] = m.org.nextDeptID
			} else {
				resolvedDeptID[in.ExternalID] = nextDryID
				nextDryID--
			}
		}
	}

	if pruneMissing {
		for extID, deptID := range extToDeptID {
			if validated.deptSet[extID] {
				continue
			}
			run.DepartmentsRemoved++
			if !payload.DryRun {
				delete(m.org.depts, deptID)
				delete(m.org.deptMembers, deptID)
				for _, shares := range m.org.subjectShares {
					delete(shares, subjectShareKey{SubjectTypeDepartment, deptID})
				}
				for _, grants := range m.wiki.grants {
					delete(grants, wikiGrantKey{SubjectTypeDepartment, deptID})
				}
			}
		}
	}

	resolvedGroupID := make(map[string]int64, len(validated.groups))
	for _, in := range validated.groups {
		if existingID, ok := extToGroupID[in.ExternalID]; ok {
			g := m.org.groups[existingID]
			if g.Name != in.Name || g.Description != in.Description {
				run.GroupsUpdated++
				if !payload.DryRun {
					g.Name = in.Name
					g.Description = in.Description
					g.UpdatedAt = now
					m.org.groups[existingID] = g
				}
			}
			resolvedGroupID[in.ExternalID] = existingID
		} else {
			run.GroupsCreated++
			if !payload.DryRun {
				if m.org.groups == nil {
					m.org.groups = map[int64]OrgGroup{}
				}
				m.org.nextGroupID++
				sid := src.ID
				m.org.groups[m.org.nextGroupID] = OrgGroup{
					ID:           m.org.nextGroupID,
					WorkspaceID:  src.WorkspaceID,
					Name:         in.Name,
					Description:  in.Description,
					SyncSourceID: &sid,
					ExternalID:   in.ExternalID,
					CreatedAt:    now,
					UpdatedAt:    now,
				}
				resolvedGroupID[in.ExternalID] = m.org.nextGroupID
			} else {
				resolvedGroupID[in.ExternalID] = nextDryID
				nextDryID--
			}
		}
	}

	if pruneMissing {
		for extID, groupID := range extToGroupID {
			if validated.groupSet[extID] {
				continue
			}
			run.GroupsRemoved++
			if !payload.DryRun {
				delete(m.org.groups, groupID)
				delete(m.org.groupMembers, groupID)
				for _, shares := range m.org.subjectShares {
					delete(shares, subjectShareKey{SubjectTypeGroup, groupID})
				}
				for _, grants := range m.wiki.grants {
					delete(grants, wikiGrantKey{SubjectTypeGroup, groupID})
				}
			}
		}
	}

	// Build workspace email -> userID map and pending invite counts.
	wsEmailToUID := map[string]int64{}
	for _, u := range m.users {
		if m.workspaceRoleLocked(src.WorkspaceID, u.ID) != "" {
			wsEmailToUID[strings.ToLower(strings.TrimSpace(u.Email))] = u.ID
		}
	}
	pendingInvites := map[string]int64{}
	pendingCount := 0
	for id, inv := range m.org.invitations {
		if inv.WorkspaceID == src.WorkspaceID {
			pendingInvites[strings.ToLower(inv.Email)] = id
			pendingCount++
		}
	}

	// Collect all live synced department/group IDs owned by this source so membership
	// reconciliation only affects departments/groups managed by this connector.
	managedDeptIDs := map[int64]bool{}
	for _, id := range resolvedDeptID {
		if id > 0 {
			managedDeptIDs[id] = true
		}
	}
	managedGroupIDs := map[int64]bool{}
	for _, id := range resolvedGroupID {
		if id > 0 {
			managedGroupIDs[id] = true
		}
	}

	inviterName := ""
	if actorID != nil {
		if u := m.userByID(*actorID); u != nil {
			inviterName = u.Name
		}
	} else if u := m.userByID(src.CreatedBy); u != nil {
		inviterName = u.Name
	}

	seenMemberUIDs := map[int64]bool{}
	for _, mem := range validated.members {
		uid, inWS := wsEmailToUID[mem.Email]
		if !inWS {
			if src.AutoInviteMissing {
				if _, already := pendingInvites[mem.Email]; !already {
					if pendingCount >= maxPendingInvitations {
						addWarning("待接受邀请已达上限，部分新邮箱未创建邀请")
						continue
					}
					run.MembersInvited++
					pendingCount++
					pendingInvites[mem.Email] = -1
					if !payload.DryRun {
						if m.org.invitations == nil {
							m.org.invitations = map[int64]WorkspaceInvitation{}
						}
						m.org.nextInviteID++
						invRole := mem.Role
						if invRole == "" {
							invRole = WorkspaceRoleMember
						}
						m.org.invitations[m.org.nextInviteID] = WorkspaceInvitation{
							ID:            m.org.nextInviteID,
							WorkspaceID:   src.WorkspaceID,
							WorkspaceName: m.workspaces[src.WorkspaceID-1].Name,
							Email:         mem.Email,
							Role:          invRole,
							InviterName:   inviterName,
							CreatedAt:     now,
						}
					}
				}
			} else {
				addWarning("未加入空间成员已跳过：" + mem.Email)
			}
			continue
		}

		seenMemberUIDs[uid] = true
		run.MembersLinked++
		// Reconcile optional workspace role (never demote owner).
		if mem.Role != "" {
			curRole := m.workspaceRoleLocked(src.WorkspaceID, uid)
			if curRole != WorkspaceRoleOwner && curRole != mem.Role {
				run.MembershipsUpdated++
				if !payload.DryRun {
					if m.workspaceRoles == nil {
						m.workspaceRoles = map[[2]int64]string{}
					}
					m.workspaceRoles[[2]int64{src.WorkspaceID, uid}] = mem.Role
				}
			}
		}

		// Desired synced department memberships for this user.
		wantDeptLeader := map[int64]bool{}
		for _, extID := range mem.DepartmentExternalIDs {
			wantDeptLeader[resolvedDeptID[extID]] = containsString(mem.LeaderDepartmentExternalIDs, extID)
		}
		for deptID, wantLeader := range wantDeptLeader {
			if deptID < 0 {
				run.MembershipsUpdated++
				continue
			}
			curLeader, exists := m.org.deptMembers[deptID][uid]
			if !exists || curLeader != wantLeader {
				run.MembershipsUpdated++
				if !payload.DryRun {
					if m.org.deptMembers == nil {
						m.org.deptMembers = map[int64]map[int64]bool{}
					}
					if m.org.deptMembers[deptID] == nil {
						m.org.deptMembers[deptID] = map[int64]bool{}
					}
					m.org.deptMembers[deptID][uid] = wantLeader
				}
			}
		}
		for deptID := range managedDeptIDs {
			if _, wanted := wantDeptLeader[deptID]; wanted {
				continue
			}
			if _, exists := m.org.deptMembers[deptID][uid]; exists {
				run.MembershipsUpdated++
				if !payload.DryRun {
					delete(m.org.deptMembers[deptID], uid)
				}
			}
		}

		// Desired synced group memberships for this user.
		wantGroups := map[int64]bool{}
		for _, extID := range mem.GroupExternalIDs {
			wantGroups[resolvedGroupID[extID]] = true
		}
		for groupID := range wantGroups {
			if groupID < 0 {
				run.MembershipsUpdated++
				continue
			}
			if !m.org.groupMembers[groupID][uid] {
				run.MembershipsUpdated++
				if !payload.DryRun {
					if m.org.groupMembers == nil {
						m.org.groupMembers = map[int64]map[int64]bool{}
					}
					if m.org.groupMembers[groupID] == nil {
						m.org.groupMembers[groupID] = map[int64]bool{}
					}
					m.org.groupMembers[groupID][uid] = true
				}
			}
		}
		for groupID := range managedGroupIDs {
			if wantGroups[groupID] {
				continue
			}
			if m.org.groupMembers[groupID][uid] {
				run.MembershipsUpdated++
				if !payload.DryRun {
					delete(m.org.groupMembers[groupID], uid)
				}
			}
		}
	}

	if pruneMissing {
		for deptID := range managedDeptIDs {
			for uid := range m.org.deptMembers[deptID] {
				if seenMemberUIDs[uid] {
					continue
				}
				run.MembershipsUpdated++
				if !payload.DryRun {
					delete(m.org.deptMembers[deptID], uid)
				}
			}
		}
		for groupID := range managedGroupIDs {
			for uid := range m.org.groupMembers[groupID] {
				if seenMemberUIDs[uid] {
					continue
				}
				run.MembershipsUpdated++
				if !payload.DryRun {
					delete(m.org.groupMembers[groupID], uid)
				}
			}
		}
	}

	m.org.nextSyncRunID++
	run.ID = m.org.nextSyncRunID
	m.org.syncRuns = append(m.org.syncRuns, run)
	if !payload.DryRun {
		t := now
		src.LastSyncAt = &t
		src.LastStatus = run.Status
		src.LastSummary = orgSyncRunSummary(run)
		src.UpdatedAt = now
		m.org.syncSources[src.ID] = src
	}
	return run, nil
}

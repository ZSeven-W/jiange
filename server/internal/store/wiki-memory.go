package store

import (
	"context"
	"encoding/json"
	"sort"
	"time"
)

type wikiGrantKey struct {
	subjectType string
	subjectID   int64
}

type memWiki struct {
	nextSpaceID    int64
	spaces         map[int64]WikiSpace
	grants         map[int64]map[wikiGrantKey]string // spaceID -> (type, id) -> role
	nextShortcutID int64
	shortcuts      []WikiShortcut
}

func (m *Memory) wikiSpaceRankLocked(ws, spaceID, uid int64, wsRole string, depts, groups map[int64]bool) int {
	if wsRole == "" {
		return 0
	}
	sp, ok := m.wiki.spaces[spaceID]
	if !ok || sp.WorkspaceID != ws {
		return 0
	}
	rank := 0
	if isWorkspaceAdminRole(wsRole) || sp.CreatorID == uid {
		rank = 3
	} else if sp.Visibility == WikiVisibilityWorkspace {
		rank = 1
	}
	for k, role := range m.wiki.grants[spaceID] {
		matched := false
		switch k.subjectType {
		case SubjectTypeUser:
			matched = k.subjectID == uid
		case SubjectTypeDepartment:
			if depts[k.subjectID] {
				if d, ok := m.org.depts[k.subjectID]; ok && d.WorkspaceID == ws {
					matched = true
				}
			}
		case SubjectTypeGroup:
			if groups[k.subjectID] {
				if g, ok := m.org.groups[k.subjectID]; ok && g.WorkspaceID == ws {
					matched = true
				}
			}
		}
		if matched && RoleRank(role) > rank {
			rank = RoleRank(role)
		}
	}
	return rank
}

func (m *Memory) wikiSpaceCallerRankLocked(spaceID, uid int64) (WikiSpace, int, bool) {
	sp, ok := m.wiki.spaces[spaceID]
	if !ok {
		return WikiSpace{}, 0, false
	}
	wsRole := m.workspaceRoleLocked(sp.WorkspaceID, uid)
	if wsRole == "" {
		return sp, 0, true
	}
	depts := m.userDeptSetLocked(sp.WorkspaceID, uid)
	groups := m.userGroupSetLocked(sp.WorkspaceID, uid)
	return sp, m.wikiSpaceRankLocked(sp.WorkspaceID, spaceID, uid, wsRole, depts, groups), true
}

func (m *Memory) wikiSpaceNodeCountLocked(spaceID, uid int64) int {
	count := 0
	for _, d := range m.d.docs {
		if d == nil || d.deleted || d.purged || d.meta.WikiSpaceID == nil || *d.meta.WikiSpaceID != spaceID {
			continue
		}
		if m.roleLocked(uid, d) != "" {
			count++
		}
	}
	return count
}

func (m *Memory) wikiSpaceGrantsLocked(spaceID int64) []WikiSpaceGrant {
	out := make([]WikiSpaceGrant, 0)
	for k, role := range m.wiki.grants[spaceID] {
		switch k.subjectType {
		case SubjectTypeUser:
			u := m.userByID(k.subjectID)
			if u == nil {
				continue
			}
			out = append(out, WikiSpaceGrant{
				SubjectType: SubjectTypeUser,
				SubjectID:   u.ID,
				Name:        u.Name,
				Email:       u.Email,
				Role:        role,
			})
		case SubjectTypeDepartment:
			d, ok := m.org.depts[k.subjectID]
			if !ok {
				continue
			}
			out = append(out, WikiSpaceGrant{
				SubjectType: SubjectTypeDepartment,
				SubjectID:   d.ID,
				Name:        d.Name,
				MemberCount: len(m.org.deptMembers[d.ID]),
				Role:        role,
			})
		case SubjectTypeGroup:
			g, ok := m.org.groups[k.subjectID]
			if !ok {
				continue
			}
			out = append(out, WikiSpaceGrant{
				SubjectType: SubjectTypeGroup,
				SubjectID:   g.ID,
				Name:        g.Name,
				MemberCount: len(m.org.groupMembers[g.ID]),
				Role:        role,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SubjectType != out[j].SubjectType {
			return out[i].SubjectType < out[j].SubjectType
		}
		return out[i].SubjectID < out[j].SubjectID
	})
	return out
}

func wikiMemoryNodeEntry(m *Memory, d *memDoc, role string) WikiNodeEntry {
	var spaceID int64
	if d.meta.WikiSpaceID != nil {
		spaceID = *d.meta.WikiSpaceID
	}
	return WikiNodeEntry{
		ID:               d.meta.ID,
		WorkspaceID:      d.meta.WorkspaceID,
		WikiSpaceID:      spaceID,
		ParentID:         cloneDriveParent(d.meta.ParentID),
		Kind:             d.meta.Kind,
		DocType:          d.meta.DocType,
		Title:            d.meta.Title,
		Icon:             d.meta.Icon,
		SortKey:          docSortKey(d.sortKey),
		CreatorID:        d.meta.CreatorID,
		CreatorName:      d.meta.CreatorName,
		Role:             role,
		Revision:         d.driveRevision,
		InheritParentACL: !d.noInheritParentACL,
		CreatedAt:        d.meta.CreatedAt,
		UpdatedAt:        d.meta.UpdatedAt,
	}
}

func (m *Memory) ListWikiSpaces(ctx context.Context, guard RestoreGuard, wsID int64) ([]WikiSpace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return nil, err
	}
	if wsID <= 0 || int(wsID) > len(m.workspaces) {
		return nil, ErrNotFound
	}
	wsRole := m.workspaceRoleLocked(wsID, guard.UserID)
	if wsRole == "" {
		return nil, ErrForbidden
	}
	depts := m.userDeptSetLocked(wsID, guard.UserID)
	groups := m.userGroupSetLocked(wsID, guard.UserID)
	out := make([]WikiSpace, 0)
	for _, sp := range m.wiki.spaces {
		if sp.WorkspaceID != wsID {
			continue
		}
		rank := m.wikiSpaceRankLocked(wsID, sp.ID, guard.UserID, wsRole, depts, groups)
		nodeCount := m.wikiSpaceNodeCountLocked(sp.ID, guard.UserID)
		if rank == 0 && nodeCount == 0 {
			continue
		}
		item := sp
		if rank == 0 {
			item.CallerRole = RoleView
		} else {
			item.CallerRole = roleFromRank(rank)
		}
		item.NodeCount = nodeCount
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	return out, nil
}

func (m *Memory) GetWikiSpaceDetail(ctx context.Context, guard RestoreGuard, spaceID int64) (WikiSpaceDetail, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return WikiSpaceDetail{}, err
	}
	sp, rank, ok := m.wikiSpaceCallerRankLocked(spaceID, guard.UserID)
	if !ok {
		return WikiSpaceDetail{}, ErrNotFound
	}
	nodes := make([]WikiNodeEntry, 0)
	for _, d := range m.d.docs {
		if d == nil || d.deleted || d.purged || d.meta.WikiSpaceID == nil || *d.meta.WikiSpaceID != spaceID {
			continue
		}
		role := m.roleLocked(guard.UserID, d)
		if role == "" {
			continue
		}
		nodes = append(nodes, wikiMemoryNodeEntry(m, d, role))
	}
	if rank == 0 && len(nodes) == 0 {
		return WikiSpaceDetail{}, ErrNotFound
	}
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].SortKey != nodes[j].SortKey {
			return nodes[i].SortKey < nodes[j].SortKey
		}
		return nodes[i].ID < nodes[j].ID
	})
	visibleNodeIDs := make(map[int64]bool, len(nodes))
	for _, n := range nodes {
		visibleNodeIDs[n.ID] = true
	}
	shortcuts := m.wikiMemoryListShortcutsLocked(spaceID, rank > 0, visibleNodeIDs)
	sp.NodeCount = len(nodes)
	if rank == 0 {
		sp.CallerRole = RoleView
	} else {
		sp.CallerRole = roleFromRank(rank)
	}
	grants := []WikiSpaceGrant{}
	if rank == 3 {
		grants = m.wikiSpaceGrantsLocked(spaceID)
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WikiSpaceDetail{}, err
	}
	return WikiSpaceDetail{Space: sp, Grants: grants, Nodes: nodes, Shortcuts: shortcuts}, nil
}

func (m *Memory) CreateWikiSpaceGuarded(ctx context.Context, guard RestoreGuard, wsID int64, rawName, rawDesc, rawIcon, visibility string) (WikiSpace, error) {
	name, ok := cleanWikiName(rawName)
	if !ok {
		return WikiSpace{}, ErrConflict
	}
	desc, ok := cleanWikiDescription(rawDesc)
	if !ok {
		return WikiSpace{}, ErrConflict
	}
	icon, ok := cleanWikiIcon(rawIcon)
	if !ok {
		return WikiSpace{}, ErrConflict
	}
	if visibility == "" {
		visibility = WikiVisibilityWorkspace
	}
	if !validWikiVisibility(visibility) {
		return WikiSpace{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return WikiSpace{}, err
	}
	if wsID <= 0 || int(wsID) > len(m.workspaces) {
		return WikiSpace{}, ErrNotFound
	}
	if !m.member(guard.UserID, wsID) {
		return WikiSpace{}, ErrForbidden
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WikiSpace{}, err
	}
	if m.wiki.spaces == nil {
		m.wiki.spaces = map[int64]WikiSpace{}
	}
	m.wiki.nextSpaceID++
	now := time.Now()
	creatorName := ""
	if u := m.userByID(guard.UserID); u != nil {
		creatorName = u.Name
	}
	sp := WikiSpace{
		ID:          m.wiki.nextSpaceID,
		WorkspaceID: wsID,
		Name:        name,
		Description: desc,
		Icon:        icon,
		Visibility:  visibility,
		CreatorID:   guard.UserID,
		CreatorName: creatorName,
		CallerRole:  RoleManage,
		NodeCount:   0,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	m.wiki.spaces[sp.ID] = sp
	return sp, nil
}

func (m *Memory) bumpWikiSpaceNodesPermissionRevisionLocked(spaceID int64) error {
	for _, d := range m.d.docs {
		if d == nil || d.purged || d.meta.WikiSpaceID == nil || *d.meta.WikiSpaceID != spaceID {
			continue
		}
		if d.meta.PermissionsRevision >= maxDriveRevision {
			return ErrConflict
		}
	}
	for _, d := range m.d.docs {
		if d == nil || d.purged || d.meta.WikiSpaceID == nil || *d.meta.WikiSpaceID != spaceID {
			continue
		}
		d.meta.PermissionsRevision++
	}
	return nil
}

func (m *Memory) UpdateWikiSpaceGuarded(ctx context.Context, guard RestoreGuard, spaceID int64, rawName, rawDesc, rawIcon, rawVis *string) (WikiSpace, error) {
	var name, desc, icon, vis string
	if rawName != nil {
		var ok bool
		name, ok = cleanWikiName(*rawName)
		if !ok {
			return WikiSpace{}, ErrConflict
		}
	}
	if rawDesc != nil {
		var ok bool
		desc, ok = cleanWikiDescription(*rawDesc)
		if !ok {
			return WikiSpace{}, ErrConflict
		}
	}
	if rawIcon != nil {
		var ok bool
		icon, ok = cleanWikiIcon(*rawIcon)
		if !ok {
			return WikiSpace{}, ErrConflict
		}
	}
	if rawVis != nil {
		if !validWikiVisibility(*rawVis) {
			return WikiSpace{}, ErrConflict
		}
		vis = *rawVis
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return WikiSpace{}, err
	}
	sp, rank, ok := m.wikiSpaceCallerRankLocked(spaceID, guard.UserID)
	if !ok {
		return WikiSpace{}, ErrNotFound
	}
	if rank < 3 {
		return WikiSpace{}, ErrForbidden
	}
	if rawVis != nil && vis != sp.Visibility {
		if err := m.bumpWikiSpaceNodesPermissionRevisionLocked(spaceID); err != nil {
			return WikiSpace{}, err
		}
		sp.Visibility = vis
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WikiSpace{}, err
	}
	if rawName != nil {
		sp.Name = name
	}
	if rawDesc != nil {
		sp.Description = desc
	}
	if rawIcon != nil {
		sp.Icon = icon
	}
	sp.UpdatedAt = time.Now()
	m.wiki.spaces[spaceID] = sp
	sp.CallerRole = RoleManage
	sp.NodeCount = m.wikiSpaceNodeCountLocked(spaceID, guard.UserID)
	return sp, nil
}

func (m *Memory) DeleteWikiSpaceGuarded(ctx context.Context, guard RestoreGuard, spaceID int64) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return nil, err
	}
	_, rank, ok := m.wikiSpaceCallerRankLocked(spaceID, guard.UserID)
	if !ok {
		return nil, ErrNotFound
	}
	if rank < 3 {
		return nil, ErrForbidden
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	ids := map[int64]bool{}
	for _, d := range m.d.docs {
		if d != nil && d.meta.WikiSpaceID != nil && *d.meta.WikiSpaceID == spaceID {
			ids[d.meta.ID] = true
			d.deleted = true
			d.purged = true
			delete(m.sheets.books, d.meta.ID)
		}
	}
	keys := map[string]bool{}
	for i := range m.sh.files {
		if f := m.sh.files[i]; f.ID != 0 && ids[f.DocID] {
			keys[f.ObjectKey] = true
			m.sh.files[i] = FileMeta{}
		}
	}
	freed := []string{}
	for key := range keys {
		refs := false
		for _, f := range m.sh.files {
			if f.ID != 0 && f.ObjectKey == key {
				refs = true
				break
			}
		}
		if !refs {
			freed = append(freed, key)
		}
	}
	sort.Strings(freed)
	delete(m.wiki.spaces, spaceID)
	delete(m.wiki.grants, spaceID)
	keptShortcuts := m.wiki.shortcuts[:0]
	for _, sc := range m.wiki.shortcuts {
		if sc.WikiSpaceID != spaceID {
			keptShortcuts = append(keptShortcuts, sc)
		}
	}
	m.wiki.shortcuts = keptShortcuts
	return freed, nil
}

func (m *Memory) SetWikiSpaceGrantGuarded(ctx context.Context, guard RestoreGuard, spaceID int64, subjectType string, subjectID int64, role string) ([]WikiSpaceGrant, error) {
	if !validWikiGrantSubjectType(subjectType) || subjectID <= 0 || (role != "" && RoleRank(role) == 0) {
		return nil, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return nil, err
	}
	sp, rank, ok := m.wikiSpaceCallerRankLocked(spaceID, guard.UserID)
	if !ok {
		return nil, ErrNotFound
	}
	if rank < 3 {
		return nil, ErrForbidden
	}
	switch subjectType {
	case SubjectTypeUser:
		if !m.member(subjectID, sp.WorkspaceID) {
			return nil, ErrNotFound
		}
		if subjectID == sp.CreatorID && role != RoleManage {
			return nil, ErrForbidden
		}
	case SubjectTypeDepartment:
		d, exists := m.org.depts[subjectID]
		if !exists || d.WorkspaceID != sp.WorkspaceID {
			return nil, ErrNotFound
		}
	case SubjectTypeGroup:
		g, exists := m.org.groups[subjectID]
		if !exists || g.WorkspaceID != sp.WorkspaceID {
			return nil, ErrNotFound
		}
	}
	if err := m.bumpWikiSpaceNodesPermissionRevisionLocked(spaceID); err != nil {
		return nil, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	if m.wiki.grants == nil {
		m.wiki.grants = map[int64]map[wikiGrantKey]string{}
	}
	if m.wiki.grants[spaceID] == nil {
		m.wiki.grants[spaceID] = map[wikiGrantKey]string{}
	}
	key := wikiGrantKey{subjectType, subjectID}
	if role == "" {
		delete(m.wiki.grants[spaceID], key)
	} else {
		m.wiki.grants[spaceID][key] = role
	}
	return m.wikiSpaceGrantsLocked(spaceID), nil
}

func (m *Memory) CreateWikiNodeGuarded(ctx context.Context, guard RestoreGuard, spaceID int64, parentID *int64, kind, docType, title string) (WikiNodeEntry, error) {
	if !validWikiNodeKind(kind) || !ValidDocType(docType) || (docType != "" && kind != "doc") || !validDriveTitle(title) {
		return WikiNodeEntry{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return WikiNodeEntry{}, err
	}
	sp, rank, ok := m.wikiSpaceCallerRankLocked(spaceID, guard.UserID)
	if !ok {
		return WikiNodeEntry{}, ErrNotFound
	}
	if !m.member(guard.UserID, sp.WorkspaceID) {
		return WikiNodeEntry{}, ErrForbidden
	}
	if parentID != nil {
		p := m.doc(*parentID)
		if p == nil || p.deleted || p.purged || p.meta.WorkspaceID != sp.WorkspaceID || p.meta.WikiSpaceID == nil || *p.meta.WikiSpaceID != spaceID || p.meta.Kind == "file" {
			return WikiNodeEntry{}, ErrNotFound
		}
		if kind == "folder" && p.meta.Kind != "folder" {
			return WikiNodeEntry{}, ErrConflict
		}
		if RoleRank(m.roleLocked(guard.UserID, p)) < RoleRank(RoleEdit) {
			return WikiNodeEntry{}, ErrForbidden
		}
	} else if rank < 2 {
		return WikiNodeEntry{}, ErrForbidden
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WikiNodeEntry{}, err
	}
	now := time.Now()
	id := int64(len(m.d.docs) + 1)
	wsID := sp.WorkspaceID
	spID := spaceID
	meta := DocMeta{
		ID:               id,
		WorkspaceID:      wsID,
		ParentID:         cloneDriveParent(parentID),
		Kind:             kind,
		DocType:          docType,
		Title:            title,
		CreatorID:        guard.UserID,
		CreatorName:      m.users[guard.UserID-1].Name,
		CreatedAt:        now,
		UpdatedAt:        now,
		DriveRevision:    1,
		InheritParentACL: true,
		WikiSpaceID:      &spID,
		WikiSpaceName:    sp.Name,
	}
	if kind == "doc" || kind == "sheet" {
		meta.CopyMinRole, meta.DownloadMinRole, meta.CommentMinRole = RoleView, RoleView, RoleView
	}
	d := &memDoc{
		meta:          meta,
		sortKey:       m.wikiMemoryNextSiblingSortKeyLocked(spaceID, parentID),
		driveRevision: 1,
		personal:      false,
		ids:           map[[2]int64]bool{},
		snaps:         map[int64][]byte{},
		versions:      map[int64]memVersion{},
	}
	if kind == "doc" {
		initial := InitialDocOps(title)
		batch, e := prepareMemoryIdentityBatch(d, initial)
		if e != nil {
			return WikiNodeEntry{}, e
		}
		for _, dup := range batch.duplicate {
			if dup {
				return WikiNodeEntry{}, ErrOpIdentityConflict
			}
		}
		batch.commit(d)
		for i, op := range initial {
			d.ids[[2]int64{op.ClientID, op.Clock}] = true
			d.ops = append(d.ops, SeqOp{int64(i + 1), op.ClientID, op.Bytes})
		}
	} else if kind == "base" {
		tbl := BaseTable{ID: m.id(), BaseID: id, Name: "数据表", Position: 1, IsDefault: true}
		field := Field{ID: m.id(), BaseID: id, TableID: tbl.ID, Name: "文本", Type: "text", Position: 1, IsPrimary: true}
		view := View{ID: m.id(), BaseID: id, TableID: tbl.ID, Name: "表格", Type: "grid", Config: json.RawMessage(`{}`), Pos: 1}
		records := make([]Record, 5)
		for i := range records {
			uid := guard.UserID
			recID := m.id()
			records[i] = Record{ID: recID, BaseID: id, TableID: tbl.ID, Cells: map[string]json.RawMessage{}, Position: float64(recID), CreatorID: &uid, CreatedAt: &now, UpdatedAt: &now}
		}
		m.b.tables = append(m.b.tables, tbl)
		m.b.fields = append(m.b.fields, field)
		m.b.views = append(m.b.views, view)
		m.b.records = append(m.b.records, records...)
	} else if kind == "slides" {
		m.slidesSequence++
		m.slides = append(m.slides, SlidesPage{ID: m.slidesSequence, SlidesID: id, Pos: 1, Shapes: json.RawMessage(`[]`), Revision: 1, UpdatedAt: now})
	} else if kind == "sheet" {
		m.initSheetWorkbookLocked(id)
	}
	m.d.docs = append(m.d.docs, d)
	return wikiMemoryNodeEntry(m, d, RoleManage), nil
}

func (m *Memory) MoveWikiNodeGuarded(ctx context.Context, guard RestoreGuard, nodeID, targetSpaceID int64, targetParentID *int64, expectedRevision int64) (WikiNodeEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return WikiNodeEntry{}, err
	}
	d := m.doc(nodeID)
	if d == nil || d.deleted || d.purged || d.meta.WikiSpaceID == nil {
		return WikiNodeEntry{}, ErrNotFound
	}
	if d.driveRevision != expectedRevision || d.driveRevision >= maxDriveRevision {
		return WikiNodeEntry{}, ErrConflict
	}
	sourceSpaceID := *d.meta.WikiSpaceID
	targetSpace, targetRank, ok := m.wikiSpaceCallerRankLocked(targetSpaceID, guard.UserID)
	if !ok || targetSpace.WorkspaceID != d.meta.WorkspaceID {
		return WikiNodeEntry{}, ErrNotFound
	}
	if RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleManage) {
		return WikiNodeEntry{}, ErrForbidden
	}
	subtree, err := m.safeDriveSubtreeLocked(d)
	if err != nil {
		return WikiNodeEntry{}, err
	}
	if sourceSpaceID != targetSpaceID {
		for _, item := range subtree {
			if item.deleted || item.purged {
				continue
			}
			if RoleRank(m.roleLocked(guard.UserID, item)) < RoleRank(RoleManage) {
				return WikiNodeEntry{}, ErrForbidden
			}
		}
	}
	if targetParentID != nil {
		p := m.doc(*targetParentID)
		if p == nil || p.deleted || p.purged || p.meta.WorkspaceID != d.meta.WorkspaceID || p.meta.WikiSpaceID == nil || *p.meta.WikiSpaceID != targetSpaceID || p.meta.Kind == "file" {
			return WikiNodeEntry{}, ErrNotFound
		}
		if d.meta.Kind == "folder" && p.meta.Kind != "folder" {
			return WikiNodeEntry{}, ErrConflict
		}
		if RoleRank(m.roleLocked(guard.UserID, p)) < RoleRank(RoleEdit) {
			return WikiNodeEntry{}, ErrForbidden
		}
		for cur := p; cur != nil; {
			if cur.meta.ID == nodeID {
				return WikiNodeEntry{}, ErrConflict
			}
			if cur.meta.ParentID == nil {
				break
			}
			cur = m.doc(*cur.meta.ParentID)
		}
	} else if targetRank < 2 {
		return WikiNodeEntry{}, ErrForbidden
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WikiNodeEntry{}, err
	}
	if err := m.bumpSubtreePermissionRevisionLocked(nodeID, true); err != nil {
		return WikiNodeEntry{}, err
	}
	d.meta.ParentID = cloneDriveParent(targetParentID)
	d.sortKey = m.wikiMemoryNextSiblingSortKeyLocked(targetSpaceID, targetParentID)
	d.driveRevision++
	d.meta.DriveRevision = d.driveRevision
	d.meta.UpdatedAt = time.Now()
	m.setDocumentModifierLocked(d, guard.UserID)
	if sourceSpaceID != targetSpaceID {
		for _, item := range subtree {
			spID := targetSpaceID
			item.meta.WikiSpaceID = &spID
			item.meta.WikiSpaceName = targetSpace.Name
		}
	}
	return wikiMemoryNodeEntry(m, d, m.roleLocked(guard.UserID, d)), nil
}

func (m *Memory) ImportDriveNodeToWikiGuarded(ctx context.Context, guard RestoreGuard, sourceNodeID, targetSpaceID int64, targetParentID *int64, expectedRevision int64) (WikiNodeEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return WikiNodeEntry{}, err
	}
	d := m.doc(sourceNodeID)
	if d == nil || d.deleted || d.purged {
		return WikiNodeEntry{}, ErrNotFound
	}
	if d.meta.WikiSpaceID != nil {
		return WikiNodeEntry{}, ErrConflict
	}
	if d.driveRevision != expectedRevision || d.driveRevision >= maxDriveRevision {
		return WikiNodeEntry{}, ErrConflict
	}
	targetSpace, targetRank, ok := m.wikiSpaceCallerRankLocked(targetSpaceID, guard.UserID)
	if !ok || targetSpace.WorkspaceID != d.meta.WorkspaceID {
		return WikiNodeEntry{}, ErrNotFound
	}
	subtree, err := m.safeDriveSubtreeLocked(d)
	if err != nil {
		return WikiNodeEntry{}, err
	}
	for _, item := range subtree {
		if item.deleted || item.purged {
			continue
		}
		if item.meta.Kind == "file" {
			return WikiNodeEntry{}, ErrConflict
		}
		if RoleRank(m.roleLocked(guard.UserID, item)) < RoleRank(RoleManage) {
			return WikiNodeEntry{}, ErrForbidden
		}
	}
	if targetParentID != nil {
		p := m.doc(*targetParentID)
		if p == nil || p.deleted || p.purged || p.meta.WorkspaceID != d.meta.WorkspaceID || p.meta.WikiSpaceID == nil || *p.meta.WikiSpaceID != targetSpaceID || p.meta.Kind == "file" {
			return WikiNodeEntry{}, ErrNotFound
		}
		if d.meta.Kind == "folder" && p.meta.Kind != "folder" {
			return WikiNodeEntry{}, ErrConflict
		}
		if RoleRank(m.roleLocked(guard.UserID, p)) < RoleRank(RoleEdit) {
			return WikiNodeEntry{}, ErrForbidden
		}
		for cur := p; cur != nil; {
			if cur.meta.ID == sourceNodeID {
				return WikiNodeEntry{}, ErrConflict
			}
			if cur.meta.ParentID == nil {
				break
			}
			cur = m.doc(*cur.meta.ParentID)
		}
	} else if targetRank < 2 {
		return WikiNodeEntry{}, ErrForbidden
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WikiNodeEntry{}, err
	}
	if err := m.bumpSubtreePermissionRevisionLocked(sourceNodeID, true); err != nil {
		return WikiNodeEntry{}, err
	}
	d.meta.ParentID = cloneDriveParent(targetParentID)
	d.sortKey = m.wikiMemoryNextSiblingSortKeyLocked(targetSpaceID, targetParentID)
	d.driveRevision++
	d.meta.DriveRevision = d.driveRevision
	d.meta.UpdatedAt = time.Now()
	m.setDocumentModifierLocked(d, guard.UserID)
	for _, item := range subtree {
		spID := targetSpaceID
		item.personal = false
		item.meta.WikiSpaceID = &spID
		item.meta.WikiSpaceName = targetSpace.Name
	}
	return wikiMemoryNodeEntry(m, d, m.roleLocked(guard.UserID, d)), nil
}

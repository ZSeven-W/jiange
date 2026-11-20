package store

import (
	"context"
	"sort"
	"time"
)

func (m *Memory) wikiMemoryNextSiblingSortKeyLocked(spaceID int64, parentID *int64) string {
	count := 0
	maxNum := 0
	for _, d := range m.d.docs {
		if d == nil || d.deleted || d.purged || d.meta.WikiSpaceID == nil || *d.meta.WikiSpaceID != spaceID {
			continue
		}
		if !sameDriveParent(d.meta.ParentID, parentID) {
			continue
		}
		count++
		if num, ok := parseWikiNumericSortKey(docSortKey(d.sortKey)); ok && num > maxNum {
			maxNum = num
		}
	}
	nextIdx := count
	if maxNum/10 > nextIdx {
		nextIdx = maxNum / 10
	}
	return wikiSortKeyForIndex(nextIdx)
}

func (m *Memory) wikiMemoryNextShortcutSortKeyLocked(spaceID int64, parentID *int64) string {
	count := 0
	maxNum := 0
	for _, sc := range m.wiki.shortcuts {
		if sc.WikiSpaceID != spaceID || !sameDriveParent(sc.ParentID, parentID) {
			continue
		}
		count++
		if num, ok := parseWikiNumericSortKey(docSortKey(sc.SortKey)); ok && num > maxNum {
			maxNum = num
		}
	}
	nextIdx := count
	if maxNum/10 > nextIdx {
		nextIdx = maxNum / 10
	}
	return wikiSortKeyForIndex(nextIdx)
}

func (m *Memory) wikiMemoryListShortcutsLocked(spaceID int64, hasSpaceAccess bool, visibleNodes map[int64]bool) []WikiShortcut {
	out := make([]WikiShortcut, 0)
	for _, sc := range m.wiki.shortcuts {
		if sc.WikiSpaceID != spaceID {
			continue
		}
		if sc.ParentID == nil {
			if !hasSpaceAccess {
				continue
			}
		} else if !visibleNodes[*sc.ParentID] {
			continue
		}
		cp := sc
		cp.ParentID = cloneDriveParent(sc.ParentID)
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SortKey != out[j].SortKey {
			return out[i].SortKey < out[j].SortKey
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (m *Memory) ReorderWikiNodeGuarded(ctx context.Context, guard RestoreGuard, spaceID, nodeID int64, targetParentID *int64, position int, expectedRevision int64) (WikiNodeEntry, error) {
	if position < 0 {
		return WikiNodeEntry{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return WikiNodeEntry{}, err
	}
	d := m.doc(nodeID)
	if d == nil || d.deleted || d.purged || d.meta.WikiSpaceID == nil || *d.meta.WikiSpaceID != spaceID {
		return WikiNodeEntry{}, ErrNotFound
	}
	if d.driveRevision != expectedRevision || d.driveRevision >= maxDriveRevision {
		return WikiNodeEntry{}, ErrConflict
	}
	sp, spaceRank, ok := m.wikiSpaceCallerRankLocked(spaceID, guard.UserID)
	if !ok || sp.WorkspaceID != d.meta.WorkspaceID {
		return WikiNodeEntry{}, ErrNotFound
	}
	sameParent := sameDriveParent(d.meta.ParentID, targetParentID)
	nodeRole := m.roleLocked(guard.UserID, d)
	if sameParent {
		if RoleRank(nodeRole) < RoleRank(RoleEdit) {
			return WikiNodeEntry{}, ErrForbidden
		}
	} else {
		if RoleRank(nodeRole) < RoleRank(RoleManage) {
			return WikiNodeEntry{}, ErrForbidden
		}
	}
	if targetParentID != nil {
		if *targetParentID == nodeID {
			return WikiNodeEntry{}, ErrConflict
		}
		p := m.doc(*targetParentID)
		if p == nil || p.deleted || p.purged || p.meta.WorkspaceID != d.meta.WorkspaceID || p.meta.WikiSpaceID == nil || *p.meta.WikiSpaceID != spaceID || p.meta.Kind == "file" {
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
	} else if spaceRank < 2 {
		return WikiNodeEntry{}, ErrForbidden
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WikiNodeEntry{}, err
	}
	if !sameParent {
		if err := m.bumpSubtreePermissionRevisionLocked(nodeID, true); err != nil {
			return WikiNodeEntry{}, err
		}
	}
	siblings := make([]*memDoc, 0)
	for _, cand := range m.d.docs {
		if cand == nil || cand.deleted || cand.purged || cand.meta.ID == nodeID {
			continue
		}
		if cand.meta.WikiSpaceID == nil || *cand.meta.WikiSpaceID != spaceID {
			continue
		}
		if sameDriveParent(cand.meta.ParentID, targetParentID) {
			siblings = append(siblings, cand)
		}
	}
	sort.Slice(siblings, func(i, j int) bool {
		ki, kj := docSortKey(siblings[i].sortKey), docSortKey(siblings[j].sortKey)
		if ki != kj {
			return ki < kj
		}
		return siblings[i].meta.ID < siblings[j].meta.ID
	})
	pos := position
	if pos > len(siblings) {
		pos = len(siblings)
	}
	ordered := make([]*memDoc, 0, len(siblings)+1)
	ordered = append(ordered, siblings[:pos]...)
	ordered = append(ordered, d)
	ordered = append(ordered, siblings[pos:]...)
	for i, item := range ordered {
		item.sortKey = wikiSortKeyForIndex(i)
	}
	d.meta.ParentID = cloneDriveParent(targetParentID)
	d.driveRevision++
	d.meta.DriveRevision = d.driveRevision
	d.meta.UpdatedAt = time.Now()
	m.setDocumentModifierLocked(d, guard.UserID)
	return wikiMemoryNodeEntry(m, d, m.roleLocked(guard.UserID, d)), nil
}

func (m *Memory) CreateWikiShortcutGuarded(ctx context.Context, guard RestoreGuard, spaceID int64, parentID *int64, targetNodeID int64, rawTitle string) (WikiShortcut, error) {
	clean, ok := cleanShortcutTitle(rawTitle)
	if spaceID <= 0 || targetNodeID <= 0 || !ok {
		return WikiShortcut{}, ErrConflict
	}
	if parentID != nil && *parentID == targetNodeID {
		return WikiShortcut{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return WikiShortcut{}, err
	}
	sp, rank, exists := m.wikiSpaceCallerRankLocked(spaceID, guard.UserID)
	if !exists {
		return WikiShortcut{}, ErrNotFound
	}
	if parentID != nil {
		p := m.doc(*parentID)
		if p == nil || p.deleted || p.purged || p.meta.WorkspaceID != sp.WorkspaceID || p.meta.WikiSpaceID == nil || *p.meta.WikiSpaceID != spaceID || p.meta.Kind == "file" {
			return WikiShortcut{}, ErrNotFound
		}
		if RoleRank(m.roleLocked(guard.UserID, p)) < RoleRank(RoleEdit) {
			return WikiShortcut{}, ErrForbidden
		}
	} else if rank < 2 {
		return WikiShortcut{}, ErrForbidden
	}
	target := m.doc(targetNodeID)
	if target == nil || target.deleted || target.purged || RoleRank(m.roleLocked(guard.UserID, target)) < RoleRank(RoleView) {
		return WikiShortcut{}, ErrNotFound
	}
	for _, sc := range m.wiki.shortcuts {
		if sc.WikiSpaceID == spaceID && sameDriveParent(sc.ParentID, parentID) && sc.TargetNodeID == targetNodeID {
			return WikiShortcut{}, ErrConflict
		}
	}
	if clean == "" {
		clean = target.meta.Title
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WikiShortcut{}, err
	}
	m.wiki.nextShortcutID++
	now := time.Now()
	creatorName := ""
	if u := m.userByID(guard.UserID); u != nil {
		creatorName = u.Name
	}
	sc := WikiShortcut{
		ID:           m.wiki.nextShortcutID,
		WorkspaceID:  sp.WorkspaceID,
		WikiSpaceID:  spaceID,
		ParentID:     cloneDriveParent(parentID),
		TargetNodeID: targetNodeID,
		Title:        clean,
		SortKey:      m.wikiMemoryNextShortcutSortKeyLocked(spaceID, parentID),
		CreatorID:    guard.UserID,
		CreatorName:  creatorName,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	m.wiki.shortcuts = append(m.wiki.shortcuts, sc)
	return sc, nil
}

func (m *Memory) DeleteWikiShortcutGuarded(ctx context.Context, guard RestoreGuard, spaceID, shortcutID int64) error {
	if spaceID <= 0 || shortcutID <= 0 {
		return ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return err
	}
	idx := -1
	for i, sc := range m.wiki.shortcuts {
		if sc.ID == shortcutID && sc.WikiSpaceID == spaceID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrNotFound
	}
	sc := m.wiki.shortcuts[idx]
	_, rank, ok := m.wikiSpaceCallerRankLocked(spaceID, guard.UserID)
	if !ok {
		return ErrNotFound
	}
	allowed := sc.CreatorID == guard.UserID || rank >= 3 || (sc.ParentID == nil && rank >= 2)
	if !allowed && sc.ParentID != nil {
		if p := m.doc(*sc.ParentID); p != nil && !p.deleted && !p.purged && RoleRank(m.roleLocked(guard.UserID, p)) >= RoleRank(RoleEdit) {
			allowed = true
		}
	}
	if !allowed {
		return ErrForbidden
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	m.wiki.shortcuts = append(m.wiki.shortcuts[:idx], m.wiki.shortcuts[idx+1:]...)
	return nil
}

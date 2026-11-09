package store

import (
	"context"
	"sort"
	"strings"
)

func (m *Memory) SearchDocs(_ context.Context, uid int64, q string) ([]DocMeta, error) {
	all, err := m.ListDocs(context.Background(), uid)
	if err != nil {
		return nil, err
	}
	kw := strings.ToLower(strings.TrimSpace(q))
	out := []DocMeta{}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, d := range all {
		if strings.Contains(strings.ToLower(d.Title), kw) || strings.Contains(strings.ToLower(d.CreatorName), kw) {
			out = append(out, d)
			continue
		}
		// body: raw op bytes embed UTF-8 text, so substring match works
		if doc := m.doc(d.ID); doc != nil {
			for _, op := range doc.ops {
				if strings.Contains(strings.ToLower(string(op.Bytes)), kw) {
					out = append(out, d)
					break
				}
			}
		}
	}
	return out, nil
}

func (m *Memory) ListFavorites(_ context.Context, uid int64) ([]DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []DocMeta{}
	for _, id := range m.favorites[uid] {
		if d := m.doc(id); d != nil && !d.deleted {
			role := m.roleLocked(uid, d)
			if RoleRank(role) < RoleRank(RoleView) {
				continue
			}
			meta := d.meta
			meta.Role = role
			meta.WorkspaceName = m.wsName(meta.WorkspaceID)
			out = append(out, meta)
		}
	}
	return out, nil
}

func (m *Memory) AddFavorite(_ context.Context, uid, doc int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, id := range m.favorites[uid] {
		if id == doc {
			return nil
		}
	}
	m.favorites[uid] = append(m.favorites[uid], doc)
	return nil
}

func (m *Memory) RemoveFavorite(_ context.Context, uid, doc int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := m.favorites[uid][:0]
	for _, id := range m.favorites[uid] {
		if id != doc {
			out = append(out, id)
		}
	}
	m.favorites[uid] = out
	return nil
}

// Ancestors walks the parent chain (doc excluded), root first.
func (m *Memory) Ancestors(_ context.Context, uid, doc int64) ([]DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(doc)
	if d == nil || d.deleted || RoleRank(m.roleLocked(uid, d)) < RoleRank(RoleView) {
		return nil, ErrNotFound
	}
	var chain []*memDoc
	seen := map[int64]bool{d.meta.ID: true}
	for cur := d; cur.meta.ParentID != nil; {
		p := m.doc(*cur.meta.ParentID)
		if p == nil || seen[p.meta.ID] {
			break
		}
		seen[p.meta.ID] = true
		chain = append(chain, p)
		cur = p
	}
	out := []DocMeta{}
	for i := len(chain) - 1; i >= 0; i-- {
		if chain[i].deleted {
			continue
		}
		role := m.roleLocked(uid, chain[i])
		if RoleRank(role) < RoleRank(RoleView) {
			continue
		}
		meta := chain[i].meta
		meta.Role = role
		meta.WorkspaceName = m.wsName(meta.WorkspaceID)
		out = append(out, meta)
	}
	return out, nil
}

var _ = sort.Ints

// ListPins returns pinned (置顶) docs, newest pin first.
func (m *Memory) ListPins(_ context.Context, uid int64) ([]DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []DocMeta{}
	ids := m.pins[uid]
	for i := len(ids) - 1; i >= 0; i-- {
		if d := m.doc(ids[i]); d != nil && !d.deleted {
			role := m.roleLocked(uid, d)
			if RoleRank(role) < RoleRank(RoleView) {
				continue
			}
			meta := d.meta
			meta.Role = role
			meta.WorkspaceName = m.wsName(meta.WorkspaceID)
			out = append(out, meta)
		}
	}
	return out, nil
}

func (m *Memory) AddPin(_ context.Context, uid, doc int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pins == nil {
		m.pins = map[int64][]int64{}
	}
	for _, id := range m.pins[uid] {
		if id == doc {
			return nil
		}
	}
	m.pins[uid] = append(m.pins[uid], doc)
	return nil
}

func (m *Memory) RemovePin(_ context.Context, uid, doc int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []int64{}
	for _, id := range m.pins[uid] {
		if id != doc {
			out = append(out, id)
		}
	}
	m.pins[uid] = out
	return nil
}

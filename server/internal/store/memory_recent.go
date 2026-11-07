package store

import (
	"context"
	"sort"
	"time"
)

func (m *Memory) RecordVisit(ctx context.Context, uid, docID int64, at time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	d := m.doc(docID)
	if uid < 1 || int(uid) > len(m.users) || d == nil || d.deleted || m.roleLocked(uid, d) == "" {
		return ErrNotFound
	}
	if m.recent == nil {
		m.recent = make(map[[2]int64]time.Time)
	}
	key := [2]int64{uid, docID}
	if old, ok := m.recent[key]; !ok || at.After(old) {
		m.recent[key] = at
	}
	return nil
}

func (m *Memory) RecentDocs(ctx context.Context, uid int64, limit int) ([]RecentDoc, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out := make([]RecentDoc, 0)
	for key, at := range m.recent {
		if key[0] != uid {
			continue
		}
		d := m.doc(key[1])
		if d == nil || d.deleted {
			continue
		}
		role := m.roleLocked(uid, d)
		if role == "" {
			continue
		}
		meta := d.meta
		meta.Role = role
		meta.WorkspaceName = m.wsName(meta.WorkspaceID)
		out = append(out, RecentDoc{DocMeta: meta, ViewedAt: at})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ViewedAt.Equal(out[j].ViewedAt) {
			return out[i].ID > out[j].ID
		}
		return out[i].ViewedAt.After(out[j].ViewedAt)
	})
	if limit = recentLimit(limit); len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

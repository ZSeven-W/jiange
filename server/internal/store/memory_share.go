package store

import (
	"context"
	"sort"
	"time"
)

type memShare struct {
	shares map[int64]map[int64]string // doc -> user -> role
	joins  map[int64]map[int64]bool   // doc -> users who joined its current link
	links  map[int64]Link
	files  []FileMeta
}

// roleLocked computes uid's role on doc d; caller holds m.mu.
func (m *Memory) roleLocked(uid int64, d *memDoc) string {
	ws := d.meta.WorkspaceID
	best := ""
	if m.member(uid, ws) {
		if d.meta.CreatorID == uid || (int(ws) <= len(m.workspaces) && m.workspaces[ws-1].OwnerID == uid) {
			return RoleManage
		}
		best = RoleEdit
	}
	for cur := d; cur != nil; {
		if r := m.sh.shares[cur.meta.ID][uid]; RoleRank(r) > RoleRank(best) {
			best = r
		}
		if m.sh.joins[cur.meta.ID][uid] && !cur.deleted {
			r := m.sh.links[cur.meta.ID].Role
			if r == "anon" {
				r = RoleView
			}
			if RoleRank(r) > RoleRank(best) {
				best = r
			}
		}
		if cur.meta.ParentID == nil {
			break
		}
		cur = m.doc(*cur.meta.ParentID)
	}
	return best
}

func (m *Memory) ListShares(_ context.Context, doc int64) ([]Share, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Share{}
	for uid, r := range m.sh.shares[doc] {
		u := m.users[uid-1]
		out = append(out, Share{UserID: uid, Name: u.Name, Email: u.Email, Role: r})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserID < out[j].UserID })
	return out, nil
}

func (m *Memory) SetShare(_ context.Context, doc, uid int64, role string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sh.shares == nil {
		m.sh.shares = map[int64]map[int64]string{}
	}
	if m.sh.shares[doc] == nil {
		m.sh.shares[doc] = map[int64]string{}
	}
	if role == "" {
		delete(m.sh.shares[doc], uid)
	} else {
		m.sh.shares[doc][uid] = role
	}
	return nil
}

func (m *Memory) GetLink(_ context.Context, doc int64) (Link, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if l, ok := m.sh.links[doc]; ok {
		return l, nil
	}
	return Link{Role: "none"}, nil
}

func (m *Memory) SetLink(_ context.Context, doc int64, l Link) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sh.links == nil {
		m.sh.links = map[int64]Link{}
	}
	if old := m.sh.links[doc]; l.Role == "none" || old.Token != "" && old.Token != l.Token {
		delete(m.sh.joins, doc)
	}
	m.sh.links[doc] = l
	return nil
}

func (m *Memory) ChangeLinkRole(_ context.Context, doc int64, role, candidate string) (Link, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.doc(doc) == nil {
		return Link{}, ErrNotFound
	}
	if m.sh.links == nil {
		m.sh.links = map[int64]Link{}
	}
	old := m.sh.links[doc]
	next := Link{Role: role, Token: old.Token}
	if role == "none" {
		next.Token = ""
	} else if old.Role == "" || old.Role == "none" || old.Token == "" {
		next.Token = candidate
	}
	if role == "none" || old.Token != "" && old.Token != next.Token {
		delete(m.sh.joins, doc)
	}
	m.sh.links[doc] = next
	return next, nil
}

// JoinLink checks the token and records the link grant under the same lock as
// SetLink, so a simultaneous close cannot recreate an already revoked grant.
func (m *Memory) JoinLink(_ context.Context, tok string, uid int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if tok == "" {
		return 0, ErrNotFound
	}
	for id, l := range m.sh.links {
		if l.Token == tok && l.Role != "none" {
			if d := m.doc(id); d != nil && !d.deleted {
				if m.sh.joins == nil {
					m.sh.joins = map[int64]map[int64]bool{}
				}
				if m.sh.joins[id] == nil {
					m.sh.joins[id] = map[int64]bool{}
				}
				m.sh.joins[id][uid] = true
				return id, nil
			}
		}
	}
	return 0, ErrNotFound
}

func (m *Memory) DocByToken(_ context.Context, tok string) (int64, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if tok == "" {
		return 0, "", ErrNotFound
	}
	for id, l := range m.sh.links {
		if l.Token == tok && l.Role != "none" {
			if d := m.doc(id); d != nil && !d.deleted {
				return id, l.Role, nil
			}
		}
	}
	return 0, "", ErrNotFound
}

func (m *Memory) SharedWithMe(_ context.Context, uid int64) ([]DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []DocMeta{}
	docs := map[int64]bool{}
	for doc, us := range m.sh.shares {
		if _, ok := us[uid]; ok {
			docs[doc] = true
		}
	}
	for doc, users := range m.sh.joins {
		if users[uid] && m.sh.links[doc].Role != "none" {
			docs[doc] = true
		}
	}
	for doc := range docs {
		d := m.doc(doc)
		if d != nil && !d.deleted && !m.member(uid, d.meta.WorkspaceID) {
			meta := d.meta
			meta.Role = m.roleLocked(uid, d)
			meta.WorkspaceName = m.wsName(meta.WorkspaceID)
			out = append(out, meta)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) WorkspaceMembers(_ context.Context, ws int64) ([]User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []User{}
	for _, u := range m.users {
		for _, id := range m.members[u.ID] {
			if id == ws {
				u.PasswordHash = ""
				out = append(out, u)
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) CreateFile(_ context.Context, f FileMeta) (FileMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f.ID = int64(len(m.sh.files) + 1)
	f.CreatedAt = time.Now()
	m.sh.files = append(m.sh.files, f)
	return f, nil
}

func (m *Memory) GetFile(_ context.Context, id int64) (FileMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id < 1 || int(id) > len(m.sh.files) {
		return FileMeta{}, ErrNotFound
	}
	return m.sh.files[id-1], nil
}

package store

import (
	"context"
	"slices"
	"sort"
	"time"
)

type memClient struct {
	user, doc, acked int64
	seen             time.Time
}

type memDoc struct {
	iconRevision int64
	meta         DocMeta
	deleted      bool
	ops          []SeqOp
	ids          map[[2]int64]bool
	snaps        map[int64][]byte
	versions     map[int64]memVersion
	opAt         []time.Time // arrival time per op (auto-version sweep)
}

type memVersion struct {
	Label  string
	UserID int64
	At     time.Time
}

type memDocs struct {
	docs    []*memDoc
	clients []memClient
	subs    []func(int64, int64)
}

func (m *Memory) doc(id int64) *memDoc {
	if id < 1 || int(id) > len(m.d.docs) {
		return nil
	}
	return m.d.docs[id-1]
}

func (m *Memory) member(uid, ws int64) bool { return slices.Contains(m.members[uid], ws) }

func (m *Memory) CanCreateIn(_ context.Context, uid, ws int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.member(uid, ws), nil
}

func (m *Memory) CreateDoc(_ context.Context, ws, creator int64, parent *int64, title string, initial []RawOp) (DocMeta, error) {
	m.mu.Lock()
	now := time.Now()
	d := &memDoc{
		meta:     DocMeta{ID: int64(len(m.d.docs) + 1), Kind: "doc", WorkspaceID: ws, ParentID: parent, Title: title, CreatorID: creator, CreatorName: m.users[creator-1].Name, CreatedAt: now, UpdatedAt: now, CopyMinRole: RoleView, DownloadMinRole: RoleView, CommentMinRole: RoleView},
		ids:      map[[2]int64]bool{},
		snaps:    map[int64][]byte{},
		versions: map[int64]memVersion{},
	}
	for i, op := range initial {
		d.ids[[2]int64{op.ClientID, op.Clock}] = true
		d.ops = append(d.ops, SeqOp{int64(i + 1), op.ClientID, op.Bytes})
	}
	m.d.docs = append(m.d.docs, d)
	m.mu.Unlock()
	return d.meta, nil
}

func (m *Memory) ListDocs(_ context.Context, uid int64) ([]DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []DocMeta{}
	for _, d := range m.d.docs {
		if m.member(uid, d.meta.WorkspaceID) && !d.deleted {
			meta := d.meta
			meta.WorkspaceName = m.wsName(meta.WorkspaceID)
			out = append(out, meta)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

func (m *Memory) GetDoc(_ context.Context, uid, id int64) (DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(id)
	if d == nil || d.deleted {
		return DocMeta{}, ErrNotFound
	}
	role := m.roleLocked(uid, d)
	if role == "" {
		return DocMeta{}, ErrNotFound
	}
	meta := d.meta
	meta.Role = role
	return meta, nil
}

// GetDocSystem fetches node meta without user scoping.
func (m *Memory) GetDocSystem(_ context.Context, id int64) (DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(id)
	if d == nil || d.deleted {
		return DocMeta{}, ErrNotFound
	}
	return d.meta, nil
}

func (m *Memory) SetCopyProtected(_ context.Context, id int64, on bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(id)
	if d == nil {
		return ErrNotFound
	}
	if d.meta.PermissionsRevision >= 9007199254740991 {
		return ErrConflict
	}
	d.meta.CopyProtected = on
	d.meta.CopyMinRole, d.meta.DownloadMinRole = RoleView, RoleView
	if on {
		d.meta.CopyMinRole, d.meta.DownloadMinRole = RoleManage, RoleManage
	}
	d.meta.PermissionsRevision++
	return nil
}

func (m *Memory) UpdateTitle(_ context.Context, id int64, title string) (DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(id)
	if d == nil {
		return DocMeta{}, ErrNotFound
	}
	d.meta.Title, d.meta.UpdatedAt = title, time.Now()
	return d.meta, nil
}

func (m *Memory) AllocClient(_ context.Context, uid, doc int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.d.clients = append(m.d.clients, memClient{user: uid, doc: doc, seen: time.Now()})
	return int64(len(m.d.clients)), nil
}

func (m *Memory) ClientOwner(_ context.Context, id int64) (int64, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id < 1 || int(id) > len(m.d.clients) {
		return 0, 0, ErrNotFound
	}
	c := m.d.clients[id-1]
	return c.user, c.doc, nil
}

func (m *Memory) SetAck(_ context.Context, id, seq int64, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id < 1 || int(id) > len(m.d.clients) {
		return ErrNotFound
	}
	c := &m.d.clients[id-1]
	c.acked = max(c.acked, seq)
	c.seen = now
	return nil
}

func (m *Memory) Horizon(_ context.Context, doc int64, since time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(doc)
	if d == nil {
		return 0, ErrNotFound
	}
	h := int64(len(d.ops))
	for _, c := range m.d.clients {
		if c.doc == doc && !c.seen.Before(since) {
			h = min(h, c.acked)
		}
	}
	return h, nil
}

func (m *Memory) AppendOps(_ context.Context, doc int64, ops []RawOp) ([]int64, error) {
	m.mu.Lock()
	d := m.doc(doc)
	if d == nil {
		m.mu.Unlock()
		return nil, ErrNotFound
	}
	seqs := make([]int64, len(ops))
	for i, op := range ops {
		k := [2]int64{op.ClientID, op.Clock}
		if d.ids[k] {
			continue
		}
		d.ids[k] = true
		seqs[i] = int64(len(d.ops) + 1)
		d.ops = append(d.ops, SeqOp{seqs[i], op.ClientID, op.Bytes})
		d.opAt = append(d.opAt, time.Now())
	}
	d.meta.UpdatedAt = time.Now()
	head := int64(len(d.ops))
	subs := slices.Clone(m.d.subs)
	m.mu.Unlock()
	for _, fn := range subs {
		fn(doc, head)
	}
	return seqs, nil
}

// AppendRestoreOps checks authorization and head while holding the same lock
// used by ordinary writes and grant changes; no partial batch is published.
func (m *Memory) AppendRestoreOps(ctx context.Context, guard RestoreGuard, doc, expectedHead int64, ops []RawOp) ([]int64, error) {
	m.mu.Lock()
	if err := ctx.Err(); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	session, ok := m.sessions[string(guard.SessionHash)]
	if !ok || session.userID != guard.UserID || !guard.currentTime().Before(session.expires) {
		m.mu.Unlock()
		return nil, ErrUnauthenticated
	}
	d := m.doc(doc)
	if d == nil || d.deleted || RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleEdit) {
		m.mu.Unlock()
		return nil, ErrForbidden
	}
	if int64(len(d.ops)) != expectedHead {
		m.mu.Unlock()
		return nil, ErrConflict
	}
	seen := make(map[[2]int64]bool, len(ops))
	for _, op := range ops {
		key := [2]int64{op.ClientID, op.Clock}
		if d.ids[key] || seen[key] {
			m.mu.Unlock()
			return nil, ErrConflict
		}
		seen[key] = true
	}
	if err := ctx.Err(); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	seqs := make([]int64, len(ops))
	rows := make([]SeqOp, len(ops))
	times := make([]time.Time, len(ops))
	now := time.Now()
	for i, op := range ops {
		seqs[i] = expectedHead + int64(i) + 1
		rows[i] = SeqOp{seqs[i], op.ClientID, op.Bytes}
		times[i] = now
	}
	if !guard.currentTime().Before(session.expires) {
		m.mu.Unlock()
		return nil, ErrUnauthenticated
	}
	if len(ops) == 0 {
		m.mu.Unlock()
		return seqs, nil
	}
	for key := range seen {
		d.ids[key] = true
	}
	d.ops = append(d.ops, rows...)
	d.opAt = append(d.opAt, times...)
	d.meta.UpdatedAt = now
	head := int64(len(d.ops))
	subs := slices.Clone(m.d.subs)
	m.mu.Unlock()
	for _, fn := range subs {
		fn(doc, head)
	}
	return seqs, nil
}

func (m *Memory) OpsAfter(_ context.Context, doc, after int64, limit int) ([]SeqOp, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(doc)
	if d == nil {
		return nil, ErrNotFound
	}
	if after >= int64(len(d.ops)) {
		return nil, nil
	}
	out := d.ops[after:]
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return slices.Clone(out), nil
}

func (m *Memory) Head(_ context.Context, doc int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(doc)
	if d == nil {
		return 0, ErrNotFound
	}
	return int64(len(d.ops)), nil
}

func (m *Memory) LatestSnapshot(_ context.Context, doc int64) (int64, []byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(doc)
	if d == nil {
		return 0, nil, ErrNotFound
	}
	var best int64 = -1
	for s := range d.snaps {
		best = max(best, s)
	}
	if best < 0 {
		return 0, nil, ErrNotFound
	}
	return best, slices.Clone(d.snaps[best]), nil
}

func (m *Memory) SaveSnapshot(_ context.Context, doc, seq int64, state []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(doc)
	if d == nil {
		return ErrNotFound
	}
	// Like Postgres ON CONFLICT DO NOTHING, snapshots are immutable for a
	// document/sequence pair. This also preserves any named version there.
	if _, exists := d.snaps[seq]; !exists {
		d.snaps[seq] = slices.Clone(state)
	}
	return nil
}

// Listen registers fn; in memory every append is delivered synchronously.
func (m *Memory) Listen(ctx context.Context, fn func(int64, int64)) error {
	m.mu.Lock()
	m.d.subs = append(m.d.subs, fn)
	m.mu.Unlock()
	<-ctx.Done()
	return nil
}

// AddMember adds a user to a workspace (tests).
func (m *Memory) AddMember(ws, uid int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.members[uid] = append(m.members[uid], ws)
}

func (m *Memory) subtree(id int64) []*memDoc {
	out := []*memDoc{m.doc(id)}
	for i := 0; i < len(out); i++ {
		for _, d := range m.d.docs {
			if d.meta.ParentID != nil && *d.meta.ParentID == out[i].meta.ID {
				out = append(out, d)
			}
		}
	}
	return out
}

func (m *Memory) setDeleted(id int64, v bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.doc(id) == nil {
		return ErrNotFound
	}
	for _, d := range m.subtree(id) {
		d.deleted = v
	}
	return nil
}

func (m *Memory) Trash(_ context.Context, id int64) error   { return m.setDeleted(id, true) }
func (m *Memory) Restore(_ context.Context, id int64) error { return m.setDeleted(id, false) }

func (m *Memory) ListTrash(_ context.Context, uid int64) ([]DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []DocMeta{}
	for _, d := range m.d.docs {
		if d.deleted && m.member(uid, d.meta.WorkspaceID) {
			out = append(out, d.meta)
		}
	}
	return out, nil
}

func (m *Memory) Move(_ context.Context, id int64, parent *int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(id)
	if d == nil {
		return ErrNotFound
	}
	if parent != nil {
		for _, x := range m.subtree(id) {
			if x.meta.ID == *parent {
				return ErrConflict
			}
		}
	}
	d.meta.ParentID = parent
	return nil
}

// wsName looks up a workspace's name (best effort).
func (m *Memory) wsName(id int64) string {
	for i := range m.workspaces {
		if m.workspaces[i].ID == id {
			return m.workspaces[i].Name
		}
	}
	return ""
}

func (m *Memory) userByID(id int64) *User {
	for i := range m.users {
		if m.users[i].ID == id {
			return &m.users[i]
		}
	}
	return nil
}

func (m *Memory) SaveVersion(_ context.Context, doc, seq int64, label string, userID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(doc)
	if d == nil {
		return ErrNotFound
	}
	if _, ok := d.snaps[seq]; !ok {
		return ErrNotFound
	}
	d.versions[seq] = memVersion{Label: label, UserID: userID, At: time.Now()}
	return nil
}

func (m *Memory) Versions(_ context.Context, doc int64) ([]Version, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Version{}
	for seq, v := range m.doc(doc).versions {
		name := ""
		if u := m.userByID(v.UserID); u != nil {
			name = u.Name
		}
		out = append(out, Version{Seq: seq, Label: v.Label, CreatedBy: v.UserID, CreatedByName: name, CreatedAt: v.At})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq > out[j].Seq })
	return out, nil
}

func (m *Memory) VersionState(_ context.Context, doc, seq int64) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(doc)
	if d == nil {
		return nil, ErrNotFound
	}
	if _, isVersion := d.versions[seq]; !isVersion {
		return nil, ErrNotFound
	}
	state, ok := d.snaps[seq]
	if !ok {
		return nil, ErrNotFound
	}
	return slices.Clone(state), nil
}

func (m *Memory) RecentDocIDs(_ context.Context, since time.Time) ([]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []int64{}
	for i, d := range m.d.docs {
		if !d.deleted {
			for _, at := range d.opAt {
				if at.After(since) {
					out = append(out, int64(i+1))
					break
				}
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

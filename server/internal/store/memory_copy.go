package store

import (
	"context"
	"time"
)

// CopyDoc commits the new node, cloned file references and initial log as a
// single critical section. The builder runs before any state is published.
func (m *Memory) CopyDoc(ctx context.Context, c DocCopy, build DocCopyBuilder) (DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expiry time.Time
	if c.Guard != nil {
		guard := c.Guard
		session, ok := m.sessions[string(guard.SessionHash)]
		if !ok || guard.UserID != c.UserID || session.userID != c.UserID || !guard.currentTime().Before(session.expires) {
			return DocMeta{}, ErrUnauthenticated
		}
		expiry = session.expires
	}
	source := m.doc(c.SourceID)
	if source == nil || source.deleted || RoleRank(m.roleLocked(c.UserID, source)) < RoleRank(RoleView) {
		return DocMeta{}, ErrNotFound
	}
	if source.meta.Kind != "doc" {
		return DocMeta{}, ErrConflict
	}
	if !DocumentDownloadAllowed(source.meta, m.roleLocked(c.UserID, source)) {
		return DocMeta{}, ErrCopyProtected
	}
	if c.UserID < 1 || c.UserID > int64(len(m.users)) || !m.member(c.UserID, c.WorkspaceID) {
		return DocMeta{}, ErrForbidden
	}
	if c.ParentID != nil {
		parent := m.doc(*c.ParentID)
		if parent == nil || parent.deleted || parent.meta.WorkspaceID != c.WorkspaceID || RoleRank(m.roleLocked(c.UserID, parent)) < RoleRank(RoleView) {
			return DocMeta{}, ErrNotFound
		}
	}
	if build == nil {
		return DocMeta{}, ErrConflict
	}
	if err := ctx.Err(); err != nil {
		return DocMeta{}, err
	}
	now := time.Now()
	newID := int64(len(m.d.docs) + 1)
	files := make([]FileMeta, 0, len(c.FileIDs))
	mapping := make(map[int64]int64, len(c.FileIDs))
	for _, oldID := range c.FileIDs {
		if _, exists := mapping[oldID]; exists {
			continue
		}
		if oldID < 1 || oldID > int64(len(m.sh.files)) {
			return DocMeta{}, ErrNotFound
		}
		original := m.sh.files[oldID-1]
		if original.DocID != c.SourceID {
			return DocMeta{}, ErrNotFound
		}
		original.ID = int64(len(m.sh.files) + len(files) + 1)
		original.DocID, original.UploaderID, original.CreatedAt = newID, c.UserID, now
		mapping[oldID] = original.ID
		files = append(files, original)
	}
	ops, err := build(mapping)
	if err != nil {
		return DocMeta{}, err
	}
	if err := ctx.Err(); err != nil {
		return DocMeta{}, err
	}
	if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
		return DocMeta{}, ErrUnauthenticated
	}
	var parentID *int64
	if c.ParentID != nil {
		id := *c.ParentID
		parentID = &id
	}
	d := &memDoc{
		meta: DocMeta{ID: newID, Kind: "doc", WorkspaceID: c.WorkspaceID, ParentID: parentID, Title: c.Title, CreatorID: c.UserID, CreatorName: m.users[c.UserID-1].Name, CreatedAt: now, UpdatedAt: now, CopyMinRole: RoleView, DownloadMinRole: RoleView},
		ids:  map[[2]int64]bool{}, snaps: map[int64][]byte{}, versions: map[int64]memVersion{},
	}
	for i, op := range ops {
		if d.ids[[2]int64{op.ClientID, op.Clock}] {
			return DocMeta{}, ErrConflict
		}
		d.ids[[2]int64{op.ClientID, op.Clock}] = true
		d.ops = append(d.ops, SeqOp{Seq: int64(i + 1), ClientID: op.ClientID, Bytes: append([]byte(nil), op.Bytes...)})
	}
	if err := ctx.Err(); err != nil {
		return DocMeta{}, err
	}
	if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
		return DocMeta{}, ErrUnauthenticated
	}
	m.sh.files = append(m.sh.files, files...)
	m.d.docs = append(m.d.docs, d)
	return d.meta, nil
}

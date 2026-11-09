package store

import (
	"context"
	"encoding/json"
	"slices"
	"sort"
	"time"
)

// slidesAccessLocked revalidates the session and requires edit access on a
// slides node. Caller holds m.mu.
func (m *Memory) slidesAccessLocked(ctx context.Context, g RestoreGuard, slidesID int64, needDeletedToo bool) (*memDoc, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s, ok := m.sessions[string(g.SessionHash)]
	if !ok || s.userID != g.UserID || !g.currentTime().Before(s.expires) {
		return nil, ErrUnauthenticated
	}
	d := m.doc(slidesID)
	if d == nil || d.meta.Kind != "slides" || (!needDeletedToo && (d.deleted || d.purged)) {
		return nil, ErrNotFound
	}
	if RoleRank(m.roleLocked(g.UserID, d)) < RoleRank(RoleEdit) {
		return nil, ErrForbidden
	}
	return d, nil
}

func (m *Memory) CreateSlidesPage(ctx context.Context, g RestoreGuard, slidesID int64, title string) (SlidesPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.slidesAccessLocked(ctx, g, slidesID, false); err != nil {
		return SlidesPage{}, err
	}
	pos := 1.0
	for _, p := range m.slides {
		if p.SlidesID == slidesID && p.Pos >= pos {
			pos = p.Pos + 1
		}
	}
	m.slidesSequence++
	page := SlidesPage{ID: m.slidesSequence, SlidesID: slidesID, Pos: pos, Title: title, Shapes: json.RawMessage(`[]`), Revision: 1, UpdatedAt: time.Now()}
	m.slides = append(m.slides, page)
	return page, nil
}

func (m *Memory) CreateSlidesFile(ctx context.Context, g RestoreGuard, slidesID int64, file FileMeta) (FileMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.slidesAccessLocked(ctx, g, slidesID, false); err != nil {
		return FileMeta{}, err
	}
	if !slideImageMIME(file.Mime) {
		return FileMeta{}, ErrConflict
	}
	file.ID = int64(len(m.sh.files) + 1)
	file.DocID, file.UploaderID, file.CreatedAt = slidesID, g.UserID, time.Now()
	m.sh.files = append(m.sh.files, file)
	return file, nil
}

func (m *Memory) ListSlidesPages(_ context.Context, uid, slidesID int64) ([]SlidesPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(slidesID)
	if d == nil || d.meta.Kind != "slides" || d.deleted || d.purged || RoleRank(m.roleLocked(uid, d)) < RoleRank(RoleView) {
		return nil, ErrForbidden
	}
	out := []SlidesPage{}
	for _, p := range m.slides {
		if p.SlidesID == slidesID {
			p.Shapes = slices.Clone(p.Shapes)
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Pos == out[j].Pos {
			return out[i].ID < out[j].ID
		}
		return out[i].Pos < out[j].Pos
	})
	return out, nil
}

func (m *Memory) findSlidesPageLocked(pageID int64) (int, *SlidesPage) {
	for i := range m.slides {
		if m.slides[i].ID == pageID {
			return i, &m.slides[i]
		}
	}
	return -1, nil
}

func (m *Memory) UpdateSlidesPage(ctx context.Context, g RestoreGuard, pageID int64, title, body, background string, notes *string, shapes *json.RawMessage, expectedRevision int64) (SlidesPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	i, p := m.findSlidesPageLocked(pageID)
	if p == nil {
		return SlidesPage{}, ErrNotFound
	}
	if _, err := m.slidesAccessLocked(ctx, g, p.SlidesID, false); err != nil {
		return SlidesPage{}, err
	}
	if expectedRevision < 1 || p.Revision != expectedRevision {
		return SlidesPage{}, ErrConflict
	}
	if shapes != nil {
		ids, err := slideImageIDs(*shapes)
		if err != nil {
			return SlidesPage{}, err
		}
		for _, id := range ids {
			if id < 1 || int(id) > len(m.sh.files) {
				return SlidesPage{}, ErrConflict
			}
			f := m.sh.files[id-1]
			if f.ID != id || f.DocID != p.SlidesID || !slideImageMIME(f.Mime) {
				return SlidesPage{}, ErrConflict
			}
		}
	}
	m.slides[i].Title, m.slides[i].Body, m.slides[i].Background = title, body, background
	if notes != nil {
		m.slides[i].Notes = *notes
	}
	if shapes != nil {
		m.slides[i].Shapes = slices.Clone(*shapes)
	}
	m.slides[i].Revision++
	m.slides[i].UpdatedAt = time.Now()
	result := m.slides[i]
	result.Shapes = slices.Clone(result.Shapes)
	return result, nil
}

func (m *Memory) DeleteSlidesPage(ctx context.Context, g RestoreGuard, pageID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, p := m.findSlidesPageLocked(pageID)
	if p == nil {
		return ErrNotFound
	}
	if _, err := m.slidesAccessLocked(ctx, g, p.SlidesID, false); err != nil {
		return err
	}
	filtered := make([]SlidesPage, 0, len(m.slides)-1)
	for _, x := range m.slides {
		if x.ID != pageID {
			filtered = append(filtered, x)
		}
	}
	m.slides = filtered
	return nil
}

func (m *Memory) MoveSlidesPage(ctx context.Context, g RestoreGuard, pageID int64, pos float64) error {
	if pos < 0 || !isFinitePos(pos) {
		return ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	i, p := m.findSlidesPageLocked(pageID)
	if p == nil {
		return ErrNotFound
	}
	if _, err := m.slidesAccessLocked(ctx, g, p.SlidesID, false); err != nil {
		return err
	}
	m.slides[i].Pos = pos
	m.slides[i].UpdatedAt = time.Now()
	return nil
}

func isFinitePos(p float64) bool { return p >= 0 && p < 1e308 }

// CopySlidesDeck publishes the new slides node, remapped image references and
// every source page as one critical section, mirroring the Postgres
// implementation. Image blobs are shared by object key.
func (m *Memory) CopySlidesDeck(ctx context.Context, c SlidesDeckCopy) (DocMeta, []SlidesPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expiry time.Time
	if c.Guard != nil {
		guard := c.Guard
		session, ok := m.sessions[string(guard.SessionHash)]
		if !ok || guard.UserID != c.UserID || session.userID != c.UserID || !guard.currentTime().Before(session.expires) {
			return DocMeta{}, nil, ErrUnauthenticated
		}
		expiry = session.expires
	}
	source := m.doc(c.SourceID)
	if source == nil || source.deleted || source.purged {
		return DocMeta{}, nil, ErrNotFound
	}
	if source.meta.Kind != "slides" {
		return DocMeta{}, nil, ErrConflict
	}
	if RoleRank(m.roleLocked(c.UserID, source)) < RoleRank(RoleView) {
		return DocMeta{}, nil, ErrNotFound
	}
	if !DocumentDownloadAllowed(source.meta, m.roleLocked(c.UserID, source)) {
		return DocMeta{}, nil, ErrCopyProtected
	}
	if c.UserID < 1 || c.UserID > int64(len(m.users)) || !m.member(c.UserID, c.WorkspaceID) {
		return DocMeta{}, nil, ErrForbidden
	}
	personal := source.personal
	var parentID *int64
	if c.ParentID != nil {
		parent := m.doc(*c.ParentID)
		if parent == nil || parent.deleted || parent.meta.Kind == "file" || parent.meta.WorkspaceID != c.WorkspaceID || RoleRank(m.roleLocked(c.UserID, parent)) < RoleRank(RoleView) {
			return DocMeta{}, nil, ErrNotFound
		}
		personal = parent.personal
		id := *c.ParentID
		parentID = &id
	}
	if err := ctx.Err(); err != nil {
		return DocMeta{}, nil, err
	}
	pages := []SlidesPage{}
	for _, p := range m.slides {
		if p.SlidesID == c.SourceID {
			p.Shapes = slices.Clone(p.Shapes)
			pages = append(pages, p)
		}
	}
	sort.Slice(pages, func(i, j int) bool {
		if pages[i].Pos == pages[j].Pos {
			return pages[i].ID < pages[j].ID
		}
		return pages[i].Pos < pages[j].Pos
	})
	var imageIDs []int64
	seen := map[int64]bool{}
	for _, page := range pages {
		ids, err := slideImageIDs(page.Shapes)
		if err != nil {
			return DocMeta{}, nil, err
		}
		for _, id := range ids {
			if !seen[id] {
				seen[id] = true
				imageIDs = append(imageIDs, id)
			}
		}
	}
	now := time.Now()
	newID := int64(len(m.d.docs) + 1)
	mapping := make(map[int64]int64, len(imageIDs))
	files := make([]FileMeta, 0, len(imageIDs))
	for _, oldID := range imageIDs {
		if oldID < 1 || oldID > int64(len(m.sh.files)) {
			return DocMeta{}, nil, ErrNotFound
		}
		original := m.sh.files[oldID-1]
		if original.ID != oldID || original.DocID != c.SourceID {
			return DocMeta{}, nil, ErrNotFound
		}
		if !slideImageMIME(original.Mime) {
			return DocMeta{}, nil, ErrConflict
		}
		clone := original
		clone.ID = int64(len(m.sh.files) + len(files) + 1)
		clone.DocID, clone.UploaderID, clone.CreatedAt = newID, c.UserID, now
		mapping[oldID] = clone.ID
		files = append(files, clone)
	}
	if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
		return DocMeta{}, nil, ErrUnauthenticated
	}
	meta := DocMeta{ID: newID, Kind: "slides", WorkspaceID: c.WorkspaceID, ParentID: parentID, Title: c.Title, CreatorID: c.UserID, CreatorName: m.users[c.UserID-1].Name, CreatedAt: now, UpdatedAt: now, DriveRevision: 1}
	d := &memDoc{meta: meta, driveRevision: 1, personal: personal, ids: map[[2]int64]bool{}, snaps: map[int64][]byte{}, versions: map[int64]memVersion{}}
	m.sh.files = append(m.sh.files, files...)
	m.d.docs = append(m.d.docs, d)
	copied := make([]SlidesPage, 0, len(pages))
	for _, page := range pages {
		shapes, err := remapSlideShapes(page.Shapes, mapping)
		if err != nil {
			return DocMeta{}, nil, err
		}
		m.slidesSequence++
		next := SlidesPage{ID: m.slidesSequence, SlidesID: newID, Pos: page.Pos, Title: page.Title, Body: page.Body, Background: page.Background, Notes: page.Notes, Shapes: shapes, Revision: 1, UpdatedAt: now}
		m.slides = append(m.slides, next)
		copied = append(copied, next)
	}
	if err := ctx.Err(); err != nil {
		return DocMeta{}, nil, err
	}
	return meta, copied, nil
}

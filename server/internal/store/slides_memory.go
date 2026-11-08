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

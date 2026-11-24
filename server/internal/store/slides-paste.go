package store

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

// SlidesPasteStore copies a verified source into the same deck after a verified anchor.
type SlidesPasteStore interface {
	PasteSlidesPage(context.Context, RestoreGuard, int64, int64, int64, int64, int64) (SlidesPage, error)
}

func (m *Memory) PasteSlidesPage(ctx context.Context, g RestoreGuard, deck, sourceID, sourceRevision, anchorID, anchorRevision int64) (SlidesPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, err := m.slidesAccessLocked(ctx, g, deck, false)
	if err != nil {
		return SlidesPage{}, err
	}
	if !DocumentCopyAllowed(d.meta, m.roleLocked(g.UserID, d)) {
		return SlidesPage{}, ErrCopyProtected
	}
	_, source := m.findSlidesPageLocked(sourceID)
	_, anchor := m.findSlidesPageLocked(anchorID)
	if source == nil || anchor == nil || source.SlidesID != deck || anchor.SlidesID != deck {
		return SlidesPage{}, ErrNotFound
	}
	if sourceRevision < 1 || anchorRevision < 1 || source.Revision != sourceRevision || anchor.Revision != anchorRevision {
		return SlidesPage{}, ErrConflict
	}
	var next *float64
	for _, p := range m.slides {
		if p.SlidesID == deck && p.ID != anchorID && (p.Pos > anchor.Pos || p.Pos == anchor.Pos && p.ID > anchor.ID) && (next == nil || p.Pos < *next) {
			pos := p.Pos
			next = &pos
		}
	}
	pos, err := slideCopyPosition(anchor.Pos, next)
	if err != nil {
		return SlidesPage{}, err
	}
	// Revalidate the session at the end of the same critical section.
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return SlidesPage{}, err
	}
	if err = driveMemoryEnd(ctx, g, expires); err != nil {
		return SlidesPage{}, err
	}
	page := *source
	page.Shapes = slices.Clone(source.Shapes)
	page.Meta = cloneSlideMeta(source.Meta)
	m.slidesSequence++
	page.ID, page.Pos, page.Revision, page.UpdatedAt = m.slidesSequence, pos, 1, time.Now()
	m.slides = append(m.slides, page)
	page.Shapes = slices.Clone(page.Shapes)
	page.Meta = cloneSlideMeta(page.Meta)
	return page, nil
}

func (p *Postgres) PasteSlidesPage(ctx context.Context, g RestoreGuard, deck, sourceID, sourceRevision, anchorID, anchorRevision int64) (out SlidesPage, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		// Lock the two pages in id order, matching reorder's lock order.
		rows, e := tx.Query(ctx, `SELECT id,slides_id,pos,title,body,background,notes,shapes,hidden,layout,meta,revision,updated_at FROM slides_pages WHERE slides_id=$1 AND id IN ($2,$3) ORDER BY id FOR UPDATE`, deck, sourceID, anchorID)
		if e != nil {
			return e
		}
		var source, anchor SlidesPage
		for rows.Next() {
			var page SlidesPage
			if e = rows.Scan(&page.ID, &page.SlidesID, &page.Pos, &page.Title, &page.Body, &page.Background, &page.Notes, &page.Shapes, &page.Hidden, &page.Layout, &page.Meta, &page.Revision, &page.UpdatedAt); e != nil {
				rows.Close()
				return e
			}
			if page.ID == sourceID {
				source = page
			}
			if page.ID == anchorID {
				anchor = page
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		if source.ID == 0 || anchor.ID == 0 {
			return ErrNotFound
		}
		expires, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		var copyMin string
		e = tx.QueryRow(ctx, `SELECT copy_min_role FROM nodes WHERE id=$1 FOR UPDATE`, deck).Scan(&copyMin)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		role, protected, kind, e := lockCopySource(ctx, tx, deck, g.UserID)
		if e != nil {
			return e
		}
		if kind != "slides" {
			return ErrNotFound
		}
		if RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		if !DocumentCopyAllowed(DocMeta{Kind: kind, CopyProtected: protected, CopyMinRole: copyMin}, role) {
			return ErrCopyProtected
		}
		if sourceRevision < 1 || anchorRevision < 1 || source.Revision != sourceRevision || anchor.Revision != anchorRevision {
			return ErrConflict
		}
		var nextValue float64
		e = tx.QueryRow(ctx, `SELECT pos FROM slides_pages WHERE slides_id=$1 AND (pos,id)>($2,$3) ORDER BY pos,id LIMIT 1`, deck, anchor.Pos, anchor.ID).Scan(&nextValue)
		var next *float64
		if e == nil {
			next = &nextValue
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		pos, e := slideCopyPosition(anchor.Pos, next)
		if e != nil {
			return e
		}
		if e = drivePGEnd(ctx, g, expires); e != nil {
			return e
		}
		e = tx.QueryRow(ctx, `INSERT INTO slides_pages (slides_id,pos,title,body,background,notes,shapes,hidden,layout,meta) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb) RETURNING id,slides_id,pos,title,body,background,notes,shapes,hidden,layout,meta,revision,updated_at`, deck, pos, source.Title, source.Body, source.Background, source.Notes, source.Shapes, source.Hidden, source.Layout, slideMetaForPG(source.Meta)).
			Scan(&out.ID, &out.SlidesID, &out.Pos, &out.Title, &out.Body, &out.Background, &out.Notes, &out.Shapes, &out.Hidden, &out.Layout, &out.Meta, &out.Revision, &out.UpdatedAt)
		if e != nil {
			return e
		}
		out.Meta = normalizeDBSlideMeta(out.Meta)
		return drivePGEnd(ctx, g, expires)
	})
	if err != nil {
		return SlidesPage{}, drivePGError(err)
	}
	return out, nil
}

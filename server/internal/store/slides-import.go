package store

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

const slidesMaxImportPages = 100

// ImportedSlidePage represents one sanitized slide for atomic deck replacement or undo restore.
type ImportedSlidePage struct {
	Title      string          `json:"title"`
	Body       string          `json:"body"`
	Background string          `json:"background"`
	Layout     string          `json:"layout"`
	Notes      string          `json:"notes"`
	Hidden     bool            `json:"hidden"`
	Shapes     json.RawMessage `json:"shapes"`
}

// SlidesDeckImportStore supports atomic PPTX deck replacement and deleted-page restore.
type SlidesDeckImportStore interface {
	ReplaceSlidesDeckGuarded(ctx context.Context, guard RestoreGuard, slidesID int64, pages []ImportedSlidePage) ([]SlidesPage, error)
	RestoreSlidesPageGuarded(ctx context.Context, guard RestoreGuard, slidesID int64, page ImportedSlidePage, targetIndex int) ([]SlidesPage, SlidesPage, error)
}

func normalizeImportedSlide(p ImportedSlidePage) (ImportedSlidePage, bool) {
	if len([]rune(p.Title)) > 200 || len(p.Body) > 20000 || len(p.Background) > 200 || len(p.Notes) > 20000 {
		return ImportedSlidePage{}, false
	}
	if !ValidSlideLayout(p.Layout) {
		return ImportedSlidePage{}, false
	}
	if len(p.Shapes) == 0 {
		p.Shapes = json.RawMessage(`[]`)
	}
	if !json.Valid(p.Shapes) {
		return ImportedSlidePage{}, false
	}
	return p, true
}

func (m *Memory) ReplaceSlidesDeckGuarded(ctx context.Context, g RestoreGuard, slidesID int64, rawPages []ImportedSlidePage) ([]SlidesPage, error) {
	if len(rawPages) == 0 || len(rawPages) > slidesMaxImportPages {
		return nil, ErrConflict
	}
	pages := make([]ImportedSlidePage, len(rawPages))
	for i, raw := range rawPages {
		norm, ok := normalizeImportedSlide(raw)
		if !ok {
			return nil, ErrConflict
		}
		pages[i] = norm
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, err := m.slidesAccessLocked(ctx, g, slidesID, false)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	// Remove existing pages for this deck
	m.slides = slices.DeleteFunc(m.slides, func(p SlidesPage) bool { return p.SlidesID == slidesID })
	out := make([]SlidesPage, 0, len(pages))
	for i, imp := range pages {
		m.slidesSequence++
		sp := SlidesPage{
			ID:         m.slidesSequence,
			SlidesID:   slidesID,
			Pos:        float64(i + 1),
			Title:      imp.Title,
			Body:       imp.Body,
			Background: imp.Background,
			Notes:      imp.Notes,
			Shapes:     slices.Clone(imp.Shapes),
			Hidden:     imp.Hidden,
			Layout:     imp.Layout,
			Revision:   1,
			UpdatedAt:  now,
		}
		m.slides = append(m.slides, sp)
		out = append(out, sp)
	}
	d.meta.UpdatedAt = now
	m.setDocumentModifierLocked(d, g.UserID)
	return out, nil
}

func (m *Memory) RestoreSlidesPageGuarded(ctx context.Context, g RestoreGuard, slidesID int64, raw ImportedSlidePage, targetIndex int) ([]SlidesPage, SlidesPage, error) {
	imp, ok := normalizeImportedSlide(raw)
	if !ok {
		return nil, SlidesPage{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, err := m.slidesAccessLocked(ctx, g, slidesID, false)
	if err != nil {
		return nil, SlidesPage{}, err
	}
	// Collect current pages in display order
	existing := make([]SlidesPage, 0)
	for _, p := range m.slides {
		if p.SlidesID == slidesID {
			existing = append(existing, p)
		}
	}
	sort.Slice(existing, func(i, j int) bool {
		if existing[i].Pos != existing[j].Pos {
			return existing[i].Pos < existing[j].Pos
		}
		return existing[i].ID < existing[j].ID
	})
	if len(existing) >= slidesMaxImportPages {
		return nil, SlidesPage{}, ErrConflict
	}
	if targetIndex < 0 {
		targetIndex = 0
	}
	if targetIndex > len(existing) {
		targetIndex = len(existing)
	}
	now := time.Now()
	m.slidesSequence++
	restored := SlidesPage{
		ID:         m.slidesSequence,
		SlidesID:   slidesID,
		Title:      imp.Title,
		Body:       imp.Body,
		Background: imp.Background,
		Notes:      imp.Notes,
		Shapes:     slices.Clone(imp.Shapes),
		Hidden:     imp.Hidden,
		Layout:     imp.Layout,
		Revision:   1,
		UpdatedAt:  now,
	}
	ordered := slices.Insert(existing, targetIndex, restored)
	for i := range ordered {
		ordered[i].Pos = float64(i + 1)
	}
	restored.Pos = float64(targetIndex + 1)
	// Replace this deck's slice entries cleanly
	m.slides = slices.DeleteFunc(m.slides, func(p SlidesPage) bool { return p.SlidesID == slidesID })
	m.slides = append(m.slides, ordered...)
	d.meta.UpdatedAt = now
	m.setDocumentModifierLocked(d, g.UserID)
	out := make([]SlidesPage, len(ordered))
	for i, p := range ordered {
		p.Shapes = slices.Clone(p.Shapes)
		out[i] = p
	}
	restored.Shapes = slices.Clone(restored.Shapes)
	return out, restored, nil
}

func (p *Postgres) ReplaceSlidesDeckGuarded(ctx context.Context, g RestoreGuard, slidesID int64, rawPages []ImportedSlidePage) (out []SlidesPage, err error) {
	if len(rawPages) == 0 || len(rawPages) > slidesMaxImportPages {
		return nil, ErrConflict
	}
	pages := make([]ImportedSlidePage, len(rawPages))
	for i, raw := range rawPages {
		norm, ok := normalizeImportedSlide(raw)
		if !ok {
			return nil, ErrConflict
		}
		pages[i] = norm
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if e := p.slidesAccessGuarded(ctx, tx, g, slidesID); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `SELECT id FROM nodes WHERE id=$1 FOR UPDATE`, slidesID); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `DELETE FROM slides_pages WHERE slides_id=$1`, slidesID); e != nil {
			return e
		}
		out = make([]SlidesPage, 0, len(pages))
		for i, imp := range pages {
			var sp SlidesPage
			e := tx.QueryRow(ctx, `
				INSERT INTO slides_pages (slides_id, pos, title, body, background, notes, shapes, hidden, layout, revision)
				VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 1)
				RETURNING id, slides_id, pos, title, body, background, notes, shapes, hidden, layout, revision, updated_at
			`, slidesID, float64(i+1), imp.Title, imp.Body, imp.Background, imp.Notes, string(imp.Shapes), imp.Hidden, imp.Layout).Scan(
				&sp.ID, &sp.SlidesID, &sp.Pos, &sp.Title, &sp.Body, &sp.Background, &sp.Notes, &sp.Shapes, &sp.Hidden, &sp.Layout, &sp.Revision, &sp.UpdatedAt,
			)
			if e != nil {
				return e
			}
			out = append(out, sp)
		}
		if _, e := tx.Exec(ctx, `UPDATE nodes SET updated_at=now() WHERE id=$1`, slidesID); e != nil {
			return e
		}
		return recordDocumentModifier(ctx, tx, slidesID, g.UserID)
	})
	if err != nil {
		return nil, drivePGError(err)
	}
	return out, nil
}

func (p *Postgres) RestoreSlidesPageGuarded(ctx context.Context, g RestoreGuard, slidesID int64, raw ImportedSlidePage, targetIndex int) (all []SlidesPage, restored SlidesPage, err error) {
	imp, ok := normalizeImportedSlide(raw)
	if !ok {
		return nil, SlidesPage{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if e := p.slidesAccessGuarded(ctx, tx, g, slidesID); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `SELECT id FROM nodes WHERE id=$1 FOR UPDATE`, slidesID); e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `SELECT id, pos FROM slides_pages WHERE slides_id=$1 ORDER BY pos, id FOR UPDATE`, slidesID)
		if e != nil {
			return e
		}
		var existingIDs []int64
		for rows.Next() {
			var id int64
			var pos float64
			if e = rows.Scan(&id, &pos); e != nil {
				rows.Close()
				return e
			}
			existingIDs = append(existingIDs, id)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
		if len(existingIDs) >= slidesMaxImportPages {
			return ErrConflict
		}
		idx := targetIndex
		if idx < 0 {
			idx = 0
		}
		if idx > len(existingIDs) {
			idx = len(existingIDs)
		}
		// Insert with temporary high pos, then normalize all positions cleanly to 1..N.
		tempPos := float64(len(existingIDs)+1000) + math.Max(1, float64(idx))
		e = tx.QueryRow(ctx, `
			INSERT INTO slides_pages (slides_id, pos, title, body, background, notes, shapes, hidden, layout, revision)
			VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 1)
			RETURNING id, slides_id, pos, title, body, background, notes, shapes, hidden, layout, revision, updated_at
		`, slidesID, tempPos, imp.Title, imp.Body, imp.Background, imp.Notes, string(imp.Shapes), imp.Hidden, imp.Layout).Scan(
			&restored.ID, &restored.SlidesID, &restored.Pos, &restored.Title, &restored.Body, &restored.Background, &restored.Notes, &restored.Shapes, &restored.Hidden, &restored.Layout, &restored.Revision, &restored.UpdatedAt,
		)
		if e != nil {
			return e
		}
		orderedIDs := slices.Insert(existingIDs, idx, restored.ID)
		posVals := make([]float64, len(orderedIDs))
		for i := range orderedIDs {
			posVals[i] = float64(i + 1)
		}
		if _, e = tx.Exec(ctx, `UPDATE slides_pages sp SET pos = t.p FROM unnest($1::bigint[], $2::float8[]) AS t(id, p) WHERE sp.id = t.id`, orderedIDs, posVals); e != nil {
			return e
		}
		restored.Pos = float64(idx + 1)
		allRows, e := tx.Query(ctx, `SELECT id, slides_id, pos, title, body, background, notes, shapes, hidden, layout, revision, updated_at FROM slides_pages WHERE slides_id=$1 ORDER BY pos, id`, slidesID)
		if e != nil {
			return e
		}
		all = make([]SlidesPage, 0, len(orderedIDs))
		for allRows.Next() {
			var sp SlidesPage
			if e = allRows.Scan(&sp.ID, &sp.SlidesID, &sp.Pos, &sp.Title, &sp.Body, &sp.Background, &sp.Notes, &sp.Shapes, &sp.Hidden, &sp.Layout, &sp.Revision, &sp.UpdatedAt); e != nil {
				allRows.Close()
				return e
			}
			all = append(all, sp)
		}
		if e = allRows.Err(); e != nil {
			allRows.Close()
			return e
		}
		allRows.Close()
		if _, e = tx.Exec(ctx, `UPDATE nodes SET updated_at=now() WHERE id=$1`, slidesID); e != nil {
			return e
		}
		return recordDocumentModifier(ctx, tx, slidesID, g.UserID)
	})
	if err != nil {
		return nil, SlidesPage{}, drivePGError(err)
	}
	return all, restored, nil
}

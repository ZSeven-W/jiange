package store

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// SlidesCrossPasteStore atomically remaps verified image references when a page
// is pasted into another deck. Image bytes share immutable object keys.
type SlidesCrossPasteStore interface {
	PasteSlidesPageFrom(context.Context, RestoreGuard, int64, int64, int64, int64, int64, int64, []int64) (SlidesPage, map[int64]int64, error)
}

func (m *Memory) PasteSlidesPageFrom(ctx context.Context, g RestoreGuard, targetDeck, sourceDeck, sourceID, sourceRevision, anchorID, anchorRevision int64, verified []int64) (SlidesPage, map[int64]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if targetDeck == sourceDeck || verified == nil {
		return SlidesPage{}, nil, ErrConflict
	}
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return SlidesPage{}, nil, err
	}
	srcDoc := m.doc(sourceDeck)
	if srcDoc == nil || srcDoc.deleted || srcDoc.purged || srcDoc.meta.Kind != "slides" || !m.driveValidChainLocked(srcDoc, srcDoc.meta.WorkspaceID, false) || RoleRank(m.roleLocked(g.UserID, srcDoc)) < RoleRank(RoleView) {
		return SlidesPage{}, nil, ErrNotFound
	}
	if !DocumentCopyAllowed(srcDoc.meta, m.roleLocked(g.UserID, srcDoc)) {
		return SlidesPage{}, nil, ErrCopyProtected
	}
	targetDoc, err := m.slidesAccessLocked(ctx, g, targetDeck, false)
	if err != nil {
		return SlidesPage{}, nil, err
	}
	if !m.driveValidChainLocked(targetDoc, targetDoc.meta.WorkspaceID, false) {
		return SlidesPage{}, nil, ErrForbidden
	}
	_, src := m.findSlidesPageLocked(sourceID)
	_, anchor := m.findSlidesPageLocked(anchorID)
	if src == nil || anchor == nil || src.SlidesID != sourceDeck || anchor.SlidesID != targetDeck {
		return SlidesPage{}, nil, ErrNotFound
	}
	if sourceRevision < 1 || anchorRevision < 1 || src.Revision != sourceRevision || anchor.Revision != anchorRevision {
		return SlidesPage{}, nil, ErrConflict
	}
	ids, err := slideImageIDs(src.Shapes)
	if err != nil {
		return SlidesPage{}, nil, err
	}
	if !sameSlideImageIDs(verified, ids) {
		return SlidesPage{}, nil, ErrConflict
	}
	var next *float64
	for _, p := range m.slides {
		if p.SlidesID == targetDeck && p.ID != anchorID && (p.Pos > anchor.Pos || p.Pos == anchor.Pos && p.ID > anchor.ID) && (next == nil || p.Pos < *next) {
			pos := p.Pos
			next = &pos
		}
	}
	pos, err := slideCopyPosition(anchor.Pos, next)
	if err != nil {
		return SlidesPage{}, nil, err
	}
	now := time.Now()
	mapping := make(map[int64]int64, len(ids))
	files := make([]FileMeta, 0, len(ids))
	for _, id := range ids {
		if id < 1 || id > int64(len(m.sh.files)) {
			return SlidesPage{}, nil, ErrNotFound
		}
		original := m.sh.files[id-1]
		if original.ID != id || original.DocID != sourceDeck {
			return SlidesPage{}, nil, ErrNotFound
		}
		if !slideImageMIME(original.Mime) {
			return SlidesPage{}, nil, ErrConflict
		}
		clone := original
		clone.ID = int64(len(m.sh.files) + len(files) + 1)
		clone.DocID = targetDeck
		clone.UploaderID = g.UserID
		clone.CreatedAt = now
		mapping[id] = clone.ID
		files = append(files, clone)
	}
	shapes, err := remapSlideShapes(src.Shapes, mapping)
	if err != nil {
		return SlidesPage{}, nil, err
	}
	if err = driveMemoryEnd(ctx, g, expires); err != nil {
		return SlidesPage{}, nil, err
	}
	page := *src
	page.Shapes = append([]byte(nil), shapes...)
	m.slidesSequence++
	page.ID = m.slidesSequence
	page.SlidesID = targetDeck
	page.Pos = pos
	page.Revision = 1
	page.UpdatedAt = now
	m.sh.files = append(m.sh.files, files...)
	m.slides = append(m.slides, page)
	page.Shapes = append([]byte(nil), page.Shapes...)
	return page, mapping, nil
}

func (p *Postgres) PasteSlidesPageFrom(ctx context.Context, g RestoreGuard, targetDeck, sourceDeck, sourceID, sourceRevision, anchorID, anchorRevision int64, verified []int64) (out SlidesPage, mapping map[int64]int64, err error) {
	if targetDeck == sourceDeck || verified == nil {
		return out, nil, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		// Match existing slide mutations: page locks in id order, then node locks.
		rows, e := tx.Query(ctx, `SELECT id,slides_id,pos,title,body,background,notes,shapes,hidden,layout,revision,updated_at FROM slides_pages WHERE (id=$1 AND slides_id=$2) OR (id=$3 AND slides_id=$4) ORDER BY id FOR UPDATE`, sourceID, sourceDeck, anchorID, targetDeck)
		if e != nil {
			return e
		}
		var src, anchor SlidesPage
		for rows.Next() {
			var page SlidesPage
			if e = rows.Scan(&page.ID, &page.SlidesID, &page.Pos, &page.Title, &page.Body, &page.Background, &page.Notes, &page.Shapes, &page.Hidden, &page.Layout, &page.Revision, &page.UpdatedAt); e != nil {
				rows.Close()
				return e
			}
			if page.ID == sourceID {
				src = page
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
		if src.ID == 0 || anchor.ID == 0 {
			return ErrNotFound
		}
		expires, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		nodes, e := tx.Query(ctx, `SELECT id,copy_min_role,workspace_id FROM nodes WHERE id IN ($1,$2) ORDER BY id FOR UPDATE`, sourceDeck, targetDeck)
		if e != nil {
			return e
		}
		var sourceCopyMin string
		var sourceWorkspace, targetWorkspace int64
		count := 0
		for nodes.Next() {
			var id, workspace int64
			var copyMin string
			if e = nodes.Scan(&id, &copyMin, &workspace); e != nil {
				nodes.Close()
				return e
			}
			count++
			if id == sourceDeck {
				sourceCopyMin = copyMin
				sourceWorkspace = workspace
			} else {
				targetWorkspace = workspace
			}
		}
		e = nodes.Err()
		nodes.Close()
		if e != nil {
			return e
		}
		if count != 2 {
			return ErrNotFound
		}
		if e = drivePGValidChain(ctx, tx, sourceDeck, sourceWorkspace); e != nil {
			return e
		}
		if e = drivePGValidChain(ctx, tx, targetDeck, targetWorkspace); e != nil {
			return e
		}
		srcRole, protected, srcKind, e := lockCopySource(ctx, tx, sourceDeck, g.UserID)
		if e != nil {
			return e
		}
		dstRole, _, dstKind, e := lockCopySource(ctx, tx, targetDeck, g.UserID)
		if e != nil {
			return e
		}
		if srcKind != "slides" || dstKind != "slides" {
			return ErrNotFound
		}
		if RoleRank(srcRole) < RoleRank(RoleView) || RoleRank(dstRole) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		if !DocumentCopyAllowed(DocMeta{Kind: srcKind, CopyProtected: protected, CopyMinRole: sourceCopyMin}, srcRole) {
			return ErrCopyProtected
		}
		if sourceRevision < 1 || anchorRevision < 1 || src.Revision != sourceRevision || anchor.Revision != anchorRevision {
			return ErrConflict
		}
		ids, e := slideImageIDs(src.Shapes)
		if e != nil {
			return e
		}
		if !sameSlideImageIDs(verified, ids) {
			return ErrConflict
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		var nextValue float64
		e = tx.QueryRow(ctx, `SELECT pos FROM slides_pages WHERE slides_id=$1 AND (pos,id)>($2,$3) ORDER BY pos,id LIMIT 1`, targetDeck, anchor.Pos, anchor.ID).Scan(&nextValue)
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
		mapping = make(map[int64]int64, len(ids))
		for _, id := range ids {
			var mime string
			e = tx.QueryRow(ctx, `SELECT mime FROM attachments WHERE id=$1 AND doc_id=$2 FOR SHARE`, id, sourceDeck).Scan(&mime)
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if e != nil {
				return e
			}
			if !slideImageMIME(mime) {
				return ErrConflict
			}
			var newID int64
			e = tx.QueryRow(ctx, `INSERT INTO attachments (doc_id,uploader_id,name,mime,size,object_key) SELECT $1,$2,name,mime,size,object_key FROM attachments WHERE id=$3 AND doc_id=$4 RETURNING id`, targetDeck, g.UserID, id, sourceDeck).Scan(&newID)
			if e != nil {
				return e
			}
			mapping[id] = newID
		}
		shapes, e := remapSlideShapes(src.Shapes, mapping)
		if e != nil {
			return e
		}
		if e = drivePGEnd(ctx, g, expires); e != nil {
			return e
		}
		e = tx.QueryRow(ctx, `INSERT INTO slides_pages (slides_id,pos,title,body,background,notes,shapes,hidden,layout) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id,slides_id,pos,title,body,background,notes,shapes,hidden,layout,revision,updated_at`, targetDeck, pos, src.Title, src.Body, src.Background, src.Notes, shapes, src.Hidden, src.Layout).Scan(&out.ID, &out.SlidesID, &out.Pos, &out.Title, &out.Body, &out.Background, &out.Notes, &out.Shapes, &out.Hidden, &out.Layout, &out.Revision, &out.UpdatedAt)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	if err != nil {
		return SlidesPage{}, nil, drivePGError(err)
	}
	return out, mapping, nil
}

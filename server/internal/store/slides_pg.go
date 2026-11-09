package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// slidesAccessGuarded revalidates the session and requires edit access on the
// slides node inside the caller's transaction.
func (p *Postgres) slidesAccessGuarded(ctx context.Context, tx pgx.Tx, g RestoreGuard, slidesID int64) error {
	expiry, err := drivePGSession(ctx, tx, g)
	if err != nil {
		return err
	}
	if !g.currentTime().Before(expiry) {
		return ErrUnauthenticated
	}
	role, _, kind, err := lockCopySource(ctx, tx, slidesID, g.UserID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return ErrNotFound
		}
		return err
	}
	if kind != "slides" {
		return ErrNotFound
	}
	if RoleRank(role) < RoleRank(RoleEdit) {
		return ErrForbidden
	}
	return nil
}

func (p *Postgres) CreateSlidesPage(ctx context.Context, g RestoreGuard, slidesID int64, title string) (page SlidesPage, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if e := p.slidesAccessGuarded(ctx, tx, g, slidesID); e != nil {
			return e
		}
		e := tx.QueryRow(ctx, `INSERT INTO slides_pages (slides_id, pos, title)
			SELECT $1, COALESCE(max(pos), 0) + 1, $2 FROM slides_pages WHERE slides_id=$1
			RETURNING id, slides_id, pos, title, body, background, notes, shapes, revision, updated_at`, slidesID, title).
			Scan(&page.ID, &page.SlidesID, &page.Pos, &page.Title, &page.Body, &page.Background, &page.Notes, &page.Shapes, &page.Revision, &page.UpdatedAt)
		return e
	})
	if err != nil {
		return SlidesPage{}, err
	}
	return page, nil
}

func (p *Postgres) CreateSlidesFile(ctx context.Context, g RestoreGuard, slidesID int64, file FileMeta) (out FileMeta, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if e := p.slidesAccessGuarded(ctx, tx, g, slidesID); e != nil {
			return e
		}
		if !slideImageMIME(file.Mime) {
			return ErrConflict
		}
		out = file
		out.DocID, out.UploaderID = slidesID, g.UserID
		if e := tx.QueryRow(ctx, `INSERT INTO attachments (doc_id,uploader_id,name,mime,size,object_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,created_at`, slidesID, g.UserID, file.Name, file.Mime, file.Size, file.ObjectKey).Scan(&out.ID, &out.CreatedAt); e != nil {
			return e
		}
		expires, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	if err != nil {
		return FileMeta{}, err
	}
	return out, nil
}

func (p *Postgres) ListSlidesPages(ctx context.Context, userID, slidesID int64) (out []SlidesPage, err error) {
	rows, err := p.Pool.Query(ctx, `SELECT sp.id, sp.slides_id, sp.pos, sp.title, sp.body, sp.background, sp.notes, sp.shapes, sp.revision, sp.updated_at
		FROM slides_pages sp JOIN nodes n ON n.id = sp.slides_id`+roleJoins+`
		WHERE sp.slides_id=$2 AND n.kind='slides' AND n.deleted_at IS NULL AND (`+roleSQL+`)<>'' ORDER BY sp.pos, sp.id`, userID, slidesID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out = []SlidesPage{}
	for rows.Next() {
		var pg SlidesPage
		if err = rows.Scan(&pg.ID, &pg.SlidesID, &pg.Pos, &pg.Title, &pg.Body, &pg.Background, &pg.Notes, &pg.Shapes, &pg.Revision, &pg.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, pg)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateSlidesPage(ctx context.Context, g RestoreGuard, pageID int64, title, body, background string, notes *string, shapes *json.RawMessage, expectedRevision int64) (page SlidesPage, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var slidesID int64
		if e := tx.QueryRow(ctx, `SELECT slides_id FROM slides_pages WHERE id=$1 FOR UPDATE`, pageID).Scan(&slidesID); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		if e := p.slidesAccessGuarded(ctx, tx, g, slidesID); e != nil {
			return e
		}
		if shapes != nil {
			ids, e := slideImageIDs(*shapes)
			if e != nil {
				return e
			}
			for _, id := range ids {
				var mime string
				e = tx.QueryRow(ctx, `SELECT mime FROM attachments WHERE id=$1 AND doc_id=$2 FOR SHARE`, id, slidesID).Scan(&mime)
				if errors.Is(e, pgx.ErrNoRows) {
					return ErrConflict
				}
				if e != nil {
					return e
				}
				if !slideImageMIME(mime) {
					return ErrConflict
				}
			}
		}
		e := tx.QueryRow(ctx, `UPDATE slides_pages SET title=$2, body=$3, background=$4, notes=COALESCE($5, notes), shapes=COALESCE($6::jsonb, shapes), revision=revision+1, updated_at=now() WHERE id=$1 AND revision=$7
			RETURNING id, slides_id, pos, title, body, background, notes, shapes, revision, updated_at`, pageID, title, body, background, notes, shapes, expectedRevision).
			Scan(&page.ID, &page.SlidesID, &page.Pos, &page.Title, &page.Body, &page.Background, &page.Notes, &page.Shapes, &page.Revision, &page.UpdatedAt)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrConflict
		}
		return e
	})
	if err != nil {
		return SlidesPage{}, err
	}
	return page, nil
}

func (p *Postgres) DeleteSlidesPage(ctx context.Context, g RestoreGuard, pageID int64) error {
	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var slidesID int64
		e := tx.QueryRow(ctx, `SELECT slides_id FROM slides_pages WHERE id=$1 FOR UPDATE`, pageID).Scan(&slidesID)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if e = p.slidesAccessGuarded(ctx, tx, g, slidesID); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `DELETE FROM slides_pages WHERE id=$1`, pageID)
		return e
	})
}

func (p *Postgres) MoveSlidesPage(ctx context.Context, g RestoreGuard, pageID int64, pos float64) error {
	if !(pos >= 0 && pos < 1e308) {
		return ErrConflict
	}
	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var slidesID int64
		e := tx.QueryRow(ctx, `SELECT slides_id FROM slides_pages WHERE id=$1 FOR UPDATE`, pageID).Scan(&slidesID)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if e = p.slidesAccessGuarded(ctx, tx, g, slidesID); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `UPDATE slides_pages SET pos=$2, updated_at=now() WHERE id=$1`, pageID, pos)
		return e
	})
}

// CopySlidesDeck publishes the new slides node, remapped image references and
// every source page in one transaction. Image blobs are immutable and shared
// by object key, so the copies reference the same storage. Page rows are
// locked until commit, so a concurrent page edit cannot slip between the read
// and the copy.
func (p *Postgres) CopySlidesDeck(ctx context.Context, c SlidesDeckCopy) (DocMeta, []SlidesPage, error) {
	var meta DocMeta
	var pages []SlidesPage
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		sourceRole, protected, kind, err := lockCopySource(ctx, tx, c.SourceID, c.UserID)
		if err != nil {
			return err
		}
		if kind != "slides" {
			return ErrConflict
		}
		if RoleRank(sourceRole) < RoleRank(RoleView) {
			return ErrNotFound
		}
		var expiry time.Time
		if c.Guard != nil {
			guard := c.Guard
			var sessionUser int64
			err := tx.QueryRow(ctx, `SELECT user_id, expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, guard.SessionHash).Scan(&sessionUser, &expiry)
			if errors.Is(err, pgx.ErrNoRows) || err == nil && (guard.UserID != c.UserID || sessionUser != c.UserID || !guard.currentTime().Before(expiry)) {
				return ErrUnauthenticated
			}
			if err != nil {
				return err
			}
		}
		// lockCopySource holds the source node through commit, so the download
		// threshold cannot change between this read and publishing the copy.
		var downloadMinRole string
		if err := tx.QueryRow(ctx, `SELECT download_min_role FROM nodes WHERE id=$1`, c.SourceID).Scan(&downloadMinRole); err != nil {
			return err
		}
		if !DocumentDownloadAllowed(DocMeta{Kind: kind, CopyProtected: protected, DownloadMinRole: downloadMinRole}, sourceRole) {
			return ErrCopyProtected
		}
		var member int64
		if err := tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, c.WorkspaceID, c.UserID).Scan(&member); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrForbidden
			}
			return err
		}
		var sourcePersonal bool
		if err := tx.QueryRow(ctx, `SELECT personal FROM nodes WHERE id=$1`, c.SourceID).Scan(&sourcePersonal); err != nil {
			return err
		}
		personal := sourcePersonal
		if c.ParentID != nil {
			var workspace int64
			var parentKind string
			if err := tx.QueryRow(ctx, `SELECT workspace_id, kind, personal FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, *c.ParentID).Scan(&workspace, &parentKind, &personal); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return ErrNotFound
				}
				return err
			}
			if workspace != c.WorkspaceID || parentKind == "file" {
				return ErrNotFound
			}
		}
		meta, err = scanDocWithPermissions(tx.QueryRow(ctx, `INSERT INTO nodes (workspace_id, parent_id, kind, sort_key, title, creator_id, drive_revision, personal)
			VALUES ($1,$2,'slides','V',$3,$4,1,$5) RETURNING `+docCols+creatorName+`, copy_protected, copy_min_role, download_min_role, comment_min_role, permissions_revision`, c.WorkspaceID, c.ParentID, c.Title, c.UserID, personal))
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT id, pos, title, body, background, notes, shapes FROM slides_pages WHERE slides_id=$1 ORDER BY pos, id FOR SHARE`, c.SourceID)
		if err != nil {
			return err
		}
		var source []SlidesPage
		for rows.Next() {
			var page SlidesPage
			if err = rows.Scan(&page.ID, &page.Pos, &page.Title, &page.Body, &page.Background, &page.Notes, &page.Shapes); err != nil {
				rows.Close()
				return err
			}
			source = append(source, page)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		var imageIDs []int64
		seen := map[int64]bool{}
		for _, page := range source {
			ids, e := slideImageIDs(page.Shapes)
			if e != nil {
				return e
			}
			for _, id := range ids {
				if !seen[id] {
					seen[id] = true
					imageIDs = append(imageIDs, id)
				}
			}
		}
		// Copies share immutable object keys. Lock all source attachment rows
		// in a stable order before publishing any references, mirroring
		// CopyDoc so deletion cannot race the copy.
		mapping := make(map[int64]int64, len(imageIDs))
		for _, oldID := range imageIDs {
			var newID int64
			var mime string
			if err = tx.QueryRow(ctx, `SELECT mime FROM attachments WHERE id=$1 AND doc_id=$2 FOR SHARE`, oldID, c.SourceID).Scan(&mime); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return ErrNotFound
				}
				return err
			}
			if !slideImageMIME(mime) {
				return ErrConflict
			}
			if err = tx.QueryRow(ctx, `INSERT INTO attachments (doc_id,uploader_id,name,mime,size,object_key)
				SELECT $1,$2,name,mime,size,object_key FROM attachments WHERE id=$3 AND doc_id=$4 RETURNING id`, meta.ID, c.UserID, oldID, c.SourceID).Scan(&newID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return ErrNotFound
				}
				return err
			}
			mapping[oldID] = newID
		}
		pages = make([]SlidesPage, 0, len(source))
		for _, page := range source {
			shapes, e := remapSlideShapes(page.Shapes, mapping)
			if e != nil {
				return e
			}
			var copied SlidesPage
			if e = tx.QueryRow(ctx, `INSERT INTO slides_pages (slides_id, pos, title, body, background, notes, shapes)
				VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, slides_id, pos, title, body, background, notes, shapes, revision, updated_at`,
				meta.ID, page.Pos, page.Title, page.Body, page.Background, page.Notes, shapes).
				Scan(&copied.ID, &copied.SlidesID, &copied.Pos, &copied.Title, &copied.Body, &copied.Background, &copied.Notes, &copied.Shapes, &copied.Revision, &copied.UpdatedAt); e != nil {
				return e
			}
			pages = append(pages, copied)
		}
		if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		return DocMeta{}, nil, err
	}
	return meta, pages, nil
}

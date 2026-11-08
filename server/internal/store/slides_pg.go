package store

import (
	"context"
	"errors"

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
			RETURNING id, slides_id, pos, title, body, background, revision, updated_at`, slidesID, title).
			Scan(&page.ID, &page.SlidesID, &page.Pos, &page.Title, &page.Body, &page.Background, &page.Revision, &page.UpdatedAt)
		return e
	})
	if err != nil {
		return SlidesPage{}, err
	}
	return page, nil
}

func (p *Postgres) ListSlidesPages(ctx context.Context, userID, slidesID int64) (out []SlidesPage, err error) {
	rows, err := p.Pool.Query(ctx, `SELECT sp.id, sp.slides_id, sp.pos, sp.title, sp.body, sp.background, sp.revision, sp.updated_at
		FROM slides_pages sp JOIN nodes n ON n.id = sp.slides_id`+roleJoins+`
		WHERE sp.slides_id=$2 AND n.kind='slides' AND n.deleted_at IS NULL AND (`+roleSQL+`)<>'' ORDER BY sp.pos, sp.id`, userID, slidesID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out = []SlidesPage{}
	for rows.Next() {
		var pg SlidesPage
		if err = rows.Scan(&pg.ID, &pg.SlidesID, &pg.Pos, &pg.Title, &pg.Body, &pg.Background, &pg.Revision, &pg.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, pg)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateSlidesPage(ctx context.Context, g RestoreGuard, pageID int64, title, body, background string, expectedRevision int64) (page SlidesPage, err error) {
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
		e := tx.QueryRow(ctx, `UPDATE slides_pages SET title=$2, body=$3, background=$4, revision=revision+1, updated_at=now() WHERE id=$1 AND revision=$5
			RETURNING id, slides_id, pos, title, body, background, revision, updated_at`, pageID, title, body, background, expectedRevision).
			Scan(&page.ID, &page.SlidesID, &page.Pos, &page.Title, &page.Body, &page.Background, &page.Revision, &page.UpdatedAt)
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

package store

import (
	"context"
	"errors"
	"regexp"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

type SlideVersion struct {
	ID       int64 `json:"id"`
	Revision int64 `json:"revision"`
}

// The result contains only the IDs and revisions the caller supplied.
type SlideBackgroundReceipt struct {
	ID        int64     `json:"id"`
	Revision  int64     `json:"revision"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type SlidesBackgroundStore interface {
	ApplySlidesBackground(context.Context, RestoreGuard, int64, string, []SlideVersion) ([]SlideBackgroundReceipt, error)
}

var slideBackgroundColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func validateSlideBackground(background string, expected []SlideVersion) error {
	if background != "" && !slideBackgroundColor.MatchString(background) || len(expected) == 0 || len(expected) > 1000 {
		return ErrConflict
	}
	seen := make(map[int64]bool, len(expected))
	for _, item := range expected {
		if item.ID <= 0 || item.Revision <= 0 || seen[item.ID] {
			return ErrConflict
		}
		seen[item.ID] = true
	}
	return nil
}

func (m *Memory) ApplySlidesBackground(ctx context.Context, guard RestoreGuard, deckID int64, background string, expected []SlideVersion) ([]SlideBackgroundReceipt, error) {
	if err := validateSlideBackground(background, expected); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.slidesAccessLocked(ctx, guard, deckID, false); err != nil {
		return nil, err
	}
	indexes := make(map[int64]int, len(expected))
	for i, page := range m.slides {
		if page.SlidesID == deckID {
			indexes[page.ID] = i
		}
	}
	if len(indexes) != len(expected) {
		return nil, ErrConflict
	}
	for _, item := range expected {
		i, ok := indexes[item.ID]
		if !ok || m.slides[i].Revision != item.Revision {
			return nil, ErrConflict
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if session, ok := m.sessions[string(guard.SessionHash)]; !ok || session.userID != guard.UserID || !guard.currentTime().Before(session.expires) {
		return nil, ErrUnauthenticated
	}
	result := make([]SlideBackgroundReceipt, 0, len(expected))
	now := time.Now()
	for _, item := range expected {
		i := indexes[item.ID]
		if m.slides[i].Background != background {
			m.slides[i].Background = background
			m.slides[i].Revision++
			m.slides[i].UpdatedAt = now
		}
		page := m.slides[i]
		result = append(result, SlideBackgroundReceipt{ID: page.ID, Revision: page.Revision, UpdatedAt: page.UpdatedAt})
	}
	return result, nil
}

func (p *Postgres) ApplySlidesBackground(ctx context.Context, guard RestoreGuard, deckID int64, background string, expected []SlideVersion) (result []SlideBackgroundReceipt, err error) {
	if err := validateSlideBackground(background, expected); err != nil {
		return nil, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		// Existing page edits and inserts lock a page before the deck node.
		// Follow that order and then re-read the set under the node lock.
		rows, e := tx.Query(ctx, `SELECT id,revision,background,updated_at FROM slides_pages WHERE slides_id=$1 ORDER BY id LIMIT 1001 FOR UPDATE`, deckID)
		if e != nil {
			return e
		}
		type current struct {
			id, revision int64
			background   string
			updatedAt    time.Time
		}
		pages := make(map[int64]current, len(expected))
		for rows.Next() {
			var page current
			if e = rows.Scan(&page.id, &page.revision, &page.background, &page.updatedAt); e != nil {
				rows.Close()
				return e
			}
			pages[page.id] = page
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		var id int64
		if e = tx.QueryRow(ctx, `SELECT id FROM nodes WHERE id=$1 FOR UPDATE`, deckID).Scan(&id); errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		} else if e != nil {
			return e
		}
		role, _, kind, e := lockCopySource(ctx, tx, deckID, guard.UserID)
		if e != nil {
			return e
		}
		if kind != "slides" {
			return ErrNotFound
		}
		if RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		// A page inserted before the node lock was acquired must invalidate the
		// whole operation, even if its original rows still match.
		var actualCount int
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM slides_pages WHERE slides_id=$1`, deckID).Scan(&actualCount); e != nil {
			return e
		}
		if actualCount != len(pages) {
			return ErrConflict
		}
		if len(pages) != len(expected) {
			return ErrConflict
		}
		for _, item := range expected {
			page, ok := pages[item.ID]
			if !ok || page.revision != item.Revision {
				return ErrConflict
			}
		}
		result = make([]SlideBackgroundReceipt, 0, len(expected))
		// Stable update order limits lock-order inversions with concurrent work.
		ordered := slices.Clone(expected)
		slices.SortFunc(ordered, func(a, b SlideVersion) int {
			if a.ID < b.ID {
				return -1
			}
			if a.ID > b.ID {
				return 1
			}
			return 0
		})
		for _, item := range ordered {
			page := pages[item.ID]
			if page.background != background {
				if e = tx.QueryRow(ctx, `UPDATE slides_pages SET background=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision,updated_at`, item.ID, background).Scan(&page.revision, &page.updatedAt); e != nil {
					return e
				}
			}
			result = append(result, SlideBackgroundReceipt{ID: item.ID, Revision: page.revision, UpdatedAt: page.updatedAt})
		}
		return drivePGEnd(ctx, guard, expires)
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		return nil, err
	}
	return result, nil
}

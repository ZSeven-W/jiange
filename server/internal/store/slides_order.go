package store

import (
	"context"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5"
)

// SlidePosition is an exact snapshot of ordering state, independent of page contents.
type SlidePosition struct {
	ID  int64   `json:"id"`
	Pos float64 `json:"pos"`
}
type SlidesOrderStore interface {
	ReorderSlides(context.Context, RestoreGuard, int64, []SlidePosition, int64, int) ([]SlidePosition, error)
}

func reorderPositions(current, expected []SlidePosition, pageID int64, to int) ([]SlidePosition, error) {
	if len(expected) < 1 || len(expected) > 1000 || len(current) != len(expected) || to < 0 || to >= len(expected) {
		return nil, ErrConflict
	}
	seen := map[int64]bool{}
	from := -1
	for i, item := range expected {
		if item.ID <= 0 || !isFinitePos(item.Pos) || seen[item.ID] || current[i] != item {
			return nil, ErrConflict
		}
		seen[item.ID] = true
		if item.ID == pageID {
			from = i
		}
	}
	if from < 0 || from == to {
		return nil, ErrConflict
	}
	result := append([]SlidePosition(nil), current...)
	moving := result[from]
	result = append(result[:from], result[from+1:]...)
	result = append(result, SlidePosition{})
	copy(result[to+1:], result[to:])
	result[to] = moving
	for i := range result {
		result[i].Pos = float64(i + 1)
	}
	return result, nil
}

func (m *Memory) ReorderSlides(ctx context.Context, g RestoreGuard, deckID int64, expected []SlidePosition, pageID int64, to int) ([]SlidePosition, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.slidesAccessLocked(ctx, g, deckID, false); err != nil {
		return nil, err
	}
	current := make([]SlidePosition, 0)
	for _, page := range m.slides {
		if page.SlidesID == deckID {
			current = append(current, SlidePosition{page.ID, page.Pos})
		}
	}
	sort.Slice(current, func(i, j int) bool {
		if current[i].Pos == current[j].Pos {
			return current[i].ID < current[j].ID
		}
		return current[i].Pos < current[j].Pos
	})
	result, err := reorderPositions(current, expected, pageID, to)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if session, ok := m.sessions[string(g.SessionHash)]; !ok || session.userID != g.UserID || !g.currentTime().Before(session.expires) {
		return nil, ErrUnauthenticated
	}
	positions := make(map[int64]float64, len(result))
	for _, item := range result {
		positions[item.ID] = item.Pos
	}
	for i := range m.slides {
		if m.slides[i].SlidesID == deckID {
			m.slides[i].Pos = positions[m.slides[i].ID]
		}
	}
	return result, nil
}

func (p *Postgres) ReorderSlides(ctx context.Context, g RestoreGuard, deckID int64, expected []SlidePosition, pageID int64, to int) (result []SlidePosition, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		// Existing page mutations lock a page before the deck. Lock rows in a stable
		// order, then the deck; re-read after the deck lock to include prior inserts.
		rows, e := tx.Query(ctx, `SELECT id FROM slides_pages WHERE slides_id=$1 ORDER BY id FOR UPDATE`, deckID)
		if e != nil {
			return e
		}
		for rows.Next() {
			var id int64
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return e
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		expiry, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		var id int64
		e = tx.QueryRow(ctx, `SELECT id FROM nodes WHERE id=$1 FOR UPDATE`, deckID).Scan(&id)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		role, _, kind, e := lockCopySource(ctx, tx, deckID, g.UserID)
		if e != nil {
			return e
		}
		if kind != "slides" {
			return ErrNotFound
		}
		if RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		rows, e = tx.Query(ctx, `SELECT id,pos FROM slides_pages WHERE slides_id=$1 ORDER BY pos,id FOR UPDATE`, deckID)
		if e != nil {
			return e
		}
		current := make([]SlidePosition, 0)
		for rows.Next() {
			var item SlidePosition
			if e = rows.Scan(&item.ID, &item.Pos); e != nil {
				rows.Close()
				return e
			}
			current = append(current, item)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		result, e = reorderPositions(current, expected, pageID, to)
		if e != nil {
			return e
		}
		for _, item := range result {
			if _, e = tx.Exec(ctx, `UPDATE slides_pages SET pos=$1 WHERE slides_id=$2 AND id=$3`, item.Pos, deckID, item.ID); e != nil {
				return e
			}
		}
		return drivePGEnd(ctx, g, expiry)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

package store

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/jackc/pgx/v5"
)

const maxFieldOrder = 10000

// fieldOrderPlan requires an exact current ordering and a complete permutation.
// Comparing the full list prevents a stale drag from overwriting a concurrent
// insert, delete, or reorder, including fields hidden in the current view.
func fieldOrderPlan(fields []Field, expected, desired []int64) ([]Field, bool, error) {
	if len(fields) == 0 || len(fields) > maxFieldOrder || len(fields) != len(expected) || len(fields) != len(desired) {
		return nil, false, ErrConflict
	}
	byID := make(map[int64]Field, len(fields))
	for i, field := range fields {
		if field.ID <= 0 || field.ID != expected[i] {
			return nil, false, ErrConflict
		}
		if _, duplicate := byID[field.ID]; duplicate {
			return nil, false, ErrConflict
		}
		byID[field.ID] = field
		if field.IsPrimary && desired[i] != field.ID {
			return nil, false, ErrPrimaryField
		}
	}
	ordered := make([]Field, 0, len(fields))
	changed := false
	for i, id := range desired {
		field, ok := byID[id]
		if !ok {
			return nil, false, ErrConflict
		}
		delete(byID, id)
		changed = changed || id != expected[i]
		field.Position = float64(i + 1)
		ordered = append(ordered, field)
	}
	return ordered, changed, nil
}

func (m *Memory) ReorderFieldsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, expected, desired []int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expiry, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return err
	}
	fields := memoryFieldsForBase(m.b.fields, baseID)
	// Memory and PostgreSQL use the same deterministic order when positions tie.
	sort.Slice(fields, func(i, j int) bool {
		if fields[i].Position == fields[j].Position {
			return fields[i].ID < fields[j].ID
		}
		return fields[i].Position < fields[j].Position
	})
	ordered, changed, err := fieldOrderPlan(fields, expected, desired)
	if err != nil || !changed {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if !guard.currentTime().Before(expiry) {
		return ErrUnauthenticated
	}
	positions := make(map[int64]float64, len(ordered))
	for _, field := range ordered {
		positions[field.ID] = field.Position
	}
	for i := range m.b.fields {
		if m.b.fields[i].BaseID == baseID {
			m.b.fields[i].Position = positions[m.b.fields[i].ID]
		}
	}
	m.appendBtEventLocked(baseID, json.RawMessage(`{"kind":"reload"}`))
	return nil
}

func (p *Postgres) ReorderFieldsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, expected, desired []int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expiry, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		// Existing legacy field paths also acquire a write lock on this table.
		// Match the lock ordering used by MutateFieldGuarded and ImportBaseCSV.
		if _, err = tx.Exec(ctx, `LOCK TABLE base_fields IN SHARE ROW EXCLUSIVE MODE`); err != nil {
			return err
		}
		fields, err := pgFields(ctx, tx, baseID)
		if err != nil {
			return err
		}
		ordered, changed, err := fieldOrderPlan(fields, expected, desired)
		if err != nil || !changed {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE base_fields AS field SET position=ordered.position
			FROM unnest($2::bigint[]) WITH ORDINALITY AS ordered(id, position)
			WHERE field.base_id=$1 AND field.id=ordered.id`, baseID, desired)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != int64(len(ordered)) {
			return ErrConflict
		}
		if err = pgViewReload(ctx, tx, baseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}

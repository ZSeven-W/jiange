package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrInvalidDateCells = errors.New("store: invalid date comparison")

func nullCell(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// validateDateComparison restricts this endpoint to date scheduling. Exact
// key equality prevents an unchecked field being changed by a forged request.
func validateDateComparison(expected, cells map[string]json.RawMessage) error {
	if len(expected) == 0 || len(expected) > 2 || len(expected) != len(cells) {
		return ErrInvalidDateCells
	}
	for key, old := range expected {
		id, err := strconv.ParseInt(key, 10, 64)
		if err != nil || id <= 0 || strconv.FormatInt(id, 10) != key {
			return ErrInvalidDateCells
		}
		next, ok := cells[key]
		if !ok || len(bytes.TrimSpace(old)) == 0 || !json.Valid(old) || len(bytes.TrimSpace(next)) == 0 || !json.Valid(next) {
			return ErrInvalidDateCells
		}
		if !nullCell(old) {
			var value string
			if json.Unmarshal(old, &value) != nil {
				return ErrInvalidDateCells
			}
		}
		if !nullCell(next) {
			var value string
			if json.Unmarshal(next, &value) != nil {
				return ErrInvalidDateCells
			}
			if _, err := time.Parse("2006-01-02", value); err != nil {
				return ErrInvalidDateCells
			}
		}
	}
	return nil
}

func equalDateCell(actual, expected json.RawMessage) bool {
	if nullCell(actual) || nullCell(expected) {
		return nullCell(actual) && nullCell(expected)
	}
	var a, b string
	return json.Unmarshal(actual, &a) == nil && json.Unmarshal(expected, &b) == nil && a == b
}

func applyDateComparison(record Record, expected, cells map[string]json.RawMessage) (Record, bool, error) {
	for key, old := range expected {
		if !equalDateCell(record.Cells[key], old) {
			return Record{}, false, ErrConflict
		}
	}
	updated := maps.Clone(record.Cells)
	if updated == nil {
		updated = make(map[string]json.RawMessage)
	}
	changed := false
	for key, value := range cells {
		if equalDateCell(record.Cells[key], value) {
			continue
		}
		changed = true
		if nullCell(value) {
			delete(updated, key)
		} else {
			updated[key] = append(json.RawMessage(nil), value...)
		}
	}
	record.Cells = updated
	return record, changed, nil
}

func dateChangeEvent(record Record) ([]byte, error) {
	return json.Marshal(map[string]any{"kind": "record", "op": "update", "record": record})
}

func (m *Memory) CompareDateCells(ctx context.Context, guard BaseWriteGuard, baseID, recordID int64, expected, cells map[string]json.RawMessage) (Record, bool, error) {
	if err := validateDateComparison(expected, cells); err != nil {
		return Record{}, false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Record{}, false, err
	}
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return Record{}, false, err
	}
	for key := range cells {
		id, _ := strconv.ParseInt(key, 10, 64)
		found := false
		for _, field := range m.b.fields {
			if field.ID == id && field.BaseID == baseID && field.Type == "date" {
				found = true
				break
			}
		}
		if !found {
			return Record{}, false, ErrInvalidDateCells
		}
	}
	for i, current := range m.b.records {
		if current.ID != recordID || current.BaseID != baseID {
			continue
		}
		record, changed, err := applyDateComparison(current, expected, cells)
		if err != nil {
			return Record{}, false, err
		}
		if err := ctx.Err(); err != nil {
			return Record{}, false, err
		}
		if !guard.currentTime().Before(expires) {
			return Record{}, false, ErrUnauthenticated
		}
		if !changed {
			return record, false, nil
		}
		now := time.Now()
		record.UpdatedAt = &now
		event, err := dateChangeEvent(record)
		if err != nil {
			return Record{}, false, err
		}
		m.b.records[i] = record
		m.appendBtEventActorLocked(ctx, baseID, event)
		return record, true, nil
	}
	return Record{}, false, ErrNotFound
}

func (p *Postgres) CompareDateCells(ctx context.Context, guard BaseWriteGuard, baseID, recordID int64, expected, cells map[string]json.RawMessage) (record Record, changed bool, err error) {
	aid, akind := actorArgs(ctx)
	if err := validateDateComparison(expected, cells); err != nil {
		return Record{}, false, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		for key := range cells {
			id, _ := strconv.ParseInt(key, 10, 64)
			var fieldType string
			err := tx.QueryRow(ctx, `SELECT type FROM base_fields WHERE base_id=$1 AND id=$2 FOR SHARE`, baseID, id).Scan(&fieldType)
			if errors.Is(err, pgx.ErrNoRows) || err == nil && fieldType != "date" {
				return ErrInvalidDateCells
			}
			if err != nil {
				return err
			}
		}
		current, err := scanRecord(tx.QueryRow(ctx, `SELECT `+recordCols+` FROM base_records WHERE base_id=$1 AND id=$2 FOR UPDATE`, baseID, recordID))
		if err != nil {
			return err
		}
		record, changed, err = applyDateComparison(current, expected, cells)
		if err != nil {
			return err
		}
		if changed {
			record, err = scanRecord(tx.QueryRow(ctx, `UPDATE base_records SET cells=$3,updated_at=now() WHERE base_id=$1 AND id=$2 RETURNING `+recordCols, baseID, recordID, record.Cells))
			if err != nil {
				return err
			}
			event, err := dateChangeEvent(record)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO bt_events (base_id,body,actor_id,actor_kind) VALUES ($1,$2,$3,$4)`, baseID, event, aid, akind); err != nil {
				return err
			}
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return Record{}, false, ErrConflict
		}
		return Record{}, false, err
	}
	return record, changed, nil
}

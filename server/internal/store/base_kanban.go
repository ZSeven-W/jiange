package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// KanbanAnchor identifies a neighboring visible card as observed when the
// drag began. Its position is checked again under the Base write lock.
type KanbanAnchor struct {
	ID       int64   `json:"id"`
	Position float64 `json:"position"`
}

// KanbanMove carries only the values needed to safely place one card. A nil
// group represents the ungrouped column, including a missing cell.
type KanbanMove struct {
	FieldID          int64         `json:"fieldId"`
	ExpectedHead     int64         `json:"expectedHead"`
	ExpectedGroup    *string       `json:"expectedGroup"`
	ExpectedPosition float64       `json:"expectedPosition"`
	ExpectedOptions  []string      `json:"expectedOptions"`
	TargetGroup      *string       `json:"targetGroup"`
	Before           *KanbanAnchor `json:"before"`
	After            *KanbanAnchor `json:"after"`
}

var ErrInvalidKanbanMove = errors.New("store: invalid kanban move")

func validateKanbanMove(move KanbanMove, recordID int64) error {
	if recordID <= 0 || move.FieldID <= 0 || move.ExpectedHead < 0 || !finiteKanbanPosition(move.ExpectedPosition) {
		return ErrInvalidKanbanMove
	}
	for _, anchor := range []*KanbanAnchor{move.Before, move.After} {
		if anchor != nil && (anchor.ID <= 0 || anchor.ID == recordID || !finiteKanbanPosition(anchor.Position)) {
			return ErrInvalidKanbanMove
		}
	}
	if move.Before != nil && move.After != nil && (move.Before.ID == move.After.ID || move.Before.Position >= move.After.Position) {
		return ErrInvalidKanbanMove
	}
	return nil
}

func finiteKanbanPosition(pos float64) bool { return !math.IsNaN(pos) && !math.IsInf(pos, 0) }

func kanbanCell(raw json.RawMessage) (*string, error) {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return nil, ErrInvalidKanbanMove
	}
	return &value, nil
}

func sameKanbanCell(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func kanbanBucket(value *string, options []string) string {
	if value != nil && slices.Contains(options, *value) {
		return *value
	}
	return ""
}

// applyKanbanMove checks the entire observed placement before changing the
// single record. It never mutates the caller's stored maps on failure.
func applyKanbanMove(field Field, current Record, neighbors map[int64]Record, move KanbanMove) (Record, bool, error) {
	if field.Type != "select" || !slices.Equal(field.Options, move.ExpectedOptions) {
		return Record{}, false, ErrConflict
	}
	if move.TargetGroup != nil && (*move.TargetGroup == "" || !slices.Contains(field.Options, *move.TargetGroup)) {
		return Record{}, false, ErrInvalidKanbanMove
	}
	key := strconv.FormatInt(field.ID, 10)
	value, err := kanbanCell(current.Cells[key])
	if err != nil || !sameKanbanCell(value, move.ExpectedGroup) || current.Position != move.ExpectedPosition {
		return Record{}, false, ErrConflict
	}
	target := ""
	if move.TargetGroup != nil {
		target = *move.TargetGroup
	}
	for _, anchor := range []*KanbanAnchor{move.Before, move.After} {
		if anchor == nil {
			continue
		}
		neighbor, ok := neighbors[anchor.ID]
		if !ok || neighbor.Position != anchor.Position {
			return Record{}, false, ErrConflict
		}
		v, err := kanbanCell(neighbor.Cells[key])
		if err != nil || kanbanBucket(v, field.Options) != target {
			return Record{}, false, ErrConflict
		}
	}
	position := current.Position
	switch {
	case move.Before != nil && move.After != nil:
		// Half-sum avoids overflow for large but valid floating point positions.
		position = move.Before.Position/2 + move.After.Position/2
		if position <= move.Before.Position || position >= move.After.Position {
			return Record{}, false, ErrConflict
		}
	case move.Before != nil:
		position = move.Before.Position + 1
		if position <= move.Before.Position {
			return Record{}, false, ErrConflict
		}
	case move.After != nil:
		position = move.After.Position - 1
		if position >= move.After.Position {
			return Record{}, false, ErrConflict
		}
	}
	if !finiteKanbanPosition(position) {
		return Record{}, false, ErrConflict
	}
	changed := !sameKanbanCell(value, move.TargetGroup) || position != current.Position
	if !changed {
		return current, false, nil
	}
	current.Cells = cloneCells(current.Cells)
	if move.TargetGroup == nil {
		delete(current.Cells, key)
	} else {
		encoded, _ := json.Marshal(*move.TargetGroup)
		current.Cells[key] = encoded
	}
	current.Position = position
	now := time.Now()
	current.UpdatedAt = &now
	return current, true, nil
}

func cloneCells(cells map[string]json.RawMessage) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(cells))
	for key, value := range cells {
		out[key] = slices.Clone(value)
	}
	return out
}

// MoveKanbanCard atomically checks permission, the observed event head and
// placement, then writes the grouping value, position and event together.
func (m *Memory) MoveKanbanCard(ctx context.Context, guard BaseWriteGuard, baseID, recordID int64, move KanbanMove) (Record, bool, error) {
	if err := validateKanbanMove(move, recordID); err != nil {
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
	var head int64
	if events := m.b.events[baseID]; len(events) > 0 {
		head = events[len(events)-1].Seq
	}
	if head != move.ExpectedHead {
		return Record{}, false, ErrConflict
	}
	var field Field
	for _, f := range m.b.fields {
		if f.BaseID == baseID && f.ID == move.FieldID {
			field = f
			break
		}
	}
	if field.ID == 0 {
		return Record{}, false, ErrNotFound
	}
	index := -1
	neighbors := make(map[int64]Record, 2)
	for i, rec := range m.b.records {
		if rec.BaseID != baseID {
			continue
		}
		if rec.ID == recordID {
			index = i
		}
		if (move.Before != nil && rec.ID == move.Before.ID) || (move.After != nil && rec.ID == move.After.ID) {
			neighbors[rec.ID] = rec
		}
	}
	if index < 0 {
		return Record{}, false, ErrNotFound
	}
	record, changed, err := applyKanbanMove(field, m.b.records[index], neighbors, move)
	if err != nil || !changed {
		return record, changed, err
	}
	if err := ctx.Err(); err != nil {
		return Record{}, false, err
	}
	if !guard.currentTime().Before(expires) {
		return Record{}, false, ErrUnauthenticated
	}
	event, err := recordEvent(baseID, "update", record, record.ID)
	if err != nil {
		return Record{}, false, err
	}
	m.b.records[index] = record
	m.appendBtEventLocked(baseID, event)
	return record, true, nil
}

func (p *Postgres) MoveKanbanCard(ctx context.Context, guard BaseWriteGuard, baseID, recordID int64, move KanbanMove) (record Record, changed bool, err error) {
	if err = validateKanbanMove(move, recordID); err != nil {
		return Record{}, false, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `LOCK TABLE base_fields IN SHARE MODE`); err != nil {
			return err
		}
		var head int64
		if err := tx.QueryRow(ctx, `SELECT COALESCE(max(id),0) FROM bt_events WHERE base_id=$1`, baseID).Scan(&head); err != nil {
			return err
		}
		if head != move.ExpectedHead {
			return ErrConflict
		}
		field, err := scanField(tx.QueryRow(ctx, `SELECT `+fieldCols+` FROM base_fields WHERE base_id=$1 AND id=$2`, baseID, move.FieldID))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		ids := []int64{recordID}
		if move.Before != nil {
			ids = append(ids, move.Before.ID)
		}
		if move.After != nil {
			ids = append(ids, move.After.ID)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		rows, err := tx.Query(ctx, `SELECT `+recordCols+` FROM base_records WHERE base_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE`, baseID, ids)
		if err != nil {
			return err
		}
		found, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Record, error) { return scanRecord(r) })
		if err != nil {
			return err
		}
		var current Record
		neighbors := make(map[int64]Record, 2)
		for _, item := range found {
			if item.ID == recordID {
				current = item
			} else {
				neighbors[item.ID] = item
			}
		}
		if current.ID == 0 {
			return ErrNotFound
		}
		record, changed, err = applyKanbanMove(field, current, neighbors, move)
		if err != nil {
			return err
		}
		if changed {
			record, err = scanRecord(tx.QueryRow(ctx, `UPDATE base_records SET cells=$3,position=$4,updated_at=now() WHERE base_id=$1 AND id=$2 RETURNING `+recordCols, baseID, recordID, record.Cells, record.Position))
			if err != nil {
				return err
			}
			event, err := recordEvent(baseID, "update", record, recordID)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO bt_events (base_id,body) VALUES ($1,$2)`, baseID, event); err != nil {
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

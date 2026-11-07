package store

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// ImportColumn identifies an existing field or describes a new field. Its
// position in Columns is the key used by Rows; no database IDs are guessed.
type ImportColumn struct {
	ExistingID int64
	New        Field
}

type BaseImportPlan struct {
	Columns []ImportColumn
	Rows    []map[int]json.RawMessage
}

// BaseImportBuilder runs inside the import's authorization and schema lock.
// It must be deterministic and must not call the Store or perform I/O.
type BaseImportBuilder func([]Field) (BaseImportPlan, error)

func validateBaseImportPlan(plan BaseImportPlan, fields []Field) error {
	if len(plan.Columns) == 0 || len(plan.Columns) > 500 || len(plan.Rows) > 10000 {
		return ErrConflict
	}
	existing := make(map[int64]bool, len(fields))
	for _, f := range fields {
		existing[f.ID] = true
	}
	used := map[int64]bool{}
	newNames := map[string]bool{}
	for _, c := range plan.Columns {
		if c.ExistingID != 0 {
			if !existing[c.ExistingID] || used[c.ExistingID] {
				return ErrConflict
			}
			used[c.ExistingID] = true
		} else if c.New.Name == "" || !FieldTypes[c.New.Type] || FieldReadOnly(c.New.Type) || c.New.Type == "link" || c.New.Type == "lookup" || c.New.Type == "formula" {
			return ErrConflict
		} else {
			if newNames[c.New.Name] {
				return ErrConflict
			}
			newNames[c.New.Name] = true
		}
	}
	for _, row := range plan.Rows {
		for col, v := range row {
			if col < 0 || col >= len(plan.Columns) || !json.Valid(v) || string(v) == "null" {
				return ErrConflict
			}
		}
	}
	return nil
}

// ImportBaseCSV commits the schema, records, and reload event together with
// authorization. The caller notifies the realtime hub only after success.
func (m *Memory) ImportBaseCSV(ctx context.Context, guard BaseWriteGuard, baseID int64, build BaseImportBuilder) (int, error) {
	if build == nil {
		return 0, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return 0, err
	}
	fields := []Field{}
	for _, f := range m.b.fields {
		if f.BaseID == baseID {
			f.Options = append([]string(nil), f.Options...)
			f.OptionColors = append([]int(nil), f.OptionColors...)
			fields = append(fields, f)
		}
	}
	sort.Slice(fields, func(i, j int) bool {
		if fields[i].Position != fields[j].Position {
			return fields[i].Position < fields[j].Position
		}
		return fields[i].ID < fields[j].ID
	})
	plan, err := build(fields)
	if err != nil {
		return 0, err
	}
	if err = validateBaseImportPlan(plan, fields); err != nil {
		return 0, err
	}
	if err = ctx.Err(); err != nil {
		return 0, err
	}
	if !guard.currentTime().Before(expires) {
		return 0, ErrUnauthenticated
	}
	ids := make([]int64, len(plan.Columns))
	var added []Field
	for i, c := range plan.Columns {
		if c.ExistingID != 0 {
			ids[i] = c.ExistingID
			continue
		}
		f := c.New
		f.BaseID, f.ID = baseID, m.id()
		f.Position = float64(f.ID)
		f.IsPrimary = len(fields) == 0 && len(added) == 0
		ids[i] = f.ID
		added = append(added, f)
	}
	now := time.Now()
	var records []Record
	for _, row := range plan.Rows {
		cells := make(map[string]json.RawMessage, len(row))
		for col, value := range row {
			cells[strconv.FormatInt(ids[col], 10)] = append(json.RawMessage(nil), value...)
		}
		uid := guard.UserID
		r := Record{ID: m.id(), BaseID: baseID, Cells: cells, CreatorID: &uid, CreatedAt: &now, UpdatedAt: &now}
		r.Position = float64(r.ID)
		records = append(records, r)
	}
	m.b.fields = append(m.b.fields, added...)
	m.b.records = append(m.b.records, records...)
	m.appendBtEventLocked(baseID, json.RawMessage(`{"kind":"reload"}`))
	return len(records), nil
}

func (p *Postgres) ImportBaseCSV(ctx context.Context, guard BaseWriteGuard, baseID int64, build BaseImportBuilder) (count int, err error) {
	if build == nil {
		return 0, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		// Existing schema and record writers do not yet all use the Base lock.
		// Table locks are a conservative transitional fence against them.
		if _, err = tx.Exec(ctx, `LOCK TABLE base_fields, base_records IN SHARE ROW EXCLUSIVE MODE`); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT `+fieldCols+` FROM base_fields WHERE base_id=$1 ORDER BY position,id`, baseID)
		if err != nil {
			return err
		}
		fields, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Field, error) { return scanField(r) })
		if err != nil {
			return err
		}
		plan, err := build(fields)
		if err != nil {
			return err
		}
		if err = validateBaseImportPlan(plan, fields); err != nil {
			return err
		}
		ids := make([]int64, len(plan.Columns))
		firstNew := len(fields) == 0
		for i, c := range plan.Columns {
			if c.ExistingID != 0 {
				ids[i] = c.ExistingID
				continue
			}
			f := c.New
			err = tx.QueryRow(ctx, `INSERT INTO base_fields (base_id,name,type,options,option_colors,description,formula,position,is_primary)
				VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE((SELECT max(position) FROM base_fields WHERE base_id=$1),0)+1,$8) RETURNING id`,
				baseID, f.Name, f.Type, opts(f), colors(f), f.Description, f.Formula, firstNew).Scan(&ids[i])
			if err != nil {
				return err
			}
			firstNew = false
		}
		var pos float64
		if err = tx.QueryRow(ctx, `SELECT COALESCE(max(position),0) FROM base_records WHERE base_id=$1`, baseID).Scan(&pos); err != nil {
			return err
		}
		batch := &pgx.Batch{}
		for _, row := range plan.Rows {
			if err = ctx.Err(); err != nil {
				return err
			}
			cells := make(map[string]json.RawMessage, len(row))
			for col, value := range row {
				cells[strconv.FormatInt(ids[col], 10)] = value
			}
			pos++
			batch.Queue(`INSERT INTO base_records (base_id,cells,position,creator_id) VALUES ($1,$2,$3,$4)`, baseID, cells, pos, guard.UserID)
		}
		if err = tx.SendBatch(ctx, batch).Close(); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO bt_events (base_id,body) VALUES ($1,'{"kind":"reload"}'::jsonb)`, baseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		count = len(plan.Rows)
		return nil
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return 0, ErrConflict
		}
		return 0, err
	}
	return count, nil
}

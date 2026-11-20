package store

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/btformula"
	"github.com/jackc/pgx/v5"
)

const baseMaxRestoreFieldCells = 10000

// RestoreFieldCellInput captures one cell value belonging to a previously
// deleted field so Undo can restore both column schema and cell values atomically.
type RestoreFieldCellInput struct {
	RecordID int64           `json:"recordId"`
	Value    json.RawMessage `json:"value"`
}

// RestoreFieldInput describes a deleted field and its captured non-empty cells.
type RestoreFieldInput struct {
	Field Field                   `json:"field"`
	Cells []RestoreFieldCellInput `json:"cells,omitempty"`
}

func validateRestoreFieldSpec(f *Field, existing []Field) error {
	f.Name = strings.TrimSpace(f.Name)
	if f.Name == "" || !utf8.ValidString(f.Name) || utf8.RuneCountInString(f.Name) > 100 {
		return ErrInvalidBaseRecord
	}
	if !FieldTypes[f.Type] || f.Type == "link" {
		return ErrInvalidBaseRecord
	}
	if f.IsPrimary {
		return ErrPrimaryField
	}
	if math.IsNaN(f.Position) || math.IsInf(f.Position, 0) || f.Position < 0 {
		return ErrInvalidBaseRecord
	}
	if utf8.RuneCountInString(f.Description) > 200 {
		return ErrInvalidBaseRecord
	}
	for _, c := range f.OptionColors {
		if c < -1 || c > 9 {
			return ErrInvalidBaseRecord
		}
	}
	if f.Type != "person" {
		f.Multiple = false
	}
	f.TargetTableID = nil
	if f.Position > 0 {
		for _, primary := range existing {
			if primary.IsPrimary && f.Position <= primary.Position {
				return ErrPrimaryField
			}
		}
	}
	if f.Type == "formula" && strings.TrimSpace(f.Formula) != "" {
		f.Formula = strings.TrimSpace(f.Formula)
		if utf8.RuneCountInString(f.Formula) > 2000 {
			return ErrInvalidBaseRecord
		}
		names := make([]string, 0, len(existing))
		for _, ef := range existing {
			names = append(names, ef.Name)
		}
		if err := btformula.Validate(f.Formula, names); err != nil {
			return ErrInvalidBaseRecord
		}
	}
	return nil
}

func (m *Memory) RestoreFieldGuarded(
	ctx context.Context,
	guard BaseWriteGuard,
	baseID int64,
	input RestoreFieldInput,
	validateCell func(Field, json.RawMessage) error,
) (Field, int, error) {
	if err := ctx.Err(); err != nil {
		return Field{}, 0, err
	}
	if len(input.Cells) > baseMaxRestoreFieldCells {
		return Field{}, 0, ErrInvalidBaseRecord
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return Field{}, 0, err
	}
	targetTableID, err := m.resolveTableIDLocked(baseID, input.Field.TableID)
	if err != nil {
		return Field{}, 0, err
	}
	existing := fieldsForTable(memoryFieldsForBase(m.b.fields, baseID), targetTableID)
	f := input.Field
	f.ID = 0
	f.BaseID = baseID
	f.TableID = targetTableID
	f.IsPrimary = false
	if err := validateRestoreFieldSpec(&f, existing); err != nil {
		return Field{}, 0, err
	}
	if f.DefaultValue != nil && !nullCell(f.DefaultValue) && validateCell != nil {
		if err := validateCell(f, f.DefaultValue); err != nil {
			return Field{}, 0, err
		}
	}

	cellByRecord := make(map[int64]json.RawMessage, len(input.Cells))
	for _, c := range input.Cells {
		if c.RecordID <= 0 || nullCell(c.Value) {
			continue
		}
		if !json.Valid(c.Value) {
			return Field{}, 0, ErrInvalidBaseRecord
		}
		if validateCell != nil {
			if err := validateCell(f, c.Value); err != nil {
				return Field{}, 0, err
			}
		}
		cellByRecord[c.RecordID] = slices.Clone(c.Value)
	}

	if err := ctx.Err(); err != nil {
		return Field{}, 0, err
	}
	if !guard.currentTime().Before(expires) {
		return Field{}, 0, ErrUnauthenticated
	}

	f.ID = m.id()
	if f.Position == 0 {
		var maxPos float64
		for _, ef := range existing {
			if ef.Position > maxPos {
				maxPos = ef.Position
			}
		}
		f.Position = maxPos + 1
	}
	f.IsPrimary = len(existing) == 0
	f.Options = slices.Clone(f.Options)
	f.OptionColors = slices.Clone(f.OptionColors)
	f.DefaultValue = slices.Clone(f.DefaultValue)
	m.b.fields = append(m.b.fields, f)

	key := strconv.FormatInt(f.ID, 10)
	restored := 0
	now := time.Now()
	if len(cellByRecord) > 0 {
		for i := range m.b.records {
			rec := &m.b.records[i]
			if rec.BaseID != baseID || rec.TableID != targetTableID {
				continue
			}
			val, ok := cellByRecord[rec.ID]
			if !ok {
				continue
			}
			nextCells := cloneRecordCells(rec.Cells)
			nextCells[key] = slices.Clone(val)
			rec.Cells = nextCells
			t := now
			rec.UpdatedAt = &t
			restored++
		}
	}
	m.appendBtEventActorLocked(ctx, baseID, fieldReload())
	return f, restored, nil
}

func (p *Postgres) RestoreFieldGuarded(
	ctx context.Context,
	guard BaseWriteGuard,
	baseID int64,
	input RestoreFieldInput,
	validateCell func(Field, json.RawMessage) error,
) (created Field, restored int, err error) {
	if len(input.Cells) > baseMaxRestoreFieldCells {
		return Field{}, 0, ErrInvalidBaseRecord
	}
	aid, akind := actorArgs(ctx)
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockBaseWrite(ctx, tx, guard, baseID)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `LOCK TABLE base_fields,base_records IN SHARE ROW EXCLUSIVE MODE`); e != nil {
			return e
		}
		targetTableID := input.Field.TableID
		if targetTableID > 0 {
			var okID int64
			if e = tx.QueryRow(ctx, `SELECT id FROM bt_tables WHERE id=$1 AND base_id=$2`, targetTableID, baseID).Scan(&okID); e != nil {
				return notFound(e)
			}
		} else {
			if e = tx.QueryRow(ctx, `SELECT id FROM bt_tables WHERE base_id=$1 AND is_default LIMIT 1`, baseID).Scan(&targetTableID); e != nil {
				return notFound(e)
			}
		}
		allFields, e := pgFields(ctx, tx, baseID)
		if e != nil {
			return e
		}
		existing := fieldsForTable(allFields, targetTableID)
		f := input.Field
		f.ID = 0
		f.BaseID = baseID
		f.TableID = targetTableID
		f.IsPrimary = false
		if e = validateRestoreFieldSpec(&f, existing); e != nil {
			return e
		}
		if f.DefaultValue != nil && !nullCell(f.DefaultValue) && validateCell != nil {
			if e = validateCell(f, f.DefaultValue); e != nil {
				return e
			}
		}

		cellByRecord := make(map[int64]json.RawMessage, len(input.Cells))
		recordIDs := make([]int64, 0, len(input.Cells))
		for _, c := range input.Cells {
			if c.RecordID <= 0 || nullCell(c.Value) {
				continue
			}
			if !json.Valid(c.Value) {
				return ErrInvalidBaseRecord
			}
			if validateCell != nil {
				if e = validateCell(f, c.Value); e != nil {
					return e
				}
			}
			if _, seen := cellByRecord[c.RecordID]; !seen {
				recordIDs = append(recordIDs, c.RecordID)
			}
			cellByRecord[c.RecordID] = slices.Clone(c.Value)
		}

		f, e = scanField(tx.QueryRow(
			ctx,
			`INSERT INTO base_fields (base_id,table_id,name,type,options,option_colors,description,formula,position,is_primary,default_value,multiple,target_table_id)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9::float8=0 THEN COALESCE((SELECT max(position) FROM base_fields WHERE table_id=$2),0)+1 ELSE $9 END,$10,$11,$12,$13)
			 RETURNING `+fieldCols,
			baseID, f.TableID, f.Name, f.Type, opts(f), colors(f), f.Description, f.Formula, f.Position, len(existing) == 0, defaultJSON(f), multipleFlag(f), f.TargetTableID,
		))
		if e != nil {
			return e
		}
		created = f

		restored = 0
		if len(recordIDs) > 0 {
			key := strconv.FormatInt(f.ID, 10)
			for _, rid := range recordIDs {
				val := cellByRecord[rid]
				tag, execErr := tx.Exec(
					ctx,
					`UPDATE base_records SET cells = COALESCE(cells, '{}'::jsonb) || jsonb_build_object($4::text, $5::jsonb), updated_at = now()
					 WHERE base_id = $1 AND table_id = $2 AND id = $3`,
					baseID, targetTableID, rid, key, string(val),
				)
				if execErr != nil {
					return execErr
				}
				if tag.RowsAffected() == 1 {
					restored++
				}
			}
		}

		if _, e = tx.Exec(ctx, `INSERT INTO bt_events (base_id,body,actor_id,actor_kind) VALUES ($1,$2,$3,$4)`, baseID, fieldReload(), aid, akind); e != nil {
			return e
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return Field{}, 0, ErrConflict
		}
		return Field{}, 0, err
	}
	return created, restored, nil
}

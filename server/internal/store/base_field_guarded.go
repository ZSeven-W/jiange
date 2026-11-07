package store

import (
	"context"
	"encoding/json"
	"math"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/btformula"
	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/jackc/pgx/v5"
)

// FieldCellConverter is deterministic and must not perform I/O or access Store.
// Returning nil deletes the cell; any non-nil result must be valid JSON.
type FieldCellConverter func(Field, Field, json.RawMessage) json.RawMessage

// FieldMutation carries a schema snapshot used for formula validation. A nil
// Before creates a field; a nil After deletes it. Both non-nil updates it.
type FieldMutation struct {
	BaseID  int64
	Before  *Field
	After   *Field
	Fields  []Field
	Convert FieldCellConverter
}

type FieldMutationResult struct {
	Field  Field
	Notify []int64
}

// sameFields is intentionally strict: a field changed after API validation
// must produce a conflict rather than using validation against stale names.
func sameFields(a, b []Field) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !reflect.DeepEqual(a[i], b[i]) {
			return false
		}
	}
	return true
}

func linkTarget(f *Field) (int64, error) {
	if f == nil || f.Type != "link" {
		return 0, nil
	}
	if len(f.Options) < 1 || len(f.Options) > 2 {
		return 0, ErrConflict
	}
	id, err := strconv.ParseInt(f.Options[0], 10, 64)
	if err != nil || id < 1 || strconv.FormatInt(id, 10) != f.Options[0] {
		return 0, ErrConflict
	}
	return id, nil
}

func fieldChangesCells(before, after Field) bool {
	if before.Type != after.Type {
		return true
	}
	return (after.Type == "select" || after.Type == "multi_select") && !slices.Equal(before.Options, after.Options)
}

func fieldBefore(a, b Field) bool {
	return a.Position < b.Position || a.Position == b.Position && a.ID < b.ID
}

func fieldMutationTargets(change FieldMutation) ([]int64, error) {
	if change.BaseID <= 0 || change.Before == nil && change.After == nil {
		return nil, ErrConflict
	}
	ids := []int64{change.BaseID}
	for _, f := range []*Field{change.Before, change.After} {
		if f == nil {
			continue
		}
		if f.BaseID != change.BaseID {
			return nil, ErrConflict
		}
		target, err := linkTarget(f)
		if err != nil {
			return nil, err
		}
		if target != 0 && target != change.BaseID {
			ids = append(ids, target)
		}
	}
	return ids, nil
}

func validFieldChange(change FieldMutation, fields []Field, views []View) error {
	if !sameFields(change.Fields, fields) {
		return ErrConflict
	}
	if change.Before != nil {
		found := false
		for _, f := range fields {
			if f.ID == change.Before.ID && reflect.DeepEqual(f, *change.Before) {
				found = true
				break
			}
		}
		if !found {
			return ErrConflict
		}
		if change.Before.IsPrimary && (change.After == nil || !change.After.IsPrimary || change.Before.Position != change.After.Position) {
			return ErrPrimaryField
		}
	}
	if change.After != nil {
		f := *change.After
		if (change.Before == nil && f.IsPrimary) || (change.Before != nil && f.IsPrimary != change.Before.IsPrimary) {
			return ErrConflict
		}
		// A secondary field cannot cross the primary. A legacy primary may be
		// later in the order; preserve its existing slot without reordering data.
		if !f.IsPrimary && (change.Before != nil || f.Position != 0) && (change.Before == nil || f.Position != change.Before.Position) {
			for _, primary := range fields {
				if !primary.IsPrimary {
					continue
				}
				if change.Before == nil && f.Position <= primary.Position || change.Before != nil && fieldBefore(*change.Before, primary) != fieldBefore(f, primary) {
					return ErrPrimaryField
				}
			}
		}
		if f.Name == "" || !utf8.ValidString(f.Name) || utf8.RuneCountInString(f.Name) > 100 || !FieldTypes[f.Type] || math.IsNaN(f.Position) || math.IsInf(f.Position, 0) {
			return ErrConflict
		}
		if change.Before == nil && f.ID != 0 || change.Before != nil && f.ID != change.Before.ID {
			return ErrConflict
		}
		if f.Type == "formula" && f.Formula != "" {
			if utf8.RuneCountInString(f.Formula) > 2000 {
				return ErrConflict
			}
			names := make([]string, 0, len(fields))
			for _, existing := range fields {
				if existing.ID != f.ID {
					names = append(names, existing.Name)
				}
			}
			if err := btformula.Validate(f.Formula, names); err != nil {
				return ErrConflict
			}
		}
	}
	// Changing a two-way link's target/type needs an explicit relinking flow;
	// never silently destroy or reassign the other table's records.
	if change.Before != nil && change.After != nil && (change.Before.Type == "link" || change.After.Type == "link") && (change.Before.Type != change.After.Type || !reflect.DeepEqual(change.Before.Options, change.After.Options)) {
		return ErrConflict
	}
	if change.Before == nil && change.After.Type == "link" && len(change.After.Options) != 1 {
		return ErrConflict
	}
	semantic := change.Before != nil && (change.After == nil || fieldChangesCells(*change.Before, *change.After))
	if semantic {
		for _, view := range views {
			var cfg btquery.Config
			if len(view.Config) > 0 && string(view.Config) != "null" && json.Unmarshal(view.Config, &cfg) != nil {
				return ErrConflict
			}
			if cfg.Locked && fieldReferenced(cfg, change.Before.ID) {
				return ErrConflict
			}
		}
		if change.After != nil && change.Convert == nil {
			return ErrConflict
		}
	}
	return nil
}

func fieldReferenced(cfg btquery.Config, id int64) bool {
	if cfg.Group != nil && *cfg.Group == id {
		return true
	}
	for _, hidden := range cfg.Hidden {
		if hidden == id {
			return true
		}
	}
	for _, s := range cfg.Sorts {
		if s.F == id {
			return true
		}
	}
	if cfg.Filters != nil {
		for _, rule := range cfg.Filters.Rules {
			if rule.F == id {
				return true
			}
		}
	}
	return false
}

// reciprocalLink checks the existing pair before any cross-base change. A
// stale/mismatched target is an explicit conflict, never silently rewritten.
func reciprocalLink(source Field, targetFields []Field) (*Field, error) {
	if source.Type != "link" || len(source.Options) < 2 {
		return nil, nil
	}
	id, err := strconv.ParseInt(source.Options[1], 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != source.Options[1] || id == source.ID {
		return nil, ErrConflict
	}
	for _, candidate := range targetFields {
		if candidate.ID == id && candidate.Type == "link" && len(candidate.Options) == 2 && candidate.Options[0] == strconv.FormatInt(source.BaseID, 10) && candidate.Options[1] == strconv.FormatInt(source.ID, 10) {
			f := candidate
			return &f, nil
		}
	}
	return nil, ErrConflict
}

func fieldReload() json.RawMessage { return json.RawMessage(`{"kind":"reload"}`) }

func fieldChangeEvents(change FieldMutation, result Field) ([]json.RawMessage, error) {
	var messages []json.RawMessage
	op := "update"
	payload := map[string]any{"kind": "field"}
	if change.Before == nil {
		op = "add"
	} else if change.After == nil {
		op = "del"
		payload["fid"] = change.Before.ID
	} else if fieldChangesCells(*change.Before, *change.After) {
		messages = append(messages, fieldReload())
	}
	payload["op"] = op
	if op != "del" {
		payload["field"] = result
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return append(messages, body), nil
}

func memoryFieldsForBase(all []Field, baseID int64) []Field {
	var out []Field
	for _, f := range all {
		if f.BaseID == baseID {
			out = append(out, f)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Position < out[j].Position })
	return out
}

func (m *Memory) MutateFieldGuarded(ctx context.Context, guard BaseWriteGuard, change FieldMutation) (FieldMutationResult, error) {
	ids, err := fieldMutationTargets(change)
	if err != nil {
		return FieldMutationResult{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return FieldMutationResult{}, err
	}
	var expires time.Time
	for _, id := range ids {
		_, expiration, err := m.checkBaseWriteLocked(guard, id)
		if err != nil {
			return FieldMutationResult{}, err
		}
		if expires.IsZero() || expiration.Before(expires) {
			expires = expiration
		}
	}
	fields := memoryFieldsForBase(m.b.fields, change.BaseID)
	var views []View
	for _, v := range m.b.views {
		if v.BaseID == change.BaseID {
			views = append(views, v)
		}
	}
	if err := validFieldChange(change, fields, views); err != nil {
		return FieldMutationResult{}, err
	}
	var companion *Field
	var companionBase int64
	if change.Before != nil && change.Before.Type == "link" && len(change.Before.Options) > 1 {
		companionBase, _ = linkTarget(change.Before)
		companion, err = reciprocalLink(*change.Before, memoryFieldsForBase(m.b.fields, companionBase))
		if err != nil {
			return FieldMutationResult{}, err
		}
	}
	// Plan all rewrites before touching shared data, so errors never partially
	// delete or convert records in the in-memory store.
	type rewrite struct {
		index int
		cells map[string]json.RawMessage
	}
	var rewrites []rewrite
	if change.Before != nil && (change.After == nil || fieldChangesCells(*change.Before, *change.After)) {
		key := strconv.FormatInt(change.Before.ID, 10)
		for i, rec := range m.b.records {
			if rec.BaseID != change.BaseID {
				continue
			}
			old, ok := rec.Cells[key]
			if !ok {
				continue
			}
			cells := make(map[string]json.RawMessage, len(rec.Cells))
			for k, v := range rec.Cells {
				cells[k] = append(json.RawMessage(nil), v...)
			}
			if change.After == nil {
				delete(cells, key)
			} else {
				value := change.Convert(*change.Before, *change.After, append(json.RawMessage(nil), old...))
				if value == nil {
					delete(cells, key)
				} else if !json.Valid(value) {
					return FieldMutationResult{}, ErrConflict
				} else {
					cells[key] = append(json.RawMessage(nil), value...)
				}
			}
			rewrites = append(rewrites, rewrite{i, cells})
		}
	}
	if err := ctx.Err(); err != nil {
		return FieldMutationResult{}, err
	}
	if !guard.currentTime().Before(expires) {
		return FieldMutationResult{}, ErrUnauthenticated
	}
	result := FieldMutationResult{Notify: []int64{change.BaseID}}
	switch {
	case change.Before == nil:
		f := *change.After
		f.IsPrimary = len(fields) == 0
		f.ID = m.id()
		if f.Position == 0 {
			f.Position = float64(f.ID)
		}
		if target, _ := linkTarget(&f); target != 0 && target != change.BaseID {
			name := strings.TrimSpace(m.doc(change.BaseID).meta.Title)
			if name == "" {
				name = "未命名多维表格"
			}
			companion := Field{ID: m.id(), BaseID: target, Name: name, Type: "link", IsPrimary: len(memoryFieldsForBase(m.b.fields, target)) == 0}
			companion.Position = float64(companion.ID)
			companion.Options = []string{strconv.FormatInt(change.BaseID, 10), strconv.FormatInt(f.ID, 10)}
			f.Options = []string{strconv.FormatInt(target, 10), strconv.FormatInt(companion.ID, 10)}
			m.b.fields = append(m.b.fields, companion)
			result.Notify = append(result.Notify, target)
		}
		m.b.fields = append(m.b.fields, f)
		result.Field = f
	case change.After == nil:
		for i, f := range m.b.fields {
			if f.ID == change.Before.ID && f.BaseID == change.BaseID {
				m.b.fields = append(m.b.fields[:i], m.b.fields[i+1:]...)
				break
			}
		}
		for k := range m.links {
			if k[0] == change.Before.ID {
				delete(m.links, k)
			}
		}
		if companion != nil {
			// Keep the target's field and its data, but detach its back-pointer
			// from the removed field so it remains a valid one-way association.
			for i, f := range m.b.fields {
				if f.ID == companion.ID && f.BaseID == companionBase {
					m.b.fields[i].Options = []string{strconv.FormatInt(change.BaseID, 10)}
					break
				}
			}
			if companionBase != change.BaseID {
				result.Notify = append(result.Notify, companionBase)
			}
		}
		result.Field = *change.Before
	default:
		for i, f := range m.b.fields {
			if f.ID == change.Before.ID && f.BaseID == change.BaseID {
				m.b.fields[i] = *change.After
				break
			}
		}
		result.Field = *change.After
	}
	for _, rewrite := range rewrites {
		m.b.records[rewrite.index].Cells = rewrite.cells
	}
	events, err := fieldChangeEvents(change, result.Field)
	if err != nil {
		return FieldMutationResult{}, err
	}
	for _, id := range result.Notify {
		if id == change.BaseID {
			for _, event := range events {
				m.appendBtEventLocked(id, event)
			}
		} else {
			m.appendBtEventLocked(id, fieldReload())
		}
	}
	return result, nil
}

func pgFields(ctx context.Context, tx pgx.Tx, baseID int64) ([]Field, error) {
	rows, err := tx.Query(ctx, `SELECT `+fieldCols+` FROM base_fields WHERE base_id=$1 ORDER BY position,id`, baseID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Field, error) { return scanField(r) })
}

func pgViews(ctx context.Context, tx pgx.Tx, baseID int64) ([]View, error) {
	rows, err := tx.Query(ctx, `SELECT id,base_id,type,name,config,pos FROM bt_views WHERE base_id=$1 ORDER BY pos,id`, baseID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (v View, err error) {
		err = r.Scan(&v.ID, &v.BaseID, &v.Type, &v.Name, &v.Config, &v.Pos)
		return
	})
}

func (p *Postgres) MutateFieldGuarded(ctx context.Context, guard BaseWriteGuard, change FieldMutation) (result FieldMutationResult, err error) {
	ids, err := fieldMutationTargets(change)
	if err != nil {
		return result, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, err := lockBaseWrites(ctx, tx, guard, ids)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `LOCK TABLE base_fields,base_records,bt_links IN SHARE ROW EXCLUSIVE MODE`); err != nil {
			return err
		}
		fields, err := pgFields(ctx, tx, change.BaseID)
		if err != nil {
			return err
		}
		views, err := pgViews(ctx, tx, change.BaseID)
		if err != nil {
			return err
		}
		if err = validFieldChange(change, fields, views); err != nil {
			return err
		}
		var companion *Field
		var companionBase int64
		if change.Before != nil && change.Before.Type == "link" && len(change.Before.Options) > 1 {
			companionBase, _ = linkTarget(change.Before)
			targetFields, err := pgFields(ctx, tx, companionBase)
			if err != nil {
				return err
			}
			companion, err = reciprocalLink(*change.Before, targetFields)
			if err != nil {
				return err
			}
		}
		result.Notify = []int64{change.BaseID}
		switch {
		case change.Before == nil:
			f := *change.After
			f, err = scanField(tx.QueryRow(ctx, `INSERT INTO base_fields (base_id,name,type,options,option_colors,description,formula,position,is_primary) VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8::float8=0 THEN COALESCE((SELECT max(position) FROM base_fields WHERE base_id=$1),0)+1 ELSE $8 END,$9) RETURNING `+fieldCols, change.BaseID, f.Name, f.Type, opts(f), colors(f), f.Description, f.Formula, f.Position, len(fields) == 0))
			if err != nil {
				return err
			}
			if target, _ := linkTarget(&f); target != 0 && target != change.BaseID {
				var name string
				if err = tx.QueryRow(ctx, `SELECT title FROM nodes WHERE id=$1`, change.BaseID).Scan(&name); err != nil {
					return err
				}
				name = strings.TrimSpace(name)
				if name == "" {
					name = "未命名多维表格"
				}
				companion, err := scanField(tx.QueryRow(ctx, `INSERT INTO base_fields (base_id,name,type,options,position,is_primary) VALUES ($1,$2,'link',$3,COALESCE((SELECT max(position) FROM base_fields WHERE base_id=$1),0)+1,NOT EXISTS (SELECT 1 FROM base_fields WHERE base_id=$1)) RETURNING `+fieldCols, target, name, opts(Field{Options: []string{strconv.FormatInt(change.BaseID, 10), strconv.FormatInt(f.ID, 10)}})))
				if err != nil {
					return err
				}
				f.Options = []string{strconv.FormatInt(target, 10), strconv.FormatInt(companion.ID, 10)}
				if _, err = tx.Exec(ctx, `UPDATE base_fields SET options=$3 WHERE base_id=$1 AND id=$2`, change.BaseID, f.ID, opts(f)); err != nil {
					return err
				}
				result.Notify = append(result.Notify, target)
			}
			result.Field = f
		case change.After == nil:
			if _, err = tx.Exec(ctx, `DELETE FROM base_fields WHERE base_id=$1 AND id=$2`, change.BaseID, change.Before.ID); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `UPDATE base_records SET cells=cells-$2 WHERE base_id=$1 AND cells ? $2`, change.BaseID, strconv.FormatInt(change.Before.ID, 10)); err != nil {
				return err
			}
			if companion != nil {
				if _, err = tx.Exec(ctx, `UPDATE base_fields SET options=$3 WHERE base_id=$1 AND id=$2`, companionBase, companion.ID, opts(Field{Options: []string{strconv.FormatInt(change.BaseID, 10)}})); err != nil {
					return err
				}
				if companionBase != change.BaseID {
					result.Notify = append(result.Notify, companionBase)
				}
			}
			result.Field = *change.Before
		default:
			f := *change.After
			if _, err = tx.Exec(ctx, `UPDATE base_fields SET name=$3,type=$4,options=$5,option_colors=$6,description=$7,formula=$8,position=$9 WHERE base_id=$1 AND id=$2`, change.BaseID, f.ID, f.Name, f.Type, opts(f), colors(f), f.Description, f.Formula, f.Position); err != nil {
				return err
			}
			if fieldChangesCells(*change.Before, f) {
				key := strconv.FormatInt(f.ID, 10)
				rows, err := tx.Query(ctx, `SELECT id,cells-> $2 FROM base_records WHERE base_id=$1 AND cells ? $2 FOR UPDATE`, change.BaseID, key)
				if err != nil {
					return err
				}
				type pair struct {
					id    int64
					value json.RawMessage
				}
				var values []pair
				for rows.Next() {
					var x pair
					if err := rows.Scan(&x.id, &x.value); err != nil {
						rows.Close()
						return err
					}
					values = append(values, x)
				}
				if err := rows.Err(); err != nil {
					rows.Close()
					return err
				}
				rows.Close()
				for _, x := range values {
					value := change.Convert(*change.Before, f, x.value)
					if value == nil {
						_, err = tx.Exec(ctx, `UPDATE base_records SET cells=cells-$3 WHERE base_id=$1 AND id=$2`, change.BaseID, x.id, key)
					} else if !json.Valid(value) {
						return ErrConflict
					} else {
						_, err = tx.Exec(ctx, `UPDATE base_records SET cells=cells||jsonb_build_object($3::text,$4::jsonb) WHERE base_id=$1 AND id=$2`, change.BaseID, x.id, key, value)
					}
					if err != nil {
						return err
					}
				}
			}
			result.Field = f
		}
		events, err := fieldChangeEvents(change, result.Field)
		if err != nil {
			return err
		}
		for _, id := range result.Notify {
			bodies := []json.RawMessage{fieldReload()}
			if id == change.BaseID {
				bodies = events
			}
			for _, body := range bodies {
				if _, err = tx.Exec(ctx, `INSERT INTO bt_events (base_id,body) VALUES ($1,$2)`, id, body); err != nil {
					return err
				}
			}
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return FieldMutationResult{}, ErrConflict
		}
		return FieldMutationResult{}, err
	}
	return result, nil
}

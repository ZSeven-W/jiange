package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"reflect"
	"sort"

	"github.com/jackc/pgx/v5"
)

// PublicFormConfigBuilder returns a validated form configuration based on the
// current form and schema. It runs while the store is locked and must not do
// I/O or call back into the Store.
type PublicFormConfigBuilder func(View, []Field) (json.RawMessage, error)

// PublicFormSupportsField is the anonymous form's writable field set. Fields
// requiring user, file or linked-record authorization cannot yet be exposed.
func PublicFormSupportsField(typ string) bool {
	switch typ {
	case "text", "number", "select", "multi_select", "checkbox", "date", "url", "phone", "email", "rating":
		return true
	default:
		return false
	}
}

func decodePublicFormObject(raw json.RawMessage) (map[string]any, bool) {
	if len(raw) == 0 || len(raw) > 1<<20 {
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if dec.Decode(&v) != nil {
		return nil, false
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return nil, false
	}
	object, ok := v.(map[string]any)
	return object, ok && object != nil
}

// json.Number values are compared exactly, avoiding float64 rounding for
// large IDs. Very large numeric spellings are compared literally to bound CPU.
func publicFormJSONEqual(a, b any) bool {
	switch x := a.(type) {
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		if x == y {
			return true
		}
		if len(x) > 128 || len(y) > 128 {
			return false
		}
		// Avoid allocating huge rational numbers from adversarial exponents.
		for _, n := range []string{string(x), string(y)} {
			if i := bytes.IndexAny([]byte(n), "eE"); i >= 0 {
				var exponent int
				if _, err := fmt.Sscanf(n[i+1:], "%d", &exponent); err != nil || exponent < -512 || exponent > 512 {
					return false
				}
			}
		}
		xr, xok := new(big.Rat).SetString(string(x))
		yr, yok := new(big.Rat).SetString(string(y))
		return xok && yok && xr.Cmp(yr) == 0
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for key, value := range x {
			other, exists := y[key]
			if !exists || !publicFormJSONEqual(value, other) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !publicFormJSONEqual(x[i], y[i]) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(a, b)
	}
}

func samePublicFormConfig(a, b json.RawMessage) bool {
	if len(a) == 0 {
		a = json.RawMessage(`{}`)
	}
	x, ok := decodePublicFormObject(a)
	if !ok {
		return false
	}
	y, ok := decodePublicFormObject(b)
	return ok && publicFormJSONEqual(x, y)
}

// PublicFormConfigExtrasEqual protects unrelated view settings (including
// filters/locked) when a manager edits only the form's presentation fields.
func PublicFormConfigExtrasEqual(current, proposed json.RawMessage) bool {
	if len(current) == 0 {
		current = json.RawMessage(`{}`)
	}
	before, ok := decodePublicFormObject(current)
	if !ok {
		return false
	}
	after, ok := decodePublicFormObject(proposed)
	if !ok {
		return false
	}
	for _, key := range []string{"title", "desc", "fields", "required"} {
		delete(before, key)
		delete(after, key)
	}
	return publicFormJSONEqual(before, after)
}

// samePublicFormSnapshot compares the actual form/schema with the exact
// snapshot shown to the manager. Clients may omit BaseID from Field objects;
// server-side membership of every current field is checked separately.
func samePublicFormSnapshot(view View, fields []Field, expectedConfig json.RawMessage, expectedFields []Field) bool {
	if expectedFields == nil || !samePublicFormConfig(view.Config, expectedConfig) || len(fields) != len(expectedFields) {
		return false
	}
	normalize := func(in []Field) []Field {
		out := append([]Field(nil), in...)
		for i := range out {
			out[i].BaseID = 0
			// Base GET strips target options for inaccessible relations. Such
			// fields cannot appear in a public form, so compare only the
			// metadata a manager is authorized to preview for those types.
			if !PublicFormSupportsField(out[i].Type) {
				out[i].Options = nil
				out[i].OptionColors = nil
				out[i].Formula = ""
			}
			if len(out[i].Options) == 0 {
				out[i].Options = nil
			}
			if len(out[i].OptionColors) == 0 {
				out[i].OptionColors = nil
			}
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].Position == out[j].Position {
				return out[i].ID < out[j].ID
			}
			return out[i].Position < out[j].Position
		})
		return out
	}
	for _, field := range fields {
		if field.BaseID != view.BaseID {
			return false
		}
	}
	return reflect.DeepEqual(normalize(fields), normalize(expectedFields))
}

func orderedPublicFormFields(fields []Field) {
	sort.Slice(fields, func(i, j int) bool {
		if fields[i].Position == fields[j].Position {
			return fields[i].ID < fields[j].ID
		}
		return fields[i].Position < fields[j].Position
	})
}

func (m *Memory) SetPublicFormConfig(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64, expectedConfig json.RawMessage, expectedFields []Field, build PublicFormConfigBuilder) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if build == nil {
		return View{}, ErrInvalidBaseRecord
	}
	role, expiry, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return View{}, err
	}
	if role != RoleManage {
		return View{}, ErrForbidden
	}
	view, fields, err := m.readPublicFormLocked(ctx, baseID, viewID)
	if err != nil {
		return View{}, err
	}
	orderedPublicFormFields(fields)
	if !samePublicFormSnapshot(view, fields, expectedConfig, expectedFields) {
		return View{}, ErrConflict
	}
	config, err := build(view, fields)
	if err != nil {
		return View{}, err
	}
	if _, ok := decodePublicFormObject(config); !ok {
		return View{}, ErrInvalidBaseRecord
	}
	if err := ctx.Err(); err != nil {
		return View{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return View{}, ErrUnauthenticated
	}
	if samePublicFormConfig(view.Config, config) {
		return view, nil
	}
	for i, v := range m.b.views {
		if v.ID == viewID && v.BaseID == baseID {
			m.b.views[i].Config = append(json.RawMessage(nil), config...)
			view.Config = append(json.RawMessage(nil), config...)
			m.recordViewReloadLocked(baseID)
			return view, nil
		}
	}
	return View{}, ErrNotFound
}

func (p *Postgres) SetPublicFormConfig(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64, expectedConfig json.RawMessage, expectedFields []Field, build PublicFormConfigBuilder) (result View, err error) {
	if build == nil {
		return View{}, ErrInvalidBaseRecord
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		role, expiry, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		if role != RoleManage {
			return ErrForbidden
		}
		// Same order as Base writes; protects against legacy field writers too.
		if _, err := tx.Exec(ctx, `LOCK TABLE base_fields IN SHARE MODE`); err != nil {
			return err
		}
		view, fields, err := pgReadPublicFormLocked(ctx, tx, baseID, viewID)
		if err != nil {
			return err
		}
		orderedPublicFormFields(fields)
		if !samePublicFormSnapshot(view, fields, expectedConfig, expectedFields) {
			return ErrConflict
		}
		config, err := build(view, fields)
		if err != nil {
			return err
		}
		if _, ok := decodePublicFormObject(config); !ok {
			return ErrInvalidBaseRecord
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		result = view
		if samePublicFormConfig(view.Config, config) {
			return nil
		}
		if err := tx.QueryRow(ctx, `UPDATE bt_views SET config=$3 WHERE base_id=$1 AND id=$2 AND type='form' RETURNING config`, baseID, viewID, config).Scan(&result.Config); err != nil {
			return notFound(err)
		}
		if err := pgViewReload(ctx, tx, baseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		return View{}, err
	}
	return result, nil
}

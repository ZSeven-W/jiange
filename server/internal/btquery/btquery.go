// Package btquery compiles bitable view configs (filters + sorts) into SQL
// fragments for jsonb cell columns, or evaluates them in memory. Field ids
// are always checked against the actual field list and values always become
// bind parameters, so view configs cannot inject SQL.
package btquery

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// FieldSpec is the compiler's view of a field (decoupled from the store so
// both can depend on this package).
type FieldSpec struct {
	ID      int64
	Type    string
	Options []string
}

// Rule is one filter condition. Ops: contains, not_contains, is, is_not,
// empty, not_empty, gt, gte, lt, lte, checked, unchecked.
type Rule struct {
	F  int64  `json:"f"`
	Op string `json:"op"`
	V  any    `json:"v,omitempty"`
}

type Filters struct {
	Conj  string `json:"conj"` // and | or
	Rules []Rule `json:"rules"`
}

type Sort struct {
	F   int64 `json:"f"`
	Asc bool  `json:"asc"`
}

// Config is what a saved view keeps in bt_views.config.
type Config struct {
	Filters *Filters `json:"filters,omitempty"`
	Sorts   []Sort   `json:"sorts,omitempty"`
	Group   *int64   `json:"group,omitempty"`
	Hidden  []int64  `json:"hidden,omitempty"`
}

var ops = map[string]bool{
	"contains": true, "not_contains": true, "is": true, "is_not": true,
	"empty": true, "not_empty": true, "gt": true, "gte": true, "lt": true, "lte": true,
	"checked": true, "unchecked": true,
}

// Validate checks a config against the base's fields.
func Validate(fields []FieldSpec, cfg Config) error {
	byID := map[int64]struct{}{}
	for _, f := range fields {
		byID[f.ID] = struct{}{}
	}
	if cfg.Filters != nil && len(cfg.Filters.Rules) > 0 {
		if cfg.Filters.Conj != "and" && cfg.Filters.Conj != "or" {
			return fmt.Errorf("conj must be and/or")
		}
		for _, r := range cfg.Filters.Rules {
			if !ops[r.Op] {
				return fmt.Errorf("unknown op %q", r.Op)
			}
			if _, ok := byID[r.F]; !ok {
				return fmt.Errorf("unknown field %d", r.F)
			}
		}
	}
	for _, s := range cfg.Sorts {
		if _, ok := byID[s.F]; !ok {
			return fmt.Errorf("unknown field %d", s.F)
		}
	}
	for _, id := range cfg.Hidden {
		if _, ok := byID[id]; !ok {
			return fmt.Errorf("unknown field %d", id)
		}
	}
	if cfg.Group != nil {
		if _, ok := byID[*cfg.Group]; !ok {
			return fmt.Errorf("unknown field %d", *cfg.Group)
		}
	}
	return nil
}

// Compile renders a config into a WHERE fragment (without the keyword), its
// bind args and an ORDER BY fragment. Values are always bind parameters and
// field ids only enter the SQL as decimal ints, never as user text.
func Compile(fields []FieldSpec, cfg Config, seedArgs ...any) (where string, args []any, order string, err error) {
	if err := Validate(fields, cfg); err != nil {
		return "", nil, "", err
	}
	byID := map[int64]FieldSpec{}
	for _, f := range fields {
		byID[f.ID] = f
	}
	args = append(args, seedArgs...)
	next := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	if cfg.Filters != nil && len(cfg.Filters.Rules) > 0 {
		parts := make([]string, 0, len(cfg.Filters.Rules))
		for _, r := range cfg.Filters.Rules {
			if sql := ruleSQL(byID[r.F], r, next); sql != "" {
				parts = append(parts, sql)
			}
		}
		conj := " AND "
		if cfg.Filters.Conj == "or" {
			conj = " OR "
		}
		where = strings.Join(parts, conj)
	}
	if len(cfg.Sorts) > 0 {
		parts := make([]string, 0, len(cfg.Sorts))
		for _, s := range cfg.Sorts {
			parts = append(parts, sortSQL(byID[s.F], s.Asc))
		}
		order = strings.Join(parts, ", ")
	}
	return where, args, order, nil
}

func key(f FieldSpec) string { return strconv.FormatInt(f.ID, 10) }

// ruleSQL builds one predicate; value-taking rules call next(v) for a bind placeholder.
func ruleSQL(f FieldSpec, r Rule, next func(any) string) string {
	cell := "(cells ->> '" + key(f) + "')" // key() is a validated decimal int64
	exists := "(cells ? '" + key(f) + "')"
	switch r.Op {
	case "contains":
		return fmt.Sprintf("%s LIKE '%%' || %s || '%%'", cell, next(r.V))
	case "not_contains":
		return fmt.Sprintf("(NOT %s LIKE '%%' || %s || '%%')", cell, next(r.V))
	case "is":
		return fmt.Sprintf("%s = %s", cell, next(r.V))
	case "is_not":
		return fmt.Sprintf("%s <> %s", cell, next(r.V))
	case "empty":
		return fmt.Sprintf("(NOT %s OR %s IN ('', 'null', '[]'))", exists, cell)
	case "not_empty":
		return fmt.Sprintf("(%s AND %s NOT IN ('', 'null', '[]'))", exists, cell)
	case "checked":
		return cell + " = 'true'"
	case "unchecked":
		return fmt.Sprintf("(%s = 'false' OR NOT %s)", cell, exists)
	case "gt", "gte", "lt", "lte":
		op := map[string]string{"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[r.Op]
		if f.Type == "number" {
			// compare numerically only when the cell really is a json number
			return fmt.Sprintf("(jsonb_typeof(cells -> '%s') = 'number' AND (%s)::float8 %s (%s)::float8)",
				key(f), cell, op, next(r.V))
		}
		return fmt.Sprintf("%s %s %s", cell, op, next(r.V))
	}
	return ""
}

func sortSQL(f FieldSpec, asc bool) string {
	dir := "DESC"
	if asc {
		dir = "ASC"
	}
	cell := "(cells ->> '" + key(f) + "')"
	switch f.Type {
	case "number":
		return fmt.Sprintf("(%s)::float8 %s NULLS LAST", cell, dir)
	case "checkbox":
		return fmt.Sprintf("(%s = 'true') %s NULLS LAST", cell, dir)
	case "select":
		// order by the option list position
		cases := make([]string, 0, len(f.Options))
		for i, o := range f.Options {
			cases = append(cases, fmt.Sprintf("WHEN %s = '%s' THEN %d", cell, optEscape(o), i))
		}
		return fmt.Sprintf("CASE %s ELSE %d END %s NULLS LAST", strings.Join(cases, " "), len(f.Options), dir)
	default:
		return fmt.Sprintf("%s %s NULLS LAST", cell, dir)
	}
}

// optEscape guards select options embedded in CASE branches: they come from
// the field's own options list, quotes are doubled to stay inside the literal.
func optEscape(o string) string { return strings.ReplaceAll(o, "'", "''") }

// Match evaluates the filters against one record's cells in memory (the
// Memory store twin of the compiled SQL path).
func Match(fields []FieldSpec, cfg Config, cells map[string]json.RawMessage) bool {
	if cfg.Filters == nil || len(cfg.Filters.Rules) == 0 {
		return true
	}
	result := cfg.Filters.Conj != "or"
	for _, r := range cfg.Filters.Rules {
		m := matchRule(r, cells[strconv.FormatInt(r.F, 10)])
		if cfg.Filters.Conj == "or" {
			result = result || m
		} else {
			result = result && m
		}
	}
	return result
}

func matchRule(r Rule, raw json.RawMessage) bool {
	var v any
	ok := len(raw) > 0
	if ok {
		ok = json.Unmarshal(raw, &v) == nil
	}
	s := ""
	if ok {
		s = toString(v)
	}
	switch r.Op {
	case "empty":
		return !ok || s == "" || s == "null" || s == "[]"
	case "not_empty":
		return ok && s != "" && s != "null" && s != "[]"
	case "contains":
		return ok && strings.Contains(s, toString(r.V))
	case "not_contains":
		return !ok || !strings.Contains(s, toString(r.V))
	case "is":
		return ok && s == toString(r.V)
	case "is_not":
		return !ok || s != toString(r.V)
	case "checked":
		return ok && v == true
	case "unchecked":
		return !ok || v != true
	case "gt", "gte", "lt", "lte":
		if !ok {
			return false
		}
		if a, aok := toFloat(v); aok {
			if b, bok := toFloat(r.V); bok {
				switch r.Op {
				case "gt":
					return a > b
				case "gte":
					return a >= b
				case "lt":
					return a < b
				case "lte":
					return a <= b
				}
			}
		}
		switch r.Op {
		case "gt":
			return s > toString(r.V)
		case "gte":
			return s >= toString(r.V)
		case "lt":
			return s < toString(r.V)
		case "lte":
			return s <= toString(r.V)
		}
	}
	return false
}

func toString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	case nil:
		return ""
	}
	return fmt.Sprint(v)
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case string:
		f, err := strconv.ParseFloat(x, 64)
		return f, err == nil
	}
	return 0, false
}

// SortIndexes returns the visit order of n records (by index) under the
// config's sort rules; empty cells sort last. cellsOf must be valid for i in [0,n).
func SortIndexes(fields []FieldSpec, cfg Config, n int, cellsOf func(i int) map[string]json.RawMessage) []int {
	idx := make([]int, n)
	for i := range idx {
		idx[i] = i
	}
	if len(cfg.Sorts) == 0 {
		return idx
	}
	byID := map[int64]FieldSpec{}
	for _, f := range fields {
		byID[f.ID] = f
	}
	cellText := func(cells map[string]json.RawMessage, id int64) (string, bool) {
		raw, ok := cells[strconv.FormatInt(id, 10)]
		if !ok {
			return "", false
		}
		var v any
		if json.Unmarshal(raw, &v) != nil {
			return string(raw), true
		}
		return toString(v), true
	}
	empty := func(cells map[string]json.RawMessage, id int64) bool {
		s, ok := cellText(cells, id)
		return !ok || s == "" || s == "[]" || s == "null"
	}
	sort.SliceStable(idx, func(a, b int) bool {
		ci, cj := cellsOf(idx[a]), cellsOf(idx[b])
		for _, s := range cfg.Sorts {
			if empty(ci, s.F) && empty(cj, s.F) {
				continue
			}
			if empty(ci, s.F) {
				return false
			}
			if empty(cj, s.F) {
				return true
			}
			f := byID[s.F]
			si, _ := cellText(ci, s.F)
			sj, _ := cellText(cj, s.F)
			var c int
			switch f.Type {
			case "number", "person", "created_by":
				x, _ := toFloat(rawToAny(ci[key(f)]))
				y, _ := toFloat(rawToAny(cj[key(f)]))
				c = int(x - y)
			case "checkbox":
				c = int(btoi(si == "true") - btoi(sj == "true"))
			case "select":
				c = optIndex(f.Options, si) - optIndex(f.Options, sj)
			default:
				c = strings.Compare(si, sj)
			}
			if c != 0 {
				if s.Asc {
					return c < 0
				}
				return c > 0
			}
		}
		return false
	})
	return idx
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

func optIndex(options []string, v string) int {
	for i, o := range options {
		if o == v {
			return i
		}
	}
	return len(options)
}

func rawToAny(raw json.RawMessage) any {
	var v any
	if json.Unmarshal(raw, &v) == nil {
		return v
	}
	return nil
}

// Package btquery compiles bitable view configs (filters + sorts) into SQL
// fragments for jsonb cell columns, or evaluates them in memory. Field ids
// are always checked against the actual field list and values always become
// bind parameters, so view configs cannot inject SQL.
package btquery

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// FieldSpec is the compiler's view of a field (decoupled from the store so
// both can depend on this package).
type FieldSpec struct {
	ID        int64
	Type      string
	Options   []string
	IsPrimary bool
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

// PermissionRole defines a Feishu-style custom permission role scoped to
// matched users, departments, and/or user groups on a shared view.
type PermissionRole struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	UserIDs         []int64           `json:"userIds,omitempty"`
	DeptIDs         []int64           `json:"deptIds,omitempty"`
	GroupIDs        []int64           `json:"groupIds,omitempty"`
	CanAddRecord    *bool             `json:"canAddRecord,omitempty"`    // nil = true
	CanDeleteRecord *bool             `json:"canDeleteRecord,omitempty"` // nil = true
	RowScope        string            `json:"rowScope,omitempty"`        // "" | "all" | "own" | "filter"
	RowFilters      *Filters          `json:"rowFilters,omitempty"`      // required/validated when rowScope == "filter"
	FieldModes      map[string]string `json:"fieldModes,omitempty"`      // fieldId -> edit|readonly|hidden
	ViewHidden      bool              `json:"viewHidden,omitempty"`      // hides this view from matched role
}

// ViewPermissions defines fine-grained row, field, and multi-role RBAC
// permissions persisted on a shared view.
type ViewPermissions struct {
	OnlyOwnRecords bool              `json:"onlyOwnRecords,omitempty"`
	FieldModes     map[string]string `json:"fieldModes,omitempty"`
	Roles          []PermissionRole  `json:"roles,omitempty"`
}

// GanttDependency represents a directed finish-to-start task edge persisted on a Gantt view.
type GanttDependency struct {
	ID     string `json:"id"`
	FromID int64  `json:"fromId"`
	ToID   int64  `json:"toId"`
}

// Config is what a saved view keeps in bt_views.config.
type Config struct {
	Filters  *Filters `json:"filters,omitempty"`
	Sorts    []Sort   `json:"sorts,omitempty"`
	Group    *int64   `json:"group,omitempty"`
	EndField *int64   `json:"endField,omitempty"`
	Hidden   []int64  `json:"hidden,omitempty"`
	// Locked marks an admin data-permission view: its filters act as a mandatory
	// row predicate and its hidden fields are stripped for non-manage roles.
	Locked bool `json:"locked,omitempty"`
	// ConfigLocked locks this shared view's layout/filter/sort configuration to
	// manage roles without restricting record/field data access or data edits.
	ConfigLocked bool `json:"configLocked,omitempty"`
	// Permissions defines fine-grained row (onlyOwnRecords) and per-field
	// (edit/readonly/hidden) permissions enforced server-side for non-manage roles.
	Permissions *ViewPermissions `json:"permissions,omitempty"`
	// GanttDeps persists directed task dependency edges for Gantt views.
	GanttDeps []GanttDependency `json:"ganttDeps,omitempty"`
	// FieldWidths persists per-column widths (fieldId -> px in [60, 1200]).
	FieldWidths map[string]int `json:"fieldWidths,omitempty"`
	// FieldStats persists per-column summary stat modes (fieldId -> stat key).
	FieldStats map[string]string `json:"fieldStats,omitempty"`
}

var ops = map[string]bool{
	"contains": true, "not_contains": true, "is": true, "is_not": true,
	"empty": true, "not_empty": true, "gt": true, "gte": true, "lt": true, "lte": true,
	"checked": true, "unchecked": true,
}

var validFieldStats = map[string]bool{
	"none":        true,
	"count":       true,
	"empty":       true,
	"filled":      true,
	"unique":      true,
	"sum":         true,
	"avg":         true,
	"min":         true,
	"max":         true,
	"checked":     true,
	"unchecked":   true,
	"pct_checked": true,
}

// ValidateFilters checks a filter conjunction and its rules against fields.
func ValidateFilters(fields []FieldSpec, filters Filters) error {
	byID := make(map[int64]FieldSpec, len(fields))
	for _, f := range fields {
		byID[f.ID] = f
	}
	return validateFiltersMap(byID, filters)
}

func validateFiltersMap(byID map[int64]FieldSpec, filters Filters) error {
	if len(filters.Rules) == 0 {
		if filters.Conj != "" && filters.Conj != "and" && filters.Conj != "or" {
			return fmt.Errorf("conj must be and/or")
		}
		return nil
	}
	if filters.Conj != "and" && filters.Conj != "or" {
		return fmt.Errorf("conj must be and/or")
	}
	for _, r := range filters.Rules {
		if !ops[r.Op] {
			return fmt.Errorf("unknown op %q", r.Op)
		}
		f, ok := byID[r.F]
		if !ok {
			return fmt.Errorf("unknown field %d", r.F)
		}
		if f.Type == "number" || f.Type == "rating" || f.Type == "person" {
			switch r.Op {
			case "is", "is_not", "gt", "gte", "lt", "lte":
				value, ok := toFloat(r.V)
				if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
					return fmt.Errorf("field %d requires a finite number", r.F)
				}
			}
		}
		if f.Type == "person" && (r.Op == "contains" || r.Op == "not_contains") {
			if _, ok := personIDs(r.V); !ok {
				return fmt.Errorf("field %d requires member id(s)", r.F)
			}
		}
	}
	return nil
}

func validateFieldModes(byID map[int64]FieldSpec, modes map[string]string) error {
	for fidStr, mode := range modes {
		fid, err := strconv.ParseInt(fidStr, 10, 64)
		if err != nil || fid <= 0 || strconv.FormatInt(fid, 10) != fidStr {
			return fmt.Errorf("unknown field %s", fidStr)
		}
		spec, ok := byID[fid]
		if !ok {
			return fmt.Errorf("unknown field %d", fid)
		}
		switch mode {
		case "edit", "readonly":
		case "hidden":
			if spec.IsPrimary {
				return fmt.Errorf("primary field %d cannot be hidden", fid)
			}
		default:
			return fmt.Errorf("invalid field permission mode %q", mode)
		}
	}
	return nil
}

func validateRoleSubjectIDs(kind string, ids []int64) error {
	if len(ids) > 200 {
		return fmt.Errorf("too many %s in role (max 200)", kind)
	}
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id <= 0 {
			return fmt.Errorf("%s id must be positive", kind)
		}
		if seen[id] {
			return fmt.Errorf("duplicate %s id %d", kind, id)
		}
		seen[id] = true
	}
	return nil
}

func validateViewPermissions(fields []FieldSpec, byID map[int64]FieldSpec, perms *ViewPermissions) error {
	if perms == nil {
		return nil
	}
	if err := validateFieldModes(byID, perms.FieldModes); err != nil {
		return err
	}
	if len(perms.Roles) > 32 {
		return fmt.Errorf("too many permission roles (max 32)")
	}
	seenIDs := make(map[string]bool, len(perms.Roles))
	for _, r := range perms.Roles {
		if r.ID == "" || strings.TrimSpace(r.ID) == "" || len(r.ID) > 64 || !utf8.ValidString(r.ID) || strings.ContainsRune(r.ID, 0) {
			return fmt.Errorf("invalid permission role id")
		}
		if seenIDs[r.ID] {
			return fmt.Errorf("duplicate permission role id %q", r.ID)
		}
		seenIDs[r.ID] = true

		name := strings.TrimSpace(r.Name)
		if name == "" || !utf8.ValidString(r.Name) || strings.ContainsRune(r.Name, 0) || utf8.RuneCountInString(name) > 64 {
			return fmt.Errorf("invalid permission role name")
		}
		if err := validateRoleSubjectIDs("userIds", r.UserIDs); err != nil {
			return err
		}
		if err := validateRoleSubjectIDs("deptIds", r.DeptIDs); err != nil {
			return err
		}
		if err := validateRoleSubjectIDs("groupIds", r.GroupIDs); err != nil {
			return err
		}
		switch r.RowScope {
		case "", "all", "own", "filter":
		default:
			return fmt.Errorf("invalid row scope %q", r.RowScope)
		}
		if r.RowScope == "filter" && r.RowFilters != nil {
			if err := ValidateFilters(fields, *r.RowFilters); err != nil {
				return fmt.Errorf("role %q rowFilters: %w", r.ID, err)
			}
		} else if r.RowFilters != nil && len(r.RowFilters.Rules) > 0 {
			if err := ValidateFilters(fields, *r.RowFilters); err != nil {
				return fmt.Errorf("role %q rowFilters: %w", r.ID, err)
			}
		}
		if err := validateFieldModes(byID, r.FieldModes); err != nil {
			return err
		}
	}
	return nil
}

// Validate checks a config against the base's fields.
func Validate(fields []FieldSpec, cfg Config) error {
	byID := map[int64]FieldSpec{}
	for _, f := range fields {
		byID[f.ID] = f
	}
	if cfg.Filters != nil && len(cfg.Filters.Rules) > 0 {
		if err := validateFiltersMap(byID, *cfg.Filters); err != nil {
			return err
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
	if cfg.EndField != nil {
		if _, ok := byID[*cfg.EndField]; !ok {
			return fmt.Errorf("unknown field %d", *cfg.EndField)
		}
	}
	if err := validateViewPermissions(fields, byID, cfg.Permissions); err != nil {
		return err
	}
	if len(cfg.GanttDeps) > 500 {
		return fmt.Errorf("too many gantt dependencies (max 500)")
	}
	if len(cfg.GanttDeps) > 0 {
		seenPairs := make(map[[2]int64]bool, len(cfg.GanttDeps))
		adj := make(map[int64][]int64, len(cfg.GanttDeps))
		for _, dep := range cfg.GanttDeps {
			if dep.FromID <= 0 || dep.ToID <= 0 {
				return fmt.Errorf("gantt dependency record ids must be positive")
			}
			if dep.FromID == dep.ToID {
				return fmt.Errorf("gantt dependency cannot reference itself (%d)", dep.FromID)
			}
			if len(dep.ID) > 200 || strings.ContainsRune(dep.ID, 0) {
				return fmt.Errorf("invalid gantt dependency id")
			}
			pair := [2]int64{dep.FromID, dep.ToID}
			if seenPairs[pair] {
				return fmt.Errorf("duplicate gantt dependency %d->%d", dep.FromID, dep.ToID)
			}
			seenPairs[pair] = true
			adj[dep.FromID] = append(adj[dep.FromID], dep.ToID)
		}
		state := make(map[int64]uint8, len(adj))
		var hasCycle func(int64) bool
		hasCycle = func(node int64) bool {
			state[node] = 1
			for _, next := range adj[node] {
				switch state[next] {
				case 1:
					return true
				case 0:
					if hasCycle(next) {
						return true
					}
				}
			}
			state[node] = 2
			return false
		}
		for node := range adj {
			if state[node] == 0 && hasCycle(node) {
				return fmt.Errorf("gantt dependencies contain a cycle")
			}
		}
	}
	if err := validateFieldWidths(cfg.FieldWidths); err != nil {
		return err
	}
	if err := validateFieldStats(cfg.FieldStats); err != nil {
		return err
	}
	return nil
}

func validatePositiveFieldKey(fidStr string) error {
	fid, err := strconv.ParseInt(fidStr, 10, 64)
	if err != nil || fid <= 0 || strconv.FormatInt(fid, 10) != fidStr {
		return fmt.Errorf("invalid field id %q", fidStr)
	}
	return nil
}

func validateFieldWidths(widths map[string]int) error {
	if len(widths) > 200 {
		return fmt.Errorf("too many fieldWidths entries (max 200)")
	}
	for fidStr, w := range widths {
		if err := validatePositiveFieldKey(fidStr); err != nil {
			return fmt.Errorf("fieldWidths: %w", err)
		}
		if w < 60 || w > 1200 {
			return fmt.Errorf("fieldWidths[%s] must be between 60 and 1200", fidStr)
		}
	}
	return nil
}

func validateFieldStats(stats map[string]string) error {
	if len(stats) > 200 {
		return fmt.Errorf("too many fieldStats entries (max 200)")
	}
	for fidStr, st := range stats {
		if err := validatePositiveFieldKey(fidStr); err != nil {
			return fmt.Errorf("fieldStats: %w", err)
		}
		if !validFieldStats[st] {
			return fmt.Errorf("invalid field stat %q", st)
		}
	}
	return nil
}

// ValidateLocked rejects policies whose field/operator semantics are not yet
// equivalent between PostgreSQL and Memory. Such a policy must never silently
// become a weaker row restriction on either backend.
func ValidateLocked(fields []FieldSpec, cfg Config) error {
	if err := Validate(fields, cfg); err != nil {
		return err
	}
	byID := make(map[int64]FieldSpec, len(fields))
	for _, f := range fields {
		byID[f.ID] = f
	}
	if cfg.Filters == nil {
		return nil
	}
	for _, rule := range cfg.Filters.Rules {
		field := byID[rule.F]
		if rule.Op == "empty" || rule.Op == "not_empty" {
			switch field.Type {
			case "text", "select", "date", "url", "phone", "email", "number", "rating", "person", "checkbox", "multi_select", "attachment":
				continue
			}
			return fmt.Errorf("locked filter on %s is not supported", field.Type)
		}
		switch field.Type {
		case "text", "select", "date", "url", "phone", "email":
			if rule.Op == "checked" || rule.Op == "unchecked" {
				return fmt.Errorf("operator %s is not supported for %s in a locked filter", rule.Op, field.Type)
			}
			if _, ok := rule.V.(string); !ok {
				return fmt.Errorf("locked filter value for %s must be text", field.Type)
			}
		case "number", "rating", "person":
			switch rule.Op {
			case "is", "is_not", "gt", "gte", "lt", "lte":
			default:
				return fmt.Errorf("operator %s is not supported for %s in a locked filter", rule.Op, field.Type)
			}
			value, ok := toFloat(rule.V)
			if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
				return fmt.Errorf("locked filter value for %s must be finite number", field.Type)
			}
		case "checkbox":
			switch rule.Op {
			case "checked", "unchecked":
			case "is", "is_not":
				if _, ok := rule.V.(bool); !ok {
					return fmt.Errorf("locked checkbox filter value must be boolean")
				}
			default:
				return fmt.Errorf("operator %s is not supported for checkbox in a locked filter", rule.Op)
			}
		default:
			return fmt.Errorf("locked filter on %s is not supported", field.Type)
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

func stringField(t string) bool {
	switch t {
	case "text", "select", "date", "url", "phone", "email":
		return true
	}
	return false
}

// ruleSQL builds one predicate; value-taking rules call next(v) for a bind placeholder.
func ruleSQL(f FieldSpec, r Rule, next func(any) string) string {
	cell := "(cells ->> '" + key(f) + "')" // key() is a validated decimal int64
	exists := "(cells ? '" + key(f) + "')"
	validString := "jsonb_typeof(cells -> '" + key(f) + "') = 'string'"
	validBool := "jsonb_typeof(cells -> '" + key(f) + "') = 'boolean'"
	// Person filters match member ids inside scalar or array cells; the
	// generic substring path below would falsely match "1" inside "[11, 2]".
	if f.Type == "person" {
		switch r.Op {
		case "contains", "not_contains", "is", "is_not":
			return personRuleSQL(f, r, next)
		}
	}
	switch r.Op {
	case "contains":
		// strpos treats percent, underscore and backslash literally, matching
		// the in-memory evaluator. LIKE would treat them as wildcards and can
		// widen a mandatory locked-view filter.
		pred := fmt.Sprintf("strpos(%s, %s) > 0", cell, next(toString(r.V)))
		if stringField(f.Type) {
			return "(" + validString + " AND " + pred + ")"
		}
		return pred
	case "not_contains":
		pred := fmt.Sprintf("strpos(%s, %s) = 0", cell, next(toString(r.V)))
		if stringField(f.Type) {
			pred = "(" + validString + " AND " + pred + ")"
		}
		return fmt.Sprintf("(%s IS NULL OR %s)", cell, pred)
	case "is":
		if f.Type == "number" || f.Type == "rating" || f.Type == "person" {
			value, _ := toFloat(r.V)
			return fmt.Sprintf("(jsonb_typeof(cells -> '%s') = 'number' AND (%s)::float8 = (%s)::float8)", key(f), cell, next(value))
		}
		arg := next(toString(r.V))
		pred := fmt.Sprintf("%s = %s", cell, arg)
		if stringField(f.Type) {
			// Equality must have the same byte-exact semantics as Go strings,
			// independent of the database's locale/collation.
			pred = fmt.Sprintf("(%s COLLATE \"C\") = (%s COLLATE \"C\")", cell, arg)
			return "(" + validString + " AND " + pred + ")"
		}
		if f.Type == "checkbox" {
			return "(" + validBool + " AND " + pred + ")"
		}
		return pred
	case "is_not":
		if f.Type == "number" || f.Type == "rating" || f.Type == "person" {
			value, _ := toFloat(r.V)
			return fmt.Sprintf("(%s IS NULL OR (jsonb_typeof(cells -> '%s') = 'number' AND (%s)::float8 <> (%s)::float8))", cell, key(f), cell, next(value))
		}
		arg := next(toString(r.V))
		pred := fmt.Sprintf("%s <> %s", cell, arg)
		if stringField(f.Type) {
			pred = fmt.Sprintf("(%s COLLATE \"C\") <> (%s COLLATE \"C\")", cell, arg)
			pred = "(" + validString + " AND " + pred + ")"
		}
		if f.Type == "checkbox" {
			pred = "(" + validBool + " AND " + pred + ")"
		}
		return fmt.Sprintf("(%s IS NULL OR %s)", cell, pred)
	case "empty":
		return fmt.Sprintf("(NOT %s OR COALESCE(%s, '') IN ('', 'null', '[]'))", exists, cell)
	case "not_empty":
		return fmt.Sprintf("(%s AND COALESCE(%s, '') NOT IN ('', 'null', '[]'))", exists, cell)
	case "checked":
		return "(" + validBool + " AND " + cell + " = 'true')"
	case "unchecked":
		return fmt.Sprintf("(%s IS NULL OR (%s AND %s = 'false'))", cell, validBool, cell)
	case "gt", "gte", "lt", "lte":
		op := map[string]string{"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[r.Op]
		if f.Type == "number" || f.Type == "rating" || f.Type == "person" {
			// compare numerically only when the cell really is a json number
			value, _ := toFloat(r.V)
			return fmt.Sprintf("(jsonb_typeof(cells -> '%s') = 'number' AND (%s)::float8 %s (%s)::float8)",
				key(f), cell, op, next(value))
		}
		pred := fmt.Sprintf("(%s COLLATE \"C\") %s (%s COLLATE \"C\")", cell, op, next(toString(r.V)))
		if stringField(f.Type) {
			return "(" + validString + " AND " + pred + ")"
		}
		return pred
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
	case "person", "created_by":
		// numeric order on the member id; arrays sort by their first member
		// (matching the in-memory twin, which previously diverged here)
		k := key(f)
		return fmt.Sprintf("COALESCE(CASE WHEN jsonb_typeof(cells -> '%s') = 'number' THEN (cells ->> '%s')::float8 END, CASE WHEN jsonb_typeof(cells -> '%s') = 'array' THEN (cells -> '%s' ->> 0)::float8 END) %s NULLS LAST", k, k, k, k, dir)
	default:
		return fmt.Sprintf("%s %s NULLS LAST", cell, dir)
	}
}

// optEscape guards select options embedded in CASE branches: they come from
// the field's own options list, quotes are doubled to stay inside the literal.
func optEscape(o string) string { return strings.ReplaceAll(o, "'", "''") }

// personRuleSQL compiles person filters as membership of member ids in a
// scalar or array cell. The EXISTS form normalizes a scalar cell (and a
// missing/null one) into elements so both shapes share one predicate,
// mirroring matchRule bit for bit.
func personRuleSQL(f FieldSpec, r Rule, next func(any) string) string {
	k := key(f)
	elements := fmt.Sprintf(
		`jsonb_array_elements_text(CASE WHEN jsonb_typeof(cells -> '%s') = 'array' THEN cells -> '%s' ELSE jsonb_build_array(cells -> '%s') END)`,
		k, k, k)
	matches := func(ids []int64) string {
		return fmt.Sprintf("EXISTS (SELECT 1 FROM %s e WHERE e::bigint = ANY(%s))", elements, next(ids))
	}
	ids, _ := personIDs(r.V)
	switch r.Op {
	case "contains", "is":
		return matches(ids)
	default: // not_contains, is_not: empty and null cells match, as in matchRule
		return "NOT " + matches(ids)
	}
}

// personIDs normalizes a person filter value — a member id (number or numeric
// text, the legacy saved form) or an array of them — into ids.
func personIDs(v any) ([]int64, bool) {
	one := func(x any) (int64, bool) {
		f, ok := toFloat(x)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
			return 0, false
		}
		return int64(f), true
	}
	switch x := v.(type) {
	case float64, string, int, int64:
		id, ok := one(x)
		return []int64{id}, ok
	case []any:
		ids := make([]int64, 0, len(x))
		for _, item := range x {
			id, ok := one(item)
			if !ok {
				return nil, false
			}
			ids = append(ids, id)
		}
		return ids, true
	}
	return nil, false
}

// personCellIDs extracts member ids from a person cell (scalar or array);
// malformed or non-numeric content counts as no members.
func personCellIDs(raw json.RawMessage) []int64 {
	var v any
	if len(raw) == 0 || json.Unmarshal(raw, &v) != nil {
		return nil
	}
	switch x := v.(type) {
	case float64:
		return []int64{int64(x)}
	case []any:
		ids := make([]int64, 0, len(x))
		for _, item := range x {
			if n, ok := item.(float64); ok {
				ids = append(ids, int64(n))
			}
		}
		return ids
	}
	return nil
}

// cellContains reports whether any member id of the cell is in ids.
func cellContains(cell, ids []int64) bool {
	for _, c := range cell {
		for _, id := range ids {
			if c == id {
				return true
			}
		}
	}
	return false
}

// PersonCellIDs extracts member ids from a person cell value (scalar or
// array); malformed or non-numeric content counts as no members. Exported for
// the member-visibility and history paths outside this package.
func PersonCellIDs(raw json.RawMessage) []int64 { return personCellIDs(raw) }

// OpsValid reports whether an operator name exists.
func OpsValid(op string) bool { return ops[op] }

// MatchRules evaluates one rule set against cells with the given conjunction
// (automation uses this without a full view Config).
func MatchRules(fields []FieldSpec, rules []Rule, conj string, cells map[string]json.RawMessage) bool {
	cfg := Config{Filters: &Filters{Conj: conj, Rules: rules}}
	return Match(fields, cfg, cells)
}

// Match evaluates the filters against one record's cells in memory (the
// Memory store twin of the compiled SQL path).
func Match(fields []FieldSpec, cfg Config, cells map[string]json.RawMessage) bool {
	if cfg.Filters == nil || len(cfg.Filters.Rules) == 0 {
		return true
	}
	result := cfg.Filters.Conj != "or"
	byID := make(map[int64]FieldSpec, len(fields))
	for _, f := range fields {
		byID[f.ID] = f
	}
	for _, r := range cfg.Filters.Rules {
		m := matchRule(byID[r.F], r, cells[strconv.FormatInt(r.F, 10)])
		if cfg.Filters.Conj == "or" {
			result = result || m
		} else {
			result = result && m
		}
	}
	return result
}

func matchRule(field FieldSpec, r Rule, raw json.RawMessage) bool {
	var v any
	ok := len(raw) > 0
	if ok {
		ok = json.Unmarshal(raw, &v) == nil
		if v == nil {
			ok = false
		}
	}
	s := ""
	if ok {
		s = toString(v)
	}
	if ok && stringField(field.Type) {
		if _, valid := v.(string); !valid && r.Op != "empty" && r.Op != "not_empty" {
			return false
		}
	}
	if ok && field.Type == "checkbox" {
		if _, valid := v.(bool); !valid && r.Op != "empty" && r.Op != "not_empty" {
			return false
		}
	}
	// Person filters match member ids inside scalar or array cells; comparing
	// the string form of an array would falsely match "1" inside "[11, 2]".
	if field.Type == "person" && (r.Op == "contains" || r.Op == "not_contains" || r.Op == "is" || r.Op == "is_not") {
		if ids, ok := personIDs(r.V); ok {
			member := cellContains(personCellIDs(raw), ids)
			if r.Op == "contains" || r.Op == "is" {
				return member
			}
			return !member
		}
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
		if field.Type == "number" || field.Type == "rating" || field.Type == "person" {
			a, aok := v.(float64)
			b, bok := toFloat(r.V)
			return ok && aok && bok && a == b
		}
		return ok && s == toString(r.V)
	case "is_not":
		if field.Type == "number" || field.Type == "rating" || field.Type == "person" {
			if !ok {
				return true
			}
			a, aok := v.(float64)
			b, bok := toFloat(r.V)
			return aok && bok && a != b
		}
		return !ok || s != toString(r.V)
	case "checked":
		return ok && v == true
	case "unchecked":
		return !ok || v == false
	case "gt", "gte", "lt", "lte":
		if !ok {
			return false
		}
		if field.Type == "number" || field.Type == "rating" || field.Type == "person" {
			a, aok := v.(float64)
			b, bok := toFloat(r.V)
			if aok && bok {
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
			return false
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
			case "number":
				x, _ := toFloat(rawToAny(ci[key(f)]))
				y, _ := toFloat(rawToAny(cj[key(f)]))
				c = int(x - y)
			case "person", "created_by":
				x, _ := toFloat(personFirstID(ci[key(f)]))
				y, _ := toFloat(personFirstID(cj[key(f)]))
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

// personFirstID is a person cell's sort key: the scalar id or the first array
// member; missing/unusable values sort as empty via the caller's checks.
func personFirstID(raw json.RawMessage) any {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil
	}
	switch x := v.(type) {
	case float64:
		return x
	case []any:
		if len(x) > 0 {
			if n, ok := x[0].(float64); ok {
				return n
			}
		}
	}
	return nil
}

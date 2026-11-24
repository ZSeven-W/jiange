package btquery

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

var fields = []FieldSpec{
	{ID: 1, Type: "text"},
	{ID: 2, Type: "select", Options: []string{"待办", "进行中", "完成"}},
	{ID: 3, Type: "number"},
	{ID: 4, Type: "checkbox"},
}

func cell(s string) json.RawMessage { return json.RawMessage(`"` + s + `"`) }
func num(s string) json.RawMessage  { return json.RawMessage(s) }

func TestCompileBindsValuesAndRejectsUnknownFields(t *testing.T) {
	cfg := Config{Filters: &Filters{Conj: "and", Rules: []Rule{
		{F: 1, Op: "contains", V: "'; DROP TABLE users; --"},
		{F: 3, Op: "gt", V: 5},
	}}}
	where, args, order, err := Compile(fields, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(where, "DROP TABLE") || strings.Contains(where, ";") {
		t.Fatalf("value leaked into SQL: %s", where)
	}
	if len(args) != 2 || args[0] != "'; DROP TABLE users; --" || args[1] != float64(5) {
		t.Fatalf("args: %v", args)
	}
	if !strings.Contains(where, "$1") || !strings.Contains(where, "$2") {
		t.Fatalf("expected bind placeholders: %s", where)
	}
	if order != "" {
		t.Fatalf("no sorts configured: %q", order)
	}

	cfg.Filters.Rules[0].F = 999
	if _, _, _, err := Compile(fields, cfg); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("unknown field accepted: %v", err)
	}
	cfg.Filters.Rules[0] = Rule{F: 1, Op: "bobby tables", V: "x"}
	if _, _, _, err := Compile(fields, cfg); err == nil || !strings.Contains(err.Error(), "unknown op") {
		t.Fatalf("unknown op accepted: %v", err)
	}
}

func TestCompileSortSQL(t *testing.T) {
	_, _, order, err := Compile(fields, Config{Sorts: []Sort{{F: 3, Asc: false}, {F: 2, Asc: true}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(order, "float8 DESC NULLS LAST") || !strings.Contains(order, "WHEN") || !strings.Contains(order, "'待办'") {
		t.Fatalf("order: %s", order)
	}
}

func TestMatchAndSortInMemory(t *testing.T) {
	recs := []map[string]json.RawMessage{
		{"1": cell("导出"), "2": cell("完成"), "3": num("10")},
		{"1": cell("分享任务"), "2": cell("待办"), "3": num("2"), "4": num("true")},
		{"1": cell("拖拽")},
	}
	ids := []int64{1, 2, 3}
	keep := func(cfg Config) []int64 {
		var out []int64
		for _, i := range SortIndexes(fields, cfg, len(recs), func(i int) map[string]json.RawMessage { return recs[i] }) {
			if Match(fields, cfg, recs[i]) {
				out = append(out, ids[i])
			}
		}
		return out
	}
	cfg := func(rules []Rule, conj string, sorts ...Sort) Config {
		return Config{Filters: &Filters{Conj: conj, Rules: rules}, Sorts: sorts}
	}
	if got := keep(cfg([]Rule{{F: 1, Op: "contains", V: "任务"}}, "and")); len(got) != 1 || got[0] != 2 {
		t.Fatalf("contains: %v", got)
	}
	if got := keep(cfg([]Rule{{F: 2, Op: "is", V: "待办"}, {F: 4, Op: "checked"}}, "and")); len(got) != 1 || got[0] != 2 {
		t.Fatalf("and: %v", got)
	}
	if got := keep(cfg([]Rule{{F: 2, Op: "is", V: "完成"}, {F: 4, Op: "checked"}}, "or")); len(got) != 2 {
		t.Fatalf("or: %v", got)
	}
	if got := keep(cfg([]Rule{{F: 3, Op: "empty"}}, "and")); len(got) != 1 || got[0] != 3 {
		t.Fatalf("empty: %v", got)
	}
	if got := keep(cfg([]Rule{{F: 3, Op: "gte", V: 2}}, "and", Sort{F: 3, Asc: true})); len(got) != 2 || got[0] != 2 || got[1] != 1 {
		t.Fatalf("gte+sort: %v", got)
	}
	if got := keep(cfg([]Rule{{F: 1, Op: "not_contains", V: "任务"}}, "and", Sort{F: 2, Asc: true})); len(got) != 2 || got[0] != 1 || got[1] != 3 {
		t.Fatalf("not_contains + select sort (empty last): %v", got)
	}
}

func TestValidatePermissionsAndGanttDeps(t *testing.T) {
	validPerms := Config{
		Permissions: &ViewPermissions{
			OnlyOwnRecords: true,
			FieldModes:     map[string]string{"1": "edit", "2": "readonly", "3": "hidden"},
		},
	}
	if err := Validate(fields, validPerms); err != nil {
		t.Fatalf("valid permissions rejected: %v", err)
	}
	if err := Validate(fields, Config{Permissions: &ViewPermissions{FieldModes: map[string]string{"999": "readonly"}}}); err == nil {
		t.Fatal("unknown field in permissions accepted")
	}
	if err := Validate(fields, Config{Permissions: &ViewPermissions{FieldModes: map[string]string{"1": "admin"}}}); err == nil {
		t.Fatal("invalid permission mode accepted")
	}

	// Diamond DAG is valid.
	validDeps := Config{
		GanttDeps: []GanttDependency{
			{ID: "d1", FromID: 1, ToID: 2},
			{ID: "d2", FromID: 1, ToID: 3},
			{ID: "d3", FromID: 2, ToID: 4},
			{ID: "d4", FromID: 3, ToID: 4},
		},
	}
	if err := Validate(fields, validDeps); err != nil {
		t.Fatalf("valid diamond gantt deps rejected: %v", err)
	}
	// Self-loop rejected.
	if err := Validate(fields, Config{GanttDeps: []GanttDependency{{ID: "s", FromID: 1, ToID: 1}}}); err == nil {
		t.Fatal("self-loop gantt dep accepted")
	}
	// Non-positive id rejected.
	if err := Validate(fields, Config{GanttDeps: []GanttDependency{{ID: "z", FromID: 0, ToID: 2}}}); err == nil {
		t.Fatal("zero gantt dep accepted")
	}
	// Cycle rejected.
	cyclicDeps := Config{
		GanttDeps: []GanttDependency{
			{ID: "c1", FromID: 1, ToID: 2},
			{ID: "c2", FromID: 2, ToID: 3},
			{ID: "c3", FromID: 3, ToID: 1},
		},
	}
	if err := Validate(fields, cyclicDeps); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("cyclic gantt deps accepted: %v", err)
	}
	// Duplicate edge rejected.
	dupDeps := Config{
		GanttDeps: []GanttDependency{
			{ID: "a", FromID: 1, ToID: 2},
			{ID: "b", FromID: 1, ToID: 2},
		},
	}
	if err := Validate(fields, dupDeps); err == nil {
		t.Fatal("duplicate gantt dep accepted")
	}
	// >500 edges rejected.
	tooMany := make([]GanttDependency, 501)
	for i := range tooMany {
		tooMany[i] = GanttDependency{ID: "e", FromID: int64(i + 1), ToID: int64(i + 2)}
	}
	if err := Validate(fields, Config{GanttDeps: tooMany}); err == nil {
		t.Fatal(">500 gantt deps accepted")
	}
}

func TestValidatePermissionRoles(t *testing.T) {
	primaryFields := []FieldSpec{
		{ID: 1, Type: "text", IsPrimary: true},
		{ID: 2, Type: "select", Options: []string{"待审", "通过", "驳回"}},
		{ID: 3, Type: "number"},
		{ID: 4, Type: "checkbox"},
	}
	boolPtr := func(v bool) *bool { return &v }

	// Valid multi-role config passes.
	valid := Config{
		Permissions: &ViewPermissions{
			OnlyOwnRecords: true,
			FieldModes:     map[string]string{"1": "readonly", "2": "edit", "3": "hidden"},
			Roles: []PermissionRole{
				{
					ID:              "sales",
					Name:            "销售",
					UserIDs:         []int64{10, 20},
					DeptIDs:         []int64{100},
					GroupIDs:        []int64{200},
					CanAddRecord:    boolPtr(true),
					CanDeleteRecord: boolPtr(false),
					RowScope:        "own",
					FieldModes:      map[string]string{"1": "edit", "3": "readonly"},
				},
				{
					ID:              "reviewer",
					Name:            "审核员",
					DeptIDs:         []int64{101},
					CanAddRecord:    boolPtr(false),
					CanDeleteRecord: boolPtr(false),
					RowScope:        "filter",
					RowFilters: &Filters{
						Conj:  "and",
						Rules: []Rule{{F: 2, Op: "is", V: "待审"}},
					},
					FieldModes: map[string]string{"3": "hidden"},
					ViewHidden: false,
				},
			},
		},
	}
	if err := Validate(primaryFields, valid); err != nil {
		t.Fatalf("valid RBAC config rejected: %v", err)
	}

	// Primary field cannot be hidden in default FieldModes or role FieldModes.
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{FieldModes: map[string]string{"1": "hidden"}}}); err == nil {
		t.Fatal("primary field hidden in default fieldModes accepted")
	}
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{
		ID: "r1", Name: "R1", FieldModes: map[string]string{"1": "hidden"},
	}}}}); err == nil {
		t.Fatal("primary field hidden in role fieldModes accepted")
	}

	// >32 roles rejected.
	manyRoles := make([]PermissionRole, 33)
	for i := range manyRoles {
		manyRoles[i] = PermissionRole{ID: "r-" + string(rune('a'+i%26)) + string(rune('0'+i/26)), Name: "Role"}
	}
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: manyRoles}}); err == nil {
		t.Fatal(">32 roles accepted")
	}

	// Duplicate / empty / >64 role ID rejected.
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{ID: "", Name: "A"}}}}); err == nil {
		t.Fatal("empty role id accepted")
	}
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{ID: strings.Repeat("x", 65), Name: "A"}}}}); err == nil {
		t.Fatal(">64 role id accepted")
	}
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{
		{ID: "dup", Name: "A"},
		{ID: "dup", Name: "B"},
	}}}); err == nil {
		t.Fatal("duplicate role id accepted")
	}

	// Empty or >64 rune role name rejected.
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{ID: "r1", Name: "   "}}}}); err == nil {
		t.Fatal("blank role name accepted")
	}
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{ID: "r1", Name: strings.Repeat("角", 65)}}}}); err == nil {
		t.Fatal(">64 rune role name accepted")
	}

	// Non-positive, duplicate, or >200 subject IDs rejected.
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{ID: "r1", Name: "A", UserIDs: []int64{0}}}}}); err == nil {
		t.Fatal("zero userId accepted")
	}
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{ID: "r1", Name: "A", DeptIDs: []int64{5, 5}}}}}); err == nil {
		t.Fatal("duplicate deptId accepted")
	}
	tooManyGroups := make([]int64, 201)
	for i := range tooManyGroups {
		tooManyGroups[i] = int64(i + 1)
	}
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{ID: "r1", Name: "A", GroupIDs: tooManyGroups}}}}); err == nil {
		t.Fatal(">200 groupIds accepted")
	}

	// Invalid rowScope rejected.
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{ID: "r1", Name: "A", RowScope: "custom"}}}}); err == nil {
		t.Fatal("invalid rowScope accepted")
	}

	// Invalid rowFilters (bad field, bad op, non-number for number field) rejected.
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{
		ID: "r1", Name: "A", RowScope: "filter",
		RowFilters: &Filters{Conj: "and", Rules: []Rule{{F: 999, Op: "is", V: "x"}}},
	}}}}); err == nil {
		t.Fatal("unknown field in rowFilters accepted")
	}
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{
		ID: "r1", Name: "A", RowScope: "filter",
		RowFilters: &Filters{Conj: "and", Rules: []Rule{{F: 3, Op: "gt", V: "not-a-num"}}},
	}}}}); err == nil {
		t.Fatal("non-numeric value for number field in rowFilters accepted")
	}
	if err := Validate(primaryFields, Config{Permissions: &ViewPermissions{Roles: []PermissionRole{{
		ID: "r1", Name: "A", RowScope: "filter",
		RowFilters: &Filters{Conj: "xor", Rules: []Rule{{F: 2, Op: "is", V: "待审"}}},
	}}}}); err == nil {
		t.Fatal("invalid conj in rowFilters accepted")
	}
}

func TestValidateFieldWidthsAndStats(t *testing.T) {
	valid := Config{
		FieldWidths: map[string]int{"1": 60, "2": 240, "3": 1200},
		FieldStats: map[string]string{
			"1":  "none",
			"2":  "count",
			"3":  "empty",
			"4":  "filled",
			"5":  "unique",
			"6":  "sum",
			"7":  "avg",
			"8":  "min",
			"9":  "max",
			"10": "checked",
			"11": "unchecked",
			"12": "pct_checked",
		},
	}
	if err := Validate(fields, valid); err != nil {
		t.Fatalf("valid fieldWidths/fieldStats rejected: %v", err)
	}

	// Width bounds
	if err := Validate(fields, Config{FieldWidths: map[string]int{"1": 59}}); err == nil {
		t.Fatal("width below 60 accepted")
	}
	if err := Validate(fields, Config{FieldWidths: map[string]int{"1": 1201}}); err == nil {
		t.Fatal("width above 1200 accepted")
	}

	// Invalid field ID keys
	for _, badKey := range []string{"0", "-1", "abc", "01", ""} {
		if err := Validate(fields, Config{FieldWidths: map[string]int{badKey: 200}}); err == nil {
			t.Fatalf("invalid fieldWidths key %q accepted", badKey)
		}
		if err := Validate(fields, Config{FieldStats: map[string]string{badKey: "sum"}}); err == nil {
			t.Fatalf("invalid fieldStats key %q accepted", badKey)
		}
	}

	// Invalid stat enum
	for _, badStat := range []string{"", "median", "SUM", "stddev"} {
		if err := Validate(fields, Config{FieldStats: map[string]string{"1": badStat}}); err == nil {
			t.Fatalf("invalid fieldStats value %q accepted", badStat)
		}
	}

	// Max 200 entries
	tooManyWidths := make(map[string]int, 201)
	tooManyStats := make(map[string]string, 201)
	for i := 1; i <= 201; i++ {
		k := strconv.Itoa(i)
		tooManyWidths[k] = 200
		tooManyStats[k] = "count"
	}
	if err := Validate(fields, Config{FieldWidths: tooManyWidths}); err == nil {
		t.Fatal(">200 fieldWidths accepted")
	}
	if err := Validate(fields, Config{FieldStats: tooManyStats}); err == nil {
		t.Fatal(">200 fieldStats accepted")
	}
}

func TestExtendedFieldsFilterAndSort(t *testing.T) {
	extFields := []FieldSpec{
		{ID: 10, Type: "currency"},
		{ID: 11, Type: "progress"},
		{ID: 12, Type: "autonumber"},
		{ID: 13, Type: "location"},
		{ID: 14, Type: "button"},
	}
	cfg := Config{
		Filters: &Filters{
			Conj: "and",
			Rules: []Rule{
				{F: 10, Op: "gte", V: 12.5},
				{F: 11, Op: "lte", V: 80},
				{F: 12, Op: "gt", V: 1},
				{F: 13, Op: "contains", V: "北京"},
			},
		},
		Sorts: []Sort{
			{F: 10, Asc: true},
			{F: 12, Asc: false},
		},
	}
	where, args, order, err := Compile(extFields, cfg)
	if err != nil {
		t.Fatalf("compile extended fields: %v", err)
	}
	if len(args) != 4 {
		t.Fatalf("expected 4 args, got %d: %v", len(args), args)
	}
	if !strings.Contains(where, "float8") || !strings.Contains(where, "strpos") {
		t.Fatalf("unexpected where SQL: %s", where)
	}
	if !strings.Contains(order, "(cells ->> '10'))::float8 ASC NULLS LAST") || !strings.Contains(order, "(cells ->> '12'))::float8 DESC NULLS LAST") {
		t.Fatalf("unexpected sort SQL: %s", order)
	}
	if err := ValidateLocked(extFields, cfg); err != nil {
		t.Fatalf("ValidateLocked rejected extended fields: %v", err)
	}

	// Non-numeric filter on currency/progress/autonumber must fail.
	for _, fid := range []int64{10, 11, 12} {
		bad := Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: fid, Op: "gt", V: "nope"}}}}
		if err := Validate(extFields, bad); err == nil {
			t.Fatalf("expected numeric validation error for field %d", fid)
		}
	}

	// In-memory Match & decimal-accurate SortIndexes.
	recs := []map[string]json.RawMessage{
		{"10": num("12.9"), "11": num("75"), "12": num("3"), "13": cell("北京市海淀区 | 39.98,116.31")},
		{"10": num("12.5"), "11": num("50"), "12": num("2"), "13": cell("北京市朝阳区")},
		{"10": num("9.9"), "11": num("90"), "12": num("1"), "13": cell("上海市浦东新区")},
	}
	var matched []int
	for _, idx := range SortIndexes(extFields, cfg, len(recs), func(i int) map[string]json.RawMessage { return recs[i] }) {
		if Match(extFields, cfg, recs[idx]) {
			matched = append(matched, idx)
		}
	}
	if len(matched) != 2 || matched[0] != 1 || matched[1] != 0 {
		t.Fatalf("expected decimal-sorted matches [1, 0], got %v", matched)
	}
}

func TestGroupsAndParentFieldConfig(t *testing.T) {
	spec := []FieldSpec{
		{ID: 1, Type: "text", IsPrimary: true},
		{ID: 2, Type: "select", Options: []string{"A", "B"}},
		{ID: 3, Type: "person"},
		{ID: 4, Type: "currency"},
		{ID: 5, Type: "link"},
	}

	// 1..3 levels valid + ParentField valid.
	g1 := int64(2)
	valid := Config{Group: &g1, Groups: []int64{2, 3, 4}, ParentField: 5}
	if err := Validate(spec, valid); err != nil {
		t.Fatalf("valid multi-group + parentField rejected: %v", err)
	}
	if got := valid.GroupFields(); len(got) != 3 || got[0] != 2 || got[1] != 3 || got[2] != 4 {
		t.Fatalf("GroupFields: %v", got)
	}

	// Legacy Group-only stays backward-compatible.
	legacy := Config{Group: &g1}
	if got := legacy.GroupFields(); len(got) != 1 || got[0] != 2 {
		t.Fatalf("legacy GroupFields: %v", got)
	}
	// NormalizeGroups syncs Group with Groups[0].
	syncCfg := Config{Groups: []int64{3, 4}}
	syncCfg.NormalizeGroups()
	if syncCfg.Group == nil || *syncCfg.Group != 3 {
		t.Fatalf("NormalizeGroups did not sync Group: %+v", syncCfg)
	}

	// >3 grouping levels rejected.
	if err := Validate(spec, Config{Groups: []int64{1, 2, 3, 4}}); err == nil {
		t.Fatal(">3 grouping levels accepted")
	}
	// Duplicate group field rejected.
	if err := Validate(spec, Config{Groups: []int64{2, 2}}); err == nil {
		t.Fatal("duplicate group field accepted")
	}
	// Unknown group field rejected.
	if err := Validate(spec, Config{Groups: []int64{2, 999}}); err == nil {
		t.Fatal("unknown group field accepted")
	}
	// Unknown or negative ParentField rejected.
	if err := Validate(spec, Config{ParentField: 999}); err == nil {
		t.Fatal("unknown parentField accepted")
	}
	if err := Validate(spec, Config{ParentField: -1}); err == nil {
		t.Fatal("negative parentField accepted")
	}
}

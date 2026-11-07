package btquery

import (
	"encoding/json"
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

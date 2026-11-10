package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

// CSV 往返: person cells export as member names joined by "; " (workspace
// members only; external collaborators keep the legacy id digits) and import
// by matching member names back to ids.

func TestPersonCSVExportNames(t *testing.T) {
	names := map[int64]string{7: "张三", 9: "李四"}
	multi := store.Field{ID: 5, Type: "person", Multiple: true}
	single := store.Field{ID: 6, Type: "person"}
	if got := cellCSV(multi, store.Record{Cells: map[string]json.RawMessage{"5": json.RawMessage(`[7,9]`)}}, names); got != "张三; 李四" {
		t.Fatalf("multi export=%q", got)
	}
	if got := cellCSV(single, store.Record{Cells: map[string]json.RawMessage{"6": json.RawMessage(`7`)}}, names); got != "张三" {
		t.Fatalf("scalar export=%q", got)
	}
	// Unknown ids (external collaborator without the directory) keep the id.
	if got := cellCSV(single, store.Record{Cells: map[string]json.RawMessage{"6": json.RawMessage(`7`)}}, nil); got != "7" {
		t.Fatalf("anonymous export=%q", got)
	}
	creator := store.Field{ID: 3, Type: "created_by"}
	uid := int64(7)
	if got := cellCSV(creator, store.Record{CreatorID: &uid}, names); got != "张三" {
		t.Fatalf("created_by export=%q", got)
	}
}

func TestPersonCSVImportNames(t *testing.T) {
	memberIDs := map[string]int64{"张三": 7, "李四": 9}
	multi := store.Field{ID: 5, Name: "成员", Type: "person", Multiple: true}
	single := store.Field{ID: 6, Name: "负责人", Type: "person"}

	plan, errs, err := csvImportPlan([][]string{{"成员", "负责人"}, {"张三; 李四", "张三"}}, true, nil, []store.Field{multi, single}, memberIDs)
	if err != nil {
		t.Fatal(err)
	}
	if len(errs) != 0 || len(plan.Rows) != 1 {
		t.Fatalf("plan errs=%+v err=%v", errs, err)
	}
	if string(plan.Rows[0][0]) != "[7,9]" || string(plan.Rows[0][1]) != "7" {
		t.Fatalf("rows: %v", plan.Rows)
	}

	// The exported spelling round-trips through the import splitter.
	if got := strings.Split("张三; 李四", ";"); len(got) != 2 {
		t.Fatalf("split: %v", got)
	}

	// Unknown members and single-mode overflows are row errors.
	_, errs, err = csvImportPlan([][]string{{"成员"}, {"张三; 未知"}}, true, nil, []store.Field{multi}, memberIDs)
	if err != nil || len(errs) != 1 {
		t.Fatalf("unknown member: errs=%+v err=%v", errs, err)
	}
	_, errs, err = csvImportPlan([][]string{{"负责人"}, {"张三; 李四"}}, true, nil, []store.Field{single}, memberIDs)
	if err != nil || len(errs) != 1 {
		t.Fatalf("single overflow: errs=%+v err=%v", errs, err)
	}

	// Without the member directory (external importer) the plan is rejected.
	if _, _, err = csvImportPlan([][]string{{"成员"}, {"张三"}}, true, nil, []store.Field{multi}, nil); err == nil {
		t.Fatalf("person import without member directory accepted")
	}
}

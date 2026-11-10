package api

import (
	"encoding/json"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestVisibleRecordTitleUsesPrimaryProjection(t *testing.T) {
	fields := []store.Field{{ID: 2, Type: "text"}, {ID: 4, Type: "number", IsPrimary: true}}
	row := store.Record{Cells: map[string]json.RawMessage{"2": json.RawMessage(`"description"`), "4": json.RawMessage(`42`)}}
	if got := visibleRecordTitle(row, visibleTitleField(fields, fields), nil); got != "42" {
		t.Fatalf("primary title=%q", got)
	}
	// When the primary is hidden, another visible field must not be presented
	// as the title. Legacy tables without a marker retain their text fallback.
	if got := visibleRecordTitle(row, visibleTitleField(fields[:1], fields), nil); got != "" {
		t.Fatalf("hidden primary fallback=%q", got)
	}
	if got := visibleRecordTitle(row, visibleTitleField(fields[:1], fields[:1]), nil); got != "description" {
		t.Fatalf("legacy fallback=%q", got)
	}
	if got := visibleRecordTitle(row, visibleTitleField(nil, nil), nil); got != "" {
		t.Fatalf("empty projection=%q", got)
	}
	person := store.Field{ID: 5, Type: "person", IsPrimary: true}
	row.Cells["5"] = json.RawMessage(`7`)
	if ids := visibleTitleMemberIDs(row, &person); len(ids) != 1 || ids[0] != 7 {
		t.Fatalf("person ids=%v", ids)
	}
	if got := visibleRecordTitle(row, &person, map[int64]string{7: "小简"}); got != "小简" {
		t.Fatalf("person title=%q", got)
	}
	if got := visibleRecordTitle(row, &person, nil); got != "" {
		t.Fatalf("unavailable name leaked ID: %q", got)
	}
}

package tableexperimental

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestSharedRichVectors(t *testing.T) {
	raw, err := os.ReadFile("../../packages/collab/testdata/table-experimental-rich.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Version int `json:"version"`
		Cases   []struct {
			Name     string `json:"name"`
			Ops      []Op   `json:"ops"`
			Expected struct {
				Row      ID         `json:"row"`
				Column   ID         `json:"column"`
				Grid     [][]string `json:"grid"`
				Rich     []RichChar `json:"rich"`
				Pending  int        `json:"pending"`
				Rejected []Rejected `json:"rejected"`
			} `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Version != 1 || len(fixture.Cases) == 0 {
		t.Fatal("invalid fixture")
	}
	tsSnapshot, err := os.ReadFile("../../packages/collab/testdata/table-experimental-rich-ts-snapshot.json")
	if err != nil {
		t.Fatal(err)
	}
	fromTS, err := FromSnapshot(tsSnapshot)
	if err != nil {
		t.Fatal(err)
	}
	if rich, ok := fromTS.CellRich(fixture.Cases[0].Expected.Row, fixture.Cases[0].Expected.Column, false); !ok || !reflect.DeepEqual(rich, fixture.Cases[0].Expected.Rich) {
		t.Fatalf("typescript snapshot: %+v", rich)
	}
	goSnapshot, err := os.ReadFile("../../packages/collab/testdata/table-experimental-rich-go-snapshot.json")
	if err != nil {
		t.Fatal(err)
	}
	canonical := New()
	for _, op := range fixture.Cases[0].Ops {
		if _, err := canonical.Apply(op); err != nil {
			t.Fatal(err)
		}
	}
	actualSnapshot, err := canonical.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	var expectedJSON, actualJSON any
	if err := json.Unmarshal(goSnapshot, &expectedJSON); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(actualSnapshot, &actualJSON); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(expectedJSON, actualJSON) {
		t.Fatal("Go snapshot fixture is stale")
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			for seed := int64(1); seed <= 80; seed++ {
				table := New()
				order := rand.New(rand.NewSource(seed)).Perm(len(tc.Ops))
				for i, index := range order {
					if accepted, err := table.Apply(tc.Ops[index]); err != nil || !accepted {
						t.Fatalf("seed %d: %v %v", seed, accepted, err)
					}
					if accepted, err := table.Apply(tc.Ops[index]); err != nil || accepted {
						t.Fatalf("retry seed %d: %v %v", seed, accepted, err)
					}
					if i == len(order)/2 {
						snapshot, err := table.Snapshot()
						if err != nil {
							t.Fatal(err)
						}
						table, err = FromSnapshot(snapshot)
						if err != nil {
							t.Fatal(err)
						}
					}
				}
				rich, ok := table.CellRich(tc.Expected.Row, tc.Expected.Column, false)
				if !ok || !reflect.DeepEqual(rich, tc.Expected.Rich) {
					t.Fatalf("seed %d rich=%+v want=%+v", seed, rich, tc.Expected.Rich)
				}
				if !reflect.DeepEqual(table.View(), tc.Expected.Grid) || table.PendingCount() != tc.Expected.Pending || !reflect.DeepEqual(table.Rejected(), tc.Expected.Rejected) {
					t.Fatalf("seed %d grid=%v pending=%d rejected=%v", seed, table.View(), table.PendingCount(), table.Rejected())
				}
				snapshot, err := table.Snapshot()
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Contains(snapshot, []byte(`"version":2`)) {
					t.Fatalf("wrong version: %s", snapshot)
				}
				restored, err := FromSnapshot(snapshot)
				if err != nil {
					t.Fatal(err)
				}
				got, ok := restored.CellRich(tc.Expected.Row, tc.Expected.Column, false)
				if !ok || !reflect.DeepEqual(got, tc.Expected.Rich) {
					t.Fatalf("restored rich=%+v", got)
				}
			}
		})
	}
}

func TestRichValidationAndDetachedProjection(t *testing.T) {
	table := New()
	row, col, ch := ID{1, 1}, ID{1, 2}, ID{1, 3}
	for _, op := range []Op{{Kind: "axis-insert", ID: row, Axis: "row"}, {Kind: "axis-insert", ID: col, Axis: "column"}, {Kind: "text-insert", ID: ch, Row: &row, Column: &col, Char: "字"}} {
		if _, err := table.Apply(op); err != nil {
			t.Fatal(err)
		}
	}
	for _, v := range []struct{ key, value string }{{"bold", "true"}, {"color", "#ff0000"}, {"color", "url(evil)"}, {"link", "javascript:evil"}} {
		value := v.value
		if _, err := table.Apply(Op{Kind: "text-mark", ID: ID{3, 1}, Row: &row, Column: &col, Target: &ch, Key: v.key, Value: &value}); err == nil {
			t.Fatalf("accepted %q %q", v.key, v.value)
		}
	}
	value := "1"
	op := Op{Kind: "text-mark", ID: ID{3, 1}, Row: &row, Column: &col, Target: &ch, Key: "bold", Value: &value}
	if _, err := table.Apply(op); err != nil {
		t.Fatal(err)
	}
	value = "changed"
	rich, ok := table.CellRich(row, col, false)
	if !ok || len(rich) != 1 || rich[0].Marks["bold"] != "1" {
		t.Fatalf("rich %+v", rich)
	}
	rich[0].Marks["bold"] = "changed"
	rich[0].ID.Clock = 99
	again, _ := table.CellRich(row, col, false)
	if again[0].Marks["bold"] != "1" || again[0].ID != ch {
		t.Fatal("projection mutated internal state")
	}
	snapshot, err := table.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := FromSnapshot(bytes.Replace(snapshot, []byte(`"version":2`), []byte(`"version":1`), 1)); err == nil || !strings.Contains(err.Error(), "version 2") {
		t.Fatalf("downgrade: %v", err)
	}
	if _, err := table.Apply(Op{Kind: "axis-delete", ID: ID{3, 2}, Axis: "row", Target: &row}); err != nil {
		t.Fatal(err)
	}
	if _, ok := table.CellRich(row, col, false); ok {
		t.Fatal("deleted row is visible")
	}
	hidden, ok := table.CellRich(row, col, true)
	if !ok || hidden[0].Marks["bold"] != "1" {
		t.Fatal("hidden mark lost")
	}
}

func TestSharedInvalidRichSnapshots(t *testing.T) {
	raw, err := os.ReadFile("../../packages/collab/testdata/table-experimental-rich-invalid.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Version int `json:"version"`
		Cases   []struct {
			Name     string `json:"name"`
			Snapshot string `json:"snapshot"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Version != 1 || len(fixture.Cases) == 0 {
		t.Fatal("invalid fixture")
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			if _, err := FromSnapshot([]byte(tc.Snapshot)); err == nil {
				t.Fatal("invalid snapshot accepted")
			}
		})
	}
}

func TestRichMarkResourceLimitIsAtomic(t *testing.T) {
	limits := DefaultLimits()
	limits.MaxOperationBytes = 390
	table, err := NewWithLimits(limits)
	if err != nil {
		t.Fatal(err)
	}
	row, col, ch := ID{1, 1}, ID{1, 2}, ID{1, 3}
	for _, op := range []Op{{Kind: "axis-insert", ID: row, Axis: "row"}, {Kind: "axis-insert", ID: col, Axis: "column"}, {Kind: "text-insert", ID: ch, Row: &row, Column: &col, Char: "A"}} {
		if _, err := table.Apply(op); err != nil {
			t.Fatal(err)
		}
	}
	before, err := table.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	color := "#3370FF"
	markID := ID{2, 1}
	if _, err := table.Apply(Op{Kind: "text-mark", ID: markID, Row: &row, Column: &col, Target: &ch, Key: "color", Value: &color}); err == nil {
		t.Fatal("oversized mark accepted")
	}
	after, err := table.Snapshot()
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("rejected mark changed state")
	}
	bold := "1"
	if ok, err := table.Apply(Op{Kind: "text-mark", ID: markID, Row: &row, Column: &col, Target: &ch, Key: "bold", Value: &bold}); err != nil || !ok {
		t.Fatalf("identity reserved: %v %v", ok, err)
	}
	snapshot, err := table.Snapshot()
	if err != nil || len(snapshot) > table.snapshotBudget {
		t.Fatalf("mark snapshot budget: %d %d %v", len(snapshot), table.snapshotBudget, err)
	}
}

func TestRichPendingMarksAreBoundedAndWake(t *testing.T) {
	limits := DefaultLimits()
	limits.MaxPending = 1
	table, err := NewWithLimits(limits)
	if err != nil {
		t.Fatal(err)
	}
	row, col, ch := ID{1, 1}, ID{1, 2}, ID{1, 3}
	value := "1"
	first := Op{Kind: "text-mark", ID: ID{2, 1}, Row: &row, Column: &col, Target: &ch, Key: "bold", Value: &value}
	second := Op{Kind: "text-mark", ID: ID{2, 2}, Row: &row, Column: &col, Target: &ch, Key: "italic", Value: &value}
	if _, err := table.Apply(first); err != nil {
		t.Fatal(err)
	}
	if _, err := table.Apply(second); err == nil {
		t.Fatal("pending limit ignored")
	}
	for _, op := range []Op{{Kind: "axis-insert", ID: row, Axis: "row"}, {Kind: "axis-insert", ID: col, Axis: "column"}, {Kind: "text-insert", ID: ch, Row: &row, Column: &col, Char: "A"}} {
		if _, err := table.Apply(op); err != nil {
			t.Fatal(err)
		}
	}
	if table.PendingCount() != 0 {
		t.Fatal("mark did not wake")
	}
	if ok, err := table.Apply(second); err != nil || !ok {
		t.Fatalf("retry: %v %v", ok, err)
	}
	chars, ok := table.CellRich(row, col, false)
	if !ok || chars[0].Marks["bold"] != "1" || chars[0].Marks["italic"] != "1" {
		t.Fatalf("marks: %+v", chars)
	}
}

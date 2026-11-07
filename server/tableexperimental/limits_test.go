package tableexperimental

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestSharedResourceVectors(t *testing.T) {
	raw, err := os.ReadFile("../../packages/collab/testdata/table-resource-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Version int `json:"version"`
		Cases   []struct {
			Name       string          `json:"name"`
			Limits     json.RawMessage `json:"limits"`
			Operations []Op            `json:"operations"`
			Results    []string        `json:"results"`
			Grid       [][]string      `json:"grid"`
			Pending    int             `json:"pending"`
			Rejected   []Rejected      `json:"rejected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Version != 1 || len(fixture.Cases) == 0 {
		t.Fatal("invalid shared resource vectors")
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			limits := DefaultLimits()
			if err := json.Unmarshal(tc.Limits, &limits); err != nil {
				t.Fatal(err)
			}
			table, err := NewWithLimits(limits)
			if err != nil {
				t.Fatal(err)
			}
			if len(tc.Operations) != len(tc.Results) {
				t.Fatal("operation/result length mismatch")
			}
			for i, op := range tc.Operations {
				accepted, err := table.Apply(op)
				got := "accepted"
				if err != nil {
					got = err.Error()
				} else if !accepted {
					got = "duplicate"
				}
				if got != tc.Results[i] {
					t.Fatalf("op %d got %q want %q", i, got, tc.Results[i])
				}
			}
			if got := table.View(); !reflect.DeepEqual(got, tc.Grid) {
				t.Fatalf("grid %v want %v", got, tc.Grid)
			}
			if got := table.PendingCount(); got != tc.Pending {
				t.Fatalf("pending %d want %d", got, tc.Pending)
			}
			if got := table.Rejected(); !reflect.DeepEqual(got, tc.Rejected) {
				t.Fatalf("rejected %v want %v", got, tc.Rejected)
			}
			snapshot, err := table.Snapshot()
			if err != nil {
				t.Fatal(err)
			}
			restored, err := FromSnapshotWithLimits(snapshot, limits)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(restored.View(), tc.Grid) || restored.PendingCount() != tc.Pending || !reflect.DeepEqual(restored.Rejected(), tc.Rejected) {
				t.Fatal("snapshot replay changed materialized state")
			}
		})
	}
}

func smallLimits() Limits {
	return Limits{MaxRows: 4, MaxColumns: 4, MaxGridCells: 8, MaxCharactersPerCell: 2, MaxOperations: 20, MaxPending: 2, MaxOperationBytes: 512, MaxSnapshotBytes: 10000}
}

func requireLimit(t *testing.T, tab *Table, op Op, name string) {
	t.Helper()
	before, err := tab.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := tab.Apply(op)
	if accepted || !errors.Is(err, ErrResourceLimit) || err.Error() != "table resource limit: "+name {
		t.Fatalf("accepted=%v err=%v want %s", accepted, err, name)
	}
	after, err := tab.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("rejected operation mutated ledger")
	}
}

func TestAdmissionLimitsAndRetryDoNotMutate(t *testing.T) {
	l := smallLimits()
	l.MaxRows = 1
	tab, err := NewWithLimits(l)
	if err != nil {
		t.Fatal(err)
	}
	row := Op{Kind: "axis-insert", ID: ID{1, 1}, Axis: "row"}
	if ok, err := tab.Apply(row); err != nil || !ok {
		t.Fatalf("row %v %v", ok, err)
	}
	if ok, err := tab.Apply(row); err != nil || ok {
		t.Fatalf("retry %v %v", ok, err)
	}
	requireLimit(t, tab, Op{Kind: "axis-insert", ID: ID{1, 2}, Axis: "row"}, "maxRows")

	l = smallLimits()
	l.MaxOperations = 1
	tab, _ = NewWithLimits(l)
	_, _ = tab.Apply(row)
	requireLimit(t, tab, Op{Kind: "axis-insert", ID: ID{1, 2}, Axis: "column"}, "maxOperations")

	l = smallLimits()
	l.MaxOperationBytes = 159
	tab, _ = NewWithLimits(l)
	requireLimit(t, tab, row, "maxOperationBytes")

	l = smallLimits()
	l.MaxSnapshotBytes = 214
	tab, _ = NewWithLimits(l)
	requireLimit(t, tab, row, "maxSnapshotBytes")
	l.MaxSnapshotBytes = 215
	tab, _ = NewWithLimits(l)
	if ok, err := tab.Apply(row); err != nil || !ok {
		t.Fatalf("exact reservation %v %v", ok, err)
	}
}

func TestPendingAndConservativeGridReservations(t *testing.T) {
	l := smallLimits()
	l.MaxPending = 1
	tab, _ := NewWithLimits(l)
	pending := Op{Kind: "axis-insert", ID: ID{1, 1}, Axis: "row", After: id(1, 9)}
	if ok, err := tab.Apply(pending); err != nil || !ok {
		t.Fatalf("pending %v %v", ok, err)
	}
	requireLimit(t, tab, Op{Kind: "axis-insert", ID: ID{1, 2}, Axis: "row", After: id(1, 10)}, "maxPending")
	if ok, err := tab.Apply(Op{Kind: "axis-insert", ID: ID{1, 9}, Axis: "row"}); err != nil || !ok || tab.PendingCount() != 0 {
		t.Fatalf("wake %v %v pending=%d", ok, err, tab.PendingCount())
	}

	l = smallLimits()
	l.MaxGridCells = 1
	tab, _ = NewWithLimits(l)
	_, _ = tab.Apply(Op{Kind: "axis-insert", ID: ID{1, 1}, Axis: "row", After: id(8, 1)})
	_, _ = tab.Apply(Op{Kind: "axis-insert", ID: ID{2, 1}, Axis: "column"})
	requireLimit(t, tab, Op{Kind: "axis-insert", ID: ID{2, 2}, Axis: "column"}, "maxGridCells")
}

func TestCellCharacterReservationsIncludePending(t *testing.T) {
	l := smallLimits()
	l.MaxCharactersPerCell = 1
	tab, _ := NewWithLimits(l)
	first := Op{Kind: "text-insert", ID: ID{3, 1}, Row: id(1, 1), Column: id(2, 1), Char: "😀"}
	if ok, err := tab.Apply(first); err != nil || !ok {
		t.Fatalf("first %v %v", ok, err)
	}
	requireLimit(t, tab, Op{Kind: "text-insert", ID: ID{3, 2}, Row: id(1, 1), Column: id(2, 1), Char: "x"}, "maxCharactersPerCell")
}

func TestClosedCycleRejectedAndDependentsAwakened(t *testing.T) {
	for _, reversed := range []bool{false, true} {
		tab := New()
		a := Op{Kind: "axis-insert", ID: ID{1, 1}, Axis: "row", After: id(1, 2)}
		b := Op{Kind: "axis-insert", ID: ID{1, 2}, Axis: "row", After: id(1, 1)}
		dependent := Op{Kind: "axis-insert", ID: ID{1, 3}, Axis: "row", After: id(1, 1)}
		_, _ = tab.Apply(dependent)
		if reversed {
			a, b = b, a
		}
		_, _ = tab.Apply(a)
		_, _ = tab.Apply(b)
		want := []Rejected{{ID{1, 1}, "cyclic dependency"}, {ID{1, 2}, "cyclic dependency"}, {ID{1, 3}, "axis dependency has wrong type"}}
		if got := tab.Rejected(); !reflect.DeepEqual(got, want) || tab.PendingCount() != 0 {
			t.Fatalf("reversed=%v got=%v pending=%d", reversed, got, tab.PendingCount())
		}
		raw, err := tab.Snapshot()
		if err != nil {
			t.Fatal(err)
		}
		restored, err := FromSnapshot(raw)
		if err != nil || !reflect.DeepEqual(restored.Rejected(), want) {
			t.Fatalf("replay rejected=%v err=%v", restored, err)
		}
	}
}

func TestSnapshotBudgetIsConservativeForEscapesAndLargeIDs(t *testing.T) {
	tab := New()
	row := ID{maxSafeInteger, maxSafeInteger - 10}
	col := ID{maxSafeInteger, maxSafeInteger - 9}
	for _, op := range []Op{
		{Kind: "axis-insert", ID: row, Axis: "row"},
		{Kind: "axis-insert", ID: col, Axis: "column"},
		{Kind: "text-insert", ID: ID{maxSafeInteger, maxSafeInteger - 8}, Row: &row, Column: &col, Char: "\x00"},
		{Kind: "text-insert", ID: ID{maxSafeInteger, maxSafeInteger - 7}, Row: &row, Column: &col, Char: "\u2028"},
		{Kind: "text-insert", ID: ID{maxSafeInteger, maxSafeInteger - 6}, Row: &row, Column: &col, Char: "<"},
	} {
		if _, err := tab.Apply(op); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := tab.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > tab.snapshotBudget {
		t.Fatalf("snapshot size=%d reservation=%d", len(raw), tab.snapshotBudget)
	}
}

func TestSnapshotSizeAndLimitValidation(t *testing.T) {
	l := smallLimits()
	l.MaxRows = 0
	if _, err := NewWithLimits(l); err == nil {
		t.Fatal("accepted zero limit")
	}
	l = smallLimits()
	l.MaxSnapshotBytes = 21
	if _, err := NewWithLimits(l); !errors.Is(err, ErrResourceLimit) {
		t.Fatalf("small snapshot limit: %v", err)
	}
	l = smallLimits()
	l.MaxSnapshotBytes = 40
	if _, err := FromSnapshotWithLimits([]byte(strings.Repeat(" ", 41)), l); !errors.Is(err, ErrResourceLimit) {
		t.Fatalf("raw snapshot size: %v", err)
	}
}

func TestSnapshotRejectsExcessArraysBeforeMaterialization(t *testing.T) {
	l := smallLimits()
	l.MaxOperations = 2
	cases := []string{
		`{"version":1,"ops":[{}, {}, {}]}`,
		`{"version":1,"ops":[[1,2,3]]}`,
	}
	for _, raw := range cases {
		if _, err := FromSnapshotWithLimits([]byte(raw), l); !errors.Is(err, ErrResourceLimit) || err.Error() != "table resource limit: maxOperations" {
			t.Fatalf("%s: %v", raw, err)
		}
	}
}

func TestRandomizedMaterializedStateSurvivesReplay(t *testing.T) {
	for seed := int64(0); seed < 1200; seed++ {
		rng := rand.New(rand.NewSource(seed))
		ops := make([]Op, 0, 50)
		for i := int64(1); i <= 50; i++ {
			id := ID{1, i}
			dep := func() *ID {
				for {
					n := int64(rng.Intn(60) + 1)
					if n != i {
						return &ID{1, n}
					}
				}
			}
			switch rng.Intn(4) {
			case 0:
				ops = append(ops, Op{Kind: "axis-insert", ID: id, Axis: []string{"row", "column"}[rng.Intn(2)], After: dep()})
			case 1:
				ops = append(ops, Op{Kind: "axis-delete", ID: id, Axis: []string{"row", "column"}[rng.Intn(2)], Target: dep()})
			case 2:
				ops = append(ops, Op{Kind: "text-insert", ID: id, Row: dep(), Column: dep(), After: dep(), Char: "x"})
			case 3:
				ops = append(ops, Op{Kind: "text-delete", ID: id, Row: dep(), Column: dep(), Target: dep()})
			}
		}
		tab := New()
		for _, ix := range rng.Perm(len(ops)) {
			if _, err := tab.Apply(ops[ix]); err != nil {
				t.Fatalf("seed=%d: %v", seed, err)
			}
		}
		raw, err := tab.Snapshot()
		if err != nil {
			t.Fatal(err)
		}
		restored, err := FromSnapshot(raw)
		if err != nil {
			t.Fatalf("seed=%d: %v", seed, err)
		}
		if tab.PendingCount() != restored.PendingCount() || !reflect.DeepEqual(tab.Rejected(), restored.Rejected()) || !reflect.DeepEqual(tab.View(), restored.View()) {
			encoded, _ := json.Marshal(ops)
			t.Logf("ops=%s", encoded)
			for _, op := range ops {
				if op.ID.Clock == 38 || op.ID.Clock == 44 {
					t.Logf("seed=%d op=%+v", seed, op)
				}
			}
			t.Fatalf("seed=%d pending %d/%d rejected %v/%v", seed, tab.PendingCount(), restored.PendingCount(), tab.Rejected(), restored.Rejected())
		}
	}
}

func TestSnapshotReplayAllowsTemporaryPendingButChecksFinal(t *testing.T) {
	l := smallLimits()
	l.MaxPending = 1
	tab, _ := NewWithLimits(l)
	root := Op{Kind: "axis-insert", ID: ID{1, 10}, Axis: "row"}
	_, _ = tab.Apply(root)
	_, _ = tab.Apply(Op{Kind: "axis-insert", ID: ID{1, 1}, Axis: "row", After: id(1, 10)})
	_, _ = tab.Apply(Op{Kind: "axis-insert", ID: ID{1, 2}, Axis: "row", After: id(1, 10)})
	raw, err := tab.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := FromSnapshotWithLimits(raw, l)
	if err != nil || !reflect.DeepEqual(restored.View(), tab.View()) || restored.PendingCount() != 0 {
		t.Fatalf("restore %v", err)
	}

	other, _ := NewWithLimits(smallLimits())
	_, _ = other.Apply(Op{Kind: "axis-insert", ID: ID{2, 1}, Axis: "row", After: id(3, 1)})
	_, _ = other.Apply(Op{Kind: "axis-insert", ID: ID{2, 2}, Axis: "row", After: id(3, 2)})
	raw, _ = other.Snapshot()
	if _, err = FromSnapshotWithLimits(raw, l); !errors.Is(err, ErrResourceLimit) || err.Error() != "table resource limit: maxPending" {
		t.Fatalf("final pending: %v", err)
	}
}

func BenchmarkIndependentMissingDependencies(b *testing.B) {
	for _, n := range []int{1000, 2000, 4000, 8000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				tab := New()
				for j := 1; j <= n; j++ {
					_, _ = tab.Apply(Op{Kind: "axis-insert", ID: ID{1, int64(j)}, Axis: "row", After: id(2, int64(j))})
				}
			}
		})
	}
}

func BenchmarkGrowingPendingChain(b *testing.B) {
	for _, n := range []int{1000, 2000, 4000, 8000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				tab := New()
				for j := 1; j <= n; j++ {
					_, _ = tab.Apply(Op{Kind: "axis-insert", ID: ID{1, int64(j)}, Axis: "row", After: id(1, int64(j+1))})
				}
			}
		})
	}
}

func BenchmarkWakePendingChain(b *testing.B) {
	for _, n := range []int{1000, 2000, 4000, 8000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				tab := New()
				for j := 1; j <= n; j++ {
					_, _ = tab.Apply(Op{Kind: "axis-insert", ID: ID{1, int64(j)}, Axis: "row", After: id(1, int64(j+1))})
				}
				_, _ = tab.Apply(Op{Kind: "axis-insert", ID: ID{1, int64(n + 1)}, Axis: "row"})
				if tab.PendingCount() != 0 {
					b.Fatal("chain failed to resolve")
				}
			}
		})
	}
}

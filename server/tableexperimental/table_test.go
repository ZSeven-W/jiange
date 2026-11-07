package tableexperimental

import (
	"encoding/json"
	"errors"
	"math/rand"
	"os"
	"reflect"
	"strings"
	"testing"
)

type vector struct {
	Name     string `json:"name"`
	Ops      []Op   `json:"ops"`
	Expected struct {
		Grid        [][]string `json:"grid"`
		Pending     int        `json:"pending"`
		Rejected    []Rejected `json:"rejected"`
		HiddenCells []struct {
			Row    ID     `json:"row"`
			Column ID     `json:"column"`
			Text   string `json:"text"`
		} `json:"hiddenCells"`
	} `json:"expected"`
}

func TestSharedTypeScriptVectors(t *testing.T) {
	raw, err := os.ReadFile("../../packages/collab/testdata/table-experimental.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Version int      `json:"version"`
		Cases   []vector `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Version != 1 || len(fixture.Cases) == 0 {
		t.Fatal("invalid shared fixtures")
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			for seed := int64(0); seed < 30; seed++ {
				table := New()
				order := rand.New(rand.NewSource(seed)).Perm(len(tc.Ops))
				for i, ix := range order {
					if accepted, err := table.Apply(tc.Ops[ix]); err != nil || !accepted {
						t.Fatalf("seed %d op %d: accepted=%v err=%v", seed, ix, accepted, err)
					}
					if i == len(order)/2 {
						snap, err := table.Snapshot()
						if err != nil {
							t.Fatal(err)
						}
						table, err = FromSnapshot(snap)
						if err != nil {
							t.Fatal(err)
						}
					}
				}
				if got := table.View(); !reflect.DeepEqual(got, tc.Expected.Grid) {
					t.Fatalf("seed %d grid=%v want=%v", seed, got, tc.Expected.Grid)
				}
				if got := table.PendingCount(); got != tc.Expected.Pending {
					t.Fatalf("seed %d pending=%d want=%d", seed, got, tc.Expected.Pending)
				}
				if got := table.Rejected(); !reflect.DeepEqual(got, tc.Expected.Rejected) {
					t.Fatalf("seed %d rejected=%v want=%v", seed, got, tc.Expected.Rejected)
				}
				for _, h := range tc.Expected.HiddenCells {
					got, ok := table.CellText(h.Row, h.Column, true)
					if !ok || got != h.Text {
						t.Fatalf("seed %d hidden=%q,%v want=%q", seed, got, ok, h.Text)
					}
				}
			}
		})
	}
}

func id(client, clock int64) *ID { return &ID{Client: client, Clock: clock} }

func TestIdentityLedgerAndDefensiveCopy(t *testing.T) {
	table := New()
	anchor := id(1, 1)
	first := Op{Kind: "axis-insert", ID: *anchor, Axis: "row"}
	if ok, err := table.Apply(first); err != nil || !ok {
		t.Fatalf("first=%v %v", ok, err)
	}
	next := Op{Kind: "axis-insert", ID: ID{2, 1}, Axis: "row", After: anchor}
	if _, err := table.Apply(next); err != nil {
		t.Fatal(err)
	}
	anchor.Clock = 99
	if got := table.AxisIDs("row", false); !reflect.DeepEqual(got, []ID{{1, 1}, {2, 1}}) {
		t.Fatalf("caller mutated ledger: %v", got)
	}
	next.After = id(1, 1)
	if ok, err := table.Apply(next); err != nil || ok {
		t.Fatalf("exact retry=%v %v", ok, err)
	}
	next.Axis = "column"
	if _, err := table.Apply(next); !errors.Is(err, ErrIdentityConflict) {
		t.Fatalf("identity conflict=%v", err)
	}
}

func TestSnapshotStrictnessAndUnicode(t *testing.T) {
	good := []string{
		`{"version":1.0,"ops":[]}`,
		`{"version":1e0,"ops":[{"kind":"axis-insert","id":{"client":1.0,"clock":1e0},"axis":"row","after":null}]}`,
		`{"version":1,"ops":[{"kind":"axis-insert","id":{"client":1,"clock":1},"axis":"row","after":null},{"kind":"axis-insert","id":{"client":1,"clock":2},"axis":"column","after":null},{"kind":"text-insert","id":{"client":1,"clock":3},"row":{"client":1,"clock":1},"column":{"client":1,"clock":2},"after":null,"char":"\ud83d\ude42"}]}`,
	}
	for _, raw := range good {
		if _, err := FromSnapshot([]byte(raw)); err != nil {
			t.Errorf("valid snapshot %s: %v", raw, err)
		}
	}
	bad := []string{
		`{"version":1,"version":1,"ops":[]}`,
		`{"version":1,"ops":[{"kind":"axis-insert","id":{"client":1,"cl\u0069ent":2,"clock":1},"axis":"row","after":null}]}`,
		`{"version":1,"ops":[{"kind":"text-insert","id":{"client":1,"clock":3},"row":{"client":1,"clock":1},"column":{"client":1,"clock":2},"after":null,"char":"\ud800","char":"x"}]}`,
		`{"version":1,"ops":[],"future":true}`,
		`{"version":1,"ops":null}`,
		`{"version":1,"ops":[{"kind":"axis-insert","id":{"client":1,"clock":1},"axis":"row"}]}`,
		`{"version":1,"ops":[{"kind":"axis-insert","id":{"client":1,"clock":1,"future":2},"axis":"row","after":null}]}`,
		`{"version":1,"ops":[{"kind":"axis-insert","id":{"client":1,"clock":1},"axis":"row","after":null,"future":true}]}`,
		`{"version":1,"ops":[{"kind":"text-insert","id":{"client":1,"clock":3},"row":{"client":1,"clock":1},"column":{"client":1,"clock":2},"after":null,"char":"\ud800"}]}`,
		`{"version":1,"ops":[{"kind":"axis-insert","id":{"client":9007199254740992,"clock":1},"axis":"row","after":null}]}`,
	}
	for _, raw := range bad {
		if _, err := FromSnapshot([]byte(raw)); err == nil {
			t.Errorf("accepted invalid snapshot %s", raw)
		}
	}
	tooDeep := `{"version":1,"ops":` + strings.Repeat("[", 128) + `0` + strings.Repeat("]", 128) + `}`
	if _, err := FromSnapshot([]byte(tooDeep)); err == nil {
		t.Fatal("accepted nesting deeper than 128")
	}
}

func TestSharedInvalidSnapshots(t *testing.T) {
	raw, err := os.ReadFile("../../packages/collab/testdata/table-experimental-invalid-snapshots.json")
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
		t.Fatal("invalid shared fixture")
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			if _, err := FromSnapshot([]byte(tc.Snapshot)); err == nil {
				t.Fatal("invalid snapshot was accepted")
			}
		})
	}
}

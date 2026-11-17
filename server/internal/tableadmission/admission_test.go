package tableadmission

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/tableexperimental"
)

type fixture struct {
	doc                        *collab.Doc
	block                      collab.OpID
	row, column, first, second tableexperimental.ID
	records                    []Record
}

func tableFrame(t *testing.T, block collab.OpID, op tableexperimental.Op) collab.Op {
	t.Helper()
	raw, err := json.Marshal(op)
	if err != nil {
		t.Fatal(err)
	}
	return collab.Op{T: collab.TTable, ID: collab.OpID{Client: uint64(op.ID.Client), Clock: uint64(op.ID.Clock)}, Block: block, Payload: raw}
}
func addRecord(t *testing.T, f *fixture, op collab.Op) {
	t.Helper()
	if err := f.doc.TryApply(op); err != nil {
		t.Fatal(err)
	}
	raw, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	f.records = append(f.records, Record{Seq: int64(len(f.records) + 1), Data: raw})
}
func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{doc: collab.NewDoc(), block: collab.OpID{Client: 1, Clock: 1}, row: tableexperimental.ID{Client: 1, Clock: 2}, column: tableexperimental.ID{Client: 1, Clock: 3}, first: tableexperimental.ID{Client: 1, Clock: 4}, second: tableexperimental.ID{Client: 1, Clock: 5}}
	addRecord(t, f, collab.Op{T: collab.TBlockCreate, ID: f.block, Parent: collab.Root, Pos: "U", Type: "table"})
	for _, op := range []tableexperimental.Op{
		{Kind: "axis-insert", ID: f.row, Axis: "row"}, {Kind: "axis-insert", ID: f.column, Axis: "column"},
		{Kind: "text-insert", ID: f.first, Row: &f.row, Column: &f.column, Char: "甲"}, {Kind: "text-insert", ID: f.second, Row: &f.row, Column: &f.column, After: &f.first, Char: "😀"},
	} {
		addRecord(t, f, tableFrame(t, f.block, op))
	}
	return f
}
func mark(t *testing.T, f *fixture, author, clock int64, target tableexperimental.ID, key string, value *string) collab.Op {
	t.Helper()
	return tableFrame(t, f.block, tableexperimental.Op{Kind: "text-mark", ID: tableexperimental.ID{Client: author, Clock: clock}, Row: &f.row, Column: &f.column, Target: &target, Key: key, Value: value})
}

func TestPrepareMarksIsDetachedAndChecksIdentities(t *testing.T) {
	f := newFixture(t)
	before := f.doc.EncodeState()
	projection, err := Rebuild(f.doc, int64(len(f.records)), f.block, f.records)
	if err != nil {
		t.Fatal(err)
	}
	baseTable, err := projection.table.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	value := "1"
	frames := []collab.Op{mark(t, f, 2, 6, f.first, "bold", &value), mark(t, f, 2, 7, f.second, "bold", &value)}
	prepared, err := projection.PrepareMarks(2, frames)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.BaseHead() != int64(len(f.records)) || !bytes.Equal(before, f.doc.EncodeState()) {
		t.Fatal("preflight changed base or head")
	}
	afterBase, err := projection.table.Snapshot()
	if err != nil || !bytes.Equal(baseTable, afterBase) {
		t.Fatal("preflight mutated table")
	}
	result, err := tableexperimental.FromSnapshot(prepared.TableSnapshot())
	if err != nil {
		t.Fatal(err)
	}
	chars, ok := result.CellRich(f.row, f.column, false)
	if !ok || len(chars) != 2 || chars[0].Marks["bold"] != "1" || chars[1].Marks["bold"] != "1" {
		t.Fatalf("result %+v", chars)
	}
	state := prepared.DocumentState()
	state[0] = 0
	if prepared.DocumentState()[0] == 0 {
		t.Fatal("document bytes were shared")
	}
	tableBytes := prepared.TableSnapshot()
	tableBytes[0] = 0
	if prepared.TableSnapshot()[0] == 0 {
		t.Fatal("table bytes were shared")
	}
	for _, op := range frames {
		if err := f.doc.TryApply(op); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(f.doc.EncodeState(), prepared.DocumentState()) {
		t.Fatal("prepared document state differs from replay")
	}
}

func TestPrepareMarksTypeScriptWireFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/collab/testdata/table-rich-mark-frames.json")
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Version int    `json:"version"`
		Batch   []byte `json:"batch"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil || wire.Version != 1 {
		t.Fatalf("fixture: %v", err)
	}
	frames, err := collab.DecodeOps(wire.Batch)
	if err != nil {
		t.Fatal(err)
	}
	f := newFixture(t)
	projection, err := Rebuild(f.doc, int64(len(f.records)), f.block, f.records)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := projection.PrepareMarks(2, frames)
	if err != nil {
		t.Fatal(err)
	}
	result, err := tableexperimental.FromSnapshot(prepared.TableSnapshot())
	if err != nil {
		t.Fatal(err)
	}
	chars, ok := result.CellRich(f.row, f.column, false)
	if !ok || len(chars) != 2 || chars[0].Marks["bold"] != "1" || chars[1].Marks["bold"] != "1" {
		t.Fatalf("result: %+v", chars)
	}
}

func TestConcurrentPreflightsDoNotMutateProjection(t *testing.T) {
	f := newFixture(t)
	projection, err := Rebuild(f.doc, int64(len(f.records)), f.block, f.records)
	if err != nil {
		t.Fatal(err)
	}
	before := projection.doc.EncodeState()
	original, err := projection.table.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	value := "1"
	var wg sync.WaitGroup
	failures := make(chan error, 16)
	for i := 0; i < 16; i++ {
		frame := mark(t, f, int64(i+2), 6, f.first, "bold", &value)
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := projection.PrepareMarks(frame.ID.Client, []collab.Op{frame})
			failures <- err
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	after, err := projection.table.Snapshot()
	if err != nil || !bytes.Equal(before, projection.doc.EncodeState()) || !bytes.Equal(original, after) {
		t.Fatal("concurrent preflight mutated base")
	}
}

func TestRebuildRejectsMissingOrInconsistentHistory(t *testing.T) {
	f := newFixture(t)
	head := int64(len(f.records))
	if _, err := Rebuild(f.doc, head, f.block, f.records[:len(f.records)-1]); !errors.Is(err, ErrInvalid) {
		t.Fatalf("missing: %v", err)
	}
	gap := append([]Record(nil), f.records...)
	gap[2].Seq++
	if _, err := Rebuild(f.doc, head, f.block, gap); !errors.Is(err, ErrInvalid) {
		t.Fatalf("gap: %v", err)
	}
	changed, err := collab.DecodeState(f.doc.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	changed.CreateBlock(3, collab.Root, "Z", "paragraph")
	if _, err := Rebuild(changed, head, f.block, f.records); !errors.Is(err, ErrInvalid) {
		t.Fatalf("state mismatch: %v", err)
	}
	bad := append([]Record(nil), f.records...)
	frame := mark(t, f, 2, 6, f.first, "bold", nil)
	frame.ID.Clock++
	bad[len(bad)-1].Data, err = collab.EncodeOps([]collab.Op{frame})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Rebuild(f.doc, head, f.block, bad); !errors.Is(err, ErrInvalid) {
		t.Fatalf("nested mismatch: %v", err)
	}
	bad = append([]Record(nil), f.records...)
	bad[1].Data = []byte{0xff}
	if _, err := Rebuild(f.doc, head, f.block, bad); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid encoding: %v", err)
	}
}

func TestRebuildRejectsLegacyTableWithoutExperimentalHistory(t *testing.T) {
	doc := collab.NewDoc()
	block := doc.CreateBlock(1, collab.Root, "U", "table")
	raw, err := collab.EncodeOps([]collab.Op{block})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Rebuild(doc, 1, block.ID, []Record{{Seq: 1, Data: raw}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("legacy table accepted: %v", err)
	}
}

func TestPrepareMarksRejectsInvalidBatchesAtomically(t *testing.T) {
	f := newFixture(t)
	projection, err := Rebuild(f.doc, int64(len(f.records)), f.block, f.records)
	if err != nil {
		t.Fatal(err)
	}
	baseDoc := projection.doc.EncodeState()
	baseTable, _ := projection.table.Snapshot()
	value := "1"
	good := mark(t, f, 2, 6, f.first, "bold", &value)
	wrongTarget := mark(t, f, 2, 7, tableexperimental.ID{Client: 9, Clock: 9}, "bold", &value)
	badPayload := good
	badPayload.Payload = []byte(`{"kind":"text-mark","kind":"text-mark"}`)
	wrongID := good
	wrongID.ID.Clock = 8
	wrongBlock := good
	wrongBlock.Block = collab.OpID{Client: 1, Clock: 99}
	badKind := tableFrame(t, f.block, tableexperimental.Op{Kind: "text-delete", ID: tableexperimental.ID{Client: 2, Clock: 6}, Row: &f.row, Column: &f.column, Target: &f.first})
	duplicate := mark(t, f, 2, 7, f.first, "bold", nil)
	oversized := good
	oversized.Payload = bytes.Repeat([]byte{'x'}, maxPayloadBytes+1)
	for name, frames := range map[string][]collab.Op{
		"empty": nil, "oversized": {oversized}, "out of order": {mark(t, f, 2, 7, f.first, "bold", &value), mark(t, f, 2, 6, f.second, "bold", &value)}, "missing target": {good, wrongTarget}, "bad payload": {badPayload}, "nested id": {wrongID}, "wrong block": {wrongBlock}, "not a mark": {badKind}, "duplicate register": {good, duplicate}, "wrong author": {mark(t, f, 3, 6, f.first, "bold", &value)}, "old clock": {mark(t, f, 2, 5, f.first, "bold", &value)},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := projection.PrepareMarks(2, frames); !errors.Is(err, ErrInvalid) {
				t.Fatalf("accepted %s: %v", name, err)
			}
			now, err := projection.table.Snapshot()
			if err != nil || !bytes.Equal(baseTable, now) || !bytes.Equal(baseDoc, projection.doc.EncodeState()) {
				t.Fatal("invalid batch mutated base")
			}
		})
	}
}

func TestPrepareMarksRejectsHiddenTargetsAndPreservesLimits(t *testing.T) {
	f := newFixture(t)
	del := tableexperimental.Op{Kind: "axis-delete", ID: tableexperimental.ID{Client: 1, Clock: 6}, Axis: "row", Target: &f.row}
	addRecord(t, f, tableFrame(t, f.block, del))
	projection, err := Rebuild(f.doc, int64(len(f.records)), f.block, f.records)
	if err != nil {
		t.Fatal(err)
	}
	value := "1"
	if _, err := projection.PrepareMarks(2, []collab.Op{mark(t, f, 2, 7, f.first, "bold", &value)}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("hidden target: %v", err)
	}
	if _, err := projection.PrepareMarks(2, make([]collab.Op, maxBatch+1)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("batch limit: %v", err)
	}
}

func TestRebuildRejectsMismatchedOrUnresolvedTablePayload(t *testing.T) {
	f := newFixture(t)
	id := tableexperimental.ID{Client: 2, Clock: 6}
	target := tableexperimental.ID{Client: 99, Clock: 1}
	value := "1"
	unresolved := tableexperimental.Op{Kind: "text-mark", ID: id, Row: &f.row, Column: &f.column, Target: &target, Key: "bold", Value: &value}
	addRecord(t, f, tableFrame(t, f.block, unresolved))
	if _, err := Rebuild(f.doc, int64(len(f.records)), f.block, f.records); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unresolved: %v", err)
	}
	if _, err := Rebuild(f.doc, int64(len(f.records)), collab.OpID{Client: 1, Clock: 999}, f.records); !errors.Is(err, ErrInvalid) {
		t.Fatalf("wrong table: %v", err)
	}
}

func TestRebuildAcceptsResolvedOutOfOrderTableDependencies(t *testing.T) {
	f := &fixture{doc: collab.NewDoc(), block: collab.OpID{Client: 1, Clock: 1}, row: tableexperimental.ID{Client: 1, Clock: 2}, column: tableexperimental.ID{Client: 1, Clock: 3}, first: tableexperimental.ID{Client: 1, Clock: 4}}
	addRecord(t, f, collab.Op{T: collab.TBlockCreate, ID: f.block, Parent: collab.Root, Pos: "U", Type: "table"})
	value := "1"
	for _, op := range []tableexperimental.Op{
		{Kind: "text-mark", ID: tableexperimental.ID{Client: 2, Clock: 5}, Row: &f.row, Column: &f.column, Target: &f.first, Key: "bold", Value: &value},
		{Kind: "text-insert", ID: f.first, Row: &f.row, Column: &f.column, Char: "甲"},
		{Kind: "axis-insert", ID: f.column, Axis: "column"},
		{Kind: "axis-insert", ID: f.row, Axis: "row"},
	} {
		addRecord(t, f, tableFrame(t, f.block, op))
	}
	projection, err := Rebuild(f.doc, int64(len(f.records)), f.block, f.records)
	if err != nil {
		t.Fatal(err)
	}
	chars, ok := projection.table.CellRich(f.row, f.column, false)
	if !ok || len(chars) != 1 || chars[0].Marks["bold"] != "1" {
		t.Fatalf("rich state: %+v", chars)
	}
}

func TestRebuildRejectsMultipleExperimentalTables(t *testing.T) {
	f := newFixture(t)
	block := collab.OpID{Client: 3, Clock: 6}
	addRecord(t, f, collab.Op{T: collab.TBlockCreate, ID: block, Parent: collab.Root, Pos: "V", Type: "table"})
	addRecord(t, f, tableFrame(t, block, tableexperimental.Op{Kind: "axis-insert", ID: tableexperimental.ID{Client: 3, Clock: 7}, Axis: "row"}))
	if _, err := Rebuild(f.doc, int64(len(f.records)), f.block, f.records); !errors.Is(err, ErrInvalid) {
		t.Fatalf("multiple tables: %v", err)
	}
}

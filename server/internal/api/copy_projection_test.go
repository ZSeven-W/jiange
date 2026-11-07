package api

import (
	"bytes"
	"errors"
	"reflect"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

func TestBuildCopyOpsTombstonedMarkAnchorPreservesFutureFormattingOrRejects(t *testing.T) {
	src := collab.NewDoc()
	for _, raw := range syncsrv.InitialOps("旧文档") {
		ops, err := collab.DecodeOps(raw.Bytes)
		if err != nil || len(ops) != 1 || !src.Apply(ops[0]) {
			t.Fatalf("initial operations: %v", err)
		}
	}
	paragraph := collab.OpID{Client: 0, Clock: 2}
	text := src.InsertText(7, paragraph, 0, "ABC")
	deletedChar := collab.OpID{Client: text.ID.Client, Clock: text.ID.Clock + 1}
	bold := "true"
	src.Apply(collab.Op{T: collab.TMark, ID: collab.OpID{Client: 7, Clock: src.Clock() + 1}, Block: paragraph, Key: "bold", Value: &bold,
		Start: collab.Anchor{Char: deletedChar, Side: 0}, End: collab.Anchor{Char: deletedChar, Side: 1}})
	src.DeleteText(7, paragraph, 1, 1)
	if got := src.View().Blocks[1].Spans; len(got) != 1 || got[0].Text != "AC" || len(got[0].Marks) != 0 {
		t.Fatalf("fixture did not hide the marked character: %+v", got)
	}
	before := src.EncodeState()
	ops, err := buildCopyOps(src, "副本", nil)
	if !bytes.Equal(before, src.EncodeState()) {
		t.Fatal("copy projection changed source document")
	}
	if err != nil {
		if !errors.Is(err, collab.ErrRestoreUnrepresentable) || len(ops) != 0 {
			t.Fatalf("must reject unsafe formatting without partial ops: %v", err)
		}
		return
	}
	copy := collab.NewDoc()
	for _, raw := range ops {
		decoded, err := collab.DecodeOps(raw.Bytes)
		if err != nil || len(decoded) != 1 || !copy.Apply(decoded[0]) {
			t.Fatalf("invalid copy operations: %v", err)
		}
	}
	if copy.Pending() != 0 {
		t.Fatalf("copy has unresolved operations: %d", copy.Pending())
	}
	for offset := 0; offset <= 2; offset++ {
		original, err := collab.DecodeState(src.EncodeState())
		if err != nil {
			t.Fatal(err)
		}
		cloned, err := collab.DecodeState(copy.EncodeState())
		if err != nil {
			t.Fatal(err)
		}
		original.InsertText(18, paragraph, offset, "X")
		cloned.InsertText(19, paragraph, offset, "X")
		if got, want := cloned.View().Blocks[1].Spans, original.View().Blocks[1].Spans; !reflect.DeepEqual(got, want) {
			t.Fatalf("future insertion at %d: got %+v want %+v", offset, got, want)
		}
	}
}

func copyFixture(t *testing.T) *collab.Doc {
	t.Helper()
	d := collab.NewDoc()
	for _, raw := range syncsrv.InitialOps("源文档") {
		ops, err := collab.DecodeOps(raw.Bytes)
		if err != nil || len(ops) != 1 || !d.Apply(ops[0]) {
			t.Fatalf("initial operations: %v", err)
		}
	}
	paragraph := collab.OpID{Client: 0, Clock: 2}
	insert := d.InsertText(7, paragraph, 0, "中文😀AB")
	bold := "true"
	mark := collab.Op{T: collab.TMark, ID: collab.OpID{Client: 7, Clock: d.Clock() + 1}, Block: paragraph, Key: "bold", Value: &bold, Start: collab.Anchor{Char: insert.ID, Side: 0}, End: collab.Anchor{Char: collab.Root, Side: 0}}
	if !d.Apply(mark) {
		t.Fatal("could not set mark")
	}
	italic := "true"
	mark = collab.Op{T: collab.TMark, ID: collab.OpID{Client: 7, Clock: d.Clock() + 1}, Block: paragraph, Key: "italic", Value: &italic, Start: collab.Anchor{Char: collab.OpID{Client: insert.ID.Client, Clock: insert.ID.Clock + 2}, Side: 0}, End: collab.Anchor{Char: collab.OpID{Client: insert.ID.Client, Clock: insert.ID.Clock + 3}, Side: 0}}
	if !d.Apply(mark) {
		t.Fatal("could not set partial mark")
	}
	columns := d.CreateBlock(7, collab.Root, "W", "columns")
	left := d.CreateBlock(7, columns.ID, "U", "paragraph")
	d.InsertText(7, left.ID, 0, "左栏")
	right := d.CreateBlock(7, columns.ID, "V", "paragraph")
	d.InsertText(7, right.ID, 0, "右栏😀")
	for _, item := range []struct{ typ, pos, id string }{{"image", "X", "42"}, {"file", "Y", "42"}, {"file", "Z", "88"}, {"image", "a", ""}} {
		block := d.CreateBlock(7, collab.Root, item.pos, item.typ)
		if item.id != "" {
			value := item.id
			op := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 7, Clock: d.Clock() + 1}, Block: block.ID, Key: "fileId", Value: &value}
			if !d.Apply(op) {
				t.Fatal("could not set file reference")
			}
		}
	}
	return d
}

func TestBuildCopyOpsPreservesStructureMarksAndFileReferences(t *testing.T) {
	src := copyFixture(t)
	before := src.EncodeState()
	if ids, err := collectCopyFileIDs(src); err != nil || !reflect.DeepEqual(ids, []int64{42, 88}) {
		t.Fatalf("source file IDs: %v %v", ids, err)
	}
	ops, err := buildCopyOps(src, "目标😀 副本", map[int64]int64{42: 100, 88: 101})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, src.EncodeState()) {
		t.Fatal("building the copy mutated its source")
	}
	replica := collab.NewDoc()
	seen := map[collab.OpID]bool{}
	for _, raw := range ops {
		decoded, err := collab.DecodeOps(raw.Bytes)
		if err != nil || len(decoded) != 1 {
			t.Fatalf("decode copy op: %v", err)
		}
		op := decoded[0]
		if op.ID.Client != 0 || seen[op.ID] || raw.ClientID != int64(op.ID.Client) || raw.Clock != int64(op.ID.Clock) {
			t.Fatalf("invalid operation identity: %+v", op.ID)
		}
		seen[op.ID] = true
		replica.Apply(op)
	}
	if replica.Pending() != 0 {
		t.Fatalf("copy has %d unresolved operations", replica.Pending())
	}
	view := replica.View()
	if len(view.Blocks) != 9 || view.Blocks[0].ID != "0:1" || view.Blocks[0].Type != "title" || replica.Text(collab.OpID{Client: 0, Clock: 1}) != "目标😀 副本" {
		t.Fatalf("unexpected document or title: %+v", view.Blocks)
	}
	spans := view.Blocks[1].Spans
	if len(spans) != 3 || spans[0].Text != "中文" || spans[1].Text != "😀" || spans[2].Text != "AB" || spans[0].Marks["bold"] != "true" || spans[1].Marks["italic"] != "true" || spans[2].Marks["bold"] != "true" {
		t.Fatalf("text or marks lost: %+v", view.Blocks[1])
	}
	columns := view.Blocks[2]
	if columns.Type != "columns" || view.Blocks[3].Parent != columns.ID || view.Blocks[4].Parent != columns.ID || view.Blocks[3].Spans[0].Text != "左栏" || view.Blocks[4].Spans[0].Text != "右栏😀" {
		t.Fatalf("nested content lost: %+v", view.Blocks[2:5])
	}
	if got := []string{view.Blocks[5].Props["fileId"], view.Blocks[6].Props["fileId"], view.Blocks[7].Props["fileId"]}; !reflect.DeepEqual(got, []string{"100", "100", "101"}) {
		t.Fatalf("incorrect cloned file IDs: %v", got)
	}
	if view.Blocks[8].Type != "image" || view.Blocks[8].Props["fileId"] != "" {
		t.Fatalf("empty image placeholder changed: %+v", view.Blocks[8])
	}
}

func TestBuildCopyOpsRejectsUnsafeSourcesAndMappings(t *testing.T) {
	for _, tc := range []struct {
		name  string
		files map[int64]int64
	}{
		{"missing", map[int64]int64{42: 100}},
		{"extra", map[int64]int64{42: 100, 88: 101, 99: 102}},
		{"invalid", map[int64]int64{42: 0, 88: 101}},
		{"collision", map[int64]int64{42: 100, 88: 100}},
		{"source alias", map[int64]int64{42: 88, 88: 101}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := buildCopyOps(copyFixture(t), "副本", tc.files); err == nil {
				t.Fatal("unsafe mapping accepted")
			}
		})
	}
	if _, err := buildCopyOps(nil, "副本", nil); err == nil {
		t.Fatal("nil source accepted")
	}
	withoutTitle := collab.NewDoc()
	withoutTitle.CreateBlock(3, collab.Root, "V", "paragraph")
	if _, err := buildCopyOps(withoutTitle, "副本", nil); err == nil {
		t.Fatal("source without the standard title accepted")
	}
	invalid := copyFixture(t)
	for _, b := range invalid.View().Blocks {
		if b.Type == "image" && b.Props["fileId"] == "42" {
			id, err := parseCopyBlockID(b.ID)
			if err != nil {
				t.Fatal(err)
			}
			value := "01"
			invalid.Apply(collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 7, Clock: invalid.Clock() + 1}, Block: id, Key: "fileId", Value: &value})
			break
		}
	}
	if _, err := collectCopyFileIDs(invalid); err == nil {
		t.Fatal("noncanonical file ID accepted")
	}
	pending := copyFixture(t)
	pending.Apply(collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 30, Clock: pending.Clock() + 1}, Block: collab.OpID{Client: 50, Clock: 1}, Parent: collab.Root, Text: "未满足依赖"})
	if pending.Pending() == 0 {
		t.Fatal("test did not create pending operation")
	}
	if _, err := buildCopyOps(pending, "副本", map[int64]int64{42: 100, 88: 101}); err == nil {
		t.Fatal("source with unresolved operations accepted")
	}
	nearLimit := copyFixture(t)
	value := "true"
	nearLimit.Apply(collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 4, Clock: maxCopyClock - 1}, Block: collab.OpID{Client: 0, Clock: 1}, Key: "test", Value: &value})
	if _, err := buildCopyOps(nearLimit, "副本", map[int64]int64{42: 100, 88: 101}); err == nil {
		t.Fatal("source without sufficient clock space accepted")
	}
}

func TestCopyOfCopyKeepsServerAuthoredBlocksAndFreshAttachments(t *testing.T) {
	firstOps, err := buildCopyOps(copyFixture(t), "甲", map[int64]int64{42: 100, 88: 101})
	if err != nil {
		t.Fatal(err)
	}
	first := collab.NewDoc()
	for _, raw := range firstOps {
		ops, err := collab.DecodeOps(raw.Bytes)
		if err != nil || len(ops) != 1 {
			t.Fatalf("decode first copy: %v", err)
		}
		first.Apply(ops[0])
	}
	secondOps, err := buildCopyOps(first, "更长的第二份副本标题😀", map[int64]int64{100: 200, 101: 201})
	if err != nil {
		t.Fatal(err)
	}
	second := collab.NewDoc()
	for _, raw := range secondOps {
		ops, err := collab.DecodeOps(raw.Bytes)
		if err != nil || len(ops) != 1 {
			t.Fatalf("decode second copy: %v", err)
		}
		second.Apply(ops[0])
	}
	if second.Pending() != 0 || second.Text(collab.OpID{Client: 0, Clock: 1}) != "更长的第二份副本标题😀" {
		t.Fatalf("second copy title or pending failed: %+v", second.View())
	}
	ids, err := collectCopyFileIDs(second)
	if err != nil || !reflect.DeepEqual(ids, []int64{200, 201}) {
		t.Fatalf("second copy file IDs: %v %v", ids, err)
	}
	blocks := second.View().Blocks
	if len(blocks) != 9 || blocks[2].Type != "columns" || blocks[3].Parent != blocks[2].ID || blocks[4].Parent != blocks[2].ID || blocks[3].Spans[0].Text != "左栏" || blocks[1].Spans[1].Marks["italic"] != "true" {
		t.Fatalf("copy of copy lost content: %+v", blocks)
	}
}

func TestSameCopyShapeRejectsChangedContentAndBrokenTree(t *testing.T) {
	src := copyFixture(t).View()
	if !sameCopyShape(src, src) {
		t.Fatal("identical shapes differ")
	}
	changed := collab.DocView{Blocks: append([]collab.BlockView(nil), src.Blocks...)}
	changed.Blocks[3].Parent = "0:0"
	if sameCopyShape(src, changed) {
		t.Fatal("lost nesting accepted")
	}
	changed.Blocks[3].Parent = "missing"
	if sameCopyShape(src, changed) {
		t.Fatal("orphan accepted")
	}
	changed = collab.DocView{Blocks: append([]collab.BlockView(nil), src.Blocks...)}
	changed.Blocks[1].Spans = append([]collab.Span(nil), src.Blocks[1].Spans...)
	changed.Blocks[1].Spans[1].Marks = map[string]string{"bold": "true"}
	if sameCopyShape(src, changed) {
		t.Fatal("changed text formatting accepted")
	}
	// Fresh IDs are expected, provided parent relationships and order match.
	changed = collab.DocView{Blocks: append([]collab.BlockView(nil), src.Blocks...)}
	ids := map[string]string{"0:0": "0:0"}
	for i, b := range changed.Blocks {
		ids[b.ID] = collab.OpID{Client: 100, Clock: uint64(i + 1)}.Key()
	}
	for i, b := range changed.Blocks {
		changed.Blocks[i].ID, changed.Blocks[i].Parent = ids[b.ID], ids[b.Parent]
	}
	if !sameCopyShape(src, changed) {
		t.Fatal("equivalent tree with fresh IDs rejected")
	}
}

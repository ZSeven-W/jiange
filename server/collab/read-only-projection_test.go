package collab

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

func projectionFixture() (*Doc, DocView) {
	d := NewDoc()
	parent := d.CreateBlock(4, Root, "A", "columns")
	p := d.CreateBlock(4, parent.ID, "A", "paragraph")
	d.InsertText(4, p.ID, 0, "甲密乙😀丙")
	bold := "true"
	restoreTestMark(d, p.ID, 0, 4, "bold", &bold)
	d.DeleteText(4, p.ID, 1, 1)
	restoreTestProp(d, p.ID, "oldSecret", "UNRENDERED-PROPERTY-SECRET")
	deleted := d.CreateBlock(4, Root, "B", "paragraph")
	d.InsertText(4, deleted.ID, 0, "HIDDEN-BLOCK-SECRET")
	d.Apply(Op{T: TBlockDelete, ID: d.next(4, 1), Block: deleted.ID})
	table := d.CreateBlock(4, Root, "C", "table")
	d.InsertText(4, table.ID, 0, "TABLE-OLD-TEXT-SECRET")
	restoreTestProp(d, table.ID, "tbl.base", "TABLE-OLD-DATA-SECRET")
	restoreTestProp(d, table.ID, "tableData", `[["可见"]]`)
	view := d.View()
	for i := range view.Blocks {
		delete(view.Blocks[i].Props, "oldSecret")
		if view.Blocks[i].Type == "table" {
			delete(view.Blocks[i].Props, "tbl.base")
			view.Blocks[i].Spans = []Span{}
		}
	}
	return d, view
}

func TestReadOnlyProjectionPreservesVisibleAnchorsAndDropsHistory(t *testing.T) {
	d, view := projectionFixture()
	before := d.EncodeState()
	projected, err := d.ReadOnlyProjection(view)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, d.EncodeState()) {
		t.Fatal("mutated source")
	}
	if !sameProjectionView(projected.View(), view) {
		t.Fatalf("projected: %+v", projected.View())
	}
	data := projected.EncodeState()
	for _, secret := range []string{"UNRENDERED-PROPERTY-SECRET", "HIDDEN-BLOCK-SECRET", "TABLE-OLD-TEXT-SECRET", "TABLE-OLD-DATA-SECRET", "密"} {
		if bytes.Contains(data, []byte(secret)) {
			t.Fatalf("snapshot leaked %q", secret)
		}
	}
	decoded, err := DecodeState(data)
	if err != nil {
		t.Fatal(err)
	}
	if !sameProjectionView(decoded.View(), view) {
		t.Fatal("snapshot round trip changed visible content")
	}
	paragraph := decoded.blocks[OpID{Client: 4, Clock: 2}]
	if paragraph == nil || paragraph.chars[OpID{Client: 4, Clock: 4}] != nil {
		t.Fatal("deleted character identity remained in projected state")
	}
	for id, block := range decoded.blocks {
		if block.deleted {
			t.Fatalf("deleted block retained: %v", id)
		}
		for _, node := range block.chars {
			if node.id != Root && node.deleted {
				t.Fatalf("deleted character retained: %v", node.id)
			}
		}
		if block.props["oldSecret"].value != "" || block.props["tbl.base"].value != "" {
			t.Fatal("excluded properties retained")
		}
		if block.props["type"].value == "table" && len(block.chars) != 1 {
			t.Fatal("table's hidden old text retained")
		}
	}
	for _, v := range view.Blocks {
		id, _ := projectionID(v.ID)
		if len(v.Spans) == 0 {
			continue
		}
		want, got := d.visible(d.blocks[id]), decoded.visible(decoded.blocks[id])
		if len(want) != len(got) {
			t.Fatal("visible characters changed")
		}
		for i := range want {
			if want[i].id != got[i].id {
				t.Fatalf("anchor at %d: %v != %v", i, got[i].id, want[i].id)
			}
		}
	}
	if !bytes.Equal(data, projected.EncodeState()) {
		t.Fatal("snapshot is not deterministic")
	}
	fixtureBytes, err := os.ReadFile("../../packages/collab/test/fixtures/read-only-projection.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		State string  `json:"state"`
		View  DocView `json:"view"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	fixtureState, err := base64.StdEncoding.DecodeString(fixture.State)
	if err != nil || !bytes.Equal(fixtureState, data) || !reflect.DeepEqual(fixture.View, view) {
		t.Fatalf("cross-language fixture no longer matches Go projection: %v", err)
	}
	if path := os.Getenv("JIANGE_READONLY_VECTOR_PATH"); path != "" {
		vector := struct {
			State string  `json:"state"`
			View  DocView `json:"view"`
		}{base64.StdEncoding.EncodeToString(data), view}
		b, err := json.Marshal(vector)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReadOnlyProjectionRejectsAmbiguousView(t *testing.T) {
	d, view := projectionFixture()
	for _, tc := range []struct {
		name   string
		mutate func(*DocView)
	}{
		{"missing block", func(v *DocView) { v.Blocks = v.Blocks[:len(v.Blocks)-1] }},
		{"wrong identity", func(v *DocView) { v.Blocks[0].ID = "4:999" }},
		{"reparent", func(v *DocView) { v.Blocks[1].Parent = "0:0" }},
		{"replaced text", func(v *DocView) { v.Blocks[1].Spans = []Span{{Text: "伪造", Marks: map[string]string{}}} }},
		{"noncanonical parent", func(v *DocView) { v.Blocks[0].Parent = "00:00" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, _ := json.Marshal(view)
			var changed DocView
			_ = json.Unmarshal(b, &changed)
			tc.mutate(&changed)
			if _, err := d.ReadOnlyProjection(changed); !errors.Is(err, ErrReadOnlyProjection) {
				t.Fatalf("expected rejection, got %v", err)
			}
		})
	}
	d.Apply(Op{T: TTextDelete, ID: d.next(9, 1), Block: OpID{Client: 999, Clock: 9}, Target: OpID{Client: 999, Clock: 10}, Len: 1})
	if _, err := d.ReadOnlyProjection(view); !errors.Is(err, ErrReadOnlyProjection) {
		t.Fatalf("pending ops: %v", err)
	}
}

func TestReadOnlyProjectionBalancesLongTextAndPreservesFormatting(t *testing.T) {
	d := NewDoc()
	b := d.CreateBlock(3, Root, "A", "paragraph")
	d.InsertText(3, b.ID, 0, strings.Repeat("文", 12000))
	italic := "true"
	restoreTestMark(d, b.ID, 2999, 9001, "italic", &italic)
	view := d.View()
	projected, err := d.ReadOnlyProjection(view)
	if err != nil {
		t.Fatal(err)
	}
	var depth func(*charNode) int
	depth = func(n *charNode) int {
		m := 0
		for _, child := range append(append([]*charNode{}, n.left...), n.right...) {
			if d := depth(child); d > m {
				m = d
			}
		}
		return 1 + m
	}
	if got := depth(projected.blocks[b.ID].root); got > 20 {
		t.Fatalf("unbalanced projection depth: %d", got)
	}
	decoded, err := DecodeState(projected.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded.View(), view) {
		t.Fatal("formatting or text changed")
	}
	if path := os.Getenv("JIANGE_READONLY_LONG_VECTOR_PATH"); path != "" {
		vector := struct {
			State string  `json:"state"`
			View  DocView `json:"view"`
		}{base64.StdEncoding.EncodeToString(projected.EncodeState()), view}
		data, err := json.Marshal(vector)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReadOnlyProjectionLimitsWorkDepthAndOutputSize(t *testing.T) {
	t.Run("render work", func(t *testing.T) {
		d := NewDoc()
		b := d.CreateBlock(1, Root, "A", "paragraph")
		d.InsertText(1, b.ID, 0, strings.Repeat("x", 5000))
		// The guard must reject before View tries a 25-million comparison scan.
		d.blocks[b.ID].marks = make([]markRec, 5000)
		if _, err := d.ReadOnlyProjection(DocView{}); !errors.Is(err, ErrReadOnlyProjection) {
			t.Fatalf("work limit: %v", err)
		}
	})
	t.Run("block nesting", func(t *testing.T) {
		d := NewDoc()
		parent := Root
		for i := 0; i < readOnlyMaxDepth+1; i++ {
			parent = d.CreateBlock(1, parent, "A", "paragraph").ID
		}
		if _, err := d.ReadOnlyProjection(d.View()); !errors.Is(err, ErrReadOnlyProjection) {
			t.Fatalf("depth limit: %v", err)
		}
	})
	t.Run("snapshot bytes", func(t *testing.T) {
		d := NewDoc()
		b := d.CreateBlock(1, Root, "A", "paragraph")
		restoreTestProp(d, b.ID, "label", strings.Repeat("x", readOnlyMaxStateBytes))
		if _, err := d.ReadOnlyProjection(d.View()); !errors.Is(err, ErrReadOnlyProjection) {
			t.Fatalf("state size limit: %v", err)
		}
	})
}

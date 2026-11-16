package collab

import (
	"bytes"
	"testing"
)

// A prototype protocol proof only: this is not a server endpoint or UI feature.
func TestExperimentalColumnArchiveProjectionAndSnapshot(t *testing.T) {
	d := NewDoc()
	group := d.CreateBlock(1, Root, "A", "columns")
	column := d.CreateBlock(1, group.ID, "B", "paragraph")
	d.InsertText(1, column.ID, 0, "隐去原文")
	peer, err := DecodeState(d.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	late := peer.InsertText(2, column.ID, 4, "远端")
	archive := OpID{Client: 1, Clock: d.clock + 1}
	ops := []Op{
		{T: TBlockCreate, ID: archive, Parent: Root, Pos: "U", Type: "jiange-column-archive-v1"},
		{T: TBlockDelete, ID: OpID{Client: 1, Clock: archive.Clock + 1}, Block: archive},
		{T: TBlockMove, ID: OpID{Client: 1, Clock: archive.Clock + 2}, Block: column.ID, Parent: archive, Pos: "U"},
	}
	tx := d.BeginTryTransaction()
	for _, op := range ops {
		if err := tx.TryApply(op); err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
	}
	tx.Commit()
	if err := d.TryApply(late); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := d.VisibleBlockText(column.ID); ok {
		t.Fatal("archived column was visible")
	}
	view, err := d.ReadOnlyProjectionView()
	if err != nil {
		t.Fatal(err)
	}
	projection, err := d.ReadOnlyProjection(view)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(projection.EncodeState(), []byte("隐去原文")) || bytes.Contains(projection.EncodeState(), []byte("远端")) {
		t.Fatal("read-only projection leaked hidden content")
	}
	d.Compact()
	cold, err := DecodeState(d.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	if !cold.blocks[archive].deleted || cold.blocks[archive].props["type"].value != "jiange-column-archive-v1" {
		t.Fatal("archive tombstone lost on snapshot")
	}
	if got := cold.Text(column.ID); got != "隐去原文远端" {
		t.Fatalf("hidden text lost: %q", got)
	}
	restore := Op{T: TBlockMove, ID: cold.next(1, 1), Block: column.ID, Parent: group.ID, Pos: "B"}
	if err := cold.TryApply(restore); err != nil {
		t.Fatal(err)
	}
	if text, _, ok := cold.VisibleBlockText(column.ID); !ok || text != "隐去原文远端" {
		t.Fatalf("restored text %q, visible %v", text, ok)
	}
}

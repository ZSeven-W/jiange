package collab

import "testing"

func TestTryApplyRejectsPartialUnicodeClockOverlap(t *testing.T) {
	d := NewDoc()
	b := d.CreateBlock(1, Root, "V", "p")
	first := Op{T: TTextInsert, ID: OpID{2, 3}, Block: b.ID, Parent: Root, Side: 1, Text: "😀中"}
	if err := d.TryApply(first); err != nil {
		t.Fatal(err)
	}
	before := d.Text(b.ID)
	overlap := Op{T: TTextInsert, ID: OpID{2, 2}, Block: b.ID, Parent: Root, Side: 1, Text: "甲乙"}
	if err := d.TryApply(overlap); err == nil {
		t.Fatal("accepted overlap with an existing Unicode character")
	}
	if got := d.Text(b.ID); got != before {
		t.Fatalf("text changed from %q to %q", before, got)
	}
	loaded, err := DecodeState(d.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	if err := loaded.TryApply(overlap); err == nil {
		t.Fatal("snapshot accepted overlap")
	}
	if got := loaded.Text(b.ID); got != before {
		t.Fatalf("snapshot text changed to %q", got)
	}
	overflow := Op{T: TTextInsert, ID: OpID{2, 1<<53 - 1}, Block: b.ID, Parent: Root, Side: 1, Text: "甲乙"}
	if err := loaded.TryApply(overflow); err != ErrIdentityOverlap {
		t.Fatalf("unsafe clock span: %v", err)
	}
}

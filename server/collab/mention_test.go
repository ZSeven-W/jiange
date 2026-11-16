package collab

import "testing"

func TestMentionTargetUsesVisibleEffectiveMark(t *testing.T) {
	d := NewDoc()
	block := d.CreateBlock(4, Root, "V", "paragraph")
	insert := d.InsertText(4, block.ID, 0, "@小简 ")
	value := "12"
	mark := Op{T: TMark, ID: d.next(4, 1), Block: block.ID, Key: "mention", Value: &value, Start: Anchor{Char: insert.ID}, End: Anchor{Char: OpID{Client: insert.ID.Client, Clock: insert.ID.Clock + 2}, Side: 1}}
	if !d.Apply(mark) || d.MentionTarget(block.ID, mark.ID) != 12 {
		t.Fatal("visible mention not detected")
	}
	changed := "13"
	overlay := mark
	overlay.ID = d.next(5, 1)
	overlay.Value = &changed
	d.Apply(overlay)
	if d.MentionTarget(block.ID, mark.ID) != 0 || d.MentionTarget(block.ID, overlay.ID) != 13 {
		t.Fatal("overridden mention used")
	}
	d.DeleteText(4, block.ID, 0, 1)
	if d.MentionTarget(block.ID, overlay.ID) != 0 {
		t.Fatal("deleted @ still produced a mention")
	}
}

func TestMentionTargetRejectsHiddenAndInvalidMarks(t *testing.T) {
	d := NewDoc()
	parent := d.CreateBlock(4, Root, "V", "columns")
	block := d.CreateBlock(4, parent.ID, "V", "paragraph")
	insert := d.InsertText(4, block.ID, 0, "@人")
	value := "2"
	mark := Op{T: TMark, ID: d.next(4, 1), Block: block.ID, Key: "mention", Value: &value, Start: Anchor{Char: insert.ID}, End: Anchor{Char: OpID{Client: insert.ID.Client, Clock: insert.ID.Clock + 1}, Side: 1}}
	d.Apply(mark)
	if d.MentionTarget(block.ID, mark.ID) != 2 {
		t.Fatal("visible nested mention missing")
	}
	for _, bad := range []string{"0", "01", "-2", "9007199254740992"} {
		v := bad
		next := mark
		next.ID = d.next(4, 1)
		next.Value = &v
		d.Apply(next)
		if d.MentionTarget(block.ID, next.ID) != 0 {
			t.Fatalf("invalid recipient %s", bad)
		}
	}
	d.Apply(Op{T: TBlockDelete, ID: d.next(4, 1), Block: parent.ID})
	if d.MentionTarget(block.ID, mark.ID) != 0 {
		t.Fatal("hidden mention used")
	}
}

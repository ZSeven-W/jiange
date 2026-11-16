package collab

import (
	"strings"
	"testing"
)

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

func TestMentionTargetsHandlesLargeBatchWithoutLosingEntries(t *testing.T) {
	d := NewDoc()
	block := d.CreateBlock(4, Root, "V", "paragraph")
	insert := d.InsertText(4, block.ID, 0, strings.Repeat("@人 ", 150))
	value := "12"
	refs := make([]MentionRef, 0, 150)
	for i := 0; i < 150; i++ {
		start := OpID{Client: insert.ID.Client, Clock: insert.ID.Clock + uint64(3*i)}
		end := OpID{Client: start.Client, Clock: start.Clock + 1}
		mark := Op{T: TMark, ID: d.next(4, 1), Block: block.ID, Key: "mention", Value: &value, Start: Anchor{Char: start}, End: Anchor{Char: end, Side: 1}}
		d.Apply(mark)
		refs = append(refs, MentionRef{Block: block.ID, Mark: mark.ID})
	}
	matches := d.MentionTargets(refs)
	if len(matches) != len(refs) {
		t.Fatalf("only %d of %d mentions found", len(matches), len(refs))
	}
	for i, ref := range refs {
		want := OpID{Client: insert.ID.Client, Clock: insert.ID.Clock + uint64(3*i)}
		if got := matches[ref]; got.RecipientID != 12 || got.FirstChar != want {
			t.Fatalf("mention %d: %+v", i, got)
		}
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

func TestMentionTargetRejectsHiddenFormulaAndDocumentLink(t *testing.T) {
	for _, hiddenCase := range []struct{ key, value string }{{"math", "x^2"}, {"link", "#/doc/42"}, {"link", "#/s/token"}, {"link", "#/p/token"}} {
		t.Run(hiddenCase.value, func(t *testing.T) {
			d := NewDoc()
			block := d.CreateBlock(4, Root, "V", "paragraph")
			insert := d.InsertText(4, block.ID, 0, "@人")
			value := "2"
			mark := Op{T: TMark, ID: d.next(4, 1), Block: block.ID, Key: "mention", Value: &value, Start: Anchor{Char: insert.ID}, End: Anchor{Char: OpID{Client: insert.ID.Client, Clock: insert.ID.Clock + 1}, Side: 1}}
			d.Apply(mark)
			hidden := hiddenCase.value
			over := mark
			over.ID = d.next(4, 1)
			over.Key = hiddenCase.key
			over.Value = &hidden
			d.Apply(over)
			if d.MentionTarget(block.ID, mark.ID) != 0 {
				t.Fatal("invisible mention notified")
			}
			clear := over
			clear.ID = d.next(4, 1)
			clear.Value = nil
			d.Apply(clear)
			if d.MentionTarget(block.ID, mark.ID) != 2 {
				t.Fatal("visible mention not restored")
			}
		})
	}
}

func TestInvalidShareLinkDoesNotHideVisibleMention(t *testing.T) {
	d := NewDoc()
	block := d.CreateBlock(4, Root, "V", "paragraph")
	insert := d.InsertText(4, block.ID, 0, "@人")
	value := "2"
	mark := Op{T: TMark, ID: d.next(4, 1), Block: block.ID, Key: "mention", Value: &value, Start: Anchor{Char: insert.ID}, End: Anchor{Char: OpID{Client: insert.ID.Client, Clock: insert.ID.Clock + 1}, Side: 1}}
	d.Apply(mark)
	invalid := "#/s/token?invalid"
	over := mark
	over.ID = d.next(4, 1)
	over.Key = "link"
	over.Value = &invalid
	d.Apply(over)
	if d.MentionTarget(block.ID, mark.ID) != 2 {
		t.Fatal("invalid link hid visible mention")
	}
}

package collab

import (
	"strings"
	"testing"
)

func TestViewLongFormattedRunsRemainStable(t *testing.T) {
	d := NewDoc()
	block := d.CreateBlock(4, Root, "A", "paragraph")
	d.InsertText(4, block.ID, 0, strings.Repeat("甲", 2000)+strings.Repeat("乙", 2000)+"😀"+strings.Repeat("丙", 2000))
	bold, color := "true", "#3370ff"
	restoreTestMark(d, block.ID, 0, 2000, "bold", &bold)
	restoreTestMark(d, block.ID, 2000, 4000, "color", &color)
	d.DeleteText(4, block.ID, 100, 10)
	view := d.View()
	if len(view.Blocks) != 1 || len(view.Blocks[0].Spans) != 3 {
		t.Fatalf("unexpected runs: %+v", view.Blocks)
	}
	spans := view.Blocks[0].Spans
	if spans[0].Text != strings.Repeat("甲", 1990) || spans[0].Marks["bold"] != "true" {
		t.Fatal("bold run changed")
	}
	if spans[1].Text != strings.Repeat("乙", 2000) || spans[1].Marks["color"] != "#3370ff" {
		t.Fatal("color run changed")
	}
	if spans[2].Text != "😀"+strings.Repeat("丙", 2000) || len(spans[2].Marks) != 0 {
		t.Fatal("plain run changed")
	}
	old := spans[0].Text
	d.InsertText(4, block.ID, 0, "新")
	_ = d.View()
	if spans[0].Text != old {
		t.Fatal("an earlier materialized view changed after an edit")
	}
}

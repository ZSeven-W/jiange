package collab

import "testing"

func TestVisibleBlockTextAgreesWithView(t *testing.T) {
	for _, mode := range []string{"visible", "deleted", "hidden-parent", "cycle", "missing"} {
		t.Run(mode, func(t *testing.T) {
			d := NewDoc()
			parent := d.CreateBlock(2, Root, "V", "paragraph").ID
			child := d.CreateBlock(2, parent, "V", "title").ID
			d.InsertText(2, child, 0, "标题😀")
			switch mode {
			case "deleted":
				d.Apply(Op{T: TBlockDelete, ID: d.next(2, 1), Block: child})
			case "hidden-parent":
				d.Apply(Op{T: TBlockDelete, ID: d.next(2, 1), Block: parent})
			case "cycle":
				d.Apply(Op{T: TBlockMove, ID: d.next(2, 1), Block: parent, Parent: child, Pos: "V"})
			case "missing":
				child = OpID{Client: 99, Clock: 99}
			}
			want, kind, found := "", "", false
			for _, b := range d.View().Blocks {
				if b.ID == child.Key() {
					found = true
					kind = b.Type
					for _, s := range b.Spans {
						want += s.Text
					}
				}
			}
			got, gotKind, gotFound := d.VisibleBlockText(child)
			if got != want || gotKind != kind || gotFound != found {
				t.Fatalf("got %q %q %v; want %q %q %v", got, gotKind, gotFound, want, kind, found)
			}
		})
	}
}

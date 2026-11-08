package store

import "github.com/ZSeven-W/jiange/server/collab"

// InitialDocOps defines the common initial title and empty paragraph for all document creation paths.
func InitialDocOps(title string) []RawOp {
	d := collab.NewDoc()
	ops := []collab.Op{d.CreateBlock(0, collab.Root, "U", "title"), d.CreateBlock(0, collab.Root, "V", "paragraph")}
	if title != "" {
		ops = append(ops, d.InsertText(0, ops[0].ID, 0, title))
	}
	out := make([]RawOp, len(ops))
	for i, op := range ops {
		b, _ := collab.EncodeOps([]collab.Op{op})
		out[i] = RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b}
	}
	return out
}

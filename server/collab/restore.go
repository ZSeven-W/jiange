package collab

import (
	"strconv"
	"strings"
)

// RestoreOps generates the ops that transform cur into target, applied to cur
// as they are produced. Restoring never rewrites history: the ops are ordinary
// inserts/deletes/sets authored by `client`, so every replica converges and
// local undo stacks stay untouched. Marks are not restored (v0.1 limitation).
func RestoreOps(cur, target *Doc, client uint64) []Op {
	var ops []Op
	emit := func(op Op) { ops = append(ops, op) }

	tv := target.View()
	cv := cur.View()
	curBlocks := map[string]BlockView{}
	for _, b := range cv.Blocks {
		curBlocks[b.ID] = b
	}
	targetIDs := map[string]bool{}

	textOf := func(d *Doc, id string) string {
		bid, ok := parseID(id)
		if !ok {
			return ""
		}
		return d.Text(bid)
	}

	for _, tb := range tv.Blocks {
		targetIDs[tb.ID] = true
		bid, ok := parseID(tb.ID)
		if !ok {
			continue
		}
		cb, exists := curBlocks[tb.ID]
		if !exists {
			// recreate the block: it gets a fresh id, then retype text and props
			parent, _ := parseID(tb.Parent)
			created := cur.CreateBlock(client, parent, target.blocks[bid].pos, tb.Type)
			emit(created)
			if text := textOf(target, tb.ID); text != "" {
				emit(cur.InsertText(client, created.Block, 0, text))
			}
			for k, v := range tb.Props {
				val := v
				op := Op{T: TBlockSet, ID: cur.next(client, 1), Block: created.Block, Key: k, Value: &val}
				cur.Apply(op)
				emit(op)
			}
			continue
		}
		// existing block: align parent/pos, text and props
		if cb.Parent != tb.Parent || cur.blocks[bid].pos != target.blocks[bid].pos {
			parent, _ := parseID(tb.Parent)
			op := Op{T: TBlockMove, ID: cur.next(client, 1), Block: bid, Parent: parent, Pos: target.blocks[bid].pos}
			cur.Apply(op)
			emit(op)
		}
		if ct := textOf(cur, tb.ID); ct != textOf(target, tb.ID) {
			if n := len([]rune(ct)); n > 0 {
				for _, d := range cur.DeleteText(client, bid, 0, n) {
					emit(d)
				}
			}
			if text := textOf(target, tb.ID); text != "" {
				emit(cur.InsertText(client, bid, 0, text))
			}
		}
		for k, v := range tb.Props {
			if cb.Props[k] != v {
				val := v
				op := Op{T: TBlockSet, ID: cur.next(client, 1), Block: bid, Key: k, Value: &val}
				cur.Apply(op)
				emit(op)
			}
		}
	}
	// remove blocks that are not in the version, parents first
	for _, cb := range cv.Blocks {
		if targetIDs[cb.ID] {
			continue
		}
		bid, ok := parseID(cb.ID)
		if !ok {
			continue
		}
		op := Op{T: TBlockDelete, ID: cur.next(client, 1), Block: bid}
		cur.Apply(op)
		emit(op)
	}
	return ops
}

func parseID(s string) (OpID, bool) {
	c, clock, ok := strings.Cut(s, ":")
	if !ok {
		return OpID{}, false
	}
	client, err := strconv.ParseUint(c, 10, 64)
	if err != nil {
		return OpID{}, false
	}
	cl, err := strconv.ParseUint(clock, 10, 64)
	if err != nil {
		return OpID{}, false
	}
	return OpID{Client: client, Clock: cl}, true
}

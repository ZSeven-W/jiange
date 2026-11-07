package collab

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ErrRestoreUnrepresentable means the target's mark behavior cannot safely be
// expressed on an existing block without changing its collaborative history.
var ErrRestoreUnrepresentable = errors.New("collab: cannot safely restore mark anchors")

// RestoreOps generates ordinary ops to transform cur into target and applies
// them to cur. New blocks receive new IDs; their descendants must reference the
// new parent IDs. This helper does not serialize the API's read/append phase;
// callers must account for concurrent edits when persisting its result.
func RestoreOps(cur, target *Doc, client uint64) []Op {
	ops, err := RestoreOpsChecked(cur, target, client)
	if err != nil {
		panic(err)
	}
	return ops
}

// RestoreOpsChecked plans on an isolated clone. An unsupported target or
// inconsistent state returns an error and leaves cur unchanged.
func RestoreOpsChecked(cur, target *Doc, client uint64) ([]Op, error) {
	if cur == nil || target == nil || cur.Pending() != 0 || target.Pending() != 0 {
		return nil, fmt.Errorf("%w: unresolved operations", ErrRestoreUnrepresentable)
	}
	// View materializes each visible character against every mark. Refuse
	// pathological work before building either view or cloning the state.
	if err := checkRestoreComplexity(cur); err != nil {
		return nil, err
	}
	if err := checkRestoreComplexity(target); err != nil {
		return nil, err
	}
	working, err := DecodeState(cur.EncodeState())
	if err != nil {
		return nil, err
	}
	ops, err := restoreOps(working, target, client)
	if err != nil {
		return nil, err
	}
	if err := applyRestorePlan(cur, working, ops); err != nil {
		return nil, err
	}
	return ops, nil
}

func checkRestoreComplexity(doc *Doc) error {
	const maxWork = uint64(5_000_000)
	var total uint64
	for id, block := range doc.blocks {
		if id == Root || block.deleted || len(block.marks) == 0 || !visibleRestoreBlock(doc, id) {
			continue
		}
		var visible uint64
		for id, char := range block.chars {
			if id != Root && !char.deleted {
				visible++
			}
		}
		marks := uint64(len(block.marks))
		if visible > maxWork/marks || total > maxWork-visible*marks {
			return fmt.Errorf("%w: too many mark boundaries", ErrRestoreUnrepresentable)
		}
		total += visible * marks
	}
	return nil
}

// Match Doc.View's hidden-parent and cycle behavior without materializing the
// expensive text/mark projection merely to estimate its cost.
func visibleRestoreBlock(doc *Doc, id OpID) bool {
	visited := map[OpID]bool{}
	for id != Root {
		if visited[id] {
			return true
		} // cycles attach to root in View
		visited[id] = true
		block := doc.blocks[id]
		if block == nil || block.deleted {
			return false
		}
		id = block.parent
	}
	return true
}

// applyRestorePlan only publishes after all generated operations have been
// verified on the isolated clone. Doc is not safe for concurrent mutation;
// callers must still coordinate the read/append transaction externally.
func applyRestorePlan(cur, working *Doc, ops []Op) error {
	if working.Pending() != 0 {
		return fmt.Errorf("%w: generated operations have missing dependencies", ErrRestoreUnrepresentable)
	}
	// Snapshots do not retain every historical `seen` entry (for example a
	// zero-length insert), so the original can reject an ID accepted by the
	// clone. Detect this before publishing any part of the plan.
	for _, op := range ops {
		if cur.seen[op.ID] || cur.isStructuralDup(&op) {
			return fmt.Errorf("%w: generated operation ID conflicts with current history", ErrRestoreUnrepresentable)
		}
	}
	for _, op := range ops {
		cur.Apply(op)
	}
	return nil
}

func restoreOps(cur, target *Doc, client uint64) ([]Op, error) {
	var ops []Op
	emit := func(op Op) { ops = append(ops, op) }

	tv, cv := target.View(), cur.View()
	curBlocks := make(map[string]BlockView, len(cv.Blocks))
	for _, b := range cv.Blocks {
		curBlocks[b.ID] = b
	}
	positions := restorePositions(target, tv)
	// View walks ancestors before their children, including effective parents
	// after cycle resolution. Keep the original-to-current mapping for both
	// recreated blocks and existing blocks moved under a recreated parent.
	mapped := map[OpID]OpID{Root: Root}
	retained := map[OpID]bool{}
	for _, tb := range tv.Blocks {
		targetID, ok := parseID(tb.ID)
		if !ok {
			continue
		}
		targetParent, ok := parseID(tb.Parent)
		if !ok {
			continue
		}
		parent, ok := mapped[targetParent]
		if !ok {
			continue
		}
		cb, exists := curBlocks[tb.ID]
		bid := targetID
		if !exists {
			created := cur.CreateBlock(client, parent, positions[targetID], tb.Type)
			emit(created)
			bid = created.ID
		} else {
			retained[bid] = true
			if cur.blocks[bid].parent != parent || cur.blocks[bid].pos != positions[targetID] {
				op := Op{T: TBlockMove, ID: cur.next(client, 1), Block: bid, Parent: parent, Pos: positions[targetID]}
				cur.Apply(op)
				emit(op)
			}
			if cb.Type != tb.Type {
				value := tb.Type
				op := Op{T: TBlockSet, ID: cur.next(client, 1), Block: bid, Key: "type", Value: &value}
				cur.Apply(op)
				emit(op)
			}
		}
		mapped[targetID] = bid

		if !exists || len(cur.blocks[bid].chars) == 1 && len(cur.blocks[bid].marks) == 0 {
			// An untouched initial paragraph is an existing block ID but has no
			// text history. It can safely receive the complete source tree in
			// place, preserving hidden anchors when copying a document.
			if err := cloneRestoreText(cur, bid, target.blocks[targetID], client, emit); err != nil {
				return nil, err
			}
		} else {
			var text strings.Builder
			for _, span := range tb.Spans {
				text.WriteString(span.Text)
			}
			wantText := text.String()
			if have := cur.Text(bid); have != wantText {
				if n := len([]rune(have)); n > 0 {
					for _, op := range cur.DeleteText(client, bid, 0, n) {
						emit(op)
					}
				}
				if wantText != "" {
					emit(cur.InsertText(client, bid, 0, wantText))
				}
			}
			if err := restoreExistingMarks(cur, bid, target.blocks[targetID], client, emit); err != nil {
				return nil, err
			}
		}

		// Block properties have no deletion operation. Clear properties absent
		// from the target to their empty value; their keys remain in the CRDT.
		keys := map[string]bool{}
		for key := range tb.Props {
			keys[key] = true
		}
		if exists {
			for key := range cb.Props {
				keys[key] = true
			}
		}
		ordered := make([]string, 0, len(keys))
		for key := range keys {
			ordered = append(ordered, key)
		}
		sort.Strings(ordered)
		for _, key := range ordered {
			want, present := tb.Props[key]
			have, had := cb.Props[key]
			if (!exists && !present) || (exists && have == want && (had || !present)) {
				continue
			}
			value := want
			op := Op{T: TBlockSet, ID: cur.next(client, 1), Block: bid, Key: key, Value: &value}
			cur.Apply(op)
			emit(op)
		}
	}
	// Existing blocks absent from the target are tombstoned. A late edit to
	// such a block can therefore become hidden; callers must surface this
	// concurrency limitation rather than treating restore as lossless merge.
	for _, cb := range cv.Blocks {
		bid, ok := parseID(cb.ID)
		if !ok || retained[bid] {
			continue
		}
		op := Op{T: TBlockDelete, ID: cur.next(client, 1), Block: bid}
		cur.Apply(op)
		emit(op)
	}
	return ops, nil
}

// restorePositions preserves the target's sibling order even when positions
// tie and recreated IDs sort differently from the old IDs. Tied positions are
// also unusable as an insertion interval in clients, so give only those groups
// unique, fractional-index-compatible keys. Unexpected noncanonical keys fall
// back to a deterministic reindex of that parent's entire sibling group.
func restorePositions(target *Doc, view DocView) map[OpID]string {
	type entry struct {
		id  OpID
		pos string
	}
	groups := map[string][]entry{}
	positions := make(map[OpID]string, len(view.Blocks))
	for _, block := range view.Blocks {
		id, ok := parseID(block.ID)
		if !ok {
			continue
		}
		pos := target.blocks[id].pos
		positions[id] = pos
		groups[block.Parent] = append(groups[block.Parent], entry{id: id, pos: pos})
	}
	for _, siblings := range groups {
		tied := false
		valid := true
		for i, e := range siblings {
			if !validRestorePosition(e.pos) {
				valid = false
			}
			if i > 0 && siblings[i-1].pos == e.pos {
				tied = true
			}
		}
		if !tied {
			continue
		}
		if valid {
			for start := 0; start < len(siblings); {
				end := start + 1
				for end < len(siblings) && siblings[end].pos == siblings[start].pos {
					end++
				}
				if end-start > 1 {
					prefix := siblings[start].pos + "0"
					if end < len(siblings) && strings.HasPrefix(siblings[end].pos, siblings[start].pos) {
						suffix := strings.TrimPrefix(siblings[end].pos, siblings[start].pos)
						zeroes := 0
						for zeroes < len(suffix) && suffix[zeroes] == '0' {
							zeroes++
						}
						prefix = siblings[start].pos + strings.Repeat("0", zeroes+1)
					}
					if len(prefix) > 1024 {
						valid = false
						break
					}
					for i := start + 1; i < end; i++ {
						positions[siblings[i].id] = prefix + restoreRank(uint64(i-start))
					}
				}
				start = end
			}
		}
		if !valid {
			for i, e := range siblings {
				positions[e.id] = restoreRank(uint64(i + 1))
			}
		}
	}
	return positions
}

func validRestorePosition(pos string) bool {
	if pos == "" || pos[len(pos)-1] == '0' {
		return false
	}
	for _, c := range pos {
		if !strings.ContainsRune("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", c) {
			return false
		}
	}
	return true
}

func restoreRank(n uint64) string {
	const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	var out [12]byte
	for i := 10; i >= 0; i-- {
		out[i] = digits[n%62]
		n /= 62
	}
	out[11] = 'V' // fractional-index keys must not end in zero
	return string(out[:])
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

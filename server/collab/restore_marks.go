package collab

import (
	"fmt"
	"math"
	"reflect"
	"sort"
	"strings"
)

// cloneRestoreText copies the target's actual Fugue tree, including deleted
// characters used as mark anchors, into a newly created block. A linear right
// chain is encoded in one insert, preserving the usual document performance.
func cloneRestoreText(doc *Doc, bid OpID, source *block, client uint64, emit func(Op)) error {
	mapped := map[OpID]OpID{Root: Root}
	var deleted []OpID
	var clone func(*charNode, OpID) error
	clone = func(first *charNode, parent OpID) error {
		chain := []*charNode{first}
		for len(chain[len(chain)-1].right) == 1 {
			chain = append(chain, chain[len(chain)-1].right[0])
		}
		var text strings.Builder
		for _, n := range chain {
			text.WriteRune(n.ch)
		}
		op := Op{T: TTextInsert, ID: doc.next(client, uint64(len(chain))), Block: bid, Parent: parent, Side: first.side, Text: text.String()}
		doc.Apply(op)
		emit(op)
		for i, n := range chain {
			id := OpID{Client: op.ID.Client, Clock: op.ID.Clock + uint64(i)}
			mapped[n.id] = id
			if n.deleted {
				deleted = append(deleted, id)
			}
		}
		for i, n := range chain {
			id := mapped[n.id]
			for _, child := range n.left {
				if err := clone(child, id); err != nil {
					return err
				}
			}
			if i == len(chain)-1 {
				for _, child := range n.right {
					if err := clone(child, id); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}
	for _, child := range source.root.left {
		if err := clone(child, Root); err != nil {
			return err
		}
	}
	for _, child := range source.root.right {
		if err := clone(child, Root); err != nil {
			return err
		}
	}
	for i := 0; i < len(deleted); {
		j := i + 1
		for j < len(deleted) && deleted[j].Client == deleted[i].Client && deleted[j].Clock == deleted[j-1].Clock+1 {
			j++
		}
		op := Op{T: TTextDelete, ID: doc.next(client, 1), Block: bid, Target: deleted[i], Len: uint64(j - i)}
		doc.Apply(op)
		emit(op)
		i = j
	}
	marks := append([]markRec(nil), source.marks...)
	sort.Slice(marks, func(i, j int) bool { return marks[i].id.Cmp(marks[j].id) < 0 })
	for _, mark := range marks {
		start, okStart := mapped[mark.start.Char]
		end, okEnd := mapped[mark.end.Char]
		if !okStart || !okEnd {
			return fmt.Errorf("%w: missing source character", ErrRestoreUnrepresentable)
		}
		op := Op{T: TMark, ID: doc.next(client, 1), Block: bid, Key: mark.key, Value: mark.value,
			Start: Anchor{Char: start, Side: mark.start.Side}, End: Anchor{Char: end, Side: mark.end.Side}}
		doc.Apply(op)
		emit(op)
	}
	return nil
}

// restoreExistingMarks overlays the target's original mark history while
// preserving its anchor sides. Unmappable deleted anchors are rejected rather
// than guessed; the caller runs this on a disposable clone.
func restoreExistingMarks(doc *Doc, bid OpID, source *block, client uint64, emit func(Op)) error {
	dest := doc.blocks[bid]
	// Equal visible spans or even one-step insertion results do not prove that
	// old hidden marks have no effect on later edits. Skip only if there is no
	// mark history, or the character trees and mark histories are isomorphic;
	// otherwise neutralize old marks before replaying the target.
	if len(source.marks) == 0 && len(dest.marks) == 0 || sameRestoreMarkState(source, dest) {
		return nil
	}
	// Root/side 1 has a dynamic position tied to the first physical node.
	// On differing histories it cannot be remapped safely for all future edits.
	for _, block := range []*block{source, dest} {
		for _, mark := range block.marks {
			if (mark.start.Char == Root && mark.start.Side == 1) || (mark.end.Char == Root && mark.end.Side == 1) {
				return fmt.Errorf("%w: dynamic root mark anchor", ErrRestoreUnrepresentable)
			}
		}
	}
	want := source.fullOrder()
	visible := doc.visible(dest)
	mapped := map[OpID]OpID{Root: Root}
	index := 0
	for _, node := range want {
		if node.deleted {
			continue
		}
		if index >= len(visible) || node.ch != visible[index].ch {
			return fmt.Errorf("%w: text differs", ErrRestoreUnrepresentable)
		}
		mapped[node.id] = visible[index].id
		index++
	}
	if index != len(visible) {
		return fmt.Errorf("%w: text differs", ErrRestoreUnrepresentable)
	}
	for _, mark := range source.marks {
		if _, ok := mapped[mark.start.Char]; !ok {
			return fmt.Errorf("%w: deleted start anchor", ErrRestoreUnrepresentable)
		}
		if _, ok := mapped[mark.end.Char]; !ok {
			return fmt.Errorf("%w: deleted end anchor", ErrRestoreUnrepresentable)
		}
	}
	// A prior restore can have already overlaid the exact source history and
	// neutralized every older mark. Recognize that form so repeated restores
	// do not append redundant operations.
	if canonicalRestoreOverlay(source, dest, mapped) {
		same, err := equivalentRestoreMarks(source, dest)
		if err != nil {
			return err
		}
		if same {
			return nil
		}
	}
	keys := map[string]bool{}
	for _, mark := range dest.marks {
		keys[mark.key] = true
	}
	ordered := make([]string, 0, len(keys))
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	order := dest.fullOrder()
	if len(ordered) > 0 && len(order) == 0 {
		return fmt.Errorf("%w: empty block has mark history", ErrRestoreUnrepresentable)
	}
	for _, key := range ordered {
		op := Op{T: TMark, ID: doc.next(client, 1), Block: bid, Key: key, Value: nil,
			Start: Anchor{Char: order[0].id, Side: 0}, End: Anchor{Char: Root, Side: 0}}
		doc.Apply(op)
		emit(op)
	}
	marks := append([]markRec(nil), source.marks...)
	sort.Slice(marks, func(i, j int) bool { return marks[i].id.Cmp(marks[j].id) < 0 })
	for _, mark := range marks {
		op := Op{T: TMark, ID: doc.next(client, 1), Block: bid, Key: mark.key, Value: mark.value,
			Start: Anchor{Char: mapped[mark.start.Char], Side: mark.start.Side}, End: Anchor{Char: mapped[mark.end.Char], Side: mark.end.Side}}
		doc.Apply(op)
		emit(op)
	}
	same, err := equivalentRestoreMarks(source, dest)
	if err != nil {
		return err
	}
	if !same {
		return fmt.Errorf("%w: insertion behavior differs", ErrRestoreUnrepresentable)
	}
	return nil
}

func canonicalRestoreOverlay(source, dest *block, mapped map[OpID]OpID) bool {
	want := append([]markRec(nil), source.marks...)
	have := append([]markRec(nil), dest.marks...)
	sort.Slice(want, func(i, j int) bool { return want[i].id.Cmp(want[j].id) < 0 })
	sort.Slice(have, func(i, j int) bool { return have[i].id.Cmp(have[j].id) < 0 })
	if len(have) < len(want) {
		return false
	}
	boundary := len(have) - len(want)
	for i, src := range want {
		dst := have[boundary+i]
		start, okStart := mapped[src.start.Char]
		end, okEnd := mapped[src.end.Char]
		if !okStart || !okEnd || src.key != dst.key || !reflect.DeepEqual(src.value, dst.value) ||
			dst.start != (Anchor{Char: start, Side: src.start.Side}) || dst.end != (Anchor{Char: end, Side: src.end.Side}) {
			return false
		}
	}
	index := map[OpID]int{}
	for i, node := range dest.fullOrder() {
		index[node.id] = i
	}
	byKey := map[string][]markRec{}
	for _, mark := range have[:boundary] {
		byKey[mark.key] = append(byKey[mark.key], mark)
	}
	for _, history := range byKey {
		clear := history[len(history)-1]
		if clear.value != nil || clear.start.Char == Root || clear.start.Side != 0 || clear.end != (Anchor{Char: Root, Side: 0}) {
			return false
		}
		first, ok := index[clear.start.Char]
		if !ok {
			return false
		}
		for _, mark := range history[:len(history)-1] {
			if mark.start.Char == Root {
				if mark.start.Side == 1 {
					return false
				}
				continue // Root/side 0 is the end sentinel and cannot start a range.
			}
			pos, ok := index[mark.start.Char]
			if !ok || pos < first {
				return false
			}
		}
	}
	return true
}

func sameRestoreMarkState(a, b *block) bool {
	ao, bo := a.fullOrder(), b.fullOrder()
	if len(ao) != len(bo) || len(a.marks) != len(b.marks) {
		return false
	}
	mapped := map[OpID]OpID{Root: Root}
	for i := range ao {
		x, y := ao[i], bo[i]
		if x.ch != y.ch || x.deleted != y.deleted || x.side != y.side {
			return false
		}
		mapped[x.id] = y.id
	}
	for i := range ao {
		if mapped[ao[i].parent.id] != bo[i].parent.id {
			return false
		}
	}
	am, bm := append([]markRec(nil), a.marks...), append([]markRec(nil), b.marks...)
	sort.Slice(am, func(i, j int) bool { return am[i].id.Cmp(am[j].id) < 0 })
	sort.Slice(bm, func(i, j int) bool { return bm[i].id.Cmp(bm[j].id) < 0 })
	for i, x := range am {
		y := bm[i]
		start, okStart := mapped[x.start.Char]
		end, okEnd := mapped[x.end.Char]
		if !okStart || !okEnd || x.key != y.key || !reflect.DeepEqual(x.value, y.value) ||
			y.start != (Anchor{Char: start, Side: x.start.Side}) || y.end != (Anchor{Char: end, Side: x.end.Side}) {
			return false
		}
	}
	return true
}

// The visible output and formatting inherited by a future insertion at each
// visible boundary must match. This catches side/expansion differences even
// when the currently rendered spans happen to be identical.
func equivalentRestoreMarks(a, b *block) (bool, error) {
	if !reflect.DeepEqual(a.view(a.parent).Spans, b.view(b.parent).Spans) {
		return false, nil
	}
	if len(a.marks) == 0 && len(b.marks) == 0 {
		return true, nil
	}
	ea, err := newRestoreMarkEvaluator(a)
	if err != nil {
		return false, err
	}
	eb, err := newRestoreMarkEvaluator(b)
	if err != nil {
		return false, err
	}
	if len(ea.visible) != len(eb.visible) {
		return false, nil
	}
	// Avoid unbounded synchronous work on pathological documents. A refusal
	// preserves the document; it never substitutes approximate formatting.
	if uint64(len(ea.visible)+1)*uint64(len(a.marks)+len(b.marks)) > 5_000_000 {
		return false, fmt.Errorf("%w: too many mark boundaries", ErrRestoreUnrepresentable)
	}
	for i := 0; i <= len(ea.visible); i++ {
		if !reflect.DeepEqual(ea.at(i), eb.at(i)) {
			return false, nil
		}
	}
	return true, nil
}

type restoreMarkEvaluator struct {
	block   *block
	order   []*charNode
	visible []*charNode
	index   map[OpID]int
}

func newRestoreMarkEvaluator(b *block) (*restoreMarkEvaluator, error) {
	e := &restoreMarkEvaluator{block: b, order: b.fullOrder(), visible: []*charNode{}, index: map[OpID]int{}}
	for i, n := range e.order {
		e.index[n.id] = i
		if !n.deleted {
			e.visible = append(e.visible, n)
		}
	}
	for _, m := range b.marks {
		if m.start.Char != Root {
			if _, ok := e.index[m.start.Char]; !ok {
				return nil, fmt.Errorf("%w: missing start anchor", ErrRestoreUnrepresentable)
			}
		}
		if m.end.Char != Root {
			if _, ok := e.index[m.end.Char]; !ok {
				return nil, fmt.Errorf("%w: missing end anchor", ErrRestoreUnrepresentable)
			}
		}
	}
	return e, nil
}
func (e *restoreMarkEvaluator) at(visibleOffset int) map[string]string {
	insert := 0
	if visibleOffset > 0 {
		insert = e.index[e.visible[visibleOffset-1].id] + 1
	} else if len(e.block.root.right) == 0 {
		insert = len(e.order)
	}
	slot := func(a Anchor) int {
		if a.Char == Root && a.Side == 0 {
			return math.MaxInt
		}
		i := 0
		if a.Char != Root {
			i = e.index[a.Char]
			if i >= insert {
				i++
			}
		}
		if a.Side == 1 {
			return 4*i + 2
		}
		return 4 * i
	}
	position := 4*insert + 1
	best := map[string]markRec{}
	for _, mark := range e.block.marks {
		if slot(mark.start) < position && position < slot(mark.end) {
			if prev, ok := best[mark.key]; !ok || mark.id.Cmp(prev.id) > 0 {
				best[mark.key] = mark
			}
		}
	}
	out := map[string]string{}
	for key, mark := range best {
		if mark.value != nil {
			out[key] = *mark.value
		}
	}
	return out
}

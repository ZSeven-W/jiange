package collab

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"unicode/utf8"
)

// ErrReadOnlyProjection means a materialized view cannot be represented as a
// bounded read-only state without guessing at block or character identities.
var ErrReadOnlyProjection = errors.New("collab: unsafe read-only projection")

const readOnlyMaxBlocks = 10000
const readOnlyMaxChars = 200000
const readOnlyMaxMarks = 100000
const readOnlyMaxSourceChars = 400000
const readOnlyMaxViewWork = 20000000
const readOnlyMaxDepth = 512
const readOnlyMaxStateBytes = 8 << 20
const readOnlyMaxInteger = uint64(1<<53 - 1)

// ReadOnlyProjectionView bounds materialization before a caller sanitizes it.
// Calling View first would bypass the projection's work limits on large or
// malformed documents. The returned view still requires access filtering.
func (d *Doc) ReadOnlyProjectionView() (DocView, error) {
	if d == nil || d.Pending() != 0 || d.HasTables() || len(d.blocks) > readOnlyMaxBlocks+1 {
		return DocView{}, ErrReadOnlyProjection
	}
	var sourceChars, sourceMarks, sourceWork uint64
	for _, block := range d.blocks {
		if block == nil || len(block.chars) == 0 || block.id.Client > readOnlyMaxInteger || block.id.Clock > readOnlyMaxInteger {
			return DocView{}, ErrReadOnlyProjection
		}
		sourceChars += uint64(len(block.chars) - 1)
		sourceMarks += uint64(len(block.marks))
		sourceWork += uint64(len(block.chars)-1) * uint64(len(block.marks))
		if sourceChars > readOnlyMaxSourceChars || sourceMarks > readOnlyMaxMarks || sourceWork > readOnlyMaxViewWork {
			return DocView{}, ErrReadOnlyProjection
		}
		for id := range block.chars {
			if id.Client > readOnlyMaxInteger || id.Clock > readOnlyMaxInteger {
				return DocView{}, ErrReadOnlyProjection
			}
		}
	}
	return d.View(), nil
}

// ReadOnlyProjection constructs a fresh snapshot from an already-authorized
// and sanitized view. It keeps IDs of visible blocks and characters, allowing
// comment and selection anchors to resolve, but drops deleted characters,
// hidden blocks, old marks, and every property omitted by the caller.
//
// The caller MUST sanitize props and mark values before calling this method;
// their values are not an access policy. A projection is NOT a CRDT replica:
// historical operations and local writes must never be applied to it. Live
// readers need complete replacement projections and explicit protocol mode
// changes when their permissions change. The original document is untouched.
func (d *Doc) ReadOnlyProjection(view DocView) (*Doc, error) {
	if len(view.Blocks) > readOnlyMaxBlocks {
		return nil, ErrReadOnlyProjection
	}
	original, err := d.ReadOnlyProjectionView()
	if err != nil {
		return nil, err
	}
	usedClients := map[uint64]bool{0: true}
	usedIDs := map[OpID]bool{Root: true}
	visibleChars := 0
	for _, block := range d.blocks {
		usedClients[block.id.Client] = true
		for id := range block.chars {
			usedClients[id.Client] = true
		}
	}
	if len(original.Blocks) != len(view.Blocks) {
		return nil, ErrReadOnlyProjection
	}
	// Synthetic mark identities cannot collide with any source client. They
	// are local to this read-only snapshot and never appear in writes.
	markClient := readOnlyMaxInteger
	for usedClients[markClient] {
		if markClient == 1 {
			return nil, ErrReadOnlyProjection
		}
		markClient--
	}
	out := NewDoc()
	depths := map[OpID]int{Root: 0}
	var markClock uint64
	var projectedWork uint64
	for i, sourceView := range original.Blocks {
		visible := view.Blocks[i]
		if visible.ID != sourceView.ID || visible.Parent != sourceView.Parent || visible.Type != sourceView.Type || visible.Props == nil {
			return nil, ErrReadOnlyProjection
		}
		id, ok := projectionID(visible.ID)
		if !ok || id == Root || usedIDs[id] {
			return nil, ErrReadOnlyProjection
		}
		usedIDs[id] = true
		parent, ok := projectionID(visible.Parent)
		if !ok || out.blocks[parent] == nil {
			return nil, ErrReadOnlyProjection
		}
		depths[id] = depths[parent] + 1
		if depths[id] > readOnlyMaxDepth {
			return nil, ErrReadOnlyProjection
		}
		source := d.blocks[id]
		if source == nil {
			return nil, ErrReadOnlyProjection
		}
		projected := newBlock(id, parent, source.pos)
		projected.props["type"] = propReg{value: visible.Type, ts: id}
		for key, value := range visible.Props {
			if key == "type" {
				return nil, ErrReadOnlyProjection
			}
			projected.props[key] = propReg{value: value, ts: id}
		}
		var nodes []*charNode
		for _, node := range source.fullOrder() {
			if !node.deleted {
				nodes = append(nodes, node)
			}
		}
		var originalText, visibleText strings.Builder
		for _, node := range nodes {
			originalText.WriteRune(node.ch)
		}
		for _, span := range visible.Spans {
			visibleText.WriteString(span.Text)
		}
		// A sanitizer may omit all text from a block, such as old text left
		// behind by converting a paragraph into a table. Partial rewriting
		// would make original character IDs ambiguous and is rejected.
		if visibleText.String() != originalText.String() {
			if visibleText.Len() != 0 {
				return nil, ErrReadOnlyProjection
			}
			nodes = nil
		}
		visibleChars += len(nodes)
		if visibleChars > readOnlyMaxChars {
			return nil, ErrReadOnlyProjection
		}
		clones := make([]*charNode, len(nodes))
		for j, node := range nodes {
			if node.id == Root || usedIDs[node.id] {
				return nil, ErrReadOnlyProjection
			}
			usedIDs[node.id] = true
			clones[j] = &charNode{id: node.id, ch: node.ch}
			projected.chars[node.id] = clones[j]
		}
		// A balanced tree retains the exact visible order with logarithmic
		// ancestry, avoiding a browser stack overflow on long paragraphs.
		var attach func(int, int, *charNode, uint8)
		attach = func(lo, hi int, parent *charNode, side uint8) {
			if lo >= hi {
				return
			}
			mid := lo + (hi-lo)/2
			node := clones[mid]
			node.parent, node.side = parent, side
			if side == 0 {
				parent.left = append(parent.left, node)
			} else {
				parent.right = append(parent.right, node)
			}
			attach(lo, mid, node, 0)
			attach(mid+1, hi, node, 1)
		}
		attach(0, len(clones), projected.root, 1)
		at := 0
		for _, span := range visible.Spans {
			size := len([]rune(span.Text))
			if size == 0 {
				continue
			}
			if at+size > len(clones) {
				return nil, ErrReadOnlyProjection
			}
			keys := make([]string, 0, len(span.Marks))
			for key := range span.Marks {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				markClock++
				if markClock > readOnlyMaxMarks {
					return nil, ErrReadOnlyProjection
				}
				value := span.Marks[key]
				projected.marks = append(projected.marks, markRec{id: OpID{Client: markClient, Clock: markClock}, key: key, value: &value, start: Anchor{Char: clones[at].id, Side: 0}, end: Anchor{Char: clones[at+size-1].id, Side: 1}})
			}
			at += size
		}
		if at != len(clones) {
			return nil, ErrReadOnlyProjection
		}
		projectedWork += uint64(len(clones)) * uint64(len(projected.marks))
		if projectedWork > readOnlyMaxViewWork {
			return nil, ErrReadOnlyProjection
		}
		out.blocks[id] = projected
	}
	out.clock = d.clock
	if markClock > out.clock {
		out.clock = markClock
	}
	if out.clock > readOnlyMaxInteger {
		return nil, ErrReadOnlyProjection
	}
	if !sameProjectionView(out.View(), view) {
		return nil, fmt.Errorf("%w: output does not match sanitized view", ErrReadOnlyProjection)
	}
	if len(out.EncodeState()) > readOnlyMaxStateBytes {
		return nil, ErrReadOnlyProjection
	}
	return out, nil
}

func projectionID(s string) (OpID, bool) {
	var id OpID
	if _, err := fmt.Sscanf(s, "%d:%d", &id.Client, &id.Clock); err != nil || id.Client > readOnlyMaxInteger || id.Clock > readOnlyMaxInteger || id.Key() != s {
		return OpID{}, false
	}
	return id, true
}

func sameProjectionView(a, b DocView) bool {
	if len(a.Blocks) != len(b.Blocks) {
		return false
	}
	for i, x := range a.Blocks {
		y := b.Blocks[i]
		if x.ID != y.ID || x.Parent != y.Parent || x.Type != y.Type || !reflect.DeepEqual(x.Props, y.Props) {
			return false
		}
		if !sameProjectionSpans(x.Spans, y.Spans) {
			return false
		}
	}
	return true
}

// Compare visible characters and formatting without allocating two arrays
// proportional to the entire paragraph. Span boundaries may differ after
// sanitization, so compare the underlying runes and marks rather than spans.
func sameProjectionSpans(a, b []Span) bool {
	type cursor struct {
		spans         []Span
		index, offset int
	}
	next := func(c *cursor) (rune, map[string]string, bool) {
		for c.index < len(c.spans) {
			span := c.spans[c.index]
			if c.offset >= len(span.Text) {
				c.index++
				c.offset = 0
				continue
			}
			r, size := utf8.DecodeRuneInString(span.Text[c.offset:])
			c.offset += size
			return r, span.Marks, true
		}
		return 0, nil, false
	}
	x, y := cursor{spans: a}, cursor{spans: b}
	for {
		left, lm, lok := next(&x)
		right, rm, rok := next(&y)
		if lok != rok {
			return false
		}
		if !lok {
			return true
		}
		if left != right || !mapsEqual(lm, rm) {
			return false
		}
	}
}

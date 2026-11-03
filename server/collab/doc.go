package collab

import (
	"math"
	"sort"
)

type charNode struct {
	id          OpID
	ch          rune
	deleted     bool
	parent      *charNode
	side        uint8
	left, right []*charNode
}

type markRec struct {
	id         OpID
	key        string
	value      *string
	start, end Anchor
}

type propReg struct {
	value string
	ts    OpID
}

type block struct {
	id      OpID
	parent  OpID
	pos     string
	locTS   OpID
	props   map[string]propReg
	deleted bool
	root    *charNode
	chars   map[OpID]*charNode
	marks   []markRec
	order   []*charNode
}

func newBlock(id, parent OpID, pos string) *block {
	root := &charNode{id: Root, deleted: true, side: 1}
	return &block{id: id, parent: parent, pos: pos, locTS: id, props: map[string]propReg{}, root: root, chars: map[OpID]*charNode{Root: root}}
}

func insertSorted(arr []*charNode, n *charNode) []*charNode {
	i := sort.Search(len(arr), func(i int) bool { return arr[i].id.Cmp(n.id) >= 0 })
	arr = append(arr, nil)
	copy(arr[i+1:], arr[i:])
	arr[i] = n
	return arr
}

// Doc is a replica of a Jiange document. The server uses it to validate ops
// and to materialize snapshots. It is not safe for concurrent use.
type Doc struct {
	clock   uint64
	blocks  map[OpID]*block
	seen    map[OpID]bool
	pending []Op
}

func NewDoc() *Doc {
	return &Doc{blocks: map[OpID]*block{Root: newBlock(Root, Root, "")}, seen: map[OpID]bool{}}
}

// Clock returns the highest Lamport clock observed.
func (d *Doc) Clock() uint64 { return d.clock }

// Pending returns the number of buffered ops waiting for dependencies.
func (d *Doc) Pending() int { return len(d.pending) }

// Apply integrates an op (idempotent, order-independent). Returns false for duplicates.
func (d *Doc) Apply(op Op) bool {
	if d.seen[op.ID] {
		return false
	}
	for _, p := range d.pending {
		if p.ID == op.ID {
			return false
		}
	}
	if !d.ready(&op) {
		d.pending = append(d.pending, op)
		return true
	}
	d.integrate(&op)
	for progress := true; progress && len(d.pending) > 0; {
		progress = false
		for i := 0; i < len(d.pending); i++ {
			p := d.pending[i]
			if d.ready(&p) {
				d.pending = append(d.pending[:i], d.pending[i+1:]...)
				d.integrate(&p)
				progress = true
				i--
			}
		}
	}
	return true
}

func (d *Doc) ready(op *Op) bool {
	if op.T == TBlockCreate {
		return true
	}
	b := d.blocks[op.Block]
	if b == nil {
		return false
	}
	switch op.T {
	case TTextInsert:
		return b.chars[op.Parent] != nil
	case TTextDelete:
		for i := uint64(0); i < op.Len; i++ {
			if b.chars[OpID{op.Target.Client, op.Target.Clock + i}] == nil {
				return false
			}
		}
	case TMark:
		return b.chars[op.Start.Char] != nil && b.chars[op.End.Char] != nil
	}
	return true
}

func (d *Doc) integrate(op *Op) {
	d.seen[op.ID] = true
	if sp := op.Span(); sp > 0 && op.ID.Clock+sp-1 > d.clock {
		d.clock = op.ID.Clock + sp - 1
	}
	switch op.T {
	case TBlockCreate:
		if d.blocks[op.ID] != nil {
			return
		}
		b := newBlock(op.ID, op.Parent, op.Pos)
		b.props["type"] = propReg{op.Type, op.ID}
		d.blocks[op.ID] = b
	case TBlockMove:
		b := d.blocks[op.Block]
		if op.ID.Cmp(b.locTS) > 0 {
			b.parent, b.pos, b.locTS = op.Parent, op.Pos, op.ID
		}
	case TBlockSet:
		b := d.blocks[op.Block]
		if cur, ok := b.props[op.Key]; !ok || op.ID.Cmp(cur.ts) > 0 {
			b.props[op.Key] = propReg{*op.Value, op.ID}
		}
	case TBlockDelete:
		d.blocks[op.Block].deleted = true
	case TTextInsert:
		b := d.blocks[op.Block]
		if b.chars[op.ID] != nil {
			return
		}
		parent, side := b.chars[op.Parent], op.Side
		i := uint64(0)
		for _, ch := range op.Text {
			n := &charNode{id: OpID{op.ID.Client, op.ID.Clock + i}, ch: ch, parent: parent, side: side}
			if side == 0 {
				parent.left = insertSorted(parent.left, n)
			} else {
				parent.right = insertSorted(parent.right, n)
			}
			b.chars[n.id] = n
			parent, side = n, 1
			i++
		}
		b.order = nil
	case TTextDelete:
		b := d.blocks[op.Block]
		for i := uint64(0); i < op.Len; i++ {
			b.chars[OpID{op.Target.Client, op.Target.Clock + i}].deleted = true
		}
		b.order = nil
	case TMark:
		b := d.blocks[op.Block]
		for _, m := range b.marks {
			if m.id == op.ID {
				return
			}
		}
		b.marks = append(b.marks, markRec{op.ID, op.Key, op.Value, op.Start, op.End})
	}
}

func (b *block) fullOrder() []*charNode {
	if b.order != nil {
		return b.order
	}
	out := make([]*charNode, 0, len(b.chars))
	var walk func(n *charNode)
	walk = func(n *charNode) {
		for _, c := range n.left {
			walk(c)
		}
		if n != b.root {
			out = append(out, n)
		}
		for _, c := range n.right {
			walk(c)
		}
	}
	walk(b.root)
	b.order = out
	return out
}

// Span is a run of text sharing the same marks.
type Span struct {
	Text  string            `json:"text"`
	Marks map[string]string `json:"marks"`
}

type BlockView struct {
	ID     string            `json:"id"`
	Parent string            `json:"parent"`
	Type   string            `json:"type"`
	Props  map[string]string `json:"props"`
	Spans  []Span            `json:"spans"`
}

type DocView struct {
	Blocks []BlockView `json:"blocks"`
}

// View returns the deterministic materialized document (same as TS Doc.view()).
func (d *Doc) View() DocView {
	eff := map[OpID]*OpID{} // nil = hidden
	resolve := func(id OpID) *OpID {
		if r, ok := eff[id]; ok {
			return r
		}
		b := d.blocks[id]
		visited := map[OpID]bool{id: true}
		cur := b.parent
		res := new(OpID)
		*res = b.parent
		for cur != Root {
			if visited[cur] {
				*res = Root
				break
			}
			visited[cur] = true
			pb := d.blocks[cur]
			if pb == nil || pb.deleted {
				res = nil
				break
			}
			cur = pb.parent
		}
		eff[id] = res
		return res
	}
	kids := map[OpID][]*block{}
	for id, b := range d.blocks {
		if id == Root || b.deleted {
			continue
		}
		if p := resolve(id); p != nil {
			kids[*p] = append(kids[*p], b)
		}
	}
	for _, arr := range kids {
		sort.Slice(arr, func(i, j int) bool {
			if arr[i].pos != arr[j].pos {
				return arr[i].pos < arr[j].pos
			}
			return arr[i].id.Cmp(arr[j].id) < 0
		})
	}
	out := DocView{Blocks: []BlockView{}}
	var walk func(p OpID)
	walk = func(p OpID) {
		for _, b := range kids[p] {
			out.Blocks = append(out.Blocks, b.view(p))
			walk(b.id)
		}
	}
	walk(Root)
	return out
}

func (b *block) view(parent OpID) BlockView {
	props := map[string]string{}
	for k, v := range b.props {
		if k != "type" {
			props[k] = v.value
		}
	}
	ord := b.fullOrder()
	idx := make(map[OpID]int, len(ord))
	for i, c := range ord {
		idx[c.id] = i
	}
	slot := func(a Anchor) int {
		if a.Side == 0 && a.Char == Root {
			return math.MaxInt // END sentinel: mark extends to the end of the block
		}
		s := idx[a.Char] * 4
		if a.Side == 1 {
			s += 2
		}
		return s
	}
	marks := append([]markRec(nil), b.marks...)
	sort.Slice(marks, func(i, j int) bool { return marks[i].id.Cmp(marks[j].id) < 0 })
	type ms struct {
		m    markRec
		s, e int
	}
	resolved := make([]ms, len(marks))
	for i, m := range marks {
		resolved[i] = ms{m, slot(m.start), slot(m.end)}
	}
	spans := []Span{}
	var last map[string]string
	for i, c := range ord {
		if c.deleted {
			continue
		}
		p := i*4 + 1
		cur := map[string]*string{}
		for _, r := range resolved {
			if r.s < p && p < r.e {
				cur[r.m.key] = r.m.value
			}
		}
		mk := map[string]string{}
		for k, v := range cur {
			if v != nil {
				mk[k] = *v
			}
		}
		if len(spans) > 0 && mapsEqual(last, mk) {
			spans[len(spans)-1].Text += string(c.ch)
		} else {
			spans = append(spans, Span{Text: string(c.ch), Marks: mk})
			last = mk
		}
	}
	return BlockView{ID: b.id.Key(), Parent: parent.Key(), Type: b.props["type"].value, Props: props, Spans: spans}
}

func mapsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if bv, ok := b[k]; !ok || bv != v {
			return false
		}
	}
	return true
}

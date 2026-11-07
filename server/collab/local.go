package collab

// Local editing helpers (mirror of the TS Doc local API) for server-side
// writers and tests. Each returns the generated op(s), already applied.

func (d *Doc) next(client uint64, span uint64) OpID {
	id := OpID{client, d.clock + 1}
	d.clock += span
	return id
}

func (d *Doc) visible(b *block) []*charNode {
	var out []*charNode
	for _, c := range b.fullOrder() {
		if !c.deleted {
			out = append(out, c)
		}
	}
	return out
}

// Text returns the visible text of a block.
func (d *Doc) Text(block OpID) string {
	b := d.blocks[block]
	if b == nil {
		return ""
	}
	rs := []rune{}
	for _, c := range d.visible(b) {
		rs = append(rs, c.ch)
	}
	return string(rs)
}

// VisibleBlockText reads one visible block without materializing rich-text
// marks throughout the document. It follows View's deleted-parent and cycle
// handling; cycles are displayed at the root.
func (d *Doc) VisibleBlockText(id OpID) (string, string, bool) {
	b := d.blocks[id]
	if b == nil || b.deleted || id == Root {
		return "", "", false
	}
	seen := map[OpID]bool{id: true}
	for parent := b.parent; parent != Root; {
		if seen[parent] {
			break
		}
		seen[parent] = true
		p := d.blocks[parent]
		if p == nil || p.deleted {
			return "", "", false
		}
		parent = p.parent
	}
	return d.Text(id), b.props["type"].value, true
}

// InsertText inserts text at a visible index of block as `client`.
func (d *Doc) InsertText(client uint64, block OpID, index int, text string) Op {
	b := d.blocks[block]
	vis := d.visible(b)
	L := b.root
	if index > 0 {
		L = vis[index-1]
	}
	parent, side := L.id, uint8(1)
	if len(L.right) > 0 {
		ord := b.fullOrder()
		li := -1
		for i, c := range ord {
			if c == L {
				li = i
			}
		}
		parent, side = ord[li+1].id, 0
	}
	op := Op{T: TTextInsert, ID: d.next(client, uint64(len([]rune(text)))), Block: block, Parent: parent, Side: side, Text: text}
	d.Apply(op)
	return op
}

// DeleteText deletes n visible chars from index (one op per id run).
func (d *Doc) DeleteText(client uint64, block OpID, index, n int) []Op {
	b := d.blocks[block]
	vis := d.visible(b)
	if index+n > len(vis) {
		n = len(vis) - index
	}
	vis = vis[index : index+n]
	var ops []Op
	for i := 0; i < len(vis); {
		start, run := vis[i].id, 1
		for i+run < len(vis) && vis[i+run].id.Client == start.Client && vis[i+run].id.Clock == start.Clock+uint64(run) {
			run++
		}
		ops = append(ops, Op{T: TTextDelete, ID: d.next(client, 1), Block: block, Target: start, Len: uint64(run)})
		i += run
	}
	for _, op := range ops {
		d.Apply(op)
	}
	return ops
}

// CreateBlock appends a block under parent with the given fractional position.
func (d *Doc) CreateBlock(client uint64, parent OpID, pos, typ string) Op {
	op := Op{T: TBlockCreate, ID: d.next(client, 1), Parent: parent, Pos: pos, Type: typ}
	d.Apply(op)
	return op
}

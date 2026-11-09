package collab

import (
	"errors"
	"fmt"
	"sort"
)

// StateTag marks a state (snapshot) blob: 0x4a 0x53 <version>.
const StateTag = 0x53

// ErrNotReady is returned by TryApply when an op's dependencies are missing.
var ErrNotReady = errors.New("collab: op dependencies missing")

// ErrDuplicate is returned by TryApply for an op that is already integrated.
var ErrDuplicate = errors.New("collab: duplicate op")

// ErrIdentityOverlap means an op would reuse an ID already occupied by a
// different op or by a character of a multi-character insertion.
var ErrIdentityOverlap = errors.New("collab: operation identity overlap")

// TryApply integrates op only if it is immediately applicable. Unlike Apply it
// never buffers; the server uses it to validate client ops.
func (d *Doc) TryApply(op Op) error {
	if err := d.validateTryApply(op); err != nil {
		return err
	}
	d.integrate(&op)
	return nil
}

// validateTryApply does not modify the replica. Keep it shared with the
// transactional path so both enforce identical identity and dependency rules.
func (d *Doc) validateTryApply(op Op) error {
	if d.seen[op.ID] || d.isStructuralDup(&op) {
		return ErrDuplicate
	}
	d.ensureOccupied()
	span := op.Span()
	if span == 0 {
		span = 1
	}
	const maxClock = uint64(1<<53 - 1)
	if op.ID.Clock > maxClock || span-1 > maxClock-op.ID.Clock {
		return ErrIdentityOverlap
	}
	for i := uint64(0); i < span; i++ {
		id := OpID{op.ID.Client, op.ID.Clock + i}
		if d.seen[id] {
			return ErrIdentityOverlap
		}
		if id != Root && d.occupied[id] != 0 {
			return ErrIdentityOverlap
		}
	}
	if op.T == TTable && (len(op.Payload) == 0 || len(op.Payload) > maxTablePayloadBytes) {
		return fmt.Errorf("collab: table payload out of range (%d bytes)", len(op.Payload))
	}
	if !d.ready(&op) {
		return ErrNotReady
	}
	return nil
}

// maxTablePayloadBytes bounds one experimental-table sub-CRDT operation
// (DEFAULT_TABLE_LIMITS.maxOperationBytes in the prototype).
const maxTablePayloadBytes = 512

// Counts accommodate legacy/corrupt states with the same retained ID in more
// than one place; removing one occurrence must not hide another. Building the
// index is lazy so ordinary snapshot decoding and read-only views pay no cost.
func (d *Doc) ensureOccupied() {
	if d.occupied != nil {
		return
	}
	d.occupied = make(map[OpID]uint32)
	for id, b := range d.blocks {
		if id != Root {
			d.occupied[id]++
		}
		for cid := range b.chars {
			if cid != Root {
				d.occupied[cid]++
			}
		}
	}
}

func (d *Doc) occupy(id OpID) {
	if d.occupied != nil && id != Root {
		d.occupied[id]++
	}
}

func (d *Doc) unoccupy(id OpID) {
	if d.occupied == nil || id == Root {
		return
	}
	if d.occupied[id] <= 1 {
		delete(d.occupied, id)
	} else {
		d.occupied[id]--
	}
}

func (d *Doc) isStructuralDup(op *Op) bool {
	switch op.T {
	case TBlockCreate:
		return d.blocks[op.ID] != nil
	case TTextInsert:
		b := d.blocks[op.Block]
		return b != nil && b.chars[op.ID] != nil
	case TMark:
		if b := d.blocks[op.Block]; b != nil {
			for _, m := range b.marks {
				if m.id == op.ID {
					return true
				}
			}
		}
	}
	return false
}

// HasBlock reports whether a (possibly deleted) block exists.
func (d *Doc) HasBlock(id OpID) bool { return d.blocks[id] != nil }

// StateVersion is the snapshot format: v2 appends the experimental-table
// payload section after the blocks. Readers accept v1 (no tables) and v2;
// op batches keep their own Version. Old binaries reject v2 snapshots by the
// strictness rule instead of misreading them.
const StateVersion = 2

// EncodeState serializes the replica (spec/PROTOCOL.md §State). Must match TS Doc.encodeState byte-for-byte.
// Docs without table payloads stay byte-identical v1; only table-bearing
// states bump to v2 (readers accept both).
func (d *Doc) EncodeState() []byte {
	w := &writer{b: make([]byte, 0, 256)}
	tableCount := 0
	for id := range d.tables {
		if len(d.tables[id]) > 0 {
			tableCount++
		}
	}
	stateVersion := byte(Version)
	if tableCount > 0 {
		stateVersion = StateVersion
	}
	w.u8(Magic)
	w.u8(StateTag)
	w.u8(stateVersion)
	w.uvar(d.clock)
	blocks := make([]*block, 0, len(d.blocks))
	for id, b := range d.blocks {
		if id != Root {
			blocks = append(blocks, b)
		}
	}
	sort.Slice(blocks, func(i, j int) bool { return blocks[i].id.Cmp(blocks[j].id) < 0 })
	w.uvar(uint64(len(blocks)))
	for _, b := range blocks {
		w.id(b.id)
		w.id(b.parent)
		w.str(b.pos)
		w.id(b.locTS)
		w.u8(boolByte(b.deleted))
		keys := make([]string, 0, len(b.props))
		for k := range b.props {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		w.uvar(uint64(len(keys)))
		for _, k := range keys {
			w.str(k)
			w.str(b.props[k].value)
			w.id(b.props[k].ts)
		}
		var list []*charNode
		index := map[*charNode]uint64{b.root: 0}
		var walk func(n *charNode)
		walk = func(n *charNode) {
			if n != b.root {
				list = append(list, n)
				index[n] = uint64(len(list))
			}
			for _, c := range n.left {
				walk(c)
			}
			for _, c := range n.right {
				walk(c)
			}
		}
		walk(b.root)
		w.uvar(uint64(len(list)))
		for _, n := range list {
			w.id(n.id)
			w.u8(n.side)
			w.uvar(index[n.parent])
			w.u8(boolByte(n.deleted))
			w.str(string(n.ch))
		}
		marks := append([]markRec(nil), b.marks...)
		sort.Slice(marks, func(i, j int) bool { return marks[i].id.Cmp(marks[j].id) < 0 })
		w.uvar(uint64(len(marks)))
		for _, m := range marks {
			w.id(m.id)
			w.str(m.key)
			if m.value == nil {
				w.u8(0)
			} else {
				w.u8(1)
				w.str(*m.value)
			}
			w.id(m.start.Char)
			w.u8(m.start.Side)
			w.id(m.end.Char)
			w.u8(m.end.Side)
		}
	}
	// v2 section: opaque experimental-table payloads per block, blocks in id
	// order for deterministic bytes. Written only in v2 (see header).
	if stateVersion == StateVersion {
		tableBlocks := make([]OpID, 0, len(d.tables))
		for id := range d.tables {
			if len(d.tables[id]) > 0 {
				tableBlocks = append(tableBlocks, id)
			}
		}
		sort.Slice(tableBlocks, func(i, j int) bool { return tableBlocks[i].Cmp(tableBlocks[j]) < 0 })
		w.uvar(uint64(len(tableBlocks)))
		for _, id := range tableBlocks {
			w.id(id)
			w.uvar(uint64(len(d.tables[id])))
			for _, p := range d.tables[id] {
				w.blob(p)
			}
		}
	}
	return w.b
}

func boolByte(b bool) byte {
	if b {
		return 1
	}
	return 0
}

// DecodeState rebuilds a replica from EncodeState (or TS encodeState) output.
func DecodeState(data []byte) (*Doc, error) {
	r := &reader{b: data}
	d := NewDoc()
	hdr := make([]byte, 3)
	for i := range hdr {
		x, err := r.u8()
		if err != nil {
			return nil, err
		}
		hdr[i] = x
	}
	if hdr[0] != Magic || hdr[1] != StateTag || (hdr[2] != Version && hdr[2] != StateVersion) {
		return nil, errors.New("collab: unsupported state blob version")
	}
	var err error
	if d.clock, err = r.uvar(); err != nil {
		return nil, err
	}
	nb, err := r.uvar()
	if err != nil {
		return nil, err
	}
	if nb > uint64(len(data)) {
		return nil, ErrShort
	}
	for i := uint64(0); i < nb; i++ {
		if err := decodeBlock(r, d); err != nil {
			return nil, err
		}
	}
	if hdr[2] == StateVersion {
		nt, err := r.uvar()
		if err != nil {
			return nil, err
		}
		for i := uint64(0); i < nt; i++ {
			id, err := r.id()
			if err != nil {
				return nil, err
			}
			if d.blocks[id] == nil {
				return nil, fmt.Errorf("collab: table payloads for unknown block %d:%d", id.Client, id.Clock)
			}
			np, err := r.uvar()
			if err != nil {
				return nil, err
			}
			for j := uint64(0); j < np; j++ {
				p, err := r.blob()
				if err != nil {
					return nil, err
				}
				d.tables[id] = append(d.tables[id], p)
			}
		}
	}
	if r.i != len(data) {
		return nil, errors.New("collab: trailing bytes in state")
	}
	return d, nil
}

func decodeBlock(r *reader, d *Doc) error {
	id, err := r.id()
	if err != nil {
		return err
	}
	parent, err := r.id()
	if err != nil {
		return err
	}
	pos, err := r.str()
	if err != nil {
		return err
	}
	b := newBlock(id, parent, pos)
	if b.locTS, err = r.id(); err != nil {
		return err
	}
	del, err := r.u8()
	if err != nil {
		return err
	}
	b.deleted = del == 1
	np, err := r.uvar()
	if err != nil {
		return err
	}
	for k := uint64(0); k < np; k++ {
		key, err := r.str()
		if err != nil {
			return err
		}
		val, err := r.str()
		if err != nil {
			return err
		}
		ts, err := r.id()
		if err != nil {
			return err
		}
		b.props[key] = propReg{val, ts}
	}
	nc, err := r.uvar()
	if err != nil {
		return err
	}
	if nc > uint64(len(r.b)) {
		return ErrShort
	}
	list := []*charNode{b.root}
	for k := uint64(0); k < nc; k++ {
		cid, err := r.id()
		if err != nil {
			return err
		}
		side, err := r.side()
		if err != nil {
			return err
		}
		pi, err := r.uvar()
		if err != nil {
			return err
		}
		dl, err := r.u8()
		if err != nil {
			return err
		}
		ch, err := r.str()
		if err != nil {
			return err
		}
		rs := []rune(ch)
		if pi >= uint64(len(list)) || len(rs) != 1 || b.chars[cid] != nil {
			return fmt.Errorf("collab: corrupt state char")
		}
		p := list[pi]
		n := &charNode{id: cid, ch: rs[0], deleted: dl == 1, parent: p, side: side}
		if side == 0 {
			p.left = insertSorted(p.left, n)
		} else {
			p.right = insertSorted(p.right, n)
		}
		b.chars[cid] = n
		list = append(list, n)
	}
	nm, err := r.uvar()
	if err != nil {
		return err
	}
	for k := uint64(0); k < nm; k++ {
		var m markRec
		if m.id, err = r.id(); err != nil {
			return err
		}
		if m.key, err = r.str(); err != nil {
			return err
		}
		has, err := r.u8()
		if err != nil {
			return err
		}
		if has == 1 {
			v, err := r.str()
			if err != nil {
				return err
			}
			m.value = &v
		}
		if m.start.Char, err = r.id(); err != nil {
			return err
		}
		if m.start.Side, err = r.side(); err != nil {
			return err
		}
		if m.end.Char, err = r.id(); err != nil {
			return err
		}
		if m.end.Side, err = r.side(); err != nil {
			return err
		}
		if b.chars[m.start.Char] == nil || b.chars[m.end.Char] == nil {
			return fmt.Errorf("collab: mark anchor missing")
		}
		b.marks = append(b.marks, m)
	}
	d.blocks[id] = b
	return nil
}

// Compact strips payload that no operation can observe from a state about to
// be saved as a snapshot: deleted blocks lose their marks and every prop except
// type. Character tombstones are always retained, in live and deleted blocks.
//
// Tombstones cannot be garbage-collected at the acknowledged horizon: a replica
// that has acknowledged a deletion still holds the tombstone and keeps using it
// as a Fugue origin (typing after a removed slash query, after a converted
// Markdown prefix, after any deletion), as a delete target for concurrent
// deletes, or as a mark anchor. Dropping it made every such later op unresolved
// for replicas that cold-load the snapshot (see PROTOCOL.md §11).
//
// Returns the number of characters removed, which is always 0.
func (d *Doc) Compact() int {
	for id, b := range d.blocks {
		if id == Root || !b.deleted {
			continue
		}
		t := b.props["type"]
		b.props = map[string]propReg{"type": t}
		b.marks = nil
	}
	return 0
}

// CompactLegacyTombstones is the tombstone GC that servers ran before
// 2026-11-09. It is unsafe (see Compact) and kept only so tests can build the
// lossy snapshots those servers persisted and verify the lossless recovery.
func (d *Doc) CompactLegacyTombstones() int {
	removed := 0
	for id, b := range d.blocks {
		if id == Root {
			continue
		}
		if b.deleted {
			removed += len(b.chars) - 1
			for cid := range b.chars {
				d.unoccupy(cid)
			}
			t := b.props["type"]
			b.props = map[string]propReg{"type": t}
			b.root.left, b.root.right = nil, nil
			b.chars = map[OpID]*charNode{Root: b.root}
			b.marks = nil
			b.order = nil
			continue
		}
		anchored := map[OpID]bool{}
		for _, m := range b.marks {
			anchored[m.start.Char] = true
			anchored[m.end.Char] = true
		}
		for changed := true; changed; {
			changed = false
			for cid, n := range b.chars {
				if n == b.root || !n.deleted || len(n.left) > 0 || len(n.right) > 0 || anchored[cid] {
					continue
				}
				p := n.parent
				if n.side == 0 {
					p.left = removeNode(p.left, n)
				} else {
					p.right = removeNode(p.right, n)
				}
				delete(b.chars, cid)
				d.unoccupy(cid)
				removed++
				changed = true
			}
		}
		b.order = nil
	}
	return removed
}

func removeNode(arr []*charNode, n *charNode) []*charNode {
	for i, x := range arr {
		if x == n {
			return append(arr[:i], arr[i+1:]...)
		}
	}
	return arr
}

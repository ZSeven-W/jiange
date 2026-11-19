package collab

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

const columnArchiveType = "jiange-column-archive-v1"
const columnArchiveKey = "_column_archive_v1"

// MaxColumns is the authoritative maximum number of live columns allowed in
// a single root-level columns container (matching Feishu & client MAX_COLUMNS).
const MaxColumns = 10

// ColumnCount returns the number of live direct child columns in a root-level
// columns container, or -1 if parent is not a live root-level columns block.
func (d *Doc) ColumnCount(parent OpID) int {
	if parent == Root {
		return -1
	}
	p := d.blocks[parent]
	if p == nil || p.deleted || p.parent != Root || p.props["type"].value != "columns" {
		return -1
	}
	count := 0
	for childID, child := range d.blocks {
		if childID == Root || child.deleted || child.parent != parent {
			continue
		}
		count++
	}
	return count
}

// CanCreateColumn verifies that a new column can be added under parent without
// exceeding MaxColumns or colliding with an existing column position.
func (d *Doc) CanCreateColumn(parent OpID, pos string) bool {
	if !validColumnArchivePosition(pos) {
		return false
	}
	count := d.ColumnCount(parent)
	if count < 0 || count >= MaxColumns {
		return false
	}
	for childID, child := range d.blocks {
		if childID == Root || child.deleted || child.parent != parent {
			continue
		}
		if child.pos == pos {
			return false
		}
	}
	return true
}

// CanUngroupColumns verifies that moves promote every live direct child of a
// root-level columns container (and any nested child blocks inside those
// columns) to Root with distinct valid positions.
func (d *Doc) CanUngroupColumns(groupID OpID, moves []Op) bool {
	if !d.CanArchiveColumnGroup(groupID) || len(moves) == 0 {
		return false
	}
	liveNodes := map[OpID]*block{}
	var collect func(parent OpID)
	collect = func(parent OpID) {
		for id, b := range d.blocks {
			if id != Root && !b.deleted && b.parent == parent {
				if _, seen := liveNodes[id]; !seen {
					liveNodes[id] = b
					collect(id)
				}
			}
		}
	}
	collect(groupID)
	if len(liveNodes) == 0 || len(moves) != len(liveNodes) {
		return false
	}
	rootPositions := map[string]bool{}
	for id, b := range d.blocks {
		if id != Root && !b.deleted && b.parent == Root {
			rootPositions[b.pos] = true
		}
	}
	seenNodes := map[OpID]bool{}
	for _, m := range moves {
		if m.T != TBlockMove || m.Parent != Root || !validColumnArchivePosition(m.Pos) {
			return false
		}
		node, ok := liveNodes[m.Block]
		if !ok || seenNodes[m.Block] || m.ID.Cmp(node.locTS) <= 0 {
			return false
		}
		if rootPositions[m.Pos] {
			return false
		}
		seenNodes[m.Block] = true
		rootPositions[m.Pos] = true
	}
	return len(seenNodes) == len(liveNodes)
}

func validColumnArchivePosition(pos string) bool {
	if len(pos) == 0 || len(pos) > 512 || strings.HasSuffix(pos, "0") {
		return false
	}
	for _, c := range pos {
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z') {
			return false
		}
	}
	return true
}

// CanArchiveColumn verifies the current visible layout before a conditional
// archive batch. The caller must still authorize and compare the document head.
func (d *Doc) CanArchiveColumn(id OpID) bool {
	b := d.blocks[id]
	if b == nil || b.deleted || id == Root {
		return false
	}
	p := d.blocks[b.parent]
	if p == nil || p.deleted || p.parent != Root || p.props["type"].value != "columns" {
		return false
	}
	positions := make([]string, 0)
	for childID, child := range d.blocks {
		if childID == Root || child.deleted || child.parent != p.id {
			continue
		}
		pos := child.pos
		if !validColumnArchivePosition(pos) {
			return false
		}
		positions = append(positions, pos)
	}
	if len(positions) < 2 || len(positions) > 1000 {
		return false
	}
	sort.Strings(positions)
	for i := 1; i < len(positions); i++ {
		if positions[i-1] == positions[i] {
			return false
		}
	}
	return true
}

// CanArchiveColumnGroup accepts only a root-level columns container. Other
// root blocks, in particular the title, cannot use this archive protocol.
func (d *Doc) CanArchiveColumnGroup(id OpID) bool {
	b := d.blocks[id]
	if b == nil || b.deleted || id == Root || b.parent != Root || b.props["type"].value != "columns" {
		return false
	}
	positions := make(map[string]bool)
	for otherID, other := range d.blocks {
		if otherID == Root || other.deleted || other.parent != Root {
			continue
		}
		if !validColumnArchivePosition(other.pos) || positions[other.pos] {
			return false
		}
		positions[other.pos] = true
	}
	return len(positions) <= 10000
}

// Check the recorded origin before writing metadata and hiding the column.
func (d *Doc) CanArchiveColumnWithMetadata(id, archive, metadataID, moveID OpID, metadata string) bool {
	if !d.CanArchiveColumn(id) && !d.CanArchiveColumnGroup(id) {
		return false
	}
	b := d.blocks[id]
	if moveID.Cmp(b.locTS) <= 0 {
		return false
	}
	if previous, ok := b.props[columnArchiveKey]; ok && metadataID.Cmp(previous.ts) <= 0 {
		return false
	}
	return metadata == fmt.Sprintf("v1|%s|%s|%s", b.parent.Key(), b.pos, archive.Key())
}

func archiveMetadataID(value string) (OpID, bool) {
	parts := strings.Split(value, ":")
	if len(parts) != 2 {
		return OpID{}, false
	}
	client, e1 := strconv.ParseUint(parts[0], 10, 53)
	clock, e2 := strconv.ParseUint(parts[1], 10, 53)
	id := OpID{Client: client, Clock: clock}
	return id, e1 == nil && e2 == nil && clock > 0 && id.Key() == value
}

// CanTransitionArchivedColumn permits only a move between the recorded
// origin and its own tombstoned archive; it never permits arbitrary moves.
func (d *Doc) CanTransitionArchivedColumn(op Op) bool {
	if op.T != TBlockMove || op.Block == Root {
		return false
	}
	b := d.blocks[op.Block]
	if b == nil || b.deleted || op.ID.Cmp(b.locTS) <= 0 {
		return false
	}
	parts := strings.Split(b.props[columnArchiveKey].value, "|")
	if len(parts) != 4 || parts[0] != "v1" || !validColumnArchivePosition(parts[2]) {
		return false
	}
	parent := Root
	if parts[1] != Root.Key() {
		var ok bool
		parent, ok = archiveMetadataID(parts[1])
		if !ok {
			return false
		}
	}
	archive, ok := archiveMetadataID(parts[3])
	if !ok {
		return false
	}
	p, tombstone := d.blocks[parent], d.blocks[archive]
	if p == nil || p.deleted || (parent != Root && (p.parent != Root || p.props["type"].value != "columns")) || (parent == Root && b.props["type"].value != "columns") || tombstone == nil || !tombstone.deleted || tombstone.props["type"].value != columnArchiveType {
		return false
	}
	for id, other := range d.blocks {
		if id != op.Block && !other.deleted && other.parent == archive {
			return false
		}
	}
	if b.parent == parent && b.pos == parts[2] && op.Parent == archive && op.Pos == "U" {
		if parent == Root {
			return d.CanArchiveColumnGroup(op.Block)
		}
		return d.CanArchiveColumn(op.Block)
	}
	if b.parent != archive || b.pos != "U" || op.Parent != parent || op.Pos != parts[2] {
		return false
	}
	positions := map[string]bool{}
	for id, sibling := range d.blocks {
		if id == Root || sibling.deleted || sibling.parent != parent {
			continue
		}
		pos := sibling.pos
		if !validColumnArchivePosition(pos) || positions[pos] || pos == op.Pos {
			return false
		}
		positions[pos] = true
	}
	if parent == Root {
		return len(positions) < 10000
	}
	return len(positions) >= 1 && len(positions) < MaxColumns
}

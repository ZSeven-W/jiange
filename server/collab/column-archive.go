package collab

import (
	"sort"
	"strings"
)

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
		if len(pos) == 0 || len(pos) > 512 || strings.HasSuffix(pos, "0") {
			return false
		}
		for _, c := range pos {
			if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z') {
				return false
			}
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

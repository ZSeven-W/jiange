package api

import "github.com/ZSeven-W/jiange/server/collab"

// Accept the original three-op prototype and the four-op protocol that also
// records the source location. No arbitrary create/delete/move batches.
func conditionalColumnArchiveBatch(ops []collab.Op) bool {
	if len(ops) != 3 && len(ops) != 4 {
		return false
	}
	create, remove, move := ops[0], ops[1], ops[len(ops)-1]
	baseValid := create.T == collab.TBlockCreate && create.Type == "jiange-column-archive-v1" && create.Parent == collab.Root && create.Pos == "U" &&
		create.ID.Client > 0 && create.ID.Client <= conditionalSafeInteger && create.ID.Clock > 0 && create.ID.Clock <= conditionalSafeInteger-uint64(len(ops)-1) &&
		remove.T == collab.TBlockDelete && remove.Block == create.ID && remove.ID.Client == create.ID.Client && remove.ID.Clock == create.ID.Clock+1 &&
		move.T == collab.TBlockMove && move.Parent == create.ID && move.Pos == "U" && move.Block != collab.Root && move.Block != create.ID && move.ID.Client == create.ID.Client && move.ID.Clock == create.ID.Clock+uint64(len(ops)-1)
	if !baseValid || len(ops) == 3 {
		return baseValid
	}
	meta := ops[2]
	return meta.T == collab.TBlockSet && meta.ID.Client == create.ID.Client && meta.ID.Clock == create.ID.Clock+2 && meta.Block == move.Block && meta.Key == "_column_archive_v1" && meta.Value != nil
}

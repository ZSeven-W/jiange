package api

import "github.com/ZSeven-W/jiange/server/collab"

// Recognize exactly the three-op archive protocol; never generalize this into
// accepting arbitrary creates, deletes or cross-parent moves in this endpoint.
func conditionalColumnArchiveBatch(ops []collab.Op) bool {
	if len(ops) != 3 {
		return false
	}
	create, remove, move := ops[0], ops[1], ops[2]
	return create.T == collab.TBlockCreate && create.Type == "jiange-column-archive-v1" && create.Parent == collab.Root && create.Pos == "U" &&
		create.ID.Client > 0 && create.ID.Client <= conditionalSafeInteger && create.ID.Clock > 0 && create.ID.Clock <= conditionalSafeInteger-2 &&
		remove.T == collab.TBlockDelete && remove.Block == create.ID && remove.ID.Client == create.ID.Client && remove.ID.Clock == create.ID.Clock+1 &&
		move.T == collab.TBlockMove && move.Parent == create.ID && move.Pos == "U" && move.Block != collab.Root && move.Block != create.ID && move.ID.Client == create.ID.Client && move.ID.Clock == create.ID.Clock+2
}

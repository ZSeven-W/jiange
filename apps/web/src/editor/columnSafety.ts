import { type Doc, type OpId, type Tx } from "@jiange/collab";
import { safeSlashUndo } from "./slashInsert";

/** Keep newly created containers alive if remote edits arrive after undo. */
export function createColumn(tx: Tx, parent: OpId, after: OpId | null): OpId {
  const column = tx.create("paragraph", after, parent);
  // An undoable marker keeps this action on the stack even though undo must
  // not tombstone a column that peers may already be editing.
  tx.setProp(column, "_column_created", "1");
  return column;
}
export const safeColumnUndo = safeSlashUndo;

/** Tombstones cannot be undone with their original ID in the current protocol. */
export function requestColumnDeletion(doc: Doc, column: OpId): "missing" | "unsupported" {
  return doc.hasBlock(column) ? "unsupported" : "missing";
}

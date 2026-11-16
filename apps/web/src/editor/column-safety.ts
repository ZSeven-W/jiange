import { eqId, ROOT, type Doc, type OpId, type Tx } from "@jiange/collab";
import { safeSlashUndo } from "./slash-insert";

/** Keep newly created containers alive if remote edits arrive after undo. */
export function createColumn(tx: Tx, parent: OpId, after: OpId | null): OpId {
  const column = tx.create("paragraph", after, parent);
  // An undoable marker keeps this action on the stack even though undo must
  // not tombstone a column that peers may already be editing.
  tx.setProp(column, "_column_created", "1");
  return column;
}
export const safeColumnUndo = safeSlashUndo;

export const MAX_COLUMNS = 10;
/** Validate the current local structure before inserting, without clipping existing content. */
export function insertColumnAfter(tx: Tx, parent: OpId, after: OpId | null): "created" | "limit" | "changed" {
  const doc = tx.doc;
  if (!doc.hasBlock(parent)) return "changed";
  const info = doc.blockInfo(parent);
  if (info.type !== "columns" || !eqId(info.parent, ROOT)) return "changed";
  const children = doc.children(parent);
  if (after && !children.some((child) => eqId(child, after))) return "changed";
  if (children.length >= MAX_COLUMNS) return "limit";
  createColumn(tx, parent, after);
  return "created";
}

/** Tombstones cannot be undone with their original ID in the current protocol. */
export function requestColumnDeletion(doc: Doc, column: OpId): "missing" | "unsupported" {
  return doc.hasBlock(column) ? "unsupported" : "missing";
}

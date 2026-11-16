import { eqId, idKey, ROOT, type Doc, type Op, type OpId, type Tx } from "@jiange/collab";
import { captureColumnMove, type ColumnMoveSnapshot } from "./column-move.js";

/**
 * Experimental only: not exported from the SDK entry point or connected to UI.
 * A deleted parent hides its live child in both TS and Go projections. Keeping
 * the child alive allows late character edits to follow the original identity.
 * Transport atomicity, conditional server admission, recovery after reload,
 * and the editor undo stack must be integrated before exposing this to users.
 */
const ARCHIVE_TYPE = "jiange-column-archive-v1";
const ARCHIVE_POS = "U";

export interface ColumnArchive {
  readonly doc: Doc;
  readonly parent: Readonly<OpId>;
  readonly block: Readonly<OpId>;
  readonly archive: Readonly<OpId>;
  readonly originalPos: string;
  readonly guard: string;
  readonly version: string;
  readonly archived: boolean;
}

/** Verify the same group and sibling positions without comparing column text. */
function siblingGuard(doc: Doc, parent: OpId, block: OpId): string | null {
  if (!doc.hasBlock(parent)) return null;
  const info = doc.blockInfo(parent);
  if (info.type !== "columns" || !eqId(info.parent, ROOT)) return null;
  const parentLoc = doc.blockLocation(parent), typeVersion = doc.propVersion(parent, "type");
  const items = doc.children(parent).filter((item) => !eqId(item, block)).map((item) => {
    const loc = doc.blockLocation(item);
    return [idKey(item), loc.pos, idKey(loc.version)];
  });
  return JSON.stringify([idKey(parentLoc.version), typeVersion ? idKey(typeVersion) : null, items]);
}

/** Hide a captured column under a new tombstoned parent without deleting it. */
export function archiveColumn(tx: Tx, captured: ColumnMoveSnapshot): ColumnArchive | null {
  const doc = tx.doc;
  if (doc !== captured.doc || doc.pendingCount !== 0) return null;
  const current = captureColumnMove(doc, captured.parent, captured.block);
  if (!current || current.pos !== captured.pos || current.version !== captured.version || current.guard !== captured.guard || current.ids.length !== captured.ids.length || current.ids.some((id, i) => id !== captured.ids[i])) return null;
  let ids: OpId[];
  try { ids = doc.allocateOpIds(3); } catch { return null; }
  const [archive, deletion, move] = ids;
  const ops: Op[] = [
    { t: "bcreate", id: archive, parent: ROOT, pos: ARCHIVE_POS, type: ARCHIVE_TYPE },
    { t: "bdel", id: deletion, block: archive },
    { t: "bmove", id: move, block: captured.block, parent: archive, pos: ARCHIVE_POS },
  ];
  for (const op of ops) { doc.apply(op); tx.ops.push(op); }
  return Object.freeze({ doc, parent: Object.freeze({ ...captured.parent }), block: Object.freeze({ ...captured.block }), archive: Object.freeze({ ...archive }), originalPos: captured.pos, guard: captured.guard, version: idKey(move), archived: true });
}

/** Restore or re-hide the same block if no sibling or location changed. */
export function toggleArchivedColumn(tx: Tx, entry: ColumnArchive): ColumnArchive | null {
  const doc = tx.doc;
  if (entry.doc !== doc || doc.pendingCount !== 0 || !doc.hasBlock(entry.block) || doc.deletedBlockType(entry.archive) !== ARCHIVE_TYPE || siblingGuard(doc, entry.parent, entry.block) !== entry.guard) return null;
  const loc = doc.blockLocation(entry.block);
  if (idKey(loc.version) !== entry.version || !eqId(loc.parent, entry.archived ? entry.archive : entry.parent) || loc.pos !== (entry.archived ? ARCHIVE_POS : entry.originalPos)) return null;
  if (entry.archived && doc.children(entry.parent).some((item) => doc.blockLocation(item).pos === entry.originalPos)) return null;
  let id: OpId;
  try { [id] = doc.allocateOpIds(1); } catch { return null; }
  const op: Op = { t: "bmove", id, block: entry.block, parent: entry.archived ? entry.parent : entry.archive, pos: entry.archived ? entry.originalPos : ARCHIVE_POS };
  doc.apply(op); tx.ops.push(op);
  return Object.freeze({ ...entry, version: idKey(id), archived: !entry.archived });
}

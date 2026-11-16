import { Doc, Tx, decodeOps, encodeOps, eqId, idKey, ROOT, type Op, type OpId } from "@jiange/collab";
import { captureColumnMove, validColumnPosition, type ColumnMoveSnapshot } from "./column-move.js";

/**
 * Experimental only: not exported from the SDK entry point or connected to UI.
 * A deleted parent hides its live child in both TS and Go projections. Keeping
 * the child alive allows late character edits to follow the original identity.
 * Transport atomicity, conditional server admission, durable handle storage,
 * and the editor undo stack must be integrated before exposing this to users.
 */
const ARCHIVE_TYPE = "jiange-column-archive-v1";
const ARCHIVE_POS = "U";
const ARCHIVE_META = "_column_archive_v1";
const MAX_PLAN_STATE_BYTES = 8 << 20;

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

export interface PreparedColumnArchive {
  readonly doc: Doc;
  readonly ops: readonly Op[];
  readonly recovery: string;
}
const planBases = new WeakMap<PreparedColumnArchive, Uint8Array>();

function freezeArchivePlan(doc: Doc, base: Uint8Array, tx: Tx, result: ColumnArchive): PreparedColumnArchive {
  const ops = decodeOps(encodeOps(tx.ops));
  for (const op of ops) {
    Object.freeze(op.id);
    if ("block" in op) Object.freeze(op.block);
    if ("parent" in op) Object.freeze(op.parent);
    Object.freeze(op);
  }
  const plan: PreparedColumnArchive = Object.freeze({ doc, ops: Object.freeze(ops), recovery: serializeColumnArchive(result) });
  planBases.set(plan, base);
  return plan;
}

/** Prepare against a private replica so nothing is hidden before a receipt. */
export function prepareColumnArchive(doc: Doc, author: number, parent: OpId, block: OpId): PreparedColumnArchive | null {
  if (!Number.isSafeInteger(author) || author <= 0 || author === doc.client || doc.pendingCount !== 0) return null;
  try {
    const captured = captureColumnMove(doc, parent, block);
    if (!captured) return null;
    const base = doc.encodeState();
    if (base.byteLength > MAX_PLAN_STATE_BYTES) return null;
    const copy = Doc.fromState(author, base), clone = captureColumnMove(copy, parent, block);
    if (!clone || clone.pos !== captured.pos || clone.version !== captured.version || clone.guard !== captured.guard) return null;
    const tx = new Tx(copy), result = archiveColumn(tx, clone);
    if (!result) return null;
    return freezeArchivePlan(doc, base, tx, result);
  } catch { return null; }
}

/** Prepare a restore or redo with the same no-optimistic-mutation contract. */
export function prepareColumnArchiveTransition(entry: ColumnArchive, author: number): PreparedColumnArchive | null {
  const doc = entry.doc;
  if (!Number.isSafeInteger(author) || author <= 0 || author === doc.client || !validArchiveState(doc, entry)) return null;
  try {
    const base = doc.encodeState();
    if (base.byteLength > MAX_PLAN_STATE_BYTES) return null;
    const copy = Doc.fromState(author, base), clone = recoverColumnArchive(copy, serializeColumnArchive(entry));
    if (!clone) return null;
    const tx = new Tx(copy), result = toggleArchivedColumn(tx, clone);
    return result ? freezeArchivePlan(doc, base, tx, result) : null;
  } catch { return null; }
}

/** Reject an operation whose original replica changed before submission. */
export function preparedColumnArchiveIsCurrent(plan: PreparedColumnArchive, doc: Doc): boolean {
  if (plan.doc !== doc) return false;
  try {
    const base = planBases.get(plan), now = doc.encodeState();
    return !!base && base.byteLength === now.byteLength && now.every((value, i) => value === base[i]);
  } catch { return false; }
}

const validId = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*):[1-9]\d*$/.test(value)) return false;
  return value.split(":").every((part) => Number.isSafeInteger(Number(part)));
};
const parseId = (value: string): OpId => {
  const [client, clock] = value.split(":").map(Number);
  return { client, clock };
};

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
  try { ids = doc.allocateOpIds(4); } catch { return null; }
  const [archive, deletion, metadata, move] = ids;
  const archiveMetadata = `v1|${idKey(captured.parent)}|${captured.pos}|${idKey(archive)}`;
  const ops: Op[] = [
    { t: "bcreate", id: archive, parent: ROOT, pos: ARCHIVE_POS, type: ARCHIVE_TYPE },
    { t: "bdel", id: deletion, block: archive },
    { t: "bset", id: metadata, block: captured.block, key: ARCHIVE_META, value: archiveMetadata },
    { t: "bmove", id: move, block: captured.block, parent: archive, pos: ARCHIVE_POS },
  ];
  for (const op of ops) { doc.apply(op); tx.ops.push(op); }
  return Object.freeze({ doc, parent: Object.freeze({ ...captured.parent }), block: Object.freeze({ ...captured.block }), archive: Object.freeze({ ...archive }), originalPos: captured.pos, guard: captured.guard, version: idKey(move), archived: true });
}

/** Persist only layout identities and positions, never column content.
 * The host must scope storage to its authenticated account and document;
 * matching structure alone does not authenticate a document identity. */
export function serializeColumnArchive(entry: ColumnArchive): string {
  return JSON.stringify({ v: 1, parent: idKey(entry.parent), block: idKey(entry.block), archive: idKey(entry.archive), originalPos: entry.originalPos, guard: entry.guard, version: entry.version, archived: entry.archived });
}

/** Rebind a persisted handle to a fully synchronized replica, without changing it. */
export function recoverColumnArchive(doc: Doc, raw: string): ColumnArchive | null {
  if (typeof raw !== "string" || raw.length > 1_000_000 || doc.pendingCount !== 0) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "archive,archived,block,guard,originalPos,parent,v,version" || value.v !== 1 || !validId(value.parent) || !validId(value.block) || !validId(value.archive) || !validId(value.version) || typeof value.originalPos !== "string" || !validColumnPosition(value.originalPos) || typeof value.guard !== "string" || typeof value.archived !== "boolean") return null;
  const entry: ColumnArchive = Object.freeze({ doc, parent: Object.freeze(parseId(value.parent)), block: Object.freeze(parseId(value.block)), archive: Object.freeze(parseId(value.archive)), originalPos: value.originalPos, guard: value.guard, version: value.version, archived: value.archived });
  return validArchiveState(doc, entry) ? entry : null;
}

function validArchiveState(doc: Doc, entry: ColumnArchive): boolean {
  if (entry.doc !== doc || doc.pendingCount !== 0 || !doc.hasBlock(entry.block) || doc.deletedBlockType(entry.archive) !== ARCHIVE_TYPE || siblingGuard(doc, entry.parent, entry.block) !== entry.guard) return false;
  if (doc.blockInfo(entry.block).props[ARCHIVE_META] !== `v1|${idKey(entry.parent)}|${entry.originalPos}|${idKey(entry.archive)}`) return false;
  const loc = doc.blockLocation(entry.block);
  if (idKey(loc.version) !== entry.version || !eqId(loc.parent, entry.archived ? entry.archive : entry.parent) || loc.pos !== (entry.archived ? ARCHIVE_POS : entry.originalPos)) return false;
  return !entry.archived || !doc.children(entry.parent).some((item) => doc.blockLocation(item).pos === entry.originalPos);
}

/** Restore or re-hide the same block if no sibling or location changed. */
export function toggleArchivedColumn(tx: Tx, entry: ColumnArchive): ColumnArchive | null {
  const doc = tx.doc;
  if (!validArchiveState(doc, entry)) return null;
  let id: OpId;
  try { [id] = doc.allocateOpIds(1); } catch { return null; }
  const op: Op = { t: "bmove", id, block: entry.block, parent: entry.archived ? entry.parent : entry.archive, pos: entry.archived ? entry.originalPos : ARCHIVE_POS };
  doc.apply(op); tx.ops.push(op);
  return Object.freeze({ ...entry, version: idKey(id), archived: !entry.archived });
}

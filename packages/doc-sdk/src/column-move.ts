import { eqId, idKey, keyBetween, ROOT, type Doc, type OpId, type Tx } from "@zseven-w/collab";

const POSITION = /^[0-9A-Za-z]{1,512}$/;
export const validColumnPosition = (value: string): boolean => POSITION.test(value) && !value.endsWith("0");

export interface ColumnMoveSnapshot {
  readonly doc: Doc;
  readonly parent: Readonly<OpId>;
  readonly block: Readonly<OpId>;
  readonly ids: readonly string[];
  readonly pos: string;
  readonly version: string;
  /** Stable scope excludes the moved column's own position. */
  readonly guard: string;
}

/** Capture a visible column and the untouched sibling positions before moving it. */
export function captureColumnMove(doc: Doc, parent: OpId, block: OpId): ColumnMoveSnapshot | null {
  if (!doc.hasBlock(parent) || !doc.hasBlock(block)) return null;
  const parentInfo = doc.blockInfo(parent), blockInfo = doc.blockInfo(block);
  if (parentInfo.type !== "columns" || !eqId(parentInfo.parent, ROOT) || !eqId(blockInfo.parent, parent)) return null;
  const siblings = doc.children(parent);
  if (siblings.length < 2 || siblings.length > 1000 || !siblings.some((id) => eqId(id, block))) return null;
  const positions = siblings.map((id) => ({ id: idKey(id), ...doc.blockLocation(id) }));
  if (positions.some((item, index) => !validColumnPosition(item.pos) || index > 0 && positions[index - 1].pos >= item.pos)) return null;
  const own = doc.blockLocation(block), parentLocation = doc.blockLocation(parent), typeVersion = doc.propVersion(parent, "type");
  const ids = positions.map((item) => item.id);
  const guard = JSON.stringify([idKey(parentLocation.version), typeVersion ? idKey(typeVersion) : null, positions.filter((item) => item.id !== idKey(block)).map((item) => [item.id, item.pos, idKey(item.version)])]);
  return Object.freeze({ doc, parent: Object.freeze({ ...parent }), block: Object.freeze({ ...block }), ids: Object.freeze(ids), pos: own.pos, version: idKey(own.version), guard });
}

/** Move after an existing sibling, or to the start when `after` is null. */
export function applyColumnMove(tx: Tx, snapshot: ColumnMoveSnapshot, after: OpId | null): "applied" | "unchanged" | "changed" | "invalid" {
  const doc = tx.doc;
  if (doc !== snapshot.doc || after && eqId(after, snapshot.block)) return "invalid";
  const current = captureColumnMove(doc, snapshot.parent, snapshot.block);
  if (!current || current.pos !== snapshot.pos || current.version !== snapshot.version || current.guard !== snapshot.guard || current.ids.some((id, index) => id !== snapshot.ids[index])) return "changed";
  const blockKey = idKey(snapshot.block), remaining = current.ids.filter((id) => id !== blockKey);
  const afterKey = after ? idKey(after) : null, target = afterKey === null ? 0 : remaining.indexOf(afterKey) + 1;
  if (afterKey !== null && target === 0) return "changed";
  const next = [...remaining]; next.splice(target, 0, blockKey);
  if (next.every((id, index) => id === current.ids[index])) return "unchanged";
  const positionOf = (key: string) => {
    const [client, clock] = key.split(":").map(Number);
    return doc.blockLocation({ client, clock }).pos;
  };
  let pos: string;
  const lower = target ? positionOf(remaining[target - 1]) : "", upper = target < remaining.length ? positionOf(remaining[target]) : "";
  try { pos = keyBetween(lower, upper); }
  catch { return "invalid"; }
  if (!validColumnPosition(pos) || lower !== "" && pos <= lower || upper !== "" && pos >= upper) return "invalid";
  let id: OpId;
  try { [id] = doc.allocateOpIds(1); } catch { return "invalid"; }
  const op = { t: "bmove" as const, id, block: { ...snapshot.block }, parent: { ...snapshot.parent }, pos };
  doc.apply(op); tx.ops.push(op);
  return "applied";
}

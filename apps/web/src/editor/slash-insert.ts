import { eqId, ROOT, Tx, type Doc, type OpId } from "@jiange/collab";
import { collapsed, type Pos, type Sel } from "./model";

/** A typed query is identified by the actual characters, not cursor offsets. */
export interface SlashQuery {
  doc: Doc;
  block: OpId;
  parent: OpId;
  type: string;
  kind: "/" | "@";
  ids: OpId[];
}

export function captureSlashQuery(doc: Doc, at: Pos, end: Pos, kind: "/" | "@"): SlashQuery | null {
  if (!doc.hasBlock(at.b) || !eqId(at.b, end.b) || at.o < 0 || end.o <= at.o) return null;
  const ids = doc.visibleIds(at.b), chars = doc.richChars(at.b);
  if (end.o > ids.length || chars[at.o]?.ch !== kind || chars.slice(at.o, end.o).some((char) => !!char.marks.math)) return null;
  const info = doc.blockInfo(at.b);
  if (!eqId(info.parent, ROOT)) return null;
  return { doc, block: at.b, parent: info.parent, type: info.type, kind, ids: ids.slice(at.o, end.o) };
}

/** Resolve only the same, contiguous characters in the same block and location. */
export function resolveSlashQuery(doc: Doc, query: SlashQuery): { start: number; end: number; text: string } | null {
  if (query.doc !== doc || !query.ids.length || !doc.hasBlock(query.block)) return null;
  const info = doc.blockInfo(query.block);
  if (info.type !== query.type || !eqId(info.parent, query.parent) || !eqId(info.parent, ROOT)) return null;
  const ids = doc.visibleIds(query.block), start = ids.findIndex((id) => eqId(id, query.ids[0]));
  if (start < 0 || query.ids.some((id, i) => !ids[start + i] || !eqId(id, ids[start + i]))) return null;
  const chars = doc.richChars(query.block).slice(start, start + query.ids.length);
  if (chars[0]?.ch !== query.kind || chars.some((char) => !!char.marks.math)) return null;
  return { start, end: start + query.ids.length, text: chars.map((char) => char.ch).join("") };
}

/** Update a verified query after one synchronous local append or deletion. */
export function updateSlashQuery(query: SlashQuery, cursor: Pos, action: "append" | "delete"): SlashQuery | null {
  const doc = query.doc;
  if (!doc.hasBlock(query.block) || !eqId(cursor.b, query.block)) return null;
  const info = doc.blockInfo(query.block);
  if (info.type !== query.type || !eqId(info.parent, query.parent) || !eqId(info.parent, ROOT)) return null;
  const ids = doc.visibleIds(query.block), start = ids.findIndex((id) => eqId(id, query.ids[0]));
  if (start < 0 || cursor.o <= start || cursor.o > ids.length) return null;
  const next = ids.slice(start, cursor.o);
  const shared = Math.min(next.length, query.ids.length);
  if (next.slice(0, shared).some((id, i) => !eqId(id, query.ids[i]))) return null;
  if (action === "append" ? next.length <= query.ids.length : next.length >= query.ids.length) return null;
  const result = { ...query, ids: next };
  const resolved = resolveSlashQuery(doc, result);
  return resolved && !/\s/.test(resolved.text) && [...resolved.text].length <= 16 ? result : null;
}

/** Remove only the verified command, returning its current insertion offset. */
export function consumeSlashQuery(tx: Tx, query: SlashQuery): number | null {
  const range = resolveSlashQuery(tx.doc, query);
  if (!range) return null;
  tx.delete(query.block, range.start, range.end);
  return range.start;
}

/** Capture the exact local command characters before opening an async dialog. */
export interface SlashInsertion {
  doc: Doc;
  anchor: OpId;
  beforeAnchor: boolean;
  commandIds: OpId[] | null;
  parent?: OpId;
  type?: string;
}

export function captureSlashInsertion(doc: Doc, at: Pos, sel: Sel | null, fromButton: boolean, insertAfter?: OpId): SlashInsertion | null {
  const anchor = insertAfter ?? at.b;
  if (!doc.hasBlock(anchor)) return null;
  const info = doc.blockInfo(anchor);
  if (!eqId(info.parent, ROOT)) return null;
  if (fromButton) return { doc, anchor, beforeAnchor: !insertAfter, commandIds: null, parent: info.parent, type: info.type };
  if (!sel || !collapsed(sel) || !eqId(sel.f.b, at.b) || at.o < 0 || sel.f.o <= at.o) return null;
  const ids = doc.visibleIds(at.b);
  const chars = doc.richChars(at.b);
  if (sel.f.o > ids.length || chars[at.o]?.ch !== "/" || chars.slice(at.o, sel.f.o).some((char) => !!char.marks.math)) return null;
  return { doc, anchor, beforeAnchor: at.o === 0 && sel.f.o === ids.length, commandIds: ids.slice(at.o, sel.f.o), parent: info.parent, type: info.type };
}

/**
 * Apply only if the captured command still exists unchanged and contiguously.
 * Never move or delete unrelated paragraph text: it may have been authored by
 * another replica. A command in the middle cannot safely split a CRDT block,
 * so report it to the caller rather than silently changing content order.
 */
export function insertSlashBlock(tx: Tx, captured: SlashInsertion, type: string, props: Record<string, string>, text = ""): Pos | "middle" | null {
  const doc = tx.doc;
  if (doc !== captured.doc || !doc.hasBlock(captured.anchor)) return null;
  const info = doc.blockInfo(captured.anchor);
  if (!eqId(info.parent, ROOT)) return null;
  if ((captured.parent && !eqId(info.parent, captured.parent)) || (captured.type && captured.type !== info.type)) return null;
  let commandStart = -1;
  let beforeAnchor = captured.beforeAnchor;
  if (captured.commandIds) {
    const ids = doc.visibleIds(captured.anchor);
    commandStart = ids.findIndex((id) => eqId(id, captured.commandIds![0]));
    if (commandStart < 0 || captured.commandIds.some((id, i) => !ids[commandStart + i] || !eqId(id, ids[commandStart + i]))) return null;
    const commandEnd = commandStart + captured.commandIds.length;
    if (doc.richChars(captured.anchor).slice(commandStart, commandEnd).some((char) => !!char.marks.math)) return null;
    if (commandStart > 0 && commandEnd < ids.length) return "middle";
    beforeAnchor = commandStart === 0;
  }
  const siblings = doc.children(info.parent);
  const index = siblings.findIndex((id) => eqId(id, captured.anchor));
  if (index < 0) return null;
  if (captured.commandIds) tx.delete(captured.anchor, commandStart, commandStart + captured.commandIds.length);
  const after = beforeAnchor ? (index > 0 ? siblings[index - 1] : null) : captured.anchor;
  const block = tx.create(type, after, info.parent);
  // Record properties separately so undo can clear our values while leaving
  // the block itself alive for operations from collaborators that arrive late.
  for (const [key, value] of Object.entries(props)) if (value) tx.setProp(block, key, value);
  if (text) tx.insert(block, 0, text);
  // A slash-only paragraph remains after the new block; otherwise create a
  // new writable paragraph following the inserted atomic block.
  if (beforeAnchor && doc.blockInfo(captured.anchor).type === "paragraph") return { b: captured.anchor, o: 0 };
  return { b: tx.create("paragraph", block, info.parent), o: 0 };
}

/** Never tombstone inserted blocks on undo: remote edits can arrive later. */
export function safeSlashUndo(tx: Tx): Tx {
  const safe = new Tx(tx.doc);
  safe.items = tx.items.filter((item) => item.k !== "create");
  return safe;
}

/** A source edit may not overwrite content changed while its dialog was open. */
export function sourceUnchanged(doc: Doc, block: OpId, type: string, chars: OpId[]): boolean {
  if (!doc.hasBlock(block) || doc.blockInfo(block).type !== type) return false;
  const now = doc.visibleIds(block);
  return now.length === chars.length && chars.every((id, i) => eqId(id, now[i]));
}

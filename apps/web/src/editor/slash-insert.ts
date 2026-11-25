import { eqId, idKey, ROOT, Tx, type Doc, type OpId } from "@zseven-w/collab";
import { collapsed, mathSpansFromChars, TEXTLESS, type Pos, type Sel } from "./model";
import { isMultiwordSlashPrefix } from "./pinyin";

/** Open slash commands only at the beginning of a line or after whitespace. */
export function canOpenSlashMenu(doc: Doc, slash: Pos): boolean {
  if (!doc.hasBlock(slash.b) || !Number.isSafeInteger(slash.o) || slash.o < 0) return false;
  const info = doc.blockInfo(slash.b), chars = doc.richChars(slash.b);
  if (info.type === "code" || chars[slash.o]?.ch !== "/" || chars[slash.o].marks.code || chars[slash.o].marks.math) return false;
  return slash.o === 0 || /\s/u.test(chars[slash.o - 1]?.ch ?? "");
}

export function validSlashQueryText(kind: "/" | "@", text: string): boolean {
  return text.startsWith(kind) && [...text].length <= 32 && (!/\s/u.test(text) || kind === "/" && isMultiwordSlashPrefix(text.slice(1)));
}

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
  return resolved && validSlashQueryText(query.kind, resolved.text) ? result : null;
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
  tailIds?: OpId[] | null;
  parent?: OpId;
  type?: string;
}

export function captureSlashInsertion(doc: Doc, at: Pos, sel: Sel | null, fromButton: boolean, insertAfter?: OpId): SlashInsertion | null {
  const anchor = insertAfter ?? at.b;
  if (!doc.hasBlock(anchor)) return null;
  const info = doc.blockInfo(anchor);
  if (!eqId(info.parent, ROOT)) return null;
  if (fromButton) return { doc, anchor, beforeAnchor: !insertAfter, commandIds: null, tailIds: null, parent: info.parent, type: info.type };
  if (!sel || !collapsed(sel) || !eqId(sel.f.b, at.b) || at.o < 0 || sel.f.o <= at.o) return null;
  const ids = doc.visibleIds(at.b);
  const chars = doc.richChars(at.b);
  if (sel.f.o > ids.length || chars[at.o]?.ch !== "/" || chars.slice(at.o, sel.f.o).some((char) => !!char.marks.math)) return null;
  return { doc, anchor, beforeAnchor: at.o === 0 && sel.f.o === ids.length, commandIds: ids.slice(at.o, sel.f.o), tailIds: ids.slice(sel.f.o), parent: info.parent, type: info.type };
}

function insertRichTail(tx: Tx, target: OpId, tail: { ch: string; marks: Record<string, string> }[]): void {
  if (!tail.length) return;
  tx.insert(target, 0, tail.map((c) => c.ch).join(""), tail.map((c) => c.marks));
  const ids = tx.doc.visibleIds(target);
  for (const span of mathSpansFromChars(tail)) {
    if (ids[span.start]) tx.format(target, span.start, span.end, "mathId", idKey(ids[span.start]));
  }
}

/**
 * Insert a block-level element via synchronous slash command, safely splitting
 * the current paragraph if the command appeared in the middle of existing text.
 */
export function insertBlockAtSlashOffset(
  tx: Tx,
  block: OpId,
  offset: number,
  type: string,
  props: Record<string, string> = {},
  text = "",
): { inserted: OpId; caret: Pos } {
  const doc = tx.doc;
  const info = doc.blockInfo(block);
  const n = doc.visibleIds(block).length;
  const setProps = (target: OpId) => {
    for (const [k, v] of Object.entries(props)) if (v) tx.setProp(target, k, v);
  };
  // Empty non-textless paragraph: convert in place and ensure a trailing paragraph.
  if (n === 0 && !TEXTLESS.has(info.type)) {
    tx.setProp(block, "type", type);
    setProps(block);
    if (text) tx.insert(block, 0, text);
    const next = tx.create("paragraph", block, info.parent);
    return { inserted: block, caret: { b: next, o: 0 } };
  }
  // At start of a non-empty paragraph: insert before the paragraph and keep its text intact.
  if (offset === 0 && n > 0 && !TEXTLESS.has(info.type)) {
    const siblings = doc.children(info.parent);
    const index = siblings.findIndex((id) => eqId(id, block));
    const after = index > 0 ? siblings[index - 1] : null;
    const inserted = tx.create(type, after, info.parent);
    setProps(inserted);
    if (text) tx.insert(inserted, 0, text);
    return { inserted, caret: { b: block, o: 0 } };
  }
  // In the middle of a paragraph: split tail into a new paragraph after the inserted block.
  if (offset > 0 && offset < n && !TEXTLESS.has(info.type)) {
    const tail = doc.richChars(block).slice(offset);
    tx.delete(block, offset, n);
    const inserted = tx.create(type, block, info.parent);
    setProps(inserted);
    if (text) tx.insert(inserted, 0, text);
    const tailBlock = tx.create("paragraph", inserted, info.parent);
    insertRichTail(tx, tailBlock, tail);
    return { inserted, caret: { b: tailBlock, o: 0 } };
  }
  // At end of a paragraph or after a textless block: insert directly after.
  const inserted = tx.create(type, block, info.parent);
  setProps(inserted);
  if (text) tx.insert(inserted, 0, text);
  const next = tx.create("paragraph", inserted, info.parent);
  return { inserted, caret: { b: next, o: 0 } };
}

/**
 * Apply only if the captured command still exists unchanged and contiguously.
 * Never move or delete unrelated paragraph text authored concurrently by
 * another replica. Local mid-paragraph commands split cleanly when the suffix
 * still matches the captured tail IDs; concurrent edits on both sides still
 * report "middle" so peer text is never silently reordered.
 */
export function insertSlashBlock(tx: Tx, captured: SlashInsertion, type: string, props: Record<string, string>, text = ""): Pos | "middle" | null {
  const doc = tx.doc;
  if (doc !== captured.doc || !doc.hasBlock(captured.anchor)) return null;
  const info = doc.blockInfo(captured.anchor);
  if (!eqId(info.parent, ROOT)) return null;
  if ((captured.parent && !eqId(info.parent, captured.parent)) || (captured.type && captured.type !== info.type)) return null;
  let commandStart = -1;
  let commandEnd = -1;
  let beforeAnchor = captured.beforeAnchor;
  let splitTail: { ch: string; marks: Record<string, string> }[] | null = null;
  if (captured.commandIds) {
    const ids = doc.visibleIds(captured.anchor);
    commandStart = ids.findIndex((id) => eqId(id, captured.commandIds![0]));
    if (commandStart < 0 || captured.commandIds.some((id, i) => !ids[commandStart + i] || !eqId(id, ids[commandStart + i]))) return null;
    commandEnd = commandStart + captured.commandIds.length;
    if (doc.richChars(captured.anchor).slice(commandStart, commandEnd).some((char) => !!char.marks.math)) return null;
    if (commandStart > 0 && commandEnd < ids.length) {
      const currentTailIds = ids.slice(commandEnd);
      const expectedTailIds = captured.tailIds;
      const tailUnchanged = !!expectedTailIds
        && expectedTailIds.length === currentTailIds.length
        && expectedTailIds.every((id, i) => eqId(id, currentTailIds[i]));
      if (!tailUnchanged) return "middle";
      splitTail = doc.richChars(captured.anchor).slice(commandEnd);
    }
    beforeAnchor = commandStart === 0;
  }
  const siblings = doc.children(info.parent);
  const index = siblings.findIndex((id) => eqId(id, captured.anchor));
  if (index < 0) return null;
  if (captured.commandIds) {
    tx.delete(captured.anchor, commandStart, splitTail ? doc.visibleIds(captured.anchor).length : commandEnd);
  }
  const after = beforeAnchor ? (index > 0 ? siblings[index - 1] : null) : captured.anchor;
  const block = tx.create(type, after, info.parent);
  // Record properties separately so undo can clear our values while leaving
  // the block itself alive for operations from collaborators that arrive late.
  for (const [key, value] of Object.entries(props)) if (value) tx.setProp(block, key, value);
  if (text) tx.insert(block, 0, text);
  if (splitTail) {
    const tailBlock = tx.create("paragraph", block, info.parent);
    insertRichTail(tx, tailBlock, splitTail);
    return { b: tailBlock, o: 0 };
  }
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

import { eqId, Tx, type Doc, type OpId } from "@jiange/collab";
import { collapsed, type Pos, type Sel } from "./model";

/** Capture the exact local command characters before opening an async dialog. */
export interface SlashInsertion {
  doc: Doc;
  anchor: OpId;
  beforeAnchor: boolean;
  commandIds: OpId[] | null;
}

export function captureSlashInsertion(doc: Doc, at: Pos, sel: Sel | null, fromButton: boolean, insertAfter?: OpId): SlashInsertion | null {
  const anchor = insertAfter ?? at.b;
  if (!doc.hasBlock(anchor)) return null;
  if (fromButton) return { doc, anchor, beforeAnchor: !insertAfter, commandIds: null };
  if (!sel || !collapsed(sel) || !eqId(sel.f.b, at.b) || at.o < 0 || sel.f.o <= at.o) return null;
  const ids = doc.visibleIds(at.b);
  const chars = doc.richChars(at.b);
  if (sel.f.o > ids.length || chars[at.o]?.ch !== "/") return null;
  return { doc, anchor, beforeAnchor: at.o === 0 && sel.f.o === ids.length, commandIds: ids.slice(at.o, sel.f.o) };
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
  let commandStart = -1;
  let beforeAnchor = captured.beforeAnchor;
  if (captured.commandIds) {
    const ids = doc.visibleIds(captured.anchor);
    commandStart = ids.findIndex((id) => eqId(id, captured.commandIds![0]));
    if (commandStart < 0 || captured.commandIds.some((id, i) => !ids[commandStart + i] || !eqId(id, ids[commandStart + i]))) return null;
    const commandEnd = commandStart + captured.commandIds.length;
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

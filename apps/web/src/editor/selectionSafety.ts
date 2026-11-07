import { eqId, ROOT, type Doc, type OpId } from "@jiange/collab";
import type { Sel } from "./model";

/** Only root text blocks and direct children of visible column containers are rendered. */
function isVisibleEditorBlock(doc: Doc, block: OpId): boolean {
  if (!doc.hasBlock(block)) return false;
  const parent = doc.blockInfo(block).parent;
  if (eqId(parent, ROOT)) return true;
  return doc.hasBlock(parent) && doc.blockInfo(parent).type === "columns" && eqId(doc.blockInfo(parent).parent, ROOT);
}

/** A peer may have deleted/moved the block or removed selected characters. */
export function validEditorSelection(doc: Doc, selection: Sel): boolean {
  for (const p of [selection.a, selection.f]) {
    if (!isVisibleEditorBlock(doc, p.b) || !Number.isSafeInteger(p.o) || p.o < 0 || p.o > doc.visibleIds(p.b).length) return false;
  }
  return true;
}

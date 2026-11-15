import { eqId, type Doc, type OpId } from "@jiange/collab";
import type { Pos } from "./model";

/** Retain the actual linked character IDs so remote edits cannot retarget an action. */
export interface LinkRange { doc: Doc; block: OpId; parent: OpId; type: string; ids: OpId[]; href: string }
export function captureLinkRange(doc: Doc, from: Pos, to: Pos, href: string): LinkRange | null {
  if (!eqId(from.b, to.b) || !doc.hasBlock(from.b) || from.o < 0 || to.o <= from.o) return null;
  const ids = doc.visibleIds(from.b), chars = doc.richChars(from.b);
  if (to.o > ids.length || chars.slice(from.o, to.o).some((char) => char.marks.link !== href || !!char.marks.math)) return null;
  const info = doc.blockInfo(from.b);
  return { doc, block: from.b, parent: info.parent, type: info.type, ids: ids.slice(from.o, to.o), href };
}
export function resolveLinkRange(doc: Doc, range: LinkRange): { from: Pos; to: Pos } | null {
  if (doc !== range.doc || !range.ids.length || !doc.hasBlock(range.block)) return null;
  const info = doc.blockInfo(range.block);
  if (info.type !== range.type || !eqId(info.parent, range.parent)) return null;
  const ids = doc.visibleIds(range.block), start = ids.findIndex((id) => eqId(id, range.ids[0]));
  if (start < 0 || range.ids.some((id, i) => !ids[start + i] || !eqId(id, ids[start + i]))) return null;
  if (doc.richChars(range.block).slice(start, start + range.ids.length).some((char) => char.marks.link !== range.href || !!char.marks.math)) return null;
  return { from: { b: range.block, o: start }, to: { b: range.block, o: start + range.ids.length } };
}
export function sameLinkRange(a: LinkRange, b: LinkRange): boolean {
  return a.doc === b.doc && eqId(a.block, b.block) && a.href === b.href && a.ids.length === b.ids.length && a.ids.every((id, i) => eqId(id, b.ids[i]));
}

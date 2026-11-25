import { eqId, type Doc, type OpId } from "@zseven-w/collab";
import type { Pos } from "./model";

/** Retain the actual linked character IDs so remote edits cannot retarget an action. */
export interface LinkRange { doc: Doc; block: OpId; parent: OpId; type: string; ids: OpId[]; href: string; kind?: string; wholeLink: boolean }
export function captureLinkRange(doc: Doc, from: Pos, to: Pos, href: string, wholeLink = false): LinkRange | null {
  if (!eqId(from.b, to.b) || !doc.hasBlock(from.b) || from.o < 0 || to.o <= from.o) return null;
  const ids = doc.visibleIds(from.b), chars = doc.richChars(from.b);
  const kind = chars[from.o]?.marks.linkKind;
  const matches = (index: number) => !!chars[index] && chars[index].marks.link === href && chars[index].marks.linkKind === kind && !chars[index].marks.math && (!wholeLink || !chars[index].marks.mention);
  if (to.o > ids.length || chars.slice(from.o, to.o).some((_, i) => !matches(from.o + i))) return null;
  let start = from.o, end = to.o;
  if (wholeLink) { while (start > 0 && matches(start - 1)) start--; while (end < chars.length && matches(end)) end++; }
  const info = doc.blockInfo(from.b);
  return { doc, block: from.b, parent: info.parent, type: info.type, ids: ids.slice(start, end), href, kind, wholeLink };
}
export function resolveLinkRange(doc: Doc, range: LinkRange): { from: Pos; to: Pos } | null {
  if (doc !== range.doc || !range.ids.length || !doc.hasBlock(range.block)) return null;
  const info = doc.blockInfo(range.block);
  if (info.type !== range.type || !eqId(info.parent, range.parent)) return null;
  const ids = doc.visibleIds(range.block), start = ids.findIndex((id) => eqId(id, range.ids[0]));
  if (start < 0 || range.ids.some((id, i) => !ids[start + i] || !eqId(id, ids[start + i]))) return null;
  const chars = doc.richChars(range.block), end = start + range.ids.length;
  const matches = (index: number) => !!chars[index] && chars[index].marks.link === range.href && chars[index].marks.linkKind === range.kind && !chars[index].marks.math && (!range.wholeLink || !chars[index].marks.mention);
  if (chars.slice(start, end).some((_, i) => !matches(start + i))) return null;
  if (range.wholeLink && (matches(start - 1) || matches(end))) return null;
  return { from: { b: range.block, o: start }, to: { b: range.block, o: start + range.ids.length } };
}
export function sameLinkRange(a: LinkRange, b: LinkRange): boolean {
  return a.doc === b.doc && eqId(a.block, b.block) && a.href === b.href && a.kind === b.kind && a.ids.length === b.ids.length && a.ids.every((id, i) => eqId(id, b.ids[i]));
}

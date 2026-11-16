import { eqId, type Doc, type OpId, type Tx } from "@jiange/collab";
import { safeURL } from "@/lib/safe-url";
import { captureCompositionAnchor, captureCompositionSelection, resolveCompositionAnchor, resolveCompositionSelection, type CompositionAnchor } from "./composition-anchor";
import type { Pos, Sel } from "./model";

export type InlineLinkAnchor = CompositionAnchor & { parent: OpId; type: string; text: string; marks: Record<string, string>[] };
export function captureInlineLink(doc: Doc, pos: Pos): InlineLinkAnchor | null {
  if (!doc.hasBlock(pos.b) || pos.o < 0 || pos.o > doc.visibleIds(pos.b).length) return null;
  const info = doc.blockInfo(pos.b);
  return { ...captureCompositionAnchor(doc, pos), parent: info.parent, type: info.type, text: "", marks: [] };
}
export function captureInlineLinkSelection(doc: Doc, selection: Sel): InlineLinkAnchor | null {
  const captured = captureCompositionSelection(doc, selection);
  if (!captured) return null;
  const start = Math.min(selection.a.o, selection.f.o), end = Math.max(selection.a.o, selection.f.o), chars = doc.richChars(captured.block).slice(start, end);
  if (chars.some((char) => !!char.marks.math || char.ch === "\n" || char.ch === "\r")) return null;
  const info = doc.blockInfo(captured.block);
  return { ...captured, parent: info.parent, type: info.type, text: chars.map((char) => char.ch).join(""), marks: chars.map((char) => ({ ...char.marks })) };
}
export function resolveInlineLink(doc: Doc, captured: InlineLinkAnchor): Pos | null {
  const selection = captured.selected.length ? resolveCompositionSelection(doc, captured) : null;
  const pos = captured.selected.length ? selection?.a : resolveCompositionAnchor(doc, captured);
  if (!pos) return null;
  const info = doc.blockInfo(pos.b);
  return info.type === captured.type && eqId(info.parent, captured.parent) ? pos : null;
}
function equalMarks(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}
export function insertInlineLink(tx: Tx, captured: InlineLinkAnchor, text: string, url: string): Pos | null {
  const label = text, href = safeURL(url.trim());
  if (!label.trim() || [...label].length > 5000 || !href || href.length > 8192) return null;
  const pos = resolveInlineLink(tx.doc, captured);
  if (!pos) return null;
  if (captured.selected.length) {
    const selection = resolveCompositionSelection(tx.doc, captured);
    if (!selection) return null;
    const chars = tx.doc.richChars(pos.b).slice(selection.a.o, selection.f.o);
    if (chars.some((char, i) => char.marks.link !== captured.marks[i]?.link || !!char.marks.math)) return null;
    if (label === captured.text) {
      tx.format(pos.b, selection.a.o, selection.f.o, "link", href);
      return selection.f;
    }
    // Replacing mixed formatting would discard a collaborator's styles.
    if (chars.some((char, i) => !equalMarks(char.marks, captured.marks[i])) || chars.some((char) => !equalMarks(char.marks, chars[0].marks))) return null;
    const marks = { ...chars[0].marks, link: href };
    tx.delete(pos.b, selection.a.o, selection.f.o);
    const length = tx.insert(pos.b, selection.a.o, label, marks);
    return length ? { b: pos.b, o: selection.a.o + length } : null;
  }
  const length = tx.insert(pos.b, pos.o, label, { link: href });
  return length ? { b: pos.b, o: pos.o + length } : null;
}

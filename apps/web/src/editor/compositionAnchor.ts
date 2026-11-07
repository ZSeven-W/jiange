import { eqId, idKey, ROOT, type Doc, type OpId } from "@jiange/collab";
import type { Pos, Sel } from "./model";

export interface CompositionAnchor {
  doc: Doc;
  block: OpId;
  anchor: ReturnType<Doc["anchorAt"]>;
  selected: OpId[];
}

export function captureCompositionAnchor(doc: Doc, pos: Pos, end = pos.o): CompositionAnchor {
  return { doc, block: pos.b, anchor: doc.anchorAt(pos.b, pos.o), selected: doc.visibleIds(pos.b).slice(pos.o, end) };
}

/** Cross-block replacement requires tombstoning blocks and cannot preserve late peer edits. */
export function captureCompositionSelection(doc: Doc, selection: Sel): CompositionAnchor | null {
  if (!eqId(selection.a.b, selection.f.b) || !doc.hasBlock(selection.a.b)) return null;
  const start = Math.min(selection.a.o, selection.f.o), end = Math.max(selection.a.o, selection.f.o);
  const length = doc.visibleIds(selection.a.b).length;
  if (start < 0 || end > length) return null;
  return captureCompositionAnchor(doc, { b: selection.a.b, o: start }, end);
}

/** Do not resolve a missing anchor to the end and silently move the input. */
export function resolveCompositionAnchor(doc: Doc, captured: CompositionAnchor): Pos | null {
  if (doc !== captured.doc || !doc.hasBlock(captured.block) || !doc.view().blocks.some((b) => b.id === idKey(captured.block))) return null;
  if (!eqId(captured.anchor.char, ROOT) && !doc.visibleIds(captured.block).some((id) => eqId(id, captured.anchor.char))) return null;
  return { b: captured.block, o: doc.resolveAnchor(captured.block, captured.anchor) };
}

/** A selected range is replaced only if its original characters are intact. */
export function resolveCompositionSelection(doc: Doc, captured: CompositionAnchor): Sel | null {
  if (doc !== captured.doc || !doc.hasBlock(captured.block) || !doc.view().blocks.some((b) => b.id === idKey(captured.block))) return null;
  if (!captured.selected.length) {
    const pos = resolveCompositionAnchor(doc, captured);
    return pos ? { a: pos, f: pos } : null;
  }
  const ids = doc.visibleIds(captured.block);
  const start = ids.findIndex((id) => eqId(id, captured.selected[0]));
  if (start < 0 || captured.selected.some((id, i) => !ids[start + i] || !eqId(id, ids[start + i]))) return null;
  return { a: { b: captured.block, o: start }, f: { b: captured.block, o: start + captured.selected.length } };
}

import { eqId, type Doc, type OpId, type Tx } from "@jiange/collab";
import { safeURL } from "@/lib/safeURL";
import { captureCompositionAnchor, resolveCompositionAnchor, type CompositionAnchor } from "./compositionAnchor";
import type { Pos } from "./model";

export type InlineLinkAnchor = CompositionAnchor & { parent: OpId; type: string };
export function captureInlineLink(doc: Doc, pos: Pos): InlineLinkAnchor | null {
  if (!doc.hasBlock(pos.b) || pos.o < 0 || pos.o > doc.visibleIds(pos.b).length) return null;
  const info = doc.blockInfo(pos.b);
  return { ...captureCompositionAnchor(doc, pos), parent: info.parent, type: info.type };
}
export function resolveInlineLink(doc: Doc, captured: InlineLinkAnchor): Pos | null {
  const pos = resolveCompositionAnchor(doc, captured);
  if (!pos) return null;
  const info = doc.blockInfo(pos.b);
  return info.type === captured.type && eqId(info.parent, captured.parent) ? pos : null;
}
export function insertInlineLink(tx: Tx, captured: InlineLinkAnchor, text: string, url: string): Pos | null {
  const label = text.trim(), href = safeURL(url.trim());
  if (!label || [...label].length > 5000 || !href || href.length > 8192) return null;
  const pos = resolveInlineLink(tx.doc, captured);
  if (!pos) return null;
  const length = tx.insert(pos.b, pos.o, label, { link: href });
  return length ? { b: pos.b, o: pos.o + length } : null;
}

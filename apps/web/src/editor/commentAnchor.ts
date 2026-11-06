import { eqId, idKey, type Doc } from "@jiange/collab";
import { TEXTLESS, type Sel } from "./model";

export type CommentSelection =
  | { ok: true; anchor: { block: string; startChar: string; endChar: string; quote: string } }
  | { ok: false; reason: "cross-block" | "empty" | "invalid" };

/** The comment API stores one block and inclusive first/last character IDs. */
export function commentSelection(doc: Doc, sel: Sel): CommentSelection {
  if (!doc.hasBlock(sel.a.b) || !doc.hasBlock(sel.f.b)) return { ok: false, reason: "invalid" };
  if (!eqId(sel.a.b, sel.f.b)) return { ok: false, reason: "cross-block" };
  if (TEXTLESS.has(doc.blockInfo(sel.a.b).type)) return { ok: false, reason: "invalid" };
  const ids = doc.visibleIds(sel.a.b);
  const start = Math.min(sel.a.o, sel.f.o);
  const end = Math.max(sel.a.o, sel.f.o);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > ids.length) return { ok: false, reason: "invalid" };
  if (start === end) return { ok: false, reason: "empty" };
  return {
    ok: true,
    anchor: {
      block: idKey(sel.a.b),
      startChar: idKey(ids[start]),
      endChar: idKey(ids[end - 1]),
      quote: doc.richChars(sel.a.b).slice(start, end).slice(0, 200).map((c) => c.ch).join(""),
    },
  };
}

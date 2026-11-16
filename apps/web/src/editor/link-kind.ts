import { eqId, type Tx } from "@jiange/collab";
import { isDocumentReferenceMarks, isDocumentReferenceURL, safeURL } from "@/lib/safe-url";
import { isSourceBlock, len, normalize, type Sel } from "./model";

/** Apply or remove a manually authored text hyperlink with explicit semantics. */
export function toggleTextLink(tx: Tx, selection: Sel, value: string): "applied" | "blocked" | "invalid" {
  const href = safeURL(value.trim());
  if (!href || href.length > 8192) return "invalid";
  const { start, end, blocks } = normalize(tx.doc, selection);
  const segments = blocks.filter((block) => !isSourceBlock(tx.doc, block)).map((block) => ({ block, from: eqId(block, start.b) ? start.o : 0, to: eqId(block, end.b) ? end.o : len(tx.doc, block) })).filter((part) => part.to > part.from);
  if (!segments.length) return "blocked";
  const chars = segments.flatMap((part) => tx.doc.richChars(part.block).slice(part.from, part.to));
  if (chars.some((char) => !!char.marks.math || !!char.marks.mention || isDocumentReferenceMarks(char.marks))) return "blocked";
  const remove = chars.every((char) => char.marks.link === href);
  for (const part of segments) {
    tx.format(part.block, part.from, part.to, "link", remove ? null : href);
    tx.format(part.block, part.from, part.to, "linkKind", !remove && isDocumentReferenceURL(href) ? "text" : null);
  }
  return "applied";
}

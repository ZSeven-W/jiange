import { eqId, idKey, type Doc, type OpId } from "@jiange/collab";
import type { ClipBlock } from "./model";

export type PastedDocumentURL = { id: number; href: string } | { token: string; href: string };

/** Do not reinterpret arbitrary URLs, clipboard HTML or unrelated app routes. */
export function pastedDocumentURL(raw: string, plain: string, origin: string, pathname: string): PastedDocumentURL | null {
  if (raw || !plain || plain.length > 8192 || plain !== plain.trim() || /[\r\n\t]/.test(plain)) return null;
  let url: URL;
  try { url = new URL(plain); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== origin || url.pathname !== pathname || url.search || url.username || url.password) return null;
  const shared = /^#\/(s|p)\/([A-Za-z0-9_-]{1,256})$/.exec(url.hash);
  if (shared) return { token: shared[2], href: `#/${shared[1]}/${shared[2]}` };
  const match = /^#\/doc\/([1-9]\d*)(?:\?(.*))?$/.exec(url.hash);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) return null;
  let href = `#/doc/${id}`;
  if (match[2] !== undefined) {
    const query = new URLSearchParams(match[2]), entries = [...query.entries()];
    if (entries.length !== 1 || entries[0][0] !== "block" || !/^\d+:\d+$/.test(entries[0][1]) || entries[0][1].split(":").some((n) => !Number.isSafeInteger(Number(n)))) return null;
    href += `?block=${encodeURIComponent(entries[0][1])}`;
  }
  return { id, href };
}

export function documentLinkClip(target: PastedDocumentURL, originalTitle: string): ClipBlock[] | null {
  const title = originalTitle.trim() || "未命名文档";
  if ([...title].length > 5000 || /[\r\n]/.test(title)) return null;
  return [{ type: "paragraph", props: {}, chars: [...title].map((ch) => ({ ch, marks: { link: target.href, linkKind: "reference" } })) }];
}

export interface PastedLinkAnchor { doc: Doc; block: OpId; parent: OpId; type: string; ids: OpId[]; text: string }

/** Capture the newly inserted literal URL. Later conversion must not touch
 * text another editor has changed, moved, formatted or split. */
export function capturePastedLink(doc: Doc, block: OpId, start: number, text: string): PastedLinkAnchor | null {
  const ids = doc.visibleIds(block).slice(start, start + [...text].length), chars = doc.richChars(block).slice(start, start + ids.length);
  if (!ids.length || chars.map((c) => c.ch).join("") !== text || chars.some((c) => Object.keys(c.marks).length !== 0)) return null;
  const info = doc.blockInfo(block);
  return { doc, block: { ...block }, parent: { ...info.parent }, type: info.type, ids: ids.map((id) => ({ ...id })), text };
}

export function resolvePastedLink(doc: Doc, anchor: PastedLinkAnchor): { start: number; end: number } | null {
  if (doc !== anchor.doc || !doc.hasBlock(anchor.block) || !doc.view().blocks.some((item) => item.id === idKey(anchor.block))) return null;
  const info = doc.blockInfo(anchor.block);
  if (info.type !== anchor.type || !eqId(info.parent, anchor.parent)) return null;
  const ids = doc.visibleIds(anchor.block), start = ids.findIndex((id) => eqId(id, anchor.ids[0]));
  if (start < 0 || anchor.ids.some((id, i) => !ids[start + i] || !eqId(id, ids[start + i]))) return null;
  const end = start + anchor.ids.length, chars = doc.richChars(anchor.block).slice(start, end);
  if (chars.map((c) => c.ch).join("") !== anchor.text || chars.some((c) => Object.keys(c.marks).length !== 0)) return null;
  return { start, end };
}

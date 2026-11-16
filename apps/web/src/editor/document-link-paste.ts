import type { ClipBlock } from "./model";

/** Convert only an exact same-origin, same-app document URL whose title is
 * already in the current user's document list. Other links remain literal. */
export function pastedDocumentLink(raw: string, plain: string, origin: string, pathname: string, docs: readonly { id: number; title: string }[]): ClipBlock[] | null {
  if (raw || !plain || plain !== plain.trim() || /[\r\n\t]/.test(plain)) return null;
  let url: URL;
  try { url = new URL(plain); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== origin || url.pathname !== pathname || url.search || url.username || url.password) return null;
  const match = /^#\/doc\/([1-9]\d*)$/.exec(url.hash);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) return null;
  const doc = docs.find((item) => item.id === id);
  if (!doc) return null;
  const title = doc.title.trim() || "未命名文档";
  if ([...title].length > 5000 || /[\r\n]/.test(title)) return null;
  const href = `#/doc/${id}`;
  return [{ type: "paragraph", props: {}, chars: [...title].map((ch) => ({ ch, marks: { link: href } })) }];
}

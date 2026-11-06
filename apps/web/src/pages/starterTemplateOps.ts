import { ROOT, Tx, type Doc, type OpId } from "@jiange/collab";
import { bodyBlocks, TITLE } from "@/editor/model";
import { parseMarkdown } from "@/lib/markdown";

/** Do not replace an existing block or nested content when inserting a starter. */
export function isEmptyStarterDocument(doc: Doc): boolean {
  const blocks = bodyBlocks(doc);
  if (blocks.length !== 1) return false;
  const first = blocks[0];
  const info = doc.blockInfo(first);
  return info.type === "paragraph" && doc.visibleIds(first).length === 0 && doc.children(first).length === 0 && Object.keys(info.props).length === 0;
}

/** Insert new blocks ahead of the original empty paragraph; never mutate or delete it. */
export function insertStarterTemplate(doc: Doc, markdown: string): Tx | null {
  if (!isEmptyStarterDocument(doc)) return null;
  const seeds = parseMarkdown(markdown);
  if (!seeds.length || seeds.some((s) => s.type === "image" || s.type === "file")) return null;
  const tx = new Tx(doc);
  let after: OpId | null = doc.hasBlock(TITLE) ? TITLE : null;
  for (const seed of seeds) {
    const block = tx.create(seed.type, after, ROOT, seed.props);
    if (seed.spans.length && seed.type !== "code") {
      const text = seed.spans.map((s) => s.text).join("");
      const marks = seed.spans.flatMap((s) => Array.from({ length: [...s.text].length }, () => s.marks));
      tx.insert(block, 0, text, marks);
    } else if (seed.text) tx.insert(block, 0, seed.text);
    after = block;
  }
  return tx;
}
/** Imported remote attachments need an upload/conversion flow not supported here. */
export function hasUnsupportedImportBlocks(markdown: string): boolean {
  return /!\[[^\]]*\]\s*(?:\([^)]*\)|\[[^\]]*\])/s.test(markdown)
    || /<img\b/i.test(markdown)
    || parseMarkdown(markdown).some((seed) => seed.type === "image" || seed.type === "file");
}

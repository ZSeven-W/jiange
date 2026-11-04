import { Doc, ROOT, Tx, type OpId } from "@jiange/collab";
import { parseMarkdown } from "./markdown";

/**
 * Builds the ops that replace a doc's content with a markdown import:
 * existing blocks (except the title) are deleted, then the parsed blocks are
 * created with text, marks and props — ordinary ops, so peers converge live
 * and the local undo stack can revert the whole import in one step.
 */
export function importMarkdownOps(doc: Doc, md: string) {
  const tx = new Tx(doc);
  const view = doc.view();
  const parseId = (s: string): OpId | null => {
    const [c, clock] = s.split(":");
    if (!c || !clock) return null;
    return { client: Number(c), clock: Number(clock) };
  };
  const title = view.blocks.find((b) => b.type === "title");
  for (const b of view.blocks) {
    if (b.type === "title") continue;
    const id = parseId(b.id);
    if (id) tx.deleteBlock(id);
  }
  let after = title ? parseId(title.id) : null;
  for (const seed of parseMarkdown(md)) {
    const id = tx.create(seed.type, after, ROOT, seed.props);
    if (seed.spans.length && seed.type !== "code") {
      const text = seed.spans.map((s) => s.text).join("");
      const marks = seed.spans.flatMap((s) => Array.from({ length: [...s.text].length }, () => s.marks));
      tx.insert(id, 0, text, marks);
    } else if (seed.type === "code" && seed.text) {
      tx.insert(id, 0, seed.text);
    }
    after = id;
  }
  return tx;
}

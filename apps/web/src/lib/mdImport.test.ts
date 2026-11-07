import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { bodyBlocks } from "@/editor/model";
import { appendMarkdownOps, importMarkdownOps } from "./mdImport";
import { viewToMarkdown } from "./markdown";

describe("Markdown import", () => {
  it("appends content without replacing existing blocks", () => {
    const doc = new Doc(1);
    const initial = new Tx(doc);
    const first = initial.create("paragraph", null, ROOT);
    initial.insert(first, 0, "原内容");
    appendMarkdownOps(doc, "$$x^2$$");
    const blocks = bodyBlocks(doc);
    expect(doc.text(first)).toBe("原内容");
    expect(doc.blockInfo(blocks[1]).type).toBe("math");
    expect(doc.text(blocks[1])).toBe("x^2");
  });
  it("preserves math and diagram source and can be undone", () => {
    const doc = new Doc(1);
    const initial = new Tx(doc);
    const first = initial.create("paragraph", null, ROOT);
    initial.insert(first, 0, "原内容");
    const tx = importMarkdownOps(doc, "$$x^2$$\n\n```mermaid\ngraph TD; A-->B\n```");
    const blocks = bodyBlocks(doc);
    expect(doc.blockInfo(blocks[0]).type).toBe("math");
    expect(doc.text(blocks[0])).toBe("x^2");
    expect(doc.blockInfo(blocks[1]).type).toBe("diagram");
    expect(doc.text(blocks[1])).toContain("graph TD");
    const undo = new UndoManager();
    undo.record(tx, null, null);
    expect(undo.undo(doc)?.ops.length).toBeGreaterThan(0);
    expect(bodyBlocks(doc).map((b) => doc.text(b))).toEqual(["原内容"]);
  });
  it("round-trips actual collaborative blocks, Unicode and nested formatting", () => {
    const source = new Doc(1);
    const tx = new Tx(source);
    const plain = tx.create("paragraph", null, ROOT);
    tx.insert(plain, 0, "# 标题 [链接](https://x.dev) 😀 \\*");
    const styled = tx.create("paragraph", plain, ROOT);
    const text = "重要中文🙂";
    const marks = { bold: "1", italic: "1", link: "https://example.com/a(b)" };
    tx.insert(styled, 0, text, Array.from(text, () => marks));
    const code = tx.create("code", styled, ROOT, { lang: "js" });
    tx.insert(code, 0, "const x = 1;\n```\n结束");
    const target = new Doc(2);
    appendMarkdownOps(target, viewToMarkdown(source.view()));
    const comparable = (doc: Doc) => doc.view().blocks.map(({ type, spans, props }) => ({ type, spans, props }));
    expect(comparable(target)).toEqual(comparable(source));
  });
});

import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { bodyBlocks } from "@/editor/model";
import { appendMarkdownOps, importMarkdownOps } from "./mdImport";

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
});

import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { bodyBlocks } from "@/editor/model";
import { hasUnsupportedImportBlocks, insertStarterTemplate, isEmptyStarterDocument } from "./starterTemplateOps";

function setup(text = "") {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const first = tx.create("paragraph", null, ROOT);
  if (text) tx.insert(first, 0, text);
  return { doc, first };
}
describe("starter templates", () => {
  it("creates new blocks without altering the original empty paragraph", () => {
    const { doc, first } = setup();
    expect(isEmptyStarterDocument(doc)).toBe(true);
    const tx = insertStarterTemplate(doc, "## 会议议题\n\n- [ ] 确认时间");
    const blocks = bodyBlocks(doc);
    expect(tx?.ops.length).toBeGreaterThan(0);
    expect(doc.hasBlock(first)).toBe(true);
    expect(doc.blockInfo(first).type).toBe("paragraph");
    expect(doc.text(first)).toBe("");
    expect(doc.blockInfo(blocks[0]).type).toBe("h2");
    expect(doc.text(blocks[0])).toBe("会议议题");
    expect(doc.blockInfo(blocks[1]).type).toBe("todo");
    expect(doc.text(blocks[1])).toBe("确认时间");
    expect(tx?.ops.some((op) => op.t === "bdel" || op.t === "bset" && op.block.client === first.client && op.block.clock === first.clock)).toBe(false);
  });
  it("undoes a template without deleting text added to the original paragraph", () => {
    const { doc, first } = setup();
    const tx = insertStarterTemplate(doc, "## 模板标题");
    expect(tx).not.toBeNull();
    const undo = new UndoManager();
    undo.record(tx!, null, null, "template");
    doc.insertText(first, 0, "其他协作者的文字");
    expect(undo.undo(doc)?.ops.length).toBeGreaterThan(0);
    expect(doc.text(first)).toBe("其他协作者的文字");
    expect(bodyBlocks(doc)).toEqual([first]);
  });
  it("preserves formula and Mermaid source", () => {
    const { doc } = setup();
    insertStarterTemplate(doc, "$$x^2$$\n\n```mermaid\ngraph TD; A-->B\n```");
    const blocks = bodyBlocks(doc);
    expect(doc.blockInfo(blocks[0]).type).toBe("math");
    expect(doc.text(blocks[0])).toBe("x^2");
    expect(doc.blockInfo(blocks[1]).type).toBe("diagram");
    expect(doc.text(blocks[1])).toContain("graph TD");
  });
  it("refuses nonempty documents and unsupported remote attachments", () => {
    const { doc, first } = setup("已有内容");
    expect(insertStarterTemplate(doc, "## 模板")).toBeNull();
    expect(doc.text(first)).toBe("已有内容");
    expect(hasUnsupportedImportBlocks("![图片](https://example.com/p.png)")).toBe(true);
    expect(hasUnsupportedImportBlocks("正文 ![图片](https://example.com/p.png)" )).toBe(true);
    expect(hasUnsupportedImportBlocks("正文 ![图片][ref]\n\n[ref]: https://example.com/p.png")).toBe(true);
    expect(hasUnsupportedImportBlocks('<img src="https://example.com/p.png">')).toBe(true);
    expect(hasUnsupportedImportBlocks("[文件](https://example.com/f.pdf)")).toBe(true);
  });
  it("keeps template blocks available for remote edits that arrive after a safe undo", () => {
    const { doc } = setup();
    const tx = insertStarterTemplate(doc, "模板")!;
    const block = bodyBlocks(doc)[0];
    const peer = Doc.fromState(2, doc.encodeState());
    const late = peer.insertText(block, 2, "远端");
    const safe = new Tx(doc);
    safe.items = tx.items.filter((item) => item.k === "ins");
    const undo = new UndoManager();
    undo.record(safe, null, null);
    undo.undo(doc);
    if (late) doc.apply(late);
    expect(doc.hasBlock(block)).toBe(true);
    expect(doc.text(block)).toBe("远端");
  });
});

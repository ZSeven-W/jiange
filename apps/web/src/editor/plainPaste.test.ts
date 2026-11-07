import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { bodyBlocks, clipText, copyRange, parseText, pasteBlocks } from "./model";

function documentWith(text = "") {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const block = tx.create("paragraph", null, ROOT);
  if (text) tx.insert(block, 0, text);
  return { doc, block };
}

describe("plain text clipboard", () => {
  it.each(["# 标题", "- [x] 完成", "- [ ] 待办", "1. 列表", "> 引用", "  - 缩进", "😀\t内容"])("does not consume literal prefixes: %s", (text) => {
    const { doc, block } = documentWith();
    const tx = new Tx(doc);
    pasteBlocks(tx, { b: block, o: 0 }, parseText(text));
    expect(doc.text(block)).toBe(text);
    expect(doc.blockInfo(block).type).toBe("paragraph");
  });

  it("retains plain text inserted inside existing content", () => {
    const { doc, block } = documentWith("前后");
    pasteBlocks(new Tx(doc), { b: block, o: 1 }, parseText("# 标题"));
    expect(doc.text(block)).toBe("前# 标题后");
  });

  it("preserves multiline text, trailing newline and undo", () => {
    const { doc, block } = documentWith("前后");
    const tx = new Tx(doc);
    pasteBlocks(tx, { b: block, o: 1 }, parseText("# 标题\r\n- [x] 完成\n"));
    expect(bodyBlocks(doc).map((id) => doc.text(id))).toEqual(["前# 标题", "- [x] 完成", "后"]);
    const undo = new UndoManager();
    undo.record(tx, null, null);
    undo.undo(doc);
    expect(bodyBlocks(doc).map((id) => doc.text(id))).toEqual(["前后"]);
  });

  it("keeps rich internal clipboard marks instead of treating them as plain text", () => {
    const { doc, block } = documentWith("粗体");
    const marked = new Tx(doc);
    marked.format(block, 0, 2, "bold", "true");
    const clip = copyRange(doc, { a: { b: block, o: 0 }, f: { b: block, o: 2 } });
    expect(clipText(clip)).toBe("粗体");
    pasteBlocks(new Tx(doc), { b: block, o: 2 }, clip);
    expect(doc.text(block)).toBe("粗体粗体");
    expect(doc.richChars(block).slice(2).every((c) => c.marks.bold === "true")).toBe(true);
  });
});

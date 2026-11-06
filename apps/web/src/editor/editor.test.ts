import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { filterItems, pinyinMatch } from "./pinyin";
import { bodyBlocks, copyRange, deleteRange, isSourceBlock, joinBackward, joinForward, markdownShortcut, parseText, pasteBlocks, setBlockType, splitBlock, toggleMark, type Sel } from "./model";

function setup(...lines: string[]) {
  const d = new Doc(1);
  const tx = new Tx(d);
  let after = null;
  for (const l of lines) {
    const b = tx.create("paragraph", after, ROOT);
    if (l) tx.insert(b, 0, l);
    after = b;
  }
  return { d, blocks: bodyBlocks(d) };
}
const texts = (d: Doc) => bodyBlocks(d).map((b) => `${d.blockInfo(b).type}:${d.text(b)}`);

describe("pinyin", () => {
  it("matches abbreviations, full and mixed pinyin", () => {
    const py = ["yi", "ji", "biao", "ti"];
    for (const q of ["yjbt", "bt", "biaoti", "yijibt", "yjbiao", "biaot"]) expect(pinyinMatch(py, q)).toBe(true);
    for (const q of ["xyz", "tb", "yjbtx"]) expect(pinyinMatch(py, q)).toBe(false);
    expect(filterItems("bt").map((i) => i.id)).toEqual(["h1", "h2", "h3", "h4", "h5", "h6"]);
    expect(filterItems("yxlb").map((i) => i.id)).toEqual(["ordered"]);
    expect(filterItems("db").map((i) => i.id)).toContain("todo");
    expect(filterItems("代码").map((i) => i.id)).toEqual(["code"]);
  });
});

describe("block editing", () => {
  it("splits and joins blocks preserving marks", () => {
    const { d, blocks } = setup("helloworld");
    const tx = new Tx(d);
    tx.format(blocks[0], 3, 7, "bold", "true");
    const p = splitBlock(tx, { b: blocks[0], o: 5 });
    expect(texts(d)).toEqual(["paragraph:hello", "paragraph:world"]);
    expect(d.richChars(p.b).slice(0, 2).every((c) => c.marks.bold)).toBe(true);
    const back = joinBackward(tx, p.b);
    expect(back.o).toBe(5);
    expect(texts(d)).toEqual(["paragraph:helloworld"]);
    expect(d.richChars(blocks[0]).map((c) => (c.marks.bold ? 1 : 0)).join("")).toBe("0001111000");
  });

  it("deletes across blocks", () => {
    const { d, blocks } = setup("abc", "def", "ghi");
    const tx = new Tx(d);
    const p = deleteRange(tx, { a: { b: blocks[2], o: 1 }, f: { b: blocks[0], o: 2 } });
    expect(p.o).toBe(2);
    expect(texts(d)).toEqual(["paragraph:abhi"]);
  });

  it("applies markdown block and inline shortcuts", () => {
    const { d, blocks } = setup("## ", "todo **x**", "1. ");
    const tx = new Tx(d);
    markdownShortcut(tx, { b: blocks[0], o: 3 }, " ");
    markdownShortcut(tx, { b: blocks[1], o: 10 }, "*");
    markdownShortcut(tx, { b: blocks[2], o: 3 }, " ");
    expect(texts(d)).toEqual(["h2:", "paragraph:todo x", "ordered:"]);
    expect(d.richChars(blocks[1])[5].marks.bold).toBe("true");
  });

  it("empty list item + Enter becomes a paragraph; toggling marks across blocks", () => {
    const { d, blocks } = setup("", "ab", "cd");
    const tx = new Tx(d);
    tx.setProp(blocks[0], "type", "bullet");
    splitBlock(tx, { b: blocks[0], o: 0 });
    expect(d.blockInfo(blocks[0]).type).toBe("paragraph");
    const sel: Sel = { a: { b: blocks[1], o: 1 }, f: { b: blocks[2], o: 1 } };
    toggleMark(tx, sel, "italic");
    expect(d.richChars(blocks[1])[1].marks.italic).toBe("true");
    expect(d.richChars(blocks[2])[0].marks.italic).toBe("true");
    toggleMark(tx, sel, "italic");
    expect(d.richChars(blocks[2])[0].marks.italic).toBeUndefined();
  });

  it("copies and pastes rich blocks", () => {
    const { d, blocks } = setup("one", "two", "xy");
    const tx = new Tx(d);
    tx.setProp(blocks[1], "type", "h1");
    const clip = copyRange(d, { a: { b: blocks[0], o: 1 }, f: { b: blocks[1], o: 3 } });
    const end = pasteBlocks(tx, { b: blocks[2], o: 1 }, clip);
    expect(texts(d)).toEqual(["paragraph:one", "h1:two", "paragraph:xne", "h1:twoy"]);
    expect(end.o).toBe(3);
    expect(parseText("# T\n- a\n1. b").map((b) => b.type)).toEqual(["h1", "bullet", "ordered"]);
  });
});

describe("code block", () => {
  it("Enter on an empty last line exits the block", () => {
    const { d, blocks } = setup("x");
    const tx = new Tx(d);
    tx.setProp(blocks[0], "type", "code");
    const p1 = splitBlock(tx, { b: blocks[0], o: 1 });
    expect(d.text(blocks[0])).toBe("x\n");
    const p2 = splitBlock(tx, p1);
    expect(texts(d)).toEqual(["code:x", "paragraph:"]);
    expect(p2.o).toBe(0);
  });
});

describe("formula and diagram blocks", () => {
  it.each(["math", "diagram"])("preserves %s at adjacent Backspace/Delete and inside the block", (type) => {
    const { d, blocks } = setup("前文", "source", "后文");
    new Tx(d).setProp(blocks[1], "type", type);
    expect(isSourceBlock(d, blocks[1])).toBe(true);
    const tx = new Tx(d);
    expect(joinForward(tx, blocks[0])).toEqual({ b: blocks[0], o: 2 });
    expect(joinBackward(tx, blocks[2])).toEqual({ b: blocks[2], o: 0 });
    expect(joinBackward(tx, blocks[1])).toEqual({ b: blocks[1], o: 0 });
    expect(joinForward(tx, blocks[1])).toEqual({ b: blocks[1], o: 0 });
    deleteRange(tx, { a: { b: blocks[1], o: 0 }, f: { b: blocks[1], o: 6 } });
    expect(tx.ops).toHaveLength(0);
    expect(texts(d)).toEqual(["paragraph:前文", `${type}:source`, "paragraph:后文"]);
  });

  it.each(["math", "diagram"])("deletes selected text without merging across %s and supports undo", (type) => {
    const { d, blocks } = setup("前文内容", "公式源码", "后文内容");
    new Tx(d).setProp(blocks[1], "type", type);
    const tx = new Tx(d);
    const caret = deleteRange(tx, { a: { b: blocks[0], o: 2 }, f: { b: blocks[2], o: 2 } });
    expect(caret).toEqual({ b: blocks[0], o: 2 });
    expect(texts(d)).toEqual(["paragraph:前文", `${type}:公式源码`, "paragraph:内容"]);
    expect(tx.ops.every((op) => op.t !== "bdel")).toBe(true);
    const undo = new UndoManager();
    undo.record(tx, null, null);
    undo.undo(d);
    expect(texts(d)).toEqual(["paragraph:前文内容", `${type}:公式源码`, "paragraph:后文内容"]);
  });

  it("retains late remote changes to the formula block across a range deletion", () => {
    const { d, blocks } = setup("abc", "x", "def");
    new Tx(d).setProp(blocks[1], "type", "math");
    const peer = Doc.fromState(2, d.encodeState());
    const late = peer.insertText(blocks[1], 1, "+y");
    const tx = new Tx(d);
    deleteRange(tx, { a: { b: blocks[0], o: 1 }, f: { b: blocks[2], o: 2 } });
    if (late) d.apply(late);
    expect(d.hasBlock(blocks[1])).toBe(true);
    expect(d.text(blocks[1])).toBe("x+y");
    expect(texts(d)).toEqual(["paragraph:a", "math:x+y", "paragraph:f"]);
  });

  it("does not apply text formatting or paste to hidden sources", () => {
    const { d, blocks } = setup("abc", "x^2", "def");
    new Tx(d).setProp(blocks[1], "type", "math");
    const tx = new Tx(d);
    const all = { a: { b: blocks[0], o: 0 }, f: { b: blocks[2], o: 3 } };
    toggleMark(tx, all, "bold");
    setBlockType(tx, all, "h1");
    pasteBlocks(tx, { b: blocks[1], o: 0 }, parseText("不应写入"));
    expect(d.blockInfo(blocks[1]).type).toBe("math");
    expect(d.text(blocks[1])).toBe("x^2");
    expect(d.richChars(blocks[1]).every((c) => !c.marks.bold)).toBe(true);
  });

  it("inserts a paragraph after an atomic block on Enter", () => {
    const { d, blocks } = setup("x^2");
    new Tx(d).setProp(blocks[0], "type", "math");
    const next = splitBlock(new Tx(d), { b: blocks[0], o: 0 });
    expect(texts(d)).toEqual(["math:x^2", "paragraph:"]);
    expect(next.o).toBe(0);
  });
});

import { applyTableEdit, parseTableData } from "./model";

describe("table block transforms", () => {
  it("parses tableData with fallback", () => {
    expect(parseTableData(JSON.stringify([["a"], ["b"]]))).toEqual([["a"], ["b"]]);
    expect(parseTableData(undefined)[0].length).toBe(3);
    expect(parseTableData("not-json")[1].length).toBe(3);
  });
  it("adds/removes rows and columns", () => {
    const t = [["a", "b"], ["c", "d"]];
    expect(applyTableEdit(t, -1, 0, "")).toEqual([["a", "b"], ["c", "d"], ["", ""]]);
    expect(applyTableEdit(t, -2, 0, "")).toEqual([["a", "b", ""], ["c", "d", ""]]);
    expect(applyTableEdit(t, -3, 0, "")).toEqual([["c", "d"]]);
    expect(applyTableEdit([["x"]], -3, 0, "")).toEqual([["x"]]); // keep last row
  });
  it("writes one cell without touching others", () => {
    expect(applyTableEdit([["a", "b"], ["c", "d"]], 1, 0, "X")).toEqual([["a", "b"], ["X", "d"]]);
  });
});

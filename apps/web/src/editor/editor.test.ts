import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { filterItems, pinyinMatch } from "./pinyin";
import { bodyBlocks, copyRange, deleteRange, joinBackward, markdownShortcut, parseText, pasteBlocks, splitBlock, toggleMark, type Sel } from "./model";

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
    expect(filterItems("bt").map((i) => i.id)).toEqual(["h1", "h2", "h3"]);
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

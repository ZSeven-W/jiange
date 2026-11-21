import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { activeMarks, applyTableEdit, bodyBlocks, clipText, cmpPos, collapsed, copyRange, createBlankTable, deleteRange, isColumnText, isSourceBlock, joinBackward, joinForward, markdownShortcut, mathSpans, normalize, orderMap, parseTableData, parseText, pasteBlocks, selectionContainsColumns, setBlockType, snapMathPos, splitBlock, toggleMark, type Sel } from "../src/model.js";

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
    const { d, blocks } = setup("## ", "todo **x** ", "1. ");
    const tx = new Tx(d);
    markdownShortcut(tx, { b: blocks[0], o: 3 }, " ");
    markdownShortcut(tx, { b: blocks[1], o: 11 }, " ");
    markdownShortcut(tx, { b: blocks[2], o: 3 }, " ");
    expect(texts(d)).toEqual(["h2:", "paragraph:todo x ", "ordered:"]);
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
    expect(clipText(parseText("# T\n- a\n1. b"))).toBe("# T\n- a\n1. b");
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

describe("table block transforms", () => {
  it("creates a bounded rectangular grid with independent rows", () => {
    const rows = createBlankTable(2, 3)!;
    expect(rows).toEqual([["", "", ""], ["", "", ""]]); rows[0][0] = "A"; expect(rows[1][0]).toBe("");
    for (const [r, c] of [[0, 1], [1, 0], [201, 1], [1, 51], [200, 50], [1.5, 1], [NaN, 1]]) expect(createBlankTable(r, c)).toBeNull();
  });
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

describe("Feishu Enter in an empty quote", () => {
  it("leaves the quote instead of adding another quote line", () => {
    const d = new Doc(1);
    const tx = new Tx(d);
    const q = tx.create("quote", null, ROOT);
    tx.insert(q, 0, "引用");
    const next = splitBlock(tx, { b: q, o: 2 });
    expect(d.blockInfo(next.b).type).toBe("quote");
    const after = splitBlock(tx, next);
    expect(after).toEqual(next);
    expect(d.blockInfo(next.b).type).toBe("paragraph");
    expect(bodyBlocks(d)).toHaveLength(2);
  });
});

describe("model edge cases: math spans, columns, join/split, activeMarks, shortcuts, and paste", () => {
  it("handles math spans, snapMathPos, expandMathSelection, cmpPos, collapsed, and unknown block fallbacks", () => {
    const { d, blocks } = setup("ab1234cd", "ef5678gh");
    const tx = new Tx(d);
    tx.format(blocks[0], 2, 6, "math", "x^2");
    tx.format(blocks[0], 2, 6, "mathId", "m1");
    tx.format(blocks[1], 2, 6, "math", "y^2");
    tx.format(blocks[1], 2, 6, "mathId", "m2");

    expect(mathSpans(d, blocks[0])).toEqual([{ start: 2, end: 6, math: "x^2", id: "m1" }]);
    // snapMathPos: offset 0, after end, closer to start, closer to end
    expect(snapMathPos(d, { b: blocks[0], o: 0 })).toEqual({ b: blocks[0], o: 0 });
    expect(snapMathPos(d, { b: blocks[0], o: 6 })).toEqual({ b: blocks[0], o: 6 });
    expect(snapMathPos(d, { b: blocks[0], o: 3 })).toEqual({ b: blocks[0], o: 2 });
    expect(snapMathPos(d, { b: blocks[0], o: 5 })).toEqual({ b: blocks[0], o: 6 });

    // normalize: backward single-block, collapsed, cross-block with end.o=0, expanding start & end inside math, and unknown block IDs
    const backNorm = normalize(d, { a: { b: blocks[0], o: 5 }, f: { b: blocks[0], o: 3 } });
    expect(backNorm.start.o).toBe(2);
    expect(backNorm.end.o).toBe(6);
    const colNorm = normalize(d, { a: { b: blocks[0], o: 3 }, f: { b: blocks[0], o: 3 } });
    expect(colNorm.start.o).toBe(3);
    expect(collapsed({ a: { b: blocks[0], o: 3 }, f: { b: blocks[0], o: 3 } })).toBe(true);
    expect(collapsed({ a: { b: blocks[0], o: 3 }, f: { b: blocks[0], o: 4 } })).toBe(false);
    const zeroEndNorm = normalize(d, { a: { b: blocks[0], o: 0 }, f: { b: blocks[1], o: 0 } });
    expect(zeroEndNorm.end.o).toBe(0);
    const unknownA = { client: 99, clock: 1 };
    const unknownB = { client: 99, clock: 2 };
    const ord = orderMap(blocks);
    expect(cmpPos(ord, { b: unknownA, o: 1 }, { b: unknownB, o: 4 })).toBe(-3);
    // Non-root blocks (column children) are real blocks not in bodyBlocks(d), exercising ord.get(...) ?? 0
    const colsParent = tx.create("columns", null, ROOT);
    const childA = tx.create("paragraph", null, colsParent);
    const childB = tx.create("paragraph", childA, colsParent);
    expect(normalize(d, { a: { b: childA, o: 0 }, f: { b: childB, o: 0 } }).blocks.length).toBeGreaterThanOrEqual(1);
    expect(isColumnText(d, unknownA)).toBe(false);

    // deleteRange single-block
    const delTx = new Tx(d);
    expect(deleteRange(delTx, { a: { b: blocks[0], o: 0 }, f: { b: blocks[0], o: 2 } })).toEqual({ b: blocks[0], o: 0 });
    expect(d.text(blocks[0])).toBe("1234cd");

    // Copy & paste math chars assigns fresh mathId
    const clip = copyRange(d, { a: { b: blocks[0], o: 0 }, f: { b: blocks[0], o: 4 } });
    const pastedEnd = pasteBlocks(new Tx(d), { b: blocks[1], o: 0 }, clip);
    expect(pastedEnd.o).toBe(4);
    expect(mathSpans(d, blocks[1]).length).toBe(2);
  });

  it("handles columns, indented lists, textless joinBackward/joinForward, shortcuts, activeMarks, and clippable paste", () => {
    const d = new Doc(1);
    const tx = new Tx(d);
    const cols = tx.create("columns", null, ROOT);
    const col1 = tx.create("paragraph", null, cols);
    const col2 = tx.create("paragraph", col1, cols);
    tx.insert(col1, 0, "c1");
    tx.insert(col2, 0, "c2");
    const p1 = tx.create("paragraph", cols, ROOT);
    tx.insert(p1, 0, "hello");
    const div = tx.create("divider", p1, ROOT);
    const p2 = tx.create("paragraph", div, ROOT);
    tx.insert(p2, 0, "world");
    const p3 = tx.create("paragraph", p2, ROOT);

    expect(selectionContainsColumns(d, { a: { b: cols, o: 0 }, f: { b: p1, o: 2 } })).toBe(true);
    expect(selectionContainsColumns(d, { a: { b: p1, o: 0 }, f: { b: p1, o: 2 } })).toBe(false);

    // Column text guards in deleteRange, splitBlock, joinBackward, joinForward
    expect(deleteRange(tx, { a: { b: col1, o: 0 }, f: { b: col2, o: 1 } })).toEqual({ b: col1, o: 0 });
    expect(splitBlock(tx, { b: col1, o: 2 })).toEqual({ b: col1, o: 3 });
    expect(joinBackward(tx, col1)).toEqual({ b: col1, o: 0 });
    expect(joinForward(tx, col1)).toEqual({ b: col1, o: 3 });

    // deleteRange starting on textless (columns) with a following text block vs all textless
    const resWithText = deleteRange(tx, { a: { b: cols, o: 0 }, f: { b: p1, o: 2 } });
    expect(resWithText).toEqual({ b: p1, o: 0 });
    const resOnlyTextless = deleteRange(tx, { a: { b: cols, o: 0 }, f: { b: cols, o: 0 } });
    expect(resOnlyTextless).toEqual({ b: cols, o: 0 });

    // joinBackward: first block, indented block, non-paragraph block, prev is divider (deleted)
    const d2 = new Doc(1), t2 = new Tx(d2);
    const first = t2.create("paragraph", null, ROOT);
    const div2 = t2.create("divider", first, ROOT);
    const ind = t2.create("bullet", div2, ROOT, { indent: "1" });
    t2.insert(ind, 0, "item");
    expect(joinBackward(t2, first)).toEqual({ b: first, o: 0 });
    // splitBlock on non-empty indented list inherits indent; on empty indented list decrements indent
    const splitInd = splitBlock(t2, { b: ind, o: 4 });
    expect(d2.blockInfo(splitInd.b).props.indent).toBe("1");
    splitBlock(t2, splitInd);
    expect(d2.blockInfo(splitInd.b).props.indent).toBe("0");
    // joinBackward on indented bullet decrements indent -> then converts bullet to paragraph -> then deletes divider!
    joinBackward(t2, ind);
    expect(d2.blockInfo(ind).props.indent).toBe("0");
    joinBackward(t2, ind);
    expect(d2.blockInfo(ind).type).toBe("paragraph");
    joinBackward(t2, ind);
    expect(d2.hasBlock(div2)).toBe(false);

    // joinForward: last block, next is columns, next is divider, next is normal paragraph (with text and empty)
    expect(joinForward(tx, p3)).toEqual({ b: p3, o: 0 });
    const d3 = new Doc(1), t3 = new Tx(d3);
    const a = t3.create("paragraph", null, ROOT); t3.insert(a, 0, "A");
    const div3 = t3.create("divider", a, ROOT);
    const b = t3.create("paragraph", div3, ROOT); t3.insert(b, 0, "B");
    const cEmpty = t3.create("paragraph", b, ROOT);
    const colAfter = t3.create("columns", cEmpty, ROOT);
    joinForward(t3, a); // deletes divider
    expect(d3.hasBlock(div3)).toBe(false);
    joinForward(t3, a); // pulls B into A
    expect(d3.text(a)).toBe("AB");
    joinForward(t3, a); // pulls empty cEmpty into A
    expect(d3.hasBlock(cEmpty)).toBe(false);
    expect(joinForward(t3, a)).toEqual({ b: a, o: 2 }); // stops before columns
    expect(d3.hasBlock(colAfter)).toBe(true);

    // markdownShortcut: [x] sets checked prop, code block returns null
    const d4 = new Doc(1), t4 = new Tx(d4);
    const todoP = t4.create("paragraph", null, ROOT); t4.insert(todoP, 0, "[x] ");
    markdownShortcut(t4, { b: todoP, o: 4 }, " ");
    expect(d4.blockInfo(todoP)).toMatchObject({ type: "todo", props: { checked: "true" } });
    const codeP = t4.create("code", todoP, ROOT); t4.insert(codeP, 0, "**x** ");
    expect(markdownShortcut(t4, { b: codeP, o: 6 }, " ")).toBeNull();

    // activeMarks: empty selection, common + differing marks, skips source block
    const d5 = new Doc(1), t5 = new Tx(d5);
    const m1 = t5.create("paragraph", null, ROOT); t5.insert(m1, 0, "ab");
    t5.format(m1, 0, 2, "bold", "1");
    t5.format(m1, 0, 1, "italic", "1");
    const mathB = t5.create("math", m1, ROOT); t5.insert(mathB, 0, "x");
    const m2 = t5.create("paragraph", mathB, ROOT); t5.insert(m2, 0, "cd");
    t5.format(m2, 0, 2, "bold", "1");
    expect(activeMarks(d5, { a: { b: m1, o: 0 }, f: { b: m1, o: 0 } })).toEqual({});
    expect(activeMarks(d5, { a: { b: m1, o: 0 }, f: { b: m2, o: 2 } })).toEqual({ bold: "1" });

    // pasteBlocks: empty clip, single clippable on empty paragraph (with "type" key in props) & on non-empty paragraph, single plain clip, multi-block onto start of paragraph with h1 first & empty type second
    const d6 = new Doc(1), t6 = new Tx(d6);
    const emptyP = t6.create("paragraph", null, ROOT);
    expect(pasteBlocks(t6, { b: emptyP, o: 0 }, [])).toEqual({ b: emptyP, o: 0 });
    const afterImg1 = pasteBlocks(t6, { b: emptyP, o: 0 }, [{ type: "image", props: { type: "ignored", url: "https://a.test/1.png" }, chars: [] }]);
    expect(d6.blockInfo(emptyP).type).toBe("image");
    t6.insert(afterImg1.b, 0, "text");
    const afterImg2 = pasteBlocks(t6, { b: afterImg1.b, o: 4 }, [{ type: "divider", props: {}, chars: [] }]);
    expect(afterImg2.o).toBe(0);
    // Single inline clip
    const afterSingle = pasteBlocks(t6, afterImg2, parseText("hi"));
    expect(afterSingle.o).toBe(2);
    // Multi-block paste at offset 0 of paragraph with non-paragraph first & "" second type
    const freshP = t6.create("paragraph", afterSingle.b, ROOT);
    pasteBlocks(t6, { b: freshP, o: 0 }, [
      { type: "h2", props: {}, chars: [{ ch: "H", marks: {} }] },
      { type: "", props: {}, chars: [] },
    ]);
    expect(d6.blockInfo(freshP).type).toBe("h2");

    // applyTableEdit on empty rows
    expect(applyTableEdit([], -1, 0, "")).toEqual([["", "", ""], ["", "", ""], ["", "", ""]]);
  });
});

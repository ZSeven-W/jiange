import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { copyRange, deleteRange, markdownShortcut, mathSpans, parseText, pasteBlocks, snapMathPos, splitBlock } from "./model";

function fixture() {
  const doc = new Doc(1), tx = new Tx(doc);
  const a = tx.create("paragraph", null, ROOT), b = tx.create("paragraph", a, ROOT);
  tx.insert(a, 0, "前abc后😀");
  tx.format(a, 1, 4, "math", "x^2");
  tx.format(a, 2, 3, "bold", "true");
  tx.insert(b, 0, "左def右");
  tx.format(b, 1, 4, "math", "y");
  return { doc, a, b };
}

describe("inline formula atomic selection", () => {
  it.each([[3, 4], [1, 2], [2, 3]])("expands partial deletion %i..%i, and restores it with undo", (from, to) => {
    const { doc, a } = fixture(), tx = new Tx(doc);
    const caret = deleteRange(tx, { a: { b: a, o: from }, f: { b: a, o: to } });
    expect(caret.o).toBe(1);
    expect(doc.text(a)).toBe("前后😀");
    const undo = new UndoManager(); undo.record(tx, null, null); undo.undo(doc);
    expect(doc.text(a)).toBe("前abc后😀");
    expect(doc.richChars(a).slice(1, 4).map(c => c.marks.math)).toEqual(["x^2", "x^2", "x^2"]);
  });
  it("expands both endpoints across blocks in either selection direction", () => {
    for (const reverse of [false, true]) {
      const { doc, a, b } = fixture(), tx = new Tx(doc);
      const start = { b: a, o: 2 }, end = { b, o: 3 };
      deleteRange(tx, reverse ? { a: end, f: start } : { a: start, f: end });
      expect(doc.text(a)).toBe("前右");
    }
  });
  it("copies a complete formula rather than partial source with the full mark", () => {
    const { doc, a } = fixture();
    const clip = copyRange(doc, { a: { b: a, o: 2 }, f: { b: a, o: 3 } });
    expect(clip[0].chars.map(c => c.ch).join("")).toBe("abc");
    expect(clip[0].chars.map(c => c.marks.math)).toEqual(["x^2", "x^2", "x^2"]);
  });
  it("snaps a caret inside the formula and never splits the source", () => {
    const { doc, a } = fixture();
    expect(snapMathPos(doc, { b: a, o: 2 }).o).toBe(1);
    expect(snapMathPos(doc, { b: a, o: 3 }).o).toBe(4);
    const p = splitBlock(new Tx(doc), { b: a, o: 2 });
    expect(doc.text(a)).toBe("前");
    expect(doc.text(p.b)).toBe("abc后😀");
  });
  it("pastes at an atomic boundary", () => {
    const { doc, a } = fixture();
    pasteBlocks(new Tx(doc), { b: a, o: 2 }, parseText("X"));
    expect(doc.text(a)).toBe("前Xabc后😀");
    expect(doc.richChars(a).slice(2, 5).every(c => c.marks.math === "x^2")).toBe(true);
  });
  it("does not match markdown syntax through an existing formula", () => {
    const doc = new Doc(1), tx = new Tx(doc), a = tx.create("paragraph", null, ROOT);
    tx.insert(a, 0, "*x*"); tx.format(a, 1, 2, "math", "x");
    expect(markdownShortcut(tx, { b: a, o: 3 }, "*")).toBeNull();
    expect(doc.text(a)).toBe("*x*");
    expect(doc.richChars(a)[1].marks.math).toBe("x");
  });
  it("distinguishes adjacent identical formulas after copy and paste", () => {
    const doc = new Doc(1), tx = new Tx(doc), a = tx.create("paragraph", null, ROOT);
    tx.insert(a, 0, "$x^2$"); markdownShortcut(tx, { b: a, o: 5 }, "$");
    const clip = copyRange(doc, { a: { b: a, o: 0 }, f: { b: a, o: 3 } });
    pasteBlocks(new Tx(doc), { b: a, o: 3 }, clip);
    const spans = mathSpans(doc, a);
    expect(spans.map(({ start, end }) => [start, end])).toEqual([[0, 3], [3, 6]]);
    expect(spans[0].id).not.toBe(spans[1].id);
    deleteRange(new Tx(doc), { a: { b: a, o: 5 }, f: { b: a, o: 6 } });
    expect(doc.text(a)).toBe("x^2");
  });
  it("keeps ambiguous legacy runs together rather than inventing atom boundaries", () => {
    const doc = new Doc(1), tx = new Tx(doc), a = tx.create("paragraph", null, ROOT);
    tx.insert(a, 0, "x^2x^2"); tx.format(a, 0, 6, "math", "x^2");
    expect(mathSpans(doc, a).map(({ start, end }) => [start, end])).toEqual([[0, 6]]);
    deleteRange(new Tx(doc), { a: { b: a, o: 5 }, f: { b: a, o: 6 } });
    expect(doc.text(a)).toBe("");
  });
  it("preserves a late remote insertion outside the selected formula on undo", () => {
    const { doc, a } = fixture(), peer = Doc.fromState(2, doc.encodeState());
    const late = peer.insertText(a, 5, "!")!;
    const tx = new Tx(doc); deleteRange(tx, { a: { b: a, o: 3 }, f: { b: a, o: 4 } });
    doc.apply(late);
    const undo = new UndoManager(); undo.record(tx, null, null); undo.undo(doc);
    expect(doc.text(a)).toContain("!");
    expect(doc.text(a)).toContain("abc");
  });
});

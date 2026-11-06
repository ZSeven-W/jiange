import { describe, expect, it, vi } from "vitest";
import { Doc, ROOT, Tx, UndoManager, type OpId } from "@jiange/collab";
import { findMatches, replaceMatches, resolveFindMatch } from "./findReplace";

function setup(...entries: [string, string][]) {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const blocks: OpId[] = [];
  let after: OpId | null = null;
  for (const [type, text] of entries) {
    const block = tx.create(type, after, ROOT);
    if (text) tx.insert(block, 0, text);
    blocks.push(block);
    after = block;
  }
  return { doc, blocks };
}

describe("findMatches", () => {
  it("finds literal non-overlapping matches in document order across marks", () => {
    const { doc, blocks } = setup(["paragraph", "a.b a.b"], ["h1", "A.B"], ["code", "a.b"]);
    new Tx(doc).format(blocks[0], 0, 1, "bold", "true");
    const matches = findMatches(doc, "a.b");
    expect(matches.map((m) => [m.block, m.start, m.end, m.text])).toEqual([
      [blocks[0], 0, 3, "a.b"], [blocks[0], 4, 7, "a.b"], [blocks[1], 0, 3, "A.B"], [blocks[2], 0, 3, "a.b"],
    ]);
    expect(findMatches(doc, "a.b", { caseSensitive: true })).toHaveLength(3);
    expect(findMatches(doc, "a*b")).toHaveLength(0);
    expect(findMatches(doc, "")).toHaveLength(0);
    expect(findMatches(setup(["paragraph", "aaaa"]).doc, "aa").map((m) => m.start)).toEqual([0, 2]);
  });

  it("maps Unicode matches to code-point boundaries with simple case folding", () => {
    const { doc } = setup(["paragraph", "😀AΣςİi\u0307 Straße"]);
    const matches = findMatches(doc, "aσ");
    expect(matches.map((m) => [m.start, m.end, m.text])).toEqual([[1, 3, "AΣ"]]);
    expect(findMatches(doc, "Σ").map((m) => m.text)).toEqual(["Σ", "ς"]);
    // JavaScript simple folding does not fold İ into i + combining dot or ß into ss.
    expect(findMatches(doc, "i\u0307").map((m) => m.text)).toEqual(["i\u0307"]);
    expect(findMatches(doc, "STRASSE")).toHaveLength(0);
    expect(findMatches(doc, "😀")[0]).toMatchObject({ start: 0, end: 1 });
  });

  it("ignores hidden source, inline formula source, nested columns, tables and title", () => {
    const { doc, blocks } = setup(["paragraph", "xabcx"], ["math", "x"], ["diagram", "x"], ["table", "x"], ["columns", ""]);
    new Tx(doc).format(blocks[0], 1, 4, "math", "abc");
    const childTx = new Tx(doc);
    const child = childTx.create("paragraph", null, blocks[4]);
    childTx.insert(child, 0, "x");
    expect(findMatches(doc, "x").map((m) => m.start)).toEqual([0, 4]);
    expect(findMatches(doc, "abc")).toHaveLength(0);
    expect(findMatches(doc, "xabc")).toHaveLength(0);
  });
});

describe("replaceMatches", () => {
  it("replaces across marks with common formatting and undoes/redoes as one transaction", () => {
    const { doc, blocks: [block] } = setup(["paragraph", "你好世界 你好世界"]);
    const format = new Tx(doc);
    format.format(block, 0, 9, "bold", "true");
    format.format(block, 1, 2, "italic", "true");
    const matches = findMatches(doc, "你好世界");
    const tx = new Tx(doc);
    expect(replaceMatches(tx, matches, "Hi😀")).toEqual({ replaced: 2, skipped: 0 });
    expect(doc.text(block)).toBe("Hi😀 Hi😀");
    expect(doc.richChars(block).slice(0, 3).map((c) => c.marks)).toEqual([{ bold: "true" }, { bold: "true" }, { bold: "true" }]);
    const undo = new UndoManager();
    undo.record(tx, null, null);
    undo.undo(doc);
    expect(doc.text(block)).toBe("你好世界 你好世界");
    expect(doc.richChars(block)[1].marks).toMatchObject({ bold: "true", italic: "true" });
    undo.redo(doc);
    expect(doc.text(block)).toBe("Hi😀 Hi😀");
  });

  it("resolves moved offsets by ID and preserves concurrent text before the match", () => {
    const { doc, blocks: [block] } = setup(["paragraph", "前目标后"]);
    const match = findMatches(doc, "目标")[0];
    doc.insertText(block, 0, "协作");
    expect(resolveFindMatch(doc, match)).toEqual({ start: 3, end: 5 });
    expect(replaceMatches(new Tx(doc), [match], "新")).toEqual({ replaced: 1, skipped: 0 });
    expect(doc.text(block)).toBe("协作前新后");
  });

  it("skips if remote changes split, delete, retype or hide the captured characters", () => {
    const { doc, blocks: [block] } = setup(["paragraph", "前目标后"]);
    const match = findMatches(doc, "目标")[0];
    doc.insertText(block, 2, "远端");
    const tx = new Tx(doc);
    expect(replaceMatches(tx, [match], "新")).toEqual({ replaced: 0, skipped: 1 });
    expect(tx.ops).toHaveLength(0);
    expect(doc.text(block)).toBe("前目远端标后");
    new Tx(doc).delete(block, 1, doc.visibleIds(block).length);
    new Tx(doc).insert(block, 1, "目标后");
    expect(resolveFindMatch(doc, match)).toBeNull();
    const fresh = findMatches(doc, "目标")[0];
    new Tx(doc).setProp(block, "type", "math");
    expect(resolveFindMatch(doc, fresh)).toBeNull();
  });

  it("replaces unchanged matches while reporting other matches that became stale", () => {
    const { doc, blocks } = setup(["paragraph", "目标"], ["paragraph", "另一个目标"]);
    const matches = findMatches(doc, "目标");
    doc.insertText(blocks[0], 1, "远端");
    const tx = new Tx(doc);
    expect(replaceMatches(tx, matches, "完成")).toEqual({ replaced: 1, skipped: 1 });
    expect(doc.text(blocks[0])).toBe("目远端标");
    expect(doc.text(blocks[1])).toBe("另一个完成");
  });

  it("does not attach the original person identity to replacement text", () => {
    const { doc, blocks: [block] } = setup(["paragraph", "@小简"]);
    const mark = new Tx(doc);
    mark.format(block, 0, 3, "mention", "42");
    mark.format(block, 0, 3, "bold", "true");
    const tx = new Tx(doc);
    replaceMatches(tx, findMatches(doc, "@小简"), "@张三");
    expect(doc.text(block)).toBe("@张三");
    expect(doc.richChars(block).every((char) => char.marks.bold === "true" && !char.marks.mention)).toBe(true);
  });

  it("rejects other document instances and blocks moved under a column", () => {
    const a = setup(["paragraph", "目标"], ["columns", ""]);
    const match = findMatches(a.doc, "目标")[0];
    const b = Doc.fromState(2, a.doc.encodeState());
    expect(replaceMatches(new Tx(b), [match], "新")).toEqual({ replaced: 0, skipped: 1 });
    new Tx(a.doc).move(a.blocks[0], null, a.blocks[1]);
    expect(resolveFindMatch(a.doc, match)).toBeNull();
  });

  it("skips duplicate or overlapping snapshots and supports empty replacements", () => {
    const { doc, blocks: [block] } = setup(["paragraph", "ababa"]);
    const first = findMatches(doc, "aba")[0];
    const overlapping = findMatches(doc, "bab")[0];
    const tx = new Tx(doc);
    expect(replaceMatches(tx, [first, overlapping, overlapping], "")).toEqual({ replaced: 1, skipped: 2 });
    expect(doc.text(block)).toBe("aa");
  });

  it("does not create CRDT edits when replacement equals the captured text", () => {
    const { doc, blocks: [block] } = setup(["paragraph", "相同 相同"]);
    const matches = findMatches(doc, "相同");
    const tx = new Tx(doc);
    expect(replaceMatches(tx, [...matches, matches[0]], "相同")).toEqual({ replaced: 2, skipped: 1 });
    expect(tx.ops).toHaveLength(0);
    expect(tx.items).toHaveLength(0);
    expect(doc.text(block)).toBe("相同 相同");
  });

  it("takes one validation snapshot per block even for many stale matches", () => {
    const { doc, blocks: [block] } = setup(["paragraph", "目标 ".repeat(1200)]);
    const matches = findMatches(doc, "目标");
    const edit = new Tx(doc);
    edit.delete(block, 0, doc.visibleIds(block).length);
    edit.insert(block, 0, "目标 ".repeat(1200));
    const ids = vi.spyOn(doc, "visibleIds");
    const chars = vi.spyOn(doc, "richChars");
    const children = vi.spyOn(doc, "children");
    const tx = new Tx(doc);
    expect(replaceMatches(tx, matches, "完成")).toEqual({ replaced: 0, skipped: 1200 });
    expect(tx.ops).toHaveLength(0);
    expect(ids).toHaveBeenCalledTimes(1);
    expect(chars).toHaveBeenCalledTimes(1);
    expect(children).toHaveBeenCalledTimes(1);
  });

  it("does not re-scan the body for every valid match during replace-all", () => {
    const { doc, blocks: [block] } = setup(["paragraph", "目标 ".repeat(160)]);
    const matches = findMatches(doc, "目标");
    const ids = vi.spyOn(doc, "visibleIds");
    const chars = vi.spyOn(doc, "richChars");
    const children = vi.spyOn(doc, "children");
    const tx = new Tx(doc);
    expect(replaceMatches(tx, matches, "")).toEqual({ replaced: 160, skipped: 0 });
    expect(doc.text(block)).toBe(" ".repeat(160));
    expect(children).toHaveBeenCalledTimes(1);
    // Tx.delete currently reads ids and marks once per actual mutation. The
    // planner adds just one snapshot rather than two full scans per match.
    expect(ids.mock.calls.length).toBeLessThanOrEqual(matches.length + 1);
    expect(chars.mock.calls.length).toBeLessThanOrEqual(matches.length + 1);
  });

  it("does not delete a late remote insert anchored inside the replaced range", () => {
    const { doc, blocks: [block] } = setup(["paragraph", "前目标后"]);
    const peer = Doc.fromState(2, doc.encodeState());
    const late = peer.insertText(block, 2, "远端");
    const match = findMatches(doc, "目标")[0];
    replaceMatches(new Tx(doc), [match], "新");
    if (late) doc.apply(late);
    expect(doc.text(block)).toContain("远端");
    expect(doc.text(block)).toContain("新");
  });
});

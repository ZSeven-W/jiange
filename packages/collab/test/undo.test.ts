import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager, type OpId } from "../src/index";

const text = (d: Doc, b: OpId) => d.text(b);
const sync = (a: Doc, b: Doc, ops: { length: number } & Iterable<unknown>) => {
  for (const op of ops as Iterable<never>) b.apply(op);
};

describe("Peritext expand", () => {
  it("bold grows at the end, link does not", () => {
    const d = new Doc(1);
    const p = d.createBlock("paragraph").id;
    d.insertText(p, 0, "ab");
    d.format(p, 0, 2, "bold", "true");
    d.insertText(p, 2, "c");
    d.format(p, 0, 3, "link", "x");
    d.insertText(p, 3, "d");
    expect(d.richChars(p).map((c) => c.marks)).toEqual([
      { bold: "true", link: "x" },
      { bold: "true", link: "x" },
      { bold: "true", link: "x" },
      { bold: "true" },
    ]);
  });
});

describe("UndoManager", () => {
  it("undoes only local changes and keeps remote edits", () => {
    const a = new Doc(1), b = new Doc(2);
    const um = new UndoManager();
    const t0 = new Tx(a);
    const p = t0.create("paragraph", null);
    t0.insert(p, 0, "hello");
    sync(a, b, t0.ops);
    um.record(t0, null, null);
    const r = b.insertText(p, 5, " bob")!;
    a.apply(r);
    const t1 = new Tx(a);
    t1.insert(p, 0, "A:");
    t1.format(p, 0, 7, "bold", "true");
    um.record(t1, null, null);
    sync(a, b, t1.ops);
    expect(text(a, p)).toBe("A:hello bob");
    const u = um.undo(a)!;
    sync(a, b, u.ops);
    expect(text(a, p)).toBe("hello bob");
    expect(a.richChars(p).some((c) => c.marks.bold)).toBe(false);
    const rd = um.redo(a)!;
    sync(a, b, rd.ops);
    expect(text(b, p)).toBe("A:hello bob");
    expect(b.richChars(p).slice(0, 7).every((c) => c.marks.bold === "true")).toBe(true);
    expect(b.view()).toEqual(a.view());
  });

  it("restores deleted text with marks and deleted blocks, then redoes", () => {
    const d = new Doc(1);
    const um = new UndoManager<string>();
    const t = new Tx(d);
    const p = t.create("paragraph", null);
    const q = t.create("heading1", p);
    t.insert(p, 0, "keep this");
    t.insert(q, 0, "title");
    t.format(p, 0, 4, "italic", "true");
    um.record(t, "s0", "s1");
    const del = new Tx(d);
    del.delete(p, 0, 5);
    del.deleteBlock(q);
    um.record(del, "s1", "s2");
    expect(d.view().blocks.length).toBe(1);
    const u = um.undo(d)!;
    expect(u.selection).toBe("s1");
    const v = d.view();
    expect(v.blocks.map((b) => b.type)).toEqual(["paragraph", "heading1"]);
    expect(v.blocks[0].spans).toEqual([
      { text: "keep", marks: { italic: "true" } },
      { text: " this", marks: {} },
    ]);
    um.redo(d);
    expect(d.view().blocks.length).toBe(1);
    // undo twice more: restores again, then removes everything from the first tx
    um.undo(d);
    um.undo(d);
    expect(d.view().blocks).toEqual([]);
    um.redo(d);
    expect(d.text(um.map(p))).toBe("keep this");
  });

  it("merges typing, undoes moves and props", () => {
    const d = new Doc(1);
    const um = new UndoManager();
    const t = new Tx(d);
    const a = t.create("paragraph", null), b = t.create("paragraph", a);
    um.record(t, null, null);
    for (const ch of "abc") {
      const x = new Tx(d);
      x.insert(a, d.text(a).length, ch);
      um.record(x, null, null, "type", 1000);
    }
    const m = new Tx(d);
    m.move(a, b);
    m.setProp(a, "type", "todo");
    um.record(m, null, null);
    expect(d.children(ROOT)).toEqual([b, a]);
    um.undo(d);
    expect(d.children(ROOT)).toEqual([a, b]);
    expect(d.blockInfo(a).type).toBe("paragraph");
    um.undo(d);
    expect(d.text(a)).toBe("");
  });

  it("converges when two users undo concurrently", () => {
    const a = new Doc(1), b = new Doc(2);
    const ua = new UndoManager(), ub = new UndoManager();
    const t = new Tx(a);
    const p = t.create("paragraph", null);
    t.insert(p, 0, "0123456789");
    sync(a, b, t.ops);
    const ta = new Tx(a);
    ta.delete(p, 2, 6);
    ua.record(ta, null, null);
    const tb = new Tx(b);
    tb.delete(p, 4, 8);
    tb.insert(p, 4, "XY");
    ub.record(tb, null, null);
    sync(a, b, ta.ops);
    sync(b, a, tb.ops);
    const x = ua.undo(a)!, y = ub.undo(b)!;
    sync(a, b, x.ops);
    sync(b, a, y.ops);
    expect(a.view()).toEqual(b.view());
    expect(a.text(p)).toContain("01");
  });
});

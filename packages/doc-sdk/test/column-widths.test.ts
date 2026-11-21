import { describe, expect, it, vi } from "vitest";
import { Doc, ROOT, Tx, UndoManager, idKey } from "@jiange/collab";
import { applyColumnWidths, captureColumnWidths, columnWeights, COLUMN_WIDTHS, validColumnWidths } from "../src/column-widths.js";

function setup() {
  const doc = new Doc(1), tx = new Tx(doc), parent = tx.create("columns", null, ROOT);
  const left = tx.create("paragraph", null, parent), middle = tx.create("paragraph", left, parent), right = tx.create("paragraph", middle, parent);
  tx.insert(left, 0, "左"); tx.insert(middle, 0, "中"); tx.insert(right, 0, "右");
  return { doc, parent, left, middle, right, ids: [left, middle, right].map(idKey) };
}

describe("document column widths", () => {
  it("defaults equally, resizes an adjacent pair, and preserves other weights", () => {
    const c = setup();
    expect(columnWeights(undefined, c.ids)).toEqual([1000, 1000, 1000]);
    const before = captureColumnWidths(c.doc, c.parent, c.ids[0], c.ids[1])!;
    expect(Object.isFrozen(before)).toBe(true); expect(Object.isFrozen(before.ids)).toBe(true); expect(Object.isFrozen(before.weights)).toBe(true);
    const tx = new Tx(c.doc);
    expect(applyColumnWidths(tx, before, 0.7)).toBe("applied");
    expect(columnWeights(c.doc.blockInfo(c.parent).props[COLUMN_WIDTHS], c.ids)).toEqual([1400, 600, 1000]);
    const undo = new UndoManager(); undo.record(tx, null, null); undo.undo(c.doc);
    expect(columnWeights(c.doc.blockInfo(c.parent).props[COLUMN_WIDTHS], c.ids)).toEqual([1000, 1000, 1000]);
    undo.redo(c.doc);
    expect(columnWeights(c.doc.blockInfo(c.parent).props[COLUMN_WIDTHS], c.ids)).toEqual([1400, 600, 1000]);
  });
  it("rejects an observed competing width write, even if the value is identical", () => {
    const c = setup(), before = captureColumnWidths(c.doc, c.parent, c.ids[0], c.ids[1])!;
    const peer = Doc.fromState(2, c.doc.encodeState());
    c.doc.apply(peer.setProp(c.parent, COLUMN_WIDTHS, ""));
    const tx = new Tx(c.doc);
    expect(applyColumnWidths(tx, before, 0.7)).toBe("changed"); expect(tx.ops).toHaveLength(0);
    expect(c.doc.text(c.left)).toBe("左");
  });
  it("rejects changed structure while allowing unrelated collaborative text", () => {
    const c = setup(), before = captureColumnWidths(c.doc, c.parent, c.ids[0], c.ids[1])!;
    const peer = Doc.fromState(2, c.doc.encodeState());
    c.doc.apply(peer.insertText(c.right, 1, "远端")!);
    expect(applyColumnWidths(new Tx(c.doc), before, 0.6)).toBe("applied");
    const next = captureColumnWidths(c.doc, c.parent, c.ids[0], c.ids[1])!;
    new Tx(c.doc).create("paragraph", c.left, c.parent);
    const stale = new Tx(c.doc);
    expect(applyColumnWidths(stale, next, 0.6)).toBe("changed"); expect(stale.ops).toHaveLength(0);
    expect(c.doc.text(c.right)).toBe("右远端");
  });
  it("does not overwrite malformed or excessive metadata, and clamps no invalid fraction", () => {
    for (const raw of ["{", '{"__proto__":10}', '{"1:1":0}', '{"1:1":1.5}', "x".repeat(32001)]) {
      const c = setup(); new Tx(c.doc).setProp(c.parent, COLUMN_WIDTHS, raw);
      expect(columnWeights(raw, c.ids)).toEqual([1000, 1000, 1000]);
      expect(captureColumnWidths(c.doc, c.parent, c.ids[0], c.ids[1])).toBeNull();
      expect(c.doc.blockInfo(c.parent).props[COLUMN_WIDTHS]).toBe(raw);
    }
    const c = setup(), before = captureColumnWidths(c.doc, c.parent, c.ids[0], c.ids[1])!, tx = new Tx(c.doc);
    for (const value of [NaN, Infinity, 0, 1]) expect(applyColumnWidths(tx, before, value)).toBe("invalid");
    expect(tx.ops).toHaveLength(0);
  });
  it("checks the resulting metadata budget before changing the live document", () => {
    const c = setup(), raw = '{"9:9":999999000}';
    new Tx(c.doc).setProp(c.parent, COLUMN_WIDTHS, raw);
    const before = captureColumnWidths(c.doc, c.parent, c.ids[0], c.ids[1])!, tx = new Tx(c.doc);
    expect(applyColumnWidths(tx, before, 0.7)).toBe("invalid");
    expect(tx.ops).toHaveLength(0);
    expect(c.doc.blockInfo(c.parent).props[COLUMN_WIDTHS]).toBe(raw);
  });

  it("handles non-object JSON, overflow weights, invalid targets, and unchanged writes", () => {
    expect(validColumnWidths("null")).toBe(false);
    expect(validColumnWidths("[]")).toBe(false);
    expect(validColumnWidths("42")).toBe(false);
    expect(validColumnWidths("")).toBe(true);

    // Sum exceeds MAX_TOTAL when missing column gets DEFAULT_WEIGHT
    const maxRaw = JSON.stringify({ "1:1": 1_000_000_000 });
    expect(columnWeights(maxRaw, ["1:1", "1:2"])).toEqual([1000, 1000]);

    const c = setup();
    // Missing parent or invalid left/right id
    expect(captureColumnWidths(c.doc, { client: 99, clock: 99 }, c.ids[0], c.ids[1])).toBeNull();
    expect(captureColumnWidths(c.doc, c.parent, "bad", c.ids[1])).toBeNull();
    expect(captureColumnWidths(c.doc, c.parent, c.ids[0], "bad")).toBeNull();

    // Non-columns parent and nested columns parent
    const para = new Tx(c.doc).create("paragraph", null, ROOT);
    expect(captureColumnWidths(c.doc, para, c.ids[0], c.ids[1])).toBeNull();
    const nestedCols = new Tx(c.doc).create("columns", null, para);
    const n1 = new Tx(c.doc).create("paragraph", null, nestedCols);
    const n2 = new Tx(c.doc).create("paragraph", n1, nestedCols);
    expect(captureColumnWidths(c.doc, nestedCols, idKey(n1), idKey(n2))).toBeNull();

    // Weights overflow in captureColumnWidths
    const overflowDoc = setup();
    new Tx(overflowDoc.doc).setProp(overflowDoc.parent, COLUMN_WIDTHS, JSON.stringify({ [overflowDoc.ids[0]]: 1_000_000_000 }));
    expect(captureColumnWidths(overflowDoc.doc, overflowDoc.parent, overflowDoc.ids[0], overflowDoc.ids[1])).toBeNull();

    // Unchanged fraction (0.5 on equal 1000/1000 weights)
    const snap = captureColumnWidths(c.doc, c.parent, c.ids[0], c.ids[1])!;
    expect(applyColumnWidths(new Tx(c.doc), snap, 0.5)).toBe("unchanged");

    // No-op tx.setProp fallback branch
    const txNoOp = new Tx(c.doc);
    vi.spyOn(txNoOp, "setProp").mockImplementationOnce(() => {});
    expect(applyColumnWidths(txNoOp, snap, 0.7)).toBe("unchanged");
  });
});

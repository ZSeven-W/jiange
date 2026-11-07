import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { validEditorSelection } from "./selectionSafety";

describe("stale editor selections", () => {
  it("rejects missing, deleted and out-of-range positions", () => {
    const doc = new Doc(1), tx = new Tx(doc), block = tx.create("paragraph", null, ROOT);
    tx.insert(block, 0, "😀字");
    const at = (o: number) => ({ b: block, o });
    expect(validEditorSelection(doc, { a: at(0), f: at(2) })).toBe(true);
    expect(validEditorSelection(doc, { a: at(0), f: at(3) })).toBe(false);
    expect(validEditorSelection(doc, { a: { b: { client: 99, clock: 9 }, o: 0 }, f: at(1) })).toBe(false);
    doc.deleteBlock(block);
    expect(validEditorSelection(doc, { a: at(0), f: at(1) })).toBe(false);
  });
  it("rejects a column whose parent was deleted or moved out of the rendered body", () => {
    const doc = new Doc(1), tx = new Tx(doc);
    const cols = tx.create("columns", null, ROOT), column = tx.create("paragraph", null, cols);
    tx.insert(column, 0, "文字");
    const s = { a: { b: column, o: 0 }, f: { b: column, o: 2 } };
    expect(validEditorSelection(doc, s)).toBe(true);
    const parent = tx.create("paragraph", cols, ROOT);
    tx.move(cols, null, parent);
    expect(validEditorSelection(doc, s)).toBe(false);
    tx.move(cols, parent, ROOT);
    doc.deleteBlock(cols);
    expect(validEditorSelection(doc, s)).toBe(false);
  });
});

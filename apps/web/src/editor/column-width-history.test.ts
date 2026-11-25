import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager, idKey } from "@zseven-w/collab";
import { applyColumnWidths, captureColumnWidths, COLUMN_WIDTHS } from "./column-widths";
import { ColumnWidthHistory } from "./column-width-history";
import { ColumnAlignmentHistory } from "./column-alignment-history";

function setup() {
  const doc = new Doc(1), tx = new Tx(doc), parent = tx.create("columns", null, ROOT);
  const left = tx.create("paragraph", null, parent), right = tx.create("paragraph", left, parent);
  tx.insert(left, 0, "左"); tx.insert(right, 0, "右");
  return { doc, parent, left, right, undo: new UndoManager(), history: new ColumnWidthHistory() };
}
type Context = ReturnType<typeof setup>;
function change(c: Context, fraction: number) {
  const before = c.history.capture(c.doc, c.parent)!;
  const snapshot = captureColumnWidths(c.doc, c.parent, idKey(c.left), idKey(c.right))!;
  expect(applyColumnWidths(new Tx(c.doc), snapshot, fraction)).toBe("applied");
  c.history.record(c.doc, c.undo, c.parent, before);
}
function commit(c: Context, redo = false) {
  const result = c.history.prepareConditional(c.doc, c.undo, c.undo.peekMarker(redo)!, redo);
  if (result.status !== "ready") return result.status;
  expect(c.history.canSubmitConditional(c.doc, c.undo, result.plan)).toBe(true);
  c.doc.apply(result.plan.op);
  return c.history.finishConditional(c.doc, c.undo, result.plan);
}

describe("conditional column width history", () => {
  it("preserves adjacent local undo and redo order", () => {
    const c = setup(); change(c, 0.6); const first = c.doc.blockInfo(c.parent).props[COLUMN_WIDTHS]; change(c, 0.7);
    const second = c.doc.blockInfo(c.parent).props[COLUMN_WIDTHS];
    expect(commit(c)).toBe("ready"); expect(c.doc.blockInfo(c.parent).props[COLUMN_WIDTHS]).toBe(first);
    expect(commit(c)).toBe("ready"); expect(c.doc.blockInfo(c.parent).props[COLUMN_WIDTHS]).toBe("");
    expect(commit(c, true)).toBe("ready"); expect(c.doc.blockInfo(c.parent).props[COLUMN_WIDTHS]).toBe(first);
    expect(commit(c, true)).toBe("ready"); expect(c.doc.blockInfo(c.parent).props[COLUMN_WIDTHS]).toBe(second);
  });
  it("refuses an observed same-value peer write or structure change", () => {
    for (const kind of ["same", "structure"] as const) {
      const c = setup(); change(c, 0.7); const peer = Doc.fromState(2, c.doc.encodeState());
      if (kind === "same") c.doc.apply(peer.setProp(c.parent, COLUMN_WIDTHS, peer.blockInfo(c.parent).props[COLUMN_WIDTHS]));
      else { const tx = new Tx(peer); tx.create("paragraph", c.left, c.parent); for (const op of tx.ops) c.doc.apply(op); }
      expect(commit(c)).toBe("conflict"); expect(c.doc.text(c.left)).toBe("左"); expect(c.doc.text(c.right)).toBe("右");
    }
  });
  it("does not finalize a prepared inverse before observing its exact operation", () => {
    const c = setup(); change(c, 0.7); const marker = c.undo.peekMarker(false)!;
    const result = c.history.prepareConditional(c.doc, c.undo, marker, false);
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(c.history.finishConditional(c.doc, c.undo, result.plan)).toBe("conflict");
    expect(c.undo.peekMarker(false)).toBe(marker);
    c.doc.apply(result.plan.op);
    expect(c.history.finishConditional(c.doc, c.undo, result.plan)).toBe("ready");
    expect(c.undo.peekMarker(true)).toBe(marker);
  });
  it("keeps width and text-alignment histories independent when interleaved", () => {
    const c = setup(), alignment = new ColumnAlignmentHistory(), before = alignment.capture(c.doc, c.left)!;
    new Tx(c.doc).setProp(c.left, "align", "center"); alignment.record(c.doc, c.undo, c.left, before);
    change(c, 0.7);
    expect(commit(c)).toBe("ready");
    const undoAlign = alignment.prepareConditional(c.doc, c.undo, c.undo.peekMarker(false)!, false);
    expect(undoAlign.status).toBe("ready"); if (undoAlign.status !== "ready") return;
    c.doc.apply(undoAlign.plan.op); expect(alignment.finishConditional(c.doc, c.undo, undoAlign.plan)).toBe("ready");
    expect(c.doc.blockInfo(c.left).props.align).toBe("");
    const redoAlign = alignment.prepareConditional(c.doc, c.undo, c.undo.peekMarker(true)!, true);
    expect(redoAlign.status).toBe("ready"); if (redoAlign.status !== "ready") return;
    c.doc.apply(redoAlign.plan.op); expect(alignment.finishConditional(c.doc, c.undo, redoAlign.plan)).toBe("ready");
    expect(commit(c, true)).toBe("ready"); expect(c.doc.blockInfo(c.left).props.align).toBe("center");
  });
});

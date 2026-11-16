import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { TableWidthHistory } from "./table-width-history";
import { validTableWidths } from "./table-widths";

function setup() {
  const doc = new Doc(1), tx = new Tx(doc);
  const table = tx.create("table", null, ROOT, { tableData: '[["A","B"],["C","D"]]' });
  return { doc, table, undo: new UndoManager(), history: new TableWidthHistory() };
}
type Context = ReturnType<typeof setup>;
function change(c: Context, widths: string) {
  const before = c.history.capture(c.doc, c.table)!;
  new Tx(c.doc).setProp(c.table, "tableWidths", widths);
  c.history.record(c.doc, c.undo, c.table, before);
}
function step(c: Context, redo = false) {
  const result = c.history.prepareConditional(c.doc, c.undo, c.undo.peekMarker(redo)!, redo);
  if (result.status !== "ready") return result.status;
  expect(c.history.canSubmitConditional(c.doc, c.undo, result.plan)).toBe(true);
  c.doc.apply(result.plan.op);
  return c.history.finishConditional(c.doc, c.undo, result.plan);
}

describe("table width history", () => {
  it("undoes and redoes consecutive resize actions in order", () => {
    const c = setup(); change(c, "[140,120]"); change(c, "[160,120]");
    expect(step(c)).toBe("ready"); expect(c.doc.blockInfo(c.table).props.tableWidths).toBe("[140,120]");
    expect(step(c)).toBe("ready"); expect(c.doc.blockInfo(c.table).props.tableWidths).toBe("");
    expect(step(c, true)).toBe("ready"); expect(c.doc.blockInfo(c.table).props.tableWidths).toBe("[140,120]");
    expect(step(c, true)).toBe("ready"); expect(c.doc.blockInfo(c.table).props.tableWidths).toBe("[160,120]");
  });

  it("refuses to overwrite an observed peer width or table change", () => {
    for (const kind of ["same-width", "structure", "merge"] as const) {
      const c = setup(); change(c, "[140,120]");
      const peer = Doc.fromState(2, c.doc.encodeState());
      const op = kind === "same-width" ? peer.setProp(c.table, "tableWidths", "[140,120]") : kind === "structure" ? peer.setProp(c.table, "tableData", '[["B","A"],["D","C"]]') : peer.setProp(c.table, "tableMerges", "[[0,0,1,2]]");
      c.doc.apply(op);
      expect(step(c)).toBe("conflict");
      expect(c.doc.blockInfo(c.table).props.tableWidths).toBe("[140,120]");
    }
  });

  it("requires the exact accepted operation to be observed before moving history", () => {
    const c = setup(); change(c, "[140,120]"); const marker = c.undo.peekMarker(false)!;
    const result = c.history.prepareConditional(c.doc, c.undo, marker, false);
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(c.history.finishConditional(c.doc, c.undo, result.plan)).toBe("conflict");
    expect(c.undo.peekMarker(false)).toBe(marker);
    c.doc.apply(result.plan.op);
    expect(c.history.finishConditional(c.doc, c.undo, result.plan)).toBe("ready");
    expect(c.undo.peekMarker(true)).toBe(marker);
  });

  it("allows only bounded numeric or empty width data", () => {
    for (const raw of ["", "[]", "[100,null,180.25]"]) expect(validTableWidths(raw)).toBe(true);
    for (const raw of ["{}", "[0]", "[-1]", "[100001]", '["text"]', "[1]{}", "[1e999]"]) expect(validTableWidths(raw)).toBe(false);
  });
});

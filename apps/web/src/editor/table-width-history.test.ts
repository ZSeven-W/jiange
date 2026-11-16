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
  it("prepares an initial resize without mutation and records it only after observation", () => {
    const c = setup(), before = c.history.capture(c.doc, c.table)!;
    const prepared = c.history.prepareInitial(c.doc, c.undo, c.table, before, "[140,120]");
    expect(prepared.status).toBe("ready"); if (prepared.status !== "ready") return;
    expect(c.doc.blockInfo(c.table).props.tableWidths).toBeUndefined();
    expect(c.history.canSubmitInitial(c.doc, c.undo, prepared.plan)).toBe(true);
    expect(c.history.finishInitial(c.doc, c.undo, prepared.plan).status).toBe("unobserved");
    c.doc.apply(prepared.plan.op);
    expect(c.history.finishInitial(c.doc, c.undo, prepared.plan).status).toBe("recorded");
    expect(step(c)).toBe("ready");
    expect(c.doc.blockInfo(c.table).props.tableWidths).toBe("");
  });

  it("does not send an initial resize after the table, width, or local history changes", () => {
    for (const kind of ["same-width", "structure", "history"] as const) {
      const c = setup(), before = c.history.capture(c.doc, c.table)!;
      const prepared = c.history.prepareInitial(c.doc, c.undo, c.table, before, "[140,120]");
      expect(prepared.status).toBe("ready"); if (prepared.status !== "ready") return;
      if (kind === "history") c.undo.recordMarker("later");
      else {
        const peer = Doc.fromState(2, c.doc.encodeState());
        c.doc.apply(peer.setProp(c.table, kind === "structure" ? "tableData" : "tableWidths", kind === "structure" ? '[["B","A"],["C","D"]]' : ""));
      }
      expect(c.history.canSubmitInitial(c.doc, c.undo, prepared.plan)).toBe(false);
    }
  });

  it("inserts an accepted resize before later unrelated actions", () => {
    const c = setup(), before = c.history.capture(c.doc, c.table)!;
    const prepared = c.history.prepareInitial(c.doc, c.undo, c.table, before, "[140,120]");
    expect(prepared.status).toBe("ready"); if (prepared.status !== "ready") return;
    c.doc.apply(prepared.plan.op); c.undo.recordMarker("later");
    const result = c.history.finishInitial(c.doc, c.undo, prepared.plan);
    expect(result.status).toBe("recorded"); if (result.status !== "recorded") return;
    expect(c.undo.peekMarker(false)).toBe("later"); expect(c.undo.moveMarker(false, "later")).toBe(true);
    expect(c.undo.peekMarker(false)).toBe(result.key);
    expect(step(c)).toBe("ready");
  });

  it("does not attach an accepted resize after history navigation or overwrite a later width", () => {
    for (const kind of ["navigation", "peer"] as const) {
      const c = setup(); if (kind === "navigation") c.undo.recordMarker("earlier");
      const before = c.history.capture(c.doc, c.table)!;
      const prepared = c.history.prepareInitial(c.doc, c.undo, c.table, before, "[140,120]");
      expect(prepared.status).toBe("ready"); if (prepared.status !== "ready") return;
      c.doc.apply(prepared.plan.op);
      if (kind === "navigation") c.undo.moveMarker(false, "earlier");
      else { const peer = Doc.fromState(2, c.doc.encodeState()); c.doc.apply(peer.setProp(c.table, "tableWidths", "[180,120]")); }
      const result = c.history.finishInitial(c.doc, c.undo, prepared.plan);
      expect(result.status).toBe(kind === "navigation" ? "no-history" : "superseded");
      if (result.status === "superseded") {
        expect(c.undo.peekMarker(false)).toBe(result.key);
        expect(step(c)).toBe("conflict");
        expect(c.doc.blockInfo(c.table).props.tableWidths).toBe("[180,120]");
      } else expect(c.undo.peekMarker(false)).toBeNull();
    }
  });

  it("retains a guarded history entry when the table changes after acceptance", () => {
    const c = setup(), before = c.history.capture(c.doc, c.table)!;
    const prepared = c.history.prepareInitial(c.doc, c.undo, c.table, before, "[140,120]");
    expect(prepared.status).toBe("ready"); if (prepared.status !== "ready") return;
    c.doc.apply(prepared.plan.op);
    const peer = Doc.fromState(2, c.doc.encodeState()); c.doc.apply(peer.setProp(c.table, "tableData", '[["B","A"],["C","D"]]'));
    const result = c.history.finishInitial(c.doc, c.undo, prepared.plan);
    expect(result.status).toBe("changed"); if (result.status !== "changed") return;
    expect(c.undo.peekMarker(false)).toBe(result.key);
    expect(step(c)).toBe("conflict");
  });

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

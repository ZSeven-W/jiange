import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { tableRowsOf, writeTable } from "./tableCells";
import { TableStructureHistory } from "./tableStructureHistory";

function setup() {
  const doc = new Doc(1), tx = new Tx(doc);
  const table = tx.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]), tableWidths: "[100,200]" });
  return { doc, table, undo: new UndoManager(), history: new TableStructureHistory() };
}

function deleteFirstRow(ctx: ReturnType<typeof setup>) {
  const { doc, table, history, undo } = ctx;
  const tx = new Tx(doc);
  writeTable(tx, table, doc.blockInfo(table).props, [["C", "D"]], doc.client);
  const key = history.record(doc, table, tx, undo)!;
  undo.recordMarker(key);
  return key;
}

describe("guarded table selection deletion history", () => {
  it("undoes and redoes the whole structural transaction", () => {
    const ctx = setup(), key = deleteFirstRow(ctx);
    expect(ctx.history.step(ctx.doc, ctx.undo, key, false).status).toBe("ready");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)).toEqual([["A", "B"], ["C", "D"]]);
    expect(ctx.history.step(ctx.doc, ctx.undo, key, true).status).toBe("ready");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)).toEqual([["C", "D"]]);
  });
  it("does not overwrite a collaborator's table edits or consume the history marker", () => {
    const ctx = setup(), key = deleteFirstRow(ctx), peer = Doc.fromState(2, ctx.doc.encodeState());
    ctx.doc.apply(peer.setProp(ctx.table, "tableWidths", "[120,200]"));
    expect(ctx.history.step(ctx.doc, ctx.undo, key, false).status).toBe("conflict");
    expect(ctx.doc.blockInfo(ctx.table).props.tableWidths).toBe("[120,200]");
    expect(ctx.undo.peekMarker(false)).toBe(key);
  });
  it("restores a whole deleted table but rejects undo after remote paragraph typing", () => {
    const ctx = setup(), tx = new Tx(ctx.doc);
    tx.setProp(ctx.table, "type", "paragraph");
    const key = ctx.history.record(ctx.doc, ctx.table, tx, ctx.undo)!;
    ctx.undo.recordMarker(key);
    expect(ctx.history.step(ctx.doc, ctx.undo, key, false).status).toBe("ready");
    expect(ctx.doc.blockInfo(ctx.table).type).toBe("table");
    expect(ctx.history.step(ctx.doc, ctx.undo, key, true).status).toBe("ready");
    const peer = Doc.fromState(2, ctx.doc.encodeState()), op = peer.insertText(ctx.table, 0, "远端");
    if (op) ctx.doc.apply(op);
    expect(ctx.history.step(ctx.doc, ctx.undo, key, false).status).toBe("conflict");
    expect(ctx.doc.text(ctx.table)).toBe("远端");
  });
});

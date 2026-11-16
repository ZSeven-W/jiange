import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager, idKey } from "@jiange/collab";
import { tableDataOf, tableRowsOf, writeTable } from "./table-cells";
import { TableCellHistory } from "./table-cell-history";
import { applyTableHistory, tableHistoryGuard } from "./table-history-undo";
import { TableStructureHistory } from "./table-structure-history";

function setup() {
  const doc = new Doc(1), tx = new Tx(doc);
  const table = tx.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]), tableWidths: "[100,200]" });
  return { doc, table, undo: new UndoManager(), history: new TableStructureHistory(), cells: new TableCellHistory(), session: {} };
}

function deleteFirstRow(ctx: ReturnType<typeof setup>) {
  const { doc, table, history, undo } = ctx;
  const tx = new Tx(doc);
  writeTable(tx, table, doc.blockInfo(table).props, [["C", "D"]], doc.client);
  const key = history.record(doc, table, tx, undo)!;
  undo.recordMarker(key);
  return key;
}

function editCell(ctx: ReturnType<typeof setup>, col: number, value: string) {
  const { doc, table, history, undo, cells, session } = ctx;
  const info = doc.blockInfo(table), rows = tableRowsOf(info.props), before = rows[0][col];
  const snapshot = history.capture(doc, table, undo), previous = doc.propVersion(table, "tableData"), type = tableHistoryGuard(doc, table);
  const tx = new Tx(doc), nextRows = rows.map((row) => [...row]); nextRows[0][col] = value;
  writeTable(tx, table, info.props, nextRows, doc.client);
  const next = doc.propVersion(table, "tableData"), key = `table:${idKey(table)}:0:${col}`;
  const merged = cells.record(session, key, before, value, previous ? idKey(previous) : null, next ? idKey(next) : null, type, "insertText", Date.now(), undo.peekMarker(false) === key);
  undo.recordMarker(key, merged); history.recordEdit(doc, table, key, snapshot, merged, undo);
  return key;
}

function editGrid(ctx: ReturnType<typeof setup>, nextRows: string[][]) {
  const { doc, table, history, undo, cells, session } = ctx, info = doc.blockInfo(table);
  const before = tableDataOf(info.props), snapshot = history.capture(doc, table, undo);
  const previous = doc.propVersion(table, "tableData"), type = tableHistoryGuard(doc, table), tx = new Tx(doc);
  writeTable(tx, table, info.props, nextRows, doc.client);
  const next = doc.propVersion(table, "tableData"), key = `table:${idKey(table)}:-1:-1`;
  cells.record(session, key, before, tableDataOf(doc.blockInfo(table).props), previous ? idKey(previous) : null, next ? idKey(next) : null, type, "paste", Date.now(), false);
  undo.recordMarker(key); history.recordEdit(doc, table, key, snapshot, false, undo);
  return key;
}

function stepCell(ctx: ReturnType<typeof setup>, key: string, redo = false) {
  if (ctx.history.beforeEditStep(ctx.doc, ctx.table, key, redo) === "conflict") return "conflict";
  const result = applyTableHistory(ctx.doc, ctx.session, ctx.undo, ctx.cells, key, redo);
  if (result.status === "ready") ctx.history.afterEditStep(ctx.doc, ctx.table, key, redo, result.ops);
  return result.status;
}

function stepStructure(ctx: ReturnType<typeof setup>, key: string, redo = false) {
  const result = ctx.history.step(ctx.doc, ctx.undo, key, redo);
  if (result.status === "ready" && result.rebase) ctx.cells.rebaseStructure(ctx.session, `table:${idKey(ctx.table)}:`, result.rebase.logical.data, result.rebase.actual.data, result.rebase.logical.guard, result.rebase.actual.guard);
  return result.status;
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
  it("undoes a later cell edit before undoing the preceding row deletion", () => {
    const ctx = setup(), structure = deleteFirstRow(ctx), cell = editCell(ctx, 0, "C!");
    expect(stepCell(ctx, cell)).toBe("ready");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)).toEqual([["C", "D"]]);
    expect(stepStructure(ctx, structure)).toBe("ready");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)).toEqual([["A", "B"], ["C", "D"]]);
    expect(stepStructure(ctx, structure, true)).toBe("ready");
    expect(stepCell(ctx, cell, true)).toBe("ready");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)).toEqual([["C!", "D"]]);
    expect(stepCell(ctx, cell)).toBe("ready");
    expect(stepStructure(ctx, structure)).toBe("ready");
  });
  it("rebases merged typing and two successive cell edits in undo order", () => {
    const ctx = setup(), structure = deleteFirstRow(ctx);
    const first = editCell(ctx, 0, "C!"), merged = editCell(ctx, 0, "C!!"), second = editCell(ctx, 1, "D!");
    expect(merged).toBe(first);
    expect(stepCell(ctx, second)).toBe("ready");
    expect(stepCell(ctx, first)).toBe("ready");
    expect(stepStructure(ctx, structure)).toBe("ready");
    expect(tableDataOf(ctx.doc.blockInfo(ctx.table).props)).toBe(JSON.stringify([["A", "B"], ["C", "D"]]));
    expect(stepStructure(ctx, structure, true)).toBe("ready");
    expect(stepCell(ctx, first, true)).toBe("ready");
    expect(stepCell(ctx, second, true)).toBe("ready");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)).toEqual([["C!!", "D!"]]);
  });
  it("rebases a same-size multi-cell paste around a structural deletion", () => {
    const ctx = setup(), structure = deleteFirstRow(ctx), paste = editGrid(ctx, [["新", "值"]]);
    expect(stepCell(ctx, paste)).toBe("ready");
    expect(stepStructure(ctx, structure)).toBe("ready");
    expect(stepStructure(ctx, structure, true)).toBe("ready");
    expect(stepCell(ctx, paste, true)).toBe("ready");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)).toEqual([["新", "值"]]);
  });
  it("rebases a column deletion including widths across undo and redo", () => {
    const ctx = setup(), tx = new Tx(ctx.doc);
    writeTable(tx, ctx.table, ctx.doc.blockInfo(ctx.table).props, [["B"], ["D"]], ctx.doc.client);
    tx.setProp(ctx.table, "tableWidths", "[200]");
    const structure = ctx.history.record(ctx.doc, ctx.table, tx, ctx.undo)!; ctx.undo.recordMarker(structure);
    const cell = editCell(ctx, 0, "B!");
    expect(stepCell(ctx, cell)).toBe("ready");
    expect(stepStructure(ctx, structure)).toBe("ready");
    expect(ctx.doc.blockInfo(ctx.table).props.tableWidths).toBe("[100,200]");
    expect(stepStructure(ctx, structure, true)).toBe("ready");
    expect(stepCell(ctx, cell, true)).toBe("ready");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)).toEqual([["B!"], ["D"]]);
    expect(ctx.doc.blockInfo(ctx.table).props.tableWidths).toBe("[200]");
  });
  it("does not rebase through another operation that changes table axes", () => {
    const ctx = setup(), structure = deleteFirstRow(ctx), append = editGrid(ctx, [["C", "D"], ["", ""]]);
    expect(stepCell(ctx, append)).toBe("ready");
    expect(stepStructure(ctx, structure)).toBe("conflict");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)).toEqual([["C", "D"]]);
  });
  it("blocks a tracked cell undo when a peer changes even an unrelated register", () => {
    const ctx = setup(); deleteFirstRow(ctx); const cell = editCell(ctx, 0, "C!");
    const peer = Doc.fromState(2, ctx.doc.encodeState());
    ctx.doc.apply(peer.setProp(ctx.table, "tableWidths", "[101,200]"));
    expect(stepCell(ctx, cell)).toBe("conflict");
    expect(ctx.doc.blockInfo(ctx.table).props.tableWidths).toBe("[101,200]");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)[0][0]).toBe("C!");
    expect(ctx.undo.peekMarker(false)).toBe(cell);
  });
  it("blocks a tracked undo after a peer writes the same cell value", () => {
    const ctx = setup(); deleteFirstRow(ctx); const cell = editCell(ctx, 0, "C!");
    const props = ctx.doc.blockInfo(ctx.table).props;
    const cellKey = Object.keys(props).find((key) => key.startsWith("tbl.c.") && props[key] === "C!");
    expect(cellKey).toBeDefined();
    const peer = Doc.fromState(2, ctx.doc.encodeState());
    ctx.doc.apply(peer.setProp(ctx.table, cellKey!, "C!"));
    expect(stepCell(ctx, cell)).toBe("conflict");
    expect(ctx.undo.peekMarker(false)).toBe(cell);
  });
  it("drops stale transition tracking when a new edit discards structural redo", () => {
    const ctx = setup(), structure = deleteFirstRow(ctx), oldCell = editCell(ctx, 0, "C!");
    expect(stepCell(ctx, oldCell)).toBe("ready");
    expect(stepStructure(ctx, structure)).toBe("ready");
    const newCell = editCell(ctx, 0, "A!");
    expect(stepCell(ctx, newCell)).toBe("ready");
    expect(stepCell(ctx, newCell, true)).toBe("ready");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)).toEqual([["A!", "B"], ["C", "D"]]);
  });
});

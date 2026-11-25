import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager, idKey } from "@zseven-w/collab";
import { applyTableWrites, cellTableWrites, isCellTable, tableDataOf, tableRowsOf, writeTable } from "./table-cells";
import { TableCellHistory } from "./table-cell-history";
import { applyTableHistory, tableHistoryGuard } from "./table-history-undo";
import { TableStructureHistory } from "./table-structure-history";
import { TableWidthHistory } from "./table-width-history";

function setup() {
  const doc = new Doc(1), tx = new Tx(doc);
  const table = tx.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]), tableWidths: "[100,200]" });
  return { doc, table, undo: new UndoManager(), history: new TableStructureHistory(), widths: new TableWidthHistory(), cells: new TableCellHistory(), session: {} };
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
  const widthBefore = !isCellTable(info.props) ? ctx.widths.capture(doc, table) : null;
  const snapshot = history.capture(doc, table, undo), previous = doc.propVersion(table, "tableData"), type = tableHistoryGuard(doc, table);
  const tx = new Tx(doc), nextRows = rows.map((row) => [...row]); nextRows[0][col] = value;
  writeTable(tx, table, info.props, nextRows, doc.client);
  ctx.widths.rebaseMigration(doc, table, widthBefore, info.props);
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
  if (result.status === "ready") {
    ctx.history.afterEditStep(ctx.doc, ctx.table, key, redo, result.ops);
    ctx.widths.rebaseData(ctx.doc, ctx.table, result.rebase.logical, result.rebase.actual, result.ops);
  }
  return result.status;
}

function stepStructure(ctx: ReturnType<typeof setup>, key: string, redo = false) {
  const result = ctx.history.step(ctx.doc, ctx.undo, key, redo);
  if (result.status === "ready" && result.rebase) {
    ctx.cells.rebaseStructure(ctx.session, `table:${idKey(ctx.table)}:`, result.rebase.logical.data, result.rebase.actual.data, result.rebase.logical.guard, result.rebase.actual.guard);
    ctx.widths.rebaseStructure(ctx.doc, ctx.table, result.rebase.logicalSnapshot, result.rebase.actualSnapshot);
  }
  return result.status;
}

describe("guarded table selection deletion history", () => {
  it("can undo a later cell edit before undoing a resize", () => {
    const ctx = setup(), info = ctx.doc.blockInfo(ctx.table), migrate = new Tx(ctx.doc);
    applyTableWrites(migrate, ctx.table, info.props, cellTableWrites(info.props, tableRowsOf(info.props), ctx.doc.client));
    const before = ctx.widths.capture(ctx.doc, ctx.table)!;
    new Tx(ctx.doc).setProp(ctx.table, "tableWidths", "[150,200]");
    const width = ctx.widths.record(ctx.doc, ctx.undo, ctx.table, before), cell = editCell(ctx, 0, "A!");
    expect(stepCell(ctx, cell)).toBe("ready");
    const result = ctx.widths.prepareConditional(ctx.doc, ctx.undo, width, false);
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    ctx.doc.apply(result.plan.op);
    expect(ctx.widths.finishConditional(ctx.doc, ctx.undo, result.plan)).toBe("ready");
    expect(ctx.doc.blockInfo(ctx.table).props.tableWidths).toBe("[100,200]");
  });
  it("preserves resize undo through the first edit and migration of a legacy table", () => {
    const ctx = setup(), before = ctx.widths.capture(ctx.doc, ctx.table)!;
    new Tx(ctx.doc).setProp(ctx.table, "tableWidths", "[150,200]");
    const width = ctx.widths.record(ctx.doc, ctx.undo, ctx.table, before), cell = editCell(ctx, 0, "A!");
    expect(isCellTable(ctx.doc.blockInfo(ctx.table).props)).toBe(true);
    expect(stepCell(ctx, cell)).toBe("ready");
    const result = ctx.widths.prepareConditional(ctx.doc, ctx.undo, width, false);
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    ctx.doc.apply(result.plan.op);
    expect(ctx.widths.finishConditional(ctx.doc, ctx.undo, result.plan)).toBe("ready");
    expect(ctx.doc.blockInfo(ctx.table).props.tableWidths).toBe("[100,200]");
  });
  it("keeps an accepted resize undoable when the first cell edit arrives before its receipt", () => {
    const ctx = setup(), before = ctx.widths.capture(ctx.doc, ctx.table)!;
    const initial = ctx.widths.prepareInitial(ctx.doc, ctx.undo, ctx.table, before, "[150,200]");
    expect(initial.status).toBe("ready"); if (initial.status !== "ready") return;
    ctx.doc.apply(initial.plan.op);
    const cell = editCell(ctx, 0, "A!");
    const recorded = ctx.widths.finishInitial(ctx.doc, ctx.undo, initial.plan);
    expect(recorded.status).toBe("changed"); if (recorded.status !== "changed") return;
    expect(stepCell(ctx, cell)).toBe("ready");
    const resize = ctx.widths.prepareConditional(ctx.doc, ctx.undo, recorded.key, false);
    expect(resize.status).toBe("ready"); if (resize.status !== "ready") return;
    ctx.doc.apply(resize.plan.op);
    expect(ctx.widths.finishConditional(ctx.doc, ctx.undo, resize.plan)).toBe("ready");
    expect(ctx.doc.blockInfo(ctx.table).props.tableWidths).toBe("[100,200]");
  });
  it("keeps a resize and a preceding row deletion in undo and redo order", () => {
    const ctx = setup(), structure = deleteFirstRow(ctx), widths = ctx.widths;
    const before = widths.capture(ctx.doc, ctx.table)!, snapshot = ctx.history.capture(ctx.doc, ctx.table, ctx.undo);
    new Tx(ctx.doc).setProp(ctx.table, "tableWidths", "[150,200]");
    const key = widths.record(ctx.doc, ctx.undo, ctx.table, before);
    ctx.history.recordEdit(ctx.doc, ctx.table, key, snapshot, false, ctx.undo);
    const stepWidth = (redo = false) => {
      if (ctx.history.beforeEditStep(ctx.doc, ctx.table, key, redo) === "conflict") return "conflict";
      const result = widths.prepareConditional(ctx.doc, ctx.undo, key, redo);
      if (result.status !== "ready") return result.status;
      ctx.doc.apply(result.plan.op);
      const status = widths.finishConditional(ctx.doc, ctx.undo, result.plan);
      if (status === "ready") ctx.history.afterEditStep(ctx.doc, ctx.table, key, redo, [result.plan.op]);
      return status;
    };
    expect(stepWidth()).toBe("ready");
    expect(stepStructure(ctx, structure)).toBe("ready");
    expect(stepStructure(ctx, structure, true)).toBe("ready");
    expect(stepWidth(true)).toBe("ready");
    expect(ctx.doc.blockInfo(ctx.table).props.tableWidths).toBe("[150,200]");
  });
  it("undoes and redoes successive independent header changes", () => {
    const ctx = setup();
    const change = (key: string, value: string) => {
      const before = ctx.history.snapshot(ctx.doc, ctx.table), tx = new Tx(ctx.doc);
      tx.setProp(ctx.table, key, value);
      const marker = ctx.history.record(ctx.doc, ctx.table, tx, ctx.undo, before)!;
      ctx.undo.recordMarker(marker); return marker;
    };
    const row = change("tableHeader", "none"), col = change("tableHeaderColumn", "column");
    expect(stepStructure(ctx, col)).toBe("ready");
    expect(stepStructure(ctx, row)).toBe("ready");
    expect(ctx.doc.blockInfo(ctx.table).props.tableHeaderColumn).toBe("");
    expect(ctx.doc.blockInfo(ctx.table).props.tableHeader).toBe("");
    expect(stepStructure(ctx, row, true)).toBe("ready");
    expect(stepStructure(ctx, col, true)).toBe("ready");
    expect(ctx.doc.blockInfo(ctx.table).props.tableHeaderColumn).toBe("column");
    expect(ctx.doc.blockInfo(ctx.table).props.tableHeader).toBe("none");
  });
  it("refuses a header undo after the peer changes that property even to the same value", () => {
    const ctx = setup(), before = ctx.history.snapshot(ctx.doc, ctx.table), tx = new Tx(ctx.doc);
    tx.setProp(ctx.table, "tableHeaderColumn", "column");
    const key = ctx.history.record(ctx.doc, ctx.table, tx, ctx.undo, before)!; ctx.undo.recordMarker(key);
    const peer = Doc.fromState(2, ctx.doc.encodeState()); ctx.doc.apply(peer.setProp(ctx.table, "tableHeaderColumn", "column"));
    expect(stepStructure(ctx, key)).toBe("conflict");
    expect(ctx.doc.blockInfo(ctx.table).props.tableHeaderColumn).toBe("column");
    expect(ctx.undo.peekMarker(false)).toBe(key);
  });
  it("preserves undo order across a structural edit and a later header toggle", () => {
    const ctx = setup(), structure = deleteFirstRow(ctx), before = ctx.history.snapshot(ctx.doc, ctx.table), tx = new Tx(ctx.doc);
    tx.setProp(ctx.table, "tableHeaderColumn", "column");
    const header = ctx.history.record(ctx.doc, ctx.table, tx, ctx.undo, before)!; ctx.undo.recordMarker(header);
    expect(stepStructure(ctx, header)).toBe("ready");
    expect(stepStructure(ctx, structure)).toBe("ready");
    expect(stepStructure(ctx, structure, true)).toBe("ready");
    expect(stepStructure(ctx, header, true)).toBe("ready");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)).toEqual([["C", "D"]]);
    expect(ctx.doc.blockInfo(ctx.table).props.tableHeaderColumn).toBe("column");
  });
  it("undoes a later cell edit before the header toggle", () => {
    const ctx = setup(), props = ctx.doc.blockInfo(ctx.table).props, migration = new Tx(ctx.doc);
    applyTableWrites(migration, ctx.table, props, cellTableWrites(props, tableRowsOf(props), ctx.doc.client));
    const before = ctx.history.snapshot(ctx.doc, ctx.table), tx = new Tx(ctx.doc);
    tx.setProp(ctx.table, "tableHeaderColumn", "column");
    const header = ctx.history.record(ctx.doc, ctx.table, tx, ctx.undo, before)!; ctx.undo.recordMarker(header);
    const cell = editCell(ctx, 0, "A!");
    expect(stepCell(ctx, cell)).toBe("ready");
    expect(stepStructure(ctx, header)).toBe("ready");
    expect(stepStructure(ctx, header, true)).toBe("ready");
    expect(stepCell(ctx, cell, true)).toBe("ready");
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)[0][0]).toBe("A!");
    expect(ctx.doc.blockInfo(ctx.table).props.tableHeaderColumn).toBe("column");
  });
  it("keeps the migration after a header undo so a late peer cell edit stays visible", () => {
    const ctx = setup(), props = ctx.doc.blockInfo(ctx.table).props, migration = new Tx(ctx.doc);
    applyTableWrites(migration, ctx.table, props, cellTableWrites(props, tableRowsOf(props), ctx.doc.client));
    const peer = Doc.fromState(2, ctx.doc.encodeState()), before = ctx.history.snapshot(ctx.doc, ctx.table), tx = new Tx(ctx.doc);
    tx.setProp(ctx.table, "tableHeaderColumn", "column");
    const header = ctx.history.record(ctx.doc, ctx.table, tx, ctx.undo, before)!; ctx.undo.recordMarker(header);
    const peerEdit = new Tx(peer), peerProps = peer.blockInfo(ctx.table).props;
    writeTable(peerEdit, ctx.table, peerProps, [["A", "B"], ["C", "远端"]], peer.client);
    expect(stepStructure(ctx, header)).toBe("ready");
    for (const op of peerEdit.ops) ctx.doc.apply(op);
    expect(isCellTable(ctx.doc.blockInfo(ctx.table).props)).toBe(true);
    expect(tableRowsOf(ctx.doc.blockInfo(ctx.table).props)[1][1]).toBe("远端");
  });
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

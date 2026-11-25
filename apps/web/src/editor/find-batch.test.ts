import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager, encodeClientMsg, encodeOps, idKey } from "@zseven-w/collab";
import { findDocumentMatches } from "./table-find";
import { applyFindBatch, canStepFindBatch, FindBatchHistory } from "./find-batch";
import { tableRowsOf, writeTable } from "./table-cells";
import { applyTableFindReplace } from "./table-find-apply";
import { applyTableHistory } from "./table-history-undo";
import { TableCellHistory } from "./table-cell-history";

function setup() {
  const doc = new Doc(9), tx = new Tx(doc), text = tx.create("paragraph", null, ROOT);
  tx.insert(text, 0, "目标与目标");
  const table = tx.create("table", text, ROOT, { tableData: JSON.stringify([["目标😀目标", "目标"], ["不变", "目标"]]) });
  const next = tx.create("paragraph", table, ROOT); tx.insert(next, 0, "目标结束");
  return { doc, text, table, next, undo: new UndoManager(), history: new FindBatchHistory() };
}
const grid = (doc: Doc, table: { client: number; clock: number }) => tableRowsOf(doc.blockInfo(table).props);

describe("mixed find and replace all", () => {
  it("allows grouped undo only on a connected, caught-up replica without pending writes", () => {
    const ready = { caughtUp: true, status: "synced", unacked: 0, blocked: null };
    expect(canStepFindBatch(ready)).toBe(true);
    expect(canStepFindBatch({ ...ready, caughtUp: false })).toBe(false);
    expect(canStepFindBatch({ ...ready, status: "offline" })).toBe(false);
    expect(canStepFindBatch({ ...ready, status: "syncing" })).toBe(false);
    expect(canStepFindBatch({ ...ready, unacked: 1 })).toBe(false);
    expect(canStepFindBatch({ ...ready, blocked: "read_only" })).toBe(false);
  });
  it("replaces text and multiple matches in multiple cells as one undoable action", () => {
    const { doc, text, table, next, undo, history } = setup();
    const matches = findDocumentMatches(doc, "目标"), result = applyFindBatch(doc, undo, history, matches, "完成");
    expect(result.status).toBe("replaced"); expect(result.count).toBe(7);
    expect(doc.text(text)).toBe("完成与完成"); expect(doc.text(next)).toBe("完成结束");
    expect(grid(doc, table)).toEqual([["完成😀完成", "完成"], ["不变", "完成"]]);
    const marker = undo.peekMarker(false)!;
    expect(history.step(doc, undo, marker, false).status).toBe("ready");
    expect(doc.text(text)).toBe("目标与目标"); expect(grid(doc, table)[0][0]).toBe("目标😀目标");
    expect(history.step(doc, undo, marker, true).status).toBe("ready");
    expect(doc.text(text)).toBe("完成与完成"); expect(grid(doc, table)[1][1]).toBe("完成");
  });

  it("refuses stale results without applying any part of the batch", () => {
    const { doc, text, table, undo, history } = setup(), matches = findDocumentMatches(doc, "目标");
    const tx = new Tx(doc), props = doc.blockInfo(table).props, rows = grid(doc, table); rows[0][0] = "已修改"; writeTable(tx, table, props, rows, doc.client);
    const before = doc.encodeState(), result = applyFindBatch(doc, undo, history, matches, "完成");
    expect(result.status).toBe("stale"); expect(doc.encodeState()).toEqual(before); expect(doc.text(text)).toBe("目标与目标");
    expect(undo.canUndo).toBe(false);
  });

  it("refuses a batch if a text result becomes a mention before applying it", () => {
    const { doc, text, table, undo, history } = setup(), matches = findDocumentMatches(doc, "目标");
    new Tx(doc).format(text, 0, 2, "mention", "42");
    const before = doc.encodeState();
    expect(applyFindBatch(doc, undo, history, matches, "完成").status).toBe("stale");
    expect(doc.encodeState()).toEqual(before);
    expect(grid(doc, table)[0][0]).toBe("目标😀目标");
  });

  it("replaces ordinary text and table matches while preserving mentions through undo", () => {
    const { doc, text, table, undo, history } = setup();
    new Tx(doc).format(text, 0, 2, "link", "#/doc/12");
    const matches = findDocumentMatches(doc, "目标");
    expect(matches.filter((match) => match.mention)).toHaveLength(1);
    expect(applyFindBatch(doc, undo, history, matches.filter((match) => !match.mention), "完成").status).toBe("replaced");
    expect(doc.text(text)).toBe("目标与完成");
    expect(doc.richChars(text)[0].marks.link).toBe("#/doc/12");
    expect(grid(doc, table)[0][0]).toBe("完成😀完成");
    expect(history.step(doc, undo, undo.peekMarker(false)!, false).status).toBe("ready");
    expect(doc.text(text)).toBe("目标与目标");
    expect(doc.richChars(text)[0].marks.link).toBe("#/doc/12");
    expect(grid(doc, table)[0][0]).toBe("目标😀目标");
  });

  it("rejects stale text without replacing otherwise-valid tables", () => {
    const { doc, text, table, undo, history } = setup(), matches = findDocumentMatches(doc, "目标");
    new Tx(doc).delete(text, 0, 1);
    const before = doc.encodeState();
    expect(applyFindBatch(doc, undo, history, matches, "完成").status).toBe("stale");
    expect(doc.encodeState()).toEqual(before);
    expect(grid(doc, table)[0][0]).toBe("目标😀目标");
  });

  it("replaces and undoes more than one table", () => {
    const { doc, table, next, undo, history } = setup();
    const second = new Tx(doc).create("table", next, ROOT, { tableData: JSON.stringify([["目标", "目标"]]) });
    const matches = findDocumentMatches(doc, "目标");
    expect(applyFindBatch(doc, undo, history, matches, "完成").count).toBe(9);
    expect(grid(doc, second)[0]).toEqual(["完成", "完成"]);
    expect(history.step(doc, undo, undo.peekMarker(false)!, false).status).toBe("ready");
    expect(grid(doc, table)[0][0]).toBe("目标😀目标"); expect(grid(doc, second)[0]).toEqual(["目标", "目标"]);
  });

  it("refuses a conflicting table undo without reverting the text", () => {
    const { doc, text, table, undo, history } = setup();
    applyFindBatch(doc, undo, history, findDocumentMatches(doc, "目标"), "完成");
    const marker = undo.peekMarker(false)!, props = doc.blockInfo(table).props, rows = grid(doc, table); rows[1][1] = "远端更改";
    writeTable(new Tx(doc), table, props, rows, doc.client);
    const before = doc.encodeState();
    expect(history.step(doc, undo, marker, false).status).toBe("conflict");
    expect(doc.encodeState()).toEqual(before); expect(doc.text(text)).toBe("完成与完成");
    expect(undo.peekMarker(false)).toBe(marker);
  });

  it("preserves later unrelated text and refuses undo when a matched text block is deleted", () => {
    const { doc, text, table, undo, history } = setup();
    applyFindBatch(doc, undo, history, findDocumentMatches(doc, "目标"), "完成");
    const marker = undo.peekMarker(false)!;
    doc.insertText(text, [...doc.text(text)].length, "远端");
    expect(history.step(doc, undo, marker, false).status).toBe("ready");
    expect(doc.text(text)).toBe("目标与目标远端");
    expect(history.step(doc, undo, marker, true).status).toBe("ready");
    doc.deleteBlock(text);
    const before = doc.encodeState();
    expect(history.step(doc, undo, marker, false).status).toBe("conflict");
    expect(doc.encodeState()).toEqual(before); expect(grid(doc, table)[0][0]).toBe("完成😀完成");
  });

  it("shares text identifier remaps with earlier editor undo and redo", () => {
    const doc = new Doc(4), init = new Tx(doc), block = init.create("paragraph", null, ROOT), table = init.create("table", block, ROOT, { tableData: JSON.stringify([["目标"]]) });
    const undo = new UndoManager(), history = new FindBatchHistory(), typing = new Tx(doc); typing.insert(block, 0, "目标"); undo.record(typing, null, null);
    applyFindBatch(doc, undo, history, findDocumentMatches(doc, "目标"), "完成");
    const marker = undo.peekMarker(false)!;
    expect(history.step(doc, undo, marker, false).status).toBe("ready");
    expect(doc.text(block)).toBe("目标");
    undo.undo(doc); expect(doc.text(block)).toBe("");
    undo.redo(doc); expect(doc.text(block)).toBe("目标");
    expect(history.step(doc, undo, marker, true).status).toBe("ready");
    expect(doc.text(block)).toBe("完成"); expect(grid(doc, table)[0][0]).toBe("完成");
  });

  it("supports undoing adjacent batch replacements on the same table", () => {
    const { doc, table, undo, history } = setup();
    applyFindBatch(doc, undo, history, findDocumentMatches(doc, "目标"), "完成");
    const first = undo.peekMarker(false)!;
    applyFindBatch(doc, undo, history, findDocumentMatches(doc, "完成"), "验收");
    const second = undo.peekMarker(false)!;
    expect(history.step(doc, undo, second, false).status).toBe("ready");
    expect(grid(doc, table)[0][0]).toBe("完成😀完成");
    expect(history.step(doc, undo, first, false).status).toBe("ready");
    expect(grid(doc, table)[0][0]).toBe("目标😀目标");
    expect(history.step(doc, undo, first, true).status).toBe("ready");
    expect(history.step(doc, undo, second, true).status).toBe("ready");
    expect(grid(doc, table)[0][0]).toBe("验收😀验收");
    expect(history.step(doc, undo, second, false).status).toBe("ready");
    expect(history.step(doc, undo, first, false).status).toBe("ready");
    expect(grid(doc, table)[0][0]).toBe("目标😀目标");
  });

  it("does not rebase a previously conflicted same-value cell write", () => {
    const { doc, table, undo, history } = setup();
    applyFindBatch(doc, undo, history, findDocumentMatches(doc, "目标"), "完成");
    const first = undo.peekMarker(false)!;
    doc.setProp(table, "tbl.c.r0.c0", grid(doc, table)[0][0]);
    applyFindBatch(doc, undo, history, findDocumentMatches(doc, "完成"), "验收");
    const second = undo.peekMarker(false)!;
    expect(history.step(doc, undo, second, false).status).toBe("ready");
    expect(history.step(doc, undo, first, false).status).toBe("conflict");
  });

  it("rebases a preceding single-cell undo after undoing the batch", () => {
    const { doc, table, undo, history } = setup(), session = {}, cellHistory = new TableCellHistory();
    const cellMatch = findDocumentMatches(doc, "目标").find((m) => !!m.table)!;
    expect(applyTableFindReplace(doc, session, undo, cellHistory, cellMatch, "计划").status).toBe("replaced");
    const cellMarker = `table:${idKey(table)}:0:0`;
    applyFindBatch(doc, undo, history, findDocumentMatches(doc, "目标"), "完成");
    const result = history.step(doc, undo, undo.peekMarker(false)!, false);
    expect(result.status).toBe("ready");
    if (result.status === "ready") for (const r of result.rebases) cellHistory.rebase(session, `table:${idKey(r.block)}:`, r.logical, r.actual, r.guard);
    expect(applyTableHistory(doc, session, undo, cellHistory, cellMarker, false).status).toBe("ready");
    expect(grid(doc, table)[0][0]).toBe("目标😀目标");
  });

  it("preserves adjacent batch history through a later cell edit and its undo/redo", () => {
    const { doc, table, undo, history } = setup(), session = {}, cellHistory = new TableCellHistory();
    applyFindBatch(doc, undo, history, findDocumentMatches(doc, "目标"), "完成");
    const batch = undo.peekMarker(false)!, match = findDocumentMatches(doc, "完成").find((m) => !!m.table)!;
    const aliases = history.capture(doc, [table]);
    expect(applyTableFindReplace(doc, session, undo, cellHistory, match, "计划").status).toBe("replaced");
    const cellMarker = `table:${idKey(table)}:0:0`; history.recordTableChange(cellMarker, aliases, false);
    const undoCellAliases = history.capture(doc, [table]);
    expect(applyTableHistory(doc, session, undo, cellHistory, cellMarker, false).status).toBe("ready");
    history.finishTableChange(doc, cellMarker, false, undoCellAliases);
    const back = history.step(doc, undo, batch, false); expect(back.status).toBe("ready");
    if (back.status === "ready") for (const r of back.rebases) cellHistory.rebase(session, `table:${idKey(r.block)}:`, r.logical, r.actual, r.guard);
    expect(grid(doc, table)[0][0]).toBe("目标😀目标");
    const forward = history.step(doc, undo, batch, true); expect(forward.status).toBe("ready");
    if (forward.status === "ready") for (const r of forward.rebases) cellHistory.rebase(session, `table:${idKey(r.block)}:`, r.logical, r.actual, r.guard);
    const redoCellAliases = history.capture(doc, [table]);
    expect(applyTableHistory(doc, session, undo, cellHistory, cellMarker, true).status).toBe("ready");
    history.finishTableChange(doc, cellMarker, true, redoCellAliases);
    expect(grid(doc, table)[0][0]).toBe("计划😀完成");
    const aliasesAgain = history.capture(doc, [table]);
    expect(applyTableHistory(doc, session, undo, cellHistory, cellMarker, false).status).toBe("ready");
    history.finishTableChange(doc, cellMarker, false, aliasesAgain);
    expect(history.step(doc, undo, batch, false).status).toBe("ready");
  });

  it("keeps mixed batches and a cell edit in the right undo order", () => {
    const { doc, table, undo, history } = setup(), session = {}, cellHistory = new TableCellHistory();
    applyFindBatch(doc, undo, history, findDocumentMatches(doc, "目标"), "完成");
    const first = undo.peekMarker(false)!, match = findDocumentMatches(doc, "完成").find((m) => !!m.table)!;
    const aliases = history.capture(doc, [table]);
    expect(applyTableFindReplace(doc, session, undo, cellHistory, match, "计划").status).toBe("replaced");
    const cell = `table:${idKey(table)}:0:0`; history.recordTableChange(cell, aliases, false);
    applyFindBatch(doc, undo, history, findDocumentMatches(doc, "完成"), "验收");
    const second = undo.peekMarker(false)!, back = history.step(doc, undo, second, false);
    expect(back.status).toBe("ready");
    if (back.status === "ready") for (const r of back.rebases) cellHistory.rebase(session, `table:${idKey(r.block)}:`, r.logical, r.actual, r.guard);
    const now = history.capture(doc, [table]);
    expect(applyTableHistory(doc, session, undo, cellHistory, cell, false).status).toBe("ready");
    history.finishTableChange(doc, cell, false, now);
    expect(history.step(doc, undo, first, false).status).toBe("ready");
    expect(grid(doc, table)[0][0]).toBe("目标😀目标");
  });

  it("keeps operations bounded and preserves the live state on preflight rejection", () => {
    const { doc, undo, history } = setup(), before = doc.encodeState();
    expect(applyFindBatch(doc, undo, history, findDocumentMatches(doc, "目标"), "x".repeat(1 << 20)).status).toBe("size");
    expect(doc.encodeState()).toEqual(before);
    expect(findDocumentMatches(doc, "目标").filter((m) => m.table).every((m) => idKey(m.block))).toBe(true);
  });

  it("rejects a batch when its inverse would exceed the frame budget", () => {
    const doc = new Doc(4), tx = new Tx(doc), table = tx.create("table", null, ROOT, { tableData: JSON.stringify([["目标".repeat(1000)]]) });
    writeTable(new Tx(doc), table, doc.blockInfo(table).props, grid(doc, table), doc.client);
    const before = doc.encodeState(), clone = Doc.fromState(doc.client, before), history = new FindBatchHistory(), undo = new UndoManager();
    const applied = applyFindBatch(clone, undo, history, findDocumentMatches(clone, "目标"), "");
    expect(applied.status).toBe("replaced");
    const initialSize = encodeClientMsg({ type: "ops", batch: encodeOps(applied.ops) }).byteLength;
    const inverse = history.step(clone, undo, undo.peekMarker(false)!, false);
    expect(inverse.status).toBe("ready");
    if (inverse.status !== "ready") return;
    const inverseSize = encodeClientMsg({ type: "ops", batch: encodeOps(inverse.ops) }).byteLength;
    expect(inverseSize).toBeGreaterThan(initialSize);
    expect(applyFindBatch(doc, new UndoManager(), new FindBatchHistory(), findDocumentMatches(doc, "目标"), "", initialSize).status).toBe("size");
    expect(doc.encodeState()).toEqual(before);
  });
});

import { describe, expect, it } from "vitest";
import { Doc, idKey, ROOT, Tx, UndoManager } from "@zseven-w/collab";
import { findMatches, replaceMatches, resolveFindMatch } from "./find-replace";
import { findDocumentMatches } from "./table-find";
import { applyFindBatch, FindBatchHistory } from "./find-batch";
import { applyTableFindReplace } from "./table-find-apply";
import { TableCellHistory } from "./table-cell-history";
import { applyTableHistory } from "./table-history-undo";
import { TableStructureHistory } from "./table-structure-history";
import { tableRowsOf, writeTable } from "./table-cells";
import {
  restorePersistedUndoHistory,
  savePersistedUndoHistory,
  undoHistoryStorageKey,
  type UndoStorageLike,
} from "./undo-persistence";

function makeStorage(): UndoStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

describe("formula-safe find & replace (includeMath)", () => {
  it("finds and safely replaces both block math and inline math when includeMath is true, with atomic undo", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const para = tx.create("paragraph", null, ROOT);
    tx.insert(para, 0, "已知 alpha + beta 满足 ");
    const inlineStart = [...doc.text(para)].length;
    tx.insert(para, inlineStart, "alpha + alpha^2", { math: "alpha + alpha^2", mathId: "m1" });
    const mathBlock = tx.create("math", para, ROOT);
    tx.insert(mathBlock, 0, "\\frac{alpha}{2} + alpha");

    // Default behavior keeps existing contract: formulas excluded unless opted in
    expect(findMatches(doc, "alpha")).toHaveLength(1);

    // Opt-in includeMath finds text + 2 inline formula hits + 2 block formula hits
    const matches = findMatches(doc, "alpha", { includeMath: true });
    expect(matches).toHaveLength(5);
    expect(matches[0].math).toBeUndefined();
    expect(matches[1].math).toMatchObject({ kind: "inline", formula: "alpha + alpha^2" });
    expect(matches[2].math).toMatchObject({ kind: "inline", formula: "alpha + alpha^2" });
    expect(matches[3].math).toMatchObject({ kind: "block" });
    expect(matches[4].math).toMatchObject({ kind: "block" });
    expect(resolveFindMatch(doc, matches[1])).not.toBeNull();
    expect(resolveFindMatch(doc, matches[3])).not.toBeNull();

    const undo = new UndoManager();
    const repTx = new Tx(doc);
    const res = replaceMatches(repTx, matches, "gamma");
    expect(res).toEqual({ replaced: 5, skipped: 0 });
    undo.record(repTx, null, null);

    expect(doc.text(para)).toBe("已知 gamma + beta 满足 gamma + gamma^2");
    const inlineChars = doc.richChars(para).slice(inlineStart);
    expect(inlineChars.every((c) => c.marks.math === "gamma + gamma^2" && c.marks.mathId === "m1")).toBe(true);
    expect(doc.text(mathBlock)).toBe("\\frac{gamma}{2} + gamma");

    // Atomic undo restores both inline and block formulas intact
    undo.undo(doc);
    expect(doc.text(para)).toBe("已知 alpha + beta 满足 alpha + alpha^2");
    expect(doc.richChars(para).slice(inlineStart).every((c) => c.marks.math === "alpha + alpha^2" && c.marks.mathId === "m1")).toBe(true);
    expect(doc.text(mathBlock)).toBe("\\frac{alpha}{2} + alpha");

    undo.redo(doc);
    expect(doc.text(mathBlock)).toBe("\\frac{gamma}{2} + gamma");
  });

  it("skips stale inline formula match if a remote edit alters the formula before replace", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const para = tx.create("paragraph", null, ROOT);
    tx.insert(para, 0, "x+y", { math: "x+y", mathId: "m2" });

    const matches = findMatches(doc, "x", { includeMath: true });
    expect(matches).toHaveLength(1);

    // Remote collaborator updates the formula
    const remoteTx = new Tx(doc);
    remoteTx.format(para, 0, 3, "math", "x+z");
    expect(resolveFindMatch(doc, matches[0])).toBeNull();
    const repTx = new Tx(doc);
    expect(replaceMatches(repTx, matches, "a")).toEqual({ replaced: 0, skipped: 1 });
    expect(repTx.ops).toHaveLength(0);
  });

  it("supports caseSensitive inside findDocumentMatches including table cells", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const table = tx.create("table", null, ROOT);
    writeTable(tx, table, {}, [["Alpha", "alpha"]], doc.client);
    expect(findDocumentMatches(doc, "Alpha", { caseSensitive: false })).toHaveLength(2);
    expect(findDocumentMatches(doc, "Alpha", { caseSensitive: true })).toHaveLength(1);
  });
});

describe("TableStructureHistory interop with safe table find & replace", () => {
  function setupTableDoc() {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const para = tx.create("paragraph", null, ROOT);
    tx.insert(para, 0, "目标正文");
    const table = tx.create("table", para, ROOT);
    writeTable(tx, table, {}, [["标题", "目标单元格"], ["行二", "正常"]], doc.client);
    return {
      doc,
      para,
      table,
      session: {},
      undo: new UndoManager(),
      tableHistory: new TableCellHistory(),
      structureHistory: new TableStructureHistory(),
      batchHistory: new FindBatchHistory(),
    };
  }

  it("undoes and redoes structure edit -> Replace All (find-batch) -> undo both -> redo both without false conflicts", () => {
    const { doc, para, table, undo, structureHistory, batchHistory } = setupTableDoc();

    // 1. Structural edit: add a new row to the table
    const beforeStruct = structureHistory.snapshot(doc, table);
    const structTx = new Tx(doc);
    const rows = tableRowsOf(doc.blockInfo(table).props);
    writeTable(structTx, table, doc.blockInfo(table).props, [...rows, ["新增行", "目标新增"]], doc.client);
    const structKey = structureHistory.record(doc, table, structTx, undo, beforeStruct)!;
    undo.recordMarker(structKey);
    expect(tableRowsOf(doc.blockInfo(table).props)).toHaveLength(3);

    // 2. Replace All across body + table ("目标" -> "完成")
    const matches = findDocumentMatches(doc, "目标");
    expect(matches).toHaveLength(3);
    const beforeBatchStruct = structureHistory.capture(doc, table, undo);
    const batchRes = applyFindBatch(doc, undo, batchHistory, matches, "完成");
    expect(batchRes.status).toBe("replaced");
    const batchKey = undo.peekMarker(false)!;
    expect(batchKey.startsWith("find-batch:")).toBe(true);
    structureHistory.recordEdit(doc, table, batchKey, beforeBatchStruct, false, undo);

    expect(doc.text(para)).toBe("完成正文");
    expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([
      ["标题", "完成单元格"],
      ["行二", "正常"],
      ["新增行", "完成新增"],
    ]);

    // 3. Undo Replace All (notifying structureHistory)
    expect(structureHistory.beforeEditStep(doc, table, batchKey, false)).toBe("ready");
    const undoBatch = batchHistory.step(doc, undo, batchKey, false);
    expect(undoBatch.status).toBe("ready");
    if (undoBatch.status === "ready") {
      structureHistory.afterEditStep(
        doc,
        table,
        batchKey,
        false,
        undoBatch.ops.filter((op) => op.t === "bset" && idKey(op.block) === idKey(table)),
      );
    }
    expect(doc.text(para)).toBe("目标正文");
    expect(tableRowsOf(doc.blockInfo(table).props)).toHaveLength(3);

    // 4. Undo Structural edit (must succeed without false conflict!)
    expect(undo.peekMarker(false)).toBe(structKey);
    const beforeUndoStructAliases = batchHistory.capture(doc, [table]);
    const undoStruct = structureHistory.step(doc, undo, structKey, false);
    expect(undoStruct.status).toBe("ready");
    batchHistory.finishTableChange(doc, structKey, false, beforeUndoStructAliases);
    expect(tableRowsOf(doc.blockInfo(table).props)).toHaveLength(2);

    // 5. Redo Structural edit -> Redo Replace All
    const beforeRedoStructAliases = batchHistory.capture(doc, [table]);
    const redoStruct = structureHistory.step(doc, undo, structKey, true);
    expect(redoStruct.status).toBe("ready");
    batchHistory.finishTableChange(doc, structKey, true, beforeRedoStructAliases);
    expect(tableRowsOf(doc.blockInfo(table).props)).toHaveLength(3);

    expect(structureHistory.beforeEditStep(doc, table, batchKey, true)).toBe("ready");
    const redoBatch = batchHistory.step(doc, undo, batchKey, true);
    expect(redoBatch.status).toBe("ready");
    expect(doc.text(para)).toBe("完成正文");
    expect(tableRowsOf(doc.blockInfo(table).props)[2][1]).toBe("完成新增");
  });

  it("undoes single-cell table find-replace followed by preceding structural edit", () => {
    const { doc, table, session, undo, tableHistory, structureHistory } = setupTableDoc();

    const beforeStruct = structureHistory.snapshot(doc, table);
    const structTx = new Tx(doc);
    const rows = tableRowsOf(doc.blockInfo(table).props);
    writeTable(structTx, table, doc.blockInfo(table).props, [...rows, ["三行", "目标三"]], doc.client);
    const structKey = structureHistory.record(doc, table, structTx, undo, beforeStruct)!;
    undo.recordMarker(structKey);

    const cellMatch = findDocumentMatches(doc, "目标三")[0];
    const beforeCell = structureHistory.capture(doc, table, undo);
    const replaced = applyTableFindReplace(doc, session, undo, tableHistory, cellMatch, "替换三");
    expect(replaced.status).toBe("replaced");
    const cellKey = undo.peekMarker(false)!;
    structureHistory.recordEdit(doc, table, cellKey, beforeCell, false, undo);

    expect(structureHistory.beforeEditStep(doc, table, cellKey, false)).toBe("ready");
    const undoCell = applyTableHistory(doc, session, undo, tableHistory, cellKey, false);
    expect(undoCell.status).toBe("ready");
    if (undoCell.status === "ready") structureHistory.afterEditStep(doc, table, cellKey, false, undoCell.ops);
    expect(tableRowsOf(doc.blockInfo(table).props)[2][1]).toBe("目标三");

    const undoStruct = structureHistory.step(doc, undo, structKey, false);
    expect(undoStruct.status).toBe("ready");
    expect(tableRowsOf(doc.blockInfo(table).props)).toHaveLength(2);
  });
});

describe("reload-persistent local undo history (undo-persistence)", () => {
  it("persists and restores text, formula, table structure, and find-batch undo stacks across reload", () => {
    const storage = makeStorage();
    const doc = new Doc(1);
    const seed = new Tx(doc);
    const para = seed.create("paragraph", null, ROOT);
    seed.insert(para, 0, "原始目标");
    const mathBlock = seed.create("math", para, ROOT);
    seed.insert(mathBlock, 0, "alpha + 1");
    const table = seed.create("table", mathBlock, ROOT);
    writeTable(seed, table, {}, [["列", "原始目标"]], doc.client);

    const session1 = {};
    const undo1 = new UndoManager();
    const tableHistory1 = new TableCellHistory();
    const structHistory1 = new TableStructureHistory();
    const batchHistory1 = new FindBatchHistory();

    // Edit 1: structural row insert
    const beforeStruct = structHistory1.snapshot(doc, table);
    const stx = new Tx(doc);
    writeTable(stx, table, doc.blockInfo(table).props, [...tableRowsOf(doc.blockInfo(table).props), ["二", "原始目标"]], doc.client);
    const sk = structHistory1.record(doc, table, stx, undo1, beforeStruct)!;
    undo1.recordMarker(sk);

    // Edit 2: Replace All across paragraph + table
    const beforeBatch = structHistory1.capture(doc, table, undo1);
    const bRes = applyFindBatch(doc, undo1, batchHistory1, findDocumentMatches(doc, "原始目标"), "新版目标");
    expect(bRes.status).toBe("replaced");
    const bk = undo1.peekMarker(false)!;
    structHistory1.recordEdit(doc, table, bk, beforeBatch, false, undo1);

    // Edit 3: Formula block replacement
    const mTx = new Tx(doc);
    replaceMatches(mTx, findMatches(doc, "alpha", { includeMath: true }), "omega");
    undo1.record(mTx, null, null);

    expect(
      savePersistedUndoHistory({
        storage,
        userId: 7,
        docId: 42,
        epoch: 3,
        doc,
        session: session1,
        undo: undo1,
        tableHistory: tableHistory1,
        tableStructureHistory: structHistory1,
        findBatchHistory: batchHistory1,
        readOnly: false,
        copyBlocked: false,
      }),
    ).toBe(true);

    // Simulate page reload with fresh replica and fresh history managers
    const reloadedDoc = Doc.fromState(9, doc.encodeState());
    const session2 = {};
    const undo2 = new UndoManager();
    const tableHistory2 = new TableCellHistory();
    const structHistory2 = new TableStructureHistory();
    const batchHistory2 = new FindBatchHistory();

    expect(
      restorePersistedUndoHistory({
        storage,
        userId: 7,
        docId: 42,
        epoch: 3,
        doc: reloadedDoc,
        session: session2,
        undo: undo2,
        tableHistory: tableHistory2,
        tableStructureHistory: structHistory2,
        findBatchHistory: batchHistory2,
        readOnly: false,
        copyBlocked: false,
      }),
    ).toBe(true);

    // Undo 3: formula block reverts omega -> alpha
    expect(undo2.undo(reloadedDoc)).not.toBeNull();
    expect(reloadedDoc.text(mathBlock)).toBe("alpha + 1");

    // Undo 2: find-batch reverts 新版目标 -> 原始目标 across para & table
    const restoredBatchKey = undo2.peekMarker(false)!;
    expect(restoredBatchKey).toBe(bk);
    expect(structHistory2.beforeEditStep(reloadedDoc, table, restoredBatchKey, false)).toBe("ready");
    const uBatch = batchHistory2.step(reloadedDoc, undo2, restoredBatchKey, false);
    expect(uBatch.status).toBe("ready");
    if (uBatch.status === "ready") {
      structHistory2.afterEditStep(
        reloadedDoc,
        table,
        restoredBatchKey,
        false,
        uBatch.ops.filter((op) => op.t === "bset" && idKey(op.block) === idKey(table)),
      );
    }
    expect(reloadedDoc.text(para)).toBe("原始目标");
    expect(tableRowsOf(reloadedDoc.blockInfo(table).props)[1][1]).toBe("原始目标");

    // Undo 1: table structure row insert reverts cleanly after reload!
    expect(undo2.peekMarker(false)).toBe(sk);
    const uStruct = structHistory2.step(reloadedDoc, undo2, sk, false);
    expect(uStruct.status).toBe("ready");
    expect(tableRowsOf(reloadedDoc.blockInfo(table).props)).toHaveLength(1);
  });

  it("refuses persistence for copy-protected docs and rejects wrong epoch or user", () => {
    const storage = makeStorage();
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const p = tx.create("paragraph", null, ROOT);
    tx.insert(p, 0, "机密文本");
    const undo = new UndoManager();
    undo.record(tx, null, null);
    const ctx = {
      storage,
      userId: 1,
      docId: 99,
      epoch: 5,
      doc,
      session: {},
      undo,
      tableHistory: new TableCellHistory(),
      tableStructureHistory: new TableStructureHistory(),
      findBatchHistory: new FindBatchHistory(),
      readOnly: false,
      copyBlocked: false,
    };

    expect(savePersistedUndoHistory(ctx)).toBe(true);
    expect(storage.map.has(undoHistoryStorageKey(1, 99))).toBe(true);

    // Wrong epoch clears and refuses restore
    expect(restorePersistedUndoHistory({ ...ctx, epoch: 6, undo: new UndoManager() })).toBe(false);
    expect(storage.map.has(undoHistoryStorageKey(1, 99))).toBe(false);

    // Copy-protected refuses save and clears any existing entry
    expect(savePersistedUndoHistory(ctx)).toBe(true);
    expect(savePersistedUndoHistory({ ...ctx, copyBlocked: true })).toBe(false);
    expect(storage.map.has(undoHistoryStorageKey(1, 99))).toBe(false);
  });
});

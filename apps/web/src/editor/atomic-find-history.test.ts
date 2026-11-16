import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Doc, encodeOps, eqId, idKey, ROOT, Tx, UndoManager, type Op } from "@jiange/collab";
import { conditionalBatchBase64, queryConditionalOpsStatus } from "@/lib/api";
import { conditionalOpsDigest, type ConditionalAttempt, type ConditionalObservation } from "@/lib/conditional-journal";
import { TITLE } from "./model";
import { findDocumentMatches } from "./table-find";
import { tableRowsOf, writeTable } from "./table-cells";
import { prepareAtomicFindBatch } from "./atomic-find-batch";
import { AtomicFindHistory } from "./atomic-find-history";
import { applyTableFindReplace } from "./table-find-apply";
import { applyTableHistory } from "./table-history-undo";
import { TableCellHistory } from "./table-cell-history";
import { applyFindBatch, FindBatchHistory } from "./find-batch";

const digest = async (bytes: Uint8Array) => new Uint8Array(await webcrypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
const requestId = "a".repeat(32);
async function receipt(ops: readonly Op[], base: number) {
  const bytes = encodeOps([...ops]), hash = await conditionalOpsDigest(1, base, bytes, digest);
  const attempt: ConditionalAttempt = { version: 1, docId: 7, userId: 2, requestId, historyEpoch: 1, expectedSeq: base, ...hash, batch: conditionalBatchBase64(bytes) };
  const observed: ConditionalObservation = { docId: 7, userId: 2, epoch: 1, lastSeq: base + ops.length, caughtUp: true, blocked: null, unacked: 0 };
  const payload = { state: "committed", docId: 7, userId: 2, requestId, currentEpoch: 1, currentHead: observed.lastSeq, historyEpoch: 1, expectedSeq: base, firstSeq: base + 1, opCount: ops.length, digest: hash.digest };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
  const status = await queryConditionalOpsStatus({ docId: 7, userId: 2, requestId, signal: new AbortController().signal });
  return { attempt, status, observe: () => observed, active: () => true, digest };
}
function fixture() {
  const doc = new Doc(9); doc.apply({ t: "bcreate", id: TITLE, parent: ROOT, pos: "U", type: "title" }); doc.insertText(TITLE, 0, "目标计划");
  const tx = new Tx(doc), text = tx.create("paragraph", TITLE, ROOT); tx.insert(text, 0, "目标正文");
  const table = tx.create("table", text, ROOT, { tableData: JSON.stringify([["目标"]]) });
  const undo = new UndoManager(), history = new AtomicFindHistory();
  const prepared = prepareAtomicFindBatch(doc, 19, findDocumentMatches(doc, "目标"), "完成", "目标计划");
  if (prepared.status !== "ready") throw new Error(prepared.status);
  return { doc, text, table, undo, history, plan: prepared.plan };
}
const grid = (doc: Doc, table: { client: number; clock: number }) => tableRowsOf(doc.blockInfo(table).props);
const apply = (doc: Doc, ops: readonly Op[]) => { for (const op of ops) expect(doc.apply(op)).toBe(true); };
afterEach(() => vi.unstubAllGlobals());

describe("confirmed atomic find history", () => {
  it("records a confirmed mixed batch and prepares undo and redo without modifying the live document", async () => {
    const { doc, text, table, undo, history, plan } = fixture(), anchor = undo.markInsertionPoint();
    apply(doc, plan.ops); const installed = await history.install(plan, doc, undo, anchor, await receipt(plan.ops, 10));
    expect(installed.status).toBe("recorded"); if (installed.status !== "recorded") return;
    expect(await history.install(plan, doc, undo, anchor, await receipt(plan.ops, 10))).toEqual(installed);
    const redacted = await receipt(plan.ops, 10), { batch: _batch, ...redactedAttempt } = redacted.attempt;
    expect(await history.install(plan, doc, undo, anchor, { ...redacted, attempt: { ...redactedAttempt, redacted: true, purpose: "atomic-find" } })).toEqual(installed);
    const beforeUndo = doc.encodeState(), step = history.prepare(doc, undo, installed.key, false, 20, "完成计划");
    expect(step.status).toBe("ready"); if (step.status !== "ready") return;
    expect(doc.encodeState()).toEqual(beforeUndo); expect(step.plan.title).toBe("目标计划");
    apply(doc, step.plan.ops); expect(await history.finish(doc, undo, step.plan, await receipt(step.plan.ops, 30))).toBe("ready");
    expect(await history.finish(doc, undo, step.plan, await receipt(step.plan.ops, 30))).toBe("ready");
    expect(doc.text(TITLE)).toBe("目标计划"); expect(doc.text(text)).toBe("目标正文"); expect(grid(doc, table)).toEqual([["目标"]]);
    const redo = history.prepare(doc, undo, installed.key, true, 21, "目标计划"); expect(redo.status).toBe("ready"); if (redo.status !== "ready") return;
    apply(doc, redo.plan.ops); expect(await history.finish(doc, undo, redo.plan, await receipt(redo.plan.ops, 50))).toBe("ready");
    expect(doc.text(TITLE)).toBe("完成计划"); expect(doc.text(text)).toBe("完成正文"); expect(grid(doc, table)).toEqual([["完成"]]);
  });

  it("does not install or advance history without a matching receipt and observed sequence", async () => {
    const { doc, undo, history, plan } = fixture(), anchor = undo.markInsertionPoint(), proof = await receipt(plan.ops, 10);
    expect((await history.install(plan, doc, undo, anchor, { ...proof, active: () => false })).status).toBe("unobserved");
    expect((await history.install(plan, doc, undo, anchor, { ...proof, observe: () => ({ ...proof.observe(), lastSeq: 10 }) })).status).toBe("unobserved");
    const altered = { ...proof.attempt, digest: "0".repeat(64) };
    expect((await history.install(plan, doc, undo, anchor, { ...proof, attempt: altered })).status).toBe("unobserved");
    expect(undo.canUndo).toBe(false);
  });

  it("keeps a later local edit above the confirmed replacement in undo order", async () => {
    const { doc, text, undo, history, plan } = fixture(), anchor = undo.markInsertionPoint();
    apply(doc, plan.ops); const later = new Tx(doc); later.insert(text, [...doc.text(text)].length, "新"); undo.record(later, null, null);
    const installed = await history.install(plan, doc, undo, anchor, await receipt(plan.ops, 10)); expect(installed.status).toBe("recorded"); if (installed.status !== "recorded") return;
    expect(undo.peekMarker(false)).toBeNull(); undo.undo(doc); expect(undo.peekMarker(false)).toBe(installed.key);
    expect(doc.text(text)).toBe("完成正文");
  });

  it("refuses a stale table or changed directory name without reverting the title", async () => {
    const { doc, table, undo, history, plan } = fixture(), anchor = undo.markInsertionPoint(); apply(doc, plan.ops);
    const installed = await history.install(plan, doc, undo, anchor, await receipt(plan.ops, 10)); if (installed.status !== "recorded") throw new Error(installed.status);
    expect(history.prepare(doc, undo, installed.key, false, 20, "别人改名").status).toBe("conflict");
    const props = doc.blockInfo(table).props; writeTable(new Tx(doc), table, props, [["别人编辑"]], doc.client);
    expect(history.prepare(doc, undo, installed.key, false, 20, "完成计划").status).toBe("conflict");
    expect(doc.text(TITLE)).toBe("完成计划"); expect(grid(doc, table)).toEqual([["别人编辑"]]);
  });

  it("does not move a marker if later history changed while an inverse was in flight", async () => {
    const { doc, text, undo, history, plan } = fixture(), anchor = undo.markInsertionPoint(); apply(doc, plan.ops);
    const installed = await history.install(plan, doc, undo, anchor, await receipt(plan.ops, 10)); if (installed.status !== "recorded") throw new Error(installed.status);
    const step = history.prepare(doc, undo, installed.key, false, 20, "完成计划"); if (step.status !== "ready") throw new Error(step.status);
    const later = new Tx(doc); later.insert(text, 0, "后续"); undo.record(later, null, null);
    apply(doc, step.plan.ops);
    expect(await history.finish(doc, undo, step.plan, await receipt(step.plan.ops, 30))).toBe("conflict");
    expect(undo.peekMarker(false)).toBeNull();
  });

  it("keeps the atomic replacement undoable after a later cell edit is undone", async () => {
    const { doc, table, undo, history, plan } = fixture(), anchor = undo.markInsertionPoint(); apply(doc, plan.ops);
    const installed = await history.install(plan, doc, undo, anchor, await receipt(plan.ops, 10)); if (installed.status !== "recorded") throw new Error(installed.status);
    const session = {}, cells = new TableCellHistory(), match = findDocumentMatches(doc, "完成").find((item) => !!item.table)!;
    const aliases = history.capture(doc, [table]);
    expect(applyTableFindReplace(doc, session, undo, cells, match, "变更").status).toBe("replaced");
    const marker = `table:${idKey(table)}:0:0`; history.recordTableChange(marker, aliases, false);
    const current = history.capture(doc, [table]); expect(applyTableHistory(doc, session, undo, cells, marker, false).status).toBe("ready");
    history.finishTableChange(doc, marker, false, current);
    expect(history.prepare(doc, undo, installed.key, false, 20, "完成计划").status).toBe("ready");
  });

  it("rebases atomic redo after undoing and redoing a cell edit that predates it", async () => {
    const { doc, table, undo, history } = fixture(), session = {}, cells = new TableCellHistory();
    const match = findDocumentMatches(doc, "目标").find((item) => !!item.table)!;
    expect(applyTableFindReplace(doc, session, undo, cells, match, "目标增").status).toBe("replaced");
    const marker = `table:${idKey(table)}:0:0`, prepared = prepareAtomicFindBatch(doc, 19, findDocumentMatches(doc, "目标"), "完成", "目标计划");
    if (prepared.status !== "ready") throw new Error(prepared.status);
    const anchor = undo.markInsertionPoint(); apply(doc, prepared.plan.ops);
    const installed = await history.install(prepared.plan, doc, undo, anchor, await receipt(prepared.plan.ops, 10)); if (installed.status !== "recorded") throw new Error(installed.status);
    const back = history.prepare(doc, undo, installed.key, false, 20, "完成计划"); if (back.status !== "ready") throw new Error(back.status);
    apply(doc, back.plan.ops); expect(await history.finish(doc, undo, back.plan, await receipt(back.plan.ops, 30))).toBe("ready");
    for (const item of history.rebases(back.plan)) cells.rebase(session, `table:${idKey(item.block)}:`, item.logical, item.actual, item.guard);
    let aliases = history.capture(doc, [table]); expect(applyTableHistory(doc, session, undo, cells, marker, false).status).toBe("ready"); history.finishTableChange(doc, marker, false, aliases);
    aliases = history.capture(doc, [table]); expect(applyTableHistory(doc, session, undo, cells, marker, true).status).toBe("ready"); history.finishTableChange(doc, marker, true, aliases);
    expect(history.prepare(doc, undo, installed.key, true, 21, "目标计划").status).toBe("ready");
  });

  it("does not rebase an earlier atomic action across an intervening same-value remote cell write", async () => {
    const { doc, table, undo, history, plan } = fixture(), anchor = undo.markInsertionPoint(); apply(doc, plan.ops);
    const installed = await history.install(plan, doc, undo, anchor, await receipt(plan.ops, 10)); if (installed.status !== "recorded") throw new Error(installed.status);
    doc.setProp(table, "tbl.c.r0.c0", "完成");
    const session = {}, cells = new TableCellHistory(), match = findDocumentMatches(doc, "完成").find((item) => !!item.table)!;
    const aliases = history.capture(doc, [table]); expect(aliases).toEqual([]);
    expect(applyTableFindReplace(doc, session, undo, cells, match, "变更").status).toBe("replaced");
    const marker = `table:${idKey(table)}:0:0`; history.recordTableChange(marker, aliases, false);
    expect(applyTableHistory(doc, session, undo, cells, marker, false).status).toBe("ready"); history.finishTableChange(doc, marker, false, []);
    expect(history.prepare(doc, undo, installed.key, false, 20, "完成计划").status).toBe("conflict");
  });

  it("rebases adjacent confirmed atomic replacements across undo", async () => {
    const { doc, undo, history, plan } = fixture(), firstAnchor = undo.markInsertionPoint(); apply(doc, plan.ops);
    const first = await history.install(plan, doc, undo, firstAnchor, await receipt(plan.ops, 10)); if (first.status !== "recorded") throw new Error(first.status);
    const secondPlan = prepareAtomicFindBatch(doc, 20, findDocumentMatches(doc, "完成"), "验收", "完成计划"); if (secondPlan.status !== "ready") throw new Error(secondPlan.status);
    const aliases = history.capture(doc, secondPlan.plan.tables.map((table) => table.block)), secondAnchor = undo.markInsertionPoint(); apply(doc, secondPlan.plan.ops);
    const second = await history.install(secondPlan.plan, doc, undo, secondAnchor, await receipt(secondPlan.plan.ops, 30), aliases); if (second.status !== "recorded") throw new Error(second.status);
    const back = history.prepare(doc, undo, second.key, false, 21, "验收计划"); if (back.status !== "ready") throw new Error(back.status);
    apply(doc, back.plan.ops); expect(await history.finish(doc, undo, back.plan, await receipt(back.plan.ops, 50))).toBe("ready");
    expect(history.prepare(doc, undo, first.key, false, 22, "完成计划").status).toBe("ready");
  });

  it("allows a preceding mixed table replacement to be undone after atomic undo", async () => {
    const { doc, text, table, undo, history } = fixture(), older = new FindBatchHistory();
    const bodyMatches = findDocumentMatches(doc, "目标").filter((match) => !eqId(match.block, TITLE));
    expect(applyFindBatch(doc, undo, older, bodyMatches, "计划").status).toBe("replaced");
    const oldKey = undo.peekMarker(false)!, previousAliases = older.capture(doc, [table]);
    const next = prepareAtomicFindBatch(doc, 19, findDocumentMatches(doc, "计划"), "完成", "目标计划"); if (next.status !== "ready") throw new Error(next.status);
    const anchor = undo.markInsertionPoint(); apply(doc, next.plan.ops);
    const installed = await history.install(next.plan, doc, undo, anchor, await receipt(next.plan.ops, 10)); if (installed.status !== "recorded") throw new Error(installed.status);
    const step = history.prepare(doc, undo, installed.key, false, 20, doc.text(TITLE)); if (step.status !== "ready") throw new Error(step.status);
    apply(doc, step.plan.ops); expect(await history.finish(doc, undo, step.plan, await receipt(step.plan.ops, 30))).toBe("ready");
    older.rebaseCaptured(doc, previousAliases, new Set(history.rebases(step.plan).map((item) => idKey(item.block))));
    expect(older.step(doc, undo, oldKey, false).status).toBe("ready");
    expect(doc.text(text)).toBe("目标正文"); expect(grid(doc, table)).toEqual([["目标"]]);
  });
});

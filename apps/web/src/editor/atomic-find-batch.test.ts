import { describe, expect, it } from "vitest";
import { Doc, encodeOps, ROOT, Tx, UndoManager } from "@jiange/collab";
import { TITLE } from "./model";
import { findDocumentMatches } from "./table-find";
import { tableRowsOf } from "./table-cells";
import { writeFindBatchTables } from "./find-batch";
import { atomicFindPlanIsCurrent, atomicFindPostState, prepareAtomicFindBatch } from "./atomic-find-batch";
import { atomicFindBatchOps } from "./atomic-find-commit";

function fixture() {
  const doc = new Doc(9);
  doc.apply({ t: "bcreate", id: TITLE, parent: ROOT, pos: "U", type: "title" });
  doc.insertText(TITLE, 0, "目标计划");
  const tx = new Tx(doc), text = tx.create("paragraph", TITLE, ROOT); tx.insert(text, 0, "目标与目标");
  const table = tx.create("table", text, ROOT, { tableData: JSON.stringify([["目标😀目标", "目标"], ["不变", "目标"]]) });
  return { doc, text, table };
}
const grid = (doc: Doc, table: { client: number; clock: number }) => tableRowsOf(doc.blockInfo(table).props);

describe("conditional title and body replacement preparation", () => {
  it("prepares title, paragraph and table replacements on a distinct replica without mutating the live document", () => {
    const { doc, text, table } = fixture(), before = doc.encodeState();
    const matches = findDocumentMatches(doc, "目标");
    const result = prepareAtomicFindBatch(doc, 19, matches, "完成", "目标计划");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(doc.encodeState()).toEqual(before); expect(result.plan.count).toBe(7);
    expect(result.plan.ops.every((op) => op.id.client === 19)).toBe(true);
    expect(Object.isFrozen(matches[0].block)).toBe(false);
    expect(Object.isFrozen(result.plan.ops[0].id)).toBe(true);
    const exposed = atomicFindPostState(result.plan)!; exposed[0] ^= 255;
    expect(atomicFindPostState(result.plan)![0]).not.toBe(exposed[0]);
    expect(atomicFindPlanIsCurrent(result.plan, doc)).toBe(true);
    const received = Doc.fromState(30, before);
    for (const op of result.plan.ops) expect(received.apply(op)).toBe(true);
    expect(received.text(TITLE)).toBe("完成计划"); expect(received.text(text)).toBe("完成与完成");
    expect(grid(received, table)).toEqual([["完成😀完成", "完成"], ["不变", "完成"]]);

    // The saved text inverse and table snapshot restore the mixed replacement.
    const undo = new UndoManager(); undo.record(result.plan.text, null, null); undo.undo(received);
    writeFindBatchTables(received, result.plan.tables.map((item) => ({ block: item.block, rows: item.before })));
    expect(received.text(TITLE)).toBe("目标计划"); expect(received.text(text)).toBe("目标与目标");
    expect(grid(received, table)[0][0]).toBe("目标😀目标");
  });

  it("invalidates a captured plan when the document changes or is replaced", () => {
    const { doc, text } = fixture(), result = prepareAtomicFindBatch(doc, 19, findDocumentMatches(doc, "目标"), "完成", "目标计划");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(atomicFindPlanIsCurrent(result.plan, Doc.fromState(9, doc.encodeState()))).toBe(false);
    new Tx(doc).insert(text, 0, "新");
    expect(atomicFindPlanIsCurrent(result.plan, doc)).toBe(false);
  });

  it("preserves body formatting when a mixed replacement is committed and undone", () => {
    const { doc, text } = fixture(); new Tx(doc).format(text, 0, 2, "bold", "true");
    const result = prepareAtomicFindBatch(doc, 19, findDocumentMatches(doc, "目标"), "完成", "目标计划");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(atomicFindBatchOps(encodeOps([...result.plan.ops]))).not.toBeNull();
    const received = Doc.fromState(30, doc.encodeState()); for (const op of result.plan.ops) received.apply(op);
    expect(received.richChars(text).slice(0, 2).every((char) => char.marks.bold === "true")).toBe(true);
    const undo = new UndoManager(); undo.record(result.plan.text, null, null); undo.undo(received);
    expect(received.text(text)).toBe("目标与目标");
    expect(received.richChars(text).slice(0, 2).every((char) => char.marks.bold === "true")).toBe(true);
  });

  it("includes editable column text in a title and table batch", () => {
    const { doc, table } = fixture(), tx = new Tx(doc), group = tx.create("columns", table, ROOT);
    const left = tx.create("paragraph", null, group), right = tx.create("paragraph", left, group);
    tx.insert(left, 0, "目标左栏"); tx.insert(right, 0, "目标右栏");
    const result = prepareAtomicFindBatch(doc, 19, findDocumentMatches(doc, "目标"), "完成", "目标计划");
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    const received = Doc.fromState(30, doc.encodeState()); for (const op of result.plan.ops) received.apply(op);
    expect(received.text(left)).toBe("完成左栏"); expect(received.text(right)).toBe("完成右栏");
    const undo = new UndoManager(); undo.record(result.plan.text, null, null); undo.undo(received);
    expect(received.text(left)).toBe("目标左栏"); expect(received.text(right)).toBe("目标右栏");
  });

  it("rejects stale text or table matches without changing any part of the document", () => {
    const { doc, text, table } = fixture(), matches = findDocumentMatches(doc, "目标");
    new Tx(doc).insert(text, 1, "远端");
    const before = doc.encodeState();
    expect(prepareAtomicFindBatch(doc, 19, matches, "完成", "目标计划").status).toBe("stale");
    expect(doc.encodeState()).toEqual(before); expect(grid(doc, table)[0][0]).toBe("目标😀目标");
  });

  it("refuses an unconfirmed directory title, the current author, and title-invalid replacements", () => {
    const { doc } = fixture(), matches = findDocumentMatches(doc, "目标"), before = doc.encodeState();
    expect(prepareAtomicFindBatch(doc, 9, matches, "完成", "目标计划").status).toBe("unavailable");
    expect(prepareAtomicFindBatch(doc, 19, matches, "完成", "目录改名").status).toBe("stale");
    expect(prepareAtomicFindBatch(doc, 19, matches, "换\n行", "目标计划").status).toBe("invalid_title");
    expect(prepareAtomicFindBatch(doc, 19, matches, "很".repeat(201), "目标计划").status).toBe("invalid_title");
    expect(prepareAtomicFindBatch(doc, 19, matches, "\ud800", "目标计划").status).toBe("invalid_text");
    expect(doc.encodeState()).toEqual(before);
  });

  it("refuses a match containing an unpaired surrogate before constructing an inverse", () => {
    const doc = new Doc(9); doc.apply({ t: "bcreate", id: TITLE, parent: ROOT, pos: "U", type: "title" }); doc.insertText(TITLE, 0, "\ud800标题");
    const before = doc.encodeState();
    expect(prepareAtomicFindBatch(doc, 19, findDocumentMatches(doc, "\ud800"), "新", doc.text(TITLE)).status).toBe("invalid_text");
    expect(doc.encodeState()).toEqual(before);
  });

  it("protects title formatting even when a concurrent insert shifted the original match", () => {
    const { doc } = fixture(), matches = findDocumentMatches(doc, "目标");
    const tx = new Tx(doc); tx.insert(TITLE, 0, "前"); tx.format(TITLE, 1, 3, "bold", "true");
    expect(prepareAtomicFindBatch(doc, 19, matches, "完成", doc.text(TITLE)).status).toBe("unsupported_title");
  });

  it("does not replace a selected member mention and recognizes unchanged batches", () => {
    const { doc, text } = fixture(); new Tx(doc).format(text, 0, 2, "mention", "5");
    const matches = findDocumentMatches(doc, "目标");
    expect(prepareAtomicFindBatch(doc, 19, matches, "完成", "目标计划").status).toBe("unavailable");
    expect(prepareAtomicFindBatch(doc, 19, matches.filter((match) => !match.mention), "目标", "目标计划").status).toBe("unchanged");
  });
});

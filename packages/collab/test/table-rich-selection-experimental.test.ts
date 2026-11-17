import { describe, expect, it } from "vitest";
import { DEFAULT_TABLE_LIMITS, ExperimentalTable, type TableOp } from "../src/table-experimental";
import { captureTableTextSelection, captureTableUTF16Selection, prepareTableTextMark, prepareTableTextMarkInverse, tableMarkPlanIsCurrent } from "../src/table-rich-selection-experimental";

function fixture() {
  const table = new ExperimentalTable(), row = { client: 1, clock: 1 }, col = { client: 1, clock: 2 }, a = { client: 1, clock: 3 }, b = { client: 1, clock: 4 }, c = { client: 1, clock: 5 };
  const ops: TableOp[] = [{ kind: "axis-insert", id: row, axis: "row", after: null }, { kind: "axis-insert", id: col, axis: "column", after: null }, { kind: "text-insert", id: a, row, column: col, after: null, char: "甲" }, { kind: "text-insert", id: b, row, column: col, after: a, char: "😀" }, { kind: "text-insert", id: c, row, column: col, after: b, char: "乙" }];
  ops.forEach((op) => table.apply(op));
  return { table, row, col, a, b, c };
}
const ids = (client: number, first: number, count: number) => Array.from({ length: count }, (_, i) => ({ client, clock: first + i }));

describe("experimental table text selection plans", () => {
  it("maps native UTF-16 selection offsets without splitting an emoji or using stale text", () => {
    const f = fixture(), selected = captureTableUTF16Selection(f.table, f.row, f.col, "甲😀乙", 1, 3)!;
    expect(selected.length).toBe(1);
    const result = prepareTableTextMark(f.table, selected, "color", "#3370FF", ids(3, 6, 1)); if (result.status !== "ready") throw new Error(result.status);
    expect(result.plan.ops[0].target).toEqual(f.b);
    expect(captureTableUTF16Selection(f.table, f.row, f.col, "甲😀乙", 2, 3)).toBeNull();
    expect(captureTableUTF16Selection(f.table, f.row, f.col, "甲😀乙", 1, 2)).toBeNull();
    expect(captureTableUTF16Selection(f.table, f.row, f.col, "甲😀丙", 1, 3)).toBeNull();
  });
  it("formats only selected original IDs when another peer inserts between them, then undoes and redoes", () => {
    const f = fixture(), selected = captureTableTextSelection(f.table, f.row, f.col, 0, 2)!;
    f.table.apply({ kind: "text-insert", id: { client: 2, clock: 6 }, row: f.row, column: f.col, after: f.a, char: "新" });
    const result = prepareTableTextMark(f.table, selected, "bold", "1", ids(3, 7, 2)); if (result.status !== "ready") throw new Error(result.status);
    expect(tableMarkPlanIsCurrent(f.table, result.plan)).toBe(true); expect(f.table.cellRich(f.row, f.col)?.every((char) => !char.marks.bold)).toBe(true);
    expect(Object.isFrozen(result.plan.ops)).toBe(true); expect(Object.isFrozen(result.plan.ops[0].target)).toBe(true);
    result.plan.ops.forEach((op) => f.table.apply(op)); expect(tableMarkPlanIsCurrent(f.table, result.plan)).toBe(false);
    expect(f.table.cellRich(f.row, f.col)?.map((char) => [char.text, char.marks.bold ?? ""])).toEqual([["甲", "1"], ["新", ""], ["😀", "1"], ["乙", ""]]);
    const undo = prepareTableTextMarkInverse(f.table, result.plan, ids(3, 9, 2)); if (undo.status !== "ready") throw new Error(undo.status);
    undo.plan.ops.forEach((op) => f.table.apply(op)); expect(f.table.cellRich(f.row, f.col)?.every((char) => !char.marks.bold)).toBe(true);
    const redo = prepareTableTextMarkInverse(f.table, undo.plan, ids(3, 11, 2)); if (redo.status !== "ready") throw new Error(redo.status);
    redo.plan.ops.forEach((op) => f.table.apply(op));
    expect(f.table.cellRich(f.row, f.col)?.map((char) => [char.text, char.marks.bold ?? ""])).toEqual([["甲", "1"], ["新", ""], ["😀", "1"], ["乙", ""]]);
  });
  it("rejects stale selection and preserves the table when a selected character or its mark changes", () => {
    const f = fixture(), selected = captureTableTextSelection(f.table, f.row, f.col, 0, 2)!;
    f.table.apply({ kind: "text-mark", id: { client: 2, clock: 6 }, row: f.row, column: f.col, target: f.a, key: "bold", value: "1" });
    const before = f.table.snapshot();
    expect(prepareTableTextMark(f.table, selected, "bold", "1", ids(3, 7, 2)).status).toBe("stale"); expect(f.table.snapshot()).toBe(before);
    const fresh = captureTableTextSelection(f.table, f.row, f.col, 0, 2)!;
    f.table.apply({ kind: "text-delete", id: { client: 2, clock: 7 }, row: f.row, column: f.col, target: f.b });
    expect(prepareTableTextMark(f.table, fresh, "italic", "1", ids(3, 8, 2)).status).toBe("stale");
    f.table.apply({ kind: "text-insert", id: { client: 2, clock: 8 }, row: f.row, column: f.col, after: f.a, char: "😀" });
    expect(f.table.cellText(f.row, f.col)).toBe("甲😀乙");
    expect(prepareTableTextMark(f.table, fresh, "italic", "1", ids(3, 9, 2)).status).toBe("stale");
  });
  it("skips already-matching characters and restores only changed registers", () => {
    const f = fixture();
    f.table.apply({ kind: "text-mark", id: { client: 2, clock: 6 }, row: f.row, column: f.col, target: f.a, key: "bold", value: "1" });
    const selected = captureTableTextSelection(f.table, f.row, f.col, 0, 2)!;
    const result = prepareTableTextMark(f.table, selected, "bold", "1", ids(3, 7, 2)); if (result.status !== "ready") throw new Error(result.status);
    expect(result.plan.ops).toHaveLength(1); expect(result.plan.ops[0].target).toEqual(f.b);
    result.plan.ops.forEach((op) => f.table.apply(op));
    const matching = captureTableTextSelection(f.table, f.row, f.col, 0, 2)!, saved = f.table.snapshot();
    expect(prepareTableTextMark(f.table, matching, "bold", "1", ids(4, 9, 2)).status).toBe("unchanged"); expect(f.table.snapshot()).toBe(saved);
    const undo = prepareTableTextMarkInverse(f.table, result.plan, ids(3, 9, 1)); if (undo.status !== "ready") throw new Error(undo.status);
    undo.plan.ops.forEach((op) => f.table.apply(op));
    expect(f.table.cellMark(f.row, f.col, f.a, "bold")).toEqual({ value: "1", version: { client: 2, clock: 6 } });
    expect(f.table.cellMark(f.row, f.col, f.b, "bold")?.value).toBeNull();
  });
  it("refuses an inverse if a peer rewrites the same mark, even with the same visible value", () => {
    const f = fixture(), selected = captureTableTextSelection(f.table, f.row, f.col, 0, 1)!;
    const result = prepareTableTextMark(f.table, selected, "bold", "1", ids(3, 6, 1)); if (result.status !== "ready") throw new Error(result.status);
    result.plan.ops.forEach((op) => f.table.apply(op));
    f.table.apply({ kind: "text-mark", id: { client: 4, clock: 7 }, row: f.row, column: f.col, target: f.a, key: "bold", value: "1" });
    expect(prepareTableTextMarkInverse(f.table, result.plan, ids(3, 8, 1)).status).toBe("conflict");
    expect(f.table.cellMark(f.row, f.col, f.a, "bold")?.version).toEqual({ client: 4, clock: 7 });
  });
  it("allows an inverse after unrelated changes but rejects a changed document before send", () => {
    const f = fixture(), selected = captureTableTextSelection(f.table, f.row, f.col, 0, 1)!;
    const result = prepareTableTextMark(f.table, selected, "bold", "1", ids(3, 6, 1)); if (result.status !== "ready") throw new Error(result.status);
    f.table.apply({ kind: "text-mark", id: { client: 4, clock: 7 }, row: f.row, column: f.col, target: f.a, key: "color", value: "#3370FF" });
    expect(tableMarkPlanIsCurrent(f.table, result.plan)).toBe(false);
    // Re-plan after a different key changed: the original bold selection is still valid.
    const fresh = prepareTableTextMark(f.table, selected, "bold", "1", ids(3, 8, 1)); if (fresh.status !== "ready") throw new Error(fresh.status);
    fresh.plan.ops.forEach((op) => f.table.apply(op));
    f.table.apply({ kind: "text-insert", id: { client: 4, clock: 9 }, row: f.row, column: f.col, after: f.c, char: "后" });
    const undo = prepareTableTextMarkInverse(f.table, fresh.plan, ids(3, 10, 1)); if (undo.status !== "ready") throw new Error(undo.status);
    undo.plan.ops.forEach((op) => f.table.apply(op)); expect(f.table.cellRich(f.row, f.col)?.[0].marks).toEqual({ color: "#3370FF" });
  });
  it("rejects invalid IDs, unavailable rows and resource-exhausted plans without mutations", () => {
    const f = fixture(), selected = captureTableTextSelection(f.table, f.row, f.col, 0, 2)!;
    expect(captureTableTextSelection(f.table, f.row, f.col, 0, 4)).toBeNull();
    expect(prepareTableTextMark(f.table, selected, "bold", "1", [ids(3, 6, 1)[0], ids(3, 6, 1)[0]]).status).toBe("invalid");
    expect(prepareTableTextMark(f.table, selected, "bold", "1", ids(3, 4, 2)).status).toBe("invalid");
    expect(prepareTableTextMark(f.table, selected, "color", "red", ids(3, 6, 2)).status).toBe("invalid");
    f.table.apply({ kind: "axis-delete", id: { client: 2, clock: 6 }, axis: "row", target: f.row });
    expect(prepareTableTextMark(f.table, selected, "bold", "1", ids(3, 7, 2)).status).toBe("stale");
    const limited = new ExperimentalTable({ ...DEFAULT_TABLE_LIMITS, maxOperations: 5 });
    const source = fixture(); JSON.parse(source.table.snapshot()).ops.forEach((op: TableOp) => limited.apply(op));
    const selection = captureTableTextSelection(limited, source.row, source.col, 0, 1)!, before = limited.snapshot();
    expect(prepareTableTextMark(limited, selection, "bold", "1", ids(5, 8, 1)).status).toBe("limit"); expect(limited.snapshot()).toBe(before);
  });
  it("does not partially format a selection when a later operation exceeds the limit", () => {
    const source = fixture(), table = new ExperimentalTable({ ...DEFAULT_TABLE_LIMITS, maxOperations: 6 });
    JSON.parse(source.table.snapshot()).ops.forEach((op: TableOp) => table.apply(op));
    const selected = captureTableTextSelection(table, source.row, source.col, 0, 2)!, before = table.snapshot();
    expect(prepareTableTextMark(table, selected, "bold", "1", ids(4, 6, 2)).status).toBe("limit");
    expect(table.snapshot()).toBe(before); expect(table.cellRich(source.row, source.col)?.every((char) => !char.marks.bold)).toBe(true);
  });
});

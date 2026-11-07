import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_TABLE_LIMITS, ExperimentalTable, type TableLimits, type TableOp } from "../src/tableExperimental";
import type { OpId } from "../src/id";

const id = (client: number, clock: number): OpId => ({ client, clock });
const row = id(1, 1), col = id(1, 2);
const axis = (opId: OpId, kind: "row" | "column", after: OpId | null = null): TableOp => ({ kind: "axis-insert", id: opId, axis: kind, after });
const text = (opId: OpId, char: string, after: OpId | null = null): TableOp => ({ kind: "text-insert", id: opId, row, column: col, after, char });
const limits = (changes: Partial<TableLimits>): TableLimits => ({ ...DEFAULT_TABLE_LIMITS, ...changes });

describe("experimental table admission budgets", () => {
  it("matches shared cross-language resource and cycle vectors", () => {
    const fixture = JSON.parse(readFileSync(new URL("../testdata/table-resource-vectors.json", import.meta.url), "utf8")) as {
      version: number;
      cases: { name: string; limits: Partial<TableLimits>; operations: TableOp[]; results: string[]; grid: string[][]; pending: number; rejected: { id: OpId; reason: string }[] }[];
    };
    expect(fixture.version).toBe(1);
    for (const scenario of fixture.cases) {
      const cfg = limits(scenario.limits), table = new ExperimentalTable(cfg);
      const results = scenario.operations.map((op) => {
        try { return table.apply(op) ? "accepted" : "duplicate"; }
        catch (error) { return (error as Error).message; }
      });
      expect(results, scenario.name).toEqual(scenario.results);
      expect(table.view(), scenario.name).toEqual(scenario.grid);
      expect(table.pendingCount, scenario.name).toBe(scenario.pending);
      expect(table.rejected, scenario.name).toEqual(scenario.rejected);
      const restored = ExperimentalTable.fromSnapshot(table.snapshot(), cfg);
      expect(restored.view(), scenario.name).toEqual(scenario.grid);
      expect(restored.pendingCount, scenario.name).toBe(scenario.pending);
      expect(restored.rejected, scenario.name).toEqual(scenario.rejected);
    }
  });
  it("reserves even pending axes and preserves the state and ID after an over-limit attempt", () => {
    const t = new ExperimentalTable(limits({ maxRows: 1 }));
    const first = axis(row, "row", id(5, 1));
    expect(t.apply(first)).toBe(true);
    const before = t.snapshot();
    expect(() => t.apply(axis(id(1, 3), "row"))).toThrow("table resource limit: maxRows");
    expect(t.snapshot()).toBe(before);
    expect(t.apply(first)).toBe(false);
    // The rejected attempt did not reserve its identity.
    expect(t.apply(axis(id(1, 3), "column"))).toBe(true);
  });

  it("limits grid area, columns, ledger and decoded payload independently", () => {
    const grid = new ExperimentalTable(limits({ maxGridCells: 1 }));
    grid.apply(axis(row, "row")); grid.apply(axis(col, "column"));
    expect(() => grid.apply(axis(id(2, 1), "column"))).toThrow("table resource limit: maxGridCells");
    const columns = new ExperimentalTable(limits({ maxColumns: 1 }));
    columns.apply(axis(col, "column"));
    expect(() => columns.apply(axis(id(2, 1), "column"))).toThrow("table resource limit: maxColumns");
    const ops = new ExperimentalTable(limits({ maxOperations: 1 }));
    ops.apply(axis(row, "row"));
    expect(() => ops.apply(axis(col, "column"))).toThrow("table resource limit: maxOperations");
    const bytes = new ExperimentalTable(limits({ maxOperationBytes: 191 }));
    expect(() => bytes.apply(axis(row, "row"))).toThrow("table resource limit: maxOperationBytes");
    expect(bytes.snapshot()).toBe('{"version":1,"ops":[]}');
  });

  it("bounds characters per cell even before their dependencies arrive", () => {
    const t = new ExperimentalTable(limits({ maxCharactersPerCell: 1 }));
    t.apply(text(id(2, 1), "🙂"));
    expect(() => t.apply(text(id(2, 2), "中"))).toThrow("table resource limit: maxCharactersPerCell");
    t.apply(axis(row, "row")); t.apply(axis(col, "column"));
    expect(t.view()).toEqual([["🙂"]]);
  });

  it("bounds pending, admits retries and wakes only affected dependency chains", () => {
    const t = new ExperimentalTable(limits({ maxPending: 1 }));
    const pending = axis(id(2, 2), "row", id(2, 1));
    t.apply(pending);
    expect(t.apply(pending)).toBe(false);
    expect(() => t.apply(axis(id(3, 2), "column", id(3, 1)))).toThrow("table resource limit: maxPending");
    t.apply(axis(id(2, 1), "row"));
    expect(t.pendingCount).toBe(0);
    expect(t.axisIds("row")).toEqual([id(2, 1), id(2, 2)]);
    expect(t.apply(axis(id(3, 2), "column", id(3, 1)))).toBe(true);
  });

  it("does not partially accept a cycle-closing op when the pending budget is full", () => {
    const t = new ExperimentalTable(limits({ maxPending: 1 }));
    t.apply(axis(id(2, 1), "row", id(2, 2)));
    const saved = t.snapshot();
    expect(() => t.apply(axis(id(2, 2), "row", id(2, 1)))).toThrow("table resource limit: maxPending");
    expect(t.snapshot()).toBe(saved);
    expect(t.pendingCount).toBe(1);
    expect(t.rejected).toEqual([]);
  });

  it("rejects only live dependency cycles and propagates rejected dependencies", () => {
    const t = new ExperimentalTable();
    const a = id(2, 1), b = id(2, 2), child = id(2, 3);
    t.apply(axis(child, "row", a)); t.apply(axis(a, "row", b)); t.apply(axis(b, "row", a));
    expect(t.pendingCount).toBe(0);
    expect(t.rejected).toEqual([
      { id: a, reason: "cyclic dependency" }, { id: b, reason: "cyclic dependency" },
      { id: child, reason: "axis dependency has wrong type" },
    ]);
    expect(ExperimentalTable.fromSnapshot(t.snapshot()).rejected).toEqual(t.rejected);
  });

  it("detects cell text cycles after their axes arrive without rejecting unrelated waiters", () => {
    const a = id(2, 1), b = id(2, 2), unrelated = id(3, 1);
    const ops = [text(a, "A", b), text(b, "B", a), axis(unrelated, "row", id(4, 1)), axis(row, "row"), axis(col, "column")];
    for (const order of [ops, [...ops].reverse()]) {
      const t = new ExperimentalTable();
      for (const op of order) t.apply(op);
      expect(t.pendingCount).toBe(1);
      expect(t.rejected).toEqual([{ id: a, reason: "cyclic dependency" }, { id: b, reason: "cyclic dependency" }]);
      expect(t.view()).toEqual([[""]]);
    }
  });

  it("rechecks a newly known dependency type before labeling a cycle", () => {
    const a = id(1, 38), b = id(1, 44);
    const textOp: TableOp = { kind: "text-insert", id: a, row: b, column: id(1, 8), after: id(1, 21), char: "x" };
    const rowOp = axis(b, "row", a);
    for (const ops of [[textOp, rowOp], [rowOp, textOp]]) {
      const t = new ExperimentalTable(); ops.forEach((op) => t.apply(op));
      expect(t.pendingCount).toBe(0);
      expect(t.rejected).toEqual([{ id: a, reason: "cell axis has wrong type" }, { id: b, reason: "axis dependency has wrong type" }]);
      expect(ExperimentalTable.fromSnapshot(t.snapshot()).rejected).toEqual(t.rejected);
    }
  });

  it("enforces snapshot bytes while allowing temporary replay pending above the live limit", () => {
    const cfg = limits({ maxPending: 1 });
    const t = new ExperimentalTable(cfg);
    t.apply(axis(id(9, 100), "row")); t.apply(axis(id(9, 200), "column"));
    for (const clock of [1, 2]) t.apply({ kind: "text-insert", id: id(8, clock), row: id(9, 100), column: id(9, 200), after: null, char: "x" });
    const saved = t.snapshot();
    expect(ExperimentalTable.fromSnapshot(saved, cfg).view()).toEqual([["xx"]]);
    expect(() => ExperimentalTable.fromSnapshot(saved, limits({ maxSnapshotBytes: 30 }))).toThrow("table resource limit: maxSnapshotBytes");
    const small = new ExperimentalTable(limits({ maxSnapshotBytes: 214 }));
    expect(() => small.apply(axis(row, "row"))).toThrow("table resource limit: maxSnapshotBytes");
    expect(small.snapshot()).toBe('{"version":1,"ops":[]}');
  });

  it("reserves enough snapshot space for escaped scalars and maximum safe IDs", () => {
    const n = Number.MAX_SAFE_INTEGER;
    const t = new ExperimentalTable(limits({ maxSnapshotBytes: 408 }));
    t.apply({ kind: "text-insert", id: id(n, n), row: id(n - 1, n), column: id(n - 2, n), after: id(n - 3, n), char: "\u0000" });
    expect(new TextEncoder().encode(t.snapshot()).length).toBeLessThanOrEqual(408);
    expect(ExperimentalTable.fromSnapshot(t.snapshot(), limits({ maxSnapshotBytes: 408 })).pendingCount).toBe(1);
  });

  it("rejects invalid or incomplete budget configurations", () => {
    expect(() => new ExperimentalTable(limits({ maxRows: 0 }))).toThrow(/positive safe integers/);
    expect(() => new ExperimentalTable(limits({ maxSnapshotBytes: 21 }))).toThrow("table resource limit: maxSnapshotBytes");
    expect(() => new ExperimentalTable({ ...limits({}), unexpected: 1 } as TableLimits)).toThrow(/unsupported/);
  });

  it("rejects oversized arrays before materializing malformed snapshot operations", () => {
    const cfg = limits({ maxOperations: 2 });
    expect(() => ExperimentalTable.fromSnapshot('{"version":1,"ops":[0,0,0]}', cfg)).toThrow("table resource limit: maxOperations");
    expect(() => ExperimentalTable.fromSnapshot('{"version":1,"ops":[[0,0,0]]}', cfg)).toThrow("table resource limit: maxOperations");
  });
});

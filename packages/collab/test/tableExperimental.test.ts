import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ExperimentalTable, type TableOp } from "../src/tableExperimental";
import { parseTableSnapshotJson } from "../src/tableStrictJson";
import type { OpId } from "../src/id";

const id = (client: number, clock: number): OpId => ({ client, clock });
const row = id(1, 1), column = id(1, 2);
const rowInsert: TableOp = { kind: "axis-insert", id: row, axis: "row", after: null };
const colInsert: TableOp = { kind: "axis-insert", id: column, axis: "column", after: null };
const insert = (opId: OpId, value: string, after: OpId | null = null, r = row, c = column): TableOp =>
  ({ kind: "text-insert", id: opId, row: r, column: c, after, char: value });

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items]; let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1); [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("experimental table CRDT", () => {
  it("rejects ambiguous or lossy JSON snapshots with shared cross-language cases", () => {
    const fixture = JSON.parse(readFileSync(new URL("../testdata/table-experimental-invalid-snapshots.json", import.meta.url), "utf8")) as {
      version: number; cases: { name: string; snapshot: string }[];
    };
    expect(fixture.version).toBe(1);
    for (const scenario of fixture.cases) expect(() => ExperimentalTable.fromSnapshot(scenario.snapshot), scenario.name).toThrow();
    const scalar = '{"version":1,"ops":[{"kind":"text-insert","id":{"client":1.0,"clock":1e0},"row":{"client":1,"clock":2},"column":{"client":1,"clock":3},"after":null,"char":"\\ud83d\\ude42"}]}';
    expect(ExperimentalTable.fromSnapshot(scalar).pendingCount).toBe(1);
    expect(() => parseTableSnapshotJson("[".repeat(128) + "0" + "]".repeat(128))).not.toThrow();
    expect(() => parseTableSnapshotJson("[".repeat(129) + "0" + "]".repeat(129))).toThrow();
  });
  it("matches the shared cross-language vectors under reordered delivery", () => {
    const fixture = JSON.parse(readFileSync(new URL("../testdata/table-experimental.json", import.meta.url), "utf8")) as {
      version: number;
      cases: { name: string; ops: TableOp[]; expected: { grid: string[][]; pending: number; rejected: { id: OpId; reason: string }[]; hiddenCells?: { row: OpId; column: OpId; text: string }[] } }[];
    };
    expect(fixture.version).toBe(1);
    for (const scenario of fixture.cases) {
      for (let seed = 1; seed <= 30; seed++) {
        const table = new ExperimentalTable();
        shuffled(scenario.ops, seed).forEach((op) => table.apply(op));
        expect(table.view(), scenario.name).toEqual(scenario.expected.grid);
        expect(table.pendingCount, scenario.name).toBe(scenario.expected.pending);
        expect(table.rejected, scenario.name).toEqual(scenario.expected.rejected);
        for (const cell of scenario.expected.hiddenCells ?? []) expect(table.cellText(cell.row, cell.column, true)).toBe(cell.text);
        const restored = ExperimentalTable.fromSnapshot(table.snapshot());
        expect(restored.view(), scenario.name).toEqual(table.view());
        expect(restored.pendingCount, scenario.name).toBe(table.pendingCount);
        expect(restored.rejected, scenario.name).toEqual(table.rejected);
      }
    }
  });
  it("converges for concurrent edits to the same and different cells, in any arrival order", () => {
    const row2 = id(2, 1), col2 = id(2, 2), a = id(1, 3), b = id(1, 4), x = id(2, 3), y = id(2, 4);
    const ops: TableOp[] = [
      rowInsert, colInsert,
      { kind: "axis-insert", id: row2, axis: "row", after: row },
      { kind: "axis-insert", id: col2, axis: "column", after: column },
      insert(a, "甲"), insert(b, "乙", a), insert(x, "🙂"), insert(y, "字", x),
      insert(id(3, 1), "右", null, row, col2), insert(id(3, 2), "下", null, row2, column),
    ];
    const reference = new ExperimentalTable(); ops.forEach((op) => reference.apply(op));
    expect(reference.view()).toEqual([["🙂字甲乙", "右"], ["下", ""]]);
    for (let seed = 1; seed <= 200; seed++) {
      const replica = new ExperimentalTable();
      for (const op of shuffled(ops, seed)) { expect(replica.apply(op)).toBe(true); expect(replica.apply(op)).toBe(false); }
      expect(replica.pendingCount).toBe(0);
      expect(replica.rejected).toEqual([]);
      expect(replica.view()).toEqual(reference.view());
      expect(replica.snapshot()).toBe(reference.snapshot());
    }
  });

  it("keeps deleted row, column and characters as anchors for delayed operations", () => {
    const row2 = id(2, 1), col2 = id(2, 2), a = id(1, 3), z = id(2, 3);
    const ops: TableOp[] = [rowInsert, colInsert, insert(a, "A"),
      { kind: "text-delete", id: id(3, 1), row, column, target: a }, insert(z, "Z", a),
      { kind: "axis-delete", id: id(3, 2), axis: "row", target: row },
      { kind: "axis-insert", id: row2, axis: "row", after: row },
      { kind: "axis-delete", id: id(3, 3), axis: "column", target: column },
      { kind: "axis-insert", id: col2, axis: "column", after: column },
      insert(id(4, 1), "迟", z), insert(id(4, 2), "新", null, row2, col2)];
    for (let seed = 1; seed <= 80; seed++) {
      const table = new ExperimentalTable(); shuffled(ops, seed).forEach((op) => table.apply(op));
      expect(table.pendingCount).toBe(0);
      expect(table.axisIds("row", true)).toEqual([row, row2]);
      expect(table.cellText(row, column)).toBeNull();
      expect(table.cellText(row, column, true)).toBe("Z迟");
      expect(table.view()).toEqual([["新"]]);
    }
  });

  it("snapshots retain pending operations and immutable copies, not just the visible grid", () => {
    const table = new ExperimentalTable(), child = id(2, 2), parent = id(2, 1);
    const input = insert(child, "B", parent);
    table.apply(input);
    expect(table.pendingCount).toBe(1);
    input.id.clock = 999;
    const saved = table.snapshot(), restored = ExperimentalTable.fromSnapshot(saved);
    expect(restored.pendingCount).toBe(1);
    restored.apply(insert(parent, "A")); restored.apply(colInsert); restored.apply(rowInsert);
    expect(restored.view()).toEqual([["AB"]]);
    expect(restored.pendingCount).toBe(0);
    expect(table.snapshot()).toBe(saved);
    expect(() => ExperimentalTable.fromSnapshot('{"version":2,"ops":[]}')).toThrow();
  });

  it("detects identity conflicts even for buffered or rejected operations", () => {
    const table = new ExperimentalTable(), child = id(2, 2);
    table.apply(insert(child, "A", id(2, 1)));
    expect(() => table.apply(insert(child, "B", id(2, 1)))).toThrow(/identity conflict/);
    table.apply(rowInsert); table.apply(colInsert);
    // The pending insertion's parent becomes known to be a column, not a char.
    table.apply({ kind: "axis-insert", id: id(2, 1), axis: "column", after: null });
    expect(table.rejected).toEqual([{ id: child, reason: "character dependency belongs to another cell" }]);
    expect(ExperimentalTable.fromSnapshot(table.snapshot()).rejected).toEqual(table.rejected);
    expect(() => table.apply({ kind: "axis-delete", id: child, axis: "row", target: row })).toThrow(/identity conflict/);
  });

  it("rejects unsafe IDs and malformed characters without reserving an operation ID", () => {
    const table = new ExperimentalTable();
    expect(() => table.apply(insert(id(2, 1), ""))).toThrow(/Unicode scalar/);
    expect(() => table.apply(insert(id(2, 1), "ab"))).toThrow(/Unicode scalar/);
    expect(() => table.apply(insert(id(2, 1), "\ud800"))).toThrow(/surrogate/);
    expect(() => table.apply({ ...insert(id(2, 1), "x"), unexpected: true } as unknown as TableOp)).toThrow(/unsupported/);
    expect(() => table.apply({ kind: "axis-insert", id: { ...id(1, 1), extra: 1 }, axis: "row", after: null } as TableOp)).toThrow(/unsupported/);
    expect(() => table.apply({ kind: "axis-insert", id: id(0, 1), axis: "row", after: null })).toThrow(/positive safe integers/);
    expect(() => table.apply({ kind: "axis-insert", id: id(1, Number.MAX_SAFE_INTEGER + 1), axis: "row", after: null })).toThrow(/positive safe integers/);
    expect(table.apply(insert(id(2, 1), "🙂"))).toBe(true);
  });

  it("does not allow a character from another cell to be used as an anchor", () => {
    const table = new ExperimentalTable(), second = id(1, 3), a = id(2, 1);
    [rowInsert, colInsert, { kind: "axis-insert", id: second, axis: "column", after: column } as TableOp, insert(a, "A")].forEach((op) => table.apply(op));
    table.apply(insert(id(2, 2), "X", a, row, second));
    expect(table.view()).toEqual([["A", ""]]);
    expect(table.rejected[0].reason).toMatch(/another cell/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_TABLE_LIMITS, ExperimentalTable, type TableOp, type TableRichChar } from "../src/table-experimental";
import type { OpId } from "../src/id";

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items]; let state = seed >>> 0;
  for (let i = result.length - 1; i > 0; i--) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; const j = state % (i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}

describe("experimental table character marks", () => {
  it("rejects the shared malformed and unsafe snapshots", () => {
    const fixture = JSON.parse(readFileSync(new URL("../testdata/table-experimental-rich-invalid.json", import.meta.url), "utf8")) as { version: number; cases: { name: string; snapshot: string }[] };
    expect(fixture.version).toBe(1);
    for (const item of fixture.cases) expect(() => ExperimentalTable.fromSnapshot(item.snapshot), item.name).toThrow();
  });
  it("reads a Go-produced snapshot and keeps the TypeScript snapshot fixture current", () => {
    const fixtures = JSON.parse(readFileSync(new URL("../testdata/table-experimental-rich.json", import.meta.url), "utf8")) as { cases: { ops: TableOp[]; expected: { row: OpId; column: OpId; rich: TableRichChar[] } }[] };
    const scenario = fixtures.cases[0];
    const go = readFileSync(new URL("../testdata/table-experimental-rich-go-snapshot.json", import.meta.url), "utf8");
    expect(ExperimentalTable.fromSnapshot(go).cellRich(scenario.expected.row, scenario.expected.column)).toEqual(scenario.expected.rich);
    const table = new ExperimentalTable(); scenario.ops.forEach((op) => table.apply(op));
    const expected = readFileSync(new URL("../testdata/table-experimental-rich-ts-snapshot.json", import.meta.url), "utf8");
    expect(JSON.parse(table.snapshot())).toEqual(JSON.parse(expected));
  });
  it("converges with the shared Go vectors under reordered operations and snapshot reload", () => {
    const fixture = JSON.parse(readFileSync(new URL("../testdata/table-experimental-rich.json", import.meta.url), "utf8")) as { version: number; cases: { name: string; ops: TableOp[]; expected: { row: OpId; column: OpId; grid: string[][]; rich: TableRichChar[]; pending: number; rejected: { id: OpId; reason: string }[] } }[] };
    expect(fixture.version).toBe(1);
    for (const scenario of fixture.cases) for (let seed = 1; seed <= 80; seed++) {
      let table = new ExperimentalTable();
      for (const [index, op] of shuffle(scenario.ops, seed).entries()) {
        expect(table.apply(op), scenario.name).toBe(true); expect(table.apply(op), scenario.name).toBe(false);
        if (index === Math.floor(scenario.ops.length / 2)) table = ExperimentalTable.fromSnapshot(table.snapshot());
      }
      expect(table.view(), scenario.name).toEqual(scenario.expected.grid);
      expect(table.cellRich(scenario.expected.row, scenario.expected.column), scenario.name).toEqual(scenario.expected.rich);
      expect(JSON.stringify(table.cellRich(scenario.expected.row, scenario.expected.column)), scenario.name).toBe(JSON.stringify(scenario.expected.rich));
      expect(table.pendingCount, scenario.name).toBe(scenario.expected.pending);
      expect(table.rejected, scenario.name).toEqual(scenario.expected.rejected);
      expect(JSON.parse(table.snapshot()).version).toBe(2);
      expect(ExperimentalTable.fromSnapshot(table.snapshot()).cellRich(scenario.expected.row, scenario.expected.column)).toEqual(scenario.expected.rich);
    }
  });
  it("does not expose mutable internal IDs or mark registers", () => {
    const t = new ExperimentalTable(), row = { client: 1, clock: 1 }, column = { client: 1, clock: 2 }, char = { client: 1, clock: 3 };
    t.apply({ kind: "axis-insert", id: row, axis: "row", after: null }); t.apply({ kind: "axis-insert", id: column, axis: "column", after: null });
    t.apply({ kind: "text-insert", id: char, row, column, after: null, char: "字" });
    const mark: TableOp = { kind: "text-mark", id: { client: 2, clock: 1 }, row, column, target: char, key: "bold", value: "1" };
    t.apply(mark); mark.target.clock = 99;
    const rich = t.cellRich(row, column)!; rich[0].id.clock = 99; rich[0].marks.bold = "changed";
    expect(t.cellRich(row, column)).toEqual([{ id: { client: 1, clock: 3 }, text: "字", marks: { bold: "1" } }]);
  });
  it("validates values, rejects downgrade and keeps tombstoned content hidden", () => {
    const t = new ExperimentalTable(), row = { client: 1, clock: 1 }, column = { client: 1, clock: 2 }, char = { client: 1, clock: 3 };
    t.apply({ kind: "axis-insert", id: row, axis: "row", after: null }); t.apply({ kind: "axis-insert", id: column, axis: "column", after: null }); t.apply({ kind: "text-insert", id: char, row, column, after: null, char: "字" });
    for (const [key, value] of [["bold", "true"], ["color", "#ff0000"], ["color", "url(evil)"], ["link", "javascript:alert(1)"]] as const) {
      expect(() => t.apply({ kind: "text-mark", id: { client: 3, clock: 1 }, row, column, target: char, key, value } as TableOp)).toThrow();
    }
    t.apply({ kind: "text-mark", id: { client: 3, clock: 1 }, row, column, target: char, key: "bold", value: "1" });
    const version1 = JSON.parse(t.snapshot()); version1.version = 1;
    expect(() => ExperimentalTable.fromSnapshot(JSON.stringify(version1))).toThrow(/version 2/);
    t.apply({ kind: "axis-delete", id: { client: 3, clock: 2 }, axis: "row", target: row });
    expect(t.cellRich(row, column)).toBeNull(); expect(t.cellRich(row, column, true)?.[0].marks.bold).toBe("1");
    t.apply({ kind: "text-delete", id: { client: 3, clock: 3 }, row, column, target: char });
    expect(t.cellRich(row, column, true)).toEqual([]);
  });
  it("enforces mark resource limits atomically without reserving a rejected identity", () => {
    const t = new ExperimentalTable({ ...DEFAULT_TABLE_LIMITS, maxOperationBytes: 390 }), row = { client: 1, clock: 1 }, column = { client: 1, clock: 2 }, char = { client: 1, clock: 3 };
    t.apply({ kind: "axis-insert", id: row, axis: "row", after: null }); t.apply({ kind: "axis-insert", id: column, axis: "column", after: null }); t.apply({ kind: "text-insert", id: char, row, column, after: null, char: "A" });
    const id = { client: 2, clock: 1 }, before = t.snapshot();
    expect(() => t.apply({ kind: "text-mark", id, row, column, target: char, key: "color", value: "#3370FF" })).toThrow(/maxOperationBytes/);
    expect(t.snapshot()).toBe(before);
    expect(t.apply({ kind: "text-mark", id, row, column, target: char, key: "bold", value: "1" })).toBe(true);
    expect(t.cellRich(row, column)?.[0].marks.bold).toBe("1");
  });
  it("bounds pending marks and wakes them after the missing character arrives", () => {
    const t = new ExperimentalTable({ ...DEFAULT_TABLE_LIMITS, maxPending: 1 }), row = { client: 1, clock: 1 }, column = { client: 1, clock: 2 }, char = { client: 1, clock: 3 };
    t.apply({ kind: "text-mark", id: { client: 2, clock: 1 }, row, column, target: char, key: "bold", value: "1" });
    expect(() => t.apply({ kind: "text-mark", id: { client: 2, clock: 2 }, row, column, target: char, key: "italic", value: "1" })).toThrow(/maxPending/);
    t.apply({ kind: "axis-insert", id: row, axis: "row", after: null }); t.apply({ kind: "axis-insert", id: column, axis: "column", after: null });
    t.apply({ kind: "text-insert", id: char, row, column, after: null, char: "A" });
    expect(t.pendingCount).toBe(0);
    expect(t.apply({ kind: "text-mark", id: { client: 2, clock: 2 }, row, column, target: char, key: "italic", value: "1" })).toBe(true);
    expect(t.cellRich(row, column)?.[0].marks).toEqual({ bold: "1", italic: "1" });
  });
});

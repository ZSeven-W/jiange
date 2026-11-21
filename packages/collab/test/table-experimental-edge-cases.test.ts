import { describe, expect, it } from "vitest";
import type { OpId } from "../src/id.js";
import { DEFAULT_TABLE_LIMITS, ExperimentalTable, type TableOp } from "../src/table-experimental.js";
import {
  captureTableTextSelection,
  captureTableUTF16Selection,
  prepareTableTextMark,
  prepareTableTextMarkInverse,
  tableMarkPlanFrames,
  tableMarkPlanIsCurrent,
} from "../src/table-rich-selection-experimental.js";
import { parseTableSnapshotJson } from "../src/table-strict-json.js";

const id = (client: number, clock: number): OpId => ({ client, clock });

describe("table-strict-json edge cases", () => {
  it("parses empty objects and rejects non-strings, malformed strings, bad delimiters, excess object depth, invalid values, and trailing text", () => {
    expect(parseTableSnapshotJson("{}")).toEqual({});

    expect(() => parseTableSnapshotJson(null as unknown as string)).toThrow(TypeError);
    // Object key not starting with quote
    expect(() => parseTableSnapshotJson("{1:2}")).toThrow(SyntaxError);
    // Unterminated string
    expect(() => parseTableSnapshotJson('"abc')).toThrow(SyntaxError);
    // Invalid escape sequence inside closed quotes
    expect(() => parseTableSnapshotJson('"\\x"')).toThrow(SyntaxError);
    // Object nesting depth >= 128
    expect(() => parseTableSnapshotJson('{"a":'.repeat(129) + "1" + "}".repeat(129))).toThrow(SyntaxError);
    // Missing colon in object
    expect(() => parseTableSnapshotJson('{"a" 1}')).toThrow(SyntaxError);
    // Missing comma in object
    expect(() => parseTableSnapshotJson('{"a":1 "b":2}')).toThrow(SyntaxError);
    // Missing comma in array
    expect(() => parseTableSnapshotJson("[1 2]")).toThrow(SyntaxError);
    // Unrecognized value token
    expect(() => parseTableSnapshotJson("undefined")).toThrow(SyntaxError);
    // Trailing non-whitespace characters
    expect(() => parseTableSnapshotJson("{} trailing")).toThrow(SyntaxError);
  });
});

describe("table-experimental edge cases", () => {
  it("validates operation shapes, IDs, axes, self-references, cellMark edge cases, and fromSnapshot limits", () => {
    const t = new ExperimentalTable();
    const r = id(1, 1);
    const c = id(1, 2);
    const ch = id(1, 3);

    // Invalid operation object & invalid IDs
    expect(() => t.apply(null as unknown as TableOp)).toThrow("invalid table operation");
    expect(() => t.apply({ kind: "axis-insert", id: null as unknown as OpId, axis: "row", after: null })).toThrow("invalid table operation ID");
    expect(() => t.apply({ kind: "axis-insert", id: [] as unknown as OpId, axis: "row", after: null })).toThrow("invalid table operation ID");

    // Invalid axis & self-referencing axis ops
    expect(() => t.apply({ kind: "axis-insert", id: r, axis: "cell" as "row", after: null })).toThrow("invalid table axis");
    expect(() => t.apply({ kind: "axis-insert", id: r, axis: "row", after: r })).toThrow("axis cannot follow itself");
    expect(() => t.apply({ kind: "axis-delete", id: r, axis: "cell" as "row", target: c })).toThrow("invalid table axis");
    expect(() => t.apply({ kind: "axis-delete", id: r, axis: "row", target: r })).toThrow("delete cannot target itself");

    // Self-referencing text-insert, text-delete, text-mark
    expect(() => t.apply({ kind: "text-insert", id: ch, row: r, column: c, after: ch, char: "a" })).toThrow("invalid text identity");
    expect(() => t.apply({ kind: "text-insert", id: r, row: r, column: c, after: null, char: "a" })).toThrow("invalid text identity");
    expect(() => t.apply({ kind: "text-insert", id: c, row: r, column: c, after: null, char: "a" })).toThrow("invalid text identity");

    expect(() => t.apply({ kind: "text-delete", id: ch, row: r, column: c, target: ch })).toThrow("invalid delete identity");
    expect(() => t.apply({ kind: "text-delete", id: r, row: r, column: c, target: ch })).toThrow("invalid delete identity");
    expect(() => t.apply({ kind: "text-delete", id: c, row: r, column: c, target: ch })).toThrow("invalid delete identity");

    expect(() => t.apply({ kind: "text-mark", id: ch, row: r, column: c, target: ch, key: "bold", value: "1" })).toThrow("invalid mark identity");
    expect(() => t.apply({ kind: "text-mark", id: r, row: r, column: c, target: ch, key: "bold", value: "1" })).toThrow("invalid mark identity");
    expect(() => t.apply({ kind: "text-mark", id: c, row: r, column: c, target: ch, key: "bold", value: "1" })).toThrow("invalid mark identity");

    // Unknown op kind
    expect(() => t.apply({ kind: "unknown", id: r } as unknown as TableOp)).toThrow("unknown table operation");

    // cellMark with invalid mark key, missing axes, and deleted axes
    t.apply({ kind: "axis-insert", id: r, axis: "row", after: null });
    t.apply({ kind: "axis-insert", id: c, axis: "column", after: null });
    t.apply({ kind: "text-insert", id: ch, row: r, column: c, after: null, char: "a" });
    expect(t.cellMark(r, c, ch, "bogus" as "bold")).toBeNull();
    expect(t.cellMark(id(9, 9), c, ch, "bold")).toBeNull();
    t.apply({ kind: "axis-delete", id: id(1, 4), axis: "row", target: r });
    expect(t.cellMark(r, c, ch, "bold")).toBeNull();
    expect(t.cellMark(r, c, ch, "bold", true)).toEqual({ value: null, version: null });

    // fromSnapshot: non-string, missing version (triggers ?? 0), and final pending > maxPending
    expect(() => ExperimentalTable.fromSnapshot(123 as unknown as string)).toThrow("snapshot must be text");
    expect(() => ExperimentalTable.fromSnapshot("{}")).toThrow("invalid experimental table snapshot");

    const pendingSnap = JSON.stringify({
      version: 1,
      ops: [
        { kind: "axis-insert", id: id(2, 1), axis: "row", after: id(9, 1) },
        { kind: "axis-insert", id: id(2, 2), axis: "row", after: id(9, 2) },
      ],
    });
    expect(() =>
      ExperimentalTable.fromSnapshot(pendingSnap, { ...DEFAULT_TABLE_LIMITS, maxPending: 1 }),
    ).toThrow("table resource limit: maxPending");
  });
});

describe("table-rich-selection-experimental edge cases", () => {
  function setup() {
    const table = new ExperimentalTable();
    const row = id(1, 1);
    const col = id(1, 2);
    const a = id(1, 3);
    const b = id(1, 4);
    table.apply({ kind: "axis-insert", id: row, axis: "row", after: null });
    table.apply({ kind: "axis-insert", id: col, axis: "column", after: null });
    table.apply({ kind: "text-insert", id: a, row, column: col, after: null, char: "A" });
    table.apply({ kind: "text-insert", id: b, row, column: col, after: a, char: "B" });
    return { table, row, col, a, b };
  }

  it("handles invalid selection bounds, UTF-16 start=0, invalid IDs, pending/rejected staleness, mismatched plans, and block ID collision", () => {
    const { table, row, col } = setup();

    // Invalid selection arguments
    expect(captureTableTextSelection(table, id(0, 1), col, 0, 1)).toBeNull();
    expect(captureTableTextSelection(table, row, id(1, 0), 0, 1)).toBeNull();
    expect(captureTableTextSelection(table, row, col, -1, 1)).toBeNull();
    expect(captureTableTextSelection(table, row, col, 1, 1)).toBeNull();
    expect(captureTableTextSelection(table, row, col, 0, 4097)).toBeNull();

    // UTF-16 selection starting at 0
    const sel0 = captureTableUTF16Selection(table, row, col, "AB", 0, 1)!;
    expect(sel0).not.toBeNull();
    expect(sel0.length).toBe(1);

    // Invalid IDs array & element
    expect(prepareTableTextMark(table, sel0, "bold", "1", null as unknown as OpId[]).status).toBe("invalid");
    expect(prepareTableTextMark(table, sel0, "bold", "1", []).status).toBe("invalid");
    expect(prepareTableTextMark(table, sel0, "bold", "1", [id(0, 10)]).status).toBe("invalid");

    // Ready plan, then check tableMarkPlanIsCurrent & prepareTableTextMarkInverse edge cases
    const planned = prepareTableTextMark(table, sel0, "bold", "1", [id(2, 10)]);
    if (planned.status !== "ready") throw new Error(planned.status);

    // Block ID colliding with plan.ops[0].id returns null
    expect(tableMarkPlanFrames(table, planned.plan, id(2, 10))).toBeNull();

    // Unknown plan / wrong table
    const otherTable = new ExperimentalTable();
    expect(tableMarkPlanIsCurrent(otherTable, planned.plan)).toBe(false);
    expect(tableMarkPlanIsCurrent(table, { ops: [] })).toBe(false);
    expect(prepareTableTextMarkInverse(otherTable, planned.plan, [id(2, 11)]).status).toBe("invalid");
    expect(prepareTableTextMarkInverse(table, { ops: [] }, [id(2, 11)]).status).toBe("invalid");
    expect(prepareTableTextMarkInverse(table, planned.plan, []).status).toBe("invalid");

    // Apply plan, then introduce pending op -> capture returns null, prepare & inverse return stale
    planned.plan.ops.forEach((op) => table.apply(op));
    table.apply({ kind: "axis-insert", id: id(5, 20), axis: "row", after: id(9, 99) });
    expect(captureTableTextSelection(table, row, col, 0, 1)).toBeNull();
    expect(prepareTableTextMark(table, sel0, "italic", "1", [id(2, 30)]).status).toBe("stale");
    expect(prepareTableTextMarkInverse(table, planned.plan, [id(2, 30)]).status).toBe("stale");
  });

  it("returns limit when table snapshot exceeds the 8 MiB selection-plan budget", () => {
    const c = 9007199254740000;
    const row = id(c, 1);
    const col = id(c, 2);
    const ch = id(c, 3);
    const ops: TableOp[] = [
      { kind: "axis-insert", id: row, axis: "row", after: null },
      { kind: "axis-insert", id: col, axis: "column", after: null },
      { kind: "text-insert", id: ch, row, column: col, after: null, char: "a" },
    ];
    for (let i = 0; i < 34000; i++) {
      ops.push({
        kind: "text-mark",
        id: { client: c, clock: c - 50000 + i },
        row,
        column: col,
        target: ch,
        key: "color",
        value: "#FFFFFF",
      });
    }
    const snap = JSON.stringify({ version: 2, ops });
    expect(snap.length).toBeGreaterThan(8 << 20);

    const table = ExperimentalTable.fromSnapshot(snap);
    const sel = captureTableTextSelection(table, row, col, 0, 1)!;
    expect(sel).not.toBeNull();
    expect(prepareTableTextMark(table, sel, "bold", "1", [{ client: c, clock: table.maxClock + 1 }])).toEqual({
      status: "limit",
    });
  });
});

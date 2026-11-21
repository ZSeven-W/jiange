import { describe, expect, it } from "vitest";
import {
  computePivotTable,
  detectDataTableRange,
  detectFirstNumericColOffset,
  extractChartDataset,
  extractPivotSourceHeaders,
  formatPivotNumber,
  pivotResultToCellMatrix,
} from "../src/analytics.js";
import type { EvaluatedSheetMap, SheetPivotTable, SheetWorksheet } from "../src/types.js";

function makeSheet(cells: [number, number, string][], rows = 10, cols = 6): SheetWorksheet {
  const rowAxes = Array.from({ length: rows }, (_, i) => ({ id: i + 1, pos: i }));
  const colAxes = Array.from({ length: cols }, (_, i) => ({ id: i + 1, pos: i }));
  return {
    id: 1,
    nodeId: 1,
    title: "Data",
    pos: 0,
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    filter: {},
    revision: 1,
    rows: rowAxes,
    columns: colAxes,
    cells: cells.map(([r, c, raw]) => ({ rowId: rowAxes[r].id, columnId: colAxes[c].id, raw, revision: 1 })),
  };
}

describe("analytics 100% branch coverage", () => {
  it("covers readEvaluatedCell, parseLooseNumber, and single/multi-col extractChartDataset branches", () => {
    const ws = makeSheet([
      [0, 0, ""], // empty header
      [1, 0, "$"], // cleaned === "" -> null
      [2, 0, "1e999"], // Infinity -> null
      [3, 0, ""], // empty cell -> skipped in colSpan===1
      [4, 0, "-15"], // negative value for minVal
      [5, 0, "42"], // raw without evalMap entry
    ]);
    const evalMap: EvaluatedSheetMap = {
      "1:0": { kind: "string", value: "$" },
      "2:0": { kind: "number", value: Number.POSITIVE_INFINITY },
      "3:0": { kind: "empty", value: "" },
      "4:0": { kind: "number", value: -15 },
      // 5:0 intentionally omitted from evalMap -> uses raw fallback!
    };
    const ds1 = extractChartDataset(ws, evalMap, { top: 0, left: 0, bottom: 5, right: 0, headerRow: true });
    expect(ds1.series[0].name).toBe("A");
    expect(ds1.minVal).toBe(-15);
    expect(ds1.series[0].values).toEqual([0, 0, -15, 42]);

    // Single column without headerRow
    const ds1NoHdr = extractChartDataset(ws, evalMap, { top: 0, left: 0, bottom: 1, right: 0, headerRow: false });
    expect(ds1NoHdr.series[0].name).toBe("A");

    // Multi-col: boolean, array (number head, string head, empty head), undefined ev.value, all-text seriesCols fallback, empty label row, empty header, headerRow=false
    const wsMulti = makeSheet([
      [0, 0, ""],
      [0, 1, ""],
      [1, 0, ""], // empty label row -> falls back to row index
      [1, 1, "raw-text"],
      [2, 0, "L2"],
      [2, 1, "arr-num"],
      [3, 0, "L3"],
      [3, 1, "arr-str"],
      [4, 0, "L4"],
      [4, 1, "arr-empty"],
    ]);
    const multiEval: EvaluatedSheetMap = {
      "1:1": { kind: "boolean", value: true },
      "2:0": { kind: "boolean", value: false },
      "2:1": { kind: "array", value: [[{ kind: "number", value: 12 }]] },
      "3:1": { kind: "array", value: [[{ kind: "string", value: "abc" }]] },
      "4:1": { kind: "array", value: [[]] },
      "3:0": { kind: "string", value: undefined as unknown as string },
    };
    const dsMulti = extractChartDataset(wsMulti, multiEval, { top: 0, left: 0, bottom: 4, right: 1, headerRow: true });
    expect(dsMulti.labels[0]).toBe("2");
    expect(dsMulti.series[0].name).toBe("B");
    expect(dsMulti.series[0].values).toEqual([0, 12, 0, 0]);

    // Multi-col with NO numeric values anywhere -> triggers seriesCols.length === 0 fallback AND headerRow: false
    const wsTextOnly = makeSheet([
      [0, 0, "Name"],
      [0, 1, "Note"],
      [1, 0, "A"],
      [1, 1, "x"],
    ]);
    const dsTextOnly = extractChartDataset(wsTextOnly, {}, { top: 0, left: 0, bottom: 1, right: 1, headerRow: false });
    expect(dsTextOnly.series[0].name).toBe("B");
    expect(dsTextOnly.series[0].values).toEqual([0, 0]);
  });

  it("covers detectDataTableRange, headers, and numeric col offset edge branches", () => {
    const ws = makeSheet([
      [1, 1, "A"],
      [1, 2, "B"],
      [2, 1, "C"],
      [2, 2, "D"],
      [4, 4, "   "], // whitespace-only cell in cellByKey -> !occupied
    ]);
    // Multi-cell selection returned as-is
    expect(detectDataTableRange(ws, {}, { top: 0, left: 0, bottom: 2, right: 2 })).toEqual({
      top: 0,
      left: 0,
      bottom: 2,
      right: 2,
    });
    // Seed at bottom-right (2,2) grows up (top--) and left (left--)
    expect(detectDataTableRange(ws, {}, { top: 2, left: 2, bottom: 2, right: 2 })).toEqual({
      top: 1,
      left: 1,
      bottom: 2,
      right: 2,
    });
    // Seed at empty cell scans cellByKey, skipping unoccupied whitespace cell (4,4)
    expect(detectDataTableRange(ws, {}, { top: 0, left: 0, bottom: 0, right: 0 })).toEqual({
      top: 1,
      left: 1,
      bottom: 2,
      right: 2,
    });
    // Completely empty sheet returns selection
    const emptyWs = makeSheet([[0, 0, "  "]]);
    expect(detectDataTableRange(emptyWs, {}, { top: 3, left: 3, bottom: 3, right: 3 })).toEqual({
      top: 3,
      left: 3,
      bottom: 3,
      right: 3,
    });

    // extractPivotSourceHeaders with empty header
    expect(extractPivotSourceHeaders(emptyWs, {}, { top: 0, left: 0, bottom: 1, right: 1 })).toEqual([
      "列 A",
      "列 B",
    ]);

    // detectFirstNumericColOffset with no numeric columns (width > 1 and width === 1)
    expect(detectFirstNumericColOffset(ws, {}, { top: 1, left: 1, bottom: 2, right: 2 })).toBe(1);
    expect(detectFirstNumericColOffset(ws, {}, { top: 1, left: 1, bottom: 2, right: 1 })).toBe(0);
  });

  it("covers formatPivotNumber, computePivotTable, and pivotResultToCellMatrix edge branches", () => {
    expect(formatPivotNumber(null)).toBe("—");
    expect(formatPivotNumber(Number.NaN)).toBe("—");
    expect(formatPivotNumber(1200)).toBe("1,200");
    expect(formatPivotNumber(12.345)).toBe("12.35");

    // Source table with: blank row, blank row/col fields, text-only values (numCount===0), missing col combinations, multiple row fields
    const ws = makeSheet([
      [0, 0, "Region"],
      [0, 1, "Sub"],
      [0, 2, "Quarter"],
      [0, 3, "Sales"],
      [1, 0, ""], // blank row field -> （空白）
      [1, 1, "S1"],
      [1, 2, ""], // blank col field -> （空白）
      [1, 3, "N/A"], // non-empty text, numCount === 0
      [2, 0, ""], // completely blank row -> skipped!
      [2, 1, ""],
      [2, 2, ""],
      [2, 3, ""],
      [3, 0, "East"],
      [3, 1, "S2"],
      [3, 2, "Q1"],
      [3, 3, ""], // empty value cell -> pushBucket early return
      [4, 0, "West"],
      [4, 1, "S2"],
      [4, 2, "Q2"],
      [4, 3, "100"],
      [5, 0, "North"],
      [5, 1, "S2"],
      [5, 2, "Q2"],
      [5, 3, "100"], // tie with West for value sort fallback to label sort
    ]);

    // Pivot covering all aggregations on empty/text-only buckets + multi rowFields + colField + showRowTotals + showColTotals + label_desc
    const pivot1: SheetPivotTable = {
      id: "p1",
      title: "P1",
      sourceSheetId: 1,
      top: 0,
      left: 0,
      bottom: 5,
      right: 3,
      rowFields: [0, 1],
      colField: 2,
      values: [
        { col: 3, agg: "sum" },
        { col: 3, agg: "avg" },
        { col: 3, agg: "min" },
        { col: 3, agg: "max" },
        { col: 3, agg: "count" },
      ],
      sortBy: "label_desc",
      showRowTotals: true,
      showColTotals: true,
    };
    const res1 = computePivotTable(ws, {}, pivot1);
    expect(res1.totalRecords).toBe(4);
    const matrix1 = pivotResultToCellMatrix(pivot1, res1);
    expect(matrix1.some((e) => e.raw === "总计")).toBe(true);
    expect(matrix1.some((e) => e.raw === "")).toBe(true);

    // Value sort (value_asc and value_desc) without colField -> uses a.cells[0] and -Infinity fallback + tie-breaker
    const pivotValAsc: SheetPivotTable = {
      id: "p2",
      title: "P2",
      sourceSheetId: 1,
      top: 0,
      left: 0,
      bottom: 5,
      right: 3,
      rowFields: [0],
      values: [{ col: 3, agg: "avg" }],
      sortBy: "value_asc",
      showRowTotals: false,
      showColTotals: true,
    };
    const resAsc = computePivotTable(ws, {}, pivotValAsc);
    expect(resAsc.rows.length).toBe(4);

    const pivotValDesc: SheetPivotTable = { ...pivotValAsc, sortBy: "value_desc" };
    const resDesc = computePivotTable(ws, {}, pivotValDesc);
    expect(resDesc.rows[0].totals).toEqual([]);

    // Non-integer field index fallback for sourceHeaders[f] ?? `列 ...` + grandRowTotals null handling
    const pivotSparse: SheetPivotTable = {
      id: "p3",
      title: "P3",
      sourceSheetId: 1,
      top: 0,
      left: 0,
      bottom: 5,
      right: 3,
      rowFields: [0.5],
      colField: 2,
      values: [{ col: 0.5, agg: "avg" }],
      sortBy: "value_desc",
      showRowTotals: true,
      showColTotals: true,
    };
    const resSparse = computePivotTable(ws, {}, pivotSparse);
    expect(resSparse.rowFieldHeaders).toEqual(["列 1.5"]);
    expect(resSparse.grandRowTotals).toEqual([null]);
    const matSparse = pivotResultToCellMatrix(pivotSparse, resSparse);
    expect(matSparse.length).toBeGreaterThan(0);
  });
});

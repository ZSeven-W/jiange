import { describe, expect, it } from "vitest";
import type { SheetPivotTable, SheetWorksheet } from "@/lib/api";
import { calculateWorkbook } from "./workbook-engine";
import {
  computePivotTable,
  detectDataTableRange,
  detectFirstNumericColOffset,
  extractChartDataset,
  pivotResultToCellMatrix,
} from "./sheet-analytics";

function buildSalesSheet(): SheetWorksheet {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, pos: i }));
  const columns = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, pos: i }));
  const rawGrid: string[][] = [
    ["部门", "季度", "销售额", "成本", "利润"],
    ["研发部", "Q1", "100", "40", "=C2-D2"],
    ["研发部", "Q2", "150", "50", "=C3-D3"],
    ["市场部", "Q1", "200", "80", "=C4-D4"],
    ["市场部", "Q2", "260", "90", "=C5-D5"],
    ["研发部", "Q1", "50", "20", "=C6-D6"],
  ];
  const cells = [];
  for (let r = 0; r < rawGrid.length; r++) {
    for (let c = 0; c < rawGrid[r].length; c++) {
      cells.push({ rowId: r + 1, columnId: c + 1, raw: rawGrid[r][c], style: {}, revision: 1 });
    }
  }
  return {
    id: 1,
    nodeId: 10,
    title: "销售明细",
    pos: 0,
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    filter: {},
    charts: [],
    pivotTables: [],
    revision: 1,
    rows,
    columns,
    cells,
  };
}

describe("sheet-analytics (charts & pivot tables)", () => {
  it("extracts chart series from evaluated formula cells", () => {
    const sheet = buildSalesSheet();
    const evalMap = calculateWorkbook([sheet]).get(sheet.id) ?? {};
    const ds = extractChartDataset(sheet, evalMap, {
      top: 0,
      left: 0,
      bottom: 4,
      right: 4,
      headerRow: true,
    });
    expect(ds.labels).toEqual(["研发部·Q1", "研发部·Q2", "市场部·Q1", "市场部·Q2"]);
    // Non-numeric text column 季度 is folded into category labels; only numeric columns become series.
    expect(ds.series.map((s) => s.name)).toEqual(["销售额", "成本", "利润"]);
    const profitSeries = ds.series.find((s) => s.name === "利润");
    expect(profitSeries?.values).toEqual([60, 100, 120, 170]);
    expect(ds.maxVal).toBe(260);
    expect(detectFirstNumericColOffset(sheet, evalMap, { top: 0, left: 0, bottom: 5, right: 4 })).toBe(2);
  });

  it("plots all columns for a single-row all-numeric range without headerRow", () => {
    const sheet: SheetWorksheet = {
      id: 2,
      nodeId: 10,
      title: "SingleRow",
      pos: 0,
      frozenRows: 0,
      frozenCols: 0,
      merges: [],
      filter: { enabled: false, headerRow: 0, rules: {} },
      revision: 1,
      rows: [{ id: 1, pos: 0 }],
      columns: [{ id: 1, pos: 0 }, { id: 2, pos: 1 }, { id: 3, pos: 2 }],
      cells: [
        { rowId: 1, columnId: 1, raw: "10", style: {}, revision: 1 },
        { rowId: 1, columnId: 2, raw: "20", style: {}, revision: 1 },
        { rowId: 1, columnId: 3, raw: "=SUM(A1:B1)", style: {}, revision: 1 },
      ],
    };
    const evalMap = calculateWorkbook([sheet]).get(sheet.id) ?? {};
    const ds = extractChartDataset(sheet, evalMap, { top: 0, left: 0, bottom: 0, right: 2, headerRow: false });
    expect(ds.labels).toEqual(["A", "B", "C"]);
    expect(ds.series).toHaveLength(1);
    expect(ds.series[0].values).toEqual([10, 20, 30]);
  });

  it("auto-detects contiguous data table around a single focused cell", () => {
    const sheet = buildSalesSheet();
    const evalMap = calculateWorkbook([sheet]).get(sheet.id) ?? {};
    expect(detectDataTableRange(sheet, evalMap, { top: 2, left: 2, bottom: 2, right: 2 })).toEqual({
      top: 0,
      left: 0,
      bottom: 5,
      right: 4,
    });
  });

  it("computes cross-tab pivot table (部门 × 季度) with sum/avg over formula columns and materializes styled matrix", () => {
    const sheet = buildSalesSheet();
    const evalMap = calculateWorkbook([sheet]).get(sheet.id) ?? {};
    const pivot: SheetPivotTable = {
      id: "piv-1",
      title: "部门季度利润透视",
      top: 0,
      left: 0,
      bottom: 5,
      right: 4,
      rowFields: [0], // 部门
      colField: 1,    // 季度 (Q1, Q2)
      values: [{ col: 4, agg: "sum" }], // 利润 = formula!
      showRowTotals: true,
      showColTotals: true,
      sortBy: "value_desc",
    };

    const res = computePivotTable(sheet, evalMap, pivot);
    expect(res.totalRecords).toBe(5);
    expect(res.colKeys).toEqual(["Q1", "Q2"]);
    // 市场部: Q1=120, Q2=170, Total=290; 研发部: Q1=60+30=90, Q2=100, Total=190.
    expect(res.rows.map((r) => ({ dept: r.labelCells[0], cells: r.cells, totals: r.totals }))).toEqual([
      { dept: "市场部", cells: [120, 170], totals: [290] },
      { dept: "研发部", cells: [90, 100], totals: [190] },
    ]);
    expect(res.grandTotals).toEqual([210, 270]);
    expect(res.grandRowTotals).toEqual([480]);

    const matrix = pivotResultToCellMatrix(pivot, res);
    // Header row (4 cols) + 2 data rows (8 cells) + 1 grand total row (4 cells) = 16 styled cells.
    expect(matrix).toHaveLength(16);
    expect(matrix.find((c) => c.row === 3 && c.col === 0)?.raw).toBe("总计");
    expect(matrix.find((c) => c.row === 3 && c.col === 3)?.raw).toBe("480");
  });
});

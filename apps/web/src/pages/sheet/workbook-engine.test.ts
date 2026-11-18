import { describe, expect, it } from "vitest";
import type { SheetWorksheet } from "@/lib/api";
import { calculateWorkbook, computeSortedRowWrites, extractFormulaReferences, formatCellDisplay, translateWorkbookFormula } from "./workbook-engine";

function makeSheet(id: number, title: string, cells: { row: number; col: number; raw: string; numFmt?: "currency" | "percent" | "decimal2" }[]): SheetWorksheet {
  return {
    id,
    nodeId: 1,
    title,
    pos: id - 1,
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    filter: {},
    revision: 1,
    rows: Array.from({ length: 10 }, (_, pos) => ({ id: id * 100 + pos + 1, pos })),
    columns: Array.from({ length: 6 }, (_, pos) => ({ id: id * 1000 + pos + 1, pos })),
    cells: cells.map((c, idx) => ({
      rowId: id * 100 + c.row + 1,
      columnId: id * 1000 + c.col + 1,
      raw: c.raw,
      style: c.numFmt ? { numFmt: c.numFmt } : {},
      revision: idx + 1,
    })),
  };
}

describe("workbook formula engine", () => {
  it("evaluates cross-sheet references, arithmetic, logic, text and cycles", () => {
    const s1 = makeSheet(1, "Sheet1", [
      { row: 0, col: 0, raw: "100" },
      { row: 0, col: 1, raw: "25%" },
      { row: 0, col: 2, raw: "=SUM(A1, Sheet2!A1:A2)" },
      { row: 1, col: 0, raw: '=IF(C1>120, CONCAT("达标:", TEXT), "未达标")' },
      { row: 1, col: 1, raw: '=IF(C1>120, CONCAT("总计", C1), "偏低")' },
      { row: 2, col: 0, raw: "=COUNTIF(Sheet2!A1:A3, \">15\")" },
      { row: 2, col: 1, raw: "=SUMIF(Sheet2!B1:B3, \"已通过\", Sheet2!A1:A3)" },
      { row: 3, col: 0, raw: "=A5" },
      { row: 4, col: 0, raw: "=A4" },
      { row: 5, col: 0, raw: "=ROUND(10/3, 2)" },
    ]);
    const s2 = makeSheet(2, "Sheet2", [
      { row: 0, col: 0, raw: "20" },
      { row: 0, col: 1, raw: "已通过" },
      { row: 1, col: 0, raw: "30" },
      { row: 1, col: 1, raw: "已通过" },
      { row: 2, col: 0, raw: "10" },
      { row: 2, col: 1, raw: "待审批" },
    ]);
    const result = calculateWorkbook([s1, s2]);
    const m1 = result.get(1)!;
    expect(m1["0:2"]).toEqual({ kind: "number", value: 150 });
    expect(m1["1:0"]).toEqual({ kind: "error", value: "#NAME?", error: "#NAME?" });
    expect(m1["1:1"]).toEqual({ kind: "string", value: "总计150" });
    expect(m1["2:0"]).toEqual({ kind: "number", value: 2 });
    expect(m1["2:1"]).toEqual({ kind: "number", value: 50 });
    expect(m1["3:0"]).toEqual({ kind: "error", value: "#CYCLE!", error: "#CYCLE!" });
    expect(m1["5:0"]).toEqual({ kind: "number", value: 3.33 });
  });

  it("extracts reference highlights starting with Feishu orange #ff8800", () => {
    const s1 = makeSheet(1, "Sheet1", []);
    const s2 = makeSheet(2, "项目 汇总", []);
    const refs = extractFormulaReferences("=SUM(A1:B2)+'项目 汇总'!C3", 1, [s1, s2]);
    expect(refs).toEqual([
      { sheetId: 1, top: 0, left: 0, bottom: 1, right: 1, color: "#ff8800", text: "A1:B2" },
      { sheetId: 2, top: 2, left: 2, bottom: 2, right: 2, color: "#7b56d9", text: "'项目 汇总'!C3" },
    ]);
  });

  it("translates relative formulas across fill & paste while keeping absolute axes and sheet names", () => {
    expect(translateWorkbookFormula("=SUM(A1:$B$2)+Sheet2!C1", 2, 1, 100, 26)).toBe("=SUM(B3:$B$2)+Sheet2!D3");
    expect(translateWorkbookFormula("=A1", -1, 0, 100, 26)).toBe("=#REF!");
  });

  it("formats currency, percent, decimals and sorts data rows deterministically", () => {
    expect(formatCellDisplay("=1234.5", { kind: "number", value: 1234.5 }, { numFmt: "currency" })).toBe("¥1,234.50");
    expect(formatCellDisplay("=0.256", { kind: "number", value: 0.256 }, { numFmt: "percent" })).toBe("25.6%");
    const ws = makeSheet(1, "Sheet1", [
      { row: 0, col: 0, raw: "任务" },
      { row: 0, col: 1, raw: "分值" },
      { row: 1, col: 0, raw: "B" },
      { row: 1, col: 1, raw: "30" },
      { row: 2, col: 0, raw: "A" },
      { row: 2, col: 1, raw: "10" },
    ]);
    const evalMap = calculateWorkbook([ws]).get(1)!;
    const writes = computeSortedRowWrites(ws, evalMap, 1, true, 0);
    expect(writes.some((w) => w.raw === "10" && w.rowId === ws.rows[1].id)).toBe(true);
    expect(writes.some((w) => w.raw === "30" && w.rowId === ws.rows[2].id)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { SheetWorksheet } from "@/lib/api";
import { exportWorkbookToXlsx, numFmtFromCode, parseXlsxForWorkbook } from "./workbook-xlsx";

function sheet(overrides: Partial<SheetWorksheet>): SheetWorksheet {
  return {
    id: 1, nodeId: 7, title: "Sheet1", pos: 0, frozenRows: 0, frozenCols: 0, merges: [], filter: {}, revision: 1,
    rows: Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, pos: i })),
    columns: Array.from({ length: 4 }, (_, i) => ({ id: 200 + i, pos: i })),
    cells: [],
    ...overrides,
  };
}

describe("workbook XLSX round trip", () => {
  it("keeps styles, number formats, merges and frozen panes after export and re-import", async () => {
    const source = sheet({
      title: "预算",
      frozenRows: 1,
      frozenCols: 1,
      merges: [{ top: 4, left: 0, bottom: 4, right: 2 }],
      cells: [
        { rowId: 100, columnId: 200, raw: "项目", style: { bold: true, bg: "#EEF3FF", align: "center" }, revision: 1 },
        { rowId: 101, columnId: 201, raw: "12000", style: { numFmt: "currency", borders: { top: true, bottom: true, color: "#9AA0A6" } }, revision: 1 },
        { rowId: 101, columnId: 202, raw: "0.25", style: { numFmt: "percent", italic: true, color: "#D83931", fontSize: 14, valign: "middle", wrap: true }, revision: 1 },
        { rowId: 102, columnId: 201, raw: "=SUM(B2:C2)", style: { numFmt: "decimal2" }, revision: 1 },
        { rowId: 103, columnId: 203, raw: "", style: { bg: "#FFF7E6" }, revision: 1 },
        { rowId: 104, columnId: 200, raw: "合并说明", style: {}, revision: 1 },
      ],
    });
    const bytes = exportWorkbookToXlsx([source]);
    const preview = await parseXlsxForWorkbook(new File([Uint8Array.from(bytes).buffer], "roundtrip.xlsx"));
    expect(preview.warnings).toEqual([]);
    const [imported] = preview.sheets;
    expect(imported.title).toBe("预算");
    expect(imported.frozenRows).toBe(1);
    expect(imported.frozenCols).toBe(1);
    expect(imported.merges).toEqual([{ top: 4, left: 0, bottom: 4, right: 2 }]);
    expect(imported.rows).toBe(100);
    expect(imported.cols).toBe(26);
    expect(imported.cells).toEqual(expect.arrayContaining([
      { row: 0, col: 0, raw: "项目", style: { bold: true, bg: "#EEF3FF", align: "center" } },
      { row: 1, col: 1, raw: "12000", style: { numFmt: "currency", borders: { top: true, bottom: true, color: "#9AA0A6" } } },
      { row: 1, col: 2, raw: "0.25", style: { numFmt: "percent", italic: true, color: "#D83931", fontSize: 14, valign: "middle", wrap: true } },
      { row: 2, col: 1, raw: "=SUM(B2:C2)", style: { numFmt: "decimal2" } },
      { row: 3, col: 3, raw: "", style: { bg: "#FFF7E6" } },
      { row: 4, col: 0, raw: "合并说明" },
    ]));
  });

  it("classifies common Excel number format codes", () => {
    expect(numFmtFromCode('"¥"#,##0.00')).toBe("currency");
    expect(numFmtFromCode("[$$-409]#,##0.00")).toBe("currency");
    expect(numFmtFromCode("0.00%")).toBe("percent");
    expect(numFmtFromCode("yyyy/m/d")).toBe("date");
    expect(numFmtFromCode("m/d/yyyy")).toBe("date");
    expect(numFmtFromCode("0.00")).toBe("decimal2");
    expect(numFmtFromCode("0.0")).toBe("decimal1");
    expect(numFmtFromCode("0")).toBe("integer");
    expect(numFmtFromCode("@")).toBeUndefined();
  });
});

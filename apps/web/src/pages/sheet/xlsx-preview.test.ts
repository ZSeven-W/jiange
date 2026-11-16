import { describe, expect, it } from "vitest";
import { readXlsx } from "@jiange/sheet-sdk/xlsx-read";
import { writeXlsx } from "@jiange/sheet-sdk/xlsx";
import { fromPreview, toPreview } from "./xlsx-preview";

describe("temporary XLSX preview", () => {
  it("preserves unchanged scalar types and does not reuse formula caches after edits", async () => {
    const input = { sheets: [{ name: "计划", cells: [
      { row: 0, col: 0, value: "001" }, { row: 0, col: 1, value: 12 },
      { row: 0, col: 2, value: true }, { row: 0, col: 3, value: { error: "#N/A" as const } },
      { row: 1, col: 0, formula: "=B1*2", value: 24 },
    ] }] };
    const preview = toPreview((await readXlsx(writeXlsx(input))).workbook);
    const edited = { ...preview.cells, "0:1": "13", "2:0": "新内容" };
    const output = await readXlsx(writeXlsx({ sheets: [fromPreview(preview.name, edited, preview.originals)] }));
    expect(output.workbook.sheets[0].cells).toEqual([
      { row: 0, col: 0, value: "001" }, { row: 0, col: 1, value: 13 },
      { row: 0, col: 2, value: true }, { row: 0, col: 3, value: { error: "#N/A" } },
      { row: 1, col: 0, formula: "=B1*2" }, { row: 2, col: 0, value: "新内容" },
    ]);
    expect(preview.losses.join("")).toContain("仅能计算部分公式");
  });
  it("refuses to silently truncate sheets, coordinates, and literal formula-like text", () => {
    expect(() => toPreview({ sheets: [{ name: "a", cells: [] }, { name: "b", cells: [] }] })).toThrow(/单工作表/);
    expect(() => toPreview({ sheets: [{ name: "a", cells: [{ row: 100, col: 0, value: "x" }] }] })).toThrow(/100 行/);
    expect(() => toPreview({ sheets: [{ name: "a", cells: [{ row: 0, col: 0, value: "=literal" }] }] })).toThrow(/普通文本/);
  });
  it("warns when an explicit empty string cannot be preserved", () => {
    const preview = toPreview({ sheets: [{ name: "a", cells: [{ row: 0, col: 0, value: "" }] }] });
    expect(preview.cells).toEqual({});
    expect(preview.losses).toContain("空文本单元格不会保留。");
  });
});

import { describe, expect, it } from "vitest";
import { applyCellChanges, clearSelection, columnName, pasteCells, selectionOutline, selectionText, sheetAddress } from "./gridModel";

describe("spreadsheet preview grid", () => {
  it("formats addresses beyond a single alphabet", () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    expect(sheetAddress({ row: 9, col: 26 })).toBe("AA10");
  });
  it("pastes and copies quoted rectangles without partial writes", () => {
    const original = { "0:0": "旧" };
    const result = pasteCells(original, { row: 0, col: 0 }, '甲\t"乙\n二"\n3\t4');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(selectionText(result.cells, { anchor: { row: 0, col: 0 }, focus: { row: 1, col: 1 } })).toBe('甲\t"乙\n二"\n3\t4');
    expect(pasteCells(original, { row: 99, col: 25 }, "a\tb")).toEqual({ ok: false, reason: "bounds" });
    expect(pasteCells(original, { row: 0, col: 0 }, "safe\t=1+1")).toEqual({ ok: true, cells: { "0:0": "safe", "0:1": "=1+1" } });
    expect(original).toEqual({ "0:0": "旧" });
    expect(selectionOutline({ anchor: { row: 0, col: 0 }, focus: { row: 1, col: 1 } }, { row: 0, col: 0 })).toContain("inset 2px 0");
  });
  it("enforces limits and clears only the selected cells", () => {
    expect(applyCellChanges({}, [{ point: { row: 0, col: 0 }, value: "字".repeat(11000) }])).toEqual({ ok: false, reason: "size" });
    expect(applyCellChanges({}, [{ point: { row: 0, col: 0 }, value: "a\u0000b" }])).toEqual({ ok: false, reason: "invalid" });
    expect(applyCellChanges({}, [{ point: { row: 0, col: 0 }, value: "\ud800" }])).toEqual({ ok: false, reason: "invalid" });
    expect(applyCellChanges({}, [{ point: { row: 0, col: 0 }, value: "😀" }]).ok).toBe(true);
    const result = clearSelection({ "0:0": "a", "1:1": "b", "2:2": "c" }, { anchor: { row: 1, col: 1 }, focus: { row: 0, col: 0 } });
    expect(result).toEqual({ ok: true, cells: { "2:2": "c" } });
  });
});

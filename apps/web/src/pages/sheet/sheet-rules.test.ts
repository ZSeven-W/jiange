import { describe, expect, it } from "vitest";
import type { SheetConditionalFormat, SheetDataValidation, SheetProtectedRange } from "@/lib/api";
import {
  evaluateSheetConditionalFormat,
  evaluateSheetValidation,
  findSheetDropdown,
  formatSheetRectA1,
  isSheetCellProtected,
} from "./sheet-rules";

describe("sheet-rules", () => {
  it("formats single cell and range A1 addresses", () => {
    expect(formatSheetRectA1({ top: 0, left: 0, bottom: 0, right: 0 })).toBe("A1");
    expect(formatSheetRectA1({ top: 1, left: 1, bottom: 4, right: 3 })).toBe("B2:D5");
  });

  it("evaluates strict and warning data validations for list, number, and date", () => {
    const rules: SheetDataValidation[] = [
      { id: "v1", top: 0, left: 0, bottom: 5, right: 0, type: "list", options: ["进行中", "已完成"], strict: true, hint: "仅限状态选项" },
      { id: "v2", top: 0, left: 1, bottom: 5, right: 1, type: "number", min: "0", max: "100", strict: true },
      { id: "v3", top: 0, left: 2, bottom: 5, right: 2, type: "date", min: "2026-01-01", max: "2026-12-31", strict: false },
    ];

    expect(findSheetDropdown(rules, 2, 0)?.options).toEqual(["进行中", "已完成"]);
    expect(findSheetDropdown(rules, 2, 1)).toBeNull();

    // List rule
    expect(evaluateSheetValidation("进行中", rules, 1, 0).valid).toBe(true);
    expect(evaluateSheetValidation("", rules, 1, 0).valid).toBe(true);
    expect(evaluateSheetValidation("=A1", rules, 1, 0).valid).toBe(true);
    const badList = evaluateSheetValidation("未知", rules, 1, 0);
    expect(badList.valid).toBe(false);
    expect(badList.strict).toBe(true);
    expect(badList.message).toBe("仅限状态选项");

    // Number rule
    expect(evaluateSheetValidation("85.5", rules, 0, 1).valid).toBe(true);
    expect(evaluateSheetValidation("101", rules, 0, 1).valid).toBe(false);
    expect(evaluateSheetValidation("abc", rules, 0, 1).valid).toBe(false);

    // Non-strict date rule
    expect(evaluateSheetValidation("2026-02-28", rules, 0, 2).valid).toBe(true);
    expect(evaluateSheetValidation("2026-02-30", rules, 0, 2).valid).toBe(false);
    const badDate = evaluateSheetValidation("2025-12-31", rules, 0, 2);
    expect(badDate.valid).toBe(false);
    expect(badDate.strict).toBe(false);
  });

  it("evaluates conditional formats dynamically over evaluated formula results", () => {
    const rules: SheetConditionalFormat[] = [
      { id: "c1", top: 0, left: 1, bottom: 10, right: 1, op: "gt", value1: "100", bg: "#dcfce7", color: "#166534", bold: true },
      { id: "c2", top: 0, left: 1, bottom: 10, right: 1, op: "between", value1: "50", value2: "100", bg: "#fef3c7", color: "#92400e" },
      { id: "c3", top: 0, left: 0, bottom: 10, right: 0, op: "contains", value1: "延期", bg: "#fee2e2", color: "#991b1b" },
    ];

    // Formula cell whose evaluated number is 125 (> 100)
    expect(
      evaluateSheetConditionalFormat("=SUM(B1:B2)", { kind: "number", value: 125 }, rules, 3, 1),
    ).toEqual({ bg: "#dcfce7", color: "#166534", bold: true });

    // Between 50 and 100
    expect(
      evaluateSheetConditionalFormat("75", { kind: "number", value: 75 }, rules, 3, 1),
    ).toEqual({ bg: "#fef3c7", color: "#92400e", bold: undefined });

    // Below 50 matches none
    expect(evaluateSheetConditionalFormat("20", { kind: "number", value: 20 }, rules, 3, 1)).toBeNull();

    // Text contains
    expect(
      evaluateSheetConditionalFormat("严重延期", { kind: "string", value: "严重延期" }, rules, 1, 0),
    ).toEqual({ bg: "#fee2e2", color: "#991b1b", bold: undefined });
  });

  it("checks protected cell ranges by role and allowlist", () => {
    const ranges: SheetProtectedRange[] = [
      { id: "p1", top: 2, left: 1, bottom: 4, right: 2, description: "锁定区", allowedUserIds: [42] },
    ];

    expect(isSheetCellProtected(ranges, 0, 0, 7, "edit")).toEqual({ protected: false, blocked: false });
    expect(isSheetCellProtected(ranges, 3, 2, 7, "edit").blocked).toBe(true);
    expect(isSheetCellProtected(ranges, 3, 2, 42, "edit")).toMatchObject({ protected: true, blocked: false });
    expect(isSheetCellProtected(ranges, 3, 2, 7, "manage")).toMatchObject({ protected: true, blocked: false });
  });
});

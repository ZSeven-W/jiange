import { describe, expect, it } from "vitest";
import type { BaseRecord, Field } from "@/lib/api";
import { matchRule, rowFill, rowHeightPx } from "./fill";
import { PALETTE } from "./registry";

const fields: Field[] = [
  { id: 1, name: "任务", type: "text", position: 1, isPrimary: true },
  { id: 2, name: "状态", type: "select", position: 2, options: ["进行中", "完成"] },
  { id: 3, name: "数字", type: "number", position: 3 },
  { id: 4, name: "勾选", type: "checkbox", position: 4 },
];
const rec = (cells: BaseRecord["cells"]): BaseRecord => ({ id: 1, baseId: 1, position: 1, cells });

describe("row fill rules", () => {
  it("evaluates text, select, number and checkbox operators", () => {
    expect(matchRule(rec({ 1: "梳理需求" }), fields[0], { op: "contains", v: "需求" }, [])).toBe(true);
    expect(matchRule(rec({ 1: "梳理需求" }), fields[0], { op: "not_contains", v: "需求" }, [])).toBe(false);
    expect(matchRule(rec({ 2: "进行中" }), fields[1], { op: "is", v: "进行中" }, [])).toBe(true);
    expect(matchRule(rec({}), fields[1], { op: "empty" }, [])).toBe(true);
    expect(matchRule(rec({ 3: 5 }), fields[2], { op: "gt", v: 3 }, [])).toBe(true);
    expect(matchRule(rec({ 3: 5 }), fields[2], { op: "lte", v: 3 }, [])).toBe(false);
    expect(matchRule(rec({}), fields[2], { op: "lt", v: 3 }, [])).toBe(false);
    expect(matchRule(rec({ 4: true }), fields[3], { op: "checked" }, [])).toBe(true);
    expect(matchRule(rec({ 1: "x" }), fields[0], { op: "contains", v: "" }, [])).toBe(false);
  });
  it("first matching rule wins and maps to the palette background", () => {
    const rules = [{ f: 3, op: "gt", v: 10, color: 1 }, { f: 2, op: "is", v: "进行中", color: 2 }, { f: 1, op: "not_empty", color: 3 }];
    expect(rowFill(rec({ 1: "a", 2: "进行中", 3: 1 }), fields, rules, [])).toBe(PALETTE[2][0]);
    expect(rowFill(rec({ 1: "a", 3: 11 }), fields, rules, [])).toBe(PALETTE[1][0]);
    expect(rowFill(rec({}), fields, rules, [])).toBeUndefined();
  });
  it("row height presets", () => {
    expect(rowHeightPx()).toBe(32);
    expect(rowHeightPx("medium")).toBe(56);
    expect(rowHeightPx("xhigh")).toBe(128);
  });
});

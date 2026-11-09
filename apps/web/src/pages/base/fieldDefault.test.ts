import { describe, expect, it } from "vitest";
import { defaultCell } from "./fields";

describe("field 默认值 input", () => {
  it("converts per type and clears on empty or invalid input", () => {
    expect(defaultCell("text", " 待补充 ", [])).toBe("待补充");
    expect(defaultCell("number", "3.5", [])).toBe(3.5);
    expect(defaultCell("number", "abc", [])).toBeNull();
    expect(defaultCell("select", "进行中", ["未开始", "进行中"])).toBe("进行中");
    expect(defaultCell("select", "旧选项", ["未开始"])).toBeNull();
    expect(defaultCell("checkbox", "true", [])).toBe(true);
    expect(defaultCell("date", "2026-11-09", [])).toBe("2026-11-09");
    expect(defaultCell("formula", "x", [])).toBeNull();
    expect(defaultCell("text", "   ", [])).toBeNull();
  });
});

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
    expect(defaultCell("multi_select", '["乙","甲","旧"]', ["甲", "乙"])).toEqual(["甲", "乙"]);
    expect(defaultCell("multi_select", "[]", ["甲"])).toBeNull();
    expect(defaultCell("multi_select", "not json", ["甲"])).toBeNull();
    expect(defaultCell("person", "7", [])).toBe(7);
    expect(defaultCell("person", "", [])).toBeNull();
    expect(defaultCell("person", "-1", [])).toBeNull();
    // 允许多选: the default is a JSON array of member ids in member order.
    expect(defaultCell("person", "[9,7]", [], [{ id: 7, name: "张三", email: "", createdAt: "" }, { id: 9, name: "李四", email: "", createdAt: "" }])).toEqual([7, 9]);
    expect(defaultCell("person", "[9,404]", [], [{ id: 9, name: "李四", email: "", createdAt: "" }])).toEqual([9]);
    expect(defaultCell("person", "[]", [])).toBeNull();
    expect(defaultCell("person", "not json", [])).toBeNull();
  });
});

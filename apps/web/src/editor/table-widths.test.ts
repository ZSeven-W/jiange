import { describe, expect, it } from "vitest";
import { parseTableWidths, updatedTableWidths, visibleTableWidths } from "./table-widths";

describe("document table widths", () => {
  it("uses the same minimum and automatic widths for editor and read-only views", () => {
    const rows = [["项目计划", "状态", "负责人"]];
    expect(visibleTableWidths(rows, [180, 70, null])).toEqual([180, 100, 100]);
    expect(visibleTableWidths([["这是一个较长的标题内容"]], undefined)).toEqual([117]);
  });
  it("handles invalid stored properties without breaking document rendering", () => {
    expect(parseTableWidths("not json")).toBeUndefined();
    expect(parseTableWidths("{} ")).toBeUndefined();
    expect(parseTableWidths('[180,"200",-1,0,null,100001]')).toEqual([180, null, null, null, null, null]);
    expect(visibleTableWidths([["a", "b"]], parseTableWidths("not json"))).toEqual([100, 100]);
  });
  it("preserves other automatic columns and stored widths when resizing", () => {
    expect(updatedTableWidths("", 3, 1, 150)).toBe("[null,150,null]");
    expect(updatedTableWidths("[120,null,200,300]", 3, 1, 160)).toBe("[120,160,200,300]");
    expect(updatedTableWidths("bad", 3, 1, 160)).toBeNull();
    expect(updatedTableWidths("", 3, 3, 160)).toBeNull();
    expect(updatedTableWidths("", 3, 1, 99)).toBeNull();
  });
});

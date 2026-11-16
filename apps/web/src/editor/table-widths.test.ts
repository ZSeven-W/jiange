import { describe, expect, it } from "vitest";
import { equalizedTableWidths, parseTableWidths, updatedSelectedTableWidths, updatedTableWidths, visibleTableWidths } from "./table-widths";

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
  it("equalizes selected nonadjacent columns and preserves their total", () => {
    expect(equalizedTableWidths([100, 170, 200, 300], [0, 2, 3])).toEqual([200, 170, 200, 200]);
    expect(equalizedTableWidths([100, 200, 201], [1, 2])).toEqual([100, 200.5, 200.5]);
    expect(equalizedTableWidths([100, 200], [0, 0])).toBeNull();
    expect(equalizedTableWidths([100, 200], [2, 0])).toBeNull();
    expect(equalizedTableWidths([100, 200], [0])).toBeNull();
  });
  it("writes only the selected widths and retains automatic and extra values", () => {
    expect(updatedSelectedTableWidths('[100,null,200,400]', 3, [0, 2], [150, 150])).toBe('[150,null,150,400]');
    expect(updatedSelectedTableWidths('', 3, [0, 2], [150, 150])).toBe('[150,null,150]');
    expect(updatedSelectedTableWidths('', 3, [0, 0], [150, 150])).toBeNull();
    expect(updatedSelectedTableWidths('', 3, [0, 2], [150])).toBeNull();
    expect(updatedSelectedTableWidths('bad', 3, [0, 2], [150, 150])).toBeNull();
  });
});

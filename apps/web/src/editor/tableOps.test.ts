import { describe, expect, it } from "vitest";
import { applyTableOp, coverMap, expandRange, mergeCells, parseMerges, splitCell, type Merge } from "./tableOps";

const grid = () => [["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]];

describe("table structure ops", () => {
  it("inserts and deletes rows/columns and clears them", () => {
    expect(applyTableOp(grid(), [], { kind: "insertRow", at: 1 }).rows).toEqual([["a", "b", "c"], ["", "", ""], ["d", "e", "f"], ["g", "h", "i"]]);
    expect(applyTableOp(grid(), [], { kind: "insertCol", at: 0 }).rows[0]).toEqual(["", "a", "b", "c"]);
    expect(applyTableOp(grid(), [], { kind: "deleteRow", index: 2 }).rows).toHaveLength(2);
    expect(applyTableOp(grid(), [], { kind: "deleteCol", index: 1 }).rows[1]).toEqual(["d", "f"]);
    expect(applyTableOp(grid(), [], { kind: "clearRow", index: 0 }).rows[0]).toEqual(["", "", ""]);
    expect(applyTableOp(grid(), [], { kind: "clearCol", index: 2 }).rows.map((r) => r[2])).toEqual(["", "", ""]);
    expect(applyTableOp([["x"]], [], { kind: "deleteRow", index: 0 }).rows).toEqual([["x"]]);
  });
  it("moves, grows and shrinks merges with structure changes", () => {
    const m: Merge[] = [[1, 0, 2, 2]];
    expect(applyTableOp(grid(), m, { kind: "insertRow", at: 0 }).merges).toEqual([[2, 0, 2, 2]]);
    expect(applyTableOp(grid(), m, { kind: "insertRow", at: 2 }).merges).toEqual([[1, 0, 3, 2]]);
    expect(applyTableOp(grid(), m, { kind: "insertCol", at: 1 }).merges).toEqual([[1, 0, 2, 3]]);
    expect(applyTableOp(grid(), m, { kind: "deleteRow", index: 1 }).merges).toEqual([[1, 0, 1, 2]]);
    expect(applyTableOp(grid(), [[0, 0, 1, 2]], { kind: "deleteCol", index: 0 }).merges).toEqual([]);
  });
});

describe("merge and split cells", () => {
  it("merges a range keeping text and splits it back", () => {
    const res = mergeCells(grid(), [], { r0: 0, c0: 0, r1: 1, c1: 1 })!;
    expect(res.merges).toEqual([[0, 0, 2, 2]]);
    expect(res.rows[0][0]).toBe("a b d e");
    expect(res.rows[1][1]).toBe("");
    expect(splitCell(res.merges, 1, 1)).toEqual([]);
    expect(splitCell(res.merges, 2, 2)).toBeNull();
    expect(mergeCells(grid(), [], { r0: 1, c0: 1, r1: 1, c1: 1 })).toBeNull();
  });
  it("expands a selection over intersecting merges", () => {
    expect(expandRange({ r0: 1, c0: 2, r1: 2, c1: 2 }, [[0, 1, 2, 2]])).toEqual({ r0: 0, c0: 1, r1: 2, c1: 2 });
  });
  it("cleans invalid merge data and maps covered cells", () => {
    expect(parseMerges("[[0,0,2,2],[1,1,2,2],[0,0,1,1],[2,2,5,1],\"x\"]", 3, 3)).toEqual([[0, 0, 2, 2]]);
    expect(parseMerges("not json", 3, 3)).toEqual([]);
    const map = coverMap([[0, 0, 2, 2]]);
    expect(map.get("0:0")).toEqual({ span: [2, 2] });
    expect(map.get("1:1")).toBe("hidden");
    expect(map.has("2:2")).toBe(false);
  });
});

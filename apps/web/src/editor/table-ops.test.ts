import { describe, expect, it } from "vitest";
import { applyTableOp, canMove, coverMap, expandRange, mergeCells, parseMerges, parseMergesStrict, planSelectionDelete, planTableReorder, remapWidths, reorderIndices, splitCell, type Merge } from "./table-ops";

const grid = () => [["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]];

describe("table structure ops", () => {
  it("reorders contiguous and nonadjacent axes without changing their relative order", () => {
    expect(reorderIndices(5,[1,3],0)).toEqual([1,3,0,2,4]);
    expect(reorderIndices(5,[1,2],5)).toEqual([0,3,4,1,2]);
    expect(reorderIndices(4,[1],2)).toEqual([0,1,2,3]);
    expect(reorderIndices(4,[1,1],0)).toBeNull();expect(reorderIndices(4,[4],0)).toBeNull();
    const rows=[['A','B','C','D'],['a','b','c','d']];
    expect(planTableReorder(rows,[],{kind:'reorderCols',indices:[1,3],before:0})?.rows).toEqual([['B','D','A','C'],['b','d','a','c']]);
    expect(remapWidths([100,110,120,130],{kind:'reorderCols',indices:[1,3],before:0},4)).toEqual([110,130,100,120]);
  });
  it("moves intact merges and refuses to split or reverse them", () => {
    const rows=[['A','B'],['','C'],['D','E'],['F','G']], merges:Merge[]=[[0,0,2,1]];
    expect(planTableReorder(rows,merges,{kind:'reorderRows',indices:[0,1],before:4})).toMatchObject({rows:[['D','E'],['F','G'],['A','B'],['','C']],merges:[[2,0,2,1]]});
    expect(planTableReorder(rows,merges,{kind:'reorderRows',indices:[0],before:4})).toBeNull();
    expect(planTableReorder(rows,merges,{kind:'reorderRows',indices:[2],before:1})).toBeNull();
    expect(rows[0][0]).toBe('A');
    expect(parseMergesStrict('[[0,0,4,1]]',3,2)).toBeNull();
    expect(parseMergesStrict('[[0,0,2,1]]',3,2)).toEqual([[0,0,2,1]]);
  });
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

describe("table column widths and moves", () => {
  const rows = [["a", "b", "c"], ["d", "e", "f"]];
  it("remaps widths on insert, delete and move", () => {
    expect(remapWidths([100, 200, 300], { kind: "insertCol", at: 1 }, 3)).toEqual([100, null, 200, 300]);
    expect(remapWidths([100, 200, 300], { kind: "deleteCol", index: 0 }, 3)).toEqual([200, 300]);
    expect(remapWidths([100, 200, 300], { kind: "moveCol", index: 2, to: 1 }, 3)).toEqual([100, 300, 200]);
    expect(remapWidths([100], { kind: "insertCol", at: 3 }, 3)).toEqual([100, null, null, null]);
    expect(remapWidths(undefined, { kind: "insertCol", at: 0 }, 3)).toBeUndefined();
    expect(remapWidths([1, 2, 3], { kind: "insertRow", at: 0 }, 3)).toBeUndefined();
  });
  it("swaps adjacent rows and columns, refusing to split merges", () => {
    expect(applyTableOp(rows, [], { kind: "moveCol", index: 0, to: 1 }).rows).toEqual([["b", "a", "c"], ["e", "d", "f"]]);
    expect(applyTableOp(rows, [], { kind: "moveRow", index: 1, to: 0 }).rows).toEqual([["d", "e", "f"], ["a", "b", "c"]]);
    const merged: Merge[] = [[0, 1, 1, 2]];
    expect(canMove(rows, merged, { kind: "moveCol", index: 0, to: 1 })).toBe(false);
    expect(applyTableOp(rows, merged, { kind: "moveCol", index: 0, to: 1 }).rows).toBe(rows);
    expect(applyTableOp(rows, merged, { kind: "moveRow", index: 0, to: 1 }).merges).toEqual([[1, 1, 1, 2]]);
    expect(canMove(rows, [], { kind: "moveCol", index: 2, to: 3 })).toBe(false);
  });
});

describe("selection toolbar deletion", () => {
  it("deletes whole selected rows or columns and preserves remaining data and widths", () => {
    const rows = grid();
    expect(planSelectionDelete(rows, [], [100, 150, 200], { r0: 0, r1: 1, c0: 0, c1: 2 })).toEqual({ kind: "rows", rows: [["g", "h", "i"]], merges: [], widths: undefined });
    expect(planSelectionDelete(rows, [], [100, 150, 200], { r0: 0, r1: 2, c0: 0, c1: 1 })).toEqual({ kind: "cols", rows: [["c"], ["f"], ["i"]], merges: [], widths: [200] });
    expect(rows).toEqual(grid());
  });
  it("only offers table deletion for the entire table and rejects partial rectangles", () => {
    expect(planSelectionDelete(grid(), [], undefined, { r0: 0, r1: 2, c0: 0, c1: 2 })).toEqual({ kind: "table" });
    expect(planSelectionDelete(grid(), [], undefined, { r0: 0, r1: 1, c0: 0, c1: 1 })).toBeNull();
    expect(planSelectionDelete(grid(), [], undefined, { r0: -1, r1: 1, c0: 0, c1: 2 })).toBeNull();
  });
  it("refuses to split a merge and remaps unrelated merges", () => {
    const merges: Merge[] = [[0, 0, 2, 1], [1, 1, 2, 2]];
    expect(planSelectionDelete(grid(), merges, undefined, { r0: 0, r1: 0, c0: 0, c1: 2 })).toBeNull();
    expect(planSelectionDelete(grid(), merges, undefined, { r0: 0, r1: 2, c0: 0, c1: 0 })).toEqual({ kind: "cols", rows: [["b", "c"], ["e", "f"], ["h", "i"]], merges: [[1, 0, 2, 2]], widths: undefined });
  });
});

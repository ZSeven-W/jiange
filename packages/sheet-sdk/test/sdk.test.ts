import { describe, expect, it } from "vitest";
import { calculateSheet, copySheetCells, pasteCopiedSheetCells } from "../src/index.js";

describe("headless sheet model", () => {
  it("copies a mixed-reference formula and recalculates it", () => {
    const cells = {"0:0":"10","1:0":"20","0:1":"=A1+$A$1"};
    const copy = copySheetCells(cells, {anchor:{row:0,col:1},focus:{row:0,col:1}}, "test")!;
    const pasted = pasteCopiedSheetCells(cells,{row:1,col:1},copy);
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    expect(pasted.cells["1:1"]).toBe("=A2+$A$1");
    expect(calculateSheet(pasted.cells)["1:1"]).toBe(30);
  });
});

import { describe, expect, it } from "vitest";
import { calculateSheet } from "../src/formula.js";

describe("spreadsheet preview formulas", () => {
  it("calculates arithmetic, referenced cells and common aggregates", () => {
    const cells = { "0:0": "10", "0:1": "20", "0:2": "=SUM(A1:B1)", "1:0": "=C1*2+5", "1:1": "=AVERAGE(A1:B1)", "1:2": "=MAX(A1:B1)-MIN(A1:B1)", "2:0": "=COUNT(A1:B2)", "2:1": "=($A$1+A$1+$B1)/2" };
    expect(calculateSheet(cells)).toMatchObject({ "0:2": 30, "1:0": 65, "1:1": 15, "1:2": 10, "2:0": 4, "2:1": 20 });
    expect(calculateSheet({ ...cells, "0:0": "20" })["1:0"]).toBe(85);
  });
  it("shows errors for invalid, unsupported, cyclic and out-of-bounds formulas", () => {
    expect(calculateSheet({ "0:0": "=1/0", "0:1": "=SUM(", "0:2": "=UNKNOWN(1)", "0:3": "=Z101", "0:4": "=F1", "0:5": "=E1", "0:6": "=1e999" })).toMatchObject({ "0:0": "#DIV/0!", "0:1": "#ERROR!", "0:2": "#NAME?", "0:3": "#REF!", "0:4": "#CYCLE!", "0:5": "#CYCLE!", "0:6": "#NUM!" });
  });
  it("bounds formula complexity and does not execute expressions", () => {
    expect(calculateSheet({ "0:0": `=${"(".repeat(100)}1${")".repeat(100)}`, "0:1": "=globalThis.alert(1)", "0:2": "=SUM(C1:Z100)" })).toMatchObject({ "0:0": "#LIMIT!", "0:1": "#ERROR!", "0:2": "#CYCLE!" });
  });
  it("does not cache depth-limit failures for unrelated roots", () => {
    const cells: Record<string, string> = {};
    for (let row = 0; row < 99; row++) cells[`${row}:0`] = `=A${row + 2}`;
    cells["99:0"] = "7";
    const result = calculateSheet(cells);
    expect(result["0:0"]).toBe("#LIMIT!");
    expect(result["20:0"]).toBe(7);
  });
  it("ignores text and empty cells in aggregate ranges", () => {
    expect(calculateSheet({ "0:0": "3", "0:1": "text", "0:3": "=SUM(A1:C1)", "1:0": "=AVERAGE(A1:C1)", "1:1": "=COUNT(A1:C1)" })).toMatchObject({ "0:3": 3, "1:0": 3, "1:1": 1 });
  });
});

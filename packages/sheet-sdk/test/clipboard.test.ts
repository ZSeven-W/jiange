import { describe, expect, it } from "vitest";
import { translateSheetFormula } from "../src/formula.js";
import { copySheetCells, pasteCopiedSheetCells, resolveSheetPaste } from "../src/clipboard.js";

describe("spreadsheet formula copy", () => {
  it("shifts relative and mixed references in expressions and ranges", () => {
    expect(translateSheetFormula("=SUM(A1:$B2)+$C$3+C$4+$D5", 2, 1)).toBe("=SUM(B3:$B4)+$C$3+D$4+$D7");
    expect(translateSheetFormula("= 1e3 + a1 * 2", 0, 1)).toBe("= 1e3 + B1 * 2");
    expect(translateSheetFormula("=A1+$B1+C$1+$D$1", -1, -1)).toBe("=#REF!+#REF!+B$1+$D$1");
  });
  it("does not guess how to rewrite unsupported syntax or function names", () => {
    for (const input of ['=IF(A1>1,"A1",0)', '=Sheet1!A1', '=LOG10(A1)', '=A1&"x"']) expect(translateSheetFormula(input, 1, 1)).toBeNull();
  });
  it("pastes an immutable rectangle snapshot and translates every formula", () => {
    const cells = {"0:0":"5","0:1":"=A1+$A$1","1:1":"=SUM(A1:B1)"};
    const copy = copySheetCells(cells, {anchor:{row:0,col:0},focus:{row:1,col:1}}, "copy-1");
    expect(copy).not.toBeNull();
    if (!copy) return;
    const result = pasteCopiedSheetCells({...cells,"0:0":"changed"}, {row:2,col:2}, copy);
    expect(result).toEqual({ok:true,cells:{...cells,"0:0":"changed","2:2":"5","2:3":"=C3+$A$1","3:3":"=SUM(C3:D3)"}});
  });
  it("makes no changes when one formula cannot be translated or the destination is out of bounds", () => {
    const cells = {"0:0":"5","0:1":"=IF(A1>0,1,0)"};
    const copy = copySheetCells(cells, {anchor:{row:0,col:0},focus:{row:0,col:1}}, "copy-2")!;
    expect(pasteCopiedSheetCells(cells, {row:2,col:0}, copy)).toEqual({ok:false,reason:"unsupported_formula"});
    const plain = copySheetCells({"0:0":"a","0:1":"b"}, {anchor:{row:0,col:0},focus:{row:0,col:1}}, "copy-3")!;
    expect(pasteCopiedSheetCells(cells, {row:99,col:25}, plain)).toEqual({ok:false,reason:"bounds"});
    expect(cells).toEqual({"0:0":"5","0:1":"=IF(A1>0,1,0)"});
  });
  it("does not silently paste a known formula when provenance is missing or mismatched", () => {
    const cells = {"0:1":"=A1"}, copy = copySheetCells(cells, {anchor:{row:0,col:1},focus:{row:0,col:1}}, "copy-4")!;
    expect(resolveSheetPaste(cells, {row:1,col:1}, copy.text, "", copy)).toEqual({ok:false,reason:"unverified_copy"});
    expect(resolveSheetPaste(cells, {row:1,col:1}, copy.text, "other", copy)).toEqual({ok:false,reason:"unverified_copy"});
    expect(resolveSheetPaste(cells, {row:1,col:1}, copy.text, "copy-4", null)).toEqual({ok:false,reason:"unverified_copy"});
    expect(resolveSheetPaste(cells, {row:1,col:1}, copy.text, "copy-4", copy)).toEqual({ok:true,cells:{...cells,"1:1":"=A2"}});
    expect(resolveSheetPaste(cells, {row:1,col:1}, "external text", "", copy)).toEqual({ok:true,cells:{...cells,"1:1":"external text"}});
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SUPPORTED_FORMULA_FUNCTIONS } from "@jiange/sheet-sdk/formula-functions";
import {
  applyFormulaCompletion,
  FORMULA_CATALOG,
  FORMULA_SPEC_MAP,
  inspectFormulaCaret,
  resolveActiveArgHighlightIndex,
  searchFormulaFunctions,
} from "./sheet-formula-autocomplete";
import { SheetFormulaBarAutocomplete } from "./sheet-formula-bar-autocomplete";

describe("sheet-formula-autocomplete", () => {
  it("covers all 144 supported SDK formula functions with curated top descriptions and fallbacks", () => {
    expect(SUPPORTED_FORMULA_FUNCTIONS.length).toBeGreaterThanOrEqual(144);
    expect(FORMULA_CATALOG.length).toBe(SUPPORTED_FORMULA_FUNCTIONS.length);
    for (const fn of SUPPORTED_FORMULA_FUNCTIONS) {
      const spec = FORMULA_SPEC_MAP.get(fn.toUpperCase());
      expect(spec, `missing spec for ${fn}`).toBeDefined();
      expect(spec!.description.length).toBeGreaterThan(0);
    }

    const xlookup = FORMULA_SPEC_MAP.get("XLOOKUP");
    expect(xlookup?.args).toEqual(["查找值", "查找数组", "返回数组", "[未找到值]", "[匹配模式]", "[搜索模式]"]);
    expect(FORMULA_SPEC_MAP.get("SUMIFS")?.args[0]).toBe("求和区域");
    expect(FORMULA_SPEC_MAP.get("DATEDIF")?.args).toEqual(["开始日期", "结束日期", "单位"]);
  });

  it("returns mode=complete with matching functions and exact replace range for top-level and nested prefixes", () => {
    const top = inspectFormulaCaret("=SU", 3);
    expect(top.mode).toBe("complete");
    if (top.mode === "complete") {
      expect(top.prefix).toBe("SU");
      expect(top.replaceStart).toBe(1);
      expect(top.replaceEnd).toBe(3);
      expect(top.matches.map((m) => m.name)).toContain("SUM");
      expect(top.matches.map((m) => m.name)).toContain("SUMIFS");
      expect(top.matches[0].name).toBe("SUM");
    }

    const nested = inspectFormulaCaret("=IF(A1>0, AV", 12);
    expect(nested.mode).toBe("complete");
    if (nested.mode === "complete") {
      expect(nested.prefix).toBe("AV");
      expect(nested.replaceStart).toBe(10);
      expect(nested.replaceEnd).toBe(12);
      expect(nested.matches.map((m) => m.name)).toContain("AVERAGE");
    }

    // Dotted statistical function names
    const dotted = inspectFormulaCaret("=STDEV.", 7);
    expect(dotted.mode).toBe("complete");
    if (dotted.mode === "complete") {
      expect(dotted.matches.map((m) => m.name)).toEqual(["STDEV.P", "STDEV.S"]);
    }

    // Substring match for LOOKUP finds VLOOKUP/XLOOKUP/HLOOKUP
    const lookupMatches = searchFormulaFunctions("LOOKUP");
    expect(lookupMatches.map((m) => m.name)).toEqual(expect.arrayContaining(["VLOOKUP", "XLOOKUP", "HLOOKUP"]));
  });

  it("ignores non-formulas, cell references, sheet prefixes, and string literals for completion", () => {
    expect(inspectFormulaCaret("SUM", 3)).toEqual({ mode: "none" });
    expect(inspectFormulaCaret("=A1+B2", 3)).toEqual({ mode: "none" });
    expect(inspectFormulaCaret("=Sheet2!A", 9)).toEqual({ mode: "none" });
    expect(inspectFormulaCaret('="SUM', 5)).toEqual({ mode: "none" });
    expect(inspectFormulaCaret("=SUM(A1:A5)", 11)).toEqual({ mode: "none" });
  });

  it("computes accurate signature mode and activeArgIndex with nested calls and string literals", () => {
    const sumArg1 = inspectFormulaCaret("=SUM(A1:A5, ", 12);
    expect(sumArg1.mode).toBe("signature");
    if (sumArg1.mode === "signature") {
      expect(sumArg1.name).toBe("SUM");
      expect(sumArg1.activeArgIndex).toBe(1);
    }

    const xlookupArg2 = inspectFormulaCaret("=XLOOKUP(A2, B:B, ", 18);
    expect(xlookupArg2.mode).toBe("signature");
    if (xlookupArg2.mode === "signature") {
      expect(xlookupArg2.name).toBe("XLOOKUP");
      expect(xlookupArg2.activeArgIndex).toBe(2);
    }

    // Commas inside string literals and nested calls must not shift outer arg index
    const nestedCompleted = inspectFormulaCaret('=IF(SUM(A1, A2)>10, "a, b, c", ', 31);
    expect(nestedCompleted.mode).toBe("signature");
    if (nestedCompleted.mode === "signature") {
      expect(nestedCompleted.name).toBe("IF");
      expect(nestedCompleted.activeArgIndex).toBe(2);
    }

    // Caret inside nested function call reports the inner function signature
    const innerCall = inspectFormulaCaret("=IF(INDEX(A1:C5, 2, ", 20);
    expect(innerCall.mode).toBe("signature");
    if (innerCall.mode === "signature") {
      expect(innerCall.name).toBe("INDEX");
      expect(innerCall.activeArgIndex).toBe(2);
    }

    // Escaped quotes inside string literals and quoted sheet names with commas
    const escapedAndSheet = inspectFormulaCaret(`=SUMIF('Q1, Sales'!A:A, "a"",b", `, 33);
    expect(escapedAndSheet.mode).toBe("signature");
    if (escapedAndSheet.mode === "signature") {
      expect(escapedAndSheet.name).toBe("SUMIF");
      expect(escapedAndSheet.activeArgIndex).toBe(2);
    }

    // Caret inside a string argument still shows the enclosing function's signature
    const insideStringArg = inspectFormulaCaret('=COUNTIF(A1:A10, ">10', 21);
    expect(insideStringArg.mode).toBe("signature");
    if (insideStringArg.mode === "signature") {
      expect(insideStringArg.name).toBe("COUNTIF");
      expect(insideStringArg.activeArgIndex).toBe(1);
    }
  });

  it("applies completion cleanly and positions caret inside parentheses", () => {
    const ins = inspectFormulaCaret("=IF(A1>0, AV", 12);
    expect(ins.mode).toBe("complete");
    if (ins.mode === "complete") {
      const res = applyFormulaCompletion("=IF(A1>0, AV", ins, "AVERAGE");
      expect(res.nextValue).toBe("=IF(A1>0, AVERAGE(");
      expect(res.nextCaret).toBe(18);
    }

    expect(resolveActiveArgHighlightIndex(["数值1", "[数值2]", "..."], 5)).toBe(2);
    expect(resolveActiveArgHighlightIndex([], 0)).toBe(-1);
  });

  it("renders autocomplete list and active-parameter signature tooltip cleanly", () => {
    const completeInspection = inspectFormulaCaret("=XL", 3);
    const completeHtml = renderToStaticMarkup(
      createElement(SheetFormulaBarAutocomplete, {
        inspection: completeInspection,
        anchorRect: { left: 100, bottom: 160, width: 400 },
        selectedIndex: 0,
        onHoverIndex: () => {},
        onSelectFunction: () => {},
      }),
    );
    expect(completeHtml).toContain("data-sheet-formula-autocomplete");
    expect(completeHtml).toContain('data-sheet-formula-option="XLOOKUP"');

    const sigInspection = inspectFormulaCaret("=XLOOKUP(A2, B:B, ", 18);
    const sigHtml = renderToStaticMarkup(
      createElement(SheetFormulaBarAutocomplete, {
        inspection: sigInspection,
        anchorRect: { left: 100, bottom: 160, width: 400 },
        selectedIndex: 0,
        onHoverIndex: () => {},
        onSelectFunction: () => {},
      }),
    );
    expect(sigHtml).toContain('data-sheet-formula-signature="XLOOKUP"');
    expect(sigHtml).toContain('data-sheet-formula-active-arg="2"');
    expect(sigHtml).toContain("返回数组");
    expect(sigHtml).toContain("#3370ff");
  });
});

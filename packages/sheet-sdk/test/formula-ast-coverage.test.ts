import { describe, expect, it } from "vitest";
import {
  extractAstReferences,
  extractFormulaReferences,
  formatSelectionAddress,
  parseA1Token,
  parseColToken,
  parseFormulaAst,
  parseRangeInput,
  translateWorkbookFormula,
} from "../src/formula-ast.js";
import type { SheetWorksheet } from "../src/types.js";

function makeSheet(id: number, title: string, rows = 10, cols = 10): SheetWorksheet {
  return {
    id,
    nodeId: id,
    title,
    pos: id - 1,
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    filter: {},
    revision: 1,
    rows: Array.from({ length: rows }, (_, i) => ({ id: i + 1, pos: i })),
    columns: Array.from({ length: cols }, (_, i) => ({ id: i + 1, pos: i })),
    cells: [],
  };
}

describe("formula-ast 100% branch coverage", () => {
  it("covers parseA1Token, parseColToken, parseRangeInput, and formatSelectionAddress", () => {
    expect(parseA1Token("ZZZ1")).toBeNull();
    expect(parseA1Token("A2000000")).toBeNull();
    expect(parseColToken("123")).toBeNull();
    expect(parseColToken("ZZZ")).toBeNull();
    expect(parseColToken("$B")).toEqual({ col: 1, abs: true });

    expect(parseRangeInput("   ")).toBeNull();
    expect(parseRangeInput("A1:B2:C3")).toBeNull();
    expect(parseRangeInput("BAD:B2")).toBeNull();
    expect(parseRangeInput("A1:BAD")).toBeNull();
    expect(parseRangeInput("B3")).toEqual({ anchor: { row: 2, col: 1 }, focus: { row: 2, col: 1 } });
    expect(parseRangeInput("A1:C4")).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 3, col: 2 } });

    expect(formatSelectionAddress({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })).toBe("A1");
    expect(formatSelectionAddress({ anchor: { row: 0, col: 0 }, focus: { row: 2, col: 2 } })).toBe("A1:C3");
  });

  it("covers tokenizeFormula, parseFormulaAst, precedence, arrays, errors, depth & cache limits", () => {
    // Whitespace, escaped quotes, unclosed string, error literals, sheet prefixes (quoted & unquoted),
    // sheet-prefixed bad cell, bad colrange, valid/bad rowrange, invalid sheet target
    expect(parseFormulaAst('= "he""llo" & "!" ')).toMatchObject({ kind: "binary", op: "&" });
    expect(parseFormulaAst('="unclosed')).toBeNull();
    expect(parseFormulaAst("=#DIV/0!")).toEqual({ kind: "error", code: "#DIV/0!" });
    expect(parseFormulaAst("='My''Sheet'!A1")).toMatchObject({ kind: "cell", sheetName: "My'Sheet" });
    expect(parseFormulaAst("=Sheet1!ZZZ1")).toEqual({ kind: "error", code: "#REF!" });
    expect(parseFormulaAst("=Sheet1!A:ZZZ")).toEqual({ kind: "error", code: "#REF!" });
    expect(parseFormulaAst("=Sheet1!1:5")).toMatchObject({
      kind: "range",
      sheetName: "Sheet1",
      startRow: 0,
      endRow: 4,
      startCol: -1,
    });
    expect(parseFormulaAst("=Sheet1!1:2000000")).toEqual({ kind: "error", code: "#REF!" });
    expect(parseFormulaAst("=Sheet1!bad")).toBeNull();

    // Two-char operators, power, unary, percent, parens, missing args, array errors, trailing tokens, unknown char
    expect(parseFormulaAst("=1<=2")).toMatchObject({ kind: "binary", op: "<=" });
    expect(parseFormulaAst("=1>=2")).toMatchObject({ kind: "binary", op: ">=" });
    expect(parseFormulaAst("=1<>2")).toMatchObject({ kind: "binary", op: "<>" });
    expect(parseFormulaAst("=2^3^2")).toMatchObject({ kind: "binary", op: "^" });
    expect(parseFormulaAst("=(1+2)*50%")).toMatchObject({ kind: "binary", op: "*" });
    expect(parseFormulaAst("=(1+2")).toBeNull();
    expect(parseFormulaAst("=()")).toBeNull();
    expect(parseFormulaAst("=-")).toBeNull();
    expect(parseFormulaAst("=1+")).toBeNull();
    expect(parseFormulaAst("=1 2")).toBeNull();
    expect(parseFormulaAst("=)")).toBeNull();
    expect(parseFormulaAst("=@")).toBeNull();
    expect(parseFormulaAst("=")).toBeNull();

    // Array literal edge cases: empty {}, bad elem, bad sep, unterminated after comma
    expect(parseFormulaAst("={}")).toBeNull();
    expect(parseFormulaAst("={,}")).toBeNull();
    expect(parseFormulaAst("={1 2}")).toBeNull();
    expect(parseFormulaAst("={1,")).toBeNull();

    // Function calls: omitted optional arg, invalid arg, missing ')'
    const omitted = parseFormulaAst("=INDEX(A1:B2,,2)");
    expect(omitted).toMatchObject({ kind: "call", name: "INDEX" });
    expect(parseFormulaAst("=SUM(1,)")).toMatchObject({ kind: "call", name: "SUM" });
    expect(parseFormulaAst("=SUM(@)")).toBeNull();
    expect(parseFormulaAst("=SUM(1")).toBeNull();
    expect(parseFormulaAst("=SUM(1+)")).toBeNull();

    // MAX_TOKENS exceeded via colrange, rowrange, and regular tokens
    expect(parseFormulaAst("=" + "A:B+".repeat(2050) + "A:B")).toBeNull();
    expect(parseFormulaAst("=" + "1:2+".repeat(2050) + "1:2")).toBeNull();
    expect(parseFormulaAst("=" + "1+".repeat(2050) + "1")).toBeNull();

    // MAX_PARSE_DEPTH exceeded in parsePrimary (L235) and parseExpr (L358)
    expect(parseFormulaAst("=" + "+".repeat(70) + "1")).toBeNull();
    expect(parseFormulaAst("=-" + "(".repeat(33) + "1" + ")".repeat(33))).toBeNull();

    // AST cache eviction (>= 4096 entries)
    for (let i = 0; i < 4105; i++) {
      parseFormulaAst(`=${i}+0`);
    }

    // extractAstReferences with percent, unary, array, volatile, dynamic
    const ast = parseFormulaAst("=OFFSET(A1,0,0)+TODAY()+(-50%)+SUM({1,2;3,4})+TaxRate")!;
    const refs = extractAstReferences(ast);
    expect(refs.hasVolatile).toBe(true);
    expect(refs.hasDynamicRef).toBe(true);
    expect(refs.names).toContain("TaxRate");
  });

  it("covers extractFormulaReferences and translateWorkbookFormula branches", () => {
    const s1 = makeSheet(1, "Sheet1");
    const s2 = makeSheet(2, "Data");
    const sheets = [s1, s2];

    expect(extractFormulaReferences("plain", 1, sheets)).toEqual([]);
    expect(extractFormulaReferences('="unclosed', 1, sheets)).toEqual([]);
    const refs = extractFormulaReferences(
      "=A:B + Data!C:D + Missing!E:F + A1:B2 + Data!C1:D2 + Missing!A1:B2 + G5 + Data!H6 + Missing!I7",
      1,
      sheets,
    );
    expect(refs.length).toBe(6);

    // translateWorkbookFormula
    expect(translateWorkbookFormula("plain", 1, 1, 100, 26)).toBe("plain");
    expect(translateWorkbookFormula('="he""llo"&A1+$B$2', 2, 3, 100, 26)).toBe('="he""llo"&D3+$B$2');
    expect(translateWorkbookFormula('="unclosed', 1, 1, 100, 26)).toBe('="unclosed');
    expect(translateWorkbookFormula("=Sheet1!ZZZ1+Sheet1!A1+Sheet1!$A$1", -1, 0, 10, 10)).toBe(
      "=#REF!+#REF!+Sheet1!$A$1",
    );
    expect(translateWorkbookFormula("=Sheet1!A1+SUM(A1)+MyName", 1, 1, 10, 10)).toBe(
      "=Sheet1!B2+SUM(B2)+MyName",
    );
    expect(translateWorkbookFormula("=A1", -5, 0, 10, 10)).toBe("=#REF!");
  });
});

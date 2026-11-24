import { describe, expect, it } from "vitest";
import { parseFormulaAst } from "../src/formula-ast.js";
import { calculateWorkbook, IncrementalFormulaEngine } from "../src/formula-engine.js";
import {
  arrVal,
  boolVal,
  BUILTIN_FUNCTIONS,
  EMPTY_VAL,
  errVal,
  type FormulaEvalContext,
  imgVal,
  isSafeSheetImageUrl,
  numVal,
  strVal,
  SUPPORTED_FORMULA_FUNCTIONS,
  toBoolean,
} from "../src/formula-functions.js";
import { formatCellDisplay } from "../src/numfmt.js";
import type { EvalValue, SheetWorksheet } from "../src/types.js";

function makeSheet(id: number, title: string, entries: [number, number, string][], rows = 30, cols = 12): SheetWorksheet {
  const rowAxes = Array.from({ length: rows }, (_, i) => ({ id: i + 1, pos: i }));
  const colAxes = Array.from({ length: cols }, (_, i) => ({ id: i + 1, pos: i }));
  return {
    id,
    nodeId: 1,
    title,
    pos: id - 1,
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    filter: {},
    revision: 1,
    rows: rowAxes,
    columns: colAxes,
    cells: entries.map(([r, c, raw]) => ({ rowId: rowAxes[r].id, columnId: colAxes[c].id, raw, revision: 1 })),
  };
}

describe("Modern sheet formula functions (Wave 2 E4-2)", () => {
  it("registers all 8 modern functions in SUPPORTED_FORMULA_FUNCTIONS", () => {
    for (const fn of [
      "REGEXMATCH",
      "REGEXREPLACE",
      "REGEXEXTRACT",
      "LET",
      "LAMBDA",
      "ARRAYFORMULA",
      "QUERY",
      "IMAGE",
    ]) {
      expect(SUPPORTED_FORMULA_FUNCTIONS).toContain(fn);
    }
  });

  it("evaluates REGEXMATCH, REGEXREPLACE, and REGEXEXTRACT with invalid/unsafe regex guards", () => {
    const ws = makeSheet(1, "Regex", [
      [0, 0, "order-2026-042"],
      [0, 1, '=REGEXMATCH(A1, "^order-\\d{4}-\\d{3}$")'],
      [0, 2, '=REGEXMATCH(A1, "^invoice-")'],
      [0, 3, '=REGEXMATCH(A1, "[invalid")'],
      [0, 4, '=REGEXMATCH(A1, "(a+)+$")'], // ReDoS nested quantifier guarded -> #VALUE!
      [0, 5, '=REGEXMATCH("hello", "")'],
      [1, 0, '=REGEXREPLACE("a1b2c3", "\\d+", "#")'],
      [1, 1, '=REGEXREPLACE("2026-11-24", "(\\d{4})-(\\d{2})-(\\d{2})", "$2/$3/$1")'],
      [1, 2, '=REGEXREPLACE("abc", "[bad", "x")'],
      [2, 0, '=REGEXEXTRACT("SKU: AB-9876", "([A-Z]+-\\d+)")'],
      [2, 1, '=REGEXEXTRACT("price is 42.50 usd", "\\d+\\.\\d+")'],
      [2, 2, '=REGEXEXTRACT("no digits here", "\\d+")'],
      [2, 3, '=REGEXEXTRACT("abc", "(")'],
    ]);
    const m = calculateWorkbook([ws]).get(1)!;
    expect(m["0:1"]).toEqual({ kind: "boolean", value: true });
    expect(m["0:2"]).toEqual({ kind: "boolean", value: false });
    expect(m["0:3"]).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });
    expect(m["0:4"]).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });
    expect(m["0:5"]).toEqual({ kind: "boolean", value: true });
    expect(m["1:0"]).toEqual({ kind: "string", value: "a#b#c#" });
    expect(m["1:1"]).toEqual({ kind: "string", value: "11/24/2026" });
    expect(m["1:2"]).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });
    expect(m["2:0"]).toEqual({ kind: "string", value: "AB-9876" });
    expect(m["2:1"]).toEqual({ kind: "string", value: "42.50" });
    expect(m["2:2"]).toEqual({ kind: "error", value: "#N/A", error: "#N/A" });
    expect(m["2:3"]).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });
  });

  it("evaluates LET with sequential lexical bindings, shadowing, and zero global mutation", () => {
    const ws = makeSheet(1, "Let", [
      [0, 0, "10"],
      [0, 1, "=LET(x, A1*2, y, x+5, x+y)"], // x=20, y=25 -> 45
      [0, 2, "=LET(x, 1, LET(x, 2, x) + x)"], // nested shadowing -> 3
      [0, 3, "=LET(TaxRate, 0.5, A1 * TaxRate)"], // locally shadows global TaxRate -> 5
      [0, 4, "=A1 * TaxRate"], // global TaxRate unchanged (0.1) -> 1
      [0, 5, "=x"], // local x must NOT leak to outer scope -> #NAME?
      [1, 0, "=LET(vals, A1:A1, SUM(vals)*3)"], // range bound in LET -> 30
      [1, 1, "=LET(x, 1)"], // invalid even arg count -> #VALUE!
      [1, 2, "=LET(123, 1, 2)"], // invalid non-identifier name -> #VALUE!
    ]);
    const engine = new IncrementalFormulaEngine();
    engine.loadSheets([ws], { definedNames: [{ name: "TaxRate", ref: "0.1" }] });
    expect(engine.getValue(1, 0, 1)).toEqual({ kind: "number", value: 45 });
    expect(engine.getValue(1, 0, 2)).toEqual({ kind: "number", value: 3 });
    expect(engine.getValue(1, 0, 3)).toEqual({ kind: "number", value: 5 });
    expect(engine.getValue(1, 0, 4)).toEqual({ kind: "number", value: 1 });
    expect(engine.getValue(1, 0, 5)).toEqual({ kind: "error", value: "#NAME?", error: "#NAME?" });
    expect(engine.getValue(1, 1, 0)).toEqual({ kind: "number", value: 30 });
    expect(engine.getValue(1, 1, 1)).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });
    expect(engine.getValue(1, 1, 2)).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });

    // Incremental update of A1 recalculates dependent LET cells automatically!
    const upd = engine.updateCells(1, [{ row: 0, col: 0, raw: "20" }]);
    expect(upd.recalculated).toBeGreaterThan(0);
    expect(engine.getValue(1, 0, 1)).toEqual({ kind: "number", value: 85 }); // x=40, y=45 -> 85
    expect(engine.getValue(1, 0, 3)).toEqual({ kind: "number", value: 10 });
    expect(engine.getValue(1, 0, 4)).toEqual({ kind: "number", value: 2 });
  });

  it("evaluates LAMBDA immediate calls, currying, higher-order calls, LET+LAMBDA, and defined-name LAMBDA", () => {
    const ws = makeSheet(1, "Lambda", [
      [0, 0, "=LAMBDA(x, y, x*y)(6, 7)"], // 42
      [0, 1, "=LET(double, LAMBDA(n, n*2), double(21))"], // 42
      [0, 2, "=LAMBDA(x, LAMBDA(y, x+y))(10)(32)"], // curried -> 42
      [0, 3, "=(LAMBDA(x, x+1))(41)"], // parenthesized -> 42
      [0, 4, "=LET(factor, 3, mul, LAMBDA(n, n * factor), mul(14))"], // closure capture -> 42
      [0, 5, "=LET(apply, LAMBDA(fn, v, fn(v)), apply(LAMBDA(x, x*x), 7))"], // higher-order -> 49
      [0, 6, "=LAMBDA(99)()"], // zero-param lambda -> 99
      [1, 0, "=LAMBDA(x, x+1)"], // uninvoked lambda at cell boundary -> #CALC!
      [1, 1, "=LAMBDA(x, y, x+y)(1)"], // wrong arity -> #VALUE!
      [1, 2, "=LAMBDA(x, x, x+1)(1, 2)"], // duplicate param -> #VALUE!
      [1, 3, "=LET(notFn, 5, notFn(1))"], // calling non-lambda -> #VALUE!
      [1, 4, "=Square(9)"], // workbook defined-name LAMBDA -> 81
      [1, 5, "=IF(TRUE, LAMBDA(x, x+10), LAMBDA(x, x-10))(5)"], // conditional lambda -> 15
    ]);
    const m = calculateWorkbook([ws], {
      definedNames: [{ name: "Square", ref: "=LAMBDA(n, n*n)" }],
    }).get(1)!;
    expect(m["0:0"]).toEqual({ kind: "number", value: 42 });
    expect(m["0:1"]).toEqual({ kind: "number", value: 42 });
    expect(m["0:2"]).toEqual({ kind: "number", value: 42 });
    expect(m["0:3"]).toEqual({ kind: "number", value: 42 });
    expect(m["0:4"]).toEqual({ kind: "number", value: 42 });
    expect(m["0:5"]).toEqual({ kind: "number", value: 49 });
    expect(m["0:6"]).toEqual({ kind: "number", value: 99 });
    expect(m["1:0"]).toEqual({ kind: "error", value: "#CALC!", error: "#CALC!" });
    expect(m["1:1"]).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });
    expect(m["1:2"]).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });
    expect(m["1:3"]).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });
    expect(m["1:4"]).toEqual({ kind: "number", value: 81 });
    expect(m["1:5"]).toEqual({ kind: "number", value: 15 });
  });

  it("evaluates ARRAYFORMULA element-wise arithmetic, spills, aggregations, and lifted scalar functions", () => {
    const ws = makeSheet(1, "Array", [
      [0, 0, "2"], [0, 1, "10"], [0, 2, "apple"],
      [1, 0, "5"], [1, 1, "20"], [1, 2, "banana"],
      [2, 0, "8"], [2, 1, "30"], [2, 2, "cherry"],
      // Spill A1:A3 * 2 into D1:D3
      [0, 3, "=ARRAYFORMULA(A1:A3*2)"],
      // Spill A1:A3 * B1:B3 into E1:E3
      [0, 4, "=ARRAYFORMULA(A1:A3*B1:B3)"],
      // Aggregating over ARRAYFORMULA
      [4, 0, "=SUM(ARRAYFORMULA(A1:A3*B1:B3))"], // 20 + 100 + 240 = 360
      [4, 1, "=ARRAYFORMULA(SUM(A1:A3*2))"], // 4 + 10 + 16 = 30
      // Element-wise IF inside ARRAYFORMULA -> F1:F3
      [0, 5, '=ARRAYFORMULA(IF(A1:A3>=5, "Big", "Small"))'],
      // Element-wise UPPER inside ARRAYFORMULA -> G1:G3
      [0, 6, "=ARRAYFORMULA(UPPER(C1:C3))"],
      // Element-wise REGEXMATCH inside ARRAYFORMULA -> H1:H3
      [0, 7, '=ARRAYFORMULA(REGEXMATCH(C1:C3, "^[ab]"))'],
      // Element-wise IFERROR inside ARRAYFORMULA -> I1:I3
      [0, 8, "=ARRAYFORMULA(IFERROR(100/(A1:A3-5), -1))"],
    ]);
    const m = calculateWorkbook([ws]).get(1)!;
    // D1:D3
    expect(m["0:3"]).toEqual({ kind: "number", value: 4 });
    expect(m["1:3"]).toEqual({ kind: "number", value: 10 });
    expect(m["2:3"]).toEqual({ kind: "number", value: 16 });
    // E1:E3
    expect(m["0:4"]).toEqual({ kind: "number", value: 20 });
    expect(m["1:4"]).toEqual({ kind: "number", value: 100 });
    expect(m["2:4"]).toEqual({ kind: "number", value: 240 });
    // Aggregations
    expect(m["4:0"]).toEqual({ kind: "number", value: 360 });
    expect(m["4:1"]).toEqual({ kind: "number", value: 30 });
    // F1:F3 (IF)
    expect(m["0:5"]).toEqual({ kind: "string", value: "Small" });
    expect(m["1:5"]).toEqual({ kind: "string", value: "Big" });
    expect(m["2:5"]).toEqual({ kind: "string", value: "Big" });
    // G1:G3 (UPPER)
    expect(m["0:6"]).toEqual({ kind: "string", value: "APPLE" });
    expect(m["1:6"]).toEqual({ kind: "string", value: "BANANA" });
    expect(m["2:6"]).toEqual({ kind: "string", value: "CHERRY" });
    // H1:H3 (REGEXMATCH)
    expect(m["0:7"]).toEqual({ kind: "boolean", value: true });
    expect(m["1:7"]).toEqual({ kind: "boolean", value: true });
    expect(m["2:7"]).toEqual({ kind: "boolean", value: false });
    // I1:I3 (IFERROR)
    expect(m["0:8"].value).toBeCloseTo(-100 / 3, 5);
    expect(m["1:8"]).toEqual({ kind: "number", value: -1 });
    expect(m["2:8"].value).toBeCloseTo(100 / 3, 5);
  });

  it("evaluates QUERY with SELECT, WHERE, GROUP BY, aggregates, ORDER BY, and LIMIT", () => {
    const ws = makeSheet(1, "Query", [
      // Table at A1:C6
      [0, 0, "Region"], [0, 1, "Rep"], [0, 2, "Sales"],
      [1, 0, "East"], [1, 1, "Alice"], [1, 2, "120"],
      [2, 0, "West"], [2, 1, "Bob"], [2, 2, "80"],
      [3, 0, "East"], [3, 1, "Carol"], [3, 2, "200"],
      [4, 0, "West"], [4, 1, "Dave"], [4, 2, "150"],
      [5, 0, "North"], [5, 1, "Eve"], [5, 2, "50"],

      // Q1 at E1: WHERE + ORDER BY + LIMIT (with auto-detected header -> 1 header + 2 rows)
      [0, 4, '=QUERY(A1:C6, "SELECT B, C WHERE C > 100 ORDER BY C DESC LIMIT 2")'],
      // Q2 at H1: GROUP BY + SUM + AVG + COUNT ordered by SUM(C) DESC
      [0, 7, '=QUERY(A1:C6, "SELECT A, SUM(C), AVG(C), COUNT(B) GROUP BY A ORDER BY SUM(C) DESC", 1)'],
      // Q3 at A8: Col1/Col2 syntax + WHERE string equality, headers = 0 on data-only subrange
      [7, 0, '=QUERY(A2:C6, "SELECT Col2 WHERE Col1 = \'West\' ORDER BY Col3 ASC", 0)'],
      // Q4 at D8: Scalar 1x1 pure aggregate without header
      [7, 3, '=QUERY(A2:C6, "SELECT SUM(C) WHERE A = \'East\'", 0)'],
      // Q5 at E8: Empty result -> #N/A
      [7, 4, '=QUERY(A1:C6, "SELECT * WHERE C > 9999", 1)'],
      // Q6 at F8: Invalid SQL syntax -> #VALUE!
      [7, 5, '=QUERY(A1:C6, "SELEKT ???", 1)'],
    ], 20, 14);

    const m = calculateWorkbook([ws]).get(1)!;
    // Q1 at E1:F3 -> Header ["Rep", "Sales"], ["Carol", 200], ["Dave", 150]
    expect(m["0:4"]).toEqual({ kind: "string", value: "Rep" });
    expect(m["0:5"]).toEqual({ kind: "string", value: "Sales" });
    expect(m["1:4"]).toEqual({ kind: "string", value: "Carol" });
    expect(m["1:5"]).toEqual({ kind: "number", value: 200 });
    expect(m["2:4"]).toEqual({ kind: "string", value: "Dave" });
    expect(m["2:5"]).toEqual({ kind: "number", value: 150 });

    // Q2 at H1:K4 -> East (320, 160, 2), West (230, 115, 2), North (50, 50, 1)
    expect(m["0:7"]).toEqual({ kind: "string", value: "Region" });
    expect(m["1:7"]).toEqual({ kind: "string", value: "East" });
    expect(m["1:8"]).toEqual({ kind: "number", value: 320 });
    expect(m["1:9"]).toEqual({ kind: "number", value: 160 });
    expect(m["1:10"]).toEqual({ kind: "number", value: 2 });
    expect(m["2:7"]).toEqual({ kind: "string", value: "West" });
    expect(m["2:8"]).toEqual({ kind: "number", value: 230 });
    expect(m["3:7"]).toEqual({ kind: "string", value: "North" });
    expect(m["3:8"]).toEqual({ kind: "number", value: 50 });

    // Q3 at A8:A9 -> Bob (80), Dave (150)
    expect(m["7:0"]).toEqual({ kind: "string", value: "Bob" });
    expect(m["8:0"]).toEqual({ kind: "string", value: "Dave" });

    // Q4 at D8 -> scalar 320
    expect(m["7:3"]).toEqual({ kind: "number", value: 320 });

    // Q5 & Q6 errors
    expect(m["7:4"]).toEqual({ kind: "error", value: "#N/A", error: "#N/A" });
    expect(m["7:5"]).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });
  });

  it("evaluates IMAGE with URL scheme allowlist, alt text, string coercion, and XSS rejection", () => {
    expect(isSafeSheetImageUrl("https://example.com/pic.png")).toBe(true);
    expect(isSafeSheetImageUrl("http://localhost:3000/a.jpg")).toBe(true);
    expect(isSafeSheetImageUrl("/api/files/42")).toBe(true);
    expect(isSafeSheetImageUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isSafeSheetImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeSheetImageUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isSafeSheetImageUrl("//evil.example/x.png")).toBe(false);
    expect(isSafeSheetImageUrl("/api/files/../secret")).toBe(false);

    const ws = makeSheet(1, "Img", [
      [0, 0, '=IMAGE("https://example.com/logo.png", "Company Logo", 1)'],
      [0, 1, '=IMAGE("/api/files/123")'],
      [0, 2, '=IMAGE("data:image/png;base64,iVBORw0KGgo=", "Pixel", 2)'],
      [0, 3, '=IMAGE("javascript:alert(1)", "Evil")'],
      [0, 4, '="Img: " & A1'],
      [0, 5, '=LEN(A1)'],
      [0, 6, '=A1 + 1'], // image in numeric context -> #VALUE!
    ]);
    const m = calculateWorkbook([ws]).get(1)!;
    expect(m["0:0"]).toEqual({
      kind: "image",
      value: "Company Logo",
      url: "https://example.com/logo.png",
      alt: "Company Logo",
      mode: 1,
    });
    expect(m["0:1"]).toEqual({
      kind: "image",
      value: "/api/files/123",
      url: "/api/files/123",
      mode: 1,
    });
    expect(m["0:2"]).toMatchObject({
      kind: "image",
      url: "data:image/png;base64,iVBORw0KGgo=",
      alt: "Pixel",
      mode: 2,
    });
    expect(m["0:3"]).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });
    expect(m["0:4"]).toEqual({ kind: "string", value: "Img: Company Logo" });
    expect(m["0:5"]).toEqual({ kind: "number", value: 12 });
    expect(m["0:6"]).toEqual({ kind: "error", value: "#VALUE!", error: "#VALUE!" });
    expect(formatCellDisplay('=IMAGE("https://example.com/logo.png","Company Logo")', m["0:0"])).toBe("Company Logo");
  });

  it("covers modern formula edge branches across regex, LET, LAMBDA, ARRAYFORMULA, QUERY, IMAGE, and AST invoke", () => {
    // AST postfix invoke error & max depth branches
    expect(parseFormulaAst("=LAMBDA(x, x)(1+)")).toBeNull();
    expect(parseFormulaAst("=(1)(")).toBeNull();
    expect(parseFormulaAst("=F()" + "()".repeat(65))).toBeNull();

    // isSafeSheetImageUrl edge cases
    expect(isSafeSheetImageUrl("")).toBe(false);
    expect(isSafeSheetImageUrl("https://example.com/" + "a".repeat(4100))).toBe(false);
    expect(isSafeSheetImageUrl("https://example.com/a\nb.png")).toBe(false);
    expect(isSafeSheetImageUrl("http://[invalid")).toBe(false);
    expect(isSafeSheetImageUrl("/api/drive/files/42?v=1")).toBe(true);
    expect(toBoolean(imgVal("https://example.com/a.png"))).toEqual(errVal("#VALUE!"));

    const ws = makeSheet(
      1,
      "ModernEdge",
      [
        // Table at A1:B2 for QUERY
        [0, 0, "Name"], [0, 1, "Val"],
        [1, 0, "A"], [1, 1, "10"],

        // Regex arity, error propagation, ReDoS nested parens, unmatched ')', length limit, alternate/optional capture groups
        [2, 0, '=REGEXMATCH("a")'],
        [2, 1, '=REGEXMATCH(1/0, "a")'],
        [2, 2, '=REGEXMATCH("a", 1/0)'],
        [2, 3, '=REGEXMATCH("a", ")")'],
        [2, 4, '=REGEXMATCH("a", "((a)+)+")'],
        [2, 5, '=REGEXMATCH("a", "((a+))+")'],
        [2, 6, '=REGEXMATCH("a", "((a+))")'],
        [2, 7, '=REGEXMATCH("a", REPT("a", 513))'],
        [3, 0, '=REGEXREPLACE("a", "b")'],
        [3, 1, '=REGEXREPLACE(1/0, "a", "b")'],
        [3, 2, '=REGEXREPLACE("a", 1/0, "b")'],
        [3, 3, '=REGEXREPLACE("a", "b", 1/0)'],
        [3, 4, '=REGEXEXTRACT("a")'],
        [3, 5, '=REGEXEXTRACT(1/0, "a")'],
        [3, 6, '=REGEXEXTRACT("a", 1/0)'],
        [3, 7, '=REGEXEXTRACT("bar", "(foo)|(bar)")'],
        [3, 8, '=REGEXEXTRACT("baz", "(foo)?(bar)?baz")'],

        // LAMBDA & LET edge cases: missing args, non-lambda invoke, error-bound call, unwrapScalar on lambda, bad params
        [4, 0, "=LAMBDA()"],
        [4, 1, "=LAMBDA(123, 1)"],
        [4, 2, "=LAMBDA(x, )"],
        [4, 3, "=LAMBDA(x, y, x+y)(1,)"],
        [4, 4, "=(1)(2)"],
        [4, 5, "=LET(bad, 1/0, bad(5))"],
        [4, 6, "=LEN(LAMBDA(x, x))"],
        [4, 7, '={50, "bad"}%'], // percent on array (number + non-number)

        // ARRAYFORMULA edge cases: wrong arity, scalar lift, missing arg lift, empty/ragged array lift
        [5, 0, "=ARRAYFORMULA()"],
        [5, 1, "=ARRAYFORMULA(1, 2)"],
        [5, 2, "=ARRAYFORMULA(ABS(-5))"],
        [5, 3, '=ARRAYFORMULA(LEFT("hello",))'],
        [5, 4, '=ARRAYFORMULA(LEFT({"abc";"def"},))'],
        [5, 5, "=ARRAYFORMULA(ABS(EMPTY_ARR()))"],
        [5, 6, "=ARRAYFORMULA(ABS(ONE_EMPTY_ROW()))"],
        [5, 7, "=ARRAYFORMULA(LET(x, {2,3}, x*10))"],

        // IF / IFERROR / IFNA in arrayMode edge cases
        [7, 0, "=ARRAYFORMULA(IF(EMPTY_ARR(), 1, 2))"],
        [7, 1, "=ARRAYFORMULA(IF(RAGGED_BOOL2(), 1, 2))"],
        [7, 3, "=ARRAYFORMULA(IF({FALSE;FALSE}, 1, 2))"],
        [7, 5, "=ARRAYFORMULA(IF({TRUE;TRUE}, 1, 2))"],
        [7, 7, "=ARRAYFORMULA(IF({TRUE;FALSE}, 1))"],
        [7, 8, "=ARRAYFORMULA(IF({TRUE;FALSE}, 1,))"],
        [7, 9, "=ARRAYFORMULA(IF({TRUE;FALSE}, {10;20}, {30;40}))"],
        [9, 0, "=ARRAYFORMULA(IF({TRUE;FALSE}, EMPTY_ARR(), EMPTY_ARR()))"],
        [9, 2, '=ARRAYFORMULA(IF({"notbool";TRUE}, 1, 2))'],
        [11, 0, "=ARRAYFORMULA(IFERROR({1,2}, 0))"],
        [11, 3, "=ARRAYFORMULA(IFERROR({1/0, 2}, {99, 88}))"],
        [11, 6, "=ARRAYFORMULA(IFERROR({1/0, 2}, EMPTY_ARR()))"],
        [12, 0, "=ARRAYFORMULA(IFNA({1, 2}, 0))"],
        [12, 3, "=ARRAYFORMULA(IFNA({#N/A, #DIV/0!}, 99))"],
        [12, 6, "=ARRAYFORMULA(IFNA({#N/A, 2}, {77, 88}))"],
        [12, 9, "=ARRAYFORMULA(IFNA({#N/A, 2}, EMPTY_ARR()))"],

        // QUERY edge branches in formula-functions.ts
        [14, 0, "=QUERY()"],
        [14, 1, '=QUERY(A1:B2, "SELECT *", 1, 2)'],
        [14, 2, '=QUERY(Missing!A1:B2, "SELECT *")'],
        [14, 3, "=QUERY(A1:B2)"],
        [14, 6, "=QUERY(A1:B2,)"],
        [14, 9, "=QUERY(A1:B2, 1/0)"],
        [14, 10, '=QUERY(A1:B2, "SELECT *", "bad")'],
        [16, 0, '=QUERY({1,2;3,4}, "SELECT Col1")'],

        // IMAGE edge branches in formula-functions.ts
        [18, 0, "=IMAGE()"],
        [18, 1, '=IMAGE("https://example.com/a.png", "a", 1, 10, 10, 10)'],
        [18, 2, "=IMAGE(1/0)"],
        [18, 3, '=IMAGE("https://example.com/a.png", 1/0)'],
        [18, 4, '=IMAGE("https://example.com/a.png", 3)'],
        [18, 5, '=IMAGE("https://example.com/a.png", 5)'],
        [18, 6, '=IMAGE("https://example.com/a.png", -1)'],
        [18, 7, '=IMAGE("https://example.com/a.png", 123, 2)'],
        [18, 8, '=IMAGE("https://example.com/a.png", "alt", "bad")'],
        [18, 9, '=IMAGE("https://example.com/a.png", "alt", 9)'],
        [18, 10, '=IMAGE("https://example.com/a.png", "alt", -1)'],
        [19, 0, '=IF(IMAGE("https://example.com/a.png"), 1, 2)'],
      ],
      25,
      12,
    );

    const engine = new IncrementalFormulaEngine();
    const m = engine.loadSheets([ws], {
      customFunctions: {
        EMPTY_ARR: () => arrVal([]),
        ONE_EMPTY_ROW: () => arrVal([[]]),
        RAGGED_BOOL2: () => arrVal([[boolVal(true), boolVal(false)], [boolVal(true)]]),
      },
    }).get(1)!;

    expect(m["2:0"]).toEqual(errVal("#VALUE!"));
    expect(m["2:1"]).toEqual(errVal("#DIV/0!"));
    expect(m["2:2"]).toEqual(errVal("#DIV/0!"));
    expect(m["2:3"]).toEqual(errVal("#VALUE!"));
    expect(m["2:4"]).toEqual(errVal("#VALUE!"));
    expect(m["2:5"]).toEqual(errVal("#VALUE!"));
    expect(m["2:6"]).toEqual(boolVal(true));
    expect(m["2:7"]).toEqual(errVal("#VALUE!"));
    expect(m["3:0"]).toEqual(errVal("#VALUE!"));
    expect(m["3:1"]).toEqual(errVal("#DIV/0!"));
    expect(m["3:2"]).toEqual(errVal("#DIV/0!"));
    expect(m["3:3"]).toEqual(errVal("#DIV/0!"));
    expect(m["3:4"]).toEqual(errVal("#VALUE!"));
    expect(m["3:5"]).toEqual(errVal("#DIV/0!"));
    expect(m["3:6"]).toEqual(errVal("#DIV/0!"));
    expect(m["3:7"]).toEqual(strVal("bar"));
    expect(m["3:8"]).toEqual(strVal(""));

    expect(m["4:0"]).toEqual(errVal("#VALUE!"));
    expect(m["4:1"]).toEqual(errVal("#VALUE!"));
    expect(m["4:2"]).toEqual(errVal("#VALUE!"));
    expect(m["4:3"]).toEqual(errVal("#VALUE!"));
    expect(m["4:4"]).toEqual(errVal("#VALUE!"));
    expect(m["4:5"]).toEqual(errVal("#DIV/0!"));
    expect(m["4:6"]).toEqual(errVal("#CALC!"));
    expect(m["4:7"]).toEqual(numVal(0.5));
    expect(m["4:8"]).toEqual(errVal("#VALUE!"));

    expect(m["5:0"]).toEqual(errVal("#VALUE!"));
    expect(m["5:1"]).toEqual(errVal("#VALUE!"));
    expect(m["5:2"]).toEqual(numVal(5));
    expect(m["5:3"]).toEqual(strVal("h"));
    expect(m["5:4"]).toEqual(strVal("a"));
    expect(m["6:4"]).toEqual(strVal("d"));
    expect(m["5:5"]).toEqual(errVal("#N/A"));
    expect(m["5:6"]).toEqual(errVal("#N/A"));
    expect(m["5:7"]).toEqual(numVal(20));
    expect(m["5:8"]).toEqual(numVal(30));

    expect(m["7:0"]).toEqual(EMPTY_VAL);
    expect(m["7:1"]).toEqual(numVal(1));
    expect(m["7:2"]).toEqual(numVal(2));
    expect(m["8:2"]).toEqual(numVal(2));
    expect(m["7:3"]).toEqual(numVal(2));
    expect(m["7:5"]).toEqual(numVal(1));
    expect(m["8:7"]).toEqual(boolVal(false));
    expect(m["8:8"]).toEqual(boolVal(false));
    expect(m["7:9"]).toEqual(numVal(10));
    expect(m["8:9"]).toEqual(numVal(40));
    expect(m["9:0"]).toEqual(EMPTY_VAL);
    expect(m["10:0"]).toEqual(boolVal(false));
    expect(m["9:2"]).toEqual(errVal("#VALUE!"));
    expect(m["10:2"]).toEqual(numVal(1));

    expect(m["11:0"]).toEqual(numVal(1));
    expect(m["11:3"]).toEqual(numVal(99));
    expect(m["11:6"]).toEqual(EMPTY_VAL);
    expect(m["12:0"]).toEqual(numVal(1));
    expect(m["12:3"]).toEqual(numVal(99));
    expect(m["12:4"]).toEqual(errVal("#DIV/0!"));
    expect(m["12:6"]).toEqual(numVal(77));
    expect(m["12:9"]).toEqual(EMPTY_VAL);

    expect(m["14:0"]).toEqual(errVal("#VALUE!"));
    expect(m["14:1"]).toEqual(errVal("#VALUE!"));
    expect(m["14:2"]).toEqual(errVal("#REF!"));
    expect(m["14:3"]).toEqual(strVal("Name"));
    expect(m["14:6"]).toEqual(strVal("Name"));
    expect(m["14:9"]).toEqual(errVal("#DIV/0!"));
    expect(m["14:10"]).toEqual(errVal("#VALUE!"));
    expect(m["16:0"]).toEqual(numVal(1));
    expect(m["17:0"]).toEqual(numVal(3));

    expect(m["18:0"]).toEqual(errVal("#VALUE!"));
    expect(m["18:1"]).toEqual(errVal("#VALUE!"));
    expect(m["18:2"]).toEqual(errVal("#DIV/0!"));
    expect(m["18:3"]).toEqual(errVal("#DIV/0!"));
    expect(m["18:4"]).toMatchObject({ kind: "image", mode: 3 });
    expect(m["18:5"]).toEqual(errVal("#VALUE!"));
    expect(m["18:6"]).toEqual(errVal("#VALUE!"));
    expect(m["18:7"]).toMatchObject({ kind: "image", alt: "123", mode: 2 });
    expect(m["18:8"]).toEqual(errVal("#VALUE!"));
    expect(m["18:9"]).toEqual(errVal("#VALUE!"));
    expect(m["18:10"]).toEqual(errVal("#VALUE!"));
    expect(m["19:0"]).toEqual(errVal("#VALUE!"));

    // Direct BUILTIN_FUNCTIONS tests for optional ctx fallbacks (no getEnv / evalAstWithEnv) and blank/missing AST nodes
    const minCtx: FormulaEvalContext = {
      sheetId: 1,
      row: 0,
      col: 0,
      evalAst: (node) => (node.kind === "number" ? numVal(node.value) : EMPTY_VAL),
      resolveRange: () => null,
      resolveCellRef: () => null,
      readCell: () => EMPTY_VAL,
      readRawCell: () => "",
      readMatrix: () => [],
      parseAndResolveRef: () => null,
      sheetBounds: () => null,
      tickOp: () => true,
    };
    expect(
      BUILTIN_FUNCTIONS.LET(
        [{ kind: "name", name: "x" }, { kind: "number", value: 1 }, { kind: "number", value: 42 }],
        minCtx,
      ),
    ).toEqual(numVal(42));
    expect(
      BUILTIN_FUNCTIONS.LAMBDA(
        [{ kind: "name", name: "   " }, { kind: "number", value: 1 }],
        minCtx,
      ),
    ).toEqual(errVal("#VALUE!"));
    expect(
      BUILTIN_FUNCTIONS.LAMBDA([{ kind: "number", value: 7 }], minCtx).kind,
    ).toBe("lambda" as unknown as EvalValue["kind"]);
    expect(
      BUILTIN_FUNCTIONS.ARRAYFORMULA([{ kind: "error", code: "__MISSING__" }], minCtx),
    ).toEqual(errVal("#VALUE!"));
    expect(
      BUILTIN_FUNCTIONS.ARRAYFORMULA([{ kind: "number", value: 9 }], minCtx),
    ).toEqual(numVal(9));
  });

  it("covers MAX_DEPTH and MAX_OPS #LIMIT! guards in LAMBDA invocation, lifted ARRAYFORMULA, and array IF", () => {
    // 1. invokeLambdaClosure depth > MAX_DEPTH via 64-cell chain ending in LET(f, LAMBDA(x, x), f(1))
    const depthCells: [number, number, string][] = [];
    for (let r = 0; r < 63; r++) {
      depthCells.push([r, 0, `=A${r + 2}`]);
    }
    depthCells.push([63, 0, "=LET(f, LAMBDA(x, x), f(1))"]);
    const depthWs = makeSheet(1, "DepthLam", depthCells, 66, 2);
    const depthEngine = new IncrementalFormulaEngine();
    const depthRes = depthEngine.loadSheets([depthWs]).get(1)!;
    // #LIMIT! is intentionally left uncached during loadSheets
    expect(depthRes["0:0"]).toBeUndefined();

    // 2. invokeLambdaClosure ++budget.ops > MAX_OPS right at closure invocation boundary
    const opsLamWs = makeSheet(
      1,
      "OpsLam",
      [[10000, 0, "=LET(a, SUM(A1:J9999), b, 1+1+1+1+1+1+1+1, LAMBDA(n, n))(1)"]],
      10002,
      10,
    );
    const opsLamEngine = new IncrementalFormulaEngine();
    const opsLamRes = opsLamEngine.loadSheets([opsLamWs]).get(1)!;
    expect(opsLamRes["10000:0"]).toBeUndefined();

    // 3. ARRAYFORMULA lifted builtin & array IF #LIMIT! budget exhaustion
    const bigArrWs = makeSheet(
      1,
      "BigArr",
      [
        [5502, 0, "=ARRAYFORMULA(ABS(A1:T5500))"],
        [5503, 0, "=ARRAYFORMULA(IF(A1:T5500>0, 1, 0))"],
      ],
      5505,
      20,
    );
    const bigArrEngine = new IncrementalFormulaEngine();
    bigArrEngine.loadSheets([bigArrWs]);
    expect(bigArrEngine.getValue(1, 5502, 0)).toEqual(errVal("#LIMIT!"));
    expect(bigArrEngine.getValue(1, 5503, 0)).toEqual(errVal("#LIMIT!"));
  });
});

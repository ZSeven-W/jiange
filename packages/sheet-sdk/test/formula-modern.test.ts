import { describe, expect, it } from "vitest";
import { calculateWorkbook, IncrementalFormulaEngine } from "../src/formula-engine.js";
import { isSafeSheetImageUrl, SUPPORTED_FORMULA_FUNCTIONS } from "../src/formula-functions.js";
import { formatCellDisplay } from "../src/numfmt.js";
import type { SheetWorksheet } from "../src/types.js";

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
});

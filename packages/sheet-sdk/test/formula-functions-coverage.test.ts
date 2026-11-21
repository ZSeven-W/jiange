import { describe, expect, it } from "vitest";
import { IncrementalFormulaEngine } from "../src/formula-engine.js";
import {
  arrVal,
  boolVal,
  compareValues,
  EMPTY_VAL,
  errVal,
  matchCriteria,
  numVal,
  strVal,
  toBoolean,
  toNumber,
  toStringValue,
  unwrapScalar,
} from "../src/formula-functions.js";
import type { SheetWorksheet } from "../src/types.js";

function runFormulas(
  cells: [number, number, string][],
  rows = 30,
  cols = 15,
) {
  const rowAxes = Array.from({ length: rows }, (_, i) => ({ id: i + 1, pos: i }));
  const colAxes = Array.from({ length: cols }, (_, i) => ({ id: i + 1, pos: i }));
  const ws: SheetWorksheet = {
    id: 1,
    nodeId: 1,
    title: "F",
    pos: 0,
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    filter: {},
    revision: 1,
    rows: rowAxes,
    columns: colAxes,
    cells: cells.map(([r, c, raw]) => ({ rowId: rowAxes[r].id, columnId: colAxes[c].id, raw, revision: 1 })),
  };
  const engine = new IncrementalFormulaEngine();
  const map = engine.loadSheets([ws], {
    customFunctions: {
      INF_FN: () => ({ kind: "number", value: Number.POSITIVE_INFINITY }),
      EMPTY_ARR: () => arrVal([]),
      ONE_EMPTY_ROW: () => arrVal([[]]),
      RAGGED_TBL: () => arrVal([[numVal(1), numVal(10)], [numVal(3)]]),
      RAGGED_COL: () => arrVal([[numVal(1)], []]),
      RAGGED_BOOL: () => arrVal([[boolVal(true)], []]),
      ERR_ARR: () => arrVal([[numVal(1), errVal("#DIV/0!")]]),
      EMPTY_CELL_ARR: () => arrVal([[EMPTY_VAL, numVal(2)]]),
    },
  }).get(1)!;
  return { engine, map };
}

describe("formula-functions 100% branch coverage", () => {
  it("covers scalar coercions, unwrapScalar, compareValues, wildcardToRegex, and matchCriteria", () => {
    expect(numVal(Number.POSITIVE_INFINITY)).toEqual(errVal("#NUM!"));
    expect(unwrapScalar(arrVal([[numVal(5)]]))).toEqual(numVal(5));
    expect(unwrapScalar(arrVal([[]]))).toEqual(EMPTY_VAL);

    expect(toNumber(EMPTY_VAL)).toBe(0);
    expect(toNumber(boolVal(true))).toBe(1);
    expect(toNumber(boolVal(false))).toBe(0);
    expect(toNumber(strVal("   "))).toBe(0);
    expect(toNumber(strVal("42.5"))).toBe(42.5);
    expect(toNumber(strVal("2024-03-15"))).toBeGreaterThan(45000);
    expect(toNumber(strVal("nope"))).toEqual(errVal("#VALUE!"));

    expect(toBoolean(EMPTY_VAL)).toBe(false);
    expect(toBoolean(numVal(0))).toBe(false);
    expect(toBoolean(numVal(3))).toBe(true);
    expect(toBoolean(strVal("true"))).toBe(true);
    expect(toBoolean(strVal("FALSE"))).toBe(false);
    expect(toBoolean(strVal("other"))).toEqual(errVal("#VALUE!"));

    expect(toStringValue(EMPTY_VAL)).toBe("");
    expect(toStringValue(boolVal(true))).toBe("TRUE");
    expect(toStringValue(boolVal(false))).toBe("FALSE");
    expect(toStringValue(errVal("#N/A"))).toBe("#N/A");

    expect(compareValues(EMPTY_VAL, EMPTY_VAL)).toBe(0);
    expect(compareValues(EMPTY_VAL, numVal(5))).toBe(-1);
    expect(compareValues(EMPTY_VAL, boolVal(true))).toBe(-1);
    expect(compareValues(EMPTY_VAL, strVal("a"))).toBeLessThan(0);
    expect(compareValues(numVal(5), EMPTY_VAL)).toBe(1);
    expect(compareValues(boolVal(false), EMPTY_VAL)).toBe(1);
    expect(compareValues(strVal("a"), EMPTY_VAL)).toBeGreaterThan(0);
    expect(compareValues(boolVal(false), boolVal(true))).toBe(-1);

    // matchCriteria: errors, empty criteria, empty rhs (=, <>, >), numeric ops, wildcards (~, ?, trailing ~), string ops
    expect(matchCriteria(errVal("#N/A"), numVal(1))).toBe(false);
    expect(matchCriteria(numVal(1), errVal("#N/A"))).toBe(false);
    expect(matchCriteria(EMPTY_VAL, EMPTY_VAL)).toBe(true);
    expect(matchCriteria(numVal(1), EMPTY_VAL)).toBe(false);

    expect(matchCriteria(EMPTY_VAL, strVal("="))).toBe(true);
    expect(matchCriteria(strVal(""), strVal("="))).toBe(true);
    expect(matchCriteria(strVal("x"), strVal("<>"))).toBe(true);
    expect(matchCriteria(strVal("x"), strVal(">"))).toBe(false);

    expect(matchCriteria(numVal(5), strVal(">=5"))).toBe(true);
    expect(matchCriteria(numVal(5), strVal("<=5"))).toBe(true);
    expect(matchCriteria(numVal(5), strVal("<>6"))).toBe(true);
    expect(matchCriteria(numVal(5), strVal(">4"))).toBe(true);
    expect(matchCriteria(numVal(5), strVal("<6"))).toBe(true);
    expect(matchCriteria(numVal(5), strVal("=5"))).toBe(true);

    expect(matchCriteria(strVal("a*b"), strVal("=a~*?"))).toBe(true);
    expect(matchCriteria(strVal("ax"), strVal("<>a?"))).toBe(false);
    expect(matchCriteria(strVal("a~"), strVal("=a~"))).toBe(true);
    expect(matchCriteria(strVal("cat"), strVal("c?t"))).toBe(true);

    expect(matchCriteria(strVal("beta"), strVal(">=alpha"))).toBe(true);
    expect(matchCriteria(strVal("alpha"), strVal("<=beta"))).toBe(true);
    expect(matchCriteria(strVal("alpha"), strVal("<>beta"))).toBe(true);
    expect(matchCriteria(strVal("beta"), strVal(">alpha"))).toBe(true);
    expect(matchCriteria(strVal("alpha"), strVal("<beta"))).toBe(true);
    expect(matchCriteria(strVal("alpha"), strVal("=ALPHA"))).toBe(true);
  });

  it("covers aggregations, conditional aggs, logic, math, text, and date edge branches", () => {
    const { map } = runFormulas([
      // Data helper cells in row 0
      [0, 0, "10"], // A1
      [0, 1, ""], // B1 (empty)
      [0, 2, '=""'], // C1 (empty string formula)
      [0, 3, "=1/0"], // D1 (error)
      [0, 4, "20"], // E1
      // collectValues & collectNumbers edge cases
      [1, 0, "=SUM(1,,2)"], // missing arg
      [1, 1, "=COUNTA(A1:C1)"], // nonempty over range
      [1, 2, "=SUM(SEQUENCE(2,1))"], // array result in numbers mode
      [1, 3, "=COUNTA(EMPTY_CELL_ARR())"], // array result in nonempty mode
      [1, 4, "=CONCAT(SEQUENCE(1,2))"], // array result in all mode
      [1, 5, "=SUM(ERR_ARR())"], // error inside array result
      [1, 6, '=SUM("bad")'], // non-numeric scalar in numbers mode
      [1, 7, "=SUM(INF_FN())"], // numVal(Infinity) -> non-number in collectNumbers map
      [1, 8, "=ABS()"], // evalNumArg missing without fallback
      [1, 9, "=LEN()"], // evalStrArg missing without fallback
      // evalConditionalAgg & evalSingleCondAgg edge cases
      [2, 0, '=SUMIFS(1/0,A1:A1,">0")'],
      [2, 1, '=COUNTIFS(1/0,">0")'],
      [2, 2, "=COUNTIFS(A1:A1,1/0)"],
      [2, 3, '=SUMIFS(EMPTY_ARR(),EMPTY_ARR(),">0")'],
      [2, 4, '=COUNTIFS(EMPTY_ARR(),">0")'],
      [2, 5, '=SUMIFS(A1:A2,A1:B2,">0")'],
      [2, 6, '=SUMIFS(D1:D1,A1:A1,">0")'],
      [2, 7, '=SUMIF(A1:A1,">0",E1:E1)'],
      [2, 8, '=SUMIF(A1:A1,">0",)'],
      // Stats / Percentile / Rounding / Basic aggs error propagation
      [3, 0, "=PERCENTILE({5},0.5)"],
      [3, 1, "=PERCENTILE({10,20,30},0.5)"],
      [3, 2, "=PERCENTILE({10,20,30},0.25)"],
      [3, 3, "=ROUNDUP(-2.1,0)"],
      [3, 4, "=AVERAGE(1/0)"],
      [3, 5, "=MIN(1/0)"],
      [3, 6, "=MAX(1/0)"],
      [3, 7, "=COUNT(1/0)"],
      [3, 8, "=COUNTA(1/0)"],
      [3, 9, "=COUNTBLANK(B1:C1)"],
      [3, 10, "=PRODUCT(B1:B1)"],
      [3, 11, "=AVERAGE(10,20)"],
      [3, 12, "=MIN(10,20)"],
      [3, 13, "=MAX(10,20)"],
      [3, 14, "=COUNT(10,20)"],
      [4, 0, '=PERCENTILE({1},"x")'],
      [4, 1, '=QUARTILE({1},"x")'],
      [4, 2, '=LARGE({1},"x")'],
      [4, 3, '=SMALL({1},"x")'],
      [4, 4, "=RANK(1,{1,2})"],
      [4, 5, '=RANK(1,{1,2},"x")'],
      [4, 6, "=SUMPRODUCT(EMPTY_ARR(),EMPTY_ARR())"],
      [4, 7, '=SUMPRODUCT({TRUE,FALSE,"txt"})'],
      // Logic & Math & Text & Date
      [5, 0, "=IF(FALSE,1)"],
      [5, 1, "=IF(FALSE,1,2)"],
      [5, 2, "=IFERROR(42,0)"],
      [5, 3, "=AND(TRUE,TRUE)"],
      [5, 4, "=OR(FALSE,FALSE)"],
      [5, 5, "=MROUND(-5,2)"],
      [5, 6, '=TEXTJOIN(",",TRUE,"a","","b")'],
      [5, 7, '=SEARCH("a?c","xyz")'],
      [5, 8, '=SEARCH("zzz","abc")'],
      [5, 13, '=SEARCH("bc","abc")'],
      [5, 9, '=SUBSTITUTE("a-b-a","a","x")'],
      [5, 10, '=VALUE("bad%")'],
      [5, 11, '=VALUE("2024-03-15")'],
      [5, 12, '=VALUE("nope")'],
      [6, 0, "=DATE(99,1,1)"],
      [6, 1, '=DATEDIF(DATE(2020,6,15),DATE(2024,3,10),"Y")'],
      [6, 2, '=DATEDIF(DATE(2020,6,15),DATE(2024,6,10),"Y")'],
      [6, 3, '=DATEDIF(DATE(2020,6,15),DATE(2024,6,10),"M")'],
      [6, 4, "=WEEKDAY(DATE(2024,3,17),2)"], // Sunday -> 7
      [6, 5, "=WEEKDAY(DATE(2024,3,17),3)"], // Sunday -> 6
      [6, 6, "=ISOWEEKNUM(DATE(2024,3,17))"], // Sunday -> dayNum=7
      [6, 7, "=WORKDAY(DATE(2024,1,1),1,1/0)"],
      [6, 8, "=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,5),1/0)"],
    ]);
    expect(map["1:0"]).toEqual(numVal(3));
    expect(map["1:1"]).toEqual(numVal(2));
    expect(map["1:2"]).toEqual(numVal(3));
    expect(map["1:3"]).toEqual(numVal(1));
    expect(map["1:4"]).toEqual(strVal("12"));
    expect(map["1:5"]).toEqual(errVal("#DIV/0!"));
    expect(map["1:8"]).toEqual(errVal("#VALUE!"));
    expect(map["1:9"]).toEqual(errVal("#VALUE!"));
    expect(map["2:6"]).toEqual(errVal("#DIV/0!"));
    expect(map["2:7"]).toEqual(numVal(20));
    expect(map["2:8"]).toEqual(numVal(10));
    expect(map["3:3"]).toEqual(numVal(-3));
    expect(map["3:9"]).toEqual(numVal(2));
    expect(map["3:10"]).toEqual(numVal(0));
    expect(map["5:0"]).toEqual(boolVal(false));
    expect(map["5:2"]).toEqual(numVal(42));
    expect(map["5:3"]).toEqual(boolVal(true));
    expect(map["5:4"]).toEqual(boolVal(false));
    expect(map["5:5"]).toEqual(errVal("#NUM!"));
    expect(map["5:6"]).toEqual(strVal("a,b"));
    expect(map["5:9"]).toEqual(strVal("x-b-x"));
    expect(map["6:1"]).toEqual(numVal(3));
    expect(map["6:2"]).toEqual(numVal(3));
    expect(map["6:3"]).toEqual(numVal(47));
    expect(map["6:4"]).toEqual(numVal(7));
    expect(map["6:5"]).toEqual(numVal(6));
  });

  it("covers lookup, reference, financial, and dynamic array edge branches", () => {
    const { map } = runFormulas([
      // Reference data in rows 0-1
      [0, 0, "10"], [0, 1, "20"], [0, 2, ""], [0, 3, "=1/0"],
      [1, 0, "30"], [1, 1, "40"],
      // VLOOKUP
      [3, 0, "=VLOOKUP(1,EMPTY_ARR(),1)"],
      [3, 1, "=VLOOKUP(1,{1,2;3,4},2)"], // default approx=true
      [3, 2, "=VLOOKUP(3,RAGGED_TBL(),2,FALSE)"], // table[r][ci] ?? EMPTY_VAL
      [3, 3, "=VLOOKUP(3,RAGGED_TBL(),2,TRUE)"], // table[bestRow][ci] ?? EMPTY_VAL
      [3, 4, "=VLOOKUP(5,A1:A1,1,TRUE)"], // bestRow < 0 -> #N/A
      [3, 5, "=VLOOKUP(5,C1:D1,1,TRUE)"], // empty & error skipped
      // HLOOKUP
      [4, 0, "=HLOOKUP(1,{1,2;3,4},2)"], // default approx=true
      [4, 1, "=HLOOKUP(3,TRANSPOSE(RAGGED_TBL()),2,FALSE)"], // exact on 2nd col
      [4, 2, "=HLOOKUP(2,RAGGED_TBL(),2,FALSE)"], // wait: let's use custom 2-row ragged with topRow [1,2], row2 [10]
      [4, 3, "=HLOOKUP(5,A1:D1,1,TRUE)"], // skips empty & error -> bestCol < 0 (#N/A)
      [4, 4, "=HLOOKUP(50,C1:D1,1,TRUE)"], // empty & error in topRow -> #N/A
      // XLOOKUP
      [5, 0, "=XLOOKUP(1,EMPTY_ARR(),EMPTY_ARR())"],
      [5, 1, "=XLOOKUP(2,{1;2;3},{10;20;30},,-1)"], // matchMode=-1 exact hit (cmp===0)
      [5, 2, "=XLOOKUP(25,{10;20;30},{1;2;3},,-1)"], // matchMode=-1 updates bestIdx twice
      [5, 3, "=XLOOKUP(99,{1;2},{10;20})"], // no 4th arg -> #N/A
      [5, 4, "=XLOOKUP(3,{1;2;3},{10})"], // !row -> #REF!
      [5, 5, "=XLOOKUP(1,{1;2},{10,11;20,21})"], // row.length > 1 -> arrVal([row])
      [5, 7, "=XLOOKUP(2,{1,2},{10,20})"], // horizontal 1-row -> scalar
      [5, 8, "=XLOOKUP(2,{1,2},RAGGED_TBL())"], // horizontal multi-row with ragged col -> arrVal + EMPTY_VAL
      // INDEX
      [7, 0, "=INDEX(EMPTY_ARR(),0,1)"],
      [7, 1, "=INDEX(RAGGED_TBL(),0,2)"], // ri===0 with ragged row -> EMPTY_VAL
      [7, 2, "=INDEX(RAGGED_COL(),2,0)"], // ci===0, mat[0].length===1, missing item -> EMPTY_VAL
      [7, 3, "=INDEX({10,20,30},1,0)"], // mat.length===1, ci===0
      [7, 4, "=INDEX(ONE_EMPTY_ROW(),1,0)"], // mat.length===1, mat[0][0] undefined -> #REF!
      [7, 5, "=INDEX(RAGGED_TBL(),2,2)"], // mat[ri-1]?.[ci-1] undefined -> #REF!
      // MATCH
      [8, 0, "=MATCH(5,C1:D1,1)"], // empty & error skipped -> best < 0 (#N/A)
      // ROW / COLUMN / ROWS / COLUMNS / OFFSET / INDIRECT / TRANSPOSE
      [8, 1, "=ROW(Missing!A1:B2)"],
      [8, 2, "=COLUMN(Missing!A1:B2)"],
      [8, 3, "=ROWS(Missing!A1:B2)"],
      [8, 4, "=COLUMNS(EMPTY_ARR())"],
      [8, 5, "=COLUMNS(Missing!A1:B2)"],
      [8, 6, "=OFFSET(A1,1)"], // < 3 args -> #VALUE!
      [8, 7, "=OFFSET(Missing!A1:B2,0,0)"], // invalid baseRange -> #VALUE!
      [8, 8, "=OFFSET(A1:B2,0,0)"], // range base + multi-cell array return!
      [10, 0, '=INDIRECT("A1:A1")'], // 1x1 range -> scalar
      [10, 1, "=TRANSPOSE(1/0)"],
      [10, 2, "=TRANSPOSE(EMPTY_ARR())"],
      // Financial
      [11, 0, "=PV(0.1,5,-100,0,1)"],
      [11, 1, "=FV(0.1,5,-100,0,1)"],
      [11, 2, "=IRR({-100,110},-1)"], // denom === 0
      [11, 3, "=IRR({-100,10},-0.5)"], // rate <= -1
      [11, 4, "=IRR({10,-20,10.001},0.5)"], // max iterations
      [11, 5, "=NPER(0.1,-1,100)"], // num/den <= 0
      [11, 6, "=RATE(1,0,0,10)"], // df ~ 0
      [11, 7, "=RATE(2,0,1,10)"], // max iterations
      // Dynamic arrays: FILTER, SORT, SORTBY
      [12, 0, "=FILTER({1;2},RAGGED_BOOL())"], // include[r][0] ?? EMPTY_VAL
      [12, 1, '=FILTER({1;2},{"bad";"bad"})'], // non-boolean row include
      [12, 2, '=FILTER({1,2;3,4},{"bad",TRUE})'], // non-boolean col include
      [12, 3, "=FILTER(EMPTY_ARR(),{TRUE})"], // data[0]?.length ?? 0 + mismatch -> #VALUE!
      [12, 4, "=FILTER({1;2},{TRUE;FALSE;TRUE})"], // dimension mismatch -> #VALUE!
      [12, 5, "=SORT(EMPTY_ARR(),1)"], // mat[0]?.length ?? 0
      [12, 6, "=SORTBY({1;2},RAGGED_COL(),-1)"], // by[i][0] ?? EMPTY_VAL + descending
    ]);
    // Also test HLOOKUP ragged exact & approx using a 2x2 ragged table where topRow=[1,2], row1=[10]
    const engineH = new IncrementalFormulaEngine();
    const wsH: SheetWorksheet = {
      id: 1,
      nodeId: 1,
      title: "H",
      pos: 0,
      frozenRows: 0,
      frozenCols: 0,
      merges: [],
      filter: {},
      revision: 1,
      rows: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, pos: i })),
      columns: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, pos: i })),
      cells: [
        { rowId: 1, columnId: 1, raw: "=HLOOKUP(2,RAGGED_H(),2,FALSE)", revision: 1 },
        { rowId: 1, columnId: 2, raw: "=HLOOKUP(2,RAGGED_H(),2,TRUE)", revision: 1 },
        { rowId: 1, columnId: 3, raw: "=VLOOKUP(5,EMPTY_ERR_COL(),1,TRUE)", revision: 1 },
      ],
    };
    const resH = engineH.loadSheets([wsH], {
      customFunctions: {
        RAGGED_H: () => arrVal([[numVal(1), numVal(2)], [numVal(10)]]),
        EMPTY_ERR_COL: () => arrVal([[EMPTY_VAL], [errVal("#DIV/0!")], [numVal(10)]]),
      },
    }).get(1)!;
    expect(resH["0:0"]).toEqual(EMPTY_VAL);
    expect(resH["0:1"]).toEqual(EMPTY_VAL);
    expect(resH["0:2"]).toEqual(errVal("#N/A"));

    expect(map["3:0"]).toEqual(errVal("#REF!"));
    expect(map["3:2"]).toEqual(EMPTY_VAL);
    expect(map["3:3"]).toEqual(EMPTY_VAL);
    expect(map["5:1"]).toEqual(numVal(20));
    expect(map["5:2"]).toEqual(numVal(2));
    expect(map["5:4"]).toEqual(errVal("#REF!"));
    expect(map["5:7"]).toEqual(numVal(20));
    expect(map["7:4"]).toEqual(errVal("#REF!"));
    expect(map["7:5"]).toEqual(errVal("#REF!"));
    expect(map["8:1"]).toEqual(errVal("#REF!"));
    expect(map["8:2"]).toEqual(errVal("#REF!"));
    expect(map["8:8"]).toEqual(numVal(10));
    expect(map["10:0"]).toEqual(numVal(10));
    expect(map["11:2"]).toEqual(errVal("#NUM!"));
    expect(map["11:3"]).toEqual(errVal("#NUM!"));
    expect(map["11:4"]).toEqual(errVal("#NUM!"));
    expect(map["11:5"]).toEqual(errVal("#NUM!"));
    expect(map["11:6"]).toEqual(errVal("#NUM!"));
    expect(map["11:7"]).toEqual(errVal("#NUM!"));
    expect(map["12:4"]).toEqual(errVal("#VALUE!"));
  });

  it("covers COUNTIFS #LIMIT! budget exhaustion via tickOp", () => {
    // 500x20 = 10,000 cells, read 20 times in COUNTIFS? Even better: 10,005x20 sheet -> readMatrix hits MAX_OPS at 200,001,
    // wait: to hit tickOp() INSIDE evalConditionalAgg loop (L281), readMatrix uses h*w ops, then loop uses h*w ops!
    // For h*w = 110,000 (e.g. 5500 x 20): readMatrix uses 110,000 ops (< 200,000), then loop ticks 90,001+ times -> hits L281!
    const rows = 5505;
    const cols = 20;
    const rowAxes = Array.from({ length: rows }, (_, i) => ({ id: i + 1, pos: i }));
    const colAxes = Array.from({ length: cols }, (_, i) => ({ id: i + 1, pos: i }));
    const ws: SheetWorksheet = {
      id: 1,
      nodeId: 1,
      title: "Big",
      pos: 0,
      frozenRows: 0,
      frozenCols: 0,
      merges: [],
      filter: {},
      revision: 1,
      rows: rowAxes,
      columns: colAxes,
      cells: [{ rowId: rowAxes[5502].id, columnId: colAxes[0].id, raw: '=COUNTIFS(A1:T5500,">0")', revision: 1 }],
    };
    const engine = new IncrementalFormulaEngine();
    engine.loadSheets([ws]);
    expect(engine.getValue(1, 5502, 0)).toEqual(errVal("#LIMIT!"));
  });
});

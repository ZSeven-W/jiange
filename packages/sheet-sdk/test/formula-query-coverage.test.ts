import { describe, expect, it } from "vitest";
import { arrVal, boolVal, EMPTY_VAL, errVal, numVal, strVal } from "../src/formula-functions.js";
import { evaluateQuery } from "../src/formula-query.js";
import type { EvalValue } from "../src/types.js";

const okTick = () => true;

const SAMPLE_TABLE: EvalValue[][] = [
  [strVal("Region"), strVal("Rep"), strVal("Sales"), strVal("Active"), strVal("Notes")],
  [strVal("East"), strVal("Alice"), numVal(120), boolVal(true), strVal("a'b")],
  [strVal("West"), strVal("Bob"), numVal(80), boolVal(false), EMPTY_VAL],
  [strVal("East"), strVal("Carol"), numVal(200), boolVal(true), strVal("")],
  [strVal("West"), strVal("Dave"), numVal(150), boolVal(false), strVal("vip_100%")],
  [strVal("North"), strVal("Eve"), numVal(50), boolVal(true), strVal("end.txt")],
];

describe("formula-query exhaustive coverage", () => {
  it("covers empty/whitespace queries, tokenization escapes, operators, aliases, OFFSET, and LABEL", () => {
    // Empty & whitespace query returns all rows
    expect(evaluateQuery(SAMPLE_TABLE, "", 0, 1, okTick)).toEqual(arrVal(SAMPLE_TABLE));
    expect(evaluateQuery(SAMPLE_TABLE, "   ", 0, 1, okTick)).toEqual(arrVal(SAMPLE_TABLE));

    // Escaped quotes: backslash escape & doubled quotes, plus double-quoted strings
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE E = 'a\\'b'", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Alice")]]));
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE E = 'a''b'", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Alice")]]));
    expect(
      evaluateQuery(SAMPLE_TABLE, 'SELECT B WHERE B = "Bob"', 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Bob")]]));

    // SELECT AS aliases (both string and identifier) + LABEL overrides + COUNT(*)
    expect(
      evaluateQuery(
        SAMPLE_TABLE,
        "SELECT A AS 'Area', COUNT(*) AS TotalRows, SUM(C) GROUP BY A ORDER BY A ASC LIMIT 2 OFFSET 1 LABEL SUM(C) 'Revenue'",
        0,
        1,
        okTick,
      ),
    ).toEqual(
      arrVal([
        [strVal("Area"), strVal("TotalRows"), strVal("Revenue")],
        [strVal("North"), numVal(1), numVal(50)],
        [strVal("West"), numVal(2), numVal(230)],
      ]),
    );

    // Default aggregate headers: COUNT(*) with no base header & MIN/MAX with header & empty header cell
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT COUNT(*), MIN(C), MAX(C)", 0, 1, okTick),
    ).toEqual(
      arrVal([
        [strVal("count"), strVal("min Sales"), strVal("max Sales")],
        [numVal(5), numVal(50), numVal(200)],
      ]),
    );

    // Multi-row header concatenation + ragged header row + blank header column for aggregate default label
    const multiHeader: EvalValue[][] = [
      [strVal("Q1"), EMPTY_VAL],
      [strVal("Amt")],
      [numVal(10), numVal(20)],
      [numVal(30), numVal(40)],
    ];
    expect(evaluateQuery(multiHeader, "SELECT SUM(A), SUM(B)", 0, 2, okTick)).toEqual(
      arrVal([
        [strVal("sum Q1 Amt"), strVal("sum")],
        [numVal(40), numVal(60)],
      ]),
    );

    // Non-zero startCol column letter resolution (startCol=2 => C is col 0, D is col 1; A is out of range)
    const twoCols: EvalValue[][] = [
      [strVal("X"), numVal(1)],
      [strVal("Y"), numVal(2)],
    ];
    expect(evaluateQuery(twoCols, "SELECT C, D WHERE D >= 2", 2, 0, okTick)).toEqual(
      arrVal([[strVal("Y"), numVal(2)]]),
    );
    expect(evaluateQuery(twoCols, "SELECT A", 2, 0, okTick)).toEqual(errVal("#VALUE!"));

    // Multi-column GROUP BY & LABEL on multiple targets + explicit ASC/DESC tie-breaking
    const tieTable: EvalValue[][] = [
      [strVal("East"), numVal(10)],
      [strVal("East"), numVal(10)],
      [strVal("West"), numVal(10)],
    ];
    expect(
      evaluateQuery(
        tieTable,
        "SELECT A, B ORDER BY B ASC, A DESC LABEL A 'Region', B 'Score'",
        0,
        0,
        okTick,
      ),
    ).toEqual(
      arrVal([
        [strVal("Region"), strVal("Score")],
        [strVal("West"), numVal(10)],
        [strVal("East"), numVal(10)],
        [strVal("East"), numVal(10)],
      ]),
    );

    // GROUP BY with multiple columns
    expect(
      evaluateQuery(tieTable, "SELECT A, B, COUNT(A) GROUP BY A, B ORDER BY A ASC", 0, 0, okTick),
    ).toEqual(
      arrVal([
        [strVal("East"), numVal(10), numVal(2)],
        [strVal("West"), numVal(10), numVal(1)],
      ]),
    );
  });

  it("covers all WHERE expressions: arithmetic, unary, parens, logic, IS NULL, string ops, LIKE, and comparisons", () => {
    // Arithmetic (+, -, *, /, unary +, unary -, parenthesized value expr) + boolean/null literals
    expect(
      evaluateQuery(
        SAMPLE_TABLE,
        "SELECT B WHERE (C + 20) * 2 - 40 / 2 >= 260 AND +C > 0 AND -C <= -120",
        0,
        1,
        okTick,
      ),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Alice")], [strVal("Carol")], [strVal("Dave")]]));

    // Boolean comparisons, OR, AND, NOT, parenthesized boolean expr
    expect(
      evaluateQuery(
        SAMPLE_TABLE,
        "SELECT B WHERE (D = TRUE AND C != 50) OR (NOT D = TRUE AND C <> 80)",
        0,
        1,
        okTick,
      ),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Alice")], [strVal("Carol")], [strVal("Dave")]]));
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE D = FALSE AND C <= 80", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Bob")]]));
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE C < 100 AND D >= FALSE", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Bob")], [strVal("Eve")]]));

    // IS NULL, IS NOT NULL, NULL literal comparison
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE E IS NULL", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Bob")], [strVal("Carol")]]));
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE E IS NOT NULL", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Alice")], [strVal("Dave")], [strVal("Eve")]]));
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE E = NULL", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Bob")], [strVal("Carol")]]));

    // String operators: CONTAINS, STARTS WITH, ENDS WITH, LIKE (%, _, regex metachar escaping), string < / > / != / <>
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE B CONTAINS 'ar'", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Carol")]]));
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE B STARTS WITH 'al'", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Alice")]]));
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE B ENDS WITH 've'", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Dave")], [strVal("Eve")]]));
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE E LIKE 'end.t_t' OR E LIKE 'vip%'", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Dave")], [strVal("Eve")]]));
    expect(
      evaluateQuery(SAMPLE_TABLE, "SELECT B WHERE B > 'Bob' AND B <= 'Dave' AND B <> 'Carol'", 0, 1, okTick),
    ).toEqual(arrVal([[strVal("Rep")], [strVal("Dave")]]));

    // scalarNum coercions (boolean true/false, numeric string, non-numeric string, empty) + div by zero + error cell
    const typedRows: EvalValue[][] = [
      [boolVal(true), strVal("10"), errVal("#DIV/0!"), arrVal([[strVal("nested")]]), arrVal([])],
      [boolVal(false), strVal("nope"), numVal(5), EMPTY_VAL, strVal("")],
      [EMPTY_VAL, strVal("  "), numVal(0), strVal("ok")], // ragged: missing col 4
    ];
    // +A tests scalarNum(bool true=1, false=0, empty=null->#VALUE! ignored in cmp)
    expect(evaluateQuery(typedRows, "SELECT A WHERE +A = 1", 0, 0, okTick)).toEqual(boolVal(true));
    expect(evaluateQuery(typedRows, "SELECT A WHERE +A = 0", 0, 0, okTick)).toEqual(boolVal(false));
    // B + 5 tests scalarNum(numeric string "10", non-numeric "nope", whitespace "  ")
    expect(evaluateQuery(typedRows, "SELECT B WHERE B + 5 = 15", 0, 0, okTick)).toEqual(strVal("10"));
    // Division by zero in WHERE produces error -> cmp returns false
    expect(evaluateQuery(typedRows, "SELECT C WHERE 10 / C = 2", 0, 0, okTick)).toEqual(numVal(5));
    // Error cell on left or right of cmp returns false
    expect(evaluateQuery(typedRows, "SELECT C WHERE C = 5 AND 1 / 0 = 1", 0, 0, okTick)).toEqual(errVal("#N/A"));
    // scalarText on error, array (non-empty and empty), boolean, empty, ragged column access
    expect(evaluateQuery(typedRows, "SELECT D WHERE D CONTAINS 'nest'", 0, 0, okTick)).toEqual(arrVal([[strVal("nested")]]));
    expect(evaluateQuery(typedRows, "SELECT C WHERE C CONTAINS 'DIV'", 0, 0, okTick)).toEqual(errVal("#N/A")); // error skipped in cmp
    expect(evaluateQuery(typedRows, "SELECT E WHERE E = ''", 0, 0, okTick)).toEqual(
      arrVal([[arrVal([])], [strVal("")], [EMPTY_VAL]]),
    );
    // scalarText on boolean & error inside header row
    const exoticHeader: EvalValue[][] = [
      [boolVal(true), boolVal(false), errVal("#REF!"), arrVal([[strVal("H")]]), arrVal([])],
      [numVal(1), numVal(2), numVal(3), numVal(4), numVal(5)],
    ];
    expect(evaluateQuery(exoticHeader, "SELECT *", 0, 1, okTick)).toEqual(
      arrVal([
        [strVal("TRUE"), strVal("FALSE"), strVal("#REF!"), strVal("H"), strVal("")],
        [numVal(1), numVal(2), numVal(3), numVal(4), numVal(5)],
      ]),
    );
  });

  it("covers cmpEval, aggregates (MIN/MAX/AVG/SUM/COUNT), ORDER BY variants, overflow, and ragged rows", () => {
    // Mixed values for cmpEval (empty, "", numbers, booleans, strings) & MIN/MAX skipping empty/""/error
    const mix: EvalValue[][] = [
      [EMPTY_VAL, strVal(""), errVal("#N/A"), boolVal(true)],
      [strVal(""), numVal(20), numVal(10), boolVal(false)],
      [numVal(5), numVal(10), numVal(30), boolVal(true)],
      [strVal("beta")], // ragged row missing cols 1..3
    ];
    // ORDER BY on column with empty, "", number, string -> covers ea&&eb, ea, eb, number/string cmp
    const sorted = evaluateQuery(mix, "SELECT A ORDER BY A ASC", 0, 0, okTick);
    expect(sorted.kind).toBe("array");
    // ORDER BY boolean column
    const sortedBool = evaluateQuery(mix, "SELECT D ORDER BY D ASC", 0, 0, okTick);
    expect(sortedBool.kind).toBe("array");

    // MIN, MAX, AVG, SUM, COUNT with ragged rows, errors, empty strings, and empty-only columns
    expect(evaluateQuery(mix, "SELECT MIN(C), MAX(C), AVG(C), COUNT(C)", 0, 0, okTick)).toEqual(
      arrVal([[numVal(10), numVal(30), numVal(20), numVal(3)]]),
    );
    // AVG, MIN, MAX over all-empty/non-numeric column -> EMPTY
    const allEmpty: EvalValue[][] = [[EMPTY_VAL], [strVal("")], [errVal("#N/A")]];
    expect(evaluateQuery(allEmpty, "SELECT AVG(A), MIN(A), MAX(A), COUNT(A)", 0, 0, okTick)).toEqual(
      arrVal([[EMPTY_VAL, EMPTY_VAL, EMPTY_VAL, numVal(1)]]),
    );

    // MIN/MAX descending/ascending updates on booleans and strings
    const minMaxBoolStr: EvalValue[][] = [
      [boolVal(true), strVal("b")],
      [boolVal(false), strVal("a")],
      [boolVal(true), strVal("c")],
    ];
    expect(evaluateQuery(minMaxBoolStr, "SELECT MIN(A), MAX(A), MIN(B), MAX(B)", 0, 0, okTick)).toEqual(
      arrVal([[boolVal(false), boolVal(true), strVal("a"), strVal("c")]]),
    );

    // Number overflow -> num() returns #NUM!
    const huge: EvalValue[][] = [[numVal(1e308)], [numVal(1e308)]];
    expect(evaluateQuery(huge, "SELECT SUM(A)", 0, 0, okTick)).toEqual(errVal("#NUM!"));

    // GROUP BY with ragged rows + ORDER BY column both in groupBy and not in groupBy
    const grpRagged: EvalValue[][] = [
      [strVal("A"), numVal(10)],
      [strVal("B"), numVal(20)],
      [], // ragged: col 0 is undefined -> EMPTY
    ];
    expect(
      evaluateQuery(grpRagged, "SELECT A, SUM(B) GROUP BY A ORDER BY A ASC", 0, 0, okTick),
    ).toEqual(
      arrVal([
        [EMPTY_VAL, numVal(0)],
        [strVal("A"), numVal(10)],
        [strVal("B"), numVal(20)],
      ]),
    );
    expect(
      evaluateQuery(grpRagged, "SELECT A, SUM(B) GROUP BY A ORDER BY B DESC", 0, 0, okTick),
    ).toEqual(
      arrVal([
        [strVal("A"), numVal(10)],
        [strVal("B"), numVal(20)],
        [EMPTY_VAL, numVal(0)],
      ]),
    );

    // Pure aggregate with ORDER BY agg and ORDER BY col (covers L692 both branches)
    expect(evaluateQuery(grpRagged, "SELECT SUM(B) ORDER BY SUM(B) DESC", 0, 0, okTick)).toEqual(numVal(30));
    expect(evaluateQuery(grpRagged, "SELECT SUM(B) ORDER BY A ASC", 0, 0, okTick)).toEqual(numVal(30));

    // Non-grouped ORDER BY on ragged row missing sort column
    expect(evaluateQuery(grpRagged, "SELECT A, B ORDER BY B ASC", 0, 0, okTick)).toEqual(
      arrVal([
        [EMPTY_VAL, EMPTY_VAL],
        [strVal("A"), numVal(10)],
        [strVal("B"), numVal(20)],
      ]),
    );
  });

  it("covers detectHeaderCount branches, invalid query syntax branches, empty data, and tickOp #LIMIT!", () => {
    // Empty data / empty row -> #VALUE!
    expect(evaluateQuery([], "SELECT *", 0, 0, okTick)).toEqual(errVal("#VALUE!"));
    expect(evaluateQuery([[]], "SELECT *", 0, 0, okTick)).toEqual(errVal("#VALUE!"));

    // detectHeaderCount: <= 1 row -> 0
    expect(evaluateQuery([[strVal("Only")]], "SELECT A", 0, undefined, okTick)).toEqual(strVal("Only"));
    // detectHeaderCount: number or boolean in first row -> 0
    expect(
      evaluateQuery(
        [
          [numVal(1), strVal("a")],
          [numVal(2), strVal("b")],
        ],
        "SELECT A",
        0,
        undefined,
        okTick,
      ),
    ).toEqual(arrVal([[numVal(1)], [numVal(2)]]));
    expect(
      evaluateQuery(
        [
          [boolVal(true), strVal("a")],
          [boolVal(false), strVal("b")],
        ],
        "SELECT A",
        0,
        undefined,
        okTick,
      ),
    ).toEqual(arrVal([[boolVal(true)], [boolVal(false)]]));
    // detectHeaderCount: first row all empty -> 0
    expect(
      evaluateQuery(
        [
          [EMPTY_VAL, strVal("  ")],
          [numVal(1), numVal(2)],
        ],
        "SELECT A",
        0,
        undefined,
        okTick,
      ),
    ).toEqual(arrVal([[EMPTY_VAL], [numVal(1)]]));
    // detectHeaderCount: col 0 blank in row 0, col 1 string header with numeric body -> 1
    expect(
      evaluateQuery(
        [
          [EMPTY_VAL, strVal("Score")],
          [strVal("x"), numVal(10)],
        ],
        "SELECT B",
        0,
        undefined,
        okTick,
      ),
    ).toEqual(arrVal([[strVal("Score")], [numVal(10)]]));
    // detectHeaderCount: row 0 strings, all body rows strings (no num/bool) -> 0
    expect(
      evaluateQuery(
        [
          [strVal("Name"), strVal("City")],
          [strVal("Alice"), strVal("NYC")],
        ],
        "SELECT A",
        0,
        undefined,
        okTick,
      ),
    ).toEqual(arrVal([[strVal("Name")], [strVal("Alice")]]));

    // Every parser rejection branch -> #VALUE!
    const badQueries = [
      "SELECT 'unclosed",
      "SELECT 'trailing\\",
      "SELECT Col99",
      "SELECT Z",
      "SELECT bad_col_name",
      "SELECT 123",
      "SELECT SUM(123)",
      "SELECT SUM(Z)",
      "SELECT SUM(A",
      "SELECT WHERE",
      "SELECT A AS 123",
      "SELECT A WHERE",
      "SELECT A WHERE (A + ) = 1",
      "SELECT A WHERE (A + 1 = 1",
      "SELECT A WHERE + = 1",
      "SELECT A WHERE - = 1",
      "SELECT A WHERE Z = 1",
      "SELECT A WHERE ) = 1",
      "SELECT A WHERE * = 1",
      "SELECT A WHERE A * = 1",
      "SELECT A WHERE = 1",
      "SELECT A WHERE A + = 1",
      "SELECT A WHERE NOT",
      "SELECT A WHERE A IS 1",
      "SELECT A WHERE A CONTAINS",
      "SELECT A WHERE A STARTS 'a'",
      "SELECT A WHERE A STARTS WITH",
      "SELECT A WHERE A ENDS 'a'",
      "SELECT A WHERE A ENDS WITH",
      "SELECT A WHERE A LIKE",
      "SELECT A WHERE A =",
      "SELECT A WHERE A",
      "SELECT A WHERE A = 1 AND",
      "SELECT A WHERE A = 1 OR",
      "SELECT A GROUP A",
      "SELECT A GROUP BY 123",
      "SELECT A GROUP BY Z",
      "SELECT A ORDER A",
      "SELECT A ORDER BY 123",
      "SELECT A LIMIT -1",
      "SELECT A LIMIT 1.5",
      "SELECT A LIMIT abc",
      "SELECT A OFFSET -1",
      "SELECT A OFFSET 1.5",
      "SELECT A OFFSET abc",
      "SELECT A LABEL 123 'x'",
      "SELECT A LABEL A 123",
      "SELECT A EXTRA_TOKEN",
      // Non-grouped column selected alongside aggregate -> #VALUE!
      "SELECT A, SUM(C)",
      "SELECT A, B, SUM(C) GROUP BY A",
    ];
    for (const q of badQueries) {
      expect(evaluateQuery(SAMPLE_TABLE, q, 0, 1, okTick), `query: ${q}`).toEqual(errVal("#VALUE!"));
    }

    // tickOp #LIMIT! in WHERE loop (1st tick), GROUP BY loop (after WHERE), and non-agg projection loop (after WHERE)
    let calls = 0;
    expect(evaluateQuery(SAMPLE_TABLE, "SELECT *", 0, 1, () => ++calls < 1)).toEqual(errVal("#LIMIT!"));

    calls = 0;
    // 5 body rows pass WHERE (5 ticks), 6th tick fails in GROUP BY loop
    expect(evaluateQuery(SAMPLE_TABLE, "SELECT A, SUM(C) GROUP BY A", 0, 1, () => ++calls <= 5)).toEqual(
      errVal("#LIMIT!"),
    );

    calls = 0;
    // 5 body rows pass WHERE (5 ticks), 6th tick fails in non-agg projection loop
    expect(evaluateQuery(SAMPLE_TABLE, "SELECT A, B", 0, 1, () => ++calls <= 5)).toEqual(errVal("#LIMIT!"));
  });
});

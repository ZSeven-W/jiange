import { describe, expect, it } from "vitest";
import { formatCsv, parseCsv } from "../src/csv.js";
import {
  extractFormulaReferences,
  formatSelectionAddress,
  parseRangeInput,
  translateWorkbookFormula,
} from "../src/formula-ast.js";
import {
  buildMergeLookup,
  calculateWorkbook,
  computeSortedRowWrites,
  getVisibleRowIndices,
  IncrementalFormulaEngine,
  normalizePointForMerge,
} from "../src/formula-engine.js";
import { SUPPORTED_FORMULA_FUNCTIONS } from "../src/formula-functions.js";
import { dateToSerial, formatCellDisplay, formatExcelNumber, parseDateToSerial } from "../src/numfmt.js";
import type { SheetWorksheet } from "../src/types.js";

function makeSheet(id: number, title: string, entries: [number, number, string][], rows = 20, cols = 10): SheetWorksheet {
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

describe("AST + DAG incremental formula engine (130+ Excel functions)", () => {
  it("registers over 125 built-in Excel functions", () => {
    expect(SUPPORTED_FORMULA_FUNCTIONS.length).toBeGreaterThanOrEqual(125);
  });

  it("evaluates math, statistics, conditional aggregations, and SUMPRODUCT/SUBTOTAL", () => {
    const ws = makeSheet(1, "Stats", [
      [0, 0, "East"], [0, 1, "A"], [0, 2, "10"],
      [1, 0, "West"], [1, 1, "B"], [1, 2, "20"],
      [2, 0, "East"], [2, 1, "B"], [2, 2, "30"],
      [3, 0, "East"], [3, 1, "A"], [3, 2, "40"],
      [4, 0, "=SUMIFS(C1:C4,A1:A4,\"East\",B1:B4,\"A\")"],
      [4, 1, "=COUNTIFS(A1:A4,\"East\",C1:C4,\">=20\")"],
      [4, 2, "=AVERAGEIFS(C1:C4,A1:A4,\"East\")"],
      [4, 3, "=MAXIFS(C1:C4,A1:A4,\"East\")"],
      [4, 4, "=MINIFS(C1:C4,A1:A4,\"East\")"],
      [5, 0, "=MEDIAN(C1:C4)"],
      [5, 1, "=LARGE(C1:C4,2)"],
      [5, 2, "=SMALL(C1:C4,2)"],
      [5, 3, "=RANK(30,C1:C4,0)"],
      [5, 4, "=PERCENTILE(C1:C4,0.5)"],
      [6, 0, "=SUMPRODUCT(C1:C4,{1;2;1;2})"],
      [6, 1, "=SUBTOTAL(9,C1:C4)"],
      [6, 2, "=ROUNDUP(3.141,2)"],
      [6, 3, "=ROUNDDOWN(3.149,2)"],
      [6, 4, "=MROUND(17,5)"],
      [7, 0, "=CEILING(4.2,1)"],
      [7, 1, "=FLOOR(4.9,1)"],
      [7, 2, "=STDEV.P(C1:C4)"],
      [7, 3, "=VAR.S(C1:C4)"],
      [7, 4, "=QUARTILE(C1:C4,3)"],
      [8, 0, "=COUNTBLANK(D1:D4)"],
      [8, 1, "=PRODUCT(2,3,4)"],
      [8, 2, "=MODE(1,2,2,3)"],
      [8, 3, "=LOG(8,2)"],
      [8, 4, "=SIGN(-9)"],
    ]);
    const map = calculateWorkbook([ws]).get(1)!;
    expect(map["4:0"]).toEqual({ kind: "number", value: 50 });
    expect(map["4:1"]).toEqual({ kind: "number", value: 2 });
    expect(map["4:2"].value).toBeCloseTo(80 / 3, 6);
    expect(map["4:3"]).toEqual({ kind: "number", value: 40 });
    expect(map["4:4"]).toEqual({ kind: "number", value: 10 });
    expect(map["5:0"]).toEqual({ kind: "number", value: 25 });
    expect(map["5:1"]).toEqual({ kind: "number", value: 30 });
    expect(map["5:2"]).toEqual({ kind: "number", value: 20 });
    expect(map["5:3"]).toEqual({ kind: "number", value: 2 });
    expect(map["5:4"]).toEqual({ kind: "number", value: 25 });
    expect(map["6:0"]).toEqual({ kind: "number", value: 160 });
    expect(map["6:1"]).toEqual({ kind: "number", value: 100 });
    expect(map["6:2"]).toEqual({ kind: "number", value: 3.15 });
    expect(map["6:3"]).toEqual({ kind: "number", value: 3.14 });
    expect(map["6:4"]).toEqual({ kind: "number", value: 15 });
    expect(map["7:0"]).toEqual({ kind: "number", value: 5 });
    expect(map["7:1"]).toEqual({ kind: "number", value: 4 });
    expect(map["7:2"].value).toBeCloseTo(Math.sqrt(125), 5);
    expect(map["7:3"].value).toBeCloseTo(500 / 3, 5);
    expect(map["7:4"]).toEqual({ kind: "number", value: 32.5 });
    expect(map["8:0"]).toEqual({ kind: "number", value: 4 });
    expect(map["8:1"]).toEqual({ kind: "number", value: 24 });
    expect(map["8:2"]).toEqual({ kind: "number", value: 2 });
    expect(map["8:3"]).toEqual({ kind: "number", value: 3 });
    expect(map["8:4"]).toEqual({ kind: "number", value: -1 });
  });

  it("evaluates lookup, reference, logic, text, date, financial, and dynamic array functions", () => {
    const ws = makeSheet(1, "Biz", [
      [0, 0, "SKU-1"], [0, 1, "Alpha"], [0, 2, "100"],
      [1, 0, "SKU-2"], [1, 1, "Beta"], [1, 2, "250"],
      [2, 0, "SKU-3"], [2, 1, "Gamma"], [2, 2, "180"],
      [3, 0, "=VLOOKUP(\"SKU-2\",A1:C3,3,FALSE)"],
      [3, 1, "=XLOOKUP(\"SKU-3\",A:A,B:B,\"missing\")"],
      [3, 2, "=XLOOKUP(\"SKU-9\",A1:A3,B1:B3,\"fallback\")"],
      [3, 3, "=INDEX(B1:B3,MATCH(\"SKU-1\",A1:A3,0))"],
      [3, 4, "=XMATCH(\"Gamma\",B1:B3,0)"],
      [4, 0, "=IFS(C1>200,\"high\",C2>200,\"mid\",TRUE,\"low\")"],
      [4, 1, "=SWITCH(B1,\"Alpha\",1,\"Beta\",2,0)"],
      [4, 2, "=IFNA(VLOOKUP(\"NOPE\",A1:C3,2,FALSE),\"none\")"],
      [4, 3, "=XOR(TRUE,FALSE,FALSE)"],
      [4, 4, "=ISFORMULA(A4)"],
      [5, 0, "=TEXTJOIN(\"-\",TRUE,B1:B3)"],
      [5, 1, "=MID(\"JiangeSDK\",2,5)"],
      [5, 2, "=SUBSTITUTE(\"a-b-c\",\"-\",\"/\",2)"],
      [5, 3, "=PROPER(\"hello world\")"],
      [5, 4, "=TEXT(0.256,\"0.0%\")"],
      [6, 0, "=DATE(2026,1,15)"],
      [6, 1, "=YEAR(EOMONTH(A7,2))"],
      [6, 2, "=DAY(EOMONTH(A7,1))"],
      [6, 3, "=DATEDIF(DATE(2025,1,1),DATE(2026,6,15),\"M\")"],
      [6, 4, "=NETWORKDAYS(DATE(2026,1,5),DATE(2026,1,9))"],
      [7, 0, "=ROUND(PMT(0.05/12,12,1200),2)"],
      [7, 1, "=ROUND(FV(0.1,2,-100,0),2)"],
      [7, 2, "=ROUND(NPV(0.1,110,121),2)"],
      [7, 3, "=ROUND(IRR({-100;60;60}),4)"],
      [7, 4, "=INDIRECT(\"C2\")"],
      [8, 0, "=OFFSET(A1,1,2)"],
      [8, 1, "=ROW(B5)"],
      [8, 2, "=COLUMN(C5)"],
      [8, 3, "=ROWS(A1:C3)"],
      [8, 4, "=COLUMNS(A1:C3)"],
      [9, 0, "=FILTER(B1:B3,C1:C3>150)"],
      [13, 0, "=UNIQUE({\"x\";\"y\";\"x\"})"],
      [13, 2, "=SORT({30;10;20},1,1)"],
      [13, 4, "=SEQUENCE(2,2,1,5)"],
    ], 25, 10);

    const map = calculateWorkbook([ws]).get(1)!;
    expect(map["3:0"]).toEqual({ kind: "number", value: 250 });
    expect(map["3:1"]).toEqual({ kind: "string", value: "Gamma" });
    expect(map["3:2"]).toEqual({ kind: "string", value: "fallback" });
    expect(map["3:3"]).toEqual({ kind: "string", value: "Alpha" });
    expect(map["3:4"]).toEqual({ kind: "number", value: 3 });
    expect(map["4:0"]).toEqual({ kind: "string", value: "mid" });
    expect(map["4:1"]).toEqual({ kind: "number", value: 1 });
    expect(map["4:2"]).toEqual({ kind: "string", value: "none" });
    expect(map["4:3"]).toEqual({ kind: "boolean", value: true });
    expect(map["4:4"]).toEqual({ kind: "boolean", value: true });
    expect(map["5:0"]).toEqual({ kind: "string", value: "Alpha-Beta-Gamma" });
    expect(map["5:1"]).toEqual({ kind: "string", value: "iange" });
    expect(map["5:2"]).toEqual({ kind: "string", value: "a-b/c" });
    expect(map["5:3"]).toEqual({ kind: "string", value: "Hello World" });
    expect(map["5:4"]).toEqual({ kind: "string", value: "25.6%" });
    expect(map["6:1"]).toEqual({ kind: "number", value: 2026 });
    expect(map["6:2"]).toEqual({ kind: "number", value: 28 });
    expect(map["6:3"]).toEqual({ kind: "number", value: 17 });
    expect(map["6:4"]).toEqual({ kind: "number", value: 5 });
    expect(map["7:0"]).toEqual({ kind: "number", value: -102.73 });
    expect(map["7:1"]).toEqual({ kind: "number", value: 210 });
    expect(map["7:2"]).toEqual({ kind: "number", value: 200 });
    expect(map["7:3"].value).toBeCloseTo(0.1307, 3);
    expect(map["7:4"]).toEqual({ kind: "number", value: 250 });
    expect(map["8:0"]).toEqual({ kind: "number", value: 250 });
    expect(map["8:1"]).toEqual({ kind: "number", value: 5 });
    expect(map["8:2"]).toEqual({ kind: "number", value: 3 });
    expect(map["8:3"]).toEqual({ kind: "number", value: 3 });
    expect(map["8:4"]).toEqual({ kind: "number", value: 3 });
    // Dynamic array spills:
    expect(map["9:0"]).toEqual({ kind: "string", value: "Beta" });
    expect(map["10:0"]).toEqual({ kind: "string", value: "Gamma" });
    expect(map["13:0"]).toEqual({ kind: "string", value: "x" });
    expect(map["14:0"]).toEqual({ kind: "string", value: "y" });
    expect(map["13:2"]).toEqual({ kind: "number", value: 10 });
    expect(map["15:2"]).toEqual({ kind: "number", value: 30 });
    expect(map["13:4"]).toEqual({ kind: "number", value: 1 });
    expect(map["13:5"]).toEqual({ kind: "number", value: 6 });
    expect(map["14:4"]).toEqual({ kind: "number", value: 11 });
    expect(map["14:5"]).toEqual({ kind: "number", value: 16 });
  });

  it("performs true incremental dirty-subgraph recalculation with defined names, custom functions, and #SPILL! detection", () => {
    const entries: [number, number, string][] = [];
    // 100 independent rows: col 0 = input, col 1 = col0 * TaxRate, col 2 = CUSTOM_DOUBLE(col1)
    for (let r = 0; r < 100; r++) {
      entries.push([r, 0, String(r + 1)]);
      entries.push([r, 1, `=A${r + 1}*TaxRate`]);
      entries.push([r, 2, `=DOUBLE_VAL(B${r + 1})`]);
    }
    // Row 100 col 0 sums B1:B100 via range watcher
    entries.push([100, 0, "=SUM(B1:B100)"]);
    // Blocked spill: A102 wants 2x1 array, A103 is occupied
    entries.push([101, 0, "=SEQUENCE(2,1)"]);
    entries.push([102, 0, "blocker"]);

    const ws = makeSheet(1, "Inc", entries, 110, 5);
    const engine = new IncrementalFormulaEngine();
    engine.registerFunction("DOUBLE_VAL", ([x]) => (x?.kind === "number" ? x.value * 2 : 0));
    engine.loadSheets([ws], { definedNames: [{ name: "TaxRate", ref: "0.1" }] });

    expect(engine.getValue(1, 0, 1)).toEqual({ kind: "number", value: 0.1 });
    expect(engine.getValue(1, 0, 2)).toEqual({ kind: "number", value: 0.2 });
    expect(engine.getValue(1, 100, 0)).toEqual({ kind: "number", value: 505 });
    expect(engine.getValue(1, 101, 0)).toEqual({ kind: "error", value: "#SPILL!", error: "#SPILL!" });

    // Updating ONLY A1 should ONLY recalculate A1 -> B1 -> C1 -> A101 (4 cells total, NOT 300!).
    const inc = engine.updateCells(1, [{ row: 0, col: 0, raw: "101" }]);
    expect(inc.recalculated).toBe(4);
    expect(engine.getValue(1, 0, 1)).toEqual({ kind: "number", value: 10.1 });
    expect(engine.getValue(1, 0, 2)).toEqual({ kind: "number", value: 20.2 });
    expect(engine.getValue(1, 100, 0)).toEqual({ kind: "number", value: 515 });
    expect(engine.getPrecedents(1, 0, 2)).toContain("1:0:1");
    expect(engine.getDependents(1, 0, 0)).toContain("1:0:1");

    // Clearing the blocker unblocks the #SPILL! automatically.
    engine.updateCells(1, [{ row: 102, col: 0, raw: "" }]);
    expect(engine.getValue(1, 101, 0)).toEqual({ kind: "number", value: 1 });
    expect(engine.getValue(1, 102, 0)).toEqual({ kind: "number", value: 2 });
  });

  it("handles formula translation, references, merge/filter/sort, numfmt, and CSV helpers", () => {
    const ws = makeSheet(1, "Sales", [
      [0, 0, "Item"], [0, 1, "Price"],
      [1, 0, "Beta"], [1, 1, "20"],
      [2, 0, "Alpha"], [2, 1, "10"],
    ], 10, 5);
    ws.merges = [{ top: 5, left: 0, bottom: 6, right: 1 }];
    ws.filter = { enabled: true, headerRow: 0, rules: { "0": { query: "alp" } } };

    expect(parseRangeInput("A1:B2")).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 1, col: 1 } });
    expect(formatSelectionAddress({ anchor: { row: 0, col: 0 }, focus: { row: 1, col: 1 } })).toBe("A1:B2");
    expect(translateWorkbookFormula("=Sales!$A$1+B2", 2, 1, 100, 26)).toBe("=Sales!$A$1+C4");
    expect(extractFormulaReferences("=SUM(A1:B2)+Sales!A:A", 1, [ws])).toHaveLength(2);

    const lookup = buildMergeLookup(ws.merges);
    expect(normalizePointForMerge({ row: 6, col: 1 }, lookup)).toEqual({ row: 5, col: 0 });

    const evalMap = calculateWorkbook([ws]).get(1)!;
    expect(getVisibleRowIndices(ws, evalMap)).toEqual([0, 2]);
    ws.merges = [];
    expect(computeSortedRowWrites(ws, evalMap, 1, true, 0).length).toBeGreaterThan(0);

    // Number formatting & CSV
    const s = parseDateToSerial("2026-11-21")!;
    expect(s).toBe(dateToSerial(new Date(Date.UTC(2026, 10, 21))));
    expect(formatExcelNumber(s, "yyyy-mm-dd")).toBe("2026-11-21");
    expect(formatExcelNumber(1234.5, '"$"#,##0.00')).toBe("$1,234.50");
    expect(formatExcelNumber(-50, "#,##0;(#,##0);0")).toBe("(50)");
    expect(formatCellDisplay("0.25", { kind: "number", value: 0.25 }, { numFmt: "percent" })).toBe("25%");

    const csv = formatCsv([["Name", "Note"], ["A,B", 'Say "Hi"\nLine2']]);
    expect(parseCsv("\uFEFF" + csv)).toEqual([["Name", "Note"], ["A,B", 'Say "Hi"\nLine2']]);
  });
});

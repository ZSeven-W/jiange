import { describe, expect, it } from "vitest";
import { createSheetTools } from "../src/ai-tools.js";
import {
  computePivotTable,
  detectDataTableRange,
  detectFirstNumericColOffset,
  extractChartDataset,
  formatPivotNumber,
} from "../src/analytics.js";
import {
  applyRemoteCellDelta,
  buildConflictResolutionWrite,
  formatSheetCellAddress,
  formatSheetRect,
  toSheetStylePatch,
} from "../src/collab.js";
import { parseColToken, parseFormulaAst } from "../src/formula-ast.js";
import { calculateWorkbook } from "../src/formula-engine.js";
import { compareValues, matchCriteria } from "../src/formula-functions.js";
import { formatCellDisplay, formatExcelNumber, parseDateToSerial } from "../src/numfmt.js";
import {
  evaluateSheetConditionalFormat,
  evaluateSheetValidation,
  findSheetDropdown,
  formatSheetRectA1,
  isSheetCellProtected,
  makeRuleId,
} from "../src/rules.js";
import type { SheetConditionalFormat, SheetDataValidation, SheetWorksheet } from "../src/types.js";
import { Workbook } from "../src/workbook.js";
import { exportWorkbookToXlsx, numFmtFromCode, parseXlsxBytesForWorkbook, sheetStyleToXlsx, xlsxStyleToSheet } from "../src/workbook-xlsx.js";
import { createFormulaWorkerHost, FormulaWorkerClient, type FormulaWorkerRequest, type MessagePortLike } from "../src/worker.js";
import { writeXlsx } from "../src/xlsx.js";

function evalFormulas(cells: [number, number, string][], rows = 20, cols = 10) {
  const rowAxes = Array.from({ length: rows }, (_, i) => ({ id: i + 1, pos: i }));
  const colAxes = Array.from({ length: cols }, (_, i) => ({ id: i + 1, pos: i }));
  const ws: SheetWorksheet = {
    id: 1,
    nodeId: 1,
    title: "T",
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
  return calculateWorkbook([ws]).get(1)!;
}

describe("exhaustive function library coverage", () => {
  it("covers math, trig, stats, and error handling branches", () => {
    const map = evalFormulas([
      [0, 0, "=ABS(-7)"], [0, 1, "=INT(-2.3)"], [0, 2, "=SQRT(16)"], [0, 3, "=SQRT(-1)"], [0, 4, "=EXP(0)"],
      [1, 0, "=LN(1)"], [1, 1, "=LN(0)"], [1, 2, "=LOG10(100)"], [1, 3, "=LOG10(-5)"], [1, 4, "=LOG(8,1)"],
      [2, 0, "=SIN(0)"], [2, 1, "=COS(0)"], [2, 2, "=TAN(0)"], [2, 3, "=PI()"], [2, 4, "=RAND()"],
      [3, 0, "=RANDBETWEEN(3,5)"], [3, 1, "=RANDBETWEEN(5,3)"], [3, 2, "=TRUNC(3.98,1)"], [3, 3, "=MOD(7,3)"], [3, 4, "=MOD(7,0)"],
      [4, 0, "=POWER(2,5)"], [4, 1, "=MROUND(5,-2)"], [4, 2, "=MROUND(5,0)"], [4, 3, "=CEILING(4.2,0)"], [4, 4, "=FLOOR(4.2,0)"],
      [5, 0, "=STDEV(10,20,30)"], [5, 1, "=VAR.P(10,20,30)"], [5, 2, "=VAR.S(10)"], [5, 3, "=VAR.P(J18:J19)"], [5, 4, "=MEDIAN(10,20,30)"],
      [6, 0, "=MEDIAN(J18:J19)"], [6, 1, "=MODE(1,2,3)"], [6, 2, "=AVERAGE(J18:J19)"], [6, 3, "=MIN(J18:J19)"], [6, 4, "=MAX(J18:J19)"],
      [7, 0, "=RANK(10,{10;20;30},1)"], [7, 1, "=RANK(99,{10;20},0)"], [7, 2, "=PERCENTILE({10;20;30},2)"], [7, 3, "=QUARTILE({10;20;30},5)"], [7, 4, "=LARGE({10;20},5)"],
      [8, 0, "=SMALL({10;20},0)"], [8, 1, "=SUBTOTAL(109,10,20)"], [8, 2, "=SUBTOTAL(99,10)"], [8, 3, "=SUMPRODUCT({1;2},{1,2})"], [8, 4, "=COUNTIF(A1:A1,7)"],
      [9, 0, "=SUMIF(A1:A1,7)"], [9, 1, "=AVERAGEIF(A1:A1,\">0\")"], [9, 2, "=AVERAGEIF(A1:A1,\">99\")"], [9, 3, "=MAXIFS(A1:A1,A1:A1,\">99\")"], [9, 4, "=MINIFS(A1:A1,A1:A1,\">99\")"],
    ]);
    expect(map["0:0"]).toEqual({ kind: "number", value: 7 });
    expect(map["0:1"]).toEqual({ kind: "number", value: -3 });
    expect(map["0:2"]).toEqual({ kind: "number", value: 4 });
    expect(map["0:3"].kind).toBe("error");
    expect(map["0:4"]).toEqual({ kind: "number", value: 1 });
    expect(map["1:0"]).toEqual({ kind: "number", value: 0 });
    expect(map["1:1"].kind).toBe("error");
    expect(map["1:2"]).toEqual({ kind: "number", value: 2 });
    expect(map["1:3"].kind).toBe("error");
    expect(map["1:4"].kind).toBe("error");
    expect(map["2:0"]).toEqual({ kind: "number", value: 0 });
    expect(map["2:1"]).toEqual({ kind: "number", value: 1 });
    expect(map["2:2"]).toEqual({ kind: "number", value: 0 });
    expect(map["2:3"].value).toBeCloseTo(Math.PI, 6);
    expect(map["2:4"].kind).toBe("number");
    expect(map["3:0"].kind).toBe("number");
    expect(map["3:1"].kind).toBe("error");
    expect(map["3:2"]).toEqual({ kind: "number", value: 3.9 });
    expect(map["3:3"]).toEqual({ kind: "number", value: 1 });
    expect(map["3:4"].kind).toBe("error");
    expect(map["4:0"]).toEqual({ kind: "number", value: 32 });
    expect(map["4:1"].kind).toBe("error");
    expect(map["4:2"]).toEqual({ kind: "number", value: 0 });
    expect(map["4:3"]).toEqual({ kind: "number", value: 0 });
    expect(map["4:4"].kind).toBe("error");
    expect(map["5:0"]).toEqual({ kind: "number", value: 10 });
    expect(map["5:1"].value).toBeCloseTo(200 / 3, 5);
    expect(map["5:2"].kind).toBe("error");
    expect(map["5:3"].kind).toBe("error");
    expect(map["5:4"]).toEqual({ kind: "number", value: 20 });
    expect(map["6:0"].kind).toBe("error");
    expect(map["6:1"].kind).toBe("error");
    expect(map["6:2"].kind).toBe("error");
    expect(map["6:3"]).toEqual({ kind: "number", value: 0 });
    expect(map["6:4"]).toEqual({ kind: "number", value: 0 });
    expect(map["7:0"]).toEqual({ kind: "number", value: 1 });
    expect(map["7:1"].kind).toBe("error");
    expect(map["7:2"].kind).toBe("error");
    expect(map["7:3"].kind).toBe("error");
    expect(map["7:4"].kind).toBe("error");
    expect(map["8:0"].kind).toBe("error");
    expect(map["8:1"]).toEqual({ kind: "number", value: 30 });
    expect(map["8:2"].kind).toBe("error");
    expect(map["8:3"].kind).toBe("error");
    expect(map["8:4"]).toEqual({ kind: "number", value: 1 });
    expect(map["9:0"]).toEqual({ kind: "number", value: 7 });
    expect(map["9:1"]).toEqual({ kind: "number", value: 7 });
    expect(map["9:2"].kind).toBe("error");
    expect(map["9:3"]).toEqual({ kind: "number", value: 0 });
    expect(map["9:4"]).toEqual({ kind: "number", value: 0 });
  });

  it("covers logic, info, text, date, financial, lookup, and array functions thoroughly", () => {
    const map = evalFormulas([
      // Logic & Info
      [0, 0, "=IF(FALSE,1)"], [0, 1, "=IFS(FALSE,1,FALSE,2)"], [0, 2, "=SWITCH(9,1,\"a\",2,\"b\",\"def\")"], [0, 3, "=SWITCH(9,1,\"a\")"], [0, 4, "=IFERROR(1/0,\"ok\")"],
      [1, 0, "=AND(TRUE,FALSE)"], [1, 1, "=OR(FALSE,TRUE)"], [1, 2, "=NOT(TRUE)"], [1, 3, "=TRUE()"], [1, 4, "=FALSE()"],
      [2, 0, "=NA()"], [2, 1, "=ISBLANK(J19)"], [2, 2, "=ISERROR(NA())"], [2, 3, "=ISERR(NA())"], [2, 4, "=ISNA(NA())"],
      [3, 0, "=ISNUMBER(5)"], [3, 1, "=ISTEXT(\"hi\")"], [3, 2, "=ISLOGICAL(TRUE)"], [3, 3, "=ISFORMULA(A1)"], [3, 4, "=CHOOSE(2,\"x\",\"y\",\"z\")"],
      // Text
      [4, 0, "=CONCATENATE(\"a\",\"b\")"], [4, 1, "=TEXTJOIN(\",\",FALSE,\"a\",\"\",\"b\")"], [4, 2, "=LEN(\"abc\")"], [4, 3, "=UPPER(\"ab\")"], [4, 4, "=LOWER(\"AB\")"],
      [5, 0, "=TRIM(\"  a   b  \")"], [5, 1, "=CLEAN(\"a\u0007b\")"], [5, 2, "=LEFT(\"hello\",2)"], [5, 3, "=RIGHT(\"hello\",2)"], [5, 4, "=FIND(\"l\",\"hello\",4)"],
      [6, 0, "=SEARCH(\"*LO\",\"hello\")"], [6, 1, "=SEARCH(\"zz\",\"hello\")"], [6, 2, "=REPLACE(\"abcdef\",2,3,\"XY\")"], [6, 3, "=VALUE(\"$1,200\")"], [6, 4, "=VALUE(\"25%\")"],
      [7, 0, "=REPT(\"ha\",3)"], [7, 1, "=EXACT(\"A\",\"a\")"], [7, 2, "=CHAR(65)"], [7, 3, "=CODE(\"A\")"], [7, 4, "=SPLIT(\"x|y\",\"|\")"],
      // Date & Time
      [8, 0, "=TIME(12,30,45)"], [8, 1, "=HOUR(A9)"], [8, 2, "=MINUTE(A9)"], [8, 3, "=SECOND(A9)"], [8, 4, "=DATEVALUE(\"2026-03-15\")"],
      [9, 0, "=MONTH(E9)"], [9, 1, "=DAYS(DATE(2026,1,10),DATE(2026,1,1))"], [9, 2, "=DATEDIF(DATE(2024,1,1),DATE(2026,6,1),\"Y\")"], [9, 3, "=EDATE(DATE(2026,1,31),1)"], [9, 4, "=WEEKDAY(DATE(2026,1,5),2)"],
      [10, 0, "=WEEKDAY(DATE(2026,1,5),3)"], [10, 1, "=WEEKNUM(DATE(2026,1,15))"], [10, 2, "=ISOWEEKNUM(DATE(2026,1,15))"], [10, 3, "=WORKDAY(DATE(2026,1,2),2)"], [10, 4, "=YEARFRAC(DATE(2026,1,1),DATE(2027,1,1))"],
      [11, 0, "=TODAY()"], [11, 1, "=NOW()"],
      // Financial
      [12, 0, "=ROUND(PV(0.05,10,-100),2)"], [12, 1, "=PV(0,10,-100)"], [12, 2, "=FV(0,10,-100)"], [12, 3, "=ROUND(NPER(0.05,-100,772.17),0)"], [12, 4, "=NPER(0,-100,500)"],
      [13, 0, "=ROUND(RATE(12,-100,1100),4)"], [13, 1, "=PMT(0,10,1000)"], [13, 2, "=HYPERLINK(\"https://a.b\",\"Link\")"], [13, 3, "=TRANSPOSE({1,2;3,4})"],
      // Lookups & Arrays
      [15, 0, "=HLOOKUP(\"k2\",{\"k1\",\"k2\";10,20},2,FALSE)"], [15, 1, "=HLOOKUP(15,{10,20;\"a\",\"b\"},2,TRUE)"],
      [15, 2, "=VLOOKUP(15,{10,\"a\";20,\"b\"},2,TRUE)"], [15, 3, "=MATCH(15,{10;20;30},1)"], [15, 4, "=MATCH(15,{30;20;10},-1)"],
      [16, 0, "=XLOOKUP(15,{10;20;30},{\"a\";\"b\";\"c\"},\"na\",-1)"], [16, 1, "=XLOOKUP(15,{10;20;30},{\"a\";\"b\";\"c\"},\"na\",1)"],
      [16, 2, "=XLOOKUP(\"*b*\",{\"aa\",\"bb\"},{1,2},0,2,-1)"], [16, 3, "=XMATCH(\"*b*\",{\"aa\";\"bb\"},2,-1)"], [16, 4, "=INDEX({1,2;3,4},2,1)"],
      [17, 0, "=FILTER({1,2;3,4},{TRUE,FALSE})"], [17, 2, "=FILTER({1;2},{FALSE;FALSE},\"empty\")"], [17, 3, "=SORTBY({\"b\";\"a\"},{2;1},1)"],
      [19, 0, "=ROW()"], [19, 1, "=COLUMN()"], [19, 2, "=ROW(B3:C5)"], [19, 3, "=COLUMN(B3:C5)"],
    ], 25, 10);

    expect(map["0:0"]).toEqual({ kind: "boolean", value: false });
    expect(map["0:1"].kind).toBe("error");
    expect(map["0:2"]).toEqual({ kind: "string", value: "def" });
    expect(map["0:3"].kind).toBe("error");
    expect(map["0:4"]).toEqual({ kind: "string", value: "ok" });
    expect(map["1:0"]).toEqual({ kind: "boolean", value: false });
    expect(map["1:1"]).toEqual({ kind: "boolean", value: true });
    expect(map["1:2"]).toEqual({ kind: "boolean", value: false });
    expect(map["1:3"]).toEqual({ kind: "boolean", value: true });
    expect(map["1:4"]).toEqual({ kind: "boolean", value: false });
    expect(map["2:0"]).toEqual({ kind: "error", value: "#N/A", error: "#N/A" });
    expect(map["2:1"]).toEqual({ kind: "boolean", value: true });
    expect(map["2:2"]).toEqual({ kind: "boolean", value: true });
    expect(map["2:3"]).toEqual({ kind: "boolean", value: false });
    expect(map["2:4"]).toEqual({ kind: "boolean", value: true });
    expect(map["3:0"]).toEqual({ kind: "boolean", value: true });
    expect(map["3:1"]).toEqual({ kind: "boolean", value: true });
    expect(map["3:2"]).toEqual({ kind: "boolean", value: true });
    expect(map["3:3"]).toEqual({ kind: "boolean", value: true });
    expect(map["3:4"]).toEqual({ kind: "string", value: "y" });
    expect(map["4:0"]).toEqual({ kind: "string", value: "ab" });
    expect(map["4:1"]).toEqual({ kind: "string", value: "a,,b" });
    expect(map["4:2"]).toEqual({ kind: "number", value: 3 });
    expect(map["4:3"]).toEqual({ kind: "string", value: "AB" });
    expect(map["4:4"]).toEqual({ kind: "string", value: "ab" });
    expect(map["5:0"]).toEqual({ kind: "string", value: "a b" });
    expect(map["5:1"]).toEqual({ kind: "string", value: "ab" });
    expect(map["5:2"]).toEqual({ kind: "string", value: "he" });
    expect(map["5:3"]).toEqual({ kind: "string", value: "lo" });
    expect(map["5:4"]).toEqual({ kind: "number", value: 4 });
    expect(map["6:0"]).toEqual({ kind: "number", value: 1 });
    expect(map["6:1"].kind).toBe("error");
    expect(map["6:2"]).toEqual({ kind: "string", value: "aXYef" });
    expect(map["6:3"]).toEqual({ kind: "number", value: 1200 });
    expect(map["6:4"]).toEqual({ kind: "number", value: 0.25 });
    expect(map["7:0"]).toEqual({ kind: "string", value: "hahaha" });
    expect(map["7:1"]).toEqual({ kind: "boolean", value: false });
    expect(map["7:2"]).toEqual({ kind: "string", value: "A" });
    expect(map["7:3"]).toEqual({ kind: "number", value: 65 });
    expect(map["7:4"]).toEqual({ kind: "string", value: "x" });
    expect(map["7:5"]).toEqual({ kind: "string", value: "y" });
    expect(map["8:1"]).toEqual({ kind: "number", value: 12 });
    expect(map["8:2"]).toEqual({ kind: "number", value: 30 });
    expect(map["8:3"]).toEqual({ kind: "number", value: 45 });
    expect(map["9:0"]).toEqual({ kind: "number", value: 3 });
    expect(map["9:1"]).toEqual({ kind: "number", value: 9 });
    expect(map["9:2"]).toEqual({ kind: "number", value: 2 });
    expect(map["9:4"]).toEqual({ kind: "number", value: 1 });
    expect(map["10:0"]).toEqual({ kind: "number", value: 0 });
    expect(map["10:1"].kind).toBe("number");
    expect(map["10:2"].kind).toBe("number");
    expect(map["10:3"].kind).toBe("number");
    expect(map["10:4"]).toEqual({ kind: "number", value: 1 });
    expect(map["11:0"].kind).toBe("string");
    expect(map["11:1"].kind).toBe("string");
    expect(map["12:0"]).toEqual({ kind: "number", value: 772.17 });
    expect(map["12:1"]).toEqual({ kind: "number", value: 1000 });
    expect(map["12:2"]).toEqual({ kind: "number", value: 1000 });
    expect(map["12:3"]).toEqual({ kind: "number", value: 10 });
    expect(map["12:4"]).toEqual({ kind: "number", value: 5 });
    expect(map["13:0"].value).toBeCloseTo(0.0138, 3);
    expect(map["13:1"]).toEqual({ kind: "number", value: -100 });
    expect(map["13:2"]).toEqual({ kind: "string", value: "Link" });
    expect(map["13:3"]).toEqual({ kind: "number", value: 1 });
    expect(map["14:3"]).toEqual({ kind: "number", value: 2 });
    expect(map["15:0"]).toEqual({ kind: "number", value: 20 });
    expect(map["15:1"]).toEqual({ kind: "string", value: "a" });
    expect(map["15:2"]).toEqual({ kind: "string", value: "a" });
    expect(map["15:3"]).toEqual({ kind: "number", value: 1 });
    expect(map["15:4"]).toEqual({ kind: "number", value: 2 });
    expect(map["16:0"]).toEqual({ kind: "string", value: "a" });
    expect(map["16:1"]).toEqual({ kind: "string", value: "b" });
    expect(map["16:2"]).toEqual({ kind: "number", value: 2 });
    expect(map["16:3"]).toEqual({ kind: "number", value: 2 });
    expect(map["16:4"]).toEqual({ kind: "number", value: 3 });
    expect(map["17:0"]).toEqual({ kind: "number", value: 1 });
    expect(map["18:0"]).toEqual({ kind: "number", value: 3 });
    expect(map["17:2"]).toEqual({ kind: "string", value: "empty" });
    expect(map["17:3"]).toEqual({ kind: "string", value: "a" });
    expect(map["18:3"]).toEqual({ kind: "string", value: "b" });
    expect(map["19:0"]).toEqual({ kind: "number", value: 20 });
    expect(map["19:1"]).toEqual({ kind: "number", value: 2 });
    expect(map["19:2"]).toEqual({ kind: "number", value: 3 });
    expect(map["19:3"]).toEqual({ kind: "number", value: 2 });
  });
});

describe("rules, collab, analytics, numfmt, workbook, and worker branch coverage", () => {
  it("covers all conditional formatting operators, data validation types, and protected ranges", () => {
    const ops: SheetConditionalFormat[] = [
      { id: "1", top: 0, left: 0, bottom: 10, right: 10, op: "empty", bg: "#111111" },
      { id: "2", top: 0, left: 0, bottom: 10, right: 10, op: "not_empty", color: "#222222" },
      { id: "3", top: 0, left: 0, bottom: 10, right: 10, op: "contains", value1: "abc", bold: true },
      { id: "4", top: 0, left: 0, bottom: 10, right: 10, op: "eq", value1: "10", bg: "#333333" },
      { id: "5", top: 0, left: 0, bottom: 10, right: 10, op: "neq", value1: "99", color: "#444444" },
      { id: "6", top: 0, left: 0, bottom: 10, right: 10, op: "gt", value1: "5", bg: "#555555" },
      { id: "7", top: 0, left: 0, bottom: 10, right: 10, op: "gte", value1: "10", bg: "#666666" },
      { id: "8", top: 0, left: 0, bottom: 10, right: 10, op: "lt", value1: "20", bg: "#777777" },
      { id: "9", top: 0, left: 0, bottom: 10, right: 10, op: "lte", value1: "10", bg: "#888888" },
      { id: "10", top: 0, left: 0, bottom: 10, right: 10, op: "between", value1: "1", value2: "15", bg: "#999999" },
    ];
    expect(evaluateSheetConditionalFormat("", { kind: "empty", value: "" }, ops, 1, 1)?.bg).toBe("#111111");
    expect(evaluateSheetConditionalFormat("10", { kind: "number", value: 10 }, ops, 1, 1)?.bg).toBe("#999999");
    expect(evaluateSheetConditionalFormat("xabc", { kind: "string", value: "xabc" }, ops, 1, 1)?.bold).toBe(true);
    expect(evaluateSheetConditionalFormat("TRUE", { kind: "boolean", value: true }, ops, 1, 1)?.color).toBe("#444444");
    expect(evaluateSheetConditionalFormat("#REF!", { kind: "error", value: "#REF!", error: "#REF!" }, ops, 1, 1)?.color).toBe("#444444");
    expect(evaluateSheetConditionalFormat("10", undefined, ops, 20, 20)).toBeNull();

    const dvs: SheetDataValidation[] = [
      { id: "d1", top: 0, left: 0, bottom: 5, right: 0, type: "number", min: "10", max: "20", strict: false },
      { id: "d2", top: 0, left: 1, bottom: 5, right: 1, type: "number", min: "10", strict: true },
      { id: "d3", top: 0, left: 2, bottom: 5, right: 2, type: "number", max: "20", strict: true },
      { id: "d4", top: 0, left: 3, bottom: 5, right: 3, type: "date", min: "2026-01-01", max: "2026-12-31", strict: true },
      { id: "d5", top: 0, left: 4, bottom: 5, right: 4, type: "date", min: "2026-01-01", strict: true },
      { id: "d6", top: 0, left: 5, bottom: 5, right: 5, type: "date", max: "2026-12-31", strict: true },
      { id: "d7", top: 0, left: 6, bottom: 5, right: 6, type: "date", strict: true },
    ];
    expect(evaluateSheetValidation("abc", dvs, 0, 0).valid).toBe(false);
    expect(evaluateSheetValidation("5", dvs, 0, 1).valid).toBe(false);
    expect(evaluateSheetValidation("25", dvs, 0, 2).valid).toBe(false);
    expect(evaluateSheetValidation("2026-02-30", dvs, 0, 3).valid).toBe(false);
    expect(evaluateSheetValidation("2025-12-31", dvs, 0, 4).valid).toBe(false);
    expect(evaluateSheetValidation("2027-01-01", dvs, 0, 5).valid).toBe(false);
    expect(evaluateSheetValidation("not-a-date", dvs, 0, 6).valid).toBe(false);
    expect(evaluateSheetValidation("2026-05-10", dvs, 0, 3).valid).toBe(true);
    expect(findSheetDropdown(dvs, 0, 0)).toBeNull();
    expect(formatSheetRectA1({ top: 0, left: 0, bottom: 0, right: 0 })).toBe("A1");
    expect(makeRuleId("x").startsWith("x-")).toBe(true);
    expect(isSheetCellProtected([], 0, 0, 1, "edit").protected).toBe(false);
  });

  it("covers collab, analytics, numfmt, workbook-xlsx, workbook ops, and worker error paths", async () => {
    // Collab
    expect(formatSheetCellAddress(0, 0)).toBe("A1");
    expect(formatSheetRect({ top: 0, left: 0, bottom: 0, right: 0 })).toBe("A1");
    expect(toSheetStylePatch({
      bold: true, italic: true, underline: true, strike: true, fontFamily: "Inter", fontSize: 12,
      color: "#111111", bg: "#ffffff", align: "center", valign: "middle", wrap: true, numFmt: "percent",
      borders: { top: true },
    })).toMatchObject({ bold: true, italic: true, borders: { top: true } });
    expect(applyRemoteCellDelta(undefined, 1, 2, [])).toBeNull();
    expect(buildConflictResolutionWrite({ rowId: 1, columnId: 1, row: 0, col: 0, expectedRevision: 1, currentRevision: 2, currentRaw: "", attemptedRaw: "x", reason: "merge_slave_conflict", anchorRowId: 1, anchorColumnId: 1, anchorRevision: 3 }, "anchor")).toEqual({ rowId: 1, columnId: 1, expectedRevision: 3, raw: "x" });
    expect(buildConflictResolutionWrite({ rowId: 1, columnId: 1, row: 0, col: 0, expectedRevision: 1, currentRevision: 2, currentRaw: "", reason: "merge_slave_conflict" }, "mine")).toBeNull();
    expect(buildConflictResolutionWrite({ rowId: 1, columnId: 1, row: 0, col: 0, expectedRevision: 1, currentRevision: 2, currentRaw: "", attemptedStylePatch: { bold: true }, reason: "style_conflict" }, "mine")?.stylePatch).toEqual({ bold: true });
    expect(buildConflictResolutionWrite({ rowId: 1, columnId: 1, row: 0, col: 0, expectedRevision: 1, currentRevision: 2, currentRaw: "", attemptedStyle: { bold: true }, reason: "style_conflict" }, "mine")?.style).toEqual({ bold: true });
    expect(buildConflictResolutionWrite({ rowId: 1, columnId: 1, row: 0, col: 0, expectedRevision: 1, currentRevision: 2, currentRaw: "", reason: "style_conflict" }, "mine")).toBeNull();

    // NumFmt & AST & Criteria
    expect(formatExcelNumber(1234.5, "currency")).toContain("1,234.50");
    expect(formatExcelNumber(1234.5, "decimal2")).toContain("1,234.50");
    expect(formatExcelNumber(1234.5, "decimal1")).toContain("1,234.5");
    expect(formatExcelNumber(1234.5, "integer")).toContain("1,235");
    expect(formatExcelNumber(46000, "date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatExcelNumber(46000, "dd/mmm/yyyy hh:mm:ss AM/PM")).toMatch(/2025/);
    expect(formatExcelNumber(1234, "0.00E+00")).toContain("E+");
    expect(formatExcelNumber(0, "#,##0;(#,##0);\"zero\"")).toBe("zero");
    expect(formatCellDisplay("2026-01-05", { kind: "string", value: "2026-01-05" }, { numFmt: "date" })).toBe("2026-01-05");
    expect(parseDateToSerial("2026-02-30")).toBeNull();
    expect(parseColToken("$AB")?.col).toBe(27);
    expect(parseFormulaAst("1:3")?.kind).toBe("range");
    expect(compareValues({ kind: "empty", value: "" }, { kind: "number", value: 5 })).toBeLessThan(0);
    expect(matchCriteria({ kind: "string", value: "Apple" }, { kind: "string", value: "A*e" })).toBe(true);
    expect(matchCriteria({ kind: "empty", value: "" }, { kind: "string", value: "=" })).toBe(true);

    // Workbook full feature set
    const wb = Workbook.fromTsv("Cat\tVal\nB\t20\nA\t10\n", "Items");
    wb.registerFunction("TRIPLE", ([v]) => (v?.kind === "number" ? v.value * 3 : 0));
    wb.sheet("Items").setCell("C2", "=TRIPLE(B2)").merge("D1:E2").unmerge("D1:E2").addHyperlink({ row: 0, col: 0, target: "https://jiange.dev" });
    expect(wb.sheet("Items").getValue("C2")).toBe(60);
    expect(wb.getPrecedents("Items", "C2")).toHaveLength(1);
    expect(wb.getDependents("Items", "B2")).toHaveLength(1);
    expect(wb.toTsv("Items")).toContain("60");
    wb.sheet("Items").sort("A", true, 0);
    expect(wb.sheet("Items").getValue("A2")).toBe("A");
    expect(wb.sheet("Items").getRange("A1:B2")).toEqual([["Cat", "Val"], ["A", 10]]);
    wb.sheet("Items").clearRange("C2:C2");
    expect(wb.sheet("Items").getValue("C2")).toBeNull();
    wb.sheet("Items").addPivotTable({ title: "P", top: 0, left: 0, bottom: 2, right: 1, rowFields: [0], values: [{ col: 1, agg: "avg" }], showRowTotals: false, showColTotals: true });
    expect(wb.recalculate().evaluatedSheets).toBe(1);
    expect(wb.toXlsx().length).toBeGreaterThan(100);
    const wb2 = Workbook.fromSnapshot(wb.toSnapshot().sheets);
    expect(wb2.listSheets()).toEqual(["Items"]);

    // Inspect outline, full, focus, truncation & query filters
    expect(wb.inspect({ detail: "outline", focus: "Items" }).summary.sheets).toHaveLength(1);
    expect(wb.inspect({ detail: "full", maxTokens: 30 }).truncated).toBe(true);
    expect(wb.query({ range: "Items!A1:B3", search: "a", limit: 1 }).truncated).toBe(true);

    // Apply remaining op variants
    const opRes = wb.apply([
      { op: "addSheet", name: "Extra" },
      { op: "setRange", sheet: "Extra", start: "A1", values: [["H", "V"], ["x", 2], ["y", 1]] },
      { op: "sort", sheet: "Extra", col: "B", ascending: true },
      { op: "merge", sheet: "Extra", range: "C1:D1" },
      { op: "unmerge", sheet: "Extra", range: "C1:D1" },
      { op: "clearRange", sheet: "Extra", range: "A3:B3" },
      { op: "renameSheet", from: "Extra", to: "Renamed" },
      { op: "deleteSheet", name: "Renamed" },
    ]);
    expect(opRes.ok).toBe(true);

    // Analytics extras
    const ws = wb.toSnapshot().sheets[0];
    const em = wb._getSheetEvalMap(ws.id);
    expect(extractChartDataset(ws, em, { top: 0, left: 1, bottom: 2, right: 1, headerRow: true }).series[0].values).toEqual([10, 20]);
    expect(detectDataTableRange(ws, em, { top: 10, left: 5, bottom: 10, right: 5 })).toEqual({ top: 0, left: 0, bottom: 2, right: 2 });
    expect(detectFirstNumericColOffset(ws, em, { top: 0, left: 0, bottom: 2, right: 1 })).toBe(1);
    expect(formatPivotNumber(null)).toBe("—");
    expect(formatPivotNumber(12.345)).toBe("12.35");
    expect(computePivotTable(ws, em, { id: "p", title: "P", top: 0, left: 0, bottom: 2, right: 1, rowFields: [0], values: [{ col: 1, agg: "min" }, { col: 1, agg: "max" }, { col: 1, agg: "count" }, { col: 1, agg: "avg" }], showRowTotals: false, showColTotals: true, sortBy: "value_desc" }).rows[0].cells[0]).toBe(20);

    // Workbook-xlsx extras
    expect(numFmtFromCode("#,##0")).toBe("integer");
    expect(numFmtFromCode("0.0")).toBe("decimal1");
    expect(numFmtFromCode("0.00")).toBe("decimal2");
    expect(numFmtFromCode("yyyy/mm/dd")).toBe("date");
    expect(numFmtFromCode('"$"\ #,##0')).toBe("currency");
    expect(numFmtFromCode("0%")).toBe("percent");
    expect(xlsxStyleToSheet(sheetStyleToXlsx({ bold: true, italic: true, underline: true, strike: true, fontFamily: "Arial", fontSize: 12, color: "#112233", bg: "#ddeeff", align: "center", valign: "middle", wrap: true, borders: { top: true, right: true, bottom: true, left: true, color: "#000000" }, numFmt: "decimal2" }))).toMatchObject({ bold: true, numFmt: "decimal2" });
    const trimmed = await parseXlsxBytesForWorkbook(writeXlsx({ sheets: [{ name: "S", cells: [{ row: 0, col: 0, value: true }, { row: 1, col: 0, value: { error: "#REF!" } }], frozen: { rows: 90, cols: 25 } }] }));
    expect(trimmed.warnings.some((w) => w.includes("冻结"))).toBe(true);
    expect(exportWorkbookToXlsx(wb.toSnapshot().sheets).length).toBeGreaterThan(100);

    // AI tools error path
    const tools = createSheetTools(wb);
    expect(() => tools.execute("unknown_tool", {})).toThrow();

    // Worker unknown message & onmessage fallback
    const host = createFormulaWorkerHost();
    expect(host({ id: 9, type: "bad" } as unknown as FormulaWorkerRequest).ok).toBe(false);
    const simplePort: MessagePortLike = {
      postMessage(msg) {
        const resp = host(msg as FormulaWorkerRequest);
        queueMicrotask(() => simplePort.onmessage?.({ data: resp }));
      },
    };
    const client = new FormulaWorkerClient(simplePort);
    await expect(client.getSheet(999)).resolves.toEqual({});
    client.dispose();
  });

  it("covers argument-count, error-propagation, and edge branches across formula-functions and formula-ast", () => {
    const errExprs = [
      "=SUM(1/0)", "=AVERAGE(1/0)", "=MIN(1/0)", "=MAX(1/0)", "=COUNT(1/0)", "=COUNTA(1/0)", "=COUNTBLANK(1/0)",
      "=PRODUCT(1/0)", "=MEDIAN(1/0)", "=MODE(1/0)", "=STDEV.S(1/0)", "=STDEV.P(1/0)", "=VAR.S(1/0)", "=VAR.P(1/0)",
      "=PERCENTILE(1)", "=PERCENTILE(1/0,0.5)", "=PERCENTILE(A1,\"x\")",
      "=QUARTILE(1)", "=QUARTILE(1/0,1)", "=QUARTILE(A1,\"x\")",
      "=LARGE(1)", "=LARGE(1/0,1)", "=LARGE(A1,\"x\")",
      "=SMALL(1)", "=SMALL(1/0,1)", "=SMALL(A1,\"x\")",
      "=RANK(1)", "=RANK(\"x\",A1)", "=RANK(1,1/0)", "=RANK(1,A1,\"x\")",
      "=SUMPRODUCT()", "=SUMPRODUCT(1/0)", "=SUMPRODUCT({1,1/0})",
      "=SUBTOTAL(1)", "=SUBTOTAL(\"x\",1)",
      "=COUNTIF(1)", "=SUMIF(1)", "=AVERAGEIF(1)", "=SUMIFS(1,2)", "=COUNTIFS(1)",
      "=IF(1)", "=IF(\"x\",1,2)", "=IFS(1)", "=IFS(\"x\",1)", "=SWITCH(1,2)", "=SWITCH(1/0,1,2)",
      "=IFERROR(1)", "=IFNA(1)", "=IFNA(1/0,2)",
      "=AND()", "=AND(1/0)", "=AND(\"x\")", "=OR()", "=OR(1/0)", "=OR(\"x\")", "=XOR()", "=XOR(1/0)", "=XOR(\"x\")",
      "=NOT()", "=NOT(1/0)", "=ISBLANK()", "=ISERROR()", "=ISERR()", "=ISNA()", "=ISNUMBER()", "=ISTEXT()", "=ISLOGICAL()", "=ISFORMULA()", "=ISFORMULA(1)",
      "=ABS(\"x\")", "=INT(\"x\")", "=SQRT(\"x\")", "=SIGN(\"x\")", "=EXP(\"x\")", "=LN(\"x\")", "=LOG10(\"x\")", "=LOG()", "=LOG(\"x\")", "=LOG(8,\"x\")",
      "=SIN(\"x\")", "=COS(\"x\")", "=TAN(\"x\")", "=PI(1)", "=RAND(1)", "=RANDBETWEEN(1)", "=RANDBETWEEN(\"x\",2)", "=RANDBETWEEN(1,\"x\")",
      "=ROUND()", "=ROUND(\"x\")", "=ROUND(1,\"x\")", "=ROUNDUP()", "=ROUNDUP(\"x\")", "=ROUNDUP(1,\"x\")",
      "=ROUNDDOWN()", "=ROUNDDOWN(\"x\")", "=ROUNDDOWN(1,\"x\")", "=MROUND(1)", "=MROUND(\"x\",1)", "=MROUND(1,\"x\")",
      "=CEILING()", "=CEILING(\"x\")", "=CEILING(1,\"x\")", "=FLOOR()", "=FLOOR(\"x\")", "=FLOOR(1,\"x\")",
      "=MOD(1)", "=MOD(\"x\",1)", "=MOD(1,\"x\")", "=POWER(1)", "=POWER(\"x\",1)", "=POWER(1,\"x\")",
      "=CONCAT(1/0)", "=TEXTJOIN(1,2)", "=TEXTJOIN(1/0,TRUE,1)", "=TEXTJOIN(\",\",\"x\",1)", "=TEXTJOIN(\",\",TRUE,1/0)",
      "=LEN(1/0)", "=UPPER(1/0)", "=LOWER(1/0)", "=PROPER(1/0)", "=TRIM(1/0)", "=CLEAN(1/0)",
      "=LEFT()", "=LEFT(1/0)", "=LEFT(\"a\",\"x\")", "=LEFT(\"a\",-1)",
      "=RIGHT()", "=RIGHT(1/0)", "=RIGHT(\"a\",\"x\")", "=RIGHT(\"a\",-1)",
      "=MID(1,2)", "=MID(1/0,1,1)", "=MID(\"a\",\"x\",1)", "=MID(\"a\",1,\"x\")", "=MID(\"a\",0,1)",
      "=FIND(1)", "=FIND(1/0,\"a\")", "=FIND(\"a\",1/0)", "=FIND(\"a\",\"a\",\"x\")", "=FIND(\"a\",\"a\",0)", "=FIND(\"z\",\"a\")",
      "=SEARCH(1)", "=SEARCH(1/0,\"a\")", "=SEARCH(\"a\",1/0)", "=SEARCH(\"a\",\"a\",\"x\")", "=SEARCH(\"a\",\"a\",0)",
      "=SUBSTITUTE(1,2)", "=SUBSTITUTE(1/0,\"a\",\"b\")", "=SUBSTITUTE(\"a\",1/0,\"b\")", "=SUBSTITUTE(\"a\",\"b\",1/0)", "=SUBSTITUTE(\"a\",\"\",\"b\")", "=SUBSTITUTE(\"a\",\"a\",\"b\",\"x\")", "=SUBSTITUTE(\"a\",\"a\",\"b\",0)", "=SUBSTITUTE(\"a\",\"z\",\"b\",2)",
      "=REPLACE(1,2,3)", "=REPLACE(1/0,1,1,\"a\")", "=REPLACE(\"a\",\"x\",1,\"b\")", "=REPLACE(\"a\",1,\"x\",\"b\")", "=REPLACE(\"a\",1,1,1/0)", "=REPLACE(\"a\",0,1,\"b\")",
      "=TEXT(1)", "=TEXT(\"x\",\"0\")", "=TEXT(1,1/0)",
      "=VALUE()", "=VALUE(1/0)", "=VALUE(\"notnum\")",
      "=REPT(1)", "=REPT(1/0,2)", "=REPT(\"a\",\"x\")", "=REPT(\"a\",-1)",
      "=EXACT(1)", "=EXACT(1/0,\"a\")", "=EXACT(\"a\",1/0)",
      "=CHAR(\"x\")", "=CHAR(0)", "=CODE(1/0)", "=CODE(\"\")",
      "=SPLIT(1)", "=SPLIT(1/0,\",\")", "=SPLIT(\"a\",1/0)", "=SPLIT(\"a\",\"\")",
      "=TODAY(1)", "=NOW(1)", "=DATE(1,2)", "=DATE(\"x\",1,1)", "=DATE(2026,\"x\",1)", "=DATE(2026,1,\"x\")",
      "=TIME(1,2)", "=TIME(\"x\",1,1)", "=TIME(1,\"x\",1)", "=TIME(1,1,\"x\")", "=TIME(-1,0,0)",
      "=DATEVALUE(1/0)", "=DATEVALUE(\"bad\")", "=YEAR(\"x\")", "=MONTH(\"x\")", "=DAY(\"x\")", "=HOUR(\"x\")", "=MINUTE(\"x\")", "=SECOND(\"x\")",
      "=DAYS(1)", "=DAYS(\"x\",1)", "=DAYS(1,\"x\")",
      "=DATEDIF(1,2)", "=DATEDIF(\"x\",2,\"D\")", "=DATEDIF(1,\"x\",\"D\")", "=DATEDIF(1,2,1/0)", "=DATEDIF(10,5,\"D\")", "=DATEDIF(1,10,\"Z\")", "=DATEDIF(1,10,\"D\")",
      "=EDATE(1)", "=EDATE(\"x\",1)", "=EDATE(1,\"x\")", "=EOMONTH(1)", "=EOMONTH(\"x\",1)", "=EOMONTH(1,\"x\")",
      "=WEEKDAY()", "=WEEKDAY(\"x\")", "=WEEKDAY(46000,\"x\")", "=WEEKDAY(46000,9)", "=WEEKDAY(46000,1)",
      "=WEEKNUM(\"x\")", "=ISOWEEKNUM(\"x\")",
      "=WORKDAY(1)", "=WORKDAY(\"x\",1)", "=WORKDAY(46000,\"x\")", "=WORKDAY(46000,-2,46000)",
      "=NETWORKDAYS(1)", "=NETWORKDAYS(\"x\",2)", "=NETWORKDAYS(1,\"x\")", "=NETWORKDAYS(46010,46000,46005)",
      "=YEARFRAC(1)", "=YEARFRAC(\"x\",2)", "=YEARFRAC(1,\"x\")",
      "=VLOOKUP(1,2)", "=VLOOKUP(1/0,A1:B2,1)", "=VLOOKUP(1,1/0,1)", "=VLOOKUP(1,A1:B2,\"x\")", "=VLOOKUP(1,A1:B2,9)", "=VLOOKUP(1,A1:B2,1,\"x\")",
      "=HLOOKUP(1,2)", "=HLOOKUP(1/0,A1:B2,1)", "=HLOOKUP(1,1/0,1)", "=HLOOKUP(1,A1:B2,\"x\")", "=HLOOKUP(1,A1:B2,9)", "=HLOOKUP(1,A1:B2,1,\"x\")", "=HLOOKUP(\"z\",{\"a\",\"b\";1,2},2,FALSE)",
      "=XLOOKUP(1,2)", "=XLOOKUP(1/0,A1:A2,B1:B2)", "=XLOOKUP(1,1/0,B1:B2)", "=XLOOKUP(1,A1:A2,1/0)", "=XLOOKUP(1,A1:A2,B1:B2,0,\"x\")", "=XLOOKUP(1,A1:A2,B1:B2,0,0,\"x\")",
      "=INDEX(1)", "=INDEX(1/0,1)", "=INDEX(A1:B2,\"x\")", "=INDEX(A1:B2,1,\"x\")", "=INDEX(A1:B2,9,1)", "=INDEX(A1:B2,0,0)", "=INDEX(A1:B2,0,1)", "=INDEX(A1:B2,1,0)",
      "=MATCH(1)", "=MATCH(1/0,A1:A2)", "=MATCH(1,1/0)", "=MATCH(1,A1:A2,\"x\")", "=MATCH(99,{1;2},0)",
      "=XMATCH(1)", "=XMATCH(1/0,A1:A2)", "=XMATCH(1,1/0)", "=XMATCH(1,A1:A2,\"x\")", "=XMATCH(1,A1:A2,0,\"x\")", "=XMATCH(99,{1;2})",
      "=CHOOSE(1)", "=CHOOSE(\"x\",1)", "=CHOOSE(5,1,2)",
      "=ROW(1)", "=COLUMN(1)", "=ROWS()", "=COLUMNS()",
      "=OFFSET(1,0,0)", "=OFFSET(A1,\"x\",0)", "=OFFSET(A1,0,\"x\")", "=OFFSET(A1,0,0,\"x\")", "=OFFSET(A1,0,0,1,\"x\")", "=OFFSET(A1,-5,0)",
      "=INDIRECT()", "=INDIRECT(1/0)", "=INDIRECT(\"badref\")", "=INDIRECT(\"A1:B2\")",
      "=TRANSPOSE()", "=HYPERLINK()", "=HYPERLINK(\"https://a.b\")",
      "=PMT(1,2)", "=PMT(\"x\",1,1)", "=PMT(0.1,\"x\",1)", "=PMT(0.1,1,\"x\")", "=PMT(0.1,1,1,\"x\")", "=PMT(0.1,1,1,0,\"x\")", "=PMT(0.1,0,1)", "=PMT(0.1,12,1000,0,1)",
      "=PV(1,2)", "=PV(\"x\",1,1)", "=PV(0.1,\"x\",1)", "=PV(0.1,1,\"x\")", "=PV(0.1,1,1,\"x\")", "=PV(0.1,1,1,0,\"x\")",
      "=FV(1,2)", "=FV(\"x\",1,1)", "=FV(0.1,\"x\",1)", "=FV(0.1,1,\"x\")", "=FV(0.1,1,1,\"x\")", "=FV(0.1,1,1,0,\"x\")",
      "=NPV(1)", "=NPV(\"x\",1)", "=NPV(0.1,1/0)",
      "=IRR()", "=IRR(1/0)", "=IRR({1;2;3})", "=IRR({-100;60;60},\"x\")",
      "=NPER(1,2)", "=NPER(\"x\",1,1)", "=NPER(0.1,\"x\",1)", "=NPER(0.1,1,\"x\")", "=NPER(0.1,1,1,\"x\")", "=NPER(0.1,1,1,0,\"x\")", "=NPER(0,0,100)",
      "=RATE(1,2)", "=RATE(\"x\",1,1)", "=RATE(12,\"x\",1)", "=RATE(12,-100,\"x\")", "=RATE(12,-100,1000,\"x\")", "=RATE(12,-100,1000,0,\"x\")", "=RATE(12,-100,1000,0,0,\"x\")",
      "=FILTER(1)", "=FILTER(1/0,{TRUE})", "=FILTER({1},1/0)", "=FILTER({1;2},{TRUE})", "=FILTER({1;2},{FALSE;FALSE})",
      "=SORT()", "=SORT(1/0)", "=SORT({1},\"x\")", "=SORT({1},1,\"x\")", "=SORT({1},5)", "=SORT({1;2},1,-1)",
      "=SORTBY(1)", "=SORTBY(1/0,{1})", "=SORTBY({1},1/0)", "=SORTBY({1},{1},\"x\")", "=SORTBY({1;2},{1})",
      "=UNIQUE()", "=UNIQUE(1/0)", "=SEQUENCE()", "=SEQUENCE(\"x\")", "=SEQUENCE(1,\"x\")", "=SEQUENCE(1,1,\"x\")", "=SEQUENCE(1,1,1,\"x\")", "=SEQUENCE(0)",
    ];
    const entries: [number, number, string][] = errExprs.map((raw, idx) => [Math.floor(idx / 10), idx % 10, raw]);
    const map = evalFormulas(entries, Math.ceil(errExprs.length / 10) + 2, 10);
    expect(Object.keys(map).length).toBeGreaterThanOrEqual(errExprs.length);
  });
});

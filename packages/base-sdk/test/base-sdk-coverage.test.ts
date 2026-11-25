import { describe, expect, it } from "vitest";
import {
  Base,
  FUNCS,
  computeGroupedSeries,
  computeMetricSummary,
  computeSelectionStats,
  createBaseTools,
  defaultDashboardWidgets,
  evalFormula,
  evalNode,
  evalRecordFormulas,
  evaluateFilterRule,
  exportTableToCsv,
  formatCellText,
  isGroupableField,
  isNumericField,
  matchFillRule,
  parseCsvToTableData,
  parseDelimitedRows,
  queryRecords,
  type BaseCell,
  type BaseField,
  type BaseOp,
  type BaseRecord,
} from "../src/index.js";

describe("@zseven-w/base-sdk full branch coverage", () => {
  it("covers all formula tokenizer, parser, evaluator, FUNCS, and dependency edge cases", () => {
    // Default env when omitted
    expect(evalFormula("[Missing]")).toBeNull();
    expect(evalFormula('LOWER("HeLLo")')).toBe("hello");

    // Tokenizer errors & <> operator
    expect(() => evalFormula("1.2.3")).toThrow("#NUM?");
    expect(() => evalFormula('"unterminated')).toThrow("#SYNTAX");
    expect(() => evalFormula("[unterminated")).toThrow("#SYNTAX");
    expect(() => evalFormula("1 @ 2")).toThrow("#SYNTAX");
    expect(evalFormula("1 <> 2")).toBe(true);
    expect(evalFormula("2 <> 2")).toBe(false);

    // Unary + and parser error cases
    expect(evalFormula("+5")).toBe(5);
    expect(evalFormula("-5")).toBe(-5);
    expect(() => evalFormula("ABS(1 2)")).toThrow("#SYNTAX");
    expect(() => evalFormula("BARE_IDENT")).toThrow("#NAME?");
    expect(() => evalFormula("(1 2)")).toThrow("#SYNTAX");
    expect(() => evalFormula("* 1")).toThrow("#SYNTAX");
    expect(() => evalFormula("1 2")).toThrow("#SYNTAX");

    // Coercions: num(), str(), bool()
    expect(evalFormula("TRUE + FALSE")).toBe(1);
    expect(() => evalFormula('1 + "abc"')).toThrow("#VALUE?");
    expect(() => evalFormula('1 + ""')).toThrow("#VALUE?");
    expect(() => evalFormula("1 + BLANK()")).toThrow("#VALUE?");
    expect(evalFormula("TEXT(BLANK())")).toBe("");
    expect(evalFormula("TEXT(TRUE) & TEXT(FALSE)")).toBe("TRUEFALSE");
    expect(evalFormula("AND(1, 0)")).toBe(false);
    expect(evalFormula('AND("x", "")')).toBe(false);
    expect(evalFormula("AND(BLANK())")).toBe(false);

    // Function edge cases
    expect(evalFormula("ROUND(3.6)")).toBe(4);
    expect(evalFormula("ROUND(3.456, 2)")).toBe(3.46);
    expect(() => evalFormula("MOD(10, 0)")).toThrow("#DIV/0!");
    expect(() => evalFormula("AVERAGE()")).toThrow("#DIV/0!");
    expect(evalFormula('ISBLANK("")')).toBe(true);
    expect(evalFormula('ISBLANK("ok")')).toBe(false);
    expect(evalFormula('RIGHT("Hi", 10)')).toBe("Hi");
    expect(evalFormula('VALUE("")')).toBe(0);
    expect(evalFormula("VALUE(BLANK())")).toBe(0);

    // FUNCS.IF & FUNCS.IFS direct calls
    expect(FUNCS.IF([true, "yes", "no"])).toBe("yes");
    expect(FUNCS.IF([false, "yes", "no"])).toBe("no");
    expect(FUNCS.IF([false, "yes"])).toBeNull();
    expect(FUNCS.IFS([false, "a", true, "b"])).toBe("b");
    expect(FUNCS.IFS([false, "a", "fallback"])).toBe("fallback");
    expect(FUNCS.IFS([false, "a"])).toBeNull();

    // All string & numeric comparison operators
    expect(evalFormula('"a" = "a"')).toBe(true);
    expect(evalFormula('"a" != "b"')).toBe(true);
    expect(evalFormula('"a" < "b"')).toBe(true);
    expect(evalFormula('"a" <= "a"')).toBe(true);
    expect(evalFormula('"b" > "a"')).toBe(true);
    expect(evalFormula('"b" >= "b"')).toBe(true);

    expect(evalFormula("5 = 5")).toBe(true);
    expect(evalFormula("5 != 4")).toBe(true);
    expect(evalFormula("4 < 5")).toBe(true);
    expect(evalFormula("5 <= 5")).toBe(true);
    expect(evalFormula("6 > 5")).toBe(true);
    expect(evalFormula("5 >= 5")).toBe(true);

    // Arithmetic binary ops & invalid op in evalNode
    expect(evalFormula("10 - 3")).toBe(7);
    expect(evalFormula("10 / 2")).toBe(5);
    expect(evalFormula("10 % 3")).toBe(1);
    expect(() => evalFormula("10 % 0")).toThrow("#DIV/0!");
    expect(() =>
      evalNode(
        { t: "bin", op: "??", l: { t: "lit", v: 1 }, r: { t: "lit", v: 2 } },
        { get: () => null },
      ),
    ).toThrow("#SYNTAX");

    // IF / IFS short-circuit branches
    expect(() => evalFormula("IF(TRUE)")).toThrow("#SYNTAX");
    expect(evalFormula("IF(FALSE, 1, 2)")).toBe(2);
    expect(evalFormula("IF(FALSE, 1)")).toBeNull();
    expect(evalFormula('IFS(FALSE, "a", "default")')).toBe("default");
    expect(evalFormula('IFS(FALSE, "a", FALSE, "b")')).toBeNull();

    // evalRecordFormulas: cellToFormulaValue branches, cached formula reuse, overrides, missing ref, empty expr, non-FormulaError catch
    const fields: BaseField[] = [
      { id: 1, tableId: 1, name: "Bool", type: "checkbox", position: 1000 },
      { id: 2, tableId: 1, name: "Tags", type: "multi_select", position: 2000 },
      { id: 3, tableId: 1, name: "EmptyArr", type: "multi_select", position: 3000 },
      { id: 4, tableId: 1, name: "Files", type: "attachment", position: 4000 },
      { id: 5, tableId: 1, name: "WeirdObj", type: "text", position: 5000 },
      { id: 6, tableId: 1, name: "NullArr", type: "text", position: 6000 },
      { id: 7, tableId: 1, name: "ObjNoName", type: "text", position: 7000 },
      { id: 8, tableId: 1, name: "LookupVal", type: "lookup", position: 8000 },
      { id: 9, tableId: 1, name: "EmptyFormula", type: "formula", position: 9000 },
      { id: 10, tableId: 1, name: "BlankFormula", type: "formula", formula: "BLANK()", position: 10000 },
      { id: 11, tableId: 1, name: "BaseVal", type: "formula", formula: "10 + 5", position: 11000 },
      {
        id: 12,
        tableId: 1,
        name: "Combined",
        type: "formula",
        formula:
          'TEXT([Bool]) & "|" & [Tags] & "|" & [EmptyArr] & "|" & [Files] & "|" & TEXT([WeirdObj]) & "|" & [NullArr] & "|" & [ObjNoName] & "|" & [LookupVal] & "|" & TEXT([MissingRef]) & "|" & TEXT([BlankFormula]) & "|" & TEXT([BaseVal] + [BaseVal])',
        position: 12000,
      },
      { id: 13, tableId: 1, name: "BoomField", type: "text", position: 13000 },
      { id: 14, tableId: 1, name: "BoomFormula", type: "formula", formula: "[BoomField]", position: 14000 },
      { id: 15, tableId: 1, name: "UnsetField", type: "text", position: 15000 },
      { id: 16, tableId: 1, name: "UnsetFormula", type: "formula", formula: "ISBLANK([UnsetField])", position: 16000 },
    ];
    const cells: Record<string, BaseCell> = {
      "1": true,
      "2": ["alpha", "beta"],
      "3": [],
      "4": [
        { id: 1, name: "spec.pdf", mime: "application/pdf", size: 100 },
        "raw-item" as unknown as { id: number; name: string; mime: string; size: number },
        null as unknown as { id: number; name: string; mime: string; size: number },
        {} as unknown as { id: number; name: string; mime: string; size: number },
      ],
      "5": { custom: 1 } as unknown as BaseCell,
      "6": [null] as unknown as BaseCell,
      "7": [{}] as unknown as BaseCell,
    };
    Object.defineProperty(cells, "13", {
      enumerable: true,
      get() {
        throw new Error("unexpected getter error");
      },
    });
    const rec: BaseRecord = { id: 1, baseId: 1, tableId: 1, cells, position: 1000 };
    const out = evalRecordFormulas(rec, fields, { 8: "FromLookup" });
    expect(out[9]).toBeNull();
    expect(out[10]).toBeNull();
    expect(out[11]).toBe(15);
    expect(out[12]).toBe(
      "TRUE|alpha, beta||spec.pdf, raw-item, null, [object Object]|||[object Object]|FromLookup|||30",
    );
    expect(out[14]).toBe("#ERROR");
    expect(out[16]).toBe(true);
  });

  it("covers all CSV export and parser branches", () => {
    // exportTableToCsv position tie-breaker (same position -> id order)
    const fields: BaseField[] = [
      { id: 2, tableId: 1, name: "Second", type: "text", position: 1000 },
      { id: 1, tableId: 1, name: "First", type: "text", position: 1000 },
    ];
    const csv = exportTableToCsv(fields, []);
    expect(csv).toBe("First,Second");

    // parseDelimitedRows: escaped quotes, CRLF, standalone CR, trailing newline, blank comma row
    expect(parseDelimitedRows('"a""b",c\r\nd,e\rf,g\n')).toEqual([
      ['a"b', "c"],
      ["d", "e"],
      ["f", "g"],
    ]);
    expect(parseDelimitedRows("a,b\n,,\n,,")).toEqual([["a", "b"]]);

    // parseCsvToTableData: empty input, blank header fallback, jagged rows, all-empty col, text col, whitespace in numeric col, huge overflow number
    expect(parseCsvToTableData("")).toEqual({ fields: [], rows: [] });
    const parsed = parseCsvToTableData(
      `Name,,EmptyCol,Notes,NumCol,HugeNum\nAlice,v1,,hello,10,99\nBob,v2,,world,"   ",${"9".repeat(400)}\nShort`,
    );
    expect(parsed.fields.map((f) => [f.name, f.type])).toEqual([
      ["Name", "text"],
      ["Field 2", "text"],
      ["EmptyCol", "text"],
      ["Notes", "text"],
      ["NumCol", "number"],
      ["HugeNum", "number"],
    ]);
    expect(parsed.rows[0].NumCol).toBe(10);
    expect(parsed.rows[1].NumCol).toBe("");
    expect(parsed.rows[1].HugeNum).toBe("9".repeat(400));
    expect(parsed.rows[2]).toEqual({ Name: "Short" });
  });

  it("covers all query, filter, sort, groupBy, fill, and selection stats branches", () => {
    // formatCellText: attachment array, null/object in array, unknown non-array object
    expect(
      formatCellText([
        { id: 1, name: "a.png", mime: "image/png", size: 10 },
        null as unknown as { id: number; name: string; mime: string; size: number },
        {} as unknown as { id: number; name: string; mime: string; size: number },
        "plain" as unknown as { id: number; name: string; mime: string; size: number },
      ]),
    ).toBe("a.png, null, [object Object], plain");
    expect(formatCellText({ weird: true } as unknown as BaseCell)).toBe("");

    // evaluateFilterRule: array eq (array & scalar), undefined cell/v, string contains/in, string gt/gte/lt/lte, empty string comparison, unknown op
    const recArr: BaseRecord = {
      id: 1,
      baseId: 1,
      tableId: 1,
      position: 1000,
      cells: {
        "1": ["A", "B"],
        "2": "2026-05-10",
        "3": "hello world",
        "4": NaN,
        "5": "   ",
        "6": "not-a-num",
        "7": "42.5",
      },
    };
    const recEmpty: BaseRecord = { id: 2, baseId: 1, tableId: 1, position: 2000, cells: {} };

    expect(evaluateFilterRule(recArr, { f: 1, op: "eq", v: ["A", "B"] })).toBe(true);
    expect(evaluateFilterRule(recArr, { f: 1, op: "eq", v: ["A"] })).toBe(false);
    expect(evaluateFilterRule(recArr, { f: 1, op: "eq", v: "B" })).toBe(true);
    expect(evaluateFilterRule(recArr, { f: 1, op: "eq", v: "Z" })).toBe(false);
    expect(evaluateFilterRule(recEmpty, { f: 99, op: "eq" })).toBe(true);

    expect(evaluateFilterRule(recArr, { f: 3, op: "contains", v: "WORLD" })).toBe(true);
    expect(evaluateFilterRule(recArr, { f: 3, op: "contains" })).toBe(true);

    expect(evaluateFilterRule(recArr, { f: 3, op: "in", v: "hello world" })).toBe(true);
    expect(evaluateFilterRule(recEmpty, { f: 99, op: "in" })).toBe(true);

    // Numeric string comparison via toNumeric + non-numeric string / NaN / whitespace fallback to string cmp
    expect(evaluateFilterRule(recArr, { f: 7, op: "gt", v: "40" })).toBe(true);
    expect(evaluateFilterRule(recArr, { f: 4, op: "gt", v: "10" })).toBe(true); // "NaN" > "10"
    expect(evaluateFilterRule(recArr, { f: 5, op: "gt", v: " " })).toBe(true);
    expect(evaluateFilterRule(recArr, { f: 6, op: "gt", v: "a" })).toBe(true);
    expect(evaluateFilterRule(recArr, { f: 2, op: "gt", v: "2026-01-01" })).toBe(true);
    expect(evaluateFilterRule(recArr, { f: 2, op: "gte", v: "2026-05-10" })).toBe(true);
    expect(evaluateFilterRule(recArr, { f: 2, op: "lt", v: "2026-12-01" })).toBe(true);
    expect(evaluateFilterRule(recArr, { f: 2, op: "lte", v: "2026-05-10" })).toBe(true);
    expect(evaluateFilterRule(recArr, { f: 2, op: "gt" })).toBe(true);
    expect(evaluateFilterRule(recEmpty, { f: 2, op: "gt", v: "a" })).toBe(false);

    // Unknown operator defaults to true
    expect(evaluateFilterRule(recArr, { f: 1, op: "custom_op" })).toBe(true);

    // matchFillRule undefined & empty
    expect(matchFillRule(recArr, undefined)).toBeNull();
    expect(matchFillRule(recArr, [])).toBeNull();

    // queryRecords sorting across rating, number (with non-numeric fallback), checkbox, select (with & without options, unknown option), text, empties, tie-breakers
    const fields: BaseField[] = [
      { id: 1, tableId: 1, name: "Title", type: "text", position: 1000 },
      { id: 2, tableId: 1, name: "Rating", type: "rating", position: 2000 },
      { id: 3, tableId: 1, name: "Done", type: "checkbox", position: 3000 },
      { id: 4, tableId: 1, name: "Stage", type: "select", options: ["High", "Low"], position: 4000 },
      { id: 5, tableId: 1, name: "SelectNoOpts", type: "select", position: 5000 },
    ];
    const records: BaseRecord[] = [
      { id: 2, baseId: 1, tableId: 1, position: 1000, cells: { "1": "B", "2": "bad", "3": false, "4": "Low", "5": "z" } },
      { id: 1, baseId: 1, tableId: 1, position: 1000, cells: { "1": "B", "2": 5, "3": true, "4": "High", "5": "a" } },
      { id: 3, baseId: 1, tableId: 1, position: 2000, cells: { "1": "A", "2": "bad2", "3": false, "4": "Other" } },
      { id: 4, baseId: 1, tableId: 1, position: 3000, cells: {} },
      { id: 5, baseId: 1, tableId: 1, position: 4000, cells: {} },
    ];

    expect(queryRecords(records, fields, { sorts: [{ f: 2, asc: true }] }).records.map((r) => r.id)).toEqual([2, 3, 1, 4, 5]);
    expect(queryRecords(records, fields, { sorts: [{ f: 3, asc: true }] }).records.map((r) => r.id)).toEqual([2, 3, 1, 4, 5]);
    expect(queryRecords(records, fields, { sorts: [{ f: 4, asc: true }] }).records.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(queryRecords(records, fields, { sorts: [{ f: 5, asc: true }] }).records.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    // Equal values tie-break on position then id
    expect(queryRecords(records, fields, { sorts: [{ f: 1, asc: true }] }).records.map((r) => r.id)).toEqual([3, 1, 2, 4, 5]);
    // groupBy select with empty group and unknown option group
    const grouped = queryRecords(records, fields, { groupBy: 4 });
    expect(grouped.groups?.map((g) => g.key)).toEqual(["High", "Low", "Other", "__empty__"]);

    // Sort with non-empty before empty to trigger emptyB branch, and groupBy with __empty__ first & multiple unknown select options
    const emptyFirstRecs: BaseRecord[] = [
      { id: 10, baseId: 1, tableId: 1, position: 1000, cells: {} },
      { id: 11, baseId: 1, tableId: 1, position: 2000, cells: { "1": "Alpha", "4": "Unknown1" } },
      { id: 12, baseId: 1, tableId: 1, position: 3000, cells: { "1": "Beta", "4": "High" } },
      { id: 13, baseId: 1, tableId: 1, position: 4000, cells: {} },
      { id: 14, baseId: 1, tableId: 1, position: 5000, cells: { "1": "Gamma", "4": "Unknown2" } },
    ];
    expect(queryRecords(emptyFirstRecs, fields, { sorts: [{ f: 1, asc: true }] }).records.map((r) => r.id)).toEqual([
      11, 12, 14, 10, 13,
    ]);
    const grouped2 = queryRecords(emptyFirstRecs, fields, { groupBy: 4 });
    expect(grouped2.groups?.[0].key).toBe("High");
    expect(grouped2.groups?.[grouped2.groups.length - 1].key).toBe("__empty__");

    // Selection stats: no numeric, non-numeric strings, bools
    const emptyStats = computeSelectionStats(["text", undefined]);
    expect(emptyStats.sum).toBeNull();
    expect(emptyStats.checkedPct).toBeNull();
  });

  it("covers all dashboard helpers, metrics, and grouped series branches", () => {
    // isGroupableField all types & false; isNumericField (also accepts minimal { type } descriptors)
    for (const type of ["select", "multi_select", "person", "date", "checkbox", "text"] as const) {
      expect(isGroupableField({ type })).toBe(true);
    }
    expect(isGroupableField({ id: 1, tableId: 1, name: "N", type: "number", position: 1000 })).toBe(false);
    expect(isNumericField({ type: "rating" })).toBe(true);
    expect(isNumericField({ id: 1, tableId: 1, name: "T", type: "text", position: 1000 })).toBe(false);

    // defaultDashboardWidgets without numeric field (select + date use metric: "count") and minimal table
    const nonNumFields: BaseField[] = [
      { id: 1, tableId: 1, name: "Stage", type: "select", position: 1000 },
      { id: 2, tableId: 1, name: "Due", type: "date", position: 2000 },
    ];
    const wNonNum = defaultDashboardWidgets(nonNumFields, 1);
    expect(wNonNum.find((w) => w.type === "bar")?.metric).toBe("count");
    expect(wNonNum.find((w) => w.type === "line")?.metric).toBe("count");
    expect(defaultDashboardWidgets([{ id: 1, tableId: 1, name: "Name", type: "text", position: 1000 }])).toHaveLength(1);

    // computeMetricSummary: checked_pct on 0 records, numeric string parsing (valid & invalid), 0 numeric values, non-integer avg, Infinity overflow
    expect(
      computeMetricSummary([], { id: "c", type: "metric", title: "C", span: 1, metric: "checked_pct", valueFieldId: 1 }).value,
    ).toBe(0);

    const recs: BaseRecord[] = [
      { id: 1, baseId: 1, tableId: 1, position: 1000, cells: { "1": "1.5", "2": "notnum", "3": "   ", "4": "G1" } },
      { id: 2, baseId: 1, tableId: 1, position: 2000, cells: { "1": 2, "4": "G1" } },
    ];
    const avgRes = computeMetricSummary(recs, { id: "a", type: "metric", title: "Avg", span: 1, metric: "avg", valueFieldId: 1 });
    expect(avgRes.headline).toBe("1.75");

    const noNums = computeMetricSummary(recs, { id: "n", type: "metric", title: "None", span: 1, metric: "sum", valueFieldId: 2 });
    expect(noNums.headline).toBe("—");
    expect(
      computeMetricSummary(recs, { id: "n2", type: "metric", title: "BlankStr", span: 1, metric: "sum", valueFieldId: 3 }).headline,
    ).toBe("—");

    const overflowRecs: BaseRecord[] = [
      { id: 1, baseId: 1, tableId: 1, position: 1000, cells: { "1": 1e308 } },
      { id: 2, baseId: 1, tableId: 1, position: 2000, cells: { "1": 1e308 } },
    ];
    expect(
      computeMetricSummary(overflowRecs, { id: "ov", type: "metric", title: "Overflow", span: 1, metric: "sum", valueFieldId: 1 }).headline,
    ).toBe("—");

    // computeGroupedSeries: missing gField ("All"), avg/min/max on bucket with no numeric values, sharePct when totalValue === 0
    const fields: BaseField[] = [{ id: 4, tableId: 1, name: "Group", type: "text", position: 1000 }];
    const allGroup = computeGroupedSeries(recs, fields, { id: "g0", type: "bar", title: "All", span: 1, metric: "count" });
    expect(allGroup.buckets[0].key).toBe("all");

    for (const metric of ["avg", "min", "max"] as const) {
      const series = computeGroupedSeries(recs, fields, {
        id: `g-${metric}`,
        type: "bar",
        title: metric,
        span: 1,
        groupFieldId: 4,
        metric,
        valueFieldId: 2, // non-numeric -> empty nums -> value 0 & sharePct 0
      });
      expect(series.buckets[0].value).toBe(0);
      expect(series.buckets[0].sharePct).toBe(0);
    }
  });

  it("covers all Base facade, lookup, undo-cap, inspect truncation, apply errors, and AI tool branches", () => {
    // Base.create defaults & fromCsv with explicit options
    const defaultBase = Base.create();
    expect(defaultBase.getName()).toBe("Untitled Base");
    const csvBase = Base.fromCsv("Title\tVal\nA\t1", { name: "TSV Base", tableName: "Sheet", delimiter: "\t" });
    expect(csvBase.getName()).toBe("TSV Base");
    expect(csvBase.getTables()[0].name).toBe("Sheet");

    // Empty base resolveTableId throws
    const emptyBase = Base.create({ empty: true });
    expect(() => emptyBase.getFields()).toThrow("base contains no tables");

    // Non-default table fallback in resolveTableId + optionColors cloneSnapshot + same-position field/record tie-breakers
    const base = Base.fromJSON({
      name: "Snap",
      tables: [
        { id: 1, baseId: 1, name: "T1", position: 1000, isDefault: false },
        { id: 2, baseId: 1, name: "T2", position: 2000, isDefault: false },
      ],
      fields: [
        { id: 2, tableId: 1, name: "Status", type: "select", options: ["Open", "Closed"], optionColors: [1, 2], position: 1000 },
        { id: 1, tableId: 1, name: "Name", type: "text", isPrimary: true, position: 1000 },
        { id: 3, tableId: 1, name: "Tags", type: "multi_select", options: ["X", "Y"], position: 2000 },
        { id: 4, tableId: 1, name: "EmptyFormula", type: "formula", position: 3000 },
        { id: 5, tableId: 1, name: "LinkT2", type: "link", targetTableId: 2, position: 4000 },
        { id: 6, tableId: 1, name: "LookupTags", type: "lookup", linkFieldId: 5, lookupFieldId: 10, position: 5000 },
        { id: 7, tableId: 1, name: "LookupBroken", type: "lookup", linkFieldId: 999, lookupFieldId: 10, position: 6000 },
        { id: 10, tableId: 2, name: "T2Tags", type: "multi_select", options: ["P", "Q"], isPrimary: true, position: 1000 },
      ],
      records: [
        { id: 2, baseId: 1, tableId: 1, position: 1000, cells: { "1": "R2", "2": "", "3": ["X", "BadTag"], "5": 100 } },
        { id: 1, baseId: 1, tableId: 1, position: 1000, cells: { "1": "R1", "5": [100, 101] } },
        { id: 3, baseId: 1, tableId: 1, position: 2000, cells: { "1": "R3", "5": "not-an-id" } },
        { id: 100, baseId: 1, tableId: 2, position: 1000, cells: { "10": ["P", "Q"] } },
        { id: 101, baseId: 1, tableId: 2, position: 2000, cells: { "10": "SingleStr" } },
      ],
      views: [
        { id: 2, baseId: 1, tableId: 1, type: "grid", name: "V2", config: {}, pos: 1000 },
        { id: 1, baseId: 1, tableId: 1, type: "grid", name: "V1", config: {}, pos: 1000 },
      ],
    });

    // resolveTableId falls back to tables[0] when none has isDefault
    expect(base.getFields().map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(base.getViews().map((v) => v.id)).toEqual([1, 2]);
    expect(() => base.getFields(999)).toThrow("table 999 not found");
    expect(() => base.queryView(999)).toThrow("view 999 not found");

    // Raw vs computed records & lookup branches (single number link, multi link with array + string, invalid rawIds, broken lookup)
    const rawRecs = base.getRecords(1, { computed: false });
    expect(rawRecs.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(rawRecs[0].cells["6"]).toBeUndefined();

    const compRecs = base.getRecords(1, { computed: true });
    expect(compRecs[0].cells["6"]).toEqual(["P, Q", "SingleStr"]); // multi target (array + string)
    expect(compRecs[1].cells["6"]).toEqual(["P, Q"]); // single number link to array cell
    expect(compRecs[2].cells["6"]).toBeUndefined(); // non-array non-number link cell

    // verify(): empty formula, empty select string skipped, multi_select invalid option
    const diags = base.verify();
    expect(diags.some((d) => d.code === "INVALID_FORMULA" && d.fieldId === 4)).toBe(true);
    expect(diags.some((d) => d.code === "INVALID_SELECT_OPTION" && d.fieldId === 3)).toBe(true);

    // evaluateDashboard with widget without tableId
    const dash = base.evaluateDashboard([{ id: "w1", type: "metric", title: "Cnt", span: 1, metric: "count" }], 1);
    expect(dash[0].metric?.value).toBe(3);

    // inspect(): default args + maxTokens truncation across 2 tables
    expect(base.inspect().truncated).toBe(false);
    expect(base.inspect({ detail: "full", maxTokens: 1 }).truncated).toBe(true);

    // Convenience wrappers error paths + deleteRecord
    expect(() => base.createTable(null as unknown as string)).toThrow();
    expect(() => base.addField(999, { name: "X", type: "text" })).toThrow();
    expect(() => base.addRecord(999, {})).toThrow();
    expect(() => base.updateRecord(999, {})).toThrow();
    expect(base.deleteRecord(3)).toBe(true);
    expect(base.deleteRecord(999)).toBe(false);

    // apply() edge cases: blank names, unknown cell key, null cell deletion, addView without config, not-found errors, non-atomic mode, empty ops, non-Error throw
    const nonAtomic = base.apply(
      [
        { op: "createTable", name: "   " },
        { op: "renameTable", tableId: 1, name: "   " },
        { op: "renameTable", tableId: 999, name: "X" },
        { op: "deleteTable", tableId: 999 },
        { op: "addField", tableId: 1, field: { name: "   ", type: "text" } },
        { op: "updateField", fieldId: 999, patch: { name: "X" } },
        { op: "deleteField", fieldId: 999 },
        { op: "addRecord", tableId: 1, cells: { customRawKey: "v" } },
        { op: "updateRecord", recordId: 999, cells: {} },
        { op: "updateRecord", recordId: 1, cells: { Name: null } },
        { op: "addView", tableId: 1, name: "   ", type: "kanban" },
        {
          op: "createTable",
          get name(): string {
            throw "non-error-string";
          },
        } as BaseOp,
      ],
      { atomic: false },
    );
    expect(nonAtomic.ok).toBe(false);
    expect(nonAtomic.errors.some((e) => e.includes("non-error-string"))).toBe(true);
    expect(nonAtomic.applied).toBeGreaterThan(0);

    // Empty apply -> undoToken: null
    const emptyApply = base.apply([]);
    expect(emptyApply.ok).toBe(true);
    expect(emptyApply.undoToken).toBeNull();

    // Undo stack cap (> 100 entries)
    for (let i = 0; i < 102; i++) {
      base.addRecord(1, { Name: `Cap ${i}` });
    }
    expect(base.canUndo()).toBe(true);

    // AI tools: calling tools with no args (default branches)
    const tools = createBaseTools(base);
    expect((tools.execute("base_query") as { total: number }).total).toBeGreaterThan(0);
    expect((tools.execute("base_apply") as { ok: boolean }).ok).toBe(true);
    expect((tools.execute("base_dashboard") as unknown[]).length).toBeGreaterThan(0);
    expect((tools.execute("base_export_csv") as { csv: string }).csv).toContain("T1".length ? "Name" : "");
  });

  it("covers autonumber multi-table isolation, overwrite protection, and formula references", () => {
    const base = Base.create("AutoNumBase");
    const t1 = base.getTables()[0].id;
    const t2 = base.createTable("SecondTable").id;
    base.addRecord(t2, { 名称: "Other table row" });

    const autoField = base.addField(t1, { name: "Seq", type: "autonumber" });
    const formulaField = base.addField(t1, { name: "SeqDouble", type: "formula", formula: "[Seq] * 2" });

    // addRecord in t1 skips existing records from t2 (base.ts:601) and assigns monotonic Seq
    const r1 = base.addRecord(t1, { 名称: "Row 1", Seq: 999 });
    expect(r1.cells[String(autoField.id)]).toBe(1);
    const r2 = base.addRecord(t1, { 名称: "Row 2" });
    expect(r2.cells[String(autoField.id)]).toBe(2);

    // updateRecord ignores attempts to mutate autonumber cells (base.ts:631)
    base.updateRecord(r1.id, { Seq: 777, 名称: "Row 1 Updated" });
    const t1Fields = base.getFields(t1);
    const recWithVal = base.getRecords(t1).find((r) => r.id === r1.id)!;
    expect(recWithVal.cells[String(autoField.id)]).toBe(1);

    // Formula referencing populated autonumber (formula.ts:436) and missing autonumber fallback to record.id (formula.ts:437)
    expect(evalRecordFormulas(recWithVal, t1Fields)[formulaField.id]).toBe(2);
    const recMissingAuto = { ...recWithVal, cells: {} };
    expect(evalRecordFormulas(recMissingAuto, t1Fields)[formulaField.id]).toBe(r1.id * 2);
  });
});

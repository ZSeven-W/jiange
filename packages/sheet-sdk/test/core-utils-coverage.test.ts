import { describe, expect, it } from "vitest";
import { createSheetTools } from "../src/ai-tools.js";
import { copySheetCells, pasteCopiedSheetCells, resolveSheetPaste } from "../src/clipboard.js";
import {
  applyRemoteCellDelta,
  buildConflictResolutionWrite,
  remoteCollaboratorBounds,
} from "../src/collab.js";
import { formatCsv, parseCsv } from "../src/csv.js";
import { calculateSheet, translateSheetFormula } from "../src/formula.js";
import {
  applyCellChanges,
  clearSelection,
  columnName,
  pasteCells,
  selectionOutline,
} from "../src/grid.js";
import { formatCellDisplay, formatExcelNumber, parseDateToSerial } from "../src/numfmt.js";
import {
  evaluateSheetConditionalFormat,
  evaluateSheetValidation,
  findSheetDropdown,
  formatSheetRectA1,
  isSheetCellProtected,
} from "../src/rules.js";
import { parseTSV } from "../src/tsv.js";
import type { SheetSnapshot, SheetWorksheet } from "../src/types.js";
import { Workbook } from "../src/workbook.js";
import {
  createFormulaWorkerHost,
  FormulaWorkerClient,
  type FormulaWorkerRequest,
  type FormulaWorkerResponse,
  type MessagePortLike,
} from "../src/worker.js";
import { xchild, xlsxXml, xtext } from "../src/xlsx-xml.js";

describe("Group 1 core utility 100% branch coverage", () => {
  it("covers all ai-tools branches", () => {
    const wb = Workbook.create({ sheets: [{ name: "Data", rows: 5, cols: 5 }] });
    wb.sheet("Data").setCell("A1", "Item").setCell("B1", 10).setCell("C1", "=B1*2").setCell("D1", "=1/0");
    const toolkit = createSheetTools(wb);

    expect(toolkit.execute("sheet_inspect")).toBeDefined();
    expect(
      toolkit.execute("sheet_inspect", {
        detail: "full",
        maxTokens: 500,
        focus: "Data",
        cursor: "0",
      }),
    ).toBeDefined();

    expect(toolkit.execute("sheet_query")).toBeDefined();
    expect(
      toolkit.execute("sheet_query", {
        sheet: "Data",
        range: "A1:D1",
        search: "Item",
        onlyFormulas: false,
        onlyErrors: false,
        limit: 10,
      }),
    ).toBeDefined();

    expect(() => toolkit.execute("sheet_apply", { ops: "not-an-array" })).toThrow(
      "sheet_apply requires an ops array",
    );
    const applyRes = toolkit.execute("sheet_apply", {
      ops: [{ op: "setCells", sheet: "Data", cells: [{ a1: "A2", raw: "Pen" }] }],
      dryRun: false,
      reason: "add item",
    }) as { undoToken?: string };
    expect(toolkit.execute("sheet_undo", { token: applyRes.undoToken })).toEqual({
      ok: true,
      version: wb.version,
    });
    expect(toolkit.execute("sheet_undo")).toEqual({ ok: false, version: wb.version });

    const csvDefault = toolkit.execute("sheet_export_csv") as { csv: string };
    const csvNamed = toolkit.execute("sheet_export_csv", { sheet: "Data" }) as { csv: string };
    expect(csvDefault.csv).toBe(csvNamed.csv);
  });

  it("covers clipboard size/token guards", () => {
    expect(copySheetCells({}, { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }, "")).toBeNull();
    expect(
      copySheetCells({}, { anchor: { row: 0, col: 0 }, focus: { row: 24, col: 24 } }, "tok"),
    ).toBeNull();
    // Ensure pasteCopiedSheetCells & resolveSheetPaste work on normal values too
    const copy = copySheetCells(
      { "0:0": "=A2" },
      { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } },
      "t1",
    )!;
    expect(pasteCopiedSheetCells({}, { row: 0, col: 0 }, copy).ok).toBe(true);
    expect(resolveSheetPaste({}, { row: 0, col: 0 }, copy.text, "t1", copy).ok).toBe(true);
  });

  it("covers all collab branches", () => {
    expect(
      remoteCollaboratorBounds({
        userId: 1,
        name: "Alice",
        worksheetId: 1,
        row: 3,
        col: 4,
      }),
    ).toEqual({ top: 3, bottom: 3, left: 4, right: 4 });
    expect(
      remoteCollaboratorBounds({
        userId: 1,
        name: "Alice",
        worksheetId: 1,
        row: 3,
        col: 4,
        anchorRow: 1,
        anchorCol: 6,
      }),
    ).toEqual({ top: 1, bottom: 3, left: 4, right: 6 });

    const snap: SheetSnapshot = {
      documentId: 1,
      workbookRevision: 5,
      sheets: [
        {
          id: 10,
          nodeId: 1,
          title: "S1",
          pos: 0,
          frozenRows: 0,
          frozenCols: 0,
          merges: [],
          filter: {},
          revision: 1,
          rows: [{ id: 1, pos: 0 }],
          columns: [{ id: 1, pos: 0 }],
          cells: [{ rowId: 1, columnId: 1, raw: "old", style: { bold: true }, revision: 3 }],
        },
        {
          id: 20,
          nodeId: 2,
          title: "S2",
          pos: 1,
          frozenRows: 0,
          frozenCols: 0,
          merges: [],
          filter: {},
          revision: 1,
          rows: [],
          columns: [],
          cells: [],
        },
      ],
    };

    // Stale workbookRevision returns original snapshot
    expect(
      applyRemoteCellDelta(snap, 10, 5, [{ rowId: 1, columnId: 1, raw: "x", revision: 4 }]),
    ).toBe(snap);
    // Gap in workbookRevision returns null
    expect(
      applyRemoteCellDelta(snap, 10, 7, [{ rowId: 1, columnId: 1, raw: "x", revision: 4 }]),
    ).toBeNull();
    // Unknown worksheet returns null
    expect(
      applyRemoteCellDelta(snap, 999, 6, [{ rowId: 1, columnId: 1, raw: "x", revision: 4 }]),
    ).toBeNull();

    // Valid delta covering: other sheet untouched, stale cell skipped, undefined raw/style preserving prev, and brand new cell with undefined raw/style
    const updated = applyRemoteCellDelta(snap, 10, 6, [
      { rowId: 1, columnId: 1, raw: "stale", revision: 2 },
      { rowId: 1, columnId: 1, revision: 4 },
      { rowId: 2, columnId: 2, revision: 1 },
      { rowId: 3, columnId: 3, raw: "styled", style: { italic: true }, revision: 1 },
    ]);
    expect(updated).not.toBeNull();
    expect(updated!.sheets[1]).toBe(snap.sheets[1]);
    const c1 = updated!.sheets[0].cells.find((c) => c.rowId === 1 && c.columnId === 1)!;
    expect(c1.raw).toBe("old");
    expect(c1.style).toEqual({ bold: true });
    const c2 = updated!.sheets[0].cells.find((c) => c.rowId === 2 && c.columnId === 2)!;
    expect(c2.raw).toBe("");
    expect(c2.style).toEqual({});

    // Conflict resolution anchor branches
    expect(
      buildConflictResolutionWrite(
        {
          rowId: 1,
          columnId: 1,
          currentRevision: 2,
          reason: "version_conflict",
          attemptedRaw: "v",
        },
        "anchor",
      ),
    ).toBeNull();
    expect(
      buildConflictResolutionWrite(
        {
          rowId: 2,
          columnId: 2,
          currentRevision: 2,
          reason: "merge_slave_conflict",
          anchorRowId: 1,
          anchorColumnId: 1,
          attemptedRaw: "anchored",
        },
        "anchor",
      ),
    ).toEqual({
      rowId: 1,
      columnId: 1,
      expectedRevision: 0,
      raw: "anchored",
    });
  });

  it("covers csv and tsv edge branches", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("a,b\rc,d\r\ne,f\ng,h")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
    expect(formatCsv([[undefined as unknown as string, "ok"]])).toBe(",ok");
    expect(parseTSV('"a""b"\tc')).toEqual([['a"b', "c"]]);
  });

  it("covers worker host errors and client edge cases", async () => {
    const host = createFormulaWorkerHost();
    // Trigger Error catch branch
    const errRes = host({
      id: 1,
      type: "load",
      sheets: null as unknown as SheetWorksheet[],
    });
    expect(errRes.ok).toBe(false);
    if (!errRes.ok) expect(errRes.error.length).toBeGreaterThan(0);

    // Trigger non-Error catch branch
    const throwingIterable = {
      [Symbol.iterator]() {
        throw "raw-string-error";
      },
    } as unknown as SheetWorksheet[];
    const strErrRes = host({ id: 2, type: "load", sheets: throwingIterable });
    expect(strErrRes).toEqual({ id: 2, ok: false, error: "raw-string-error" });

    // Client listener edge cases + dispose with pending
    let listener: ((ev: { data: unknown }) => void) | null = null;
    const posted: unknown[] = [];
    const port: MessagePortLike = {
      postMessage(msg) {
        posted.push(msg);
      },
      addEventListener(_type, fn) {
        listener = fn;
      },
      removeEventListener() {
        listener = null;
      },
    };
    const client = new FormulaWorkerClient(port);
    // Ignored messages: null, non-numeric id, unknown id
    listener!({ data: null });
    listener!({ data: { id: "not-num" } });
    listener!({ data: { id: 999, ok: true } });

    // Error response rejects promise
    const failPromise = client.getSheet(1);
    const req1 = posted[0] as FormulaWorkerRequest;
    listener!({ data: { id: req1.id, ok: false, error: "boom" } satisfies FormulaWorkerResponse });
    await expect(failPromise).rejects.toThrow("boom");

    // Dispose rejects still-pending promises
    const pendingPromise = client.getSheet(2);
    client.dispose();
    await expect(pendingPromise).rejects.toThrow("FormulaWorkerClient disposed");
  });

  it("covers xlsx-xml namespace, attribute, xchild and xtext branches", () => {
    const doc = xlsxXml('<root><child>hello <b>world</b></child></root>');
    expect(doc.ns).toBe("");
    const ch = xchild(doc, "child");
    expect(ch).toBeDefined();
    expect(xtext(ch!)).toBe("hello world");
    expect(xchild(doc, "missing")).toBeUndefined();

    // Valid xml namespace binding
    const withXmlNs = xlsxXml(
      '<root xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:space="preserve">x</root>',
    );
    expect(xtext(withXmlNs)).toBe("x");

    // Invalid namespaces
    expect(() => xlsxXml('<a xmlns:=""/>')).toThrow("invalid XML namespace");
    expect(() => xlsxXml('<a xmlns:x:y="urn:a"/>')).toThrow("invalid XML namespace");
    expect(() => xlsxXml('<a xmlns:xmlns="urn:a"/>')).toThrow("invalid XML namespace");
    expect(() => xlsxXml('<a xmlns:xml="urn:wrong"/>')).toThrow("invalid XML namespace");

    // Invalid qualified names
    expect(() => xlsxXml("<a:b:c/>")).toThrow("invalid XML qualified name");
    expect(() => xlsxXml("<:a/>")).toThrow("invalid XML qualified name");
    expect(() => xlsxXml("<a:/>")).toThrow("invalid XML qualified name");

    // Undeclared namespace
    expect(() => xlsxXml("<p:a/>")).toThrow("undeclared XML namespace");

    // Duplicate expanded attribute across different prefixes bound to same URI
    expect(() => xlsxXml('<a xmlns:p="urn:ns" xmlns:q="urn:ns" p:x="1" q:x="2"/>')).toThrow(
      "duplicate XML attribute",
    );
  });

  it("covers grid bounds, outline, validText, and batch size branches", () => {
    expect(columnName(-1)).toBe("");
    expect(columnName(16384)).toBe("");
    expect(columnName(1.5)).toBe("");

    const sel3x3 = { anchor: { row: 0, col: 0 }, focus: { row: 2, col: 2 } };
    expect(selectionOutline(sel3x3, { row: 5, col: 5 })).toBeUndefined();
    expect(selectionOutline(sel3x3, { row: 1, col: 1 })).toBeUndefined();
    expect(selectionOutline(sel3x3, { row: 2, col: 2 })).toBe(
      "inset 0 -2px #3370ff, inset -2px 0 #3370ff",
    );

    expect(applyCellChanges({}, [])).toEqual({ ok: false, reason: "size" });
    expect(
      applyCellChanges({}, [{ point: { row: 0, col: 0 }, value: "a\u0000b" }]),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      applyCellChanges({}, [{ point: { row: 0, col: 0 }, value: "\udc00" }]),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(pasteCells({}, { row: 0, col: 0 }, "")).toEqual({ ok: false, reason: "size" });
    expect(
      clearSelection({}, { anchor: { row: 0, col: 0 }, focus: { row: 25, col: 25 } }),
    ).toEqual({ ok: false, reason: "size" });
  });

  it("covers rules validation, conditional formatting, and protection branches", () => {
    expect(formatSheetRectA1({ top: 0, left: 0, bottom: 2, right: 2 })).toBe("A1:C3");
    expect(findSheetDropdown(undefined, 0, 0)).toBeNull();
    expect(findSheetDropdown([], 0, 0)).toBeNull();

    // List rule with undefined options + custom hint vs fallback
    const listNoOpts = evaluateSheetValidation(
      "X",
      [{ id: "v1", top: 0, bottom: 0, left: 0, right: 0, type: "list", strict: true }],
      0,
      0,
    );
    expect(listNoOpts.valid).toBe(false);

    // Number rule with only max, and with neither min nor max, and with custom hint
    const numMaxOnly = evaluateSheetValidation(
      "99",
      [{ id: "v2", top: 0, bottom: 0, left: 0, right: 0, type: "number", max: "50", strict: true }],
      0,
      0,
    );
    expect(numMaxOnly.message).toContain("50");

    const numNeither = evaluateSheetValidation(
      "abc",
      [{ id: "v3", top: 0, bottom: 0, left: 0, right: 0, type: "number", strict: true }],
      0,
      0,
    );
    expect(numNeither.message).toBe("请输入有效数字");

    const withHint = evaluateSheetValidation(
      "abc",
      [
        {
          id: "v4",
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          type: "number",
          strict: true,
          hint: "Custom error",
        },
      ],
      0,
      0,
    );
    expect(withHint.message).toBe("Custom error");

    // Conditional formatting branches
    expect(evaluateSheetConditionalFormat("1", undefined, undefined, 0, 0)).toBeNull();
    expect(evaluateSheetConditionalFormat("1", undefined, [], 0, 0)).toBeNull();
    const eqRule = [
      { id: "c1", top: 0, bottom: 0, left: 0, right: 0, op: "eq" as const, value1: "TRUE", bg: "#111" },
      { id: "c2", top: 0, bottom: 0, left: 0, right: 0, op: "eq" as const, value1: "FALSE", bg: "#222" },
      { id: "c3", top: 0, bottom: 0, left: 0, right: 0, op: "gt" as const, value1: "5", bg: "#333" },
      { id: "c4", top: 0, bottom: 0, left: 0, right: 0, op: "empty" as const, bg: "#444" },
    ];
    expect(
      evaluateSheetConditionalFormat("=TRUE", { kind: "boolean", value: true }, eqRule, 0, 0),
    ).toEqual({ bg: "#111", color: undefined, bold: undefined });
    expect(
      evaluateSheetConditionalFormat("=FALSE", { kind: "boolean", value: false }, eqRule, 0, 0),
    ).toEqual({ bg: "#222", color: undefined, bold: undefined });
    expect(
      evaluateSheetConditionalFormat(
        "=A1:A2",
        { kind: "array", value: [[{ kind: "number", value: 10 }]] },
        eqRule,
        0,
        0,
      ),
    ).toEqual({ bg: "#333", color: undefined, bold: undefined });
    expect(
      evaluateSheetConditionalFormat("", { kind: "array", value: [[]] }, eqRule, 0, 0),
    ).toEqual({ bg: "#444", color: undefined, bold: undefined });
    expect(evaluateSheetConditionalFormat("  10  ", undefined, eqRule, 0, 0)).toEqual({
      bg: "#333",
      color: undefined,
      bold: undefined,
    });
    expect(evaluateSheetConditionalFormat("   ", undefined, eqRule, 0, 0)).toEqual({
      bg: "#444",
      color: undefined,
      bold: undefined,
    });

    // Protection branches: non-matching rect, undefined allowedUserIds, manage role
    const protRules = [
      { id: "p1", top: 5, bottom: 5, left: 5, right: 5 },
      { id: "p2", top: 0, bottom: 0, left: 0, right: 0 },
    ];
    expect(isSheetCellProtected(protRules, 0, 0, 7, "edit").blocked).toBe(true);
    expect(isSheetCellProtected(protRules, 0, 0, 7, "manage")).toMatchObject({
      protected: true,
      blocked: false,
    });
  });

  it("covers numfmt date/time, escape, scientific, and display branches", () => {
    const dtAm = parseDateToSerial("2024-03-05 09:04:07");
    const dtPm = parseDateToSerial("2024-03-05 15:08");
    expect(dtAm).not.toBeNull();
    expect(dtPm).not.toBeNull();
    expect(parseDateToSerial("2024-03-05 24:00:00")).toBeNull();
    expect(parseDateToSerial("2024-03-05 10:60:00")).toBeNull();
    expect(parseDateToSerial("2024-03-05 10:00:60")).toBeNull();

    // Quoted literals, unterminated quote, backslash escapes, yy, mmmm, m, d, hh, h, s, am/pm
    expect(formatExcelNumber(dtAm!, '"D:"yy-mmmm-m-d h:m:s am/pm\\!')).toBe(
      "D:24-March-3-5 9:4:7 AM!",
    );
    expect(formatExcelNumber(dtPm!, 'hh:mm:ss am/pm "unterminated')).toBe(
      "03:08:00 PM unterminated",
    );
    expect(formatExcelNumber(dtPm!, "h:m:s\\")).toBe("15:8:0");
    expect(formatExcelNumber(dtPm!, "hh:mm")).toBe("15:08");

    // Scientific without decimal, fraction without 0s, literal "@"
    expect(formatExcelNumber(1234, "0E+00")).toBe("1.23E+3");
    expect(formatExcelNumber(12.5, "#.#")).toBe("12.5");
    expect(formatExcelNumber(42, "@")).toBe("42");

    // formatCellDisplay branches: array (non-empty + empty), boolean (true/false), formula without evalVal
    expect(
      formatCellDisplay("=A1:A2", { kind: "array", value: [[{ kind: "number", value: 42 }]] }),
    ).toBe("42");
    expect(formatCellDisplay("=A1:A2", { kind: "array", value: [[]] })).toBe("");
    expect(formatCellDisplay("=TRUE", { kind: "boolean", value: true })).toBe("TRUE");
    expect(formatCellDisplay("=FALSE", { kind: "boolean", value: false })).toBe("FALSE");
    expect(formatCellDisplay("=A1", undefined)).toBe("");
    expect(formatCellDisplay("=A1", { kind: "string", value: "hi" })).toBe("hi");
  });

  it("covers all legacy formula.ts parser, evaluator, and translator branches", () => {
    // translateSheetFormula guards & #REF!
    expect(translateSheetFormula("=A1", Number.NaN, 0)).toBeNull();
    expect(translateSheetFormula("=A1", 0, 1.5)).toBeNull();
    expect(translateSheetFormula("=" + " ".repeat(32770), 0, 0)).toBeNull();
    expect(translateSheetFormula("=" + "1+".repeat(600) + "1", 0, 0)).toBeNull();
    expect(translateSheetFormula("=#REF!+A1", 1, 1)).toBe("=#REF!+B2");

    // calculateSheet branches
    const tooManyTokens = "=" + "1+".repeat(600) + "1";
    const bigRange = "=SUM(" + Array(9).fill("B1:Z100").join(",") + ")";
    const out = calculateSheet({
      "0:0": "   ",
      "0:1": "not-a-num",
      "0:2": "= A1 + 1 ",
      "0:3": "=B1",
      "0:4": "=+5 + -3",
      "0:5": "=(1+2",
      "0:6": "=#REF!",
      "0:7": "=#REF!+1",
      "0:8": "=SUM+1",
      "0:9": "=SUM(A1:Z101)",
      "0:10": "=SUM(Z101:A1)",
      "0:11": "=SUM(1, 2, 3)",
      "0:12": "=SUM(1/0)",
      "0:13": "=SUM(1, 2",
      "0:14": "=AVERAGE()",
      "0:15": "=MIN()",
      "0:16": "=MAX()",
      "0:17": "=MIN(5, 2)",
      "0:18": "=MAX(5, 2)",
      "0:19": "=AVERAGE(2, 4)",
      "0:20": "=)",
      "0:21": "=2^3^2",
      "0:22": "=1+(1/0)",
      "0:23": "=1/0",
      "0:24": "=1 2",
      "0:25": tooManyTokens,
      "1:1": "=-#REF!+1",
      "1:2": "=Z99+1",
    });

    expect(calculateSheet({ "0:0": bigRange })["0:0"]).toBe("#LIMIT!");

    expect(out["0:2"]).toBe(1);
    expect(out["0:3"]).toBe("#VALUE!");
    expect(out["0:4"]).toBe(2);
    expect(out["0:5"]).toBe("#ERROR!");
    expect(out["0:6"]).toBe("#REF!");
    expect(out["0:7"]).toBe("#REF!");
    expect(out["0:8"]).toBe("#NAME?");
    expect(out["0:9"]).toBe("#REF!");
    expect(out["0:10"]).toBe("#REF!");
    expect(out["0:11"]).toBe(6);
    expect(out["0:12"]).toBe("#DIV/0!");
    expect(out["0:13"]).toBe("#ERROR!");
    expect(out["0:14"]).toBe("#DIV/0!");
    expect(out["0:15"]).toBe(0);
    expect(out["0:16"]).toBe(0);
    expect(out["0:17"]).toBe(2);
    expect(out["0:18"]).toBe(5);
    expect(out["0:19"]).toBe(3);
    expect(out["0:20"]).toBe("#ERROR!");
    expect(out["0:21"]).toBe(512);
    expect(out["0:22"]).toBe("#DIV/0!");
    expect(out["0:23"]).toBe("#DIV/0!");
    expect(out["0:24"]).toBe("#ERROR!");
    expect(out["0:25"]).toBe("#ERROR!");
    expect(out["1:1"]).toBe("#REF!");
  });
});

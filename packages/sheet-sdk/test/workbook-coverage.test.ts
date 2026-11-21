import { createZip } from "@jiange/ooxml/zip";
import { describe, expect, it } from "vitest";
import { arrVal, numVal } from "../src/formula-functions.js";
import type { SheetWorksheet } from "../src/types.js";
import { Workbook, type WorkbookOp } from "../src/workbook.js";
import { writeXlsx } from "../src/xlsx.js";

const enc = new TextEncoder();
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

describe("workbook 100% branch coverage", () => {
  it("covers WorksheetProxy getters, validation errors, merges, resize, sort, and nested array eval", () => {
    const wb = Workbook.create({ sheets: [{ name: "S1", rows: 5, cols: 5 }] });
    wb.addSheet("S2", 5, 5);
    const s1 = wb.sheet("S1");
    const s2 = wb.sheet("S2");

    expect(s1.rowCount).toBe(5);
    expect(s1.colCount).toBe(5);

    // normalizeRawInput (null, true, false) + getFormatted
    s1.setCell("A1", null);
    s1.setCell("A2", true);
    s1.setCell("A3", false);
    expect(s1.getFormatted("A2")).toBe("TRUE");
    expect(s1.getFormatted("A3")).toBe("FALSE");

    // evalToPrimitive error & nested array (2x1 outer so applySpill keeps array, getValue returns inner array)
    wb.registerFunction("NESTED_ARR", () => arrVal([[arrVal([[numVal(7)]])], [numVal(8)]]));
    s1.setCell("B1", "=1/0");
    s1.setCell("B2", "=NESTED_ARR()");
    expect(s1.getValue("B1")).toBe("#DIV/0!");
    expect(s1.getValue("B2")).toBe(7);

    // Grow grid beyond 5x5 via _ensureGridSize (both rows and cols)
    s1.setCell("H8", "far");
    expect(s1.rowCount).toBe(8);
    expect(s1.colCount).toBe(8);

    // Validation errors on WorksheetProxy methods
    expect(() => s1.getCell("BAD")).toThrow("Invalid cell address");
    expect(() => s1.getValue("BAD")).toThrow("Invalid cell address");
    expect(() => s1.setCell("BAD", 1)).toThrow("Invalid cell address");
    expect(() => s1.setRange("BAD", [[1]])).toThrow("Invalid start address");
    expect(() => s1.getRange("BAD:RANGE")).toThrow("Invalid range");
    expect(() => s1.clearRange("BAD")).toThrow("Invalid range");
    expect(() => s1.merge("A1")).toThrow("Invalid merge range");
    expect(() => s1.merge("BAD")).toThrow("Invalid merge range");
    expect(() => s1.unmerge("BAD")).toThrow("Invalid unmerge range");

    // Overlapping merge throws
    s1.merge("A1:B2");
    expect(() => s1.merge("B2:C3")).toThrow("overlaps an existing merge");
    s1.unmerge("A1:B2");

    // setColWidth (numeric string, invalid char, invalid width) & setRowHeight (invalid row/height)
    s1.setColWidth("0", 120);
    s1.setColWidth("B", 100);
    expect(() => s1.setColWidth("1A!", 100)).toThrow("Invalid column resize");
    expect(() => s1.setColWidth(0, -5)).toThrow("Invalid column resize");
    expect(() => s1.setRowHeight(-1, 20)).toThrow("Invalid row resize");
    expect(() => s1.setRowHeight(0, 0)).toThrow("Invalid row resize");

    // sort invalid col & setFilter / clearFilter
    expect(() => s1.sort(999)).toThrow("Invalid sort column");
    s1.setFilter({ enabled: true, rules: { "0": { query: "a" } }, sort: { col: 0, ascending: true } });
    expect(wb._getWorksheetById(s1.id)?.filter.enabled).toBe(true);
    s1.setFilter({ enabled: true });
    s1.clearFilter();
    expect(wb._getWorksheetById(s1.id)?.filter.enabled).toBe(false);

    // Deleted sheet proxy throws
    wb.deleteSheet("S2");
    expect(() => s2.name).toThrow("no longer exists");

    // Internal mutators guard on unknown sheetId + out-of-bounds _getRawCellAt
    expect(wb._getRawCellAt(999, 0, 0)).toBeUndefined();
    expect(wb._getRawCellAt(s1.id, -1, 0)).toBeUndefined();
    wb._setCellsBatch(999, [{ row: 0, col: 0, raw: "x" }]);
    wb._setCellsBatch(s1.id, []);
    wb._addMerge(999, { top: 0, left: 0, bottom: 1, right: 1 });
    wb._removeMerge(999, { top: 0, left: 0, bottom: 1, right: 1 });
  });

  it("covers Workbook factory methods, sheet management errors, undo/redo, csv/tsv, and fromXlsx branches", async () => {
    // Empty snapshot falls back to default Sheet1; create() with omitted sheets & omitted rows/cols
    const fromEmpty = Workbook.fromSnapshot([]);
    expect(fromEmpty.listSheets()).toEqual(["Sheet1"]);
    const defaultWb = Workbook.create();
    expect(defaultWb.listSheets()).toEqual(["Sheet1"]);
    const defaultDims = Workbook.create({ sheets: [{ name: "OnlyName" }] });
    expect(defaultDims.sheet(0).rowCount).toBe(100);
    expect(defaultDims.sheet(0).colCount).toBe(26);

    // Sheet management error paths
    expect(() => defaultWb.sheet("Missing")).toThrow("Worksheet not found");
    expect(() => defaultWb.addSheet("   ")).toThrow("Invalid sheet name");
    expect(() => defaultWb.addSheet("Sheet1")).toThrow("Duplicate sheet name");
    defaultWb.addSheet("Other");
    expect(() => defaultWb.renameSheet("Sheet1", "   ")).toThrow("Invalid sheet name");
    expect(() => defaultWb.renameSheet("Missing", "New")).toThrow("Worksheet not found");
    expect(() => defaultWb.renameSheet("Sheet1", "Other")).toThrow("Duplicate sheet name");
    expect(() => defaultWb.deleteSheet("Missing")).toThrow("Worksheet not found");

    // defineName validation + sheet-scoped defineName
    expect(() => defaultWb.defineName("1bad", "A1")).toThrow("Invalid defined name");
    defaultWb.defineName("Rate", "0.2", "Sheet1");
    defaultWb.defineName("Rate", "0.25", "Sheet1"); // overwrite same scope

    // getPrecedents / getDependents on missing sheet or bad A1
    expect(defaultWb.getPrecedents("Missing", "A1")).toEqual([]);
    expect(defaultWb.getPrecedents("Sheet1", "BAD")).toEqual([]);
    expect(defaultWb.getDependents("Missing", "A1")).toEqual([]);
    expect(defaultWb.getDependents("Sheet1", "BAD")).toEqual([]);

    // toCsv / toTsv on missing sheet, empty sheet, and styled-empty cell
    expect(() => defaultWb.toCsv("Missing")).toThrow("Worksheet not found");
    expect(() => defaultWb.toTsv("Missing")).toThrow("Worksheet not found");
    defaultWb.sheet("Sheet1").setCell("A1", "", { bold: true });
    expect(defaultWb.toCsv("Sheet1")).toBe("");
    expect(defaultWb.toTsv()).toBe("");
    expect(defaultWb.toTsv("Other")).toBe("");

    // canUndo / canRedo + undo token mismatch + empty redo
    expect(defaultWb.canUndo).toBe(false);
    expect(defaultWb.canRedo).toBe(false);
    expect(defaultWb.redo()).toBe(false);
    const applied = defaultWb.apply([{ op: "setCells", sheet: "Sheet1", cells: [{ a1: "A1", raw: "1" }] }]);
    expect(defaultWb.canUndo).toBe(true);
    expect(defaultWb.undo("wrong-token")).toBe(false);
    expect(defaultWb.undo(applied.undoToken)).toBe(true);
    expect(defaultWb.canRedo).toBe(true);
    expect(defaultWb.redo()).toBe(true);

    // fromXlsx covering > 50 rows / > 20 cols, frozen, hyperlinks, conditionalFormats, comments, boolean, error, empty-value cell, and definedNames
    const bytes = writeXlsx({
      sheets: [
        {
          name: "Big",
          frozen: { rows: 1, cols: 2 },
          hyperlinks: [{ row: 0, col: 0, target: "https://example.com" }],
          conditionalFormats: [{ id: "cf-1", top: 0, left: 0, bottom: 2, right: 2, op: "gt", value1: "10", bg: "#DCFCE7" }],
          comments: [
            { row: 65, col: 28, text: "Far comment", author: "Alice" },
            { row: 0, col: 0, text: "Anon comment" },
          ],
          cells: [
            { row: 60, col: 25, value: true },
            { row: 0, col: 1, value: false },
            { row: 0, col: 2, value: { error: "#N/A" } },
            { row: 0, col: 3, style: { bold: true } },
          ],
        },
      ],
      definedNames: [{ name: "Tax", ref: "Big!$A$1" }],
    });
    const { workbook: imported } = await Workbook.fromXlsx(bytes);
    expect(imported.sheet("Big").rowCount).toBe(75);
    expect(imported.sheet("Big").colCount).toBe(33);
    expect(imported.sheet("Big").getCell("B1").raw).toBe("FALSE");
    expect(imported.sheet("Big").getCell("C1").raw).toBe("#N/A");
    expect(imported.toSnapshot().sheets[0].conditionalFormats?.length).toBe(1);
    expect(imported.toSnapshot().sheets[0].comments?.length).toBe(2);

    // WorksheetProxy.addComment (valid, second comment increments id, invalid address)
    const c1 = imported.sheet("Big").addComment("A1", "Note 1", "Bob");
    const c2 = imported.sheet("Big").addComment("A2", "Note 2");
    expect(c1.id).toBe(3);
    expect(c2.authorName).toBe("");
    expect(() => imported.sheet("Big").addComment("BAD", "x")).toThrow("Invalid cell address");
    const freshSheet = Workbook.create({ sheets: [{ name: "Fresh", rows: 5, cols: 5 }] });
    expect(freshSheet.sheet("Fresh").addComment("A1", "First").id).toBe(1);

    // fromXlsx with empty inline string without style (hits if (!raw && !style) continue)
    const emptyCellZip = createZip([
      {
        name: "[Content_Types].xml",
        data: enc.encode(
          `<Types xmlns="${CT_NS}"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
        ),
      },
      {
        name: "_rels/.rels",
        data: enc.encode(
          `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        ),
      },
      {
        name: "xl/workbook.xml",
        data: enc.encode(
          `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        ),
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: enc.encode(
          `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        ),
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: enc.encode(
          `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t></t></is></c></row></sheetData></worksheet>`,
        ),
      },
    ]);
    const { workbook: importedEmpty } = await Workbook.fromXlsx(emptyCellZip);
    expect(importedEmpty.sheet("S").getCell("A1").raw).toBe("");
  });

  it("covers inspect, query, apply (dryRun, non-atomic, error, undo cap, ops), and verify branches", () => {
    // Build snapshot with orphan cell, styled-empty cell, literal # error & non-error #tag, merges (valid, oob, overlap), oob chart & pivot
    const ws1: SheetWorksheet = {
      id: 1,
      nodeId: 0,
      title: "Main",
      pos: 0,
      frozenRows: 0,
      frozenCols: 0,
      merges: [
        { top: 0, left: 0, bottom: 1, right: 1 },
        { top: 1, left: 1, bottom: 2, right: 2 }, // overlaps first merge
        { top: 0, left: 0, bottom: 99, right: 0 }, // out of bounds
      ],
      filter: {},
      revision: 1,
      rows: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, pos: i })),
      columns: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, pos: i })),
      cells: [
        { rowId: 1, columnId: 1, raw: "", style: { bold: true }, revision: 1 }, // styled empty
        { rowId: 999, columnId: 1, raw: "orphan", revision: 1 }, // orphan cell
        { rowId: 1, columnId: 2, raw: "#DIV/0!", revision: 1 }, // literal error starting with '#'
        { rowId: 1, columnId: 3, raw: "#noterror", revision: 1 }, // starts with '#' but not error
        { rowId: 2, columnId: 1, raw: "=A2", revision: 1 }, // #CYCLE!
        { rowId: 2, columnId: 2, raw: "=NO_SUCH_FN()", revision: 1 }, // #NAME?
        { rowId: 2, columnId: 3, raw: "=SEQUENCE(2,1)", revision: 1 }, // blocked by C3 -> #SPILL!
        { rowId: 3, columnId: 3, raw: "BLOCK", revision: 1 },
        { rowId: 2, columnId: 4, raw: '="a"+1', revision: 1 }, // #VALUE! (default suggestion)
        { rowId: 3, columnId: 1, raw: "999", revision: 1 }, // triggers non-list warning validation
      ],
      validations: [
        { id: "v1", top: 2, bottom: 2, left: 0, right: 0, type: "number", max: "10", strict: false },
      ],
      conditionalFormats: [
        { id: "cf1", top: 0, bottom: 0, left: 0, right: 0, op: "not_empty", bg: "#eeeeee" },
      ],
      charts: [
        { id: "ch1", title: "OOB", type: "bar", top: 0, left: 0, bottom: 50, right: 2, headerRow: true, x: 0, y: 0, width: 100, height: 100, showLegend: true },
      ],
      pivotTables: [
        { id: "pv1", title: "OOBP", sourceSheetId: 1, top: 0, left: 0, bottom: 50, right: 2, rowFields: [0], values: [{ col: 1, agg: "sum" }], sortBy: "label_asc", showRowTotals: false, showColTotals: false },
      ],
    };
    const ws2: SheetWorksheet = {
      id: 2,
      nodeId: 0,
      title: "EmptySheet",
      pos: 1,
      frozenRows: 0,
      frozenCols: 0,
      merges: [],
      filter: {},
      revision: 1,
      rows: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, pos: i })),
      columns: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, pos: i })),
      cells: [],
    };

    const wb = Workbook.fromSnapshot([ws1, ws2], [{ name: "Tax", ref: "0.1" }]);
    wb.registerFunction("MY_FN", () => 123);

    // inspect: multi-sheet + definedNames + empty sheet + token budget pagination (nextCursor)
    const fullInsp = wb.inspect({ detail: "summary", maxTokens: 5000 });
    expect(fullInsp.promptText).toContain("Defined Names: Tax=0.1");
    expect(fullInsp.summary.sheets[1].usedRange).toBeNull();
    const paged = wb.inspect({ detail: "summary", maxTokens: 30 });
    expect(paged.truncated).toBe(true);
    expect(paged.nextCursor).toBe("1");

    // verify: all formula suggestions, non-list warning validation, merge oob/overlap, chart/pivot oob
    const diags = wb.verify();
    const codes = new Set(diags.map((d) => d.code));
    expect(codes.has("formula_div0")).toBe(true);
    expect(codes.has("formula_cycle")).toBe(true);
    expect(codes.has("formula_name")).toBe(true);
    expect(codes.has("formula_spill")).toBe(true);
    expect(codes.has("formula_value")).toBe(true);
    expect(codes.has("validation_violation")).toBe(true);
    expect(codes.has("merge_out_of_bounds")).toBe(true);
    expect(codes.has("merge_overlap")).toBe(true);
    expect(codes.has("chart_invalid_range")).toBe(true);
    expect(codes.has("pivot_invalid_range")).toBe(true);

    // query: no-range skipping styled-empty cell, range with empty cell (cell === undefined), onlyErrors filtering
    const qAll = wb.query({ sheet: "Main" });
    expect(qAll.totalMatched).toBeGreaterThan(0);
    const qEmptyRange = wb.query({ sheet: "EmptySheet", range: "A1:B2" });
    expect(qEmptyRange.cells.length).toBe(4);
    const qErr = wb.query({ sheet: "Main", onlyErrors: true });
    expect(qErr.cells.every((c) => c.error !== undefined)).toBe(true);

    // apply dryRun with customFns
    const dry = wb.apply([{ op: "setCells", sheet: "EmptySheet", cells: [{ a1: "A1", raw: "=MY_FN()" }] }], {
      dryRun: true,
    });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);

    // apply non-atomic partial failure + non-Error thrown inside executeOp
    const nonAtomic = wb.apply(
      [
        { op: "setCells", sheet: "EmptySheet", cells: [{ a1: "A1", raw: "kept" }] },
        { op: "setRange", sheet: "EmptySheet", start: "BAD", values: [[1]] },
      ],
      { atomic: false },
    );
    expect(nonAtomic.ok).toBe(false);
    expect(nonAtomic.appliedCount).toBe(1);
    expect(nonAtomic.diff.cellChanges.length).toBe(1);

    const throwStrOp = {
      op: "addSheet",
      get name(): string {
        throw "raw-op-error";
      },
    } as unknown as WorkbookOp;
    const strErr = wb.apply([throwStrOp]);
    expect(strErr.ok).toBe(false);
    expect(strErr.error?.message).toBe("raw-op-error");

    // executeOp edge branches: style-only setCells (existing + new cell, no raw/formatted diff),
    // invalid range on clearRange/addValidation/addConditionalFormat/addChart, default sort/validation/chart flags
    const opRes = wb.apply([
      {
        op: "setCells",
        sheet: "EmptySheet",
        cells: [
          { a1: "A1", style: { bold: true } }, // existing cell, no raw -> no diff change
          { a1: "B1", style: { italic: true } }, // brand new cell, no raw
        ],
      },
      { op: "sort", sheet: "EmptySheet", col: 0 },
      { op: "addValidation", sheet: "EmptySheet", range: "A1:A2", type: "number", max: "5" },
      { op: "addChart", sheet: "EmptySheet", title: "C", chartType: "line", range: "A1:B2" },
    ]);
    expect(opRes.ok).toBe(true);

    expect(wb.apply([{ op: "clearRange", sheet: "EmptySheet", range: "BAD" }]).ok).toBe(false);
    expect(
      wb.apply([{ op: "addValidation", sheet: "EmptySheet", range: "BAD", type: "number" }]).ok,
    ).toBe(false);
    expect(
      wb.apply([{ op: "addConditionalFormat", sheet: "EmptySheet", range: "BAD", ruleOp: "empty" }]).ok,
    ).toBe(false);
    expect(
      wb.apply([{ op: "addChart", sheet: "EmptySheet", title: "X", chartType: "bar", range: "BAD" }]).ok,
    ).toBe(false);

    // Undo stack cap (> 50)
    for (let i = 0; i < 52; i++) {
      wb.apply([{ op: "setCells", sheet: "EmptySheet", cells: [{ a1: "C1", raw: i }] }]);
    }
    expect(wb.canUndo).toBe(true);

    // inspect() fast path & edge branches: non-sequential axis IDs, orphan cell in non-seq map,
    // cold cellIndexCache with cells outside sample row/col window, warm cellIndexCache,
    // spilled cell + array cell + empty-row array cell in sample window (peekValue branches)
    const nonSeqWs: SheetWorksheet = {
      id: 10,
      nodeId: 0,
      title: "CustomIds",
      pos: 0,
      frozenRows: 0,
      frozenCols: 0,
      merges: [],
      filter: {},
      revision: 1,
      rows: Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, pos: i })),
      columns: Array.from({ length: 20 }, (_, i) => ({ id: 200 + i, pos: i })),
      cells: [
        { rowId: 100, columnId: 200, raw: "=SEQUENCE(2,1)", revision: 1 }, // array origin + spill into row 1
        { rowId: 100, columnId: 201, raw: "=EMPTY_ARR_FN()", revision: 1 }, // empty-row array in peekValue
        { rowId: 110, columnId: 200, raw: "outside-sample-row", revision: 1 }, // r > maxSampleRow
        { rowId: 100, columnId: 219, raw: "outside-sample-col", revision: 1 }, // c > capCol
        { rowId: 999, columnId: 200, raw: "orphan-row", revision: 1 },
        { rowId: 100, columnId: 999, raw: "orphan-col", revision: 1 },
      ],
    };
    const customWb = Workbook.fromSnapshot([nonSeqWs]);
    customWb.registerFunction("EMPTY_ARR_FN", () => arrVal([[], []]));
    const firstInsp = customWb.inspect({ detail: "summary" });
    expect(firstInsp.summary.sheets[0].nonEmptyCells).toBe(4);
    expect(firstInsp.summary.sheets[0].sampleRows?.[0]?.[0]).toBe("2");
    // Second inspect hits warm sheetStatsCache
    const secondInsp = customWb.inspect({ detail: "summary" });
    expect(secondInsp.summary.sheets[0].nonEmptyCells).toBe(4);
    // Warm cellIndexCache path in readInspectWindow
    customWb.sheet("CustomIds").setCell("C1", "warm");
    expect(customWb.inspect({ detail: "summary" }).summary.sheets[0].headers[2]).toBe("warm");
  });
});

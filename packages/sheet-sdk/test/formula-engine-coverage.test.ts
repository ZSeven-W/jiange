import { describe, expect, it } from "vitest";
import {
  buildMergeLookup,
  buildWorksheetGridMap,
  calculateWorkbook,
  computeSortedRowWrites,
  evalScalarRaw,
  getVisibleRowIndices,
  IncrementalFormulaEngine,
  normalizePointForMerge,
} from "../src/formula-engine.js";
import { arrVal, numVal, strVal } from "../src/formula-functions.js";
import type { SheetWorksheet } from "../src/types.js";

function makeWs(
  id: number,
  title: string,
  cells: [number, number, string, Record<string, unknown>?][],
  rows = 10,
  cols = 10,
): SheetWorksheet {
  const rowAxes = Array.from({ length: rows }, (_, i) => ({ id: i + 1, pos: i }));
  const colAxes = Array.from({ length: cols }, (_, i) => ({ id: i + 1, pos: i }));
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
    rows: rowAxes,
    columns: colAxes,
    cells: cells.map(([r, c, raw, style]) => ({
      rowId: rowAxes[r].id,
      columnId: colAxes[c].id,
      raw,
      ...(style ? { style } : {}),
      revision: 1,
    })),
  };
}

describe("formula-engine 100% branch coverage", () => {
  it("covers evalScalarRaw, buildWorksheetGridMap, binary/unary/percent ops, and custom functions", () => {
    // buildWorksheetGridMap skips orphan rowId/columnId
    const orphanWs = makeWs(1, "S1", []);
    orphanWs.cells.push({ rowId: 999, columnId: 1, raw: "x", revision: 1 });
    expect(buildWorksheetGridMap(orphanWs).cellByKey.size).toBe(0);

    // evalScalarRaw: whitespace, TRUE/FALSE, error literal
    expect(evalScalarRaw("   ")).toEqual({ kind: "string", value: "   " });
    expect(evalScalarRaw("true")).toEqual({ kind: "boolean", value: true });
    expect(evalScalarRaw("FALSE")).toEqual({ kind: "boolean", value: false });
    expect(evalScalarRaw("#div/0!")).toEqual({ kind: "error", value: "#DIV/0!", error: "#DIV/0!" });

    // Engine custom functions + unregister + binary/unary/percent/array broadcasting
    const engine = new IncrementalFormulaEngine();
    engine.registerFunction("TEMP", () => 1);
    engine.unregisterFunction("TEMP");
    const ws = makeWs(1, "S1", [
      [0, 0, "=FN_NULL()"],
      [0, 1, "=FN_STR()"],
      [0, 2, "=FN_BOOL()"],
      [0, 3, "=FN_EVAL()"],
      [0, 4, "=FN_THROW()"],
      [0, 5, "=TEMP()"],
      // Binary operators: error propagation, &, =, <>, <, <=, >, >=, +, -, *, /, ^, non-numeric a/b
      [1, 0, "=(1/0)+1"],
      [1, 1, '="a"&"b"'],
      [1, 2, "=1=1"],
      [1, 3, "=1<>2"],
      [1, 4, "=1<2"],
      [1, 5, "=1<=2"],
      [1, 6, "=2>1"],
      [1, 7, "=2>=1"],
      [1, 8, "=2^3"],
      [1, 9, '="x"+1'],
      [2, 0, '=1+"y"'],
      [2, 1, "=1-2"],
      [2, 2, "=4/2"],
      [2, 3, "=1/0"],
      // Array broadcasting: scalar+array, array+scalar, empty array, ragged array
      [2, 4, "=1+{1,2}"],
      [2, 7, "=FN_EMPTY_ARR()+1"],
      [2, 8, "=1+FN_EMPTY_ARR()"],
      [2, 9, "=FN_RAGGED()+{1,2}"],
      // Unary (scalar + array + non-number) and percent (number + non-number)
      [4, 0, "=+5"],
      [4, 1, "=-{1,\"bad\"}"],
      [4, 3, "=+{1,2}"],
      [4, 5, '=-"bad"'],
      [4, 6, "=50%"],
      [4, 7, '="bad"%'],
      // Syntax error, error literal, missing optional arg
      [5, 0, "=1+"],
      [5, 1, "=#N/A"],
      [5, 2, "=IF(TRUE,,2)"],
      // Single-element array, empty array & empty-row array spill edge cases
      [5, 3, "=FN_ONE_BY_ONE()"],
      [5, 4, "=FN_EMPTY_ROWS()"],
      [5, 5, "=E6"], // reads cached FN_EMPTY_ROWS array
      [5, 6, "=FN_RAGGED_SPILL()"], // ragged 2x2 array where mat[1][1] is undefined
      [5, 9, "=FN_EMPTY_ARR()"], // direct empty array -> applySpill mat[0]?.length ?? 0 & EMPTY_VAL
    ]);
    const res = engine.loadSheets([ws], {
      customFunctions: {
        FN_NULL: () => null,
        FN_STR: () => "hi",
        FN_BOOL: () => true,
        FN_EVAL: () => strVal("direct"),
        FN_THROW: () => {
          throw new Error("boom");
        },
        FN_EMPTY_ARR: () => arrVal([]),
        FN_RAGGED: () => arrVal([[numVal(1)], [numVal(2), numVal(3)]]),
        FN_ONE_BY_ONE: () => arrVal([[numVal(9)]]),
        FN_EMPTY_ROWS: () => arrVal([[], []]),
        FN_RAGGED_SPILL: () => arrVal([[numVal(1), numVal(2)], [numVal(3)]]),
      },
    });
    const m = res.get(1)!;
    expect(m["0:0"]).toEqual({ kind: "empty", value: "" });
    expect(m["0:1"]).toEqual({ kind: "string", value: "hi" });
    expect(m["0:2"]).toEqual({ kind: "boolean", value: true });
    expect(m["0:3"]).toEqual({ kind: "string", value: "direct" });
    expect(m["0:4"].kind).toBe("error");
    expect(m["0:5"]).toEqual({ kind: "error", value: "#NAME?", error: "#NAME?" });
    expect(m["1:8"]).toEqual({ kind: "number", value: 8 });
    expect(m["4:6"]).toEqual({ kind: "number", value: 0.5 });
    expect(m["5:0"]).toEqual({ kind: "error", value: "#ERROR!", error: "#ERROR!" });
    expect(m["5:3"]).toEqual({ kind: "number", value: 9 });
    expect(m["5:4"]).toEqual({ kind: "empty", value: "" });
    expect(engine.getValue(1, 5, 4)).toEqual({ kind: "empty", value: "" });
    expect(engine.getSheetValues(1)["5:4"]).toEqual({ kind: "empty", value: "" });
  });

  it("covers incremental updates, spills, range watchers, volatile/dynamic refs, defined names, and resolvers", () => {
    const ws1 = makeWs(
      1,
      "S1",
      [
        [0, 0, "10"], // A1
        [0, 1, "=SEQUENCE(2,2)"], // B1 spills to B2, C1, C2
        [0, 3, "=C2"], // D1 reads spilled C2
        [0, 4, "=RAND()"], // E1 volatile
        [0, 5, '=INDIRECT("A1")'], // F1 dynamic
        [0, 6, "=SUM(1:1)"], // G1 whole-row range watcher
        [0, 7, "=ScopedName"], // H1 sheet-scoped defined name
        [0, 8, "=BadName"], // I1 defined name with unparseable ref
        [0, 9, "=LoopA"], // J1 recursive defined name (depth > 8 in indexFormulaDependencies)
        // Resolver edge cases
        [2, 0, "=Missing!A1"], // unresolved sheet cell
        [2, 1, "=Missing!A1:B2"], // unresolved sheet range
        [2, 2, "=A1:Z99"], // out-of-bounds range
        [2, 3, "=ISFORMULA(Missing!A1)"], // resolveCellRef null sheet
        [2, 4, "=ISFORMULA(CellName)"], // resolveCellRef defined name -> cell
        [2, 5, "=ISFORMULA(BadSheetCellName)"], // resolveCellRef defined name -> missing sheet
        [2, 6, "=ISFORMULA(UnknownName)"], // resolveCellRef unknown name
        [2, 7, "=ISFORMULA(123)"], // resolveCellRef non-ref
        [2, 8, "=ISFORMULA(A10)"], // readRawCell empty cell
        [2, 9, '=INDIRECT("bad@@")'], // parseAndResolveRef null
        [3, 0, '=INDIRECT("Missing!A1")'], // parseAndResolveRef unknown sheet
        [3, 1, '=INDIRECT("1+2")'], // parseAndResolveRef non-ref
        [3, 2, "=INDEX(Missing!A1:B2,1,1)"], // readMatrix unresolved range
        [3, 3, "=INDEX(42,1,1)"], // readMatrix scalar fallback [[ev]]
        [3, 4, "=SEQUENCE(2,2)"], // E4 spills E4:F5 (populates E5 in spillCells)
        [4, 3, "=SEQUENCE(1,2)"], // D5 tries to spill into E5 -> collides with E4's spill!
        [3, 6, "=SUM(A1:A1)"], // G4 range watcher (for getDependents outside & inside)
      ],
      6,
      10,
    );
    const ws2 = makeWs(2, "S2", [[0, 0, "=SEQUENCE(1,2)"]], 4, 4);

    const engine = new IncrementalFormulaEngine();
    engine.loadSheets([ws1, ws2], {
      definedNames: [
        { name: "ScopedName", sheetName: "S1", ref: "42" },
        { name: "BadName", ref: "1+" },
        { name: "LoopA", ref: "LoopA" },
        { name: "CellName", ref: "B1" },
        { name: "BadSheetCellName", ref: "Missing!A1" },
      ],
    });

    // Multi-sheet getSheetValues with spills on both sheets (covers cKey.startsWith continue)
    expect(engine.getSheetValues(1)["1:2"]).toEqual({ kind: "number", value: 4 });
    expect(engine.getSheetValues(2)["0:1"]).toEqual({ kind: "number", value: 2 });
    expect(engine.getSheetValues(999)).toEqual({});

    // getPrecedents / getDependents (empty, direct, range watcher matching & non-matching)
    expect(engine.getPrecedents(1, 0, 0)).toEqual([]);
    expect(engine.getDependents(1, 200, 200)).toEqual([]);
    expect(engine.getDependents(1, 0, 0).length).toBeGreaterThan(0);

    // updateCells unknown sheet
    expect(engine.updateCells(999, [{ row: 0, col: 0, raw: "1" }])).toEqual({
      recalculated: 0,
      dirtyKeys: [],
    });

    // updateCells growing sheet rows/cols + colliding with existing spill (C2) + clearing range watcher (G1)
    const upd = engine.updateCells(1, [
      { row: 0, col: 0, raw: "20" }, // triggers volatile & dynamicRef dirtying
      { row: 1, col: 2, raw: "BLOCKER" }, // hits spillCells -> dirties B1 & clears B1's spill
      { row: 0, col: 6, raw: "plain" }, // clears range watcher G1 (clearCellDependencies prevWatches)
      { row: 10, col: 12, raw: "grow" }, // grows rt.rows and rt.cols
    ]);
    expect(upd.recalculated).toBeGreaterThan(0);
    expect(engine.getValue(1, 0, 1)).toEqual({ kind: "error", value: "#SPILL!", error: "#SPILL!" });
    expect(engine.getValue(1, 99, 99)).toEqual({ kind: "error", value: "#REF!", error: "#REF!" });
  });

  it("covers MAX_DEPTH and MAX_OPS #LIMIT! paths in evalCell, evalAstNode, range, and readMatrix", () => {
    // Reverse chain of 66 cells -> evalCell hits MAX_DEPTH (L608)
    const chainCells: [number, number, string][] = [];
    for (let r = 0; r < 66; r++) {
      chainCells.push([r, 0, `=A${r + 2}`]);
    }
    chainCells.push([66, 0, "1"]);
    // Depth 3 cell calling 62 unary '+' -> evalAstNode hits MAX_DEPTH (L646: 3 + 62 = 65 > 64)
    chainCells.push([0, 1, "=B2"]);
    chainCells.push([1, 1, "=B3"]);
    chainCells.push([2, 1, "=B4"]);
    chainCells.push([3, 1, "=" + "+".repeat(62) + "1"]);

    const depthEngine = new IncrementalFormulaEngine();
    const depthRes = depthEngine.loadSheets([makeWs(1, "Depth", chainCells, 70, 3)]).get(1)!;
    // #LIMIT! is intentionally uncached during evaluateAll, while shallower cells succeed
    expect(depthRes["0:0"]).toBeUndefined();
    expect(depthRes["0:1"]).toBeUndefined();
    expect(depthRes["66:0"]).toEqual({ kind: "number", value: 1 });

    // MAX_OPS in range (L669) and readMatrix (L740): 10,005x20 = 200,100 cells (> 200,000)
    const bigWs = makeWs(
      1,
      "Big",
      [
        [10006, 0, "=A1:T10005"],
        [10007, 0, "=SUM(A1:T10005)"],
      ],
      10010,
      20,
    );
    const opsEngine = new IncrementalFormulaEngine();
    opsEngine.loadSheets([bigWs]);
    expect(opsEngine.getValue(1, 10006, 0)).toEqual({ kind: "error", value: "#LIMIT!", error: "#LIMIT!" });
    expect(opsEngine.getValue(1, 10007, 0)).toEqual({ kind: "error", value: "#LIMIT!", error: "#LIMIT!" });
  });

  it("covers normalizePointForMerge, getVisibleRowIndices, and computeSortedRowWrites branches", () => {
    const lookup = buildMergeLookup([{ top: 0, left: 0, bottom: 1, right: 1 }]);
    expect(normalizePointForMerge({ row: 1, col: 1 }, lookup)).toEqual({ row: 0, col: 0 });
    expect(normalizePointForMerge({ row: 5, col: 5 }, lookup)).toEqual({ row: 5, col: 5 });

    // Filter disabled -> returns all rows; filter with values matching & non-matching & omitted headerRow
    const ws = makeWs(
      1,
      "Filter",
      [
        [0, 0, "Name"],
        [1, 0, "Alice"],
        [2, 0, "Bob"],
        [3, 0, ""],
        [4, 0, ""],
        [5, 0, "", { bold: true }], // styled empty row (covers style non-empty check in computeSortedRowWrites)
      ],
      6,
      2,
    );
    const evalMap = calculateWorkbook([ws]).get(1)!;
    expect(getVisibleRowIndices(ws, evalMap)).toEqual([0, 1, 2, 3, 4, 5]);
    ws.filter = { enabled: true, rules: { 0: { values: ["Alice"] } } };
    expect(getVisibleRowIndices(ws, evalMap)).toEqual([0, 1]);

    // computeSortedRowWrites: with merges -> []
    ws.merges = [{ top: 0, left: 0, bottom: 0, right: 1 }];
    expect(computeSortedRowWrites(ws, evalMap, 0, true)).toEqual([]);
    ws.merges = [];

    // <= 1 non-empty data row -> []
    const smallWs = makeWs(1, "Small", [[0, 0, "H"], [1, 0, "OnlyOne"]], 4, 2);
    expect(computeSortedRowWrites(smallWs, calculateWorkbook([smallWs]).get(1)!, 0, true)).toEqual([]);

    // Sort with empty rows (eA&&eB, eA, eB), already-in-place row (targetRow===srcRow), ascending & descending
    const sortWs = makeWs(
      1,
      "Sort",
      [
        [0, 0, "Val"],
        [1, 0, ""], // empty row 1
        [2, 0, "30"],
        [3, 0, "10"],
        [4, 0, ""], // empty row 4 (eA && eB)
        [5, 0, "20"],
        [6, 0, "", { bold: true }], // styled empty row 6
      ],
      7,
      2,
    );
    const sortEval = calculateWorkbook([sortWs]).get(1)!;
    const ascWrites = computeSortedRowWrites(sortWs, sortEval, 0, true);
    expect(ascWrites.length).toBeGreaterThan(0);
    const descWrites = computeSortedRowWrites(sortWs, sortEval, 0, false);
    expect(descWrites.length).toBeGreaterThan(0);
  });
});

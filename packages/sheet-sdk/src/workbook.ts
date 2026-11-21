import { formatCsv, parseCsv } from "./csv.js";
import { columnName, sheetAddress } from "./grid.js";
import { parseA1Token, parseRangeInput } from "./formula-ast.js";
import {
  buildWorksheetGridMap,
  computeSortedRowWrites,
  IncrementalFormulaEngine,
} from "./formula-engine.js";
import type { CustomFormulaFunction } from "./formula-functions.js";
import { formatCellDisplay } from "./numfmt.js";
import { evaluateSheetValidation, formatSheetRectA1, makeRuleId } from "./rules.js";
import { formatTSV, parseTSV } from "./tsv.js";
import type {
  ApplyOptions,
  ApplyResult,
  Diagnostic,
  EvalValue,
  InspectOptions,
  InspectResult,
  SheetAxis,
  SheetCell,
  SheetCellStyle,
  SheetChart,
  SheetChartType,
  SheetCondFormatOp,
  SheetConditionalFormat,
  SheetDataValidation,
  SheetDefinedName,
  SheetHyperlink,
  SheetMerge,
  SheetPivotTable,
  SheetWorksheet,
} from "./types.js";
import { exportWorkbookToXlsx, exportWorkbookToXlsxAsync, xlsxStyleToSheet } from "./workbook-xlsx.js";
import type { WriteXlsxOptions } from "./xlsx.js";
import { readXlsx, type ReadXlsxOptions } from "./xlsx-read.js";

export interface WorkbookCreateOptions {
  sheets?: { name: string; rows?: number; cols?: number }[];
  definedNames?: SheetDefinedName[];
}

export interface WorkbookCellChange {
  sheet: string;
  a1: string;
  beforeRaw: string;
  afterRaw: string;
  beforeValue?: string;
  afterValue?: string;
}

export interface WorkbookDiff {
  cellChanges: WorkbookCellChange[];
  structuralChanges: string[];
}

export type WorkbookOp =
  | { op: "setCells"; sheet: string; cells: { a1: string; raw?: string | number | boolean | null; style?: SheetCellStyle }[] }
  | { op: "setRange"; sheet: string; start: string; values: (string | number | boolean | null)[][] }
  | { op: "clearRange"; sheet: string; range: string }
  | { op: "addSheet"; name: string; rows?: number; cols?: number }
  | { op: "renameSheet"; from: string; to: string }
  | { op: "deleteSheet"; name: string }
  | { op: "merge"; sheet: string; range: string }
  | { op: "unmerge"; sheet: string; range: string }
  | { op: "setFreeze"; sheet: string; rows: number; cols: number }
  | { op: "resize"; sheet: string; colWidths?: Record<number, number>; rowHeights?: Record<number, number> }
  | { op: "sort"; sheet: string; col: number | string; ascending?: boolean; headerRow?: number }
  | { op: "defineName"; name: string; ref: string; sheetName?: string }
  | { op: "addValidation"; sheet: string; range: string; type: "list" | "number" | "date"; options?: string[]; min?: string; max?: string; strict?: boolean; hint?: string }
  | { op: "addConditionalFormat"; sheet: string; range: string; ruleOp: SheetCondFormatOp; value1?: string; value2?: string; bg?: string; color?: string; bold?: boolean }
  | { op: "addChart"; sheet: string; title: string; chartType: SheetChartType; range: string; headerRow?: boolean };

export interface WorkbookSheetSummary {
  name: string;
  rows: number;
  cols: number;
  usedRange: string | null;
  nonEmptyCells: number;
  formulaCells: number;
  errorCells: number;
  headers: string[];
  sampleRows?: string[][];
  merges: number;
  charts: number;
  pivots: number;
  validations: number;
  conditionalFormats: number;
}

export interface WorkbookInspectSummary {
  sheetCount: number;
  definedNames: SheetDefinedName[];
  sheets: WorkbookSheetSummary[];
  totalCells: number;
  totalFormulas: number;
  totalErrors: number;
}

export interface WorkbookQuery {
  sheet?: string;
  range?: string;
  search?: string;
  onlyFormulas?: boolean;
  onlyErrors?: boolean;
  limit?: number;
}

export interface WorkbookQueryCell {
  sheet: string;
  a1: string;
  row: number;
  col: number;
  raw: string;
  value: string | number | boolean | null;
  formatted: string;
  error?: string;
}

export interface WorkbookQueryResult {
  cells: WorkbookQueryCell[];
  truncated: boolean;
  totalMatched: number;
}

interface UndoEntry {
  token: string;
  before: { sheets: SheetWorksheet[]; definedNames: SheetDefinedName[] };
  after: { sheets: SheetWorksheet[]; definedNames: SheetDefinedName[] };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeAxes(count: number): SheetAxis[] {
  return Array.from({ length: count }, (_, idx) => ({ id: idx + 1, pos: idx }));
}

function makeEmptyWorksheet(id: number, title: string, pos: number, rows = 100, cols = 26): SheetWorksheet {
  return {
    id,
    nodeId: 0,
    title,
    pos,
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    filter: {},
    revision: 1,
    rows: makeAxes(Math.max(1, rows)),
    columns: makeAxes(Math.max(1, cols)),
    cells: [],
  };
}

function normalizeRawInput(raw: string | number | boolean | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "boolean") return raw ? "TRUE" : "FALSE";
  return String(raw);
}

function evalToPrimitive(ev: EvalValue | undefined): string | number | boolean | null {
  if (!ev || ev.kind === "empty") return null;
  if (ev.kind === "number" || ev.kind === "string" || ev.kind === "boolean") return ev.value;
  if (ev.kind === "error") return ev.error;
  return evalToPrimitive(ev.value[0]?.[0]);
}

function parseColIndex(col: number | string): number {
  if (typeof col === "number") return col;
  const trimmed = col.trim().toUpperCase();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  let idx = 0;
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0) - 64;
    if (code < 1 || code > 26) return -1;
    idx = idx * 26 + code;
  }
  return idx - 1;
}

function parseSheetRange(ref: string): { top: number; left: number; bottom: number; right: number } | null {
  const parsed = parseRangeInput(ref);
  if (!parsed) return null;
  return {
    top: Math.min(parsed.anchor.row, parsed.focus.row),
    left: Math.min(parsed.anchor.col, parsed.focus.col),
    bottom: Math.max(parsed.anchor.row, parsed.focus.row),
    right: Math.max(parsed.anchor.col, parsed.focus.col),
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * High-level ergonomic sheet proxy tied to a parent `Workbook`.
 */
export class WorksheetProxy {
  constructor(private readonly wb: Workbook, readonly id: number) {}

  private get ws(): SheetWorksheet {
    const found = this.wb._getWorksheetById(this.id);
    if (!found) throw new Error(`Worksheet ${this.id} no longer exists`);
    return found;
  }

  get name(): string { return this.ws.title; }
  get rowCount(): number { return this.ws.rows.length; }
  get colCount(): number { return this.ws.columns.length; }

  getCell(a1: string): { raw: string; value: string | number | boolean | null; formatted: string; style?: SheetCellStyle } {
    const pt = parseA1Token(a1);
    if (!pt) throw new Error(`Invalid cell address: ${a1}`);
    const cell = this.wb._getRawCellAt(this.id, pt.row, pt.col);
    const ev = this.wb._getEvalValue(this.id, pt.row, pt.col);
    const raw = cell?.raw ?? "";
    return {
      raw,
      value: evalToPrimitive(ev),
      formatted: formatCellDisplay(raw, ev, cell?.style),
      ...(cell?.style ? { style: { ...cell.style } } : {}),
    };
  }

  getValue(a1: string): string | number | boolean | null {
    const pt = parseA1Token(a1);
    if (!pt) throw new Error(`Invalid cell address: ${a1}`);
    return evalToPrimitive(this.wb._getEvalValue(this.id, pt.row, pt.col));
  }

  getFormatted(a1: string): string {
    return this.getCell(a1).formatted;
  }

  setCell(a1: string, raw: string | number | boolean | null, style?: SheetCellStyle): this {
    const pt = parseA1Token(a1);
    if (!pt) throw new Error(`Invalid cell address: ${a1}`);
    this.wb._setCellAt(this.id, pt.row, pt.col, normalizeRawInput(raw), style);
    return this;
  }

  setRange(startA1: string, values: readonly (readonly (string | number | boolean | null)[])[]): this {
    const pt = parseA1Token(startA1);
    if (!pt) throw new Error(`Invalid start address: ${startA1}`);
    const batch: { row: number; col: number; raw: string }[] = [];
    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        batch.push({ row: pt.row + r, col: pt.col + c, raw: normalizeRawInput(values[r][c]) });
      }
    }
    this.wb._setCellsBatch(this.id, batch);
    return this;
  }

  getRange(rangeA1: string): (string | number | boolean | null)[][] {
    const rect = parseSheetRange(rangeA1);
    if (!rect) throw new Error(`Invalid range: ${rangeA1}`);
    const out: (string | number | boolean | null)[][] = [];
    for (let r = rect.top; r <= rect.bottom; r++) {
      const row: (string | number | boolean | null)[] = [];
      for (let c = rect.left; c <= rect.right; c++) {
        row.push(evalToPrimitive(this.wb._getEvalValue(this.id, r, c)));
      }
      out.push(row);
    }
    return out;
  }

  clearRange(rangeA1: string): this {
    const rect = parseSheetRange(rangeA1);
    if (!rect) throw new Error(`Invalid range: ${rangeA1}`);
    const batch: { row: number; col: number; raw: string }[] = [];
    for (let r = rect.top; r <= rect.bottom; r++) {
      for (let c = rect.left; c <= rect.right; c++) batch.push({ row: r, col: c, raw: "" });
    }
    this.wb._setCellsBatch(this.id, batch);
    return this;
  }

  merge(rangeA1: string): this {
    const rect = parseSheetRange(rangeA1);
    if (!rect || (rect.top === rect.bottom && rect.left === rect.right)) throw new Error(`Invalid merge range: ${rangeA1}`);
    this.wb._addMerge(this.id, rect);
    return this;
  }

  unmerge(rangeA1: string): this {
    const rect = parseSheetRange(rangeA1);
    if (!rect) throw new Error(`Invalid unmerge range: ${rangeA1}`);
    this.wb._removeMerge(this.id, rect);
    return this;
  }

  setFreeze(rows: number, cols: number): this {
    const ws = this.ws;
    ws.frozenRows = Math.max(0, Math.trunc(rows));
    ws.frozenCols = Math.max(0, Math.trunc(cols));
    ws.revision++;
    this.wb._bumpVersion();
    return this;
  }

  setColWidth(col: number | string, widthPx: number): this {
    const idx = parseColIndex(col);
    const ws = this.ws;
    if (idx < 0 || !Number.isFinite(widthPx) || widthPx <= 0) throw new Error(`Invalid column resize: ${col}`);
    this.wb._ensureGridSize(ws, ws.rows.length, idx + 1);
    ws.columns[idx].size = widthPx;
    ws.revision++;
    this.wb._bumpVersion();
    return this;
  }

  setRowHeight(row: number, heightPx: number): this {
    const ws = this.ws;
    if (!Number.isInteger(row) || row < 0 || !Number.isFinite(heightPx) || heightPx <= 0) throw new Error(`Invalid row resize: ${row}`);
    this.wb._ensureGridSize(ws, row + 1, ws.columns.length);
    ws.rows[row].size = heightPx;
    ws.revision++;
    this.wb._bumpVersion();
    return this;
  }

  sort(col: number | string, ascending = true, headerRow = 0): this {
    const idx = parseColIndex(col);
    const ws = this.ws;
    if (idx < 0 || idx >= ws.columns.length) throw new Error(`Invalid sort column: ${col}`);
    const evalMap = this.wb._getSheetEvalMap(this.id);
    const writes = computeSortedRowWrites(ws, evalMap, idx, ascending, headerRow);
    if (writes.length) {
      const { rowPosById, colPosById } = buildWorksheetGridMap(ws);
      const batch = writes.map((w) => ({
        row: rowPosById.get(w.rowId)!,
        col: colPosById.get(w.columnId)!,
        raw: w.raw!,
        style: w.style,
      }));
      this.wb._setCellsBatch(this.id, batch);
    }
    return this;
  }

  addValidation(rule: Omit<SheetDataValidation, "id"> & { id?: string }): SheetDataValidation {
    const ws = this.ws;
    const created: SheetDataValidation = { ...rule, id: rule.id ?? makeRuleId("dv") };
    ws.validations = [...(ws.validations ?? []), created];
    ws.revision++;
    this.wb._bumpVersion();
    return created;
  }

  addConditionalFormat(rule: Omit<SheetConditionalFormat, "id"> & { id?: string }): SheetConditionalFormat {
    const ws = this.ws;
    const created: SheetConditionalFormat = { ...rule, id: rule.id ?? makeRuleId("cf") };
    ws.conditionalFormats = [...(ws.conditionalFormats ?? []), created];
    ws.revision++;
    this.wb._bumpVersion();
    return created;
  }

  addChart(chart: Omit<SheetChart, "id"> & { id?: string }): SheetChart {
    const ws = this.ws;
    const created: SheetChart = { ...chart, id: chart.id ?? makeRuleId("chart") };
    ws.charts = [...(ws.charts ?? []), created];
    ws.revision++;
    this.wb._bumpVersion();
    return created;
  }

  addPivotTable(pivot: Omit<SheetPivotTable, "id"> & { id?: string }): SheetPivotTable {
    const ws = this.ws;
    const created: SheetPivotTable = { ...pivot, id: pivot.id ?? makeRuleId("pivot") };
    ws.pivotTables = [...(ws.pivotTables ?? []), created];
    ws.revision++;
    this.wb._bumpVersion();
    return created;
  }

  addHyperlink(link: SheetHyperlink): this {
    const ws = this.ws;
    ws.hyperlinks = [...(ws.hyperlinks ?? []).filter((h) => !(h.row === link.row && h.col === link.col)), link];
    ws.revision++;
    this.wb._bumpVersion();
    return this;
  }
}

/**
 * Lightweight, zero-DOM, AI-Native Spreadsheet Facade.
 * Backed by the incremental AST+DAG formula engine and bounded OOXML I/O.
 */
export class Workbook {
  private sheets: SheetWorksheet[] = [];
  private definedNames: SheetDefinedName[] = [];
  private readonly engine = new IncrementalFormulaEngine();
  private customFns = new Map<string, CustomFormulaFunction>();
  private versionCounter = 1;
  private nextSheetId = 1;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private maxUndo = 50;
  private cellIndexCache = new Map<number, { revision: number; ref: SheetCell[]; byAxisKey: Map<string, number> }>();

  private constructor(sheets: SheetWorksheet[], definedNames: SheetDefinedName[] = []) {
    this.sheets = sheets.length ? cloneJson(sheets) : [makeEmptyWorksheet(1, "Sheet1", 0)];
    this.definedNames = cloneJson(definedNames);
    this.nextSheetId = this.sheets.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    this.engine.loadSheets(this.sheets, { definedNames: this.definedNames });
  }

  static create(options: WorkbookCreateOptions = {}): Workbook {
    const specs = options.sheets?.length ? options.sheets : [{ name: "Sheet1", rows: 100, cols: 26 }];
    const sheets = specs.map((s, idx) => makeEmptyWorksheet(idx + 1, s.name, idx, s.rows ?? 100, s.cols ?? 26));
    return new Workbook(sheets, options.definedNames ?? []);
  }

  static fromSnapshot(sheets: readonly SheetWorksheet[], definedNames: readonly SheetDefinedName[] = []): Workbook {
    return new Workbook(cloneJson([...sheets]), cloneJson([...definedNames]));
  }

  static async fromXlsx(bytes: Uint8Array, options?: ReadXlsxOptions): Promise<{ workbook: Workbook; warnings: string[] }> {
    const parsed = await readXlsx(bytes, options);
    const sheets: SheetWorksheet[] = parsed.workbook.sheets.map((s, idx) => {
      let maxRow = 50;
      let maxCol = 20;
      for (const c of s.cells) {
        if (c.row + 10 > maxRow) maxRow = c.row + 10;
        if (c.col + 5 > maxCol) maxCol = c.col + 5;
      }
      const ws = makeEmptyWorksheet(idx + 1, s.name, idx, maxRow, maxCol);
      ws.frozenRows = s.frozen?.rows ?? 0;
      ws.frozenCols = s.frozen?.cols ?? 0;
      ws.merges = (s.merges ?? []).map((m) => ({ ...m }));
      if (s.validations?.length) ws.validations = cloneJson([...s.validations]);
      if (s.hyperlinks?.length) ws.hyperlinks = cloneJson([...s.hyperlinks]);
      if (s.colWidths) {
        for (const [k, w] of Object.entries(s.colWidths)) {
          const ci = Number(k);
          if (ci >= 0 && ci < ws.columns.length) ws.columns[ci].size = Math.round(w * 7.5);
        }
      }
      if (s.rowHeights) {
        for (const [k, h] of Object.entries(s.rowHeights)) {
          const ri = Number(k);
          if (ri >= 0 && ri < ws.rows.length) ws.rows[ri].size = Math.round(h / 0.75);
        }
      }
      for (const c of s.cells) {
        let raw = "";
        if (c.formula) raw = c.formula;
        else if (typeof c.value === "boolean") raw = c.value ? "TRUE" : "FALSE";
        else if (typeof c.value === "object" && c.value !== null) raw = c.value.error;
        else if (c.value !== undefined) raw = String(c.value);
        const style = xlsxStyleToSheet(c.style);
        if (!raw && !style) continue;
        ws.cells.push({
          rowId: ws.rows[c.row].id,
          columnId: ws.columns[c.col].id,
          raw,
          ...(style ? { style } : {}),
          revision: 1,
        });
      }
      return ws;
    });
    return {
      workbook: new Workbook(sheets, parsed.workbook.definedNames ? [...parsed.workbook.definedNames] : []),
      warnings: parsed.warnings,
    };
  }

  static fromCsv(csv: string, sheetName = "Sheet1"): Workbook {
    const rows = parseCsv(csv);
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 1);
    const wb = Workbook.create({ sheets: [{ name: sheetName, rows: Math.max(rows.length + 10, 50), cols: Math.max(cols + 4, 16) }] });
    if (rows.length) wb.sheet(0).setRange("A1", rows);
    return wb;
  }

  static fromTsv(tsv: string, sheetName = "Sheet1"): Workbook {
    const rows = parseTSV(tsv);
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 1);
    const wb = Workbook.create({ sheets: [{ name: sheetName, rows: Math.max(rows.length + 10, 50), cols: Math.max(cols + 4, 16) }] });
    if (rows.length) wb.sheet(0).setRange("A1", rows);
    return wb;
  }

  get version(): number { return this.versionCounter; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  listSheets(): string[] { return this.sheets.map((s) => s.title); }

  sheet(nameOrIndex: string | number): WorksheetProxy {
    const ws = typeof nameOrIndex === "number"
      ? this.sheets[nameOrIndex]
      : this.sheets.find((s) => s.title.toLowerCase() === nameOrIndex.trim().toLowerCase());
    if (!ws) throw new Error(`Worksheet not found: ${String(nameOrIndex)}`);
    return new WorksheetProxy(this, ws.id);
  }

  addSheet(name: string, rows = 100, cols = 26): WorksheetProxy {
    const clean = name.trim();
    if (!clean || clean.length > 31) throw new Error(`Invalid sheet name: ${name}`);
    if (this.sheets.some((s) => s.title.toLowerCase() === clean.toLowerCase())) {
      throw new Error(`Duplicate sheet name: ${clean}`);
    }
    const ws = makeEmptyWorksheet(this.nextSheetId++, clean, this.sheets.length, rows, cols);
    this.sheets.push(ws);
    this.recalculateAll();
    this._bumpVersion();
    return new WorksheetProxy(this, ws.id);
  }

  renameSheet(oldName: string, newName: string): this {
    const clean = newName.trim();
    if (!clean || clean.length > 31) throw new Error(`Invalid sheet name: ${newName}`);
    const ws = this.sheets.find((s) => s.title.toLowerCase() === oldName.trim().toLowerCase());
    if (!ws) throw new Error(`Worksheet not found: ${oldName}`);
    if (this.sheets.some((s) => s.id !== ws.id && s.title.toLowerCase() === clean.toLowerCase())) {
      throw new Error(`Duplicate sheet name: ${clean}`);
    }
    ws.title = clean;
    ws.revision++;
    this.recalculateAll();
    this._bumpVersion();
    return this;
  }

  deleteSheet(name: string): this {
    if (this.sheets.length <= 1) throw new Error("Cannot delete the last worksheet");
    const idx = this.sheets.findIndex((s) => s.title.toLowerCase() === name.trim().toLowerCase());
    if (idx < 0) throw new Error(`Worksheet not found: ${name}`);
    this.sheets.splice(idx, 1);
    this.sheets.forEach((s, i) => { s.pos = i; });
    this.recalculateAll();
    this._bumpVersion();
    return this;
  }

  defineName(name: string, ref: string, sheetName?: string): this {
    const clean = name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(clean)) throw new Error(`Invalid defined name: ${name}`);
    const lower = clean.toLowerCase();
    const scopeLower = sheetName?.trim().toLowerCase();
    this.definedNames = [
      ...this.definedNames.filter((d) => !(d.name.toLowerCase() === lower && d.sheetName?.toLowerCase() === scopeLower)),
      { name: clean, ref: ref.trim(), ...(sheetName ? { sheetName } : {}) },
    ];
    this.recalculateAll();
    this._bumpVersion();
    return this;
  }

  registerFunction(name: string, fn: CustomFormulaFunction): this {
    this.customFns.set(name.trim().toUpperCase(), fn);
    this.engine.registerFunction(name, fn);
    this.engine.evaluateAll();
    return this;
  }

  recalculate(): { evaluatedSheets: number } {
    this.engine.evaluateAll();
    return { evaluatedSheets: this.sheets.length };
  }

  recalculateAll(): Map<number, Record<string, EvalValue>> {
    const customFunctions: Record<string, CustomFormulaFunction> = {};
    for (const [k, v] of this.customFns) customFunctions[k] = v;
    return this.engine.loadSheets(this.sheets, { definedNames: this.definedNames, customFunctions });
  }

  getPrecedents(sheetName: string, a1: string): string[] {
    const ws = this.sheets.find((s) => s.title.toLowerCase() === sheetName.trim().toLowerCase());
    const pt = parseA1Token(a1);
    if (!ws || !pt) return [];
    return this.engine.getPrecedents(ws.id, pt.row, pt.col);
  }

  getDependents(sheetName: string, a1: string): string[] {
    const ws = this.sheets.find((s) => s.title.toLowerCase() === sheetName.trim().toLowerCase());
    const pt = parseA1Token(a1);
    if (!ws || !pt) return [];
    return this.engine.getDependents(ws.id, pt.row, pt.col);
  }

  toSnapshot(): { sheets: SheetWorksheet[]; definedNames: SheetDefinedName[] } {
    return { sheets: cloneJson(this.sheets), definedNames: cloneJson(this.definedNames) };
  }

  toXlsx(options?: WriteXlsxOptions): Uint8Array {
    return exportWorkbookToXlsx(this.sheets, options);
  }

  async toXlsxAsync(options?: WriteXlsxOptions): Promise<Uint8Array> {
    return exportWorkbookToXlsxAsync(this.sheets, options);
  }

  toCsv(sheetName?: string): string {
    const ws = sheetName ? this.sheets.find((s) => s.title.toLowerCase() === sheetName.trim().toLowerCase()) : this.sheets[0];
    if (!ws) throw new Error(`Worksheet not found: ${sheetName}`);
    return formatCsv(this.extractDenseFormattedMatrix(ws));
  }

  toTsv(sheetName?: string): string {
    const ws = sheetName ? this.sheets.find((s) => s.title.toLowerCase() === sheetName.trim().toLowerCase()) : this.sheets[0];
    if (!ws) throw new Error(`Worksheet not found: ${sheetName}`);
    return formatTSV(this.extractDenseFormattedMatrix(ws));
  }

  undo(token?: string): boolean {
    if (!this.undoStack.length) return false;
    if (token && this.undoStack[this.undoStack.length - 1].token !== token) return false;
    const entry = this.undoStack.pop()!;
    this.redoStack.push(entry);
    this.restoreState(entry.before);
    return true;
  }

  redo(): boolean {
    if (!this.redoStack.length) return false;
    const entry = this.redoStack.pop()!;
    this.undoStack.push(entry);
    this.restoreState(entry.after);
    return true;
  }

  // ---------- AI-Native Primitives ----------

  inspect(options: InspectOptions = {}): InspectResult<WorkbookInspectSummary> {
    const detail = options.detail ?? "summary";
    const maxTokens = options.maxTokens ?? 2000;
    const focusLower = options.focus?.trim().toLowerCase();
    const startIdx = options.cursor ? Math.max(0, Number(options.cursor) || 0) : 0;

    const targetSheets = focusLower
      ? this.sheets.filter((s) => s.title.toLowerCase() === focusLower)
      : this.sheets;

    const sheetSummaries: WorkbookSheetSummary[] = [];
    let totalCells = 0;
    let totalFormulas = 0;
    let totalErrors = 0;

    const promptLines: string[] = [];
    promptLines.push(`# Workbook (${this.sheets.length} sheet${this.sheets.length === 1 ? "" : "s"}, v${this.versionCounter})`);
    if (this.definedNames.length) {
      promptLines.push(`Defined Names: ${this.definedNames.map((d) => `${d.name}=${d.ref}`).join(", ")}`);
    }

    let truncated = false;
    let nextCursor: string | undefined;
    const sampleLimit = detail === "outline" ? 0 : detail === "summary" ? 5 : 50;

    for (let si = startIdx; si < targetSheets.length; si++) {
      const ws = targetSheets[si];
      const evalMap = this.engine.getSheetValues(ws.id);
      const rowPosById = new Map<number, number>();
      for (let i = 0; i < ws.rows.length; i++) rowPosById.set(ws.rows[i].id, i);
      const colPosById = new Map<number, number>();
      for (let i = 0; i < ws.columns.length; i++) colPosById.set(ws.columns[i].id, i);

      let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
      let nonEmpty = 0, formulas = 0, errors = 0;

      for (let i = 0; i < ws.cells.length; i++) {
        const cell = ws.cells[i];
        if (!cell.raw) continue;
        const r = rowPosById.get(cell.rowId);
        const c = colPosById.get(cell.columnId);
        if (r === undefined || c === undefined) continue;
        nonEmpty++;
        if (cell.raw.charCodeAt(0) === 61 /* '=' */) {
          formulas++;
          const ev = evalMap[`${r}:${c}`];
          if (ev?.kind === "error") errors++;
        } else if (cell.raw.charCodeAt(0) === 35 /* '#' */) {
          const ev = evalMap[`${r}:${c}`];
          if (ev?.kind === "error") errors++;
        }
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }

      totalCells += nonEmpty;
      totalFormulas += formulas;
      totalErrors += errors;

      const usedRange = maxR >= minR && maxC >= minC
        ? `${sheetAddress({ row: minR, col: minC })}:${sheetAddress({ row: maxR, col: maxC })}`
        : null;

      const headers: string[] = [];
      const sampleRows: string[][] = [];
      if (usedRange) {
        const capCol = Math.min(maxC, minC + 15);
        for (let c = minC; c <= capCol; c++) {
          const cell = this._getRawCellAt(ws.id, minR, c);
          headers.push(formatCellDisplay(cell?.raw ?? "", evalMap[`${minR}:${c}`], cell?.style) || columnName(c));
        }
        const maxSampleRow = Math.min(maxR, minR + sampleLimit);
        for (let r = minR + 1; r <= maxSampleRow; r++) {
          const rowVals: string[] = [];
          for (let c = minC; c <= capCol; c++) {
            const cell = this._getRawCellAt(ws.id, r, c);
            rowVals.push(formatCellDisplay(cell?.raw ?? "", evalMap[`${r}:${c}`], cell?.style));
          }
          sampleRows.push(rowVals);
        }
      }

      const summary: WorkbookSheetSummary = {
        name: ws.title,
        rows: ws.rows.length,
        cols: ws.columns.length,
        usedRange,
        nonEmptyCells: nonEmpty,
        formulaCells: formulas,
        errorCells: errors,
        headers,
        ...(sampleLimit > 0 ? { sampleRows } : {}),
        merges: ws.merges.length,
        charts: ws.charts?.length ?? 0,
        pivots: ws.pivotTables?.length ?? 0,
        validations: ws.validations?.length ?? 0,
        conditionalFormats: ws.conditionalFormats?.length ?? 0,
      };
      sheetSummaries.push(summary);

      const sectionLines: string[] = [];
      sectionLines.push(`\n## Sheet: ${ws.title} (${usedRange ?? "empty"}, cells=${nonEmpty}, formulas=${formulas}, errors=${errors})`);
      if (headers.length) sectionLines.push(`Headers: | ${headers.join(" | ")} |`);
      if (sampleRows.length) {
        sectionLines.push(`| ${headers.map(() => "---").join(" | ")} |`);
        for (const r of sampleRows) sectionLines.push(`| ${r.join(" | ")} |`);
      }

      const candidate = [...promptLines, ...sectionLines].join("\n");
      if (estimateTokens(candidate) > maxTokens && promptLines.length > 2) {
        truncated = true;
        nextCursor = String(si);
        break;
      }
      promptLines.push(...sectionLines);
    }

    let promptText = promptLines.join("\n");
    if (estimateTokens(promptText) > maxTokens) {
      const charBudget = Math.max(200, Math.floor(maxTokens * 3.5));
      promptText = promptText.slice(0, charBudget) + "\n…(truncated)";
      truncated = true;
    }

    return {
      kind: "sheet",
      version: this.versionCounter,
      promptText,
      summary: {
        sheetCount: this.sheets.length,
        definedNames: cloneJson(this.definedNames),
        sheets: sheetSummaries,
        totalCells,
        totalFormulas,
        totalErrors,
      },
      estimatedTokens: estimateTokens(promptText),
      truncated,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  query(params: WorkbookQuery = {}): WorkbookQueryResult {
    const limit = Math.min(2000, Math.max(1, params.limit ?? 200));
    let targetSheetName = params.sheet;
    let rangeRef = params.range;
    if (rangeRef && rangeRef.includes("!")) {
      const idx = rangeRef.indexOf("!");
      targetSheetName = rangeRef.slice(0, idx).replace(/^'|'$/g, "");
      rangeRef = rangeRef.slice(idx + 1);
    }
    const targetSheets = targetSheetName
      ? this.sheets.filter((s) => s.title.toLowerCase() === targetSheetName!.trim().toLowerCase())
      : this.sheets;
    const rect = rangeRef ? parseSheetRange(rangeRef) : null;
    const searchLower = params.search?.toLowerCase();

    const matched: WorkbookQueryCell[] = [];
    let totalMatched = 0;
    let truncated = false;

    for (const ws of targetSheets) {
      const { cellByKey } = buildWorksheetGridMap(ws);
      const evalMap = this.engine.getSheetValues(ws.id);
      const keys = rect
        ? (() => {
            const ks: string[] = [];
            for (let r = rect.top; r <= rect.bottom; r++) {
              for (let c = rect.left; c <= rect.right; c++) ks.push(`${r}:${c}`);
            }
            return ks;
          })()
        : [...new Set([...cellByKey.keys(), ...Object.keys(evalMap)])].sort((a, b) => {
            const [ar, ac] = a.split(":").map(Number);
            const [br, bc] = b.split(":").map(Number);
            return ar - br || ac - bc;
          });

      for (const key of keys) {
        const [row, col] = key.split(":").map(Number);
        const cell = cellByKey.get(key);
        const raw = cell?.raw ?? "";
        const ev = evalMap[key];
        if (!rect && !raw && !ev) continue;
        if (params.onlyFormulas && !raw.startsWith("=")) continue;
        if (params.onlyErrors && ev?.kind !== "error") continue;
        const formatted = formatCellDisplay(raw, ev, cell?.style);
        if (searchLower && !raw.toLowerCase().includes(searchLower) && !formatted.toLowerCase().includes(searchLower)) {
          continue;
        }
        totalMatched++;
        if (matched.length < limit) {
          matched.push({
            sheet: ws.title,
            a1: sheetAddress({ row, col }),
            row,
            col,
            raw,
            value: evalToPrimitive(ev),
            formatted,
            ...(ev?.kind === "error" ? { error: ev.error } : {}),
          });
        } else {
          truncated = true;
        }
      }
    }

    return { cells: matched, truncated, totalMatched };
  }

  apply(ops: readonly WorkbookOp[], options: ApplyOptions = {}): ApplyResult<WorkbookDiff> {
    const dryRun = options.dryRun === true;
    const atomic = options.atomic !== false;

    if (dryRun) {
      const clone = new Workbook(this.sheets, this.definedNames);
      for (const [k, fn] of this.customFns) clone.registerFunction(k, fn);
      const res = clone.apply(ops, { ...options, dryRun: false });
      return { ...res, dryRun: true, undoToken: undefined };
    }

    const beforeState = this.toSnapshot();
    const diff: WorkbookDiff = { cellChanges: [], structuralChanges: [] };
    let appliedCount = 0;

    try {
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        this.executeOp(op, diff);
        appliedCount++;
      }
    } catch (err) {
      if (atomic) this.restoreState(beforeState);
      return {
        ok: false,
        dryRun: false,
        appliedCount: atomic ? 0 : appliedCount,
        diff: atomic ? { cellChanges: [], structuralChanges: [] } : diff,
        diagnostics: this.verify(),
        error: {
          index: appliedCount,
          code: "op_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const afterState = this.toSnapshot();
    const undoToken = `undo-${this.versionCounter}-${Date.now().toString(36)}`;
    this.undoStack.push({ token: undoToken, before: beforeState, after: afterState });
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack = [];

    return {
      ok: true,
      dryRun: false,
      appliedCount,
      diff,
      diagnostics: this.verify(),
      undoToken,
    };
  }

  verify(): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const ws of this.sheets) {
      const { cellByKey } = buildWorksheetGridMap(ws);
      const evalMap = this.engine.getSheetValues(ws.id);

      // 1. Formula errors & validation checks
      for (const [key, cell] of cellByKey) {
        const [r, c] = key.split(":").map(Number);
        const target = `${ws.title}!${sheetAddress({ row: r, col: c })}`;
        const ev = evalMap[key];
        if (ev?.kind === "error") {
          diagnostics.push({
            severity: "error",
            code: `formula_${ev.error.replace(/[^A-Z0-9]/gi, "").toLowerCase()}`,
            target,
            message: `Formula "${cell.raw}" evaluated to ${ev.error}`,
            suggestion:
              ev.error === "#DIV/0!"
                ? "Guard denominator with IF(denom=0, 0, ...) or IFERROR(..., 0)"
                : ev.error === "#CYCLE!"
                  ? "Break the circular cell reference chain"
                  : ev.error === "#NAME?"
                    ? "Check function name spelling or define missing named range"
                    : ev.error === "#SPILL!"
                      ? "Clear non-empty cells blocking the dynamic array spill range"
                      : "Verify referenced sheet/cell coordinates and argument types",
          });
        }
        if (ws.validations?.length && cell.raw) {
          const valRes = evaluateSheetValidation(cell.raw, ws.validations, r, c);
          if (!valRes.valid) {
            diagnostics.push({
              severity: valRes.strict ? "error" : "warning",
              code: "validation_violation",
              target,
              message: valRes.message,
              suggestion: valRes.rule?.type === "list" && valRes.rule.options
                ? `Use one of: ${valRes.rule.options.join(", ")}`
                : "Adjust cell value to satisfy data validation bounds",
            });
          }
        }
      }

      // 2. Merge overlap & bounds checks
      const mergeCells = new Set<string>();
      for (const m of ws.merges) {
        const ref = `${ws.title}!${formatSheetRectA1(m)}`;
        if (m.top < 0 || m.left < 0 || m.bottom >= ws.rows.length || m.right >= ws.columns.length || m.top > m.bottom || m.left > m.right) {
          diagnostics.push({ severity: "error", code: "merge_out_of_bounds", target: ref, message: "Merged range exceeds worksheet bounds" });
          continue;
        }
        let overlap = false;
        for (let r = m.top; r <= m.bottom && !overlap; r++) {
          for (let c = m.left; c <= m.right; c++) {
            const k = `${r}:${c}`;
            if (mergeCells.has(k)) { overlap = true; break; }
            mergeCells.add(k);
          }
        }
        if (overlap) {
          diagnostics.push({ severity: "error", code: "merge_overlap", target: ref, message: "Merged range overlaps another merge" });
        }
      }

      // 3. Chart & Pivot bounds checks
      for (const chart of ws.charts ?? []) {
        if (chart.bottom >= ws.rows.length || chart.right >= ws.columns.length || chart.top > chart.bottom || chart.left > chart.right) {
          diagnostics.push({ severity: "warning", code: "chart_invalid_range", target: `${ws.title}#chart:${chart.id}`, message: `Chart "${chart.title}" references out-of-bounds range` });
        }
      }
      for (const pivot of ws.pivotTables ?? []) {
        if (pivot.bottom >= ws.rows.length || pivot.right >= ws.columns.length || pivot.top > pivot.bottom || pivot.left > pivot.right) {
          diagnostics.push({ severity: "warning", code: "pivot_invalid_range", target: `${ws.title}#pivot:${pivot.id}`, message: `Pivot "${pivot.title}" references out-of-bounds range` });
        }
      }
    }

    return diagnostics;
  }

  // ---------- Internal mutators shared with WorksheetProxy ----------

  /** @internal */
  _getWorksheetById(id: number): SheetWorksheet | undefined {
    return this.sheets.find((s) => s.id === id);
  }

  /** @internal */
  _bumpVersion(): void {
    this.versionCounter++;
  }

  /** @internal */
  _getEvalValue(sheetId: number, row: number, col: number): EvalValue {
    return this.engine.getValue(sheetId, row, col);
  }

  /** @internal */
  _getSheetEvalMap(sheetId: number): Record<string, EvalValue> {
    return this.engine.getSheetValues(sheetId);
  }

  /** @internal */
  _ensureGridSize(ws: SheetWorksheet, minRows: number, minCols: number): void {
    while (ws.rows.length < minRows) {
      const nextId = ws.rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
      ws.rows.push({ id: nextId, pos: ws.rows.length });
    }
    while (ws.columns.length < minCols) {
      const nextId = ws.columns.reduce((m, c) => Math.max(m, c.id), 0) + 1;
      ws.columns.push({ id: nextId, pos: ws.columns.length });
    }
  }

  /** @internal */
  _setCellAt(sheetId: number, row: number, col: number, raw: string, style?: SheetCellStyle): void {
    this._setCellsBatch(sheetId, [{ row, col, raw, style }]);
  }

  private getCellIndex(ws: SheetWorksheet): Map<string, number> {
    const cached = this.cellIndexCache.get(ws.id);
    if (cached && cached.revision === ws.revision && cached.ref === ws.cells) {
      return cached.byAxisKey;
    }
    const byAxisKey = new Map<string, number>();
    for (let i = 0; i < ws.cells.length; i++) {
      const c = ws.cells[i];
      byAxisKey.set(`${c.rowId}:${c.columnId}`, i);
    }
    this.cellIndexCache.set(ws.id, { revision: ws.revision, ref: ws.cells, byAxisKey });
    return byAxisKey;
  }

  /** @internal */
  _getRawCellAt(sheetId: number, row: number, col: number): SheetCell | undefined {
    const ws = this._getWorksheetById(sheetId);
    if (!ws || row < 0 || col < 0 || row >= ws.rows.length || col >= ws.columns.length) return undefined;
    const idx = this.getCellIndex(ws).get(`${ws.rows[row].id}:${ws.columns[col].id}`);
    return idx !== undefined ? ws.cells[idx] : undefined;
  }

  /** @internal */
  _setCellsBatch(sheetId: number, items: readonly { row: number; col: number; raw?: string; style?: SheetCellStyle }[]): void {
    const ws = this._getWorksheetById(sheetId);
    if (!ws || !items.length) return;

    let maxR = ws.rows.length;
    let maxC = ws.columns.length;
    for (const item of items) {
      if (item.row + 1 > maxR) maxR = item.row + 1;
      if (item.col + 1 > maxC) maxC = item.col + 1;
    }
    this._ensureGridSize(ws, maxR, maxC);

    const indexMap = this.getCellIndex(ws);
    const rawChanges: { row: number; col: number; raw: string }[] = [];
    for (const item of items) {
      const rowId = ws.rows[item.row].id;
      const columnId = ws.columns[item.col].id;
      const aKey = `${rowId}:${columnId}`;
      const existingIdx = indexMap.get(aKey);
      const existing = existingIdx !== undefined ? ws.cells[existingIdx] : undefined;
      const nextRaw = item.raw !== undefined ? item.raw : (existing?.raw ?? "");
      const nextStyle = item.style !== undefined ? { ...(existing?.style ?? {}), ...item.style } : existing?.style;
      const hasStyle = nextStyle && Object.keys(nextStyle).length > 0;
      if (!nextRaw && !hasStyle) {
        if (existingIdx !== undefined) {
          const lastIdx = ws.cells.length - 1;
          if (existingIdx !== lastIdx) {
            const moved = ws.cells[lastIdx];
            ws.cells[existingIdx] = moved;
            indexMap.set(`${moved.rowId}:${moved.columnId}`, existingIdx);
          }
          ws.cells.pop();
          indexMap.delete(aKey);
        }
      } else {
        const nextCell: SheetCell = {
          rowId,
          columnId,
          raw: nextRaw,
          ...(hasStyle ? { style: nextStyle } : {}),
          revision: (existing?.revision ?? 0) + 1,
        };
        if (existingIdx !== undefined) {
          ws.cells[existingIdx] = nextCell;
        } else {
          indexMap.set(aKey, ws.cells.length);
          ws.cells.push(nextCell);
        }
      }
      if (item.raw !== undefined) rawChanges.push({ row: item.row, col: item.col, raw: nextRaw });
    }
    ws.revision++;
    this.cellIndexCache.set(ws.id, { revision: ws.revision, ref: ws.cells, byAxisKey: indexMap });
    if (rawChanges.length) this.engine.updateCells(sheetId, rawChanges);
    this._bumpVersion();
  }

  /** @internal */
  _addMerge(sheetId: number, rect: SheetMerge): void {
    const ws = this._getWorksheetById(sheetId);
    if (!ws) return;
    this._ensureGridSize(ws, rect.bottom + 1, rect.right + 1);
    const overlaps = ws.merges.some(
      (m) => !(rect.bottom < m.top || rect.top > m.bottom || rect.right < m.left || rect.left > m.right),
    );
    if (overlaps) throw new Error(`Merge ${formatSheetRectA1(rect)} overlaps an existing merge`);
    ws.merges = [...ws.merges, { ...rect }];
    ws.revision++;
    this._bumpVersion();
  }

  /** @internal */
  _removeMerge(sheetId: number, rect: SheetMerge): void {
    const ws = this._getWorksheetById(sheetId);
    if (!ws) return;
    ws.merges = ws.merges.filter(
      (m) => rect.bottom < m.top || rect.top > m.bottom || rect.right < m.left || rect.left > m.right,
    );
    ws.revision++;
    this._bumpVersion();
  }

  private restoreState(state: { sheets: SheetWorksheet[]; definedNames: SheetDefinedName[] }): void {
    this.sheets = cloneJson(state.sheets);
    this.definedNames = cloneJson(state.definedNames);
    this.recalculateAll();
    this._bumpVersion();
  }

  private extractDenseFormattedMatrix(ws: SheetWorksheet): string[][] {
    const { cellByKey } = buildWorksheetGridMap(ws);
    const evalMap = this.engine.getSheetValues(ws.id);
    let maxR = -1, maxC = -1;
    for (const [key, cell] of cellByKey) {
      if (!cell.raw) continue;
      const [r, c] = key.split(":").map(Number);
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
    if (maxR < 0 || maxC < 0) return [];
    const rows: string[][] = [];
    for (let r = 0; r <= maxR; r++) {
      const line: string[] = [];
      for (let c = 0; c <= maxC; c++) {
        const cell = cellByKey.get(`${r}:${c}`);
        line.push(formatCellDisplay(cell?.raw ?? "", evalMap[`${r}:${c}`], cell?.style));
      }
      rows.push(line);
    }
    return rows;
  }

  private executeOp(op: WorkbookOp, diff: WorkbookDiff): void {
    switch (op.op) {
      case "addSheet":
        this.addSheet(op.name, op.rows, op.cols);
        diff.structuralChanges.push(`addSheet:${op.name}`);
        return;
      case "renameSheet":
        this.renameSheet(op.from, op.to);
        diff.structuralChanges.push(`renameSheet:${op.from}->${op.to}`);
        return;
      case "deleteSheet":
        this.deleteSheet(op.name);
        diff.structuralChanges.push(`deleteSheet:${op.name}`);
        return;
      case "defineName":
        this.defineName(op.name, op.ref, op.sheetName);
        diff.structuralChanges.push(`defineName:${op.name}=${op.ref}`);
        return;
      case "setCells": {
        const proxy = this.sheet(op.sheet);
        const beforeSnap = op.cells.map((c) => {
          const cur = proxy.getCell(c.a1);
          return { a1: c.a1, pt: parseA1Token(c.a1)!, raw: cur.raw, formatted: cur.formatted };
        });
        const items = op.cells.map((c, idx) => ({
          row: beforeSnap[idx].pt.row,
          col: beforeSnap[idx].pt.col,
          ...(c.raw !== undefined ? { raw: normalizeRawInput(c.raw) } : {}),
          ...(c.style !== undefined ? { style: c.style } : {}),
        }));
        this._setCellsBatch(proxy.id, items);
        beforeSnap.forEach((b) => {
          const after = proxy.getCell(b.a1);
          if (b.raw !== after.raw || b.formatted !== after.formatted) {
            diff.cellChanges.push({ sheet: proxy.name, a1: b.a1, beforeRaw: b.raw, afterRaw: after.raw, beforeValue: b.formatted, afterValue: after.formatted });
          }
        });
        return;
      }
      case "setRange": {
        const proxy = this.sheet(op.sheet);
        const pt = parseA1Token(op.start);
        if (!pt) throw new Error(`Invalid start address: ${op.start}`);
        const cells: { a1: string; raw: string | number | boolean | null }[] = [];
        for (let r = 0; r < op.values.length; r++) {
          for (let c = 0; c < op.values[r].length; c++) {
            cells.push({ a1: sheetAddress({ row: pt.row + r, col: pt.col + c }), raw: op.values[r][c] });
          }
        }
        this.executeOp({ op: "setCells", sheet: op.sheet, cells }, diff);
        return;
      }
      case "clearRange": {
        const proxy = this.sheet(op.sheet);
        const rect = parseSheetRange(op.range);
        if (!rect) throw new Error(`Invalid range: ${op.range}`);
        const cells: { a1: string; raw: string }[] = [];
        for (let r = rect.top; r <= rect.bottom; r++) {
          for (let c = rect.left; c <= rect.right; c++) cells.push({ a1: sheetAddress({ row: r, col: c }), raw: "" });
        }
        this.executeOp({ op: "setCells", sheet: op.sheet, cells }, diff);
        return;
      }
      case "merge":
        this.sheet(op.sheet).merge(op.range);
        diff.structuralChanges.push(`merge:${op.sheet}!${op.range}`);
        return;
      case "unmerge":
        this.sheet(op.sheet).unmerge(op.range);
        diff.structuralChanges.push(`unmerge:${op.sheet}!${op.range}`);
        return;
      case "setFreeze":
        this.sheet(op.sheet).setFreeze(op.rows, op.cols);
        diff.structuralChanges.push(`freeze:${op.sheet}(${op.rows},${op.cols})`);
        return;
      case "resize": {
        const proxy = this.sheet(op.sheet);
        if (op.colWidths) for (const [k, v] of Object.entries(op.colWidths)) proxy.setColWidth(Number(k), v);
        if (op.rowHeights) for (const [k, v] of Object.entries(op.rowHeights)) proxy.setRowHeight(Number(k), v);
        diff.structuralChanges.push(`resize:${op.sheet}`);
        return;
      }
      case "sort":
        this.sheet(op.sheet).sort(op.col, op.ascending ?? true, op.headerRow ?? 0);
        diff.structuralChanges.push(`sort:${op.sheet}:${String(op.col)}`);
        return;
      case "addValidation": {
        const rect = parseSheetRange(op.range);
        if (!rect) throw new Error(`Invalid range: ${op.range}`);
        this.sheet(op.sheet).addValidation({
          ...rect,
          type: op.type,
          options: op.options,
          min: op.min,
          max: op.max,
          strict: op.strict ?? true,
          hint: op.hint,
        });
        diff.structuralChanges.push(`addValidation:${op.sheet}!${op.range}`);
        return;
      }
      case "addConditionalFormat": {
        const rect = parseSheetRange(op.range);
        if (!rect) throw new Error(`Invalid range: ${op.range}`);
        this.sheet(op.sheet).addConditionalFormat({
          ...rect,
          op: op.ruleOp,
          value1: op.value1,
          value2: op.value2,
          bg: op.bg,
          color: op.color,
          bold: op.bold,
        });
        diff.structuralChanges.push(`addConditionalFormat:${op.sheet}!${op.range}`);
        return;
      }
      case "addChart": {
        const rect = parseSheetRange(op.range);
        if (!rect) throw new Error(`Invalid range: ${op.range}`);
        this.sheet(op.sheet).addChart({
          title: op.title,
          type: op.chartType,
          ...rect,
          headerRow: op.headerRow ?? true,
          x: 40,
          y: 40,
          width: 420,
          height: 260,
          showLegend: true,
        });
        diff.structuralChanges.push(`addChart:${op.sheet}:${op.title}`);
        return;
      }
    }
  }
}

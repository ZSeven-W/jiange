import { pointKey, type SheetPoint } from "./grid.js";
import {
  extractAstReferences,
  parseA1Token,
  parseFormulaAst,
  type FormulaAst,
  type RangeRefNode,
} from "./formula-ast.js";
import {
  ARRAY_LIFTABLE_FUNCTIONS,
  arrVal,
  boolVal,
  BUILTIN_FUNCTIONS,
  compareValues,
  EMPTY_VAL,
  errVal,
  isLambdaVal,
  isMissingArg,
  numVal,
  strVal,
  toNumber,
  toStringValue,
  unwrapScalar,
  type CustomFormulaFunction,
  type FormulaEvalContext,
  type LambdaEvalValue,
  type ResolvedRange,
} from "./formula-functions.js";
import { formatCellDisplay } from "./numfmt.js";
import type {
  EvalValue,
  SheetCell,
  SheetCellWrite,
  SheetDefinedName,
  SheetMerge,
  SheetWorksheet,
} from "./types.js";

const MAX_DEPTH = 64;
const MAX_OPS = 200_000;
const EMPTY_ENV: ReadonlyMap<string, EvalValue> = new Map();

function sanitizeBoundaryValue(val: EvalValue): EvalValue {
  if (isLambdaVal(val)) return errVal("#CALC!");
  return val;
}

export type MergeCellInfo =
  | { kind: "master"; rowSpan: number; colSpan: number; merge: SheetMerge }
  | { kind: "covered"; masterRow: number; masterCol: number; merge: SheetMerge };

export function buildWorksheetGridMap(ws: SheetWorksheet) {
  const rowPosById = new Map<number, number>();
  const colPosById = new Map<number, number>();
  ws.rows.forEach((r, idx) => rowPosById.set(r.id, idx));
  ws.columns.forEach((c, idx) => colPosById.set(c.id, idx));
  const cellByKey = new Map<string, SheetCell>();
  for (const cell of ws.cells) {
    const r = rowPosById.get(cell.rowId);
    const c = colPosById.get(cell.columnId);
    if (r === undefined || c === undefined) continue;
    cellByKey.set(`${r}:${c}`, cell);
  }
  return { rowPosById, colPosById, cellByKey };
}

export function evalScalarRaw(raw: string): EvalValue {
  if (!raw) return EMPTY_VAL;
  const trimmed = raw.trim();
  if (!trimmed) return strVal(raw);
  if (/^(true|false)$/i.test(trimmed)) return boolVal(trimmed.toUpperCase() === "TRUE");
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return numVal(n);
  }
  if (/^#(?:REF!|DIV\/0!|VALUE!|NAME\?|NUM!|N\/A|NULL!|SPILL!|CALC!|CYCLE!|ERROR!)$/i.test(trimmed)) {
    return errVal(trimmed.toUpperCase());
  }
  return strVal(raw);
}

function normalizeCustomResult(value: ReturnType<CustomFormulaFunction>): EvalValue {
  if (value === null || value === undefined) return EMPTY_VAL;
  if (typeof value === "number") return numVal(value);
  if (typeof value === "string") return strVal(value);
  if (typeof value === "boolean") return boolVal(value);
  return value;
}

function evalScalarBinary(op: string, left: EvalValue, right: EvalValue): EvalValue {
  if (left.kind === "error") return left;
  if (right.kind === "error") return right;
  if (op === "&") return strVal(toStringValue(left) + toStringValue(right));
  if (op === "=" || op === "<>" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    const cmp = compareValues(left, right);
    return boolVal(
      op === "=" ? cmp === 0 : op === "<>" ? cmp !== 0 : op === "<" ? cmp < 0 : op === "<=" ? cmp <= 0 : op === ">" ? cmp > 0 : cmp >= 0,
    );
  }
  const a = toNumber(left);
  const b = toNumber(right);
  if (typeof a !== "number") return a;
  if (typeof b !== "number") return b;
  if (op === "+") return numVal(a + b);
  if (op === "-") return numVal(a - b);
  if (op === "*") return numVal(a * b);
  if (op === "/") return b === 0 ? errVal("#DIV/0!") : numVal(a / b);
  return numVal(a ** b);
}

function evalBinaryValue(op: string, left: EvalValue, right: EvalValue): EvalValue {
  if (left.kind !== "array" && right.kind !== "array") {
    return evalScalarBinary(op, left, right);
  }
  const lMat = left.kind === "array" ? left.value : [[left]];
  const rMat = right.kind === "array" ? right.value : [[right]];
  const lCols = lMat[0]?.length ?? 1;
  const rCols = rMat[0]?.length ?? 1;
  const rows = Math.max(lMat.length, rMat.length);
  const cols = Math.max(lCols, rCols);
  const out: EvalValue[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: EvalValue[] = [];
    for (let c = 0; c < cols; c++) {
      const lv = lMat[Math.min(r, lMat.length - 1)]?.[Math.min(c, lCols - 1)] ?? errVal("#N/A");
      const rv = rMat[Math.min(r, rMat.length - 1)]?.[Math.min(c, rCols - 1)] ?? errVal("#N/A");
      line.push(evalScalarBinary(op, lv, rv));
    }
    out.push(line);
  }
  return arrVal(out);
}

interface RangeWatcher {
  watcherKey: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

interface SheetRuntime {
  id: number;
  title: string;
  rows: number;
  cols: number;
  rawMap: Map<string, string>;
  maxUsedRow: number;
  maxUsedCol: number;
}

export interface IncrementalUpdateResult {
  recalculated: number;
  dirtyKeys: string[];
}

export interface WorkbookCalculateOptions {
  definedNames?: readonly SheetDefinedName[];
  customFunctions?: Readonly<Record<string, CustomFormulaFunction>>;
}

/**
 * Incremental AST + DAG dependency-graph formula engine.
 * Single-cell updates only recalculate the transitive dirty subgraph instead of
 * scanning the entire workbook.
 */
export class IncrementalFormulaEngine {
  private sheets = new Map<number, SheetRuntime>();
  private sheetIdByTitle = new Map<string, number>();
  private definedNames = new Map<string, SheetDefinedName>();
  private customFunctions = new Map<string, CustomFormulaFunction>();

  // Evaluation cache keyed by `${sheetId}:${row}:${col}`.
  private cache = new Map<string, EvalValue>();
  // Fast O(1) error counter per sheet, kept in sync with `cache`.
  private errorCellsBySheet = new Map<number, Set<string>>();
  // Spill overlay keyed by `${sheetId}:${row}:${col}` -> { originKey, value }.
  private spillCells = new Map<string, { originKey: string; value: EvalValue }>();
  private originSpills = new Map<string, string[]>();
  private blockedSpillOrigins = new Map<string, Set<string>>();
  private originBlockers = new Map<string, string[]>();

  // Dependency graph.
  private astByCell = new Map<string, FormulaAst | null>();
  private cellPrecedents = new Map<string, Set<string>>();
  private cellDependents = new Map<string, Set<string>>();
  private rangeWatchersBySheet = new Map<number, RangeWatcher[]>();
  private cellRangeWatches = new Map<string, { sheetId: number; watcher: RangeWatcher }[]>();
  private volatileCells = new Set<string>();
  private dynamicRefCells = new Set<string>();

  registerFunction(name: string, fn: CustomFormulaFunction): void {
    this.customFunctions.set(name.trim().toUpperCase(), fn);
  }

  unregisterFunction(name: string): void {
    this.customFunctions.delete(name.trim().toUpperCase());
  }

  setDefinedNames(names: readonly SheetDefinedName[]): void {
    this.definedNames.clear();
    for (const def of names) {
      const scope = def.sheetName ? `${def.sheetName.trim().toLowerCase()}!` : "";
      this.definedNames.set(`${scope}${def.name.trim().toLowerCase()}`, def);
    }
  }

  loadSheets(sheets: readonly SheetWorksheet[], options: WorkbookCalculateOptions = {}): Map<number, Record<string, EvalValue>> {
    this.sheets.clear();
    this.sheetIdByTitle.clear();
    this.cache.clear();
    this.errorCellsBySheet.clear();
    this.spillCells.clear();
    this.originSpills.clear();
    this.blockedSpillOrigins.clear();
    this.originBlockers.clear();
    this.astByCell.clear();
    this.cellPrecedents.clear();
    this.cellDependents.clear();
    this.rangeWatchersBySheet.clear();
    this.cellRangeWatches.clear();
    this.volatileCells.clear();
    this.dynamicRefCells.clear();

    if (options.definedNames) this.setDefinedNames(options.definedNames);
    if (options.customFunctions) {
      for (const [k, fn] of Object.entries(options.customFunctions)) this.registerFunction(k, fn);
    }

    for (const ws of sheets) {
      const { cellByKey } = buildWorksheetGridMap(ws);
      const rawMap = new Map<string, string>();
      let maxUsedRow = 0;
      let maxUsedCol = 0;
      for (const [rc, cell] of cellByKey) {
        if (cell.raw !== "") {
          rawMap.set(rc, cell.raw);
          const [r, c] = rc.split(":").map(Number);
          if (r > maxUsedRow) maxUsedRow = r;
          if (c > maxUsedCol) maxUsedCol = c;
        }
      }
      this.sheets.set(ws.id, {
        id: ws.id,
        title: ws.title,
        rows: ws.rows.length,
        cols: ws.columns.length,
        rawMap,
        maxUsedRow,
        maxUsedCol,
      });
      this.sheetIdByTitle.set(ws.title.trim().toLowerCase(), ws.id);
    }

    // Build dependency graph for every formula cell.
    for (const rt of this.sheets.values()) {
      for (const [rc, raw] of rt.rawMap) {
        if (raw.startsWith("=")) {
          const [r, c] = rc.split(":").map(Number);
          this.indexFormulaDependencies(rt.id, r, c, raw);
        }
      }
    }

    return this.evaluateAll();
  }

  /** Incrementally update raw values in a sheet and recalculate ONLY the dirty subgraph. */
  updateCells(sheetId: number, changes: readonly { row: number; col: number; raw: string }[]): IncrementalUpdateResult {
    const rt = this.sheets.get(sheetId);
    if (!rt) return { recalculated: 0, dirtyKeys: [] };

    const roots = new Set<string>();
    for (const ch of changes) {
      if (ch.row >= rt.rows) rt.rows = ch.row + 1;
      if (ch.col >= rt.cols) rt.cols = ch.col + 1;
      const rc = `${ch.row}:${ch.col}`;
      const cKey = `${sheetId}:${ch.row}:${ch.col}`;
      const prev = rt.rawMap.get(rc) ?? "";
      if (prev === ch.raw) continue;
      if (ch.raw === "") rt.rawMap.delete(rc);
      else {
        rt.rawMap.set(rc, ch.raw);
        if (ch.row > rt.maxUsedRow) rt.maxUsedRow = ch.row;
        if (ch.col > rt.maxUsedCol) rt.maxUsedCol = ch.col;
      }

      this.clearCellDependencies(cKey);
      this.clearSpillFrom(cKey);
      if (ch.raw.startsWith("=")) {
        this.indexFormulaDependencies(sheetId, ch.row, ch.col, ch.raw);
      }
      roots.add(cKey);

      // If this cell collided with an existing spill or was blocking a #SPILL!, dirty those origins.
      const spillHit = this.spillCells.get(cKey);
      if (spillHit) roots.add(spillHit.originKey);
      const blockedOrigins = this.blockedSpillOrigins.get(cKey);
      if (blockedOrigins) for (const origin of blockedOrigins) roots.add(origin);
    }

    if (roots.size === 0) return { recalculated: 0, dirtyKeys: [] };

    // Collect transitive dirty closure via direct dependents + range watchers + volatile/dynamic cells.
    const dirty = new Set<string>(roots);
    const queue = [...roots];
    for (const v of this.volatileCells) {
      if (!dirty.has(v)) { dirty.add(v); queue.push(v); }
    }
    for (const d of this.dynamicRefCells) {
      if (!dirty.has(d)) { dirty.add(d); queue.push(d); }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const direct = this.cellDependents.get(current);
      if (direct) {
        for (const dep of direct) {
          if (!dirty.has(dep)) { dirty.add(dep); queue.push(dep); }
        }
      }
      const [sidStr, rStr, cStr] = current.split(":");
      const sid = Number(sidStr);
      const r = Number(rStr);
      const c = Number(cStr);
      const watchers = this.rangeWatchersBySheet.get(sid);
      if (watchers) {
        for (const w of watchers) {
          if (r >= w.top && r <= w.bottom && c >= w.left && c <= w.right) {
            if (!dirty.has(w.watcherKey)) {
              dirty.add(w.watcherKey);
              queue.push(w.watcherKey);
            }
          }
        }
      }
    }

    // Invalidate cached values and spills for dirty nodes only.
    for (const key of dirty) {
      this.cache.delete(key);
      this.errorCellsBySheet.get(Number(key.slice(0, key.indexOf(":"))))?.delete(key);
      this.clearSpillFrom(key);
    }

    // Re-evaluate only dirty cells.
    let recalculated = 0;
    for (const key of dirty) {
      const [sid, r, c] = key.split(":").map(Number);
      this.evalCell(sid, r, c, 0, new Set(), { ops: 0 });
      recalculated++;
    }

    return { recalculated, dirtyKeys: [...dirty] };
  }

  evaluateAll(): Map<number, Record<string, EvalValue>> {
    this.cache.clear();
    this.errorCellsBySheet.clear();
    this.spillCells.clear();
    this.originSpills.clear();
    this.blockedSpillOrigins.clear();
    this.originBlockers.clear();
    for (const rt of this.sheets.values()) {
      for (const [rc] of rt.rawMap) {
        const [r, c] = rc.split(":").map(Number);
        this.evalCell(rt.id, r, c, 0, new Set(), { ops: 0 });
      }
    }
    return this.exportAllValues();
  }

  exportAllValues(): Map<number, Record<string, EvalValue>> {
    const out = new Map<number, Record<string, EvalValue>>();
    for (const rt of this.sheets.values()) {
      const map: Record<string, EvalValue> = {};
      for (const [rc] of rt.rawMap) {
        const val = this.cache.get(`${rt.id}:${rc}`);
        if (val) map[rc] = val.kind === "array" ? (val.value[0]?.[0] ?? EMPTY_VAL) : val;
      }
      for (const [cKey, spill] of this.spillCells) {
        if (!cKey.startsWith(`${rt.id}:`)) continue;
        const rc = cKey.slice(`${rt.id}:`.length);
        if (!rt.rawMap.has(rc)) map[rc] = spill.value;
      }
      out.set(rt.id, map);
    }
    return out;
  }

  getValue(sheetId: number, row: number, col: number): EvalValue {
    const cKey = `${sheetId}:${row}:${col}`;
    const spill = this.spillCells.get(cKey);
    if (spill) return spill.value;
    const cached = this.cache.get(cKey);
    if (cached) return cached.kind === "array" ? (cached.value[0]?.[0] ?? EMPTY_VAL) : cached;
    return this.evalCell(sheetId, row, col, 0, new Set(), { ops: 0 });
  }

  /** Non-mutating O(1) lookup of an evaluated cell value (or spilled overlay). */
  peekValue(sheetId: number, row: number, col: number): EvalValue | undefined {
    const cKey = `${sheetId}:${row}:${col}`;
    const spill = this.spillCells.get(cKey);
    if (spill) return spill.value;
    const cached = this.cache.get(cKey);
    if (!cached) return undefined;
    return cached.kind === "array" ? (cached.value[0][0] ?? EMPTY_VAL) : cached;
  }

  /** O(1) count of cached error cells on a worksheet. */
  getSheetErrorCount(sheetId: number): number {
    return this.errorCellsBySheet.get(sheetId)?.size ?? 0;
  }

  private setCachedValue(sheetId: number, cKey: string, val: EvalValue): void {
    this.cache.set(cKey, val);
    const top = val.kind === "array" ? (val.value[0][0] ?? EMPTY_VAL) : val;
    if (top.kind === "error") {
      let errs = this.errorCellsBySheet.get(sheetId);
      if (!errs) { errs = new Set(); this.errorCellsBySheet.set(sheetId, errs); }
      errs.add(cKey);
    } else {
      this.errorCellsBySheet.get(sheetId)?.delete(cKey);
    }
  }

  getSheetValues(sheetId: number): Record<string, EvalValue> {
    const rt = this.sheets.get(sheetId);
    if (!rt) return {};
    const map: Record<string, EvalValue> = {};
    for (const [rc] of rt.rawMap) {
      const val = this.cache.get(`${sheetId}:${rc}`);
      if (val) map[rc] = val.kind === "array" ? (val.value[0]?.[0] ?? EMPTY_VAL) : val;
    }
    for (const [cKey, spill] of this.spillCells) {
      if (!cKey.startsWith(`${sheetId}:`)) continue;
      const rc = cKey.slice(`${sheetId}:`.length);
      if (!rt.rawMap.has(rc)) map[rc] = spill.value;
    }
    return map;
  }

  getPrecedents(sheetId: number, row: number, col: number): string[] {
    return [...(this.cellPrecedents.get(`${sheetId}:${row}:${col}`) ?? [])];
  }

  getDependents(sheetId: number, row: number, col: number): string[] {
    const cKey = `${sheetId}:${row}:${col}`;
    const out = new Set<string>(this.cellDependents.get(cKey) ?? []);
    const watchers = this.rangeWatchersBySheet.get(sheetId);
    if (watchers) {
      for (const w of watchers) {
        if (row >= w.top && row <= w.bottom && col >= w.left && col <= w.right) out.add(w.watcherKey);
      }
    }
    return [...out];
  }

  private resolveSheetId(currentSheetId: number, name?: string): number | null {
    if (!name) return currentSheetId;
    return this.sheetIdByTitle.get(name.trim().toLowerCase()) ?? null;
  }

  private resolveDefinedName(sheetId: number, name: string): SheetDefinedName | null {
    const lower = name.trim().toLowerCase();
    const rt = this.sheets.get(sheetId);
    if (rt) {
      const scoped = this.definedNames.get(`${rt.title.trim().toLowerCase()}!${lower}`);
      if (scoped) return scoped;
    }
    return this.definedNames.get(lower) ?? null;
  }

  private clearCellDependencies(cKey: string): void {
    this.astByCell.delete(cKey);
    this.volatileCells.delete(cKey);
    this.dynamicRefCells.delete(cKey);
    const prevPrecs = this.cellPrecedents.get(cKey);
    if (prevPrecs) {
      for (const p of prevPrecs) {
        const deps = this.cellDependents.get(p);
        if (deps) {
          deps.delete(cKey);
          if (deps.size === 0) this.cellDependents.delete(p);
        }
      }
      this.cellPrecedents.delete(cKey);
    }
    const prevWatches = this.cellRangeWatches.get(cKey);
    if (prevWatches) {
      for (const item of prevWatches) {
        const list = this.rangeWatchersBySheet.get(item.sheetId);
        if (list) {
          const idx = list.indexOf(item.watcher);
          if (idx >= 0) list.splice(idx, 1);
        }
      }
      this.cellRangeWatches.delete(cKey);
    }
  }

  private indexFormulaDependencies(sheetId: number, row: number, col: number, raw: string): void {
    const cKey = `${sheetId}:${row}:${col}`;
    const ast = parseFormulaAst(raw);
    this.astByCell.set(cKey, ast);
    if (!ast) return;

    const addFromAst = (node: FormulaAst, depth: number) => {
      if (depth > 8) return;
      const refs = extractAstReferences(node);
      if (refs.hasVolatile) this.volatileCells.add(cKey);
      if (refs.hasDynamicRef) this.dynamicRefCells.add(cKey);

      for (const c of refs.cells) {
        const sid = this.resolveSheetId(sheetId, c.sheetName);
        if (sid === null) continue;
        const targetKey = `${sid}:${c.row}:${c.col}`;
        let pSet = this.cellPrecedents.get(cKey);
        if (!pSet) { pSet = new Set(); this.cellPrecedents.set(cKey, pSet); }
        pSet.add(targetKey);
        let dSet = this.cellDependents.get(targetKey);
        if (!dSet) { dSet = new Set(); this.cellDependents.set(targetKey, dSet); }
        dSet.add(cKey);
      }
      for (const rg of refs.ranges) {
        const sid = this.resolveSheetId(sheetId, rg.sheetName);
        if (sid === null) continue;
        const targetRt = this.sheets.get(sid)!;
        const top = rg.startRow < 0 ? 0 : rg.startRow;
        const bottom = rg.endRow < 0 ? Math.max(targetRt.rows - 1, 1048575) : rg.endRow;
        const left = rg.startCol < 0 ? 0 : rg.startCol;
        const right = rg.endCol < 0 ? Math.max(targetRt.cols - 1, 16383) : rg.endCol;
        const watcher: RangeWatcher = { watcherKey: cKey, top, left, bottom, right };
        let list = this.rangeWatchersBySheet.get(sid);
        if (!list) { list = []; this.rangeWatchersBySheet.set(sid, list); }
        list.push(watcher);
        let cw = this.cellRangeWatches.get(cKey);
        if (!cw) { cw = []; this.cellRangeWatches.set(cKey, cw); }
        cw.push({ sheetId: sid, watcher });
      }
      for (const nm of refs.names) {
        const def = this.resolveDefinedName(sheetId, nm);
        if (!def) continue;
        const subAst = parseFormulaAst(def.ref);
        if (subAst) addFromAst(subAst, depth + 1);
      }
    };

    addFromAst(ast, 0);
  }

  private clearSpillFrom(originKey: string): void {
    const targets = this.originSpills.get(originKey);
    if (targets) {
      for (const t of targets) {
        if (this.spillCells.get(t)?.originKey === originKey) {
          this.spillCells.delete(t);
        }
      }
      this.originSpills.delete(originKey);
    }
    const blockers = this.originBlockers.get(originKey);
    if (blockers) {
      for (const b of blockers) {
        const set = this.blockedSpillOrigins.get(b);
        if (set) {
          set.delete(originKey);
          if (set.size === 0) this.blockedSpillOrigins.delete(b);
        }
      }
      this.originBlockers.delete(originKey);
    }
  }

  private applySpill(sheetId: number, row: number, col: number, originKey: string, mat: EvalValue[][]): EvalValue {
    const rt = this.sheets.get(sheetId)!;
    const h = mat.length;
    const w = mat[0]?.length ?? 0;
    if (h <= 1 && w <= 1) return sanitizeBoundaryValue(mat[0]?.[0] ?? EMPTY_VAL);

    // Check spill area collisions against non-empty raw cells or other spill ranges.
    const targets: string[] = [];
    const blockers: string[] = [];
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = row + dr;
        const c = col + dc;
        const rc = `${r}:${c}`;
        const tKey = `${sheetId}:${r}:${c}`;
        const existingSpill = this.spillCells.get(tKey);
        if (rt.rawMap.has(rc) || (existingSpill && existingSpill.originKey !== originKey)) {
          blockers.push(tKey);
        } else {
          targets.push(tKey);
        }
      }
    }
    if (blockers.length > 0) {
      this.originBlockers.set(originKey, blockers);
      for (const b of blockers) {
        let set = this.blockedSpillOrigins.get(b);
        if (!set) { set = new Set(); this.blockedSpillOrigins.set(b, set); }
        set.add(originKey);
      }
      return errVal("#SPILL!");
    }
    const cleanMat: EvalValue[][] = [];
    for (let dr = 0; dr < h; dr++) {
      const cleanRow: EvalValue[] = [];
      for (let dc = 0; dc < w; dc++) {
        const cellVal = sanitizeBoundaryValue(mat[dr]?.[dc] ?? EMPTY_VAL);
        cleanRow.push(cellVal);
        if (dr === 0 && dc === 0) continue;
        const tKey = `${sheetId}:${row + dr}:${col + dc}`;
        this.spillCells.set(tKey, { originKey, value: cellVal });
      }
      cleanMat.push(cleanRow);
    }
    this.originSpills.set(originKey, targets);
    return arrVal(cleanMat);
  }

  private resolveRangeNode(currentSheetId: number, node: RangeRefNode): ResolvedRange | null {
    const sid = this.resolveSheetId(currentSheetId, node.sheetName);
    if (sid === null) return null;
    const rt = this.sheets.get(sid)!;
    const top = node.startRow < 0 ? 0 : node.startRow;
    const bottom = node.endRow < 0 ? Math.min(rt.rows - 1, Math.max(rt.maxUsedRow, 0)) : node.endRow;
    const left = node.startCol < 0 ? 0 : node.startCol;
    const right = node.endCol < 0 ? Math.min(rt.cols - 1, Math.max(rt.maxUsedCol, 0)) : node.endCol;
    if (top < 0 || left < 0 || bottom >= rt.rows || right >= rt.cols || top > bottom || left > right) {
      return null;
    }
    return { sheetId: sid, top, left, bottom, right };
  }

  private evalCell(
    sheetId: number,
    row: number,
    col: number,
    depth: number,
    active: Set<string>,
    budget: { ops: number },
  ): EvalValue {
    const rt = this.sheets.get(sheetId);
    if (!rt || row < 0 || row >= rt.rows || col < 0 || col >= rt.cols) return errVal("#REF!");
    const cKey = `${sheetId}:${row}:${col}`;
    const spill = this.spillCells.get(cKey);
    if (spill && !rt.rawMap.has(`${row}:${col}`)) return spill.value;
    const cached = this.cache.get(cKey);
    if (cached !== undefined) return cached.kind === "array" ? (cached.value[0]?.[0] ?? EMPTY_VAL) : cached;
    if (active.has(cKey)) return errVal("#CYCLE!");
    if (depth > MAX_DEPTH || ++budget.ops > MAX_OPS) return errVal("#LIMIT!");

    const raw = rt.rawMap.get(`${row}:${col}`) ?? "";
    if (!raw.startsWith("=")) {
      const val = evalScalarRaw(raw);
      this.setCachedValue(sheetId, cKey, val);
      return val;
    }

    active.add(cKey);
    const ast = this.astByCell.get(cKey);
    let result: EvalValue;
    if (!ast) {
      result = errVal("#ERROR!");
    } else {
      result = this.evalAstNode(ast, sheetId, row, col, depth, active, budget, EMPTY_ENV, false);
    }
    result = sanitizeBoundaryValue(result);
    if (result.kind === "number") {
      result = numVal(Number(result.value.toPrecision(15)));
    } else if (result.kind === "array") {
      result = this.applySpill(sheetId, row, col, cKey, result.value);
    }
    active.delete(cKey);
    if (result.kind !== "error" || result.error !== "#LIMIT!") {
      this.setCachedValue(sheetId, cKey, result);
    }
    return result.kind === "array" ? (result.value[0]?.[0] ?? EMPTY_VAL) : result;
  }

  private invokeLambdaClosure(
    fn: LambdaEvalValue,
    argNodes: readonly FormulaAst[],
    callerSheetId: number,
    row: number,
    col: number,
    depth: number,
    active: Set<string>,
    budget: { ops: number },
    callerEnv: ReadonlyMap<string, EvalValue>,
    arrayMode: boolean,
  ): EvalValue {
    if (depth > MAX_DEPTH || ++budget.ops > MAX_OPS) return errVal("#LIMIT!");
    if (argNodes.length !== fn.params.length) return errVal("#VALUE!");
    const callEnv = new Map<string, EvalValue>(fn.env);
    for (let i = 0; i < fn.params.length; i++) {
      if (isMissingArg(argNodes[i])) return errVal("#VALUE!");
      const argVal = this.evalAstNode(argNodes[i], callerSheetId, row, col, depth + 1, active, budget, callerEnv, arrayMode);
      callEnv.set(fn.params[i], argVal);
    }
    return this.evalAstNode(fn.body, fn.sheetId, row, col, depth + 1, active, budget, callEnv, arrayMode);
  }

  private evalAstNode(
    node: FormulaAst,
    sheetId: number,
    row: number,
    col: number,
    depth: number,
    active: Set<string>,
    budget: { ops: number },
    env: ReadonlyMap<string, EvalValue> = EMPTY_ENV,
    arrayMode = false,
  ): EvalValue {
    if (depth > MAX_DEPTH || ++budget.ops > MAX_OPS) return errVal("#LIMIT!");

    switch (node.kind) {
      case "number":
        return numVal(node.value);
      case "string":
        return strVal(node.value);
      case "boolean":
        return boolVal(node.value);
      case "error":
        return node.code === "__MISSING__" ? EMPTY_VAL : errVal(node.code);
      case "cell": {
        const sid = this.resolveSheetId(sheetId, node.sheetName);
        if (sid === null) return errVal("#REF!");
        return this.evalCell(sid, node.row, node.col, depth + 1, active, budget);
      }
      case "range": {
        const resolved = this.resolveRangeNode(sheetId, node);
        if (!resolved) return errVal("#REF!");
        const mat: EvalValue[][] = [];
        for (let r = resolved.top; r <= resolved.bottom; r++) {
          const line: EvalValue[] = [];
          for (let c = resolved.left; c <= resolved.right; c++) {
            if (++budget.ops > MAX_OPS) return errVal("#LIMIT!");
            line.push(this.evalCell(resolved.sheetId, r, c, depth + 1, active, budget));
          }
          mat.push(line);
        }
        return arrVal(mat);
      }
      case "name": {
        const local = env.get(node.name.toUpperCase());
        if (local !== undefined) return local;
        const def = this.resolveDefinedName(sheetId, node.name);
        if (!def) return errVal("#NAME?");
        const subAst = parseFormulaAst(def.ref);
        if (!subAst) return errVal("#NAME?");
        return this.evalAstNode(subAst, sheetId, row, col, depth + 1, active, budget, EMPTY_ENV, arrayMode);
      }
      case "unary": {
        const inner = this.evalAstNode(node.arg, sheetId, row, col, depth + 1, active, budget, env, arrayMode);
        if (inner.kind === "array") {
          return arrVal(inner.value.map((r) => r.map((v) => {
            const n = toNumber(v);
            return typeof n === "number" ? numVal(node.op === "-" ? -n : n) : n;
          })));
        }
        const n = toNumber(inner);
        return typeof n === "number" ? numVal(node.op === "-" ? -n : n) : n;
      }
      case "percent": {
        const inner = this.evalAstNode(node.arg, sheetId, row, col, depth + 1, active, budget, env, arrayMode);
        if (inner.kind === "array") {
          return arrVal(inner.value.map((r) => r.map((v) => {
            const n = toNumber(v);
            return typeof n === "number" ? numVal(n / 100) : n;
          })));
        }
        const n = toNumber(inner);
        return typeof n === "number" ? numVal(n / 100) : n;
      }
      case "binary": {
        const left = this.evalAstNode(node.left, sheetId, row, col, depth + 1, active, budget, env, arrayMode);
        const right = this.evalAstNode(node.right, sheetId, row, col, depth + 1, active, budget, env, arrayMode);
        return evalBinaryValue(node.op, left, right);
      }
      case "array": {
        const rows = node.rows.map((r) =>
          r.map((item) => unwrapScalar(this.evalAstNode(item, sheetId, row, col, depth + 1, active, budget, env, arrayMode))),
        );
        return arrVal(rows);
      }
      case "invoke": {
        const callee = this.evalAstNode(node.callee, sheetId, row, col, depth + 1, active, budget, env, arrayMode);
        if (callee.kind === "error") return callee;
        if (!isLambdaVal(callee)) return errVal("#VALUE!");
        return this.invokeLambdaClosure(callee, node.args, sheetId, row, col, depth + 1, active, budget, env, arrayMode);
      }
      case "call": {
        // 1. Lexical scope callable (e.g. LET(double, LAMBDA(n, n*2), double(21)))
        const localBound = env.get(node.name);
        if (localBound !== undefined) {
          if (localBound.kind === "error") return localBound;
          if (!isLambdaVal(localBound)) return errVal("#VALUE!");
          return this.invokeLambdaClosure(localBound, node.args, sheetId, row, col, depth + 1, active, budget, env, arrayMode);
        }

        const ctx: FormulaEvalContext = {
          sheetId,
          row,
          col,
          arrayMode,
          getEnv: () => env,
          evalAst: (child) => this.evalAstNode(child, sheetId, row, col, depth + 1, active, budget, env, arrayMode),
          evalAstWithEnv: (child, nextEnv, nextArrayMode) =>
            this.evalAstNode(child, sheetId, row, col, depth + 1, active, budget, nextEnv, nextArrayMode ?? arrayMode),
          resolveRange: (rNode) => this.resolveRangeNode(sheetId, rNode),
          resolveCellRef: (refNode) => {
            if (refNode.kind === "cell") {
              const sid = this.resolveSheetId(sheetId, refNode.sheetName);
              return sid === null ? null : { sheetId: sid, row: refNode.row, col: refNode.col };
            }
            if (refNode.kind === "name") {
              const def = this.resolveDefinedName(sheetId, refNode.name);
              const sub = def ? parseFormulaAst(def.ref) : null;
              if (sub?.kind === "cell") {
                const sid = this.resolveSheetId(sheetId, sub.sheetName);
                return sid === null ? null : { sheetId: sid, row: sub.row, col: sub.col };
              }
            }
            return null;
          },
          readCell: (sid, r, c) => this.evalCell(sid, r, c, depth + 1, active, budget),
          readRawCell: (sid, r, c) => this.sheets.get(sid)!.rawMap.get(`${r}:${c}`) ?? "",
          readMatrix: (matNode) => {
            if (matNode.kind === "range") {
              const resolved = this.resolveRangeNode(sheetId, matNode);
              if (!resolved) return errVal("#REF!");
              const mat: EvalValue[][] = [];
              for (let r = resolved.top; r <= resolved.bottom; r++) {
                const line: EvalValue[] = [];
                for (let c = resolved.left; c <= resolved.right; c++) {
                  if (++budget.ops > MAX_OPS) return errVal("#LIMIT!");
                  line.push(this.evalCell(resolved.sheetId, r, c, depth + 1, active, budget));
                }
                mat.push(line);
              }
              return mat;
            }
            const ev = this.evalAstNode(matNode, sheetId, row, col, depth + 1, active, budget, env, arrayMode);
            if (ev.kind === "error") return ev;
            if (ev.kind === "array") return ev.value;
            return [[ev]];
          },
          parseAndResolveRef: (refText) => {
            const parsed = parseFormulaAst(refText.trim());
            if (!parsed) return null;
            if (parsed.kind === "cell") {
              const sid = this.resolveSheetId(sheetId, parsed.sheetName);
              return sid === null ? null : { sheetId: sid, row: parsed.row, col: parsed.col };
            }
            if (parsed.kind === "range") {
              return this.resolveRangeNode(sheetId, parsed);
            }
            return null;
          },
          sheetBounds: (sid) => {
            const target = this.sheets.get(sid)!;
            return { rows: target.rows, cols: target.cols };
          },
          tickOp: () => ++budget.ops <= MAX_OPS,
        };

        const custom = this.customFunctions.get(node.name);
        if (custom) {
          const evaluatedArgs = node.args.map((arg) =>
            this.evalAstNode(arg, sheetId, row, col, depth + 1, active, budget, env, arrayMode),
          );
          try {
            return normalizeCustomResult(custom(evaluatedArgs, { sheetId, row, col }));
          } catch {
            return errVal("#VALUE!");
          }
        }
        const builtin = BUILTIN_FUNCTIONS[node.name];
        if (builtin) {
          if (arrayMode && ARRAY_LIFTABLE_FUNCTIONS.has(node.name) && node.args.length > 0) {
            const evald = node.args.map((a) =>
              isMissingArg(a)
                ? null
                : this.evalAstNode(a, sheetId, row, col, depth + 1, active, budget, env, arrayMode),
            );
            const placeholderIndex = new Map<FormulaAst, number>();
            const placeholders: FormulaAst[] = node.args.map((a, idx) => {
              if (isMissingArg(a)) return a;
              const p: FormulaAst = { kind: "name", name: `__ARG_${idx}__` };
              placeholderIndex.set(p, idx);
              return p;
            });
            const hasArray = evald.some((v) => v !== null && v.kind === "array");
            if (hasArray) {
              let rows = 1;
              let cols = 1;
              for (const v of evald) {
                if (v && v.kind === "array") {
                  rows = Math.max(rows, v.value.length);
                  cols = Math.max(cols, v.value[0]?.length ?? 1);
                }
              }
              const out: EvalValue[][] = [];
              for (let r = 0; r < rows; r++) {
                const line: EvalValue[] = [];
                for (let c = 0; c < cols; c++) {
                  if (++budget.ops > MAX_OPS) return errVal("#LIMIT!");
                  const cellVals = evald.map((v) => {
                    if (!v) return EMPTY_VAL;
                    if (v.kind !== "array") return v;
                    const rr = Math.min(r, Math.max(0, v.value.length - 1));
                    const rowArr = v.value[rr];
                    const cc = Math.min(c, Math.max(0, (rowArr?.length ?? 1) - 1));
                    return rowArr?.[cc] ?? errVal("#N/A");
                  });
                  const liftCtx: FormulaEvalContext = {
                    ...ctx,
                    arrayMode: false,
                    evalAst: (child) => cellVals[placeholderIndex.get(child)!],
                  };
                  line.push(builtin(placeholders, liftCtx));
                }
                out.push(line);
              }
              return arrVal(out);
            }
            const scalarCtx: FormulaEvalContext = {
              ...ctx,
              evalAst: (child) => evald[placeholderIndex.get(child)!]!,
            };
            return builtin(placeholders, scalarCtx);
          }
          return builtin(node.args, ctx);
        }

        // 4. Workbook defined-name LAMBDA (e.g. defined name AddOne = "=LAMBDA(x, x+1)", called as =AddOne(5))
        const defFn = this.resolveDefinedName(sheetId, node.name);
        if (defFn) {
          const defAst = parseFormulaAst(defFn.ref);
          if (defAst) {
            const defVal = this.evalAstNode(defAst, sheetId, row, col, depth + 1, active, budget, EMPTY_ENV, arrayMode);
            if (isLambdaVal(defVal)) {
              return this.invokeLambdaClosure(defVal, node.args, sheetId, row, col, depth + 1, active, budget, env, arrayMode);
            }
          }
        }
        return errVal("#NAME?");
      }
    }
  }
}

/** Stateless convenience wrapper compatible with existing Jiange web callers. */
export function calculateWorkbook(
  sheets: readonly SheetWorksheet[],
  options: WorkbookCalculateOptions = {},
): Map<number, Record<string, EvalValue>> {
  const engine = new IncrementalFormulaEngine();
  return engine.loadSheets(sheets, options);
}

export function buildMergeLookup(merges: readonly SheetMerge[]): Map<string, MergeCellInfo> {
  const map = new Map<string, MergeCellInfo>();
  for (const merge of merges) {
    for (let r = merge.top; r <= merge.bottom; r++) {
      for (let c = merge.left; c <= merge.right; c++) {
        if (r === merge.top && c === merge.left) {
          map.set(`${r}:${c}`, {
            kind: "master",
            rowSpan: merge.bottom - merge.top + 1,
            colSpan: merge.right - merge.left + 1,
            merge,
          });
        } else {
          map.set(`${r}:${c}`, { kind: "covered", masterRow: merge.top, masterCol: merge.left, merge });
        }
      }
    }
  }
  return map;
}

export function normalizePointForMerge(point: SheetPoint, mergeLookup: Map<string, MergeCellInfo>): SheetPoint {
  const info = mergeLookup.get(pointKey(point));
  if (info?.kind === "covered") return { row: info.masterRow, col: info.masterCol };
  return point;
}

export function getVisibleRowIndices(ws: SheetWorksheet, evalMap: Record<string, EvalValue>): number[] {
  const count = ws.rows.length;
  const all = Array.from({ length: count }, (_, i) => i);
  if (!ws.filter?.enabled || !ws.filter.rules || Object.keys(ws.filter.rules).length === 0) return all;
  const headerRow = Math.max(0, ws.filter.headerRow ?? 0);
  const { cellByKey } = buildWorksheetGridMap(ws);
  const rules = Object.entries(ws.filter.rules);
  return all.filter((row) => {
    if (row <= headerRow) return true;
    for (const [colKey, rule] of rules) {
      const col = Number(colKey);
      const cell = cellByKey.get(`${row}:${col}`);
      const ev = evalMap[`${row}:${col}`];
      const text = formatCellDisplay(cell?.raw ?? "", ev, cell?.style);
      if (rule.query && !text.toLowerCase().includes(rule.query.toLowerCase())) return false;
      if (rule.values && rule.values.length > 0 && !rule.values.includes(text)) return false;
    }
    return true;
  });
}

/** Shift relative row references in an Excel formula when a row moves by `rowDelta` (e.g. during sort). */
export function shiftFormulaRowRefs(raw: string, rowDelta: number): string {
  if (!raw.startsWith("=") || rowDelta === 0) return raw;
  return raw.replace(
    /"(?:""|[^"])*"|'(?:''|[^'])*'!|(?<![A-Za-z0-9_!])(\$?[A-Za-z]{1,3})(\$?)([1-9]\d*)(?![A-Za-z0-9_(])/g,
    (match, colPart?: string, rowAbs?: string, rowDigits?: string) => {
      if (!colPart || rowAbs === "$") return match;
      const nextRow = Number(rowDigits) + rowDelta;
      return nextRow < 1 ? "#REF!" : `${colPart}${nextRow}`;
    },
  );
}

export function computeSortedRowWrites(
  ws: SheetWorksheet,
  evalMap: Record<string, EvalValue>,
  col: number,
  ascending: boolean,
  headerRow = 0,
): SheetCellWrite[] {
  if (ws.merges.length > 0) return [];
  const { cellByKey } = buildWorksheetGridMap(ws);
  let lastNonEmpty = -1;
  for (let r = headerRow + 1; r < ws.rows.length; r++) {
    for (let c = 0; c < ws.columns.length; c++) {
      const cell = cellByKey.get(`${r}:${c}`);
      if (cell && (cell.raw !== "" || (cell.style && Object.keys(cell.style).length > 0))) {
        lastNonEmpty = r;
        break;
      }
    }
  }
  if (lastNonEmpty <= headerRow + 1) return [];
  const dataRows = Array.from({ length: lastNonEmpty - headerRow }, (_, idx) => headerRow + 1 + idx);
  const compareRows = (rA: number, rB: number) => {
    const vA = evalMap[`${rA}:${col}`];
    const vB = evalMap[`${rB}:${col}`];
    const eA = !vA || vA.kind === "empty" || (vA.kind === "string" && vA.value === "");
    const eB = !vB || vB.kind === "empty" || (vB.kind === "string" && vB.value === "");
    if (eA && eB) return rA - rB;
    if (eA) return 1;
    if (eB) return -1;
    const cmp = compareValues(vA, vB);
    return ascending ? cmp : -cmp;
  };
  const sortedIndices = [...dataRows].sort(compareRows);
  const writes: SheetCellWrite[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const targetRow = dataRows[i];
    const srcRow = sortedIndices[i];
    if (targetRow === srcRow) continue;
    const rowDelta = targetRow - srcRow;
    for (let c = 0; c < ws.columns.length; c++) {
      const targetCell = cellByKey.get(`${targetRow}:${c}`);
      const srcCell = cellByKey.get(`${srcRow}:${c}`);
      const nextRaw = shiftFormulaRowRefs(srcCell?.raw ?? "", rowDelta);
      const nextStyle = srcCell?.style ?? {};
      const curRaw = targetCell?.raw ?? "";
      const curStyle = targetCell?.style ?? {};
      if (nextRaw === curRaw && JSON.stringify(nextStyle) === JSON.stringify(curStyle)) continue;
      writes.push({
        rowId: ws.rows[targetRow].id,
        columnId: ws.columns[c].id,
        expectedRevision: targetCell?.revision ?? 0,
        raw: nextRaw,
        style: nextStyle,
      });
    }
  }
  return writes;
}

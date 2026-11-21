import { columnName } from "./grid.js";
import { buildWorksheetGridMap } from "./formula-engine.js";
import type {
  EvaluatedSheetMap,
  SheetCellStyle,
  SheetChart,
  SheetChartType,
  SheetPivotAgg,
  SheetPivotSort,
  SheetPivotTable,
  SheetRect,
  SheetWorksheet,
} from "./types.js";

export const CHART_PALETTE = [
  "#3370ff",
  "#00b42a",
  "#ff8800",
  "#722ed1",
  "#f54a45",
  "#00b8d9",
  "#eb2f96",
  "#faad14",
];

export const CHART_TYPE_OPTIONS: { type: SheetChartType; label: string }[] = [
  { type: "column", label: "柱状图" },
  { type: "bar", label: "条形图" },
  { type: "line", label: "折线图" },
  { type: "area", label: "面积图" },
  { type: "pie", label: "饼图" },
];

export const PIVOT_AGG_OPTIONS: { agg: SheetPivotAgg; label: string }[] = [
  { agg: "sum", label: "求和" },
  { agg: "count", label: "计数" },
  { agg: "avg", label: "平均值" },
  { agg: "min", label: "最小值" },
  { agg: "max", label: "最大值" },
];

export const PIVOT_SORT_OPTIONS: { sort: SheetPivotSort; label: string }[] = [
  { sort: "label_asc", label: "行标签升序" },
  { sort: "label_desc", label: "行标签降序" },
  { sort: "value_desc", label: "数值降序" },
  { sort: "value_asc", label: "数值升序" },
];

export interface ChartSeries {
  name: string;
  color: string;
  values: number[];
}

export interface ChartDataset {
  labels: string[];
  series: ChartSeries[];
  maxVal: number;
  minVal: number;
  total: number;
}

function parseLooseNumber(text: string): number | null {
  const cleaned = text.trim().replace(/[,¥$€£%\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function readEvaluatedCell(
  cellByKey: Map<string, { raw: string }>,
  evalMap: EvaluatedSheetMap,
  row: number,
  col: number,
): { text: string; num: number | null; empty: boolean } {
  const key = `${row}:${col}`;
  const raw = cellByKey.get(key)?.raw ?? "";
  const ev = evalMap[key];
  if (ev) {
    if (ev.kind === "number") {
      return Number.isFinite(ev.value)
        ? { text: String(ev.value), num: ev.value, empty: false }
        : { text: String(ev.value), num: null, empty: false };
    }
    if (ev.kind === "empty") return { text: "", num: null, empty: true };
    if (ev.kind === "boolean") return { text: ev.value ? "TRUE" : "FALSE", num: null, empty: false };
    if (ev.kind === "array") {
      const head = ev.value[0]?.[0];
      if (head && head.kind === "number") return { text: String(head.value), num: head.value, empty: false };
      return { text: head ? String(head.value) : "", num: null, empty: !head };
    }
    const text = ev.value ?? raw;
    const n = parseLooseNumber(text);
    return { text, num: n, empty: text.trim() === "" };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { text: "", num: null, empty: true };
  return { text: raw, num: parseLooseNumber(trimmed), empty: false };
}

export function extractChartDataset(
  sheet: SheetWorksheet,
  evalMap: EvaluatedSheetMap,
  chart: Pick<SheetChart, "top" | "left" | "bottom" | "right" | "headerRow">,
): ChartDataset {
  const { cellByKey } = buildWorksheetGridMap(sheet);
  const top = Math.max(0, Math.min(chart.top, chart.bottom));
  const bottom = Math.min(sheet.rows.length - 1, Math.max(chart.top, chart.bottom));
  const left = Math.max(0, Math.min(chart.left, chart.right));
  const right = Math.min(sheet.columns.length - 1, Math.max(chart.left, chart.right));

  const colSpan = right - left + 1;
  const startRow = chart.headerRow && bottom > top ? top + 1 : top;

  const labels: string[] = [];
  const series: ChartSeries[] = [];

  if (colSpan === 1) {
    const seriesName = chart.headerRow && bottom > top
      ? (readEvaluatedCell(cellByKey, evalMap, top, left).text || columnName(left))
      : columnName(left);
    const values: number[] = [];
    for (let r = startRow; r <= bottom; r++) {
      const cell = readEvaluatedCell(cellByKey, evalMap, r, left);
      if (cell.empty) continue;
      labels.push(`${columnName(left)}${r + 1}`);
      values.push(cell.num ?? 0);
    }
    series.push({ name: seriesName, color: CHART_PALETTE[0], values });
  } else {
    const dataRows: number[] = [];
    for (let r = startRow; r <= bottom; r++) {
      let rowNonEmpty = false;
      for (let c = left; c <= right; c++) {
        if (!readEvaluatedCell(cellByKey, evalMap, r, c).empty) { rowNonEmpty = true; break; }
      }
      if (rowNonEmpty) dataRows.push(r);
    }

    const labelCols: number[] = [left];
    const seriesCols: number[] = [];
    for (let c = left + 1; c <= right; c++) {
      let numericCount = 0;
      for (const r of dataRows) {
        if (readEvaluatedCell(cellByKey, evalMap, r, c).num !== null) numericCount++;
      }
      if (numericCount > 0) seriesCols.push(c);
      else labelCols.push(c);
    }
    if (seriesCols.length === 0) {
      labelCols.length = 1;
      for (let c = left + 1; c <= right; c++) seriesCols.push(c);
    }

    for (const r of dataRows) {
      const parts = labelCols.map((c) => readEvaluatedCell(cellByKey, evalMap, r, c).text.trim()).filter(Boolean);
      labels.push(parts.length > 0 ? parts.join("·") : `${r + 1}`);
    }

    seriesCols.forEach((c, sIdx) => {
      const name = chart.headerRow && bottom > top
        ? (readEvaluatedCell(cellByKey, evalMap, top, c).text || columnName(c))
        : columnName(c);
      const values = dataRows.map((r) => readEvaluatedCell(cellByKey, evalMap, r, c).num ?? 0);
      series.push({ name, color: CHART_PALETTE[sIdx % CHART_PALETTE.length], values });
    });
  }

  let maxVal = 0;
  let minVal = 0;
  let total = 0;
  for (const s of series) {
    for (const v of s.values) {
      if (v > maxVal) maxVal = v;
      if (v < minVal) minVal = v;
      total += Math.max(0, v);
    }
  }
  return { labels, series, maxVal, minVal, total };
}

export function detectDataTableRange(
  sheet: SheetWorksheet,
  evalMap: EvaluatedSheetMap,
  selection: SheetRect,
): SheetRect {
  if (selection.bottom > selection.top || selection.right > selection.left) return selection;
  const { cellByKey } = buildWorksheetGridMap(sheet);
  const occupied = (r: number, c: number) =>
    r >= 0 && r < sheet.rows.length && c >= 0 && c < sheet.columns.length &&
    !readEvaluatedCell(cellByKey, evalMap, r, c).empty;

  const seedR = selection.top;
  const seedC = selection.left;
  if (!occupied(seedR, seedC)) {
    let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
    for (const key of cellByKey.keys()) {
      const [rs, cs] = key.split(":");
      const r = Number(rs);
      const c = Number(cs);
      if (!occupied(r, c)) continue;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    if (maxR >= minR && maxC >= minC) return { top: minR, left: minC, bottom: maxR, right: maxC };
    return selection;
  }

  let top = seedR, bottom = seedR, left = seedC, right = seedC;
  let grew = true;
  while (grew) {
    grew = false;
    if (top > 0) for (let c = left; c <= right; c++) if (occupied(top - 1, c)) { top--; grew = true; break; }
    if (bottom < sheet.rows.length - 1) for (let c = left; c <= right; c++) if (occupied(bottom + 1, c)) { bottom++; grew = true; break; }
    if (left > 0) for (let r = top; r <= bottom; r++) if (occupied(r, left - 1)) { left--; grew = true; break; }
    if (right < sheet.columns.length - 1) for (let r = top; r <= bottom; r++) if (occupied(r, right + 1)) { right++; grew = true; break; }
  }
  return { top, left, bottom, right };
}

export function extractPivotSourceHeaders(
  sheet: SheetWorksheet,
  evalMap: EvaluatedSheetMap,
  rect: SheetRect,
): string[] {
  const { cellByKey } = buildWorksheetGridMap(sheet);
  const out: string[] = [];
  for (let c = rect.left; c <= rect.right; c++) {
    const h = readEvaluatedCell(cellByKey, evalMap, rect.top, c).text.trim();
    out.push(h || `列 ${columnName(c)}`);
  }
  return out;
}

export function detectFirstNumericColOffset(
  sheet: SheetWorksheet,
  evalMap: EvaluatedSheetMap,
  rect: SheetRect,
): number {
  const { cellByKey } = buildWorksheetGridMap(sheet);
  const top = Math.max(0, Math.min(rect.top, rect.bottom));
  const bottom = Math.min(sheet.rows.length - 1, Math.max(rect.top, rect.bottom));
  const left = Math.max(0, Math.min(rect.left, rect.right));
  const right = Math.min(sheet.columns.length - 1, Math.max(rect.left, rect.right));
  const width = Math.max(1, right - left + 1);
  for (let offset = 1; offset < width; offset++) {
    const c = left + offset;
    for (let r = top + 1; r <= bottom; r++) {
      if (readEvaluatedCell(cellByKey, evalMap, r, c).num !== null) return offset;
    }
  }
  return Math.min(1, width - 1);
}

interface AggBucket { sum: number; count: number; numCount: number; min: number; max: number }
const emptyBucket = (): AggBucket => ({ sum: 0, count: 0, numCount: 0, min: Infinity, max: -Infinity });
const roundClean = (n: number) => Math.round(n * 1e6) / 1e6;

function pushBucket(b: AggBucket, cell: { num: number | null; empty: boolean }) {
  if (cell.empty) return;
  b.count++;
  if (cell.num !== null) {
    b.sum += cell.num;
    b.numCount++;
    if (cell.num < b.min) b.min = cell.num;
    if (cell.num > b.max) b.max = cell.num;
  }
}

function finishBucket(b: AggBucket | undefined, agg: SheetPivotAgg): number | null {
  if (!b || b.count === 0) return agg === "count" ? 0 : null;
  switch (agg) {
    case "count": return b.count;
    case "sum": return b.numCount > 0 ? roundClean(b.sum) : 0;
    case "avg": return b.numCount > 0 ? roundClean(b.sum / b.numCount) : null;
    case "min": return b.numCount > 0 ? roundClean(b.min) : null;
    case "max": return b.numCount > 0 ? roundClean(b.max) : null;
  }
}

export function formatPivotNumber(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return Number(v.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export interface PivotComputedRow {
  key: string;
  labelCells: string[];
  cells: (number | null)[];
  totals: (number | null)[];
}

export interface PivotComputedResult {
  sourceHeaders: string[];
  rowFieldHeaders: string[];
  colKeys: string[];
  valueColumnHeaders: string[];
  rowTotalHeaders: string[];
  rows: PivotComputedRow[];
  grandTotals: (number | null)[];
  grandRowTotals: (number | null)[];
  totalRecords: number;
}

const AGG_SHORT_LABEL: Record<SheetPivotAgg, string> = {
  sum: "求和",
  count: "计数",
  avg: "均值",
  min: "最小",
  max: "最大",
};

export function computePivotTable(
  sourceSheet: SheetWorksheet,
  sourceEvalMap: EvaluatedSheetMap,
  pivot: SheetPivotTable,
): PivotComputedResult {
  const { cellByKey } = buildWorksheetGridMap(sourceSheet);
  const top = Math.max(0, Math.min(pivot.top, pivot.bottom));
  const bottom = Math.min(sourceSheet.rows.length - 1, Math.max(pivot.top, pivot.bottom));
  const left = Math.max(0, Math.min(pivot.left, pivot.right));
  const right = Math.min(sourceSheet.columns.length - 1, Math.max(pivot.left, pivot.right));
  const width = right - left + 1;

  const sourceHeaders = extractPivotSourceHeaders(sourceSheet, sourceEvalMap, { top, left, bottom, right });
  const rowFields = pivot.rowFields.filter((f) => f >= 0 && f < width);
  const colField = pivot.colField !== undefined && pivot.colField >= 0 && pivot.colField < width ? pivot.colField : undefined;
  const values = pivot.values.filter((v) => v.col >= 0 && v.col < width);

  const rowFieldHeaders = rowFields.map((f) => sourceHeaders[f] ?? `列 ${f + 1}`);
  const colKeySet = new Set<string>();
  const rowMap = new Map<string, { labelCells: string[]; byCol: Map<string, AggBucket[]>; rowTotals: AggBucket[] }>();
  const grandByCol = new Map<string, AggBucket[]>();
  const grandTotalsBuckets = values.map(() => emptyBucket());

  let totalRecords = 0;
  for (let r = top + 1; r <= bottom; r++) {
    let anyNonEmpty = false;
    for (let c = left; c <= right; c++) {
      if (!readEvaluatedCell(cellByKey, sourceEvalMap, r, c).empty) { anyNonEmpty = true; break; }
    }
    if (!anyNonEmpty) continue;
    totalRecords++;

    const labelCells = rowFields.map((f) => readEvaluatedCell(cellByKey, sourceEvalMap, r, left + f).text.trim() || "（空白）");
    const rowKey = labelCells.join("\u001f");
    const colKey = colField !== undefined
      ? (readEvaluatedCell(cellByKey, sourceEvalMap, r, left + colField).text.trim() || "（空白）")
      : "__all__";
    colKeySet.add(colKey);

    let entry = rowMap.get(rowKey);
    if (!entry) {
      entry = { labelCells, byCol: new Map(), rowTotals: values.map(() => emptyBucket()) };
      rowMap.set(rowKey, entry);
    }
    let colBuckets = entry.byCol.get(colKey);
    if (!colBuckets) { colBuckets = values.map(() => emptyBucket()); entry.byCol.set(colKey, colBuckets); }
    let gColBuckets = grandByCol.get(colKey);
    if (!gColBuckets) { gColBuckets = values.map(() => emptyBucket()); grandByCol.set(colKey, gColBuckets); }

    values.forEach((vDef, vi) => {
      const cell = readEvaluatedCell(cellByKey, sourceEvalMap, r, left + vDef.col);
      pushBucket(colBuckets![vi], cell);
      pushBucket(entry!.rowTotals[vi], cell);
      pushBucket(gColBuckets![vi], cell);
      pushBucket(grandTotalsBuckets[vi], cell);
    });
  }

  const colKeys = colField !== undefined ? [...colKeySet].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")) : ["__all__"];
  const valueColumnHeaders: string[] = [];
  for (const ck of colKeys) {
    for (const vDef of values) {
      const baseName = `${sourceHeaders[vDef.col] ?? `列 ${vDef.col + 1}`}(${AGG_SHORT_LABEL[vDef.agg]})`;
      valueColumnHeaders.push(colField !== undefined ? `${ck} · ${baseName}` : baseName);
    }
  }
  const rowTotalHeaders = colField !== undefined && pivot.showRowTotals
    ? values.map((vDef) => `总计 · ${sourceHeaders[vDef.col] ?? `列 ${vDef.col + 1}`}(${AGG_SHORT_LABEL[vDef.agg]})`)
    : [];

  const rows: PivotComputedRow[] = [...rowMap.entries()].map(([key, entry]) => {
    const cells: (number | null)[] = [];
    for (const ck of colKeys) {
      const buckets = entry.byCol.get(ck);
      values.forEach((vDef, vi) => cells.push(finishBucket(buckets?.[vi], vDef.agg)));
    }
    const totals = colField !== undefined && pivot.showRowTotals
      ? values.map((vDef, vi) => finishBucket(entry.rowTotals[vi], vDef.agg))
      : [];
    return { key, labelCells: entry.labelCells, cells, totals };
  });

  const sortMode = pivot.sortBy || "label_asc";
  rows.sort((a, b) => {
    if (sortMode === "value_desc" || sortMode === "value_asc") {
      const va = a.totals[0] ?? a.cells[0] ?? -Infinity;
      const vb = b.totals[0] ?? b.cells[0] ?? -Infinity;
      if (va !== vb) return sortMode === "value_desc" ? vb - va : va - vb;
    }
    const cmp = a.labelCells.join(" / ").localeCompare(b.labelCells.join(" / "), "zh-Hans-CN");
    return sortMode === "label_desc" ? -cmp : cmp;
  });

  const grandTotals: (number | null)[] = [];
  for (const ck of colKeys) {
    const buckets = grandByCol.get(ck);
    values.forEach((vDef, vi) => grandTotals.push(finishBucket(buckets?.[vi], vDef.agg)));
  }
  const grandRowTotals = colField !== undefined && pivot.showRowTotals
    ? values.map((vDef, vi) => finishBucket(grandTotalsBuckets[vi], vDef.agg))
    : [];

  return { sourceHeaders, rowFieldHeaders, colKeys, valueColumnHeaders, rowTotalHeaders, rows, grandTotals, grandRowTotals, totalRecords };
}

export function pivotResultToCellMatrix(
  pivot: SheetPivotTable,
  result: PivotComputedResult,
): { row: number; col: number; raw: string; style: SheetCellStyle }[] {
  const edits: { row: number; col: number; raw: string; style: SheetCellStyle }[] = [];
  const headerStyle: SheetCellStyle = { bold: true, bg: "#eef3ff", color: "#1f2329", borders: { top: true, right: true, bottom: true, left: true, color: "#c9cdd4" } };
  const labelStyle: SheetCellStyle = { borders: { top: true, right: true, bottom: true, left: true, color: "#e5e6eb" } };
  const numStyle: SheetCellStyle = { align: "right", borders: { top: true, right: true, bottom: true, left: true, color: "#e5e6eb" } };
  const totalStyle: SheetCellStyle = { bold: true, bg: "#f5f6f7", align: "right", borders: { top: true, right: true, bottom: true, left: true, color: "#c9cdd4" } };
  const totalLabelStyle: SheetCellStyle = { bold: true, bg: "#f5f6f7", borders: { top: true, right: true, bottom: true, left: true, color: "#c9cdd4" } };

  const allHeaders = [...result.rowFieldHeaders, ...result.valueColumnHeaders, ...result.rowTotalHeaders];
  allHeaders.forEach((h, c) => edits.push({ row: 0, col: c, raw: h, style: headerStyle }));

  result.rows.forEach((r, rIdx) => {
    const outRow = rIdx + 1;
    let c = 0;
    for (const lbl of r.labelCells) edits.push({ row: outRow, col: c++, raw: lbl, style: labelStyle });
    for (const val of r.cells) edits.push({ row: outRow, col: c++, raw: val === null ? "" : String(val), style: numStyle });
    for (const val of r.totals) edits.push({ row: outRow, col: c++, raw: val === null ? "" : String(val), style: { ...numStyle, bold: true } });
  });

  if (pivot.showColTotals && result.rows.length > 0) {
    const outRow = result.rows.length + 1;
    let c = 0;
    for (let i = 0; i < result.rowFieldHeaders.length; i++) edits.push({ row: outRow, col: c++, raw: i === 0 ? "总计" : "", style: totalLabelStyle });
    for (const val of result.grandTotals) edits.push({ row: outRow, col: c++, raw: val === null ? "" : String(val), style: totalStyle });
    for (const val of result.grandRowTotals) edits.push({ row: outRow, col: c++, raw: val === null ? "" : String(val), style: totalStyle });
  }
  return edits;
}

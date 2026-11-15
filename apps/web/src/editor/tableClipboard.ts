import { coverMap, expandRange, normRange, type CellRange, type Merge } from "./tableOps";

const MAX_TEXT = 256 * 1024;
const MAX_PASTE_CELLS = 1000;
const MAX_TABLE_CELLS = 5000;
const MAX_ROWS = 200;
const MAX_COLS = 50;

/** Excel-compatible TSV, including quoted tabs, line breaks and doubled quotes. */
export function parseTableTSV(text: string): string[][] | null {
  if (text.length > MAX_TEXT) return null;
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false, closed = false, count = 0;
  const cell = () => { row.push(value); value = ""; closed = false; return ++count <= MAX_PASTE_CELLS && row.length <= MAX_COLS; };
  const line = () => { rows.push(row); row = []; return rows.length <= MAX_ROWS; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } }
      else if (ch === "\r") { value += "\n"; if (text[i + 1] === "\n") i++; }
      else value += ch;
    } else if (ch === "\t") { if (!cell()) return null; }
    else if (ch === "\n" || ch === "\r") { if (!cell() || !line()) return null; if (ch === "\r" && text[i + 1] === "\n") i++; }
    else if (closed) return null;
    else if (ch === '"' && value === "") quoted = true;
    else value += ch;
  }
  if (quoted) return null;
  if (value !== "" || row.length || closed) { if (!cell() || !line()) return null; }
  return rows;
}

export function formatTableTSV(rows: string[][], range: CellRange, merges: Merge[] = []): string {
  const covered = coverMap(merges);
  return rows.slice(range.r0, range.r1 + 1).map((row, ri) => row.slice(range.c0, range.c1 + 1).map((cell, ci) => {
    // Hidden cells can hold concurrent edits; do not copy invisible content.
    const value = covered.get(`${range.r0 + ri}:${range.c0 + ci}`) === "hidden" ? "" : cell;
    return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join("\t")).join("\n");
}

export type TablePasteResult = { ok: true; rows: string[][]; changed: boolean } | { ok: false; message: string };

/** Append one blank row within the same limits used by table paste. */
export function planTableAppendRow(rows: string[][]): TablePasteResult {
  const cols = rows[0]?.length ?? 0;
  if (!rows.length || !cols || rows.some((row) => row.length !== cols)) return { ok: false, message: "表格结构无效，未添加新行。" };
  if (rows.length + 1 > MAX_ROWS || cols > MAX_COLS || (rows.length + 1) * cols > MAX_TABLE_CELLS) return { ok: false, message: "表格已达到大小限制，未添加新行。" };
  const next = [...rows, Array.from({ length: cols }, () => "")];
  if (new TextEncoder().encode(JSON.stringify(next)).length > 1024 * 1024) return { ok: false, message: "表格过大，未添加新行。" };
  return { ok: true, rows: next, changed: true };
}

/** Compute all changes first; merged cells accept only a compatible source shape. */
export function planTablePaste(rows: string[][], merges: Merge[], startRow: number, startCol: number, text: string): TablePasteResult {
  const grid = parseTableTSV(text);
  if (!grid?.length) return { ok: false, message: "粘贴内容格式无效或过大，表格未修改。" };
  if (!Number.isInteger(startRow) || !Number.isInteger(startCol) || startRow < 0 || startCol < 0 || startRow >= rows.length || startCol >= (rows[0]?.length ?? 0)) return { ok: false, message: "表格位置已变化，请重新选择单元格。" };
  const width = Math.max(...grid.map((r) => r.length));
  const nr = Math.max(rows.length, startRow + grid.length), nc = Math.max(rows[0].length, startCol + width);
  if (nr > MAX_ROWS || nc > MAX_COLS || nr * nc > MAX_TABLE_CELLS) return { ok: false, message: "粘贴范围超过表格大小限制，表格未修改。" };
  for (const [mr, mc, rs, cs] of merges) {
    let touched = false, fullyCovered = true, hiddenContent = false;
    for (let r = mr; r < mr + rs; r++) for (let c = mc; c < mc + cs; c++) {
      const gr = r - startRow, gc = c - startCol;
      const present = gr >= 0 && gr < grid.length && gc >= 0 && gc < grid[gr].length;
      touched ||= present;
      fullyCovered &&= present;
      if (present && (r !== mr || c !== mc) && grid[gr][gc] !== "") hiddenContent = true;
    }
    const singleAnchor = grid.length === 1 && grid[0].length === 1 && startRow === mr && startCol === mc;
    if (touched && ((!fullyCovered && !singleAnchor) || hiddenContent)) return { ok: false, message: "粘贴内容与合并单元格不匹配，请调整选区或先拆分。" };
  }
  const covered = coverMap(merges);
  const next = Array.from({ length: nr }, (_, r) => Array.from({ length: nc }, (_, c) => rows[r]?.[c] ?? ""));
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) {
    if (covered.get(`${startRow + r}:${startCol + c}`) !== "hidden") next[startRow + r][startCol + c] = grid[r][c];
  }
  if (new TextEncoder().encode(JSON.stringify(next)).length > 1024 * 1024) return { ok: false, message: "粘贴后的表格过大，表格未修改。" };
  return { ok: true, rows: next, changed: JSON.stringify(rows) !== JSON.stringify(next) };
}

/** Clear visible anchors in a complete selection, retaining hidden cell data. */
function planTableRemoval(rows: string[][], merges: Merge[], selection: CellRange, action: "剪切" | "清空"): TablePasteResult {
  const range = normRange(selection);
  if (![range.r0, range.r1, range.c0, range.c1].every(Number.isInteger) || range.r0 < 0 || range.c0 < 0 || range.r1 >= rows.length || range.c1 >= (rows[0]?.length ?? 0)) return { ok: false, message: "表格位置已变化，请重新选择单元格。" };
  const expanded = expandRange(range, merges);
  if (expanded.r0 !== range.r0 || expanded.r1 !== range.r1 || expanded.c0 !== range.c0 || expanded.c1 !== range.c1) return { ok: false, message: "选区未完整包含合并单元格，请重新选择。" };
  if ((range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1) > MAX_PASTE_CELLS) return { ok: false, message: `${action}范围过大，表格未修改。` };
  const covered = coverMap(merges);
  const next = rows.map((row, r) => row.map((value, c) => r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1 && covered.get(`${r}:${c}`) !== "hidden" ? "" : value));
  if (new TextEncoder().encode(JSON.stringify(next)).length > 1024 * 1024) return { ok: false, message: `表格过大，无法安全${action}。` };
  return { ok: true, rows: next, changed: JSON.stringify(rows) !== JSON.stringify(next) };
}

export function planTableCut(rows: string[][], merges: Merge[], selection: CellRange): TablePasteResult {
  return planTableRemoval(rows, merges, selection, "剪切");
}

export function planTableClear(rows: string[][], merges: Merge[], selection: CellRange): TablePasteResult {
  return planTableRemoval(rows, merges, selection, "清空");
}

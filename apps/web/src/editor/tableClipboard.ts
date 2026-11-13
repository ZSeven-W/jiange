import type { CellRange, Merge } from "./tableOps";

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

export function formatTableTSV(rows: string[][], range: CellRange): string {
  return rows.slice(range.r0, range.r1 + 1).map((row) => row.slice(range.c0, range.c1 + 1).map((value) => /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join("\t")).join("\n");
}

export type TablePasteResult = { ok: true; rows: string[][]; changed: boolean } | { ok: false; message: string };

/** Compute all changes first; do not partially paste over merged cells or limits. */
export function planTablePaste(rows: string[][], merges: Merge[], startRow: number, startCol: number, text: string): TablePasteResult {
  const grid = parseTableTSV(text);
  if (!grid?.length) return { ok: false, message: "粘贴内容格式无效或过大，表格未修改。" };
  if (!Number.isInteger(startRow) || !Number.isInteger(startCol) || startRow < 0 || startCol < 0 || startRow >= rows.length || startCol >= (rows[0]?.length ?? 0)) return { ok: false, message: "表格位置已变化，请重新选择单元格。" };
  const width = Math.max(...grid.map((r) => r.length));
  const nr = Math.max(rows.length, startRow + grid.length), nc = Math.max(rows[0].length, startCol + width);
  if (nr > MAX_ROWS || nc > MAX_COLS || nr * nc > MAX_TABLE_CELLS) return { ok: false, message: "粘贴范围超过表格大小限制，表格未修改。" };
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) {
    if (merges.some(([mr, mc, rs, cs]) => startRow + r >= mr && startRow + r < mr + rs && startCol + c >= mc && startCol + c < mc + cs)) return { ok: false, message: "粘贴范围包含合并单元格，请先拆分后重试。" };
  }
  const next = Array.from({ length: nr }, (_, r) => Array.from({ length: nc }, (_, c) => rows[r]?.[c] ?? ""));
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) next[startRow + r][startCol + c] = grid[r][c];
  if (new TextEncoder().encode(JSON.stringify(next)).length > 1024 * 1024) return { ok: false, message: "粘贴后的表格过大，表格未修改。" };
  return { ok: true, rows: next, changed: JSON.stringify(rows) !== JSON.stringify(next) };
}

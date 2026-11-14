import { formatTSV, parseTSV } from "@/pages/base/tsv";

export type SheetPoint = { row: number; col: number };
export type SheetSelection = { anchor: SheetPoint; focus: SheetPoint };
export type SheetCells = Readonly<Record<string, string>>;
export const PREVIEW_ROWS = 100, PREVIEW_COLS = 26;
const MAX_BATCH = 500, MAX_CELL_BYTES = 32 * 1024, MAX_BATCH_BYTES = 2 * 1024 * 1024;
export const pointKey = ({ row, col }: SheetPoint) => `${row}:${col}`;
export function validPoint(point: SheetPoint, rows = PREVIEW_ROWS, cols = PREVIEW_COLS) {
  return Number.isInteger(point.row) && Number.isInteger(point.col) && point.row >= 0 && point.row < rows && point.col >= 0 && point.col < cols;
}
export function columnName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 16384) return "";
  let n = index + 1, result = "";
  while (n) { n--; result = String.fromCharCode(65 + n % 26) + result; n = Math.floor(n / 26); }
  return result;
}
export function sheetAddress(point: SheetPoint): string { return `${columnName(point.col)}${point.row + 1}`; }
export function selectionBounds(selection: SheetSelection) {
  return { top: Math.min(selection.anchor.row, selection.focus.row), bottom: Math.max(selection.anchor.row, selection.focus.row), left: Math.min(selection.anchor.col, selection.focus.col), right: Math.max(selection.anchor.col, selection.focus.col) };
}
export function selected(selection: SheetSelection, point: SheetPoint) {
  const b = selectionBounds(selection); return point.row >= b.top && point.row <= b.bottom && point.col >= b.left && point.col <= b.right;
}
export function selectionOutline(selection: SheetSelection, point: SheetPoint): string | undefined {
  const b = selectionBounds(selection);
  if (!selected(selection, point)) return undefined;
  const edges: string[] = [];
  if (point.row === b.top) edges.push("inset 0 2px #3370ff");
  if (point.row === b.bottom) edges.push("inset 0 -2px #3370ff");
  if (point.col === b.left) edges.push("inset 2px 0 #3370ff");
  if (point.col === b.right) edges.push("inset -2px 0 #3370ff");
  return edges.length ? edges.join(", ") : undefined;
}
export type CellChange = { point: SheetPoint; value: string };
export type CellEdit = { ok: true; cells: SheetCells } | { ok: false; reason: "bounds" | "formula" | "size" | "invalid" };
function validText(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0 || code >= 0xdc00 && code <= 0xdfff) return false;
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
  }
  return true;
}

/** Check the whole operation before applying it; never silently clip pasted cells. */
export function applyCellChanges(cells: SheetCells, changes: readonly CellChange[]): CellEdit {
  if (!changes.length || changes.length > MAX_BATCH) return { ok: false, reason: "size" };
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const change of changes) {
    if (!validPoint(change.point)) return { ok: false, reason: "bounds" };
    if (change.value.startsWith("=")) return { ok: false, reason: "formula" };
    if (!validText(change.value)) return { ok: false, reason: "invalid" };
    const size = encoder.encode(change.value).length;
    if (size > MAX_CELL_BYTES || (bytes += size) > MAX_BATCH_BYTES) return { ok: false, reason: "size" };
  }
  const next = { ...cells };
  for (const { point, value } of changes) { const key = pointKey(point); if (value === "") delete next[key]; else next[key] = value; }
  return { ok: true, cells: next };
}
export function pasteCells(cells: SheetCells, at: SheetPoint, text: string): CellEdit {
  const grid = parseTSV(text);
  if (!grid.length) return { ok: false, reason: "size" };
  const changes: CellChange[] = [];
  for (let row = 0; row < grid.length; row++) for (let col = 0; col < grid[row].length; col++) changes.push({ point: { row: at.row + row, col: at.col + col }, value: grid[row][col] });
  return applyCellChanges(cells, changes);
}
export function selectionText(cells: SheetCells, selection: SheetSelection): string {
  const b = selectionBounds(selection), rows: string[][] = [];
  for (let row = b.top; row <= b.bottom; row++) { const values: string[] = []; for (let col = b.left; col <= b.right; col++) values.push(cells[pointKey({ row, col })] ?? ""); rows.push(values); }
  return formatTSV(rows);
}
export function clearSelection(cells: SheetCells, selection: SheetSelection): CellEdit {
  const b = selectionBounds(selection), changes: CellChange[] = [];
  if ((b.bottom - b.top + 1) * (b.right - b.left + 1) > MAX_BATCH) return { ok: false, reason: "size" };
  for (let row = b.top; row <= b.bottom; row++) for (let col = b.left; col <= b.right; col++) changes.push({ point: { row, col }, value: "" });
  return applyCellChanges(cells, changes);
}

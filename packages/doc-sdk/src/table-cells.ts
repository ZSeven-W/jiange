import type { OpId, Tx } from "@jiange/collab";
import { parseTableData } from "./model.js";

/**
 * 表格单元格级存储（无需协议变更）：协同模型的块属性本身就是“逐键后写胜出”，
 * 把每个单元格存为独立属性后，不同协作者同时编辑不同单元格不会再互相覆盖。
 *
 *   tbl.v = "2"                 已迁移标记
 *   tbl.rows / tbl.cols         行、列稳定 ID 的 JSON 数组（结构仍是整体后写胜出）
 *   tbl.c.<rowId>.<colId>       单元格文本
 *   tableData                   与旧客户端兼容的整表镜像（每次写入一并更新）
 *   tbl.m                       镜像指纹：等于 hash(tableData) 时说明镜像出自新客户端；
 *                               不相等说明旧客户端直接改了 tableData，以它为准并回填单元格。
 *
 * 并发写同一单元格仍按后写胜出；并发插入/删除行列时结构列表后写胜出（文字不会被别人的
 * 单元格编辑覆盖，但被丢弃的新行会从视图中消失）。
 */
export const TBL_VERSION = "tbl.v";
export const TBL_ROWS = "tbl.rows";
export const TBL_COLS = "tbl.cols";
export const TBL_MIRROR = "tbl.m";
/** Legacy grid at migration time. Every client migrating the same legacy table writes the
 * identical value, so unchanged cells need no per-cell write (and cannot clobber others). */
export const TBL_BASE = "tbl.base";
export const cellKey = (row: string, col: string) => `tbl.c.${row}.${col}`;
export const cellFillKey = (row: string, col: string) => `tbl.fill.${row}.${col}`;
export type TableAlignAxis = "horizontal" | "vertical";
export type TableHorizontalAlign = "left" | "center" | "right";
export type TableVerticalAlign = "top" | "middle" | "bottom";
export type TableAlign = TableHorizontalAlign | TableVerticalAlign;
export const cellAlignKey = (row: string, col: string, axis: TableAlignAxis) => `tbl.${axis === "horizontal" ? "halign" : "valign"}.${row}.${col}`;

/** FNV-1a 32-bit over UTF-8, lowercase hex (mirrored in Go for server search). */
export function tableHash(value: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const ids = (raw: string | undefined): string[] | null => {
  try {
    const parsed = JSON.parse(raw ?? "null");
    return Array.isArray(parsed) && parsed.length && parsed.every((x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(x)) ? parsed : null;
  } catch { return null; }
};

/** Explicit cell fill; an empty value inherits the default/header background. */
export function tableCellFill(props: Record<string, string>, row: number, col: number): string {
  if (!Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(col) || col < 0) return "";
  const rows = props[TBL_VERSION] === "2" ? ids(props[TBL_ROWS]) : null, cols = props[TBL_VERSION] === "2" ? ids(props[TBL_COLS]) : null;
  const r = rows ? rows[row] : `r${row}`, c = cols ? cols[col] : `c${col}`;
  if (!r || !c) return "";
  const value = props[cellFillKey(r, c)] ?? "";
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : "";
}

/** Set only the selected cell registers; existing rows/columns retain their IDs. */
export function setTableCellFills(tx: Tx, block: OpId, cells: readonly { row: number; col: number; fill: string }[]): void {
  const props = tx.doc.blockInfo(block).props;
  const rows = ids(props[TBL_ROWS]), cols = ids(props[TBL_COLS]);
  if (props[TBL_VERSION] !== "2" || !rows || !cols) throw new Error("table must be migrated before setting cell fill");
  for (const { row, col, fill } of cells) {
    if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col) || row < 0 || col < 0 || row >= rows.length || col >= cols.length || (fill !== "" && !/^#[0-9a-f]{6}$/i.test(fill))) throw new Error("invalid table fill");
  }
  for (const { row, col, fill } of cells) tx.setProp(block, cellFillKey(rows[row], cols[col]), fill.toUpperCase());
}

export function tableCellAlign(props: Record<string, string>, row: number, col: number, axis: "horizontal"): TableHorizontalAlign;
export function tableCellAlign(props: Record<string, string>, row: number, col: number, axis: "vertical"): TableVerticalAlign;
export function tableCellAlign(props: Record<string, string>, row: number, col: number, axis: TableAlignAxis): TableAlign;
export function tableCellAlign(props: Record<string, string>, row: number, col: number, axis: TableAlignAxis): TableAlign {
  const fallback = axis === "horizontal" ? "left" : "top";
  if (!Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(col) || col < 0) return fallback;
  const rows = props[TBL_VERSION] === "2" ? ids(props[TBL_ROWS]) : null, cols = props[TBL_VERSION] === "2" ? ids(props[TBL_COLS]) : null;
  const r = rows ? rows[row] : `r${row}`, c = cols ? cols[col] : `c${col}`;
  if (!r || !c) return fallback;
  const value = props[cellAlignKey(r, c, axis)];
  if (axis === "horizontal" && (value === "center" || value === "right")) return value;
  if (axis === "vertical" && (value === "middle" || value === "bottom")) return value;
  return fallback;
}

/** Per-axis cell registers keep concurrent horizontal and vertical edits independent. */
export function setTableCellAlignments(tx: Tx, block: OpId, cells: readonly { row: number; col: number; axis: TableAlignAxis; align: TableAlign }[]): void {
  const props = tx.doc.blockInfo(block).props, rows = ids(props[TBL_ROWS]), cols = ids(props[TBL_COLS]);
  if (props[TBL_VERSION] !== "2" || !rows || !cols) throw new Error("table must be migrated before setting cell alignment");
  for (const { row, col, axis, align } of cells) {
    if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col) || row < 0 || col < 0 || row >= rows.length || col >= cols.length || (axis !== "horizontal" && axis !== "vertical") || !(axis === "horizontal" ? ["left", "center", "right"] : ["top", "middle", "bottom"]).includes(align)) throw new Error("invalid table alignment");
  }
  for (const { row, col, axis, align } of cells) tx.setProp(block, cellAlignKey(rows[row], cols[col], axis), align === (axis === "horizontal" ? "left" : "top") ? "" : align);
}

export function isCellTable(props: Record<string, string>): boolean {
  return props[TBL_VERSION] === "2" && !!ids(props[TBL_ROWS]) && !!ids(props[TBL_COLS]);
}

/** Cell value: explicit cell prop, else the migration base for migration-time axes (r<i>/c<j>). */
function cellValue(props: Record<string, string>, base: string[][] | null, r: string, c: string): string {
  const own = props[cellKey(r, c)];
  if (own !== undefined) return own;
  const ri = /^r(\d+)$/.exec(r), ci = /^c(\d+)$/.exec(c);
  return ri && ci && base ? base[Number(ri[1])]?.[Number(ci[1])] ?? "" : "";
}

const baseOf = (props: Record<string, string>) => (props[TBL_BASE] ? parseTableData(props[TBL_BASE]) : null);

/** Grid materialized from cell props (ignores the mirror). */
export function cellGrid(props: Record<string, string>): string[][] | null {
  const rows = ids(props[TBL_ROWS]), cols = ids(props[TBL_COLS]);
  if (props[TBL_VERSION] !== "2" || !rows || !cols) return null;
  const base = baseOf(props);
  return rows.map((r) => cols.map((c) => cellValue(props, base, r, c)));
}

/** Old clients only write tableData: their write leaves the fingerprint stale. */
const mirrorTrusted = (props: Record<string, string>) => props[TBL_MIRROR] === tableHash(props.tableData ?? "");

/** The effective table rows every reader should use. */
export function tableRowsOf(props: Record<string, string>): string[][] {
  const grid = cellGrid(props);
  if (grid && mirrorTrusted(props)) return grid;
  return parseTableData(props.tableData);
}

/** Effective table as the legacy JSON string (for renderers/exports that take a string). */
export function tableDataOf(props: Record<string, string>): string {
  return isCellTable(props) && mirrorTrusted(props) ? JSON.stringify(cellGrid(props)) : (props.tableData ?? "");
}

/**
 * Reorder stable axes without rewriting cell registers. Reject a stale legacy
 * mirror or malformed identities rather than guessing which content moves.
 */
function stableTableSnapshot(props: Record<string, string>): { rows: string[]; cols: string[]; grid: string[][] } | null {
  const rows = ids(props[TBL_ROWS]), cols = ids(props[TBL_COLS]);
  if (props[TBL_VERSION] !== "2" || !rows || !cols || !mirrorTrusted(props) || new Set(rows).size !== rows.length || new Set(cols).size !== cols.length || rows.length > 200 || cols.length > 50 || rows.length * cols.length > 5000) return null;
  const grid = cellGrid(props);
  return grid ? { rows, cols, grid } : null;
}

export function stableTableReorderWrites(props: Record<string, string>, axis: "row" | "column", order: readonly number[]): Record<string, string> | null {
  const snapshot = stableTableSnapshot(props);
  if (!snapshot) return null;
  const { rows, cols, grid } = snapshot, count = axis === "row" ? rows.length : axis === "column" ? cols.length : 0;
  if (!count || order.length !== count || new Set(order).size !== count || order.some(index => !Number.isSafeInteger(index) || index < 0 || index >= count)) return null;
  const next = axis === "row" ? order.map(index => [...grid[index]]) : grid.map(row => order.map(index => row[index]));
  const mirror = JSON.stringify(next);
  return { [axis === "row" ? TBL_ROWS : TBL_COLS]: JSON.stringify(order.map(index => (axis === "row" ? rows : cols)[index])), tableData: mirror, [TBL_MIRROR]: tableHash(mirror) };
}

/** Insert a fresh axis without changing any existing cell register. */
export function stableTableInsertWrites(props: Record<string, string>, axis: "row" | "column", at: number, id: string): Record<string, string> | null {
  const snapshot = stableTableSnapshot(props);
  if (!snapshot || (axis !== "row" && axis !== "column") || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  const { rows, cols, grid } = snapshot, source = axis === "row" ? rows : cols;
  if (!Number.isSafeInteger(at) || at < 0 || at > source.length || rows.includes(id) || cols.includes(id) || Object.keys(props).some(key => key.startsWith("tbl.") && key.split(".")[axis === "row" ? 2 : 3] === id)) return null;
  const nextRows = rows.length + (axis === "row" ? 1 : 0), nextCols = cols.length + (axis === "column" ? 1 : 0);
  if (nextRows > 200 || nextCols > 50 || nextRows * nextCols > 5000) return null;
  const axes = [...source.slice(0, at), id, ...source.slice(at)];
  const next = axis === "row" ? [...grid.slice(0, at), Array(cols.length).fill(""), ...grid.slice(at)] : grid.map(row => [...row.slice(0, at), "", ...row.slice(at)]);
  const mirror = JSON.stringify(next);
  return { [axis === "row" ? TBL_ROWS : TBL_COLS]: JSON.stringify(axes), tableData: mirror, [TBL_MIRROR]: tableHash(mirror) };
}

/** Remove axes but retain their registers for delayed writes and guarded undo. */
export function stableTableDeleteWrites(props: Record<string, string>, axis: "row" | "column", indices: readonly number[]): Record<string, string> | null {
  const snapshot = stableTableSnapshot(props);
  if (!snapshot || (axis !== "row" && axis !== "column")) return null;
  const { rows, cols, grid } = snapshot, source = axis === "row" ? rows : cols, removed = new Set(indices);
  if (!indices.length || removed.size !== indices.length || indices.length >= source.length || indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= source.length)) return null;
  const axes = source.filter((_, index) => !removed.has(index));
  const next = axis === "row" ? grid.filter((_, index) => !removed.has(index)) : grid.map(row => row.filter((_, index) => !removed.has(index)));
  const mirror = JSON.stringify(next);
  return { [axis === "row" ? TBL_ROWS : TBL_COLS]: JSON.stringify(axes), tableData: mirror, [TBL_MIRROR]: tableHash(mirror) };
}

let seq = 0;
/** Short, collision-resistant row/column ID (client id + counter + random). */
export function newAxisId(client: number): string {
  seq = (seq + 1) % 1_000_000;
  // "x" prefix keeps these apart from migration-time axes (r<i>/c<j>).
  return `x${client.toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Prop writes that turn the current table into `next`. Leading rows/columns keep
 * their IDs; only cells whose text changes are written, so a single-cell edit
 * writes one cell (+ mirror) and cannot clobber a collaborator's other cells.
 */
export function cellTableWrites(props: Record<string, string>, next: string[][], client: number): Record<string, string> {
  const writes: Record<string, string> = {};
  const migrated = isCellTable(props);
  const legacy = migrated ? null : parseTableData(props.tableData);
  const base = migrated ? baseOf(props) : legacy;
  const oldRows = (migrated ? ids(props[TBL_ROWS]) : null) ?? [];
  const oldCols = (migrated ? ids(props[TBL_COLS]) : null) ?? [];
  const width = Math.max(1, ...next.map((r) => r.length));
  // First migration uses deterministic IDs so two clients migrating the same legacy
  // table concurrently agree on the axes and neither side's cell edit is orphaned.
  const rows = next.map((_, i) => oldRows[i] ?? (migrated ? newAxisId(client) : `r${i}`));
  const cols = Array.from({ length: width }, (_, i) => oldCols[i] ?? (migrated ? newAxisId(client) : `c${i}`));
  if (!migrated) { writes[TBL_VERSION] = "2"; writes[TBL_BASE] = JSON.stringify(legacy); }
  if (JSON.stringify(rows) !== props[TBL_ROWS]) writes[TBL_ROWS] = JSON.stringify(rows);
  if (JSON.stringify(cols) !== props[TBL_COLS]) writes[TBL_COLS] = JSON.stringify(cols);
  rows.forEach((r, ri) => cols.forEach((c, ci) => {
    const value = next[ri]?.[ci] ?? "";
    // Only cells whose effective value changes are written; concurrent writers of
    // other cells (or of the same migration) never overwrite each other.
    if (cellValue(migrated ? props : {}, base, r, c) !== value) writes[cellKey(r, c)] = value;
  }));
  const mirror = JSON.stringify(next.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? "")));
  if (mirror !== props.tableData) writes.tableData = mirror;
  writes[TBL_MIRROR] = tableHash(mirror);
  return writes;
}

/** Apply cell writes with their inherited values, including explicit clears. */
export function applyTableWrites(tx: Tx, block: OpId, props: Record<string, string>, writes: Record<string, string>): void {
  const base = isCellTable(props) ? baseOf(props) : parseTableData(props.tableData);
  for (const [key, value] of Object.entries(writes)) {
    const cell = /^tbl\.c\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(key);
    // Missing per-cell registers inherit migration-time text, so writing an
    // explicit empty value must not be treated as an already-empty register.
    tx.setProp(block, key, value, cell ? cellValue(props, base, cell[1], cell[2]) : "");
  }
}

/** Apply a full-table change through cell props. Always rewrites the mirror (keeps tableData versioning). */
export function writeTable(tx: Tx, block: OpId, props: Record<string, string>, next: string[][], client: number): void {
  const writes = cellTableWrites(props, next, client);
  // Ensure the tableData register always advances so version-based history checks see the write.
  if (!("tableData" in writes)) writes.tableData = props.tableData ?? JSON.stringify(next);
  applyTableWrites(tx, block, props, writes);
}

/**
 * Background convergence after concurrent edits: rewrite a stale mirror from the
 * cells, or re-seed cells from a newer old-client tableData write. Null = nothing to do.
 */
export function tableRepairWrites(props: Record<string, string>, client: number): Record<string, string> | null {
  if (!isCellTable(props)) return null;
  if (!mirrorTrusted(props)) return cellTableWrites(props, parseTableData(props.tableData), client);
  const grid = JSON.stringify(cellGrid(props));
  if (grid === props.tableData) return null;
  return { tableData: grid, [TBL_MIRROR]: tableHash(grid) };
}

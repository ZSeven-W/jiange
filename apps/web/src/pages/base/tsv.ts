import type { BaseRecord, Cell, Field } from "@/lib/api";
import { displayValue, REGISTRY } from "./registry";
import type { User } from "@/lib/api";

/** Parse Excel-style TSV: \t between cells, \n between rows; a leading `"`
 * quotes a cell (embedded tabs/newlines allowed, `""` is a literal quote).
 * A trailing newline does not add an empty row. */
export function parseTSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

/** Needs quoting when pasted back into TSV (embedded separator/newline/quote). */
export function formatTSV(rows: string[][]): string {
  return rows
    .map((r) => r.map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join("\t"))
    .join("\n");
}

/** Cell value → plain text (for copy), through the type registry. */
export function toText(field: Field, v: Cell | undefined, members?: User[]): string {
  return REGISTRY[field.type].format(v, field, members);
}

/** Plain text → cell value; undefined means "cannot paste into this field" (skip). */
export function fromText(field: Field, text: string, members?: User[]): Cell | null | undefined {
  const value = REGISTRY[field.type].parse(text, field, members);
  if (field.type !== "date" || value === null || value === undefined) return value;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : undefined;
}

export interface PastePatch {
  rid: number;
  cells: Record<string, Cell | null>;
}

export interface PastePlan {
  /** patches keyed by existing record id */
  patches: PastePatch[];
  /** how many new rows to create before applying the tail patches */
  addRows: { cells: Record<string, Cell | null> }[];
  /** One-based coordinates in the pasted TSV, without including cell contents. */
  skipped: { row: number; column: number; reason: "outside_fields" | "invalid" }[];
  /** Existing target IDs used to recheck authorization for the retained input. */
  scope: { recordIds: number[]; fieldIds: number[] };
}

/** Compute the mutations for pasting TSV at selection anchor (ri, fi).
 * Cells that cannot be represented in their field are skipped. */
export function planPaste(records: BaseRecord[], fields: Field[], ri: number, fi: number, text: string, members?: User[]): PastePlan {
  const grid = parseTSV(text);
  const width = grid.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const plan: PastePlan = {
    patches: [], addRows: [], skipped: [],
    scope: { recordIds: records.slice(ri, ri + grid.length).map((record) => record.id), fieldIds: fields.slice(fi, fi + width).map((field) => field.id) },
  };
  if (grid.length === 0) return plan;
  const perRecord = new Map<number, Record<string, Cell | null>>();
  for (let dr = 0; dr < grid.length; dr++) {
    const row = grid[dr];
    const cells: Record<string, Cell | null> = {};
    for (let dc = 0; dc < row.length; dc++) {
      const f = fields[fi + dc];
      if (!f) { plan.skipped.push({ row: dr + 1, column: dc + 1, reason: "outside_fields" }); continue; }
      const v = fromText(f, row[dc], members);
      if (v === undefined) { plan.skipped.push({ row: dr + 1, column: dc + 1, reason: "invalid" }); continue; }
      cells[f.id] = v;
    }
    if (Object.keys(cells).length === 0) continue;
    const rec = records[ri + dr];
    if (rec) {
      perRecord.set(rec.id, { ...(perRecord.get(rec.id) ?? {}), ...cells });
    } else {
      plan.addRows.push({ cells });
    }
  }
  for (const [rid, cells] of perRecord) plan.patches.push({ rid, cells });
  return plan;
}

export function skippedPasteMessage(skipped: PastePlan["skipped"]): string {
  const positions = skipped.slice(0, 5).map(({ row, column }) => `第 ${row} 行第 ${column} 列`).join("、");
  return `有 ${skipped.length} 个单元格因格式不支持或超出字段范围未写入（${positions}${skipped.length > 5 ? "等" : ""}）。`;
}

/** TSV for a cell rectangle (indices into the visible grid). */
export function rangeText(records: BaseRecord[], fields: Field[], members: User[], r0: number, r1: number, f0: number, f1: number): string {
  const rows: string[][] = [];
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
    const out: string[] = [];
    for (let f = Math.min(f0, f1); f <= Math.max(f0, f1); f++) out.push(toText(fields[f], displayValue(records[r], fields[f], members), members));
    rows.push(out);
  }
  return formatTSV(rows);
}

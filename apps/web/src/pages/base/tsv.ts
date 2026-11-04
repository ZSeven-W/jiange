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
export function toText(field: Field, v: Cell | undefined): string {
  return REGISTRY[field.type].format(v, field);
}

/** Plain text → cell value; undefined means "cannot paste into this field" (skip). */
export function fromText(field: Field, text: string): Cell | null | undefined {
  return REGISTRY[field.type].parse(text, field);
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
}

/** Compute the mutations for pasting TSV at selection anchor (ri, fi).
 * Cells that cannot be represented in their field are skipped. */
export function planPaste(records: BaseRecord[], fields: Field[], ri: number, fi: number, text: string): PastePlan {
  const grid = parseTSV(text);
  const plan: PastePlan = { patches: [], addRows: [] };
  if (grid.length === 0) return plan;
  const perRecord = new Map<number, Record<string, Cell | null>>();
  for (let dr = 0; dr < grid.length; dr++) {
    const row = grid[dr];
    const cells: Record<string, Cell | null> = {};
    for (let dc = 0; dc < row.length; dc++) {
      const f = fields[fi + dc];
      if (!f) continue;
      const v = REGISTRY[f.type].parse(row[dc], f);
      if (v === undefined) continue;
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

/** TSV for a cell rectangle (indices into the visible grid). */
export function rangeText(records: BaseRecord[], fields: Field[], members: User[], r0: number, r1: number, f0: number, f1: number): string {
  const rows: string[][] = [];
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
    const out: string[] = [];
    for (let f = Math.min(f0, f1); f <= Math.max(f0, f1); f++) out.push(toText(fields[f], displayValue(records[r], fields[f], members)));
    rows.push(out);
  }
  return formatTSV(rows);
}

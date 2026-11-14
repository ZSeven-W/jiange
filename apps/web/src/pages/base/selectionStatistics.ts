import type { BaseRecord, Cell, Field } from "@/lib/api";
import { validGridSelection, type GridSelection } from "./gridSelection";

export interface SelectionStatistics { count: number; sum: number | null; average: number | null }
type CellValue = (record: BaseRecord, field: Field) => Cell | undefined;

function summarize(records: readonly BaseRecord[], fields: readonly Field[], value: CellValue): SelectionStatistics {
  let count = 0, sum = 0, numericCount = 0;
  for (const record of records) {
    for (const field of fields) {
      const cell = value(record, field);
      if (cell === undefined || cell === null || cell === "" || (Array.isArray(cell) && cell.length === 0)) continue;
      count++;
      if ((field.type === "number" || field.type === "formula" || field.type === "rating") && typeof cell === "number" && Number.isFinite(cell)) {
        numericCount++;
        sum += cell;
      }
    }
  }
  if (!Number.isFinite(sum)) return { count, sum: null, average: null };
  return { count, sum, average: numericCount ? sum / numericCount : 0 };
}

/** Summarize only the current visible rectangle. IDs and dates are not numeric measures. */
export function selectionStatistics(selection: GridSelection, records: readonly BaseRecord[], fields: readonly Field[], value: CellValue): SelectionStatistics | null {
  if (!validGridSelection(selection, records, fields)) return null;
  return summarize(records.slice(Math.min(selection.ar, selection.rr), Math.max(selection.ar, selection.rr) + 1), fields.slice(Math.min(selection.af, selection.rf), Math.max(selection.af, selection.rf) + 1), value);
}

/** Ignore selected IDs that are no longer in the current filtered projection. */
export function selectedRecordStatistics(selected: ReadonlySet<number>, records: readonly BaseRecord[], fields: readonly Field[], value: CellValue): SelectionStatistics | null {
  const rows = records.filter((record) => selected.has(record.id));
  return rows.length ? summarize(rows, fields, value) : null;
}

/** Avoid floating point noise without converting overflowing results to Infinity. */
export function formatSelectionNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(15)));
}

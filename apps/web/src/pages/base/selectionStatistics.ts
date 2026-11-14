import type { BaseRecord, Cell, Field } from "@/lib/api";
import { validGridSelection, type GridSelection } from "./gridSelection";

export interface SelectionStatistics { count: number; sum: number | null; average: number | null }

/** Summarize only the current visible rectangle. IDs and dates are not numeric measures. */
export function selectionStatistics(selection: GridSelection, records: readonly BaseRecord[], fields: readonly Field[], value: (record: BaseRecord, field: Field) => Cell | undefined): SelectionStatistics | null {
  if (!validGridSelection(selection, records, fields)) return null;
  let count = 0, sum = 0, numericCount = 0;
  for (let row = Math.min(selection.ar, selection.rr); row <= Math.max(selection.ar, selection.rr); row++) {
    for (let column = Math.min(selection.af, selection.rf); column <= Math.max(selection.af, selection.rf); column++) {
      const field = fields[column];
      const cell = value(records[row], field);
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

/** Avoid floating point noise without converting overflowing results to Infinity. */
export function formatSelectionNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(15)));
}

import type { Widths } from "./table-ops";

/** Bound conditional layout values to numbers and nulls; no text payloads. */
export function validTableWidths(raw: string): boolean {
  if (raw === "") return true;
  if (raw.length > 32000) return false;
  try {
    const values: unknown = JSON.parse(raw);
    return Array.isArray(values) && values.length <= 1000 && values.every((value) => value === null || typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100000);
  } catch { return false; }
}

/** Change one column without turning the other automatic columns into fixed ones. */
export function updatedTableWidths(raw: string, columns: number, index: number, width: number): string | null {
  if (!validTableWidths(raw) || !Number.isSafeInteger(columns) || columns < 1 || columns > 1000 || !Number.isSafeInteger(index) || index < 0 || index >= columns || !Number.isFinite(width) || width < 100 || width > 100000) return null;
  const old = raw ? JSON.parse(raw) as Widths : [];
  const next = JSON.stringify([...Array.from({ length: columns }, (_, column) => column === index ? width : old[column] ?? null), ...old.slice(columns)]);
  return validTableWidths(next) ? next : null;
}

/** Invalid collaborative or imported props must not prevent a document opening. */
export function parseTableWidths(raw: string | undefined): Widths | undefined {
  if (!raw) return undefined;
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return undefined;
    return values.map((value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100000 ? value : null);
  } catch { return undefined; }
}

/** The editor and every read-only rendering use the same visible column widths. */
export function visibleTableWidths(rows: string[][], widths?: Widths): number[] {
  const first = rows[0] ?? [];
  const longest = Math.max(0, ...first.map((cell) => typeof cell === "string" ? [...cell].length : 0));
  const automatic = Math.max(100, Math.min(260, 18 + longest * 9));
  return first.map((_, index) => {
    const width = widths?.[index];
    return typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.max(100, width) : automatic;
  });
}

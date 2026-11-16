import type { Widths } from "./table-ops";

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

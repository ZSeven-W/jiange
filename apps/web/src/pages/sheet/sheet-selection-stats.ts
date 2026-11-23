export type SheetStatKey = "sum" | "avg" | "count" | "numericCount" | "min" | "max";

export interface SheetSelectionStats {
  totalCells: number;
  count: number;
  numericCount: number;
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
}

export interface SheetSelectionBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SheetEvalLike {
  kind: string;
  value?: unknown;
  text?: string;
}

export const SHEET_STAT_META: readonly { key: SheetStatKey; label: string; shortLabel: string; numericOnly?: boolean }[] = [
  { key: "sum", label: "求和", shortLabel: "求和", numericOnly: true },
  { key: "avg", label: "平均值", shortLabel: "平均值", numericOnly: true },
  { key: "count", label: "计数", shortLabel: "计数" },
  { key: "numericCount", label: "数值计数", shortLabel: "数值计数" },
  { key: "min", label: "最小值", shortLabel: "最小值", numericOnly: true },
  { key: "max", label: "最大值", shortLabel: "最大值", numericOnly: true },
];

function cleanPrecision(n: number): number {
  return Number(n.toPrecision(12));
}

export function formatSheetStatNumber(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(n);
}

/**
 * Compute Feishu-compatible selection aggregation stats for a multi-cell range.
 * Returns null for single-cell selections or completely empty selections.
 */
export function computeSheetSelectionStats(
  bounds: SheetSelectionBounds,
  evalMap: Record<string, SheetEvalLike | undefined>,
  getRaw?: (r: number, c: number) => string | undefined,
): SheetSelectionStats | null {
  const rows = bounds.bottom - bounds.top + 1;
  const cols = bounds.right - bounds.left + 1;
  const totalCells = rows * cols;
  if (totalCells <= 1) return null;

  let count = 0;
  let numericCount = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let r = bounds.top; r <= bounds.bottom; r++) {
    for (let c = bounds.left; c <= bounds.right; c++) {
      const ev = evalMap[`${r}:${c}`];
      const raw = getRaw?.(r, c);
      const hasRaw = typeof raw === "string" && raw.trim() !== "";
      const isNonEmptyEval =
        ev !== undefined &&
        ev.kind !== "empty" &&
        !(ev.kind === "string" && String(ev.value ?? ev.text ?? "").trim() === "");

      if (isNonEmptyEval || hasRaw) {
        count++;
      }

      if (ev?.kind === "number" && typeof ev.value === "number" && Number.isFinite(ev.value)) {
        numericCount++;
        sum += ev.value;
        if (ev.value < min) min = ev.value;
        if (ev.value > max) max = ev.value;
      }
    }
  }

  if (count === 0) return null;

  return {
    totalCells,
    count,
    numericCount,
    sum: numericCount > 0 ? cleanPrecision(sum) : null,
    avg: numericCount > 0 ? cleanPrecision(sum / numericCount) : null,
    min: numericCount > 0 ? cleanPrecision(min) : null,
    max: numericCount > 0 ? cleanPrecision(max) : null,
  };
}

export function sheetStatRawValue(stats: SheetSelectionStats, key: SheetStatKey): number | null {
  return stats[key];
}

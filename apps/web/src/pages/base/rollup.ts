import type { Field } from "@/lib/api";

export type RollupAgg = "raw" | "sum" | "avg" | "count" | "min" | "max";

export const ROLLUP_OPTIONS: readonly { value: RollupAgg; label: string }[] = [
  { value: "raw", label: "原值展示" },
  { value: "sum", label: "求和" },
  { value: "avg", label: "平均值" },
  { value: "count", label: "计数" },
  { value: "min", label: "最小值" },
  { value: "max", label: "最大值" },
];

const VALID_AGGS = new Set<string>(ROLLUP_OPTIONS.map((o) => o.value));

export function isRollupAgg(value: unknown): value is RollupAgg {
  return typeof value === "string" && VALID_AGGS.has(value);
}

/** Extract linkFieldId, lookupFieldId, and cloud-persisted rollupAgg from field.options. */
export function lookupFieldConfig(field: Pick<Field, "options"> | undefined): {
  linkFieldId: number;
  lookupFieldId: number;
  rollupAgg: RollupAgg;
} {
  const linkRaw = Number(field?.options?.[0]);
  const targetRaw = Number(field?.options?.[1]);
  const aggRaw = field?.options?.[2];
  return {
    linkFieldId: Number.isSafeInteger(linkRaw) && linkRaw > 0 ? linkRaw : 0,
    lookupFieldId: Number.isSafeInteger(targetRaw) && targetRaw > 0 ? targetRaw : 0,
    rollupAgg: isRollupAgg(aggRaw) ? aggRaw : "raw",
  };
}

/** Build the cloud-persisted options array for a lookup field ([linkId, targetId] or [linkId, targetId, agg]). */
export function buildLookupOptions(
  linkFieldId: number,
  lookupFieldId: number,
  agg: RollupAgg,
): string[] {
  return agg === "raw"
    ? [String(linkFieldId), String(lookupFieldId)]
    : [String(linkFieldId), String(lookupFieldId), agg];
}

/** Resolve the configured rollup aggregation directly from field.options[2] (default "raw"). */
export function getLookupRollup(
  field: Pick<Field, "options"> | undefined,
): RollupAgg {
  const raw = field?.options?.[2];
  return isRollupAgg(raw) ? raw : "raw";
}

function parseRollupNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function roundRollup(n: number): number {
  return Number(n.toFixed(6));
}

function isNonEmptyRollupValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Pure rollup aggregation over lookup cell values.
 * - "raw": returns a shallow copy of the original values.
 * - "count": returns count of non-empty values (0 when empty).
 * - "sum" | "avg" | "min" | "max": aggregates finite numbers (and numeric strings);
 *   returns null when no numeric values are present.
 */
export function aggregateRollupValues(
  values: readonly unknown[],
  agg: RollupAgg,
): number | null | unknown[] {
  if (agg === "raw") return [...values];
  if (agg === "count") {
    let count = 0;
    for (const v of values) {
      if (isNonEmptyRollupValue(v)) count++;
    }
    return count;
  }
  const nums: number[] = [];
  for (const v of values) {
    const n = parseRollupNumber(v);
    if (n !== null) nums.push(n);
  }
  if (nums.length === 0) return null;
  switch (agg) {
    case "sum":
      return roundRollup(nums.reduce((acc, n) => acc + n, 0));
    case "avg":
      return roundRollup(nums.reduce((acc, n) => acc + n, 0) / nums.length);
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
  }
}

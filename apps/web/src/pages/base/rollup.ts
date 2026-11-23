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

export function rollupStorageKey(baseId: number): string {
  return `jiange:base:rollup:${baseId}`;
}

interface RollupStore {
  byField: Record<string, RollupAgg>;
  bySource: Record<string, RollupAgg>;
}

const EMPTY_STORE: RollupStore = { byField: {}, bySource: {} };

function readStore(baseId: number): RollupStore {
  if (!Number.isSafeInteger(baseId) || baseId <= 0 || typeof localStorage === "undefined") {
    return { byField: {}, bySource: {} };
  }
  try {
    const raw = localStorage.getItem(rollupStorageKey(baseId));
    if (!raw) return { byField: {}, bySource: {} };
    const parsed = JSON.parse(raw) as Partial<RollupStore>;
    const byField: Record<string, RollupAgg> = {};
    const bySource: Record<string, RollupAgg> = {};
    if (parsed && typeof parsed === "object") {
      if (parsed.byField && typeof parsed.byField === "object") {
        for (const [k, v] of Object.entries(parsed.byField)) {
          if (isRollupAgg(v)) byField[k] = v;
        }
      }
      if (parsed.bySource && typeof parsed.bySource === "object") {
        for (const [k, v] of Object.entries(parsed.bySource)) {
          if (isRollupAgg(v)) bySource[k] = v;
        }
      }
    }
    return { byField, bySource };
  } catch {
    return { ...EMPTY_STORE, byField: {}, bySource: {} };
  }
}

function writeStore(baseId: number, store: RollupStore): void {
  if (!Number.isSafeInteger(baseId) || baseId <= 0 || typeof localStorage === "undefined") return;
  try {
    if (!Object.keys(store.byField).length && !Object.keys(store.bySource).length) {
      localStorage.removeItem(rollupStorageKey(baseId));
    } else {
      localStorage.setItem(rollupStorageKey(baseId), JSON.stringify(store));
    }
  } catch {
    // Ignore storage quota / privacy mode failures.
  }
}

/** Extract linkFieldId and lookupFieldId encoded in a lookup field's options array. */
export function lookupFieldConfig(field: Pick<Field, "options"> | undefined): {
  linkFieldId: number;
  lookupFieldId: number;
} {
  const linkRaw = Number(field?.options?.[0]);
  const targetRaw = Number(field?.options?.[1]);
  return {
    linkFieldId: Number.isSafeInteger(linkRaw) && linkRaw > 0 ? linkRaw : 0,
    lookupFieldId: Number.isSafeInteger(targetRaw) && targetRaw > 0 ? targetRaw : 0,
  };
}

/**
 * Persist rollup aggregation metadata for a lookup field.
 * Stores by explicit fieldId (when editing) and by (linkFieldId, lookupFieldId, fieldName)
 * so newly created lookup fields pick up their chosen rollup immediately after creation.
 */
export function setLookupRollup(
  baseId: number,
  opts: {
    fieldId?: number;
    linkFieldId?: number;
    lookupFieldId?: number;
    fieldName?: string;
    agg: RollupAgg;
  },
): void {
  if (!Number.isSafeInteger(baseId) || baseId <= 0) return;
  const store = readStore(baseId);
  const { fieldId, linkFieldId, lookupFieldId, fieldName, agg } = opts;
  const normalizedName = fieldName?.trim() ?? "";

  if (fieldId && Number.isSafeInteger(fieldId) && fieldId > 0) {
    if (agg === "raw") {
      delete store.byField[String(fieldId)];
    } else {
      store.byField[String(fieldId)] = agg;
    }
  }

  if (linkFieldId && lookupFieldId && linkFieldId > 0 && lookupFieldId > 0) {
    const baseSig = `${linkFieldId}:${lookupFieldId}`;
    const namedSig = normalizedName ? `${baseSig}:${normalizedName}` : "";
    if (agg === "raw") {
      if (namedSig) delete store.bySource[namedSig];
      if (!fieldId) delete store.bySource[baseSig];
    } else {
      if (namedSig) store.bySource[namedSig] = agg;
      else store.bySource[baseSig] = agg;
    }
  }

  writeStore(baseId, store);
}

/** Remove saved rollup metadata for a field (e.g. when switching away from lookup). */
export function clearLookupRollup(baseId: number, fieldId: number): void {
  if (!Number.isSafeInteger(baseId) || baseId <= 0 || !Number.isSafeInteger(fieldId) || fieldId <= 0) return;
  const store = readStore(baseId);
  if (!(String(fieldId) in store.byField)) return;
  delete store.byField[String(fieldId)];
  writeStore(baseId, store);
}

/** Resolve the configured rollup aggregation for a lookup field. */
export function getLookupRollup(
  field: Pick<Field, "id" | "name" | "options"> | undefined,
  baseId?: number,
): RollupAgg {
  if (!field || !baseId || !Number.isSafeInteger(baseId) || baseId <= 0) return "raw";
  const store = readStore(baseId);
  const byId = store.byField[String(field.id)];
  if (byId) return byId;
  const { linkFieldId, lookupFieldId } = lookupFieldConfig(field);
  if (linkFieldId > 0 && lookupFieldId > 0) {
    const baseSig = `${linkFieldId}:${lookupFieldId}`;
    const name = field.name?.trim() ?? "";
    if (name && store.bySource[`${baseSig}:${name}`]) {
      return store.bySource[`${baseSig}:${name}`];
    }
    if (store.bySource[baseSig]) {
      return store.bySource[baseSig];
    }
  }
  return "raw";
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

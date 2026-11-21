/**
 * Headless view query, filter, sort, group, conditional fill, and selection stats engine.
 */

import type { BaseCell, BaseField, BaseRecord, FillRule, FilterRule } from "./types.js";

export interface QueryRecordsOptions {
  filters?: { conj: "and" | "or"; rules: FilterRule[] };
  sorts?: Array<{ f: number; asc: boolean }>;
  search?: string;
  groupBy?: number;
  limit?: number;
  offset?: number;
}

export interface RecordGroup {
  key: string;
  label: string;
  records: BaseRecord[];
}

export interface QueryRecordsResult {
  total: number;
  records: BaseRecord[];
  groups?: RecordGroup[];
}

export interface SelectionStats {
  count: number;
  filled: number;
  empty: number;
  unique: number;
  numericCount: number;
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  checkedCount: number;
  checkedPct: number | null;
}

export function isCellEmpty(val: BaseCell | undefined | null): boolean {
  if (val === undefined || val === null || val === "") return true;
  if (Array.isArray(val)) return val.length === 0;
  return false;
}

export function formatCellText(val: BaseCell | undefined | null): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    return val
      .map((item) => (typeof item === "object" && item !== null && "name" in item ? item.name : String(item)))
      .join(", ");
  }
  return "";
}

function toNumeric(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim() !== "") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function evaluateFilterRule(record: BaseRecord, rule: FilterRule): boolean {
  const cell = record.cells[String(rule.f)];
  const op = rule.op;

  if (op === "is_empty") return isCellEmpty(cell);
  if (op === "is_not_empty") return !isCellEmpty(cell);

  if (op === "eq") {
    if (Array.isArray(cell)) {
      if (Array.isArray(rule.v)) {
        return cell.length === rule.v.length && cell.every((v, i) => String(v) === String((rule.v as unknown[])[i]));
      }
      return cell.some((v) => String(v) === String(rule.v));
    }
    return String(cell ?? "") === String(rule.v ?? "");
  }

  if (op === "neq") {
    return !evaluateFilterRule(record, { ...rule, op: "eq" });
  }

  if (op === "contains") {
    if (Array.isArray(cell) && Array.isArray(rule.v)) {
      const set = new Set(cell.map(String));
      return rule.v.every((x) => set.has(String(x)));
    }
    return formatCellText(cell).toLowerCase().includes(String(rule.v ?? "").toLowerCase());
  }

  if (op === "not_contains") {
    return !evaluateFilterRule(record, { ...rule, op: "contains" });
  }

  if (op === "in") {
    const candidates = Array.isArray(rule.v) ? rule.v.map(String) : [String(rule.v ?? "")];
    if (Array.isArray(cell)) return cell.some((v) => candidates.includes(String(v)));
    return candidates.includes(String(cell ?? ""));
  }

  if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
    const a = toNumeric(cell);
    const b = toNumeric(rule.v);
    if (a !== null && b !== null) {
      if (op === "gt") return a > b;
      if (op === "gte") return a >= b;
      if (op === "lt") return a < b;
      return a <= b;
    }
    const sa = formatCellText(cell);
    const sb = String(rule.v ?? "");
    if (!sa) return false;
    if (op === "gt") return sa > sb;
    if (op === "gte") return sa >= sb;
    if (op === "lt") return sa < sb;
    return sa <= sb;
  }

  return true;
}

export function matchFillRule(record: BaseRecord, fills: readonly FillRule[] | undefined): number | null {
  if (!fills || fills.length === 0) return null;
  for (const rule of fills) {
    if (evaluateFilterRule(record, rule)) return rule.color;
  }
  return null;
}

function compareCells(a: BaseCell | undefined, b: BaseCell | undefined, field?: BaseField): number {
  if (field?.type === "number" || field?.type === "rating") {
    const na = toNumeric(a) ?? 0;
    const nb = toNumeric(b) ?? 0;
    return na - nb;
  }
  if (field?.type === "checkbox") {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  if (field?.type === "select" && field.options?.length) {
    const ia = field.options.indexOf(String(a));
    const ib = field.options.indexOf(String(b));
    if (ia >= 0 && ib >= 0) return ia - ib;
  }
  return formatCellText(a).localeCompare(formatCellText(b));
}

/** Query records with AND/OR filters, free-text search, multi-column sort, grouping, and pagination. */
export function queryRecords(
  records: readonly BaseRecord[],
  fields: readonly BaseField[],
  options: QueryRecordsOptions = {},
): QueryRecordsResult {
  const fieldById = new Map(fields.map((f) => [f.id, f]));
  let out = [...records];

  if (options.filters && options.filters.rules.length > 0) {
    const { conj, rules } = options.filters;
    out = out.filter((rec) =>
      conj === "or"
        ? rules.some((r) => evaluateFilterRule(rec, r))
        : rules.every((r) => evaluateFilterRule(rec, r)),
    );
  }

  const kw = options.search?.trim().toLowerCase();
  if (kw) {
    out = out.filter((rec) =>
      fields.some((f) => formatCellText(rec.cells[String(f.id)]).toLowerCase().includes(kw)),
    );
  }

  if (options.sorts && options.sorts.length > 0) {
    const sorts = options.sorts;
    out.sort((a, b) => {
      for (const s of sorts) {
        const f = fieldById.get(s.f);
        const aVal = a.cells[String(s.f)];
        const bVal = b.cells[String(s.f)];
        const emptyA = isCellEmpty(aVal);
        const emptyB = isCellEmpty(bVal);
        if (emptyA && emptyB) continue;
        if (emptyA) return 1;
        if (emptyB) return -1;
        const c = compareCells(aVal, bVal, f);
        if (c !== 0) return s.asc ? c : -c;
      }
      return a.position - b.position || a.id - b.id;
    });
  }

  const total = out.length;
  const offset = Math.max(0, options.offset ?? 0);
  const sliced = options.limit !== undefined ? out.slice(offset, offset + Math.max(0, options.limit)) : out.slice(offset);

  if (options.groupBy !== undefined) {
    const gField = fieldById.get(options.groupBy);
    const map = new Map<string, RecordGroup>();
    for (const rec of sliced) {
      const raw = rec.cells[String(options.groupBy)];
      const label = isCellEmpty(raw) ? "(Empty)" : formatCellText(raw);
      const key = isCellEmpty(raw) ? "__empty__" : label;
      let group = map.get(key);
      if (!group) {
        group = { key, label, records: [] };
        map.set(key, group);
      }
      group.records.push(rec);
    }
    const groups = [...map.values()];
    if (gField?.type === "select" && gField.options?.length) {
      const order = new Map(gField.options.map((o, idx) => [o, idx]));
      groups.sort((a, b) => {
        if (a.key === "__empty__") return 1;
        if (b.key === "__empty__") return -1;
        return (order.get(a.label) ?? 9999) - (order.get(b.label) ?? 9999);
      });
    }
    return { total, records: sliced, groups };
  }

  return { total, records: sliced };
}

/** Compute spreadsheet-style summary statistics across a selection of cells. */
export function computeSelectionStats(values: ReadonlyArray<BaseCell | undefined | null>): SelectionStats {
  const count = values.length;
  let filled = 0;
  let empty = 0;
  let numericCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let checkedCount = 0;
  let boolCount = 0;
  const uniqueSet = new Set<string>();

  for (const val of values) {
    if (isCellEmpty(val)) {
      empty++;
      continue;
    }
    filled++;
    uniqueSet.add(formatCellText(val));
    if (typeof val === "boolean") {
      boolCount++;
      if (val) checkedCount++;
    } else {
      const n = toNumeric(val);
      if (n !== null) {
        numericCount++;
        sum += n;
        if (n < min) min = n;
        if (n > max) max = n;
      }
    }
  }

  return {
    count,
    filled,
    empty,
    unique: uniqueSet.size,
    numericCount,
    sum: numericCount > 0 ? sum : null,
    avg: numericCount > 0 ? sum / numericCount : null,
    min: numericCount > 0 ? min : null,
    max: numericCount > 0 ? max : null,
    checkedCount,
    checkedPct: boolCount > 0 ? (checkedCount / count) * 100 : null,
  };
}

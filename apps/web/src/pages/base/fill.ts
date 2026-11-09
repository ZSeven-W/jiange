import type { BaseRecord, Field, FillRule, RowHeight, User } from "@/lib/api";
import { displayValue, PALETTE, REGISTRY } from "./registry";

export const ROW_HEIGHTS: Record<RowHeight, number> = { low: 32, medium: 56, high: 88, xhigh: 128 };
export const ROW_HEIGHT_LABEL: Record<RowHeight, string> = { low: "低", medium: "中等", high: "高", xhigh: "超高" };
export const rowHeightPx = (h?: RowHeight) => ROW_HEIGHTS[h ?? "low"] ?? 32;

const blank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Client-side twin of the server filter operators, used for 填色 (row fill) rules. */
export function matchRule(rec: BaseRecord, field: Field | undefined, rule: { op: string; v?: string | number | boolean }, members: User[]): boolean {
  if (!field) return false;
  const raw = displayValue(rec, field, members);
  switch (rule.op) {
    case "empty":
      return blank(raw);
    case "not_empty":
      return !blank(raw);
    case "checked":
      return raw === true;
    case "unchecked":
      return raw !== true;
  }
  if (rule.v === undefined || rule.v === "") return false;
  if (field.type === "number" || rule.op === "gt" || rule.op === "gte" || rule.op === "lt" || rule.op === "lte") {
    const a = typeof raw === "number" ? raw : field.type === "date" && typeof raw === "string" ? Date.parse(raw) : Number(raw);
    const b = field.type === "date" ? Date.parse(String(rule.v)) : Number(rule.v);
    if (blank(raw) || Number.isNaN(a) || Number.isNaN(b)) return false;
    switch (rule.op) {
      case "is": return a === b;
      case "is_not": return a !== b;
      case "gt": return a > b;
      case "gte": return a >= b;
      case "lt": return a < b;
      case "lte": return a <= b;
    }
  }
  const text = REGISTRY[field.type].format(raw, field).toLowerCase();
  const want = String(rule.v).toLowerCase();
  const values = Array.isArray(raw) ? raw.map((x) => String(x).toLowerCase()) : [text];
  switch (rule.op) {
    case "contains": return text.includes(want);
    case "not_contains": return !text.includes(want);
    case "is": return values.includes(want) || (field.type === "date" && text.slice(0, 10) === want.slice(0, 10));
    case "is_not": return !values.includes(want);
  }
  return false;
}

/** Background colour for a record from the first matching fill rule, or undefined. */
export function rowFill(rec: BaseRecord, fields: Field[], rules: FillRule[] | undefined, members: User[]): string | undefined {
  for (const rule of rules ?? []) {
    if (matchRule(rec, fields.find((f) => f.id === rule.f), rule, members)) return PALETTE[((rule.color % PALETTE.length) + PALETTE.length) % PALETTE.length][0];
  }
  return undefined;
}

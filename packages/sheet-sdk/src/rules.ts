import { sheetAddress } from "./grid.js";
import type {
  EvalValue,
  SheetCondFormatOp,
  SheetConditionalFormat,
  SheetDataValidation,
  SheetProtectedRange,
  SheetRect,
} from "./types.js";

export interface ValidationEvalResult {
  valid: boolean;
  strict: boolean;
  message: string;
  rule?: SheetDataValidation;
}

export interface CondFormatStyle {
  bg?: string;
  color?: string;
  bold?: boolean;
}

export interface CondFormatPreset {
  id: string;
  label: string;
  bg: string;
  color: string;
  bold?: boolean;
}

export const COND_FMT_PRESETS: CondFormatPreset[] = [
  { id: "red", label: "浅红预警", bg: "#fee2e2", color: "#991b1b", bold: true },
  { id: "green", label: "浅绿达标", bg: "#dcfce7", color: "#166534", bold: true },
  { id: "amber", label: "浅黄提醒", bg: "#fef3c7", color: "#92400e", bold: false },
  { id: "blue", label: "浅蓝强调", bg: "#dbeafe", color: "#1e40af", bold: false },
  { id: "slate", label: "深灰加粗", bg: "#f3f4f6", color: "#111827", bold: true },
];

export const COND_FMT_OPS: { op: SheetCondFormatOp; label: string; needsValue1: boolean; needsValue2: boolean }[] = [
  { op: "gt", label: "大于", needsValue1: true, needsValue2: false },
  { op: "gte", label: "大于等于", needsValue1: true, needsValue2: false },
  { op: "lt", label: "小于", needsValue1: true, needsValue2: false },
  { op: "lte", label: "小于等于", needsValue1: true, needsValue2: false },
  { op: "eq", label: "等于", needsValue1: true, needsValue2: false },
  { op: "neq", label: "不等于", needsValue1: true, needsValue2: false },
  { op: "between", label: "介于", needsValue1: true, needsValue2: true },
  { op: "contains", label: "包含文本", needsValue1: true, needsValue2: false },
  { op: "empty", label: "为空", needsValue1: false, needsValue2: false },
  { op: "not_empty", label: "非空", needsValue1: false, needsValue2: false },
];

export function pointInSheetRect(row: number, col: number, rect: SheetRect): boolean {
  return row >= rect.top && row <= rect.bottom && col >= rect.left && col <= rect.right;
}

export function formatSheetRectA1(rect: SheetRect): string {
  const start = sheetAddress({ row: rect.top, col: rect.left });
  if (rect.top === rect.bottom && rect.left === rect.right) return start;
  return `${start}:${sheetAddress({ row: rect.bottom, col: rect.right })}`;
}

export function makeRuleId(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}

function parseStrictIsoDate(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return dt.getTime();
}

function parseFiniteNum(raw: string): number | null {
  if (!raw.trim()) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

export function findSheetDropdown(
  rules: readonly SheetDataValidation[] | undefined,
  row: number,
  col: number,
): SheetDataValidation | null {
  if (!rules || rules.length === 0) return null;
  for (const r of rules) {
    if (r.type === "list" && r.options && r.options.length > 0 && pointInSheetRect(row, col, r)) {
      return r;
    }
  }
  return null;
}

export function evaluateSheetValidation(
  raw: string,
  rules: readonly SheetDataValidation[] | undefined,
  row: number,
  col: number,
): ValidationEvalResult {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("=") || !rules || rules.length === 0) {
    return { valid: true, strict: false, message: "" };
  }
  let warningResult: ValidationEvalResult | null = null;
  for (const r of rules) {
    if (!pointInSheetRect(row, col, r)) continue;
    let ok = true;
    let fallbackMsg = "单元格内容不符合数据验证规则";
    if (r.type === "list") {
      const opts = r.options ?? [];
      ok = opts.includes(trimmed);
      fallbackMsg = `仅允许选择：${opts.join(" / ")}`;
    } else if (r.type === "number") {
      const v = parseFiniteNum(trimmed);
      if (v === null) {
        ok = false;
      } else {
        const minV = r.min ? parseFiniteNum(r.min) : null;
        const maxV = r.max ? parseFiniteNum(r.max) : null;
        if (minV !== null && v < minV) ok = false;
        if (maxV !== null && v > maxV) ok = false;
      }
      if (r.min && r.max) fallbackMsg = `请输入 ${r.min} 至 ${r.max} 之间的数字`;
      else if (r.min) fallbackMsg = `请输入不小于 ${r.min} 的数字`;
      else if (r.max) fallbackMsg = `请输入不大于 ${r.max} 的数字`;
      else fallbackMsg = "请输入有效数字";
    } else if (r.type === "date") {
      const ts = parseStrictIsoDate(trimmed);
      if (ts === null) {
        ok = false;
      } else {
        const minTs = r.min ? parseStrictIsoDate(r.min) : null;
        const maxTs = r.max ? parseStrictIsoDate(r.max) : null;
        if (minTs !== null && ts < minTs) ok = false;
        if (maxTs !== null && ts > maxTs) ok = false;
      }
      if (r.min && r.max) fallbackMsg = `请输入 ${r.min} 至 ${r.max} 之间的日期 (YYYY-MM-DD)`;
      else if (r.min) fallbackMsg = `请输入不早于 ${r.min} 的日期 (YYYY-MM-DD)`;
      else if (r.max) fallbackMsg = `请输入不晚于 ${r.max} 的日期 (YYYY-MM-DD)`;
      else fallbackMsg = "请输入有效日期 (YYYY-MM-DD)";
    }
    if (!ok) {
      const res: ValidationEvalResult = {
        valid: false,
        strict: r.strict,
        message: r.hint?.trim() || fallbackMsg,
        rule: r,
      };
      if (r.strict) return res;
      if (!warningResult) warningResult = res;
    }
  }
  return warningResult ?? { valid: true, strict: false, message: "" };
}

function evaluatedTextAndNumber(raw: string, ev: EvalValue | undefined): { text: string; num: number | null; empty: boolean } {
  if (ev) {
    if (ev.kind === "empty") return { text: "", num: null, empty: true };
    if (ev.kind === "number") return { text: String(ev.value), num: ev.value, empty: false };
    if (ev.kind === "boolean") return { text: ev.value ? "TRUE" : "FALSE", num: null, empty: false };
    if (ev.kind === "error") return { text: ev.value, num: null, empty: false };
    if (ev.kind === "array") return evaluatedTextAndNumber(raw, ev.value[0]?.[0]);
    const t = ev.value.trim();
    return { text: t, num: parseFiniteNum(t), empty: t === "" };
  }
  const t = raw.trim();
  return { text: t, num: parseFiniteNum(t), empty: t === "" };
}

export function evaluateSheetConditionalFormat(
  raw: string,
  ev: EvalValue | undefined,
  rules: readonly SheetConditionalFormat[] | undefined,
  row: number,
  col: number,
): CondFormatStyle | null {
  if (!rules || rules.length === 0) return null;
  let anyMatched = false;
  let outBg: string | undefined;
  let outColor: string | undefined;
  let outBold: boolean | undefined;
  let cached: { text: string; num: number | null; empty: boolean } | null = null;

  for (const r of rules) {
    if (!pointInSheetRect(row, col, r)) continue;
    if (!cached) cached = evaluatedTextAndNumber(raw, ev);
    const { text, num, empty } = cached;
    const v1 = (r.value1 ?? "").trim();
    const v2 = (r.value2 ?? "").trim();
    let matched = false;

    switch (r.op) {
      case "empty":
        matched = empty;
        break;
      case "not_empty":
        matched = !empty;
        break;
      case "contains":
        matched = !empty && v1 !== "" && text.toLowerCase().includes(v1.toLowerCase());
        break;
      case "eq": {
        const n1 = parseFiniteNum(v1);
        if (num !== null && n1 !== null) matched = num === n1;
        else matched = text.toLowerCase() === v1.toLowerCase();
        break;
      }
      case "neq": {
        const n1 = parseFiniteNum(v1);
        if (num !== null && n1 !== null) matched = num !== n1;
        else matched = !empty && text.toLowerCase() !== v1.toLowerCase();
        break;
      }
      case "gt": {
        const n1 = parseFiniteNum(v1);
        matched = num !== null && n1 !== null && num > n1;
        break;
      }
      case "gte": {
        const n1 = parseFiniteNum(v1);
        matched = num !== null && n1 !== null && num >= n1;
        break;
      }
      case "lt": {
        const n1 = parseFiniteNum(v1);
        matched = num !== null && n1 !== null && num < n1;
        break;
      }
      case "lte": {
        const n1 = parseFiniteNum(v1);
        matched = num !== null && n1 !== null && num <= n1;
        break;
      }
      case "between": {
        const n1 = parseFiniteNum(v1);
        const n2 = parseFiniteNum(v2);
        if (num !== null && n1 !== null && n2 !== null) {
          const lo = Math.min(n1, n2);
          const hi = Math.max(n1, n2);
          matched = num >= lo && num <= hi;
        }
        break;
      }
    }

    if (matched) {
      anyMatched = true;
      if (r.bg) outBg = r.bg;
      if (r.color) outColor = r.color;
      if (r.bold) outBold = true;
    }
  }
  return anyMatched ? { bg: outBg, color: outColor, bold: outBold } : null;
}

export function isSheetCellProtected(
  rules: readonly SheetProtectedRange[] | undefined,
  row: number,
  col: number,
  userId: number,
  role: string,
): { protected: boolean; blocked: boolean; rule?: SheetProtectedRange } {
  if (!rules || rules.length === 0) return { protected: false, blocked: false };
  let firstMatch: SheetProtectedRange | undefined;
  for (const r of rules) {
    if (!pointInSheetRect(row, col, r)) continue;
    if (!firstMatch) firstMatch = r;
    if (role !== "manage" && !(r.allowedUserIds ?? []).includes(userId)) {
      return { protected: true, blocked: true, rule: r };
    }
  }
  return { protected: !!firstMatch, blocked: false, rule: firstMatch };
}

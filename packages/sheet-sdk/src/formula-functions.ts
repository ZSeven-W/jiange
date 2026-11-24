import type { FormulaAst, RangeRefNode } from "./formula-ast.js";
import { evaluateQuery } from "./formula-query.js";
import { dateToSerial, formatExcelNumber, parseDateToSerial, serialToDate } from "./numfmt.js";
import type { EvalValue } from "./types.js";

export const EMPTY_VAL: EvalValue = { kind: "empty", value: "" };
export const errVal = (code: string): EvalValue => ({ kind: "error", value: code, error: code });
export const numVal = (n: number): EvalValue => (Number.isFinite(n) ? { kind: "number", value: n === 0 ? 0 : n } : errVal("#NUM!"));
export const strVal = (s: string): EvalValue => ({ kind: "string", value: s });
export const boolVal = (b: boolean): EvalValue => ({ kind: "boolean", value: b });
export const arrVal = (rows: EvalValue[][]): EvalValue => ({ kind: "array", value: rows });
export const imgVal = (url: string, alt?: string, mode = 1): EvalValue => ({
  kind: "image",
  value: alt && alt.length > 0 ? alt : url,
  url,
  ...(alt !== undefined ? { alt } : {}),
  mode,
});

/** Internal first-class callable produced by LAMBDA(...). Never escapes evalCell uninvoked (#CALC!). */
export interface LambdaEvalValue {
  readonly kind: "lambda";
  readonly value: "#CALC!";
  readonly error?: undefined;
  readonly params: readonly string[];
  readonly body: FormulaAst;
  readonly env: ReadonlyMap<string, EvalValue>;
  readonly sheetId: number;
}

export function isLambdaVal(v: unknown): v is LambdaEvalValue {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "lambda";
}

/** Validate safe URL schemes allowed by =IMAGE(...) and the Sheet cell image renderer. */
export function isSafeSheetImageUrl(raw: string): boolean {
  const url = raw.trim();
  if (!url || url.length > 4096) return false;
  if (/[\u0000-\u001f\u007f]/.test(url)) return false;
  if (url.startsWith("/api/files/") || url.startsWith("/api/drive/files/")) {
    if (url.includes("..") || url.startsWith("//")) return false;
    return /^\/api\/(?:drive\/)?files\/[A-Za-z0-9_./-]+(?:\?[A-Za-z0-9_=&%.-]*)?$/.test(url);
  }
  if (/^data:image\//i.test(url)) {
    return /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif|svg\+xml)(?:;charset=[A-Za-z0-9_-]+)?;base64,[A-Za-z0-9+/=]+$/i.test(url);
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  return false;
}

const MAX_REGEX_LENGTH = 512;

function hasNestedQuantifier(pattern: string): boolean {
  const stack: boolean[] = [];
  let inCharClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") { i++; continue; }
    if (inCharClass) {
      if (ch === "]") inCharClass = false;
      continue;
    }
    if (ch === "[") { inCharClass = true; continue; }
    if (ch === "(") { stack.push(false); continue; }
    if (ch === ")") {
      const innerHadQuantifier = stack.pop() ?? false;
      const next = pattern[i + 1];
      const followedByQuantifier = next === "+" || next === "*" || next === "{";
      if (innerHadQuantifier && followedByQuantifier) return true;
      if ((innerHadQuantifier || followedByQuantifier) && stack.length > 0) {
        stack[stack.length - 1] = true;
      }
      continue;
    }
    if (ch === "+" || ch === "*" || ch === "{") {
      if (stack.length > 0) stack[stack.length - 1] = true;
    }
  }
  return false;
}

function compileSafeRegex(pattern: string, flags = ""): RegExp | null {
  if (pattern.length > MAX_REGEX_LENGTH) return null;
  if (hasNestedQuantifier(pattern)) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export interface ResolvedRange {
  sheetId: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface FormulaEvalContext {
  sheetId: number;
  row: number;
  col: number;
  evalAst(node: FormulaAst): EvalValue;
  evalAstWithEnv?(node: FormulaAst, env: ReadonlyMap<string, EvalValue>, arrayMode?: boolean): EvalValue;
  getEnv?(): ReadonlyMap<string, EvalValue>;
  arrayMode?: boolean;
  resolveRange(node: RangeRefNode): ResolvedRange | null;
  resolveCellRef(node: FormulaAst): { sheetId: number; row: number; col: number } | null;
  readCell(sheetId: number, row: number, col: number): EvalValue;
  readRawCell(sheetId: number, row: number, col: number): string;
  readMatrix(node: FormulaAst): EvalValue[][] | EvalValue;
  parseAndResolveRef(refText: string): ResolvedRange | { sheetId: number; row: number; col: number } | null;
  sheetBounds(sheetId: number): { rows: number; cols: number } | null;
  tickOp(): boolean;
}

export type FormulaFunction = (args: readonly FormulaAst[], ctx: FormulaEvalContext) => EvalValue;
export type CustomFormulaFunction = (args: EvalValue[], meta: { sheetId: number; row: number; col: number }) => EvalValue | number | string | boolean | null | undefined;

export type ScalarEvalValue = Exclude<EvalValue, { kind: "array" }>;

export function unwrapScalar(v: EvalValue): ScalarEvalValue {
  if (isLambdaVal(v)) return { kind: "error", value: "#CALC!", error: "#CALC!" };
  if (v.kind === "array") {
    const first = v.value[0]?.[0];
    return first ? unwrapScalar(first) : { kind: "empty", value: "" };
  }
  return v;
}

export function isMissingArg(node: FormulaAst | undefined): boolean {
  return !node || (node.kind === "error" && node.code === "__MISSING__");
}

export function toNumber(raw: EvalValue): number | EvalValue {
  const v = unwrapScalar(raw);
  if (v.kind === "error") return v;
  if (v.kind === "image") return errVal("#VALUE!");
  if (v.kind === "empty") return 0;
  if (v.kind === "number") return v.value;
  if (v.kind === "boolean") return v.value ? 1 : 0;
  const trimmed = v.value.trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) return parsed;
  const dateSerial = parseDateToSerial(trimmed);
  if (dateSerial !== null) return dateSerial;
  return errVal("#VALUE!");
}

export function toBoolean(raw: EvalValue): boolean | EvalValue {
  const v = unwrapScalar(raw);
  if (v.kind === "error") return v;
  if (v.kind === "image") return errVal("#VALUE!");
  if (v.kind === "empty") return false;
  if (v.kind === "boolean") return v.value;
  if (v.kind === "number") return v.value !== 0;
  const up = v.value.trim().toUpperCase();
  if (up === "TRUE") return true;
  if (up === "FALSE") return false;
  return errVal("#VALUE!");
}

export function toStringValue(raw: EvalValue): string {
  const v = unwrapScalar(raw);
  if (v.kind === "empty") return "";
  if (v.kind === "boolean") return v.value ? "TRUE" : "FALSE";
  if (v.kind === "error") return v.error;
  return String(v.value);
}

export function compareValues(rawA: EvalValue, rawB: EvalValue): number {
  const a = unwrapScalar(rawA);
  const b = unwrapScalar(rawB);
  if (a.kind === "empty" && b.kind === "empty") return 0;
  if (a.kind === "empty") return b.kind === "number" ? -Math.sign(b.value) : b.kind === "boolean" ? -1 : "".localeCompare(toStringValue(b));
  if (b.kind === "empty") return a.kind === "number" ? Math.sign(a.value) : a.kind === "boolean" ? 1 : toStringValue(a).localeCompare("");
  if (a.kind === "number" && b.kind === "number") return a.value - b.value;
  if (a.kind === "boolean" && b.kind === "boolean") return Number(a.value) - Number(b.value);
  return toStringValue(a).toLowerCase().localeCompare(toStringValue(b).toLowerCase());
}

function wildcardToRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length) {
      out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out, "i");
}

export function matchCriteria(cellRaw: EvalValue, criteriaRaw: EvalValue): boolean {
  const cell = unwrapScalar(cellRaw);
  const criteria = unwrapScalar(criteriaRaw);
  if (cell.kind === "error" || criteria.kind === "error") return false;
  if (criteria.kind === "empty") return cell.kind === "empty";
  const critStr = toStringValue(criteria);
  const opMatch = /^(>=|<=|<>|>|<|=)(.*)$/.exec(critStr);
  if (opMatch) {
    const op = opMatch[1];
    const rhsRaw = opMatch[2].trim();
    if (rhsRaw === "") {
      const isEmpty = cell.kind === "empty" || (cell.kind === "string" && cell.value === "");
      return op === "=" ? isEmpty : op === "<>" ? !isEmpty : false;
    }
    const rhsNum = Number.isFinite(Number(rhsRaw)) ? Number(rhsRaw) : null;
    const lhsNum = cell.kind === "number" ? cell.value : null;
    if (rhsNum !== null && lhsNum !== null) {
      if (op === ">=") return lhsNum >= rhsNum;
      if (op === "<=") return lhsNum <= rhsNum;
      if (op === "<>") return lhsNum !== rhsNum;
      if (op === ">") return lhsNum > rhsNum;
      if (op === "<") return lhsNum < rhsNum;
      return lhsNum === rhsNum;
    }
    if ((op === "=" || op === "<>") && (rhsRaw.includes("*") || rhsRaw.includes("?"))) {
      const matched = wildcardToRegex(rhsRaw).test(toStringValue(cell));
      return op === "=" ? matched : !matched;
    }
    const cmp = toStringValue(cell).toLowerCase().localeCompare(rhsRaw.toLowerCase());
    if (op === ">=") return cmp >= 0;
    if (op === "<=") return cmp <= 0;
    if (op === "<>") return cmp !== 0;
    if (op === ">") return cmp > 0;
    if (op === "<") return cmp < 0;
    return cmp === 0;
  }
  if (cell.kind === "number" && criteria.kind === "number") return cell.value === criteria.value;
  if (criteria.kind === "string" && (critStr.includes("*") || critStr.includes("?"))) {
    return wildcardToRegex(critStr).test(toStringValue(cell));
  }
  return toStringValue(cell).toLowerCase() === critStr.toLowerCase();
}

function collectValues(args: readonly FormulaAst[], ctx: FormulaEvalContext, mode: "numbers" | "nonempty" | "all"): EvalValue[] | EvalValue {
  const out: EvalValue[] = [];
  for (const arg of args) {
    if (isMissingArg(arg)) continue;
    if (arg.kind === "range" || arg.kind === "array") {
      const mat = ctx.readMatrix(arg);
      if (!Array.isArray(mat)) return mat;
      for (const row of mat) {
        for (const v of row) {
          if (v.kind === "error") return v;
          if (mode === "numbers") {
            if (v.kind === "number") out.push(v);
          } else if (mode === "nonempty") {
            if (v.kind !== "empty") out.push(v);
          } else {
            out.push(v);
          }
        }
      }
    } else {
      const v = ctx.evalAst(arg);
      if (v.kind === "array") {
        for (const row of v.value) {
          for (const item of row) {
            if (item.kind === "error") return item;
            if (mode === "numbers") { if (item.kind === "number") out.push(item); }
            else if (mode === "nonempty") { if (item.kind !== "empty") out.push(item); }
            else out.push(item);
          }
        }
      } else {
        if (v.kind === "error") return v;
        if (mode === "numbers") {
          const n = toNumber(v);
          if (typeof n !== "number") return n;
          out.push(numVal(n));
        } else if (mode === "nonempty") {
          if (v.kind !== "empty") out.push(v);
        } else {
          out.push(v);
        }
      }
    }
  }
  return out;
}

function collectNumbers(args: readonly FormulaAst[], ctx: FormulaEvalContext): number[] | EvalValue {
  const vals = collectValues(args, ctx, "numbers");
  if (!Array.isArray(vals)) return vals;
  return vals.map((v) => (v.kind === "number" ? v.value : 0));
}

function evalNumArg(arg: FormulaAst | undefined, ctx: FormulaEvalContext, fallback?: number): number | EvalValue {
  if (isMissingArg(arg)) return fallback !== undefined ? fallback : errVal("#VALUE!");
  return toNumber(ctx.evalAst(arg!));
}

function evalStrArg(arg: FormulaAst | undefined, ctx: FormulaEvalContext): string | EvalValue {
  if (isMissingArg(arg)) return errVal("#VALUE!");
  const v = unwrapScalar(ctx.evalAst(arg!));
  if (v.kind === "error") return v;
  return toStringValue(v);
}

function getMatrix(arg: FormulaAst, ctx: FormulaEvalContext): EvalValue[][] | EvalValue {
  return ctx.readMatrix(arg);
}

function flattenMatrix(mat: EvalValue[][]): EvalValue[] {
  const out: EvalValue[] = [];
  for (const row of mat) for (const item of row) out.push(item);
  return out;
}

function evalDateParts(serial: number): { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number } {
  const dt = serialToDate(serial);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    hh: dt.getUTCHours(),
    mm: dt.getUTCMinutes(),
    ss: dt.getUTCSeconds(),
    dow: dt.getUTCDay(),
  };
}

function evalConditionalAgg(
  fn: "SUMIFS" | "COUNTIFS" | "AVERAGEIFS" | "MAXIFS" | "MINIFS",
  args: readonly FormulaAst[],
  ctx: FormulaEvalContext,
): EvalValue {
  const hasTarget = fn !== "COUNTIFS";
  const minArgs = hasTarget ? 3 : 2;
  if (args.length < minArgs || (hasTarget ? (args.length - 1) % 2 !== 0 : args.length % 2 !== 0)) {
    return errVal("#VALUE!");
  }
  const targetMat = hasTarget ? getMatrix(args[0], ctx) : null;
  if (targetMat && !Array.isArray(targetMat)) return targetMat;

  const pairs: { mat: EvalValue[][]; crit: EvalValue }[] = [];
  for (let i = hasTarget ? 1 : 0; i < args.length; i += 2) {
    const mat = getMatrix(args[i], ctx);
    if (!Array.isArray(mat)) return mat;
    const crit = unwrapScalar(ctx.evalAst(args[i + 1]));
    if (crit.kind === "error") return crit;
    pairs.push({ mat, crit });
  }
  const h = targetMat ? targetMat.length : pairs[0].mat.length;
  const w = targetMat ? (targetMat[0]?.length ?? 0) : (pairs[0].mat[0]?.length ?? 0);
  for (const p of pairs) {
    if (p.mat.length !== h || (p.mat[0]?.length ?? 0) !== w) return errVal("#VALUE!");
  }

  let count = 0;
  let sum = 0;
  let numCount = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!ctx.tickOp()) return errVal("#LIMIT!");
      let allMatch = true;
      for (const p of pairs) {
        if (!matchCriteria(p.mat[r][c], p.crit)) { allMatch = false; break; }
      }
      if (!allMatch) continue;
      count++;
      if (targetMat) {
        const tv = targetMat[r][c];
        if (tv.kind === "error") return tv;
        if (tv.kind === "number") {
          sum += tv.value;
          numCount++;
          if (tv.value < min) min = tv.value;
          if (tv.value > max) max = tv.value;
        }
      }
    }
  }
  if (fn === "COUNTIFS") return numVal(count);
  if (fn === "SUMIFS") return numVal(sum);
  if (fn === "AVERAGEIFS") return numCount ? numVal(sum / numCount) : errVal("#DIV/0!");
  if (fn === "MINIFS") return numCount ? numVal(min) : numVal(0);
  return numCount ? numVal(max) : numVal(0);
}

function evalSingleCondAgg(fn: "COUNTIF" | "SUMIF" | "AVERAGEIF", args: readonly FormulaAst[], ctx: FormulaEvalContext): EvalValue {
  if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
  if (fn === "COUNTIF") return evalConditionalAgg("COUNTIFS", [args[0], args[1]], ctx);
  const sumArg = args[2] && !isMissingArg(args[2]) ? args[2] : args[0];
  return evalConditionalAgg(fn === "SUMIF" ? "SUMIFS" : "AVERAGEIFS", [sumArg, args[0], args[1]], ctx);
}

function percentileSorted(sorted: number[], k: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = k * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function roundTo(n: number, digits: number, mode: "round" | "up" | "down"): number {
  const factor = 10 ** Math.trunc(digits);
  const scaled = n * factor;
  if (mode === "round") return Math.round(scaled) / factor;
  if (mode === "up") return (scaled >= 0 ? Math.ceil(scaled) : Math.floor(scaled)) / factor;
  return Math.trunc(scaled) / factor;
}

function pmtCalc(rate: number, nper: number, pv: number, fv = 0, type = 0): number {
  if (rate === 0) return -(pv + fv) / nper;
  const pvif = (1 + rate) ** nper;
  const pmt = (rate / (pvif - 1)) * -(pv * pvif + fv);
  return type ? pmt / (1 + rate) : pmt;
}

function pvCalc(rate: number, nper: number, pmt: number, fv = 0, type = 0): number {
  if (rate === 0) return -(pmt * nper + fv);
  const factor = (1 + rate) ** nper;
  const adj = type ? 1 + rate : 1;
  return -(fv + pmt * adj * ((factor - 1) / rate)) / factor;
}

function fvCalc(rate: number, nper: number, pmt: number, pv = 0, type = 0): number {
  if (rate === 0) return -(pv + pmt * nper);
  const factor = (1 + rate) ** nper;
  const adj = type ? 1 + rate : 1;
  return -(pv * factor + pmt * adj * ((factor - 1) / rate));
}

function irrCalc(cashflows: number[], guess = 0.1): number | null {
  let rate = guess;
  for (let iter = 0; iter < 100; iter++) {
    let npv = 0;
    let dnpv = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const denom = (1 + rate) ** t;
      if (!Number.isFinite(denom) || denom === 0) return null;
      npv += cashflows[t] / denom;
      if (t > 0) dnpv -= (t * cashflows[t]) / ((1 + rate) ** (t + 1));
    }
    if (Math.abs(npv) < 1e-7) return rate;
    if (Math.abs(dnpv) < 1e-12) return null;
    rate -= npv / dnpv;
    if (!Number.isFinite(rate) || rate <= -1) return null;
  }
  return null;
}

function workdayCalc(startSerial: number, days: number, holidays: Set<number>): number {
  let cur = Math.trunc(startSerial);
  let rem = Math.trunc(days);
  const step = rem >= 0 ? 1 : -1;
  rem = Math.abs(rem);
  while (rem > 0) {
    cur += step;
    const dow = evalDateParts(cur).dow;
    if (dow !== 0 && dow !== 6 && !holidays.has(cur)) rem--;
  }
  return cur;
}

function networkdaysCalc(startSerial: number, endSerial: number, holidays: Set<number>): number {
  const s = Math.trunc(startSerial);
  const e = Math.trunc(endSerial);
  const sign = s <= e ? 1 : -1;
  const lo = Math.min(s, e);
  const hi = Math.max(s, e);
  let count = 0;
  for (let d = lo; d <= hi; d++) {
    const dow = evalDateParts(d).dow;
    if (dow !== 0 && dow !== 6 && !holidays.has(d)) count++;
  }
  return sign * count;
}

export const BUILTIN_FUNCTIONS: Record<string, FormulaFunction> = {
  // ---- Basic & Statistical Aggregations ----
  SUM: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    return Array.isArray(nums) ? numVal(nums.reduce((a, b) => a + b, 0)) : nums;
  },
  AVERAGE: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    if (!Array.isArray(nums)) return nums;
    return nums.length ? numVal(nums.reduce((a, b) => a + b, 0) / nums.length) : errVal("#DIV/0!");
  },
  MIN: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    return Array.isArray(nums) ? numVal(nums.length ? Math.min(...nums) : 0) : nums;
  },
  MAX: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    return Array.isArray(nums) ? numVal(nums.length ? Math.max(...nums) : 0) : nums;
  },
  COUNT: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    return Array.isArray(nums) ? numVal(nums.length) : nums;
  },
  COUNTA: (args, ctx) => {
    const vals = collectValues(args, ctx, "nonempty");
    return Array.isArray(vals) ? numVal(vals.length) : vals;
  },
  COUNTBLANK: (args, ctx) => {
    const vals = collectValues(args, ctx, "all");
    if (!Array.isArray(vals)) return vals;
    return numVal(vals.filter((v) => v.kind === "empty" || (v.kind === "string" && v.value === "")).length);
  },
  PRODUCT: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    if (!Array.isArray(nums)) return nums;
    return numVal(nums.length ? nums.reduce((a, b) => a * b, 1) : 0);
  },
  MEDIAN: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    if (!Array.isArray(nums)) return nums;
    if (!nums.length) return errVal("#NUM!");
    nums.sort((a, b) => a - b);
    const mid = Math.floor(nums.length / 2);
    return numVal(nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2);
  },
  MODE: (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    if (!Array.isArray(nums)) return nums;
    const freq = new Map<number, number>();
    let bestNum = 0;
    let bestCount = 1;
    for (const n of nums) {
      const c = (freq.get(n) ?? 0) + 1;
      freq.set(n, c);
      if (c > bestCount) { bestCount = c; bestNum = n; }
    }
    return bestCount > 1 ? numVal(bestNum) : errVal("#N/A");
  },
  STDEV: (args, ctx) => BUILTIN_FUNCTIONS["STDEV.S"](args, ctx),
  "STDEV.S": (args, ctx) => {
    const v = BUILTIN_FUNCTIONS["VAR.S"](args, ctx);
    return v.kind === "number" ? numVal(Math.sqrt(v.value)) : v;
  },
  "STDEV.P": (args, ctx) => {
    const v = BUILTIN_FUNCTIONS["VAR.P"](args, ctx);
    return v.kind === "number" ? numVal(Math.sqrt(v.value)) : v;
  },
  "VAR.S": (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    if (!Array.isArray(nums)) return nums;
    if (nums.length < 2) return errVal("#DIV/0!");
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    return numVal(nums.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (nums.length - 1));
  },
  "VAR.P": (args, ctx) => {
    const nums = collectNumbers(args, ctx);
    if (!Array.isArray(nums)) return nums;
    if (!nums.length) return errVal("#DIV/0!");
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    return numVal(nums.reduce((acc, x) => acc + (x - mean) ** 2, 0) / nums.length);
  },
  PERCENTILE: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const nums = collectNumbers([args[0]], ctx);
    if (!Array.isArray(nums)) return nums;
    const k = evalNumArg(args[1], ctx);
    if (typeof k !== "number") return k;
    if (!nums.length || k < 0 || k > 1) return errVal("#NUM!");
    nums.sort((a, b) => a - b);
    return numVal(percentileSorted(nums, k));
  },
  QUARTILE: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const nums = collectNumbers([args[0]], ctx);
    if (!Array.isArray(nums)) return nums;
    const q = evalNumArg(args[1], ctx);
    if (typeof q !== "number") return q;
    const qi = Math.trunc(q);
    if (!nums.length || qi < 0 || qi > 4) return errVal("#NUM!");
    nums.sort((a, b) => a - b);
    return numVal(percentileSorted(nums, qi / 4));
  },
  LARGE: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const nums = collectNumbers([args[0]], ctx);
    if (!Array.isArray(nums)) return nums;
    const k = evalNumArg(args[1], ctx);
    if (typeof k !== "number") return k;
    const ki = Math.trunc(k);
    if (ki < 1 || ki > nums.length) return errVal("#NUM!");
    nums.sort((a, b) => b - a);
    return numVal(nums[ki - 1]);
  },
  SMALL: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const nums = collectNumbers([args[0]], ctx);
    if (!Array.isArray(nums)) return nums;
    const k = evalNumArg(args[1], ctx);
    if (typeof k !== "number") return k;
    const ki = Math.trunc(k);
    if (ki < 1 || ki > nums.length) return errVal("#NUM!");
    nums.sort((a, b) => a - b);
    return numVal(nums[ki - 1]);
  },
  RANK: (args, ctx) => {
    if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
    const x = evalNumArg(args[0], ctx);
    if (typeof x !== "number") return x;
    const nums = collectNumbers([args[1]], ctx);
    if (!Array.isArray(nums)) return nums;
    const order = args[2] ? evalNumArg(args[2], ctx, 0) : 0;
    if (typeof order !== "number") return order;
    if (!nums.includes(x)) return errVal("#N/A");
    const rank = 1 + nums.filter((n) => (order === 0 ? n > x : n < x)).length;
    return numVal(rank);
  },
  SUMPRODUCT: (args, ctx) => {
    if (!args.length) return errVal("#VALUE!");
    const mats: EvalValue[][][] = [];
    for (const arg of args) {
      const m = getMatrix(arg, ctx);
      if (!Array.isArray(m)) return m;
      mats.push(m);
    }
    const h = mats[0].length;
    const w = mats[0][0]?.length ?? 0;
    for (const m of mats) if (m.length !== h || (m[0]?.length ?? 0) !== w) return errVal("#VALUE!");
    let total = 0;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        let prod = 1;
        for (const m of mats) {
          const cell = m[r][c];
          if (cell.kind === "error") return cell;
          prod *= cell.kind === "number" ? cell.value : cell.kind === "boolean" ? (cell.value ? 1 : 0) : 0;
        }
        total += prod;
      }
    }
    return numVal(total);
  },
  SUBTOTAL: (args, ctx) => {
    if (args.length < 2) return errVal("#VALUE!");
    const code = evalNumArg(args[0], ctx);
    if (typeof code !== "number") return code;
    const norm = code > 100 ? code - 100 : code;
    const map: Record<number, string> = { 1: "AVERAGE", 2: "COUNT", 3: "COUNTA", 4: "MAX", 5: "MIN", 6: "PRODUCT", 7: "STDEV.S", 8: "STDEV.P", 9: "SUM", 10: "VAR.S", 11: "VAR.P" };
    const target = map[Math.trunc(norm)];
    return target ? BUILTIN_FUNCTIONS[target](args.slice(1), ctx) : errVal("#VALUE!");
  },

  // ---- Conditional Aggregations ----
  COUNTIF: (args, ctx) => evalSingleCondAgg("COUNTIF", args, ctx),
  SUMIF: (args, ctx) => evalSingleCondAgg("SUMIF", args, ctx),
  AVERAGEIF: (args, ctx) => evalSingleCondAgg("AVERAGEIF", args, ctx),
  COUNTIFS: (args, ctx) => evalConditionalAgg("COUNTIFS", args, ctx),
  SUMIFS: (args, ctx) => evalConditionalAgg("SUMIFS", args, ctx),
  AVERAGEIFS: (args, ctx) => evalConditionalAgg("AVERAGEIFS", args, ctx),
  MAXIFS: (args, ctx) => evalConditionalAgg("MAXIFS", args, ctx),
  MINIFS: (args, ctx) => evalConditionalAgg("MINIFS", args, ctx),

  // ---- Logic & Information ----
  IF: (args, ctx) => {
    if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
    const condRaw = ctx.evalAst(args[0]);
    if (ctx.arrayMode && condRaw.kind === "array") {
      const cMat = condRaw.value;
      const cRows = cMat.length;
      const cCols = cMat[0]?.length ?? 0;
      let anyTrue = false;
      let anyFalse = false;
      const bools: (boolean | EvalValue)[][] = [];
      for (let r = 0; r < cRows; r++) {
        const line: (boolean | EvalValue)[] = [];
        for (let c = 0; c < cCols; c++) {
          const b = toBoolean(cMat[r]?.[c] ?? EMPTY_VAL);
          if (b === true) anyTrue = true;
          else if (b === false) anyFalse = true;
          line.push(b);
        }
        bools.push(line);
      }
      const tVal = anyTrue ? ctx.evalAst(args[1]) : EMPTY_VAL;
      const fVal = anyFalse
        ? (args[2] && !isMissingArg(args[2]) ? ctx.evalAst(args[2]) : boolVal(false))
        : EMPTY_VAL;
      const tMat = tVal.kind === "array" ? tVal.value : [[tVal]];
      const fMat = fVal.kind === "array" ? fVal.value : [[fVal]];
      const rows = Math.max(cRows, anyTrue ? tMat.length : 1, anyFalse ? fMat.length : 1);
      const cols = Math.max(cCols, anyTrue ? (tMat[0]?.length ?? 1) : 1, anyFalse ? (fMat[0]?.length ?? 1) : 1);
      const out: EvalValue[][] = [];
      for (let r = 0; r < rows; r++) {
        const line: EvalValue[] = [];
        for (let c = 0; c < cols; c++) {
          if (!ctx.tickOp()) return errVal("#LIMIT!");
          const b = bools[Math.min(r, cRows - 1)]?.[Math.min(c, cCols - 1)] ?? false;
          if (typeof b !== "boolean") { line.push(b); continue; }
          if (b) {
            line.push(tMat[Math.min(r, tMat.length - 1)]?.[Math.min(c, (tMat[0]?.length ?? 1) - 1)] ?? EMPTY_VAL);
          } else {
            line.push(fMat[Math.min(r, fMat.length - 1)]?.[Math.min(c, (fMat[0]?.length ?? 1) - 1)] ?? boolVal(false));
          }
        }
        out.push(line);
      }
      return arrVal(out);
    }
    const cond = toBoolean(condRaw);
    if (typeof cond !== "boolean") return cond;
    if (cond) return ctx.evalAst(args[1]);
    return args[2] && !isMissingArg(args[2]) ? ctx.evalAst(args[2]) : boolVal(false);
  },
  IFS: (args, ctx) => {
    if (args.length < 2 || args.length % 2 !== 0) return errVal("#VALUE!");
    for (let i = 0; i < args.length; i += 2) {
      const cond = toBoolean(ctx.evalAst(args[i]));
      if (typeof cond !== "boolean") return cond;
      if (cond) return ctx.evalAst(args[i + 1]);
    }
    return errVal("#N/A");
  },
  SWITCH: (args, ctx) => {
    if (args.length < 3) return errVal("#VALUE!");
    const expr = unwrapScalar(ctx.evalAst(args[0]));
    if (expr.kind === "error") return expr;
    let i = 1;
    while (i + 1 < args.length) {
      const cand = unwrapScalar(ctx.evalAst(args[i]));
      if (cand.kind !== "error" && compareValues(expr, cand) === 0) return ctx.evalAst(args[i + 1]);
      i += 2;
    }
    return i < args.length ? ctx.evalAst(args[i]) : errVal("#N/A");
  },
  IFERROR: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const v = ctx.evalAst(args[0]);
    if (ctx.arrayMode && v.kind === "array") {
      const hasErr = v.value.some((row) => row.some((c) => c.kind === "error"));
      if (!hasErr) return v;
      const fb = ctx.evalAst(args[1]);
      const fbMat = fb.kind === "array" ? fb.value : [[fb]];
      return arrVal(
        v.value.map((row, r) =>
          row.map((cell, c) =>
            cell.kind === "error"
              ? (fbMat[Math.min(r, fbMat.length - 1)]?.[Math.min(c, (fbMat[0]?.length ?? 1) - 1)] ?? EMPTY_VAL)
              : cell,
          ),
        ),
      );
    }
    return v.kind === "error" ? ctx.evalAst(args[1]) : v;
  },
  IFNA: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const v = ctx.evalAst(args[0]);
    if (ctx.arrayMode && v.kind === "array") {
      const hasNa = v.value.some((row) => row.some((c) => c.kind === "error" && c.error === "#N/A"));
      if (!hasNa) return v;
      const fb = ctx.evalAst(args[1]);
      const fbMat = fb.kind === "array" ? fb.value : [[fb]];
      return arrVal(
        v.value.map((row, r) =>
          row.map((cell, c) =>
            cell.kind === "error" && cell.error === "#N/A"
              ? (fbMat[Math.min(r, fbMat.length - 1)]?.[Math.min(c, (fbMat[0]?.length ?? 1) - 1)] ?? EMPTY_VAL)
              : cell,
          ),
        ),
      );
    }
    return v.kind === "error" && v.error === "#N/A" ? ctx.evalAst(args[1]) : v;
  },
  AND: (args, ctx) => {
    const vals = collectValues(args, ctx, "nonempty");
    if (!Array.isArray(vals)) return vals;
    if (!vals.length) return errVal("#VALUE!");
    for (const v of vals) {
      const b = toBoolean(v);
      if (typeof b !== "boolean") return b;
      if (!b) return boolVal(false);
    }
    return boolVal(true);
  },
  OR: (args, ctx) => {
    const vals = collectValues(args, ctx, "nonempty");
    if (!Array.isArray(vals)) return vals;
    if (!vals.length) return errVal("#VALUE!");
    for (const v of vals) {
      const b = toBoolean(v);
      if (typeof b !== "boolean") return b;
      if (b) return boolVal(true);
    }
    return boolVal(false);
  },
  XOR: (args, ctx) => {
    const vals = collectValues(args, ctx, "nonempty");
    if (!Array.isArray(vals)) return vals;
    if (!vals.length) return errVal("#VALUE!");
    let parity = false;
    for (const v of vals) {
      const b = toBoolean(v);
      if (typeof b !== "boolean") return b;
      if (b) parity = !parity;
    }
    return boolVal(parity);
  },
  NOT: (args, ctx) => {
    if (args.length !== 1) return errVal("#VALUE!");
    const b = toBoolean(ctx.evalAst(args[0]));
    return typeof b === "boolean" ? boolVal(!b) : b;
  },
  TRUE: () => boolVal(true),
  FALSE: () => boolVal(false),
  NA: () => errVal("#N/A"),
  ISBLANK: (args, ctx) => args.length === 1 ? boolVal(unwrapScalar(ctx.evalAst(args[0])).kind === "empty") : errVal("#VALUE!"),
  ISERROR: (args, ctx) => args.length === 1 ? boolVal(unwrapScalar(ctx.evalAst(args[0])).kind === "error") : errVal("#VALUE!"),
  ISERR: (args, ctx) => {
    if (args.length !== 1) return errVal("#VALUE!");
    const v = unwrapScalar(ctx.evalAst(args[0]));
    return boolVal(v.kind === "error" && v.error !== "#N/A");
  },
  ISNA: (args, ctx) => {
    if (args.length !== 1) return errVal("#VALUE!");
    const v = unwrapScalar(ctx.evalAst(args[0]));
    return boolVal(v.kind === "error" && v.error === "#N/A");
  },
  ISNUMBER: (args, ctx) => args.length === 1 ? boolVal(unwrapScalar(ctx.evalAst(args[0])).kind === "number") : errVal("#VALUE!"),
  ISTEXT: (args, ctx) => args.length === 1 ? boolVal(unwrapScalar(ctx.evalAst(args[0])).kind === "string") : errVal("#VALUE!"),
  ISLOGICAL: (args, ctx) => args.length === 1 ? boolVal(unwrapScalar(ctx.evalAst(args[0])).kind === "boolean") : errVal("#VALUE!"),
  ISFORMULA: (args, ctx) => {
    if (args.length !== 1) return errVal("#VALUE!");
    const ref = ctx.resolveCellRef(args[0]);
    if (!ref) return errVal("#VALUE!");
    return boolVal(ctx.readRawCell(ref.sheetId, ref.row, ref.col).startsWith("="));
  },

  // ---- Math ----
  ABS: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(Math.abs(n)) : n; },
  INT: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(Math.floor(n)) : n; },
  SQRT: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? (n < 0 ? errVal("#NUM!") : numVal(Math.sqrt(n))) : n; },
  SIGN: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(Math.sign(n)) : n; },
  EXP: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(Math.exp(n)) : n; },
  LN: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? (n <= 0 ? errVal("#NUM!") : numVal(Math.log(n))) : n; },
  LOG10: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? (n <= 0 ? errVal("#NUM!") : numVal(Math.log10(n))) : n; },
  LOG: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    const n = evalNumArg(args[0], ctx);
    const base = args[1] ? evalNumArg(args[1], ctx, 10) : 10;
    if (typeof n !== "number") return n;
    if (typeof base !== "number") return base;
    if (n <= 0 || base <= 0 || base === 1) return errVal("#NUM!");
    return numVal(Math.log(n) / Math.log(base));
  },
  SIN: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(Math.sin(n)) : n; },
  COS: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(Math.cos(n)) : n; },
  TAN: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(Math.tan(n)) : n; },
  PI: (args) => (args.length ? errVal("#VALUE!") : numVal(Math.PI)),
  RAND: (args) => (args.length ? errVal("#VALUE!") : numVal(Math.random())),
  RANDBETWEEN: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const lo = evalNumArg(args[0], ctx);
    const hi = evalNumArg(args[1], ctx);
    if (typeof lo !== "number") return lo;
    if (typeof hi !== "number") return hi;
    const a = Math.ceil(lo);
    const b = Math.floor(hi);
    if (a > b) return errVal("#NUM!");
    return numVal(Math.floor(Math.random() * (b - a + 1)) + a);
  },
  ROUND: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    const n = evalNumArg(args[0], ctx);
    const d = evalNumArg(args[1], ctx, 0);
    if (typeof n !== "number") return n;
    if (typeof d !== "number") return d;
    return numVal(roundTo(n, d, "round"));
  },
  ROUNDUP: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    const n = evalNumArg(args[0], ctx);
    const d = evalNumArg(args[1], ctx, 0);
    if (typeof n !== "number") return n;
    if (typeof d !== "number") return d;
    return numVal(roundTo(n, d, "up"));
  },
  ROUNDDOWN: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    const n = evalNumArg(args[0], ctx);
    const d = evalNumArg(args[1], ctx, 0);
    if (typeof n !== "number") return n;
    if (typeof d !== "number") return d;
    return numVal(roundTo(n, d, "down"));
  },
  TRUNC: (args, ctx) => BUILTIN_FUNCTIONS.ROUNDDOWN(args, ctx),
  MROUND: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const n = evalNumArg(args[0], ctx);
    const m = evalNumArg(args[1], ctx);
    if (typeof n !== "number") return n;
    if (typeof m !== "number") return m;
    if (m === 0) return numVal(0);
    if ((n > 0 && m < 0) || (n < 0 && m > 0)) return errVal("#NUM!");
    return numVal(Math.round(n / m) * m);
  },
  CEILING: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    const n = evalNumArg(args[0], ctx);
    const sig = evalNumArg(args[1], ctx, 1);
    if (typeof n !== "number") return n;
    if (typeof sig !== "number") return sig;
    if (sig === 0) return numVal(0);
    return numVal(Math.ceil(n / sig) * sig);
  },
  FLOOR: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    const n = evalNumArg(args[0], ctx);
    const sig = evalNumArg(args[1], ctx, 1);
    if (typeof n !== "number") return n;
    if (typeof sig !== "number") return sig;
    if (sig === 0) return errVal("#DIV/0!");
    return numVal(Math.floor(n / sig) * sig);
  },
  MOD: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const a = evalNumArg(args[0], ctx);
    const b = evalNumArg(args[1], ctx);
    if (typeof a !== "number") return a;
    if (typeof b !== "number") return b;
    return b === 0 ? errVal("#DIV/0!") : numVal(((a % b) + b) % b);
  },
  POWER: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const a = evalNumArg(args[0], ctx);
    const b = evalNumArg(args[1], ctx);
    if (typeof a !== "number") return a;
    if (typeof b !== "number") return b;
    return numVal(a ** b);
  },

  // ---- Text ----
  CONCAT: (args, ctx) => {
    const vals = collectValues(args, ctx, "all");
    if (!Array.isArray(vals)) return vals;
    return strVal(vals.map((v) => toStringValue(v)).join(""));
  },
  CONCATENATE: (args, ctx) => BUILTIN_FUNCTIONS.CONCAT(args, ctx),
  TEXTJOIN: (args, ctx) => {
    if (args.length < 3) return errVal("#VALUE!");
    const delim = evalStrArg(args[0], ctx);
    if (typeof delim !== "string") return delim;
    const ignoreEmpty = toBoolean(ctx.evalAst(args[1]));
    if (typeof ignoreEmpty !== "boolean") return ignoreEmpty;
    const vals = collectValues(args.slice(2), ctx, "all");
    if (!Array.isArray(vals)) return vals;
    const parts: string[] = [];
    for (const v of vals) {
      const s = toStringValue(v);
      if (ignoreEmpty && s === "") continue;
      parts.push(s);
    }
    return strVal(parts.join(delim));
  },
  LEN: (args, ctx) => { const s = evalStrArg(args[0], ctx); return typeof s === "string" ? numVal(Array.from(s).length) : s; },
  UPPER: (args, ctx) => { const s = evalStrArg(args[0], ctx); return typeof s === "string" ? strVal(s.toUpperCase()) : s; },
  LOWER: (args, ctx) => { const s = evalStrArg(args[0], ctx); return typeof s === "string" ? strVal(s.toLowerCase()) : s; },
  PROPER: (args, ctx) => {
    const s = evalStrArg(args[0], ctx);
    return typeof s === "string" ? strVal(s.toLowerCase().replace(/(^|[^a-zA-Z0-9])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase())) : s;
  },
  TRIM: (args, ctx) => { const s = evalStrArg(args[0], ctx); return typeof s === "string" ? strVal(s.trim().replace(/\s+/g, " ")) : s; },
  CLEAN: (args, ctx) => { const s = evalStrArg(args[0], ctx); return typeof s === "string" ? strVal(s.replace(/[\u0000-\u001f]/g, "")) : s; },
  LEFT: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    const s = evalStrArg(args[0], ctx);
    const n = evalNumArg(args[1], ctx, 1);
    if (typeof s !== "string") return s;
    if (typeof n !== "number") return n;
    if (n < 0) return errVal("#VALUE!");
    return strVal(Array.from(s).slice(0, Math.trunc(n)).join(""));
  },
  RIGHT: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    const s = evalStrArg(args[0], ctx);
    const n = evalNumArg(args[1], ctx, 1);
    if (typeof s !== "string") return s;
    if (typeof n !== "number") return n;
    if (n < 0) return errVal("#VALUE!");
    const chars = Array.from(s);
    return strVal(chars.slice(Math.max(0, chars.length - Math.trunc(n))).join(""));
  },
  MID: (args, ctx) => {
    if (args.length !== 3) return errVal("#VALUE!");
    const s = evalStrArg(args[0], ctx);
    const start = evalNumArg(args[1], ctx);
    const len = evalNumArg(args[2], ctx);
    if (typeof s !== "string") return s;
    if (typeof start !== "number") return start;
    if (typeof len !== "number") return len;
    if (start < 1 || len < 0) return errVal("#VALUE!");
    const chars = Array.from(s);
    const st = Math.trunc(start) - 1;
    return strVal(chars.slice(st, st + Math.trunc(len)).join(""));
  },
  FIND: (args, ctx) => {
    if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
    const needle = evalStrArg(args[0], ctx);
    const hay = evalStrArg(args[1], ctx);
    const start = evalNumArg(args[2], ctx, 1);
    if (typeof needle !== "string") return needle;
    if (typeof hay !== "string") return hay;
    if (typeof start !== "number") return start;
    if (start < 1 || start > hay.length + 1) return errVal("#VALUE!");
    const idx = hay.indexOf(needle, Math.trunc(start) - 1);
    return idx < 0 ? errVal("#VALUE!") : numVal(idx + 1);
  },
  SEARCH: (args, ctx) => {
    if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
    const needle = evalStrArg(args[0], ctx);
    const hay = evalStrArg(args[1], ctx);
    const start = evalNumArg(args[2], ctx, 1);
    if (typeof needle !== "string") return needle;
    if (typeof hay !== "string") return hay;
    if (typeof start !== "number") return start;
    if (start < 1 || start > hay.length + 1) return errVal("#VALUE!");
    const slice = hay.slice(Math.trunc(start) - 1);
    if (needle.includes("*") || needle.includes("?")) {
      const re = new RegExp(wildcardToRegex(needle).source.slice(1, -1), "i");
      const m = re.exec(slice);
      return m ? numVal(Math.trunc(start) + m.index) : errVal("#VALUE!");
    }
    const idx = slice.toLowerCase().indexOf(needle.toLowerCase());
    return idx < 0 ? errVal("#VALUE!") : numVal(Math.trunc(start) + idx);
  },
  SUBSTITUTE: (args, ctx) => {
    if (args.length < 3 || args.length > 4) return errVal("#VALUE!");
    const text = evalStrArg(args[0], ctx);
    const oldStr = evalStrArg(args[1], ctx);
    const newStr = evalStrArg(args[2], ctx);
    if (typeof text !== "string") return text;
    if (typeof oldStr !== "string") return oldStr;
    if (typeof newStr !== "string") return newStr;
    if (!oldStr) return strVal(text);
    if (args.length === 4 && !isMissingArg(args[3])) {
      const inst = evalNumArg(args[3], ctx);
      if (typeof inst !== "number") return inst;
      if (inst < 1) return errVal("#VALUE!");
      let count = 0;
      let pos = 0;
      while (true) {
        const idx = text.indexOf(oldStr, pos);
        if (idx < 0) return strVal(text);
        if (++count === Math.trunc(inst)) return strVal(text.slice(0, idx) + newStr + text.slice(idx + oldStr.length));
        pos = idx + oldStr.length;
      }
    }
    return strVal(text.split(oldStr).join(newStr));
  },
  REPLACE: (args, ctx) => {
    if (args.length !== 4) return errVal("#VALUE!");
    const text = evalStrArg(args[0], ctx);
    const start = evalNumArg(args[1], ctx);
    const count = evalNumArg(args[2], ctx);
    const next = evalStrArg(args[3], ctx);
    if (typeof text !== "string") return text;
    if (typeof start !== "number") return start;
    if (typeof count !== "number") return count;
    if (typeof next !== "string") return next;
    if (start < 1 || count < 0) return errVal("#VALUE!");
    const chars = Array.from(text);
    const st = Math.trunc(start) - 1;
    return strVal([...chars.slice(0, st), ...Array.from(next), ...chars.slice(st + Math.trunc(count))].join(""));
  },
  TEXT: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const n = evalNumArg(args[0], ctx);
    const fmt = evalStrArg(args[1], ctx);
    if (typeof n !== "number") return n;
    if (typeof fmt !== "string") return fmt;
    return strVal(formatExcelNumber(n, fmt));
  },
  VALUE: (args, ctx) => {
    if (args.length !== 1) return errVal("#VALUE!");
    const s = evalStrArg(args[0], ctx);
    if (typeof s !== "string") return s;
    const cleaned = s.trim().replace(/[¥$€£,]/g, "");
    if (cleaned.endsWith("%")) {
      const pct = Number(cleaned.slice(0, -1));
      return Number.isFinite(pct) ? numVal(pct / 100) : errVal("#VALUE!");
    }
    const n = Number(cleaned);
    if (Number.isFinite(n) && cleaned !== "") return numVal(n);
    const ds = parseDateToSerial(s);
    return ds !== null ? numVal(ds) : errVal("#VALUE!");
  },
  REPT: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const s = evalStrArg(args[0], ctx);
    const n = evalNumArg(args[1], ctx);
    if (typeof s !== "string") return s;
    if (typeof n !== "number") return n;
    const k = Math.trunc(n);
    if (k < 0 || s.length * k > 32767) return errVal("#VALUE!");
    return strVal(s.repeat(k));
  },
  EXACT: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const a = evalStrArg(args[0], ctx);
    const b = evalStrArg(args[1], ctx);
    if (typeof a !== "string") return a;
    if (typeof b !== "string") return b;
    return boolVal(a === b);
  },
  CHAR: (args, ctx) => {
    const n = evalNumArg(args[0], ctx);
    if (typeof n !== "number") return n;
    const c = Math.trunc(n);
    return c < 1 || c > 255 ? errVal("#VALUE!") : strVal(String.fromCharCode(c));
  },
  CODE: (args, ctx) => {
    const s = evalStrArg(args[0], ctx);
    if (typeof s !== "string") return s;
    return s.length ? numVal(s.charCodeAt(0)) : errVal("#VALUE!");
  },
  SPLIT: (args, ctx) => {
    if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
    const s = evalStrArg(args[0], ctx);
    const d = evalStrArg(args[1], ctx);
    if (typeof s !== "string") return s;
    if (typeof d !== "string") return d;
    if (!d) return errVal("#VALUE!");
    return arrVal([s.split(d).map((part) => strVal(part))]);
  },

  // ---- Date & Time ----
  TODAY: (args) => args.length ? errVal("#VALUE!") : strVal(new Date().toISOString().slice(0, 10)),
  NOW: (args) => args.length ? errVal("#VALUE!") : strVal(new Date().toISOString().slice(0, 16).replace("T", " ")),
  DATE: (args, ctx) => {
    if (args.length !== 3) return errVal("#VALUE!");
    const y = evalNumArg(args[0], ctx);
    const m = evalNumArg(args[1], ctx);
    const d = evalNumArg(args[2], ctx);
    if (typeof y !== "number") return y;
    if (typeof m !== "number") return m;
    if (typeof d !== "number") return d;
    const yr = y >= 0 && y < 1900 ? 1900 + Math.trunc(y) : Math.trunc(y);
    return numVal(dateToSerial(new Date(Date.UTC(yr, Math.trunc(m) - 1, Math.trunc(d)))));
  },
  TIME: (args, ctx) => {
    if (args.length !== 3) return errVal("#VALUE!");
    const h = evalNumArg(args[0], ctx);
    const m = evalNumArg(args[1], ctx);
    const s = evalNumArg(args[2], ctx);
    if (typeof h !== "number") return h;
    if (typeof m !== "number") return m;
    if (typeof s !== "number") return s;
    const sec = Math.trunc(h) * 3600 + Math.trunc(m) * 60 + Math.trunc(s);
    if (sec < 0) return errVal("#NUM!");
    return numVal((sec % 86400) / 86400);
  },
  DATEVALUE: (args, ctx) => {
    const s = evalStrArg(args[0], ctx);
    if (typeof s !== "string") return s;
    const serial = parseDateToSerial(s);
    return serial === null ? errVal("#VALUE!") : numVal(Math.floor(serial));
  },
  YEAR: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(evalDateParts(n).y) : n; },
  MONTH: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(evalDateParts(n).m) : n; },
  DAY: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(evalDateParts(n).d) : n; },
  HOUR: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(evalDateParts(n).hh) : n; },
  MINUTE: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(evalDateParts(n).mm) : n; },
  SECOND: (args, ctx) => { const n = evalNumArg(args[0], ctx); return typeof n === "number" ? numVal(evalDateParts(n).ss) : n; },
  DAYS: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const end = evalNumArg(args[0], ctx);
    const start = evalNumArg(args[1], ctx);
    if (typeof end !== "number") return end;
    if (typeof start !== "number") return start;
    return numVal(Math.trunc(end) - Math.trunc(start));
  },
  DATEDIF: (args, ctx) => {
    if (args.length !== 3) return errVal("#VALUE!");
    const start = evalNumArg(args[0], ctx);
    const end = evalNumArg(args[1], ctx);
    const unit = evalStrArg(args[2], ctx);
    if (typeof start !== "number") return start;
    if (typeof end !== "number") return end;
    if (typeof unit !== "string") return unit;
    if (start > end) return errVal("#NUM!");
    const a = evalDateParts(start);
    const b = evalDateParts(end);
    const u = unit.toUpperCase();
    if (u === "D") return numVal(Math.trunc(end) - Math.trunc(start));
    if (u === "Y") {
      let years = b.y - a.y;
      if (b.m < a.m || (b.m === a.m && b.d < a.d)) years--;
      return numVal(years);
    }
    if (u === "M") {
      let months = (b.y - a.y) * 12 + (b.m - a.m);
      if (b.d < a.d) months--;
      return numVal(months);
    }
    return errVal("#NUM!");
  },
  EDATE: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const start = evalNumArg(args[0], ctx);
    const months = evalNumArg(args[1], ctx);
    if (typeof start !== "number") return start;
    if (typeof months !== "number") return months;
    const p = evalDateParts(start);
    const targetMonth = p.m - 1 + Math.trunc(months);
    const lastDay = new Date(Date.UTC(p.y, targetMonth + 1, 0)).getUTCDate();
    return numVal(dateToSerial(new Date(Date.UTC(p.y, targetMonth, Math.min(p.d, lastDay)))));
  },
  EOMONTH: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const start = evalNumArg(args[0], ctx);
    const months = evalNumArg(args[1], ctx);
    if (typeof start !== "number") return start;
    if (typeof months !== "number") return months;
    const p = evalDateParts(start);
    return numVal(dateToSerial(new Date(Date.UTC(p.y, p.m + Math.trunc(months), 0))));
  },
  WEEKDAY: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    const n = evalNumArg(args[0], ctx);
    const mode = evalNumArg(args[1], ctx, 1);
    if (typeof n !== "number") return n;
    if (typeof mode !== "number") return mode;
    const dow = evalDateParts(n).dow; // 0=Sun..6=Sat
    if (mode === 1) return numVal(dow + 1);
    if (mode === 2) return numVal(dow === 0 ? 7 : dow);
    if (mode === 3) return numVal(dow === 0 ? 6 : dow - 1);
    return errVal("#NUM!");
  },
  WEEKNUM: (args, ctx) => {
    const n = evalNumArg(args[0], ctx);
    if (typeof n !== "number") return n;
    const p = evalDateParts(n);
    const jan1 = dateToSerial(new Date(Date.UTC(p.y, 0, 1)));
    const jan1Dow = evalDateParts(jan1).dow;
    return numVal(Math.floor((Math.trunc(n) - jan1 + jan1Dow) / 7) + 1);
  },
  ISOWEEKNUM: (args, ctx) => {
    const n = evalNumArg(args[0], ctx);
    if (typeof n !== "number") return n;
    const dt = serialToDate(n);
    const dayNum = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    return numVal(Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7));
  },
  WORKDAY: (args, ctx) => {
    if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
    const start = evalNumArg(args[0], ctx);
    const days = evalNumArg(args[1], ctx);
    if (typeof start !== "number") return start;
    if (typeof days !== "number") return days;
    const hols = new Set<number>();
    if (args[2] && !isMissingArg(args[2])) {
      const nums = collectNumbers([args[2]], ctx);
      if (!Array.isArray(nums)) return nums;
      for (const h of nums) hols.add(Math.trunc(h));
    }
    return numVal(workdayCalc(start, days, hols));
  },
  NETWORKDAYS: (args, ctx) => {
    if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
    const start = evalNumArg(args[0], ctx);
    const end = evalNumArg(args[1], ctx);
    if (typeof start !== "number") return start;
    if (typeof end !== "number") return end;
    const hols = new Set<number>();
    if (args[2] && !isMissingArg(args[2])) {
      const nums = collectNumbers([args[2]], ctx);
      if (!Array.isArray(nums)) return nums;
      for (const h of nums) hols.add(Math.trunc(h));
    }
    return numVal(networkdaysCalc(start, end, hols));
  },
  YEARFRAC: (args, ctx) => {
    if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
    const start = evalNumArg(args[0], ctx);
    const end = evalNumArg(args[1], ctx);
    if (typeof start !== "number") return start;
    if (typeof end !== "number") return end;
    return numVal(Math.abs(end - start) / 365);
  },

  // ---- Lookup & Reference ----
  VLOOKUP: (args, ctx) => {
    if (args.length < 3 || args.length > 4) return errVal("#VALUE!");
    const key = unwrapScalar(ctx.evalAst(args[0]));
    if (key.kind === "error") return key;
    const table = getMatrix(args[1], ctx);
    if (!Array.isArray(table)) return table;
    const colIdx = evalNumArg(args[2], ctx);
    if (typeof colIdx !== "number") return colIdx;
    const ci = Math.trunc(colIdx) - 1;
    if (ci < 0 || ci >= (table[0]?.length ?? 0)) return errVal("#REF!");
    const approx = args[3] && !isMissingArg(args[3]) ? toBoolean(ctx.evalAst(args[3])) : true;
    if (typeof approx !== "boolean") return approx;

    if (!approx) {
      for (let r = 0; r < table.length; r++) {
        if (matchCriteria(table[r][0], key)) return table[r][ci] ?? EMPTY_VAL;
      }
      return errVal("#N/A");
    }
    let bestRow = -1;
    for (let r = 0; r < table.length; r++) {
      const cell = table[r][0];
      if (cell.kind === "empty" || cell.kind === "error") continue;
      if (compareValues(cell, key) <= 0) bestRow = r;
      else break;
    }
    return bestRow >= 0 ? (table[bestRow][ci] ?? EMPTY_VAL) : errVal("#N/A");
  },
  HLOOKUP: (args, ctx) => {
    if (args.length < 3 || args.length > 4) return errVal("#VALUE!");
    const key = unwrapScalar(ctx.evalAst(args[0]));
    if (key.kind === "error") return key;
    const table = getMatrix(args[1], ctx);
    if (!Array.isArray(table)) return table;
    const rowIdx = evalNumArg(args[2], ctx);
    if (typeof rowIdx !== "number") return rowIdx;
    const ri = Math.trunc(rowIdx) - 1;
    if (ri < 0 || ri >= table.length) return errVal("#REF!");
    const approx = args[3] && !isMissingArg(args[3]) ? toBoolean(ctx.evalAst(args[3])) : true;
    if (typeof approx !== "boolean") return approx;
    const topRow = table[0];
    if (!approx) {
      for (let c = 0; c < topRow.length; c++) {
        if (matchCriteria(topRow[c], key)) return table[ri][c] ?? EMPTY_VAL;
      }
      return errVal("#N/A");
    }
    let bestCol = -1;
    for (let c = 0; c < topRow.length; c++) {
      if (topRow[c].kind === "empty" || topRow[c].kind === "error") continue;
      if (compareValues(topRow[c], key) <= 0) bestCol = c;
      else break;
    }
    return bestCol >= 0 ? (table[ri][bestCol] ?? EMPTY_VAL) : errVal("#N/A");
  },
  XLOOKUP: (args, ctx) => {
    if (args.length < 3 || args.length > 6) return errVal("#VALUE!");
    const key = unwrapScalar(ctx.evalAst(args[0]));
    if (key.kind === "error") return key;
    const lookupMat = getMatrix(args[1], ctx);
    const returnMat = getMatrix(args[2], ctx);
    if (!Array.isArray(lookupMat)) return lookupMat;
    if (!Array.isArray(returnMat)) return returnMat;
    const matchMode = args[4] && !isMissingArg(args[4]) ? evalNumArg(args[4], ctx, 0) : 0;
    const searchMode = args[5] && !isMissingArg(args[5]) ? evalNumArg(args[5], ctx, 1) : 1;
    if (typeof matchMode !== "number") return matchMode;
    if (typeof searchMode !== "number") return searchMode;

    const vertical = lookupMat.length >= (lookupMat[0]?.length ?? 0);
    const keys = flattenMatrix(lookupMat);
    const order = searchMode === -1 ? keys.map((_, i) => keys.length - 1 - i) : keys.map((_, i) => i);

    let hit = -1;
    if (matchMode === 0 || matchMode === 2) {
      for (const idx of order) {
        if (matchMode === 2 ? matchCriteria(keys[idx], key) : compareValues(keys[idx], key) === 0) {
          hit = idx;
          break;
        }
      }
    } else if (matchMode === -1 || matchMode === 1) {
      let bestIdx = -1;
      for (const idx of order) {
        const cmp = compareValues(keys[idx], key);
        if (cmp === 0) { bestIdx = idx; break; }
        if (matchMode === -1 && cmp < 0 && (bestIdx < 0 || compareValues(keys[idx], keys[bestIdx]) > 0)) bestIdx = idx;
        if (matchMode === 1 && cmp > 0 && (bestIdx < 0 || compareValues(keys[idx], keys[bestIdx]) < 0)) bestIdx = idx;
      }
      hit = bestIdx;
    }
    if (hit < 0) {
      return args[3] && !isMissingArg(args[3]) ? ctx.evalAst(args[3]) : errVal("#N/A");
    }
    if (vertical) {
      const row = returnMat[hit];
      if (!row) return errVal("#REF!");
      return row.length === 1 ? row[0] : arrVal([row]);
    }
    const colVals = returnMat.map((r) => [r[hit] ?? EMPTY_VAL]);
    return colVals.length === 1 ? colVals[0][0] : arrVal(colVals);
  },
  INDEX: (args, ctx) => {
    if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
    const mat = getMatrix(args[0], ctx);
    if (!Array.isArray(mat)) return mat;
    const rArg = evalNumArg(args[1], ctx, 0);
    const cArg = args.length === 3 ? evalNumArg(args[2], ctx, 0) : 0;
    if (typeof rArg !== "number") return rArg;
    if (typeof cArg !== "number") return cArg;
    const ri = Math.trunc(rArg);
    const ci = Math.trunc(cArg);
    if (ri < 0 || ci < 0 || ri > mat.length || ci > (mat[0]?.length ?? 0)) return errVal("#REF!");
    if (ri === 0 && ci === 0) return arrVal(mat);
    if (ri === 0) return arrVal(mat.map((row) => [row[ci - 1] ?? EMPTY_VAL]));
    if (ci === 0) {
      if (mat[0]?.length === 1) return mat[ri - 1]?.[0] ?? EMPTY_VAL;
      if (mat.length === 1) return mat[0][ri - 1] ?? errVal("#REF!");
      return arrVal([mat[ri - 1]]);
    }
    return mat[ri - 1]?.[ci - 1] ?? errVal("#REF!");
  },
  MATCH: (args, ctx) => {
    if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
    const key = unwrapScalar(ctx.evalAst(args[0]));
    if (key.kind === "error") return key;
    const mat = getMatrix(args[1], ctx);
    if (!Array.isArray(mat)) return mat;
    const type = evalNumArg(args[2], ctx, 1);
    if (typeof type !== "number") return type;
    const flat = flattenMatrix(mat);
    if (type === 0) {
      for (let i = 0; i < flat.length; i++) if (matchCriteria(flat[i], key)) return numVal(i + 1);
      return errVal("#N/A");
    }
    let best = -1;
    for (let i = 0; i < flat.length; i++) {
      if (flat[i].kind === "empty" || flat[i].kind === "error") continue;
      const cmp = compareValues(flat[i], key);
      if (type > 0 ? cmp <= 0 : cmp >= 0) best = i;
      else break;
    }
    return best >= 0 ? numVal(best + 1) : errVal("#N/A");
  },
  XMATCH: (args, ctx) => {
    if (args.length < 2 || args.length > 4) return errVal("#VALUE!");
    const key = unwrapScalar(ctx.evalAst(args[0]));
    if (key.kind === "error") return key;
    const mat = getMatrix(args[1], ctx);
    if (!Array.isArray(mat)) return mat;
    const matchMode = evalNumArg(args[2], ctx, 0);
    const searchMode = evalNumArg(args[3], ctx, 1);
    if (typeof matchMode !== "number") return matchMode;
    if (typeof searchMode !== "number") return searchMode;
    const flat = flattenMatrix(mat);
    const indices = searchMode === -1 ? flat.map((_, i) => flat.length - 1 - i) : flat.map((_, i) => i);
    for (const i of indices) {
      if (matchMode === 2 ? matchCriteria(flat[i], key) : compareValues(flat[i], key) === 0) return numVal(i + 1);
    }
    return errVal("#N/A");
  },
  CHOOSE: (args, ctx) => {
    if (args.length < 2) return errVal("#VALUE!");
    const idx = evalNumArg(args[0], ctx);
    if (typeof idx !== "number") return idx;
    const i = Math.trunc(idx);
    if (i < 1 || i >= args.length) return errVal("#VALUE!");
    return ctx.evalAst(args[i]);
  },
  ROW: (args, ctx) => {
    if (args.length === 0) return numVal(ctx.row + 1);
    const cell = ctx.resolveCellRef(args[0]);
    if (cell) return numVal(cell.row + 1);
    if (args[0].kind === "range") {
      const r = ctx.resolveRange(args[0]);
      return r ? numVal(r.top + 1) : errVal("#REF!");
    }
    return errVal("#VALUE!");
  },
  COLUMN: (args, ctx) => {
    if (args.length === 0) return numVal(ctx.col + 1);
    const cell = ctx.resolveCellRef(args[0]);
    if (cell) return numVal(cell.col + 1);
    if (args[0].kind === "range") {
      const r = ctx.resolveRange(args[0]);
      return r ? numVal(r.left + 1) : errVal("#REF!");
    }
    return errVal("#VALUE!");
  },
  ROWS: (args, ctx) => {
    if (args.length !== 1) return errVal("#VALUE!");
    const m = getMatrix(args[0], ctx);
    return Array.isArray(m) ? numVal(m.length) : m;
  },
  COLUMNS: (args, ctx) => {
    if (args.length !== 1) return errVal("#VALUE!");
    const m = getMatrix(args[0], ctx);
    return Array.isArray(m) ? numVal(m[0]?.length ?? 0) : m;
  },
  OFFSET: (args, ctx) => {
    if (args.length < 3 || args.length > 5) return errVal("#VALUE!");
    const baseCell = ctx.resolveCellRef(args[0]);
    const baseRange = args[0].kind === "range" ? ctx.resolveRange(args[0]) : null;
    if (!baseCell && !baseRange) return errVal("#VALUE!");
    const dRow = evalNumArg(args[1], ctx);
    const dCol = evalNumArg(args[2], ctx);
    if (typeof dRow !== "number") return dRow;
    if (typeof dCol !== "number") return dCol;
    const sheetId = baseCell ? baseCell.sheetId : baseRange!.sheetId;
    const top = (baseCell ? baseCell.row : baseRange!.top) + Math.trunc(dRow);
    const left = (baseCell ? baseCell.col : baseRange!.left) + Math.trunc(dCol);
    const defaultH = baseRange ? baseRange.bottom - baseRange.top + 1 : 1;
    const defaultW = baseRange ? baseRange.right - baseRange.left + 1 : 1;
    const h = args[3] && !isMissingArg(args[3]) ? evalNumArg(args[3], ctx, defaultH) : defaultH;
    const w = args[4] && !isMissingArg(args[4]) ? evalNumArg(args[4], ctx, defaultW) : defaultW;
    if (typeof h !== "number") return h;
    if (typeof w !== "number") return w;
    const hi = Math.trunc(h);
    const wi = Math.trunc(w);
    const bounds = ctx.sheetBounds(sheetId);
    if (!bounds || hi < 1 || wi < 1 || top < 0 || left < 0 || top + hi > bounds.rows || left + wi > bounds.cols) {
      return errVal("#REF!");
    }
    if (hi === 1 && wi === 1) return ctx.readCell(sheetId, top, left);
    const mat: EvalValue[][] = [];
    for (let r = 0; r < hi; r++) {
      const row: EvalValue[] = [];
      for (let c = 0; c < wi; c++) row.push(ctx.readCell(sheetId, top + r, left + c));
      mat.push(row);
    }
    return arrVal(mat);
  },
  INDIRECT: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    const refText = evalStrArg(args[0], ctx);
    if (typeof refText !== "string") return refText;
    const resolved = ctx.parseAndResolveRef(refText);
    if (!resolved) return errVal("#REF!");
    if ("row" in resolved) return ctx.readCell(resolved.sheetId, resolved.row, resolved.col);
    const mat: EvalValue[][] = [];
    for (let r = resolved.top; r <= resolved.bottom; r++) {
      const row: EvalValue[] = [];
      for (let c = resolved.left; c <= resolved.right; c++) row.push(ctx.readCell(resolved.sheetId, r, c));
      mat.push(row);
    }
    return mat.length === 1 && mat[0].length === 1 ? mat[0][0] : arrVal(mat);
  },
  TRANSPOSE: (args, ctx) => {
    if (args.length !== 1) return errVal("#VALUE!");
    const mat = getMatrix(args[0], ctx);
    if (!Array.isArray(mat)) return mat;
    const h = mat.length;
    const w = mat[0]?.length ?? 0;
    const out: EvalValue[][] = [];
    for (let c = 0; c < w; c++) {
      const row: EvalValue[] = [];
      for (let r = 0; r < h; r++) row.push(mat[r][c]);
      out.push(row);
    }
    return arrVal(out);
  },
  HYPERLINK: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    return args[1] && !isMissingArg(args[1]) ? unwrapScalar(ctx.evalAst(args[1])) : unwrapScalar(ctx.evalAst(args[0]));
  },

  // ---- Financial ----
  PMT: (args, ctx) => {
    if (args.length < 3 || args.length > 5) return errVal("#VALUE!");
    const r = evalNumArg(args[0], ctx);
    const n = evalNumArg(args[1], ctx);
    const pv = evalNumArg(args[2], ctx);
    const fv = evalNumArg(args[3], ctx, 0);
    const t = evalNumArg(args[4], ctx, 0);
    if (typeof r !== "number") return r;
    if (typeof n !== "number") return n;
    if (typeof pv !== "number") return pv;
    if (typeof fv !== "number") return fv;
    if (typeof t !== "number") return t;
    return n === 0 ? errVal("#NUM!") : numVal(pmtCalc(r, n, pv, fv, t));
  },
  PV: (args, ctx) => {
    if (args.length < 3 || args.length > 5) return errVal("#VALUE!");
    const r = evalNumArg(args[0], ctx);
    const n = evalNumArg(args[1], ctx);
    const pmt = evalNumArg(args[2], ctx);
    const fv = evalNumArg(args[3], ctx, 0);
    const t = evalNumArg(args[4], ctx, 0);
    if (typeof r !== "number") return r;
    if (typeof n !== "number") return n;
    if (typeof pmt !== "number") return pmt;
    if (typeof fv !== "number") return fv;
    if (typeof t !== "number") return t;
    return numVal(pvCalc(r, n, pmt, fv, t));
  },
  FV: (args, ctx) => {
    if (args.length < 3 || args.length > 5) return errVal("#VALUE!");
    const r = evalNumArg(args[0], ctx);
    const n = evalNumArg(args[1], ctx);
    const pmt = evalNumArg(args[2], ctx);
    const pv = evalNumArg(args[3], ctx, 0);
    const t = evalNumArg(args[4], ctx, 0);
    if (typeof r !== "number") return r;
    if (typeof n !== "number") return n;
    if (typeof pmt !== "number") return pmt;
    if (typeof pv !== "number") return pv;
    if (typeof t !== "number") return t;
    return numVal(fvCalc(r, n, pmt, pv, t));
  },
  NPV: (args, ctx) => {
    if (args.length < 2) return errVal("#VALUE!");
    const rate = evalNumArg(args[0], ctx);
    if (typeof rate !== "number") return rate;
    const nums = collectNumbers(args.slice(1), ctx);
    if (!Array.isArray(nums)) return nums;
    let total = 0;
    for (let i = 0; i < nums.length; i++) total += nums[i] / (1 + rate) ** (i + 1);
    return numVal(total);
  },
  IRR: (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errVal("#VALUE!");
    const nums = collectNumbers([args[0]], ctx);
    if (!Array.isArray(nums)) return nums;
    const guess = evalNumArg(args[1], ctx, 0.1);
    if (typeof guess !== "number") return guess;
    const res = irrCalc(nums, guess);
    return res === null ? errVal("#NUM!") : numVal(res);
  },
  NPER: (args, ctx) => {
    if (args.length < 3 || args.length > 5) return errVal("#VALUE!");
    const r = evalNumArg(args[0], ctx);
    const pmt = evalNumArg(args[1], ctx);
    const pv = evalNumArg(args[2], ctx);
    const fv = evalNumArg(args[3], ctx, 0);
    const t = evalNumArg(args[4], ctx, 0);
    if (typeof r !== "number") return r;
    if (typeof pmt !== "number") return pmt;
    if (typeof pv !== "number") return pv;
    if (typeof fv !== "number") return fv;
    if (typeof t !== "number") return t;
    if (r === 0) return pmt === 0 ? errVal("#DIV/0!") : numVal(-(pv + fv) / pmt);
    const adj = pmt * (1 + r * t);
    const num = adj - fv * r;
    const den = pv * r + adj;
    if (num / den <= 0) return errVal("#NUM!");
    return numVal(Math.log(num / den) / Math.log(1 + r));
  },
  RATE: (args, ctx) => {
    if (args.length < 3 || args.length > 6) return errVal("#VALUE!");
    const nper = evalNumArg(args[0], ctx);
    const pmt = evalNumArg(args[1], ctx);
    const pv = evalNumArg(args[2], ctx);
    const fv = evalNumArg(args[3], ctx, 0);
    const t = evalNumArg(args[4], ctx, 0);
    const guess = evalNumArg(args[5], ctx, 0.1);
    if (typeof nper !== "number") return nper;
    if (typeof pmt !== "number") return pmt;
    if (typeof pv !== "number") return pv;
    if (typeof fv !== "number") return fv;
    if (typeof t !== "number") return t;
    if (typeof guess !== "number") return guess;
    let rate = guess;
    for (let i = 0; i < 100; i++) {
      const f = fvCalc(rate, nper, pmt, pv, t) - fv;
      if (Math.abs(f) < 1e-7) return numVal(rate);
      const eps = 1e-6;
      const df = (fvCalc(rate + eps, nper, pmt, pv, t) - fv - f) / eps;
      if (Math.abs(df) < 1e-12) return errVal("#NUM!");
      rate -= f / df;
    }
    return errVal("#NUM!");
  },

  // ---- Dynamic Arrays ----
  FILTER: (args, ctx) => {
    if (args.length < 2 || args.length > 3) return errVal("#VALUE!");
    const data = getMatrix(args[0], ctx);
    const include = getMatrix(args[1], ctx);
    if (!Array.isArray(data)) return data;
    if (!Array.isArray(include)) return include;
    const out: EvalValue[][] = [];
    if (include.length === data.length) {
      for (let r = 0; r < data.length; r++) {
        const b = toBoolean(include[r][0] ?? EMPTY_VAL);
        if (typeof b !== "boolean") return b;
        if (b) out.push(data[r]);
      }
    } else if (include.length === 1 && include[0].length === (data[0]?.length ?? 0)) {
      const keepCols: number[] = [];
      for (let c = 0; c < include[0].length; c++) {
        const b = toBoolean(include[0][c]);
        if (typeof b !== "boolean") return b;
        if (b) keepCols.push(c);
      }
      if (keepCols.length) {
        for (const row of data) out.push(keepCols.map((c) => row[c]));
      }
    } else {
      return errVal("#VALUE!");
    }
    if (!out.length) return args[2] && !isMissingArg(args[2]) ? ctx.evalAst(args[2]) : errVal("#CALC!");
    return arrVal(out);
  },
  SORT: (args, ctx) => {
    if (args.length < 1 || args.length > 3) return errVal("#VALUE!");
    const mat = getMatrix(args[0], ctx);
    if (!Array.isArray(mat)) return mat;
    const sortIdx = evalNumArg(args[1], ctx, 1);
    const sortOrder = evalNumArg(args[2], ctx, 1);
    if (typeof sortIdx !== "number") return sortIdx;
    if (typeof sortOrder !== "number") return sortOrder;
    const ci = Math.trunc(sortIdx) - 1;
    if (ci < 0 || ci >= (mat[0]?.length ?? 0)) return errVal("#VALUE!");
    const asc = sortOrder >= 0;
    const copy = mat.map((r) => [...r]);
    copy.sort((a, b) => {
      const cmp = compareValues(a[ci], b[ci]);
      return asc ? cmp : -cmp;
    });
    return arrVal(copy);
  },
  SORTBY: (args, ctx) => {
    if (args.length < 2) return errVal("#VALUE!");
    const mat = getMatrix(args[0], ctx);
    const by = getMatrix(args[1], ctx);
    if (!Array.isArray(mat)) return mat;
    if (!Array.isArray(by)) return by;
    const order = evalNumArg(args[2], ctx, 1);
    if (typeof order !== "number") return order;
    if (by.length !== mat.length) return errVal("#VALUE!");
    const asc = order >= 0;
    const indexed = mat.map((row, i) => ({ row, key: by[i][0] ?? EMPTY_VAL }));
    indexed.sort((a, b) => (asc ? compareValues(a.key, b.key) : -compareValues(a.key, b.key)));
    return arrVal(indexed.map((x) => x.row));
  },
  UNIQUE: (args, ctx) => {
    if (args.length < 1 || args.length > 3) return errVal("#VALUE!");
    const mat = getMatrix(args[0], ctx);
    if (!Array.isArray(mat)) return mat;
    const seen = new Set<string>();
    const out: EvalValue[][] = [];
    for (const row of mat) {
      const key = row.map((v) => `${v.kind}:${toStringValue(v).toLowerCase()}`).join("\u001f");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return arrVal(out);
  },
  SEQUENCE: (args, ctx) => {
    if (args.length < 1 || args.length > 4) return errVal("#VALUE!");
    const rows = evalNumArg(args[0], ctx);
    const cols = evalNumArg(args[1], ctx, 1);
    const start = evalNumArg(args[2], ctx, 1);
    const step = evalNumArg(args[3], ctx, 1);
    if (typeof rows !== "number") return rows;
    if (typeof cols !== "number") return cols;
    if (typeof start !== "number") return start;
    if (typeof step !== "number") return step;
    const r = Math.trunc(rows);
    const c = Math.trunc(cols);
    if (r < 1 || c < 1 || r * c > 10000) return errVal("#NUM!");
    const out: EvalValue[][] = [];
    let cur = start;
    for (let i = 0; i < r; i++) {
      const line: EvalValue[] = [];
      for (let j = 0; j < c; j++) {
        line.push(numVal(cur));
        cur += step;
      }
      out.push(line);
    }
    return arrVal(out);
  },

  // ---- Modern Regex, Functional, Array, Query & Media ----
  REGEXMATCH: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const text = evalStrArg(args[0], ctx);
    const pattern = evalStrArg(args[1], ctx);
    if (typeof text !== "string") return text;
    if (typeof pattern !== "string") return pattern;
    const re = compileSafeRegex(pattern);
    if (!re) return errVal("#VALUE!");
    return boolVal(re.test(text));
  },
  REGEXREPLACE: (args, ctx) => {
    if (args.length !== 3) return errVal("#VALUE!");
    const text = evalStrArg(args[0], ctx);
    const pattern = evalStrArg(args[1], ctx);
    const replacement = evalStrArg(args[2], ctx);
    if (typeof text !== "string") return text;
    if (typeof pattern !== "string") return pattern;
    if (typeof replacement !== "string") return replacement;
    const re = compileSafeRegex(pattern, "g");
    if (!re) return errVal("#VALUE!");
    return strVal(text.replace(re, replacement));
  },
  REGEXEXTRACT: (args, ctx) => {
    if (args.length !== 2) return errVal("#VALUE!");
    const text = evalStrArg(args[0], ctx);
    const pattern = evalStrArg(args[1], ctx);
    if (typeof text !== "string") return text;
    if (typeof pattern !== "string") return pattern;
    const re = compileSafeRegex(pattern);
    if (!re) return errVal("#VALUE!");
    const m = re.exec(text);
    if (!m) return errVal("#N/A");
    if (m.length > 1) {
      if (m[1] !== undefined) return strVal(m[1]);
      for (let i = 2; i < m.length; i++) {
        if (m[i] !== undefined) return strVal(m[i]);
      }
      return strVal("");
    }
    return strVal(m[0]);
  },
  LET: (args, ctx) => {
    if (args.length < 3 || args.length % 2 !== 1) return errVal("#VALUE!");
    const baseEnv = ctx.getEnv ? ctx.getEnv() : new Map<string, EvalValue>();
    const localEnv = new Map<string, EvalValue>(baseEnv);
    const evalIn = (node: FormulaAst) =>
      ctx.evalAstWithEnv ? ctx.evalAstWithEnv(node, localEnv, ctx.arrayMode) : ctx.evalAst(node);
    for (let i = 0; i < args.length - 1; i += 2) {
      const nameNode = args[i];
      if (nameNode.kind !== "name" || !nameNode.name.trim()) return errVal("#VALUE!");
      const key = nameNode.name.toUpperCase();
      const val = evalIn(args[i + 1]);
      localEnv.set(key, val);
    }
    return evalIn(args[args.length - 1]);
  },
  LAMBDA: (args, ctx) => {
    if (args.length < 1) return errVal("#VALUE!");
    const params: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < args.length - 1; i++) {
      const paramNode = args[i];
      if (paramNode.kind !== "name" || !paramNode.name.trim()) return errVal("#VALUE!");
      const upper = paramNode.name.toUpperCase();
      if (seen.has(upper)) return errVal("#VALUE!");
      seen.add(upper);
      params.push(upper);
    }
    const body = args[args.length - 1];
    if (isMissingArg(body)) return errVal("#VALUE!");
    const closure: LambdaEvalValue = {
      kind: "lambda",
      value: "#CALC!",
      params,
      body,
      env: new Map(ctx.getEnv ? ctx.getEnv() : []),
      sheetId: ctx.sheetId,
    };
    return closure as unknown as EvalValue;
  },
  ARRAYFORMULA: (args, ctx) => {
    if (args.length !== 1 || isMissingArg(args[0])) return errVal("#VALUE!");
    const env = ctx.getEnv ? ctx.getEnv() : new Map<string, EvalValue>();
    return ctx.evalAstWithEnv ? ctx.evalAstWithEnv(args[0], env, true) : ctx.evalAst(args[0]);
  },
  QUERY: (args, ctx) => {
    if (args.length < 1 || args.length > 3) return errVal("#VALUE!");
    const mat = getMatrix(args[0], ctx);
    if (!Array.isArray(mat)) return mat;
    const queryStr = args.length >= 2 && !isMissingArg(args[1]) ? evalStrArg(args[1], ctx) : "";
    if (typeof queryStr !== "string") return queryStr;
    let headersArg: number | undefined;
    if (args.length === 3 && !isMissingArg(args[2])) {
      const h = evalNumArg(args[2], ctx);
      if (typeof h !== "number") return h;
      headersArg = h;
    }
    let startCol = 0;
    if (args[0].kind === "range") {
      const resolved = ctx.resolveRange(args[0]);
      if (resolved) startCol = resolved.left;
    }
    return evaluateQuery(mat, queryStr, startCol, headersArg, () => ctx.tickOp());
  },
  IMAGE: (args, ctx) => {
    if (args.length < 1 || args.length > 5) return errVal("#VALUE!");
    const urlRaw = evalStrArg(args[0], ctx);
    if (typeof urlRaw !== "string") return urlRaw;
    const url = urlRaw.trim();
    if (!isSafeSheetImageUrl(url)) return errVal("#VALUE!");
    let alt: string | undefined;
    let mode = 1;
    if (args.length >= 2 && !isMissingArg(args[1])) {
      const second = unwrapScalar(ctx.evalAst(args[1]));
      if (second.kind === "error") return second;
      if (args.length === 2 && second.kind === "number") {
        // Google Sheets compatibility: IMAGE(url, mode)
        const m = Math.trunc(second.value);
        if (m < 0 || m > 4) return errVal("#VALUE!");
        mode = m;
      } else {
        alt = toStringValue(second);
      }
    }
    if (args.length >= 3 && !isMissingArg(args[2])) {
      const m = evalNumArg(args[2], ctx);
      if (typeof m !== "number") return m;
      const mi = Math.trunc(m);
      if (mi < 0 || mi > 4) return errVal("#VALUE!");
      mode = mi;
    }
    return imgVal(url, alt, mode);
  },
};

/** Pure scalar built-in functions that broadcast element-wise inside ARRAYFORMULA(...). */
export const ARRAY_LIFTABLE_FUNCTIONS: ReadonlySet<string> = new Set([
  "ABS", "INT", "SQRT", "SIGN", "EXP", "LN", "LOG10", "LOG", "SIN", "COS", "TAN",
  "ROUND", "ROUNDUP", "ROUNDDOWN", "TRUNC", "MROUND", "CEILING", "FLOOR", "MOD", "POWER",
  "LEN", "UPPER", "LOWER", "PROPER", "TRIM", "CLEAN", "LEFT", "RIGHT", "MID",
  "FIND", "SEARCH", "SUBSTITUTE", "REPLACE", "TEXT", "VALUE", "REPT", "EXACT", "CHAR", "CODE",
  "REGEXMATCH", "REGEXREPLACE", "REGEXEXTRACT",
  "NOT", "ISBLANK", "ISERROR", "ISERR", "ISNA", "ISNUMBER", "ISTEXT", "ISLOGICAL",
  "YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "WEEKDAY", "WEEKNUM", "ISOWEEKNUM", "DATEVALUE",
  "IMAGE",
]);

export const SUPPORTED_FORMULA_FUNCTIONS: readonly string[] = Object.freeze(Object.keys(BUILTIN_FUNCTIONS).sort());

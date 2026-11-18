import type { SheetCell, SheetCellStyle, SheetCellWrite, SheetMerge, SheetWorksheet } from "@/lib/api";
import { columnName, pointKey, selectionBounds, sheetAddress, type SheetPoint, type SheetSelection } from "@jiange/sheet-sdk/grid";

export type EvalValue =
  | { kind: "empty"; value: ""; error?: undefined }
  | { kind: "number"; value: number; error?: undefined }
  | { kind: "string"; value: string; error?: undefined }
  | { kind: "boolean"; value: boolean; error?: undefined }
  | { kind: "error"; value: string; error: string };

export interface FormulaRefHighlight {
  sheetId: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
  color: string;
  text: string;
}

export const FORMULA_REF_PALETTE = ["#ff8800", "#7b56d9", "#1456f0", "#00b42a", "#d83931"] as const;

const MAX_TOKENS = 2048;
const MAX_DEPTH = 64;
const MAX_OPS = 50000;

export function parseA1Token(text: string): { row: number; col: number; rowAbs: boolean; colAbs: boolean } | null {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})$/.exec(text);
  if (!m) return null;
  let col = 0;
  for (const ch of m[2].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  const row = Number(m[4]);
  if (col < 1 || col > 16384 || row < 1 || row > 1048576) return null;
  return { row: row - 1, col: col - 1, colAbs: !!m[1], rowAbs: !!m[3] };
}

export function parseRangeInput(text: string): { anchor: SheetPoint; focus: SheetPoint } | null {
  const clean = text.trim();
  if (!clean) return null;
  const parts = clean.split(":");
  if (parts.length > 2) return null;
  const a = parseA1Token(parts[0].trim());
  if (!a) return null;
  if (parts.length === 1) return { anchor: { row: a.row, col: a.col }, focus: { row: a.row, col: a.col } };
  const b = parseA1Token(parts[1].trim());
  if (!b) return null;
  return { anchor: { row: a.row, col: a.col }, focus: { row: b.row, col: b.col } };
}

export function formatSelectionAddress(selection: SheetSelection): string {
  const b = selectionBounds(selection);
  const start = sheetAddress({ row: b.top, col: b.left });
  if (b.top === b.bottom && b.left === b.right) return start;
  return `${start}:${sheetAddress({ row: b.bottom, col: b.right })}`;
}

export function buildWorksheetGridMap(ws: SheetWorksheet) {
  const rowPosById = new Map<number, number>();
  const colPosById = new Map<number, number>();
  ws.rows.forEach((r, idx) => rowPosById.set(r.id, idx));
  ws.columns.forEach((c, idx) => colPosById.set(c.id, idx));
  const cellByKey = new Map<string, SheetCell>();
  for (const cell of ws.cells) {
    const r = rowPosById.get(cell.rowId);
    const c = colPosById.get(cell.columnId);
    if (r === undefined || c === undefined) continue;
    cellByKey.set(`${r}:${c}`, cell);
  }
  return { rowPosById, colPosById, cellByKey };
}

type Token =
  | { kind: "number"; text: string; num: number }
  | { kind: "string"; text: string; str: string }
  | { kind: "bool"; text: string; bool: boolean }
  | { kind: "ref"; text: string; sheetName?: string; ref: { row: number; col: number; rowAbs: boolean; colAbs: boolean } }
  | { kind: "badref"; text: string }
  | { kind: "name"; text: string }
  | { kind: "op"; text: string };

function tokenizeFormula(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) {
      i++;
      continue;
    }
    const rest = expr.slice(i);
    if (rest[0] === '"') {
      let end = 1;
      let str = "";
      let closed = false;
      while (end < rest.length) {
        if (rest[end] === '"') {
          if (rest[end + 1] === '"') {
            str += '"';
            end += 2;
            continue;
          }
          closed = true;
          end++;
          break;
        }
        str += rest[end++];
      }
      if (!closed) return null;
      tokens.push({ kind: "string", text: rest.slice(0, end), str });
      i += end;
    } else if (rest.startsWith("#REF!")) {
      tokens.push({ kind: "badref", text: "#REF!" });
      i += 5;
    } else {
      const sheetRef = /^(?:'((?:[^']|'')+)'|([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]{0,30}))!(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})/.exec(rest);
      if (sheetRef) {
        const sheetName = sheetRef[1] !== undefined ? sheetRef[1].replace(/''/g, "'") : sheetRef[2];
        const parsed = parseA1Token(sheetRef[3]);
        if (!parsed) tokens.push({ kind: "badref", text: sheetRef[0] });
        else tokens.push({ kind: "ref", text: sheetRef[0], sheetName, ref: parsed });
        i += sheetRef[0].length;
      } else {
        const numMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
        if (numMatch) {
          tokens.push({ kind: "number", text: numMatch[0], num: Number(numMatch[0]) });
          i += numMatch[0].length;
        } else {
          const twoCharOp = /^(?:<>|<=|>=)/.exec(rest);
          if (twoCharOp) {
            tokens.push({ kind: "op", text: twoCharOp[0] });
            i += 2;
          } else if ("+-*/^%(),:&=<>".includes(rest[0])) {
            tokens.push({ kind: "op", text: rest[0] });
            i++;
          } else {
            const word = /^(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}|[A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
            if (!word) return null;
            const upper = word[0].toUpperCase();
            if ((upper === "TRUE" || upper === "FALSE") && !/^\s*\(/.test(rest.slice(word[0].length))) {
              tokens.push({ kind: "bool", text: word[0], bool: upper === "TRUE" });
            } else {
              const ref = parseA1Token(word[0]);
              if (ref && !/^\s*\(/.test(rest.slice(word[0].length))) {
                tokens.push({ kind: "ref", text: word[0], ref });
              } else {
                tokens.push({ kind: "name", text: word[0] });
              }
            }
            i += word[0].length;
          }
        }
      }
    }
    if (tokens.length > MAX_TOKENS) return null;
  }
  return tokens;
}

const errVal = (code: string): EvalValue => ({ kind: "error", value: code, error: code });
const numVal = (n: number): EvalValue => (Number.isFinite(n) ? { kind: "number", value: n === 0 ? 0 : n } : errVal("#NUM!"));
const strVal = (s: string): EvalValue => ({ kind: "string", value: s });
const boolVal = (b: boolean): EvalValue => ({ kind: "boolean", value: b });

function toNumber(v: EvalValue): number | EvalValue {
  if (v.kind === "error") return v;
  if (v.kind === "empty") return 0;
  if (v.kind === "number") return v.value;
  if (v.kind === "boolean") return v.value ? 1 : 0;
  const trimmed = v.value.trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : errVal("#VALUE!");
}

function toBoolean(v: EvalValue): boolean | EvalValue {
  if (v.kind === "error") return v;
  if (v.kind === "empty") return false;
  if (v.kind === "boolean") return v.value;
  if (v.kind === "number") return v.value !== 0;
  const up = v.value.trim().toUpperCase();
  if (up === "TRUE") return true;
  if (up === "FALSE") return false;
  return errVal("#VALUE!");
}

function toStringValue(v: EvalValue): string {
  if (v.kind === "empty") return "";
  if (v.kind === "boolean") return v.value ? "TRUE" : "FALSE";
  return String(v.value);
}

function compareValues(a: EvalValue, b: EvalValue): number {
  if (a.kind === "empty" && b.kind === "empty") return 0;
  if (a.kind === "empty") return b.kind === "number" ? -Math.sign(b.value) : b.kind === "boolean" ? -1 : "".localeCompare(toStringValue(b));
  if (b.kind === "empty") return a.kind === "number" ? Math.sign(a.value) : a.kind === "boolean" ? 1 : toStringValue(a).localeCompare("");
  if (a.kind === "number" && b.kind === "number") return a.value - b.value;
  if (a.kind === "boolean" && b.kind === "boolean") return Number(a.value) - Number(b.value);
  return toStringValue(a).toLowerCase().localeCompare(toStringValue(b).toLowerCase());
}

function matchCriteria(cell: EvalValue, criteria: EvalValue): boolean {
  if (cell.kind === "error" || criteria.kind === "error") return false;
  const critStr = toStringValue(criteria);
  const opMatch = /^(>=|<=|<>|>|<|=)(.*)$/.exec(critStr);
  if (opMatch) {
    const op = opMatch[1];
    const rhsRaw = opMatch[2].trim();
    const rhsNum = rhsRaw !== "" && Number.isFinite(Number(rhsRaw)) ? Number(rhsRaw) : null;
    const lhsNum = cell.kind === "number" ? cell.value : null;
    if (rhsNum !== null && lhsNum !== null) {
      if (op === ">=") return lhsNum >= rhsNum;
      if (op === "<=") return lhsNum <= rhsNum;
      if (op === "<>") return lhsNum !== rhsNum;
      if (op === ">") return lhsNum > rhsNum;
      if (op === "<") return lhsNum < rhsNum;
      return lhsNum === rhsNum;
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
  return toStringValue(cell).toLowerCase() === critStr.toLowerCase();
}

export function calculateWorkbook(sheets: readonly SheetWorksheet[]): Map<number, Record<string, EvalValue>> {
  const sheetMap = new Map<number, { ws: SheetWorksheet; grid: Map<string, SheetCell> }>();
  const byTitle = new Map<string, number>();
  for (const ws of sheets) {
    const { cellByKey } = buildWorksheetGridMap(ws);
    sheetMap.set(ws.id, { ws, grid: cellByKey });
    byTitle.set(ws.title.trim().toLowerCase(), ws.id);
  }

  const cache = new Map<string, EvalValue>();
  const active = new Set<string>();
  let ops = 0;

  const evalScalarRaw = (raw: string): EvalValue => {
    if (!raw) return { kind: "empty", value: "" };
    const trimmed = raw.trim();
    if (!trimmed) return { kind: "string", value: raw };
    if (/^(true|false)$/i.test(trimmed)) return boolVal(trimmed.toUpperCase() === "TRUE");
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return numVal(n);
    }
    return strVal(raw);
  };

  const evalCell = (sheetId: number, row: number, col: number, depth: number): EvalValue => {
    const entry = sheetMap.get(sheetId);
    if (!entry || row < 0 || row >= entry.ws.rows.length || col < 0 || col >= entry.ws.columns.length) {
      return errVal("#REF!");
    }
    const cKey = `${sheetId}:${row}:${col}`;
    const cached = cache.get(cKey);
    if (cached !== undefined) return cached;
    if (active.has(cKey)) return errVal("#CYCLE!");
    if (depth > MAX_DEPTH || ++ops > MAX_OPS) return errVal("#LIMIT!");

    const cell = entry.grid.get(`${row}:${col}`);
    const raw = cell?.raw ?? "";
    if (!raw.startsWith("=")) {
      const val = evalScalarRaw(raw);
      cache.set(cKey, val);
      return val;
    }

    active.add(cKey);
    const tokens = tokenizeFormula(raw.slice(1));
    let pos = 0;

    const resolveTargetSheet = (name?: string): number | null => {
      if (!name) return sheetId;
      return byTitle.get(name.trim().toLowerCase()) ?? null;
    };

    type RangeRef = { sheetId: number; top: number; left: number; bottom: number; right: number };

    const tryConsumeRange = (): RangeRef | null => {
      const t0 = tokens?.[pos];
      if (!t0 || t0.kind !== "ref") return null;
      const t1 = tokens?.[pos + 1];
      const t2 = tokens?.[pos + 2];
      if (t1?.kind === "op" && t1.text === ":" && t2?.kind === "ref" && !t2.sheetName) {
        const sid = resolveTargetSheet(t0.sheetName);
        pos += 3;
        if (sid === null) return { sheetId: -1, top: 0, left: 0, bottom: 0, right: 0 };
        return {
          sheetId: sid,
          top: Math.min(t0.ref.row, t2.ref.row),
          left: Math.min(t0.ref.col, t2.ref.col),
          bottom: Math.max(t0.ref.row, t2.ref.row),
          right: Math.max(t0.ref.col, t2.ref.col),
        };
      }
      return null;
    };

    const parsePrimary = (nesting: number): EvalValue => {
      if (nesting > MAX_DEPTH || ++ops > MAX_OPS) return errVal("#LIMIT!");
      const tok = tokens?.[pos++];
      if (!tok) return errVal("#ERROR!");
      if (tok.kind === "number") return numVal(tok.num);
      if (tok.kind === "string") return strVal(tok.str);
      if (tok.kind === "bool") return boolVal(tok.bool);
      if (tok.kind === "badref") return errVal("#REF!");
      if (tok.kind === "ref") {
        const sid = resolveTargetSheet(tok.sheetName);
        if (sid === null) return errVal("#REF!");
        return evalCell(sid, tok.ref.row, tok.ref.col, depth + 1);
      }
      if (tok.kind === "op" && (tok.text === "+" || tok.text === "-")) {
        const inner = parseUnary(nesting + 1);
        const n = toNumber(inner);
        if (typeof n !== "number") return n;
        return numVal(tok.text === "-" ? -n : n);
      }
      if (tok.kind === "op" && tok.text === "(") {
        const inner = parseExpr(0, nesting + 1);
        if (tokens?.[pos]?.kind !== "op" || tokens[pos].text !== ")") return errVal("#ERROR!");
        pos++;
        return inner;
      }
      if (tok.kind === "name") {
        const fn = tok.text.toUpperCase();
        if (tokens?.[pos]?.kind !== "op" || tokens[pos].text !== "(") return errVal("#NAME?");
        pos++;

        // Lazy control-flow functions evaluate only the taken branch.
        if (fn === "IF") {
          const cond = parseExpr(0, nesting + 1);
          const b = toBoolean(cond);
          if (typeof b !== "boolean") {
            // Skip remaining args to validate parens or return error.
            return b;
          }
          if (tokens?.[pos]?.kind !== "op" || tokens[pos].text !== ",") return errVal("#ERROR!");
          pos++;
          if (b) {
            const thenVal = parseExpr(0, nesting + 1);
            if (tokens?.[pos]?.kind === "op" && tokens[pos].text === ",") {
              pos++;
              // Skip second branch syntactically without forcing #CYCLE! unless taken.
              let depthParen = 0;
              while (pos < (tokens?.length ?? 0)) {
                const t = tokens![pos];
                if (t.kind === "op" && t.text === "(") depthParen++;
                else if (t.kind === "op" && t.text === ")") {
                  if (depthParen === 0) break;
                  depthParen--;
                }
                pos++;
              }
            }
            if (tokens?.[pos++]?.text !== ")") return errVal("#ERROR!");
            return thenVal;
          }
          let depthParen = 0;
          while (pos < (tokens?.length ?? 0)) {
            const t = tokens![pos];
            if (t.kind === "op" && t.text === "(") depthParen++;
            else if (t.kind === "op" && t.text === ")") {
              if (depthParen === 0) {
                pos++;
                return boolVal(false);
              }
              depthParen--;
            } else if (depthParen === 0 && t.kind === "op" && t.text === ",") {
              pos++;
              break;
            }
            pos++;
          }
          const elseVal = parseExpr(0, nesting + 1);
          if (tokens?.[pos++]?.text !== ")") return errVal("#ERROR!");
          return elseVal;
        }

        const collectRangeValues = (range: RangeRef, numericOnly: boolean): EvalValue[] | EvalValue => {
          const target = sheetMap.get(range.sheetId);
          if (!target) return errVal("#REF!");
          if (range.bottom >= target.ws.rows.length || range.right >= target.ws.columns.length) return errVal("#REF!");
          const collected: EvalValue[] = [];
          for (let r = range.top; r <= range.bottom; r++) {
            for (let c = range.left; c <= range.right; c++) {
              if (++ops > MAX_OPS) return errVal("#LIMIT!");
              const rawCell = target.grid.get(`${r}:${c}`)?.raw ?? "";
              if (!rawCell) continue;
              const ev = evalCell(range.sheetId, r, c, depth + 1);
              if (ev.kind === "error") return ev;
              if (numericOnly) {
                if (ev.kind === "number") collected.push(ev);
              } else if (ev.kind !== "empty") {
                collected.push(ev);
              }
            }
          }
          return collected;
        };

        type FnArg = { kind: "range"; range: RangeRef } | { kind: "value"; value: EvalValue };
        const args: FnArg[] = [];
        if (!(tokens?.[pos]?.kind === "op" && tokens[pos].text === ")")) {
          while (true) {
            const range = tryConsumeRange();
            if (range) {
              args.push({ kind: "range", range });
            } else {
              args.push({ kind: "value", value: parseExpr(0, nesting + 1) });
            }
            if (tokens?.[pos]?.kind === "op" && tokens[pos].text === ",") {
              pos++;
              continue;
            }
            break;
          }
        }
        if (tokens?.[pos++]?.text !== ")") return errVal("#ERROR!");

        const flattenNumbers = (skipTextInRanges: boolean): number[] | EvalValue => {
          const nums: number[] = [];
          for (const arg of args) {
            if (arg.kind === "range") {
              const vals = collectRangeValues(arg.range, skipTextInRanges);
              if (!Array.isArray(vals)) return vals;
              for (const v of vals) {
                const n = toNumber(v);
                if (typeof n !== "number") return n;
                nums.push(n);
              }
            } else {
              if (arg.value.kind === "error") return arg.value;
              const n = toNumber(arg.value);
              if (typeof n !== "number") return n;
              nums.push(n);
            }
          }
          return nums;
        };

        switch (fn) {
          case "SUM":
          case "AVERAGE":
          case "MIN":
          case "MAX":
          case "COUNT": {
            const nums = flattenNumbers(true);
            if (!Array.isArray(nums)) return nums;
            if (fn === "COUNT") return numVal(nums.length);
            if (fn === "SUM") return numVal(nums.reduce((a, b) => a + b, 0));
            if (fn === "AVERAGE") return nums.length ? numVal(nums.reduce((a, b) => a + b, 0) / nums.length) : errVal("#DIV/0!");
            if (!nums.length) return numVal(0);
            return numVal(fn === "MIN" ? Math.min(...nums) : Math.max(...nums));
          }
          case "COUNTA": {
            let count = 0;
            for (const arg of args) {
              if (arg.kind === "range") {
                const vals = collectRangeValues(arg.range, false);
                if (!Array.isArray(vals)) return vals;
                count += vals.length;
              } else if (arg.value.kind !== "empty") {
                count++;
              }
            }
            return numVal(count);
          }
          case "IFERROR": {
            if (args.length !== 2 || args[0].kind === "range" || args[1].kind === "range") return errVal("#VALUE!");
            return args[0].value.kind === "error" ? args[1].value : args[0].value;
          }
          case "AND":
          case "OR": {
            if (!args.length) return errVal("#VALUE!");
            const bools: boolean[] = [];
            for (const arg of args) {
              if (arg.kind === "range") {
                const vals = collectRangeValues(arg.range, false);
                if (!Array.isArray(vals)) return vals;
                for (const v of vals) {
                  const b = toBoolean(v);
                  if (typeof b !== "boolean") return b;
                  bools.push(b);
                }
              } else {
                const b = toBoolean(arg.value);
                if (typeof b !== "boolean") return b;
                bools.push(b);
              }
            }
            return boolVal(fn === "AND" ? bools.every(Boolean) : bools.some(Boolean));
          }
          case "NOT": {
            if (args.length !== 1 || args[0].kind === "range") return errVal("#VALUE!");
            const b = toBoolean(args[0].value);
            return typeof b === "boolean" ? boolVal(!b) : b;
          }
          case "ABS":
          case "INT":
          case "SQRT": {
            if (args.length !== 1 || args[0].kind === "range") return errVal("#VALUE!");
            const n = toNumber(args[0].value);
            if (typeof n !== "number") return n;
            if (fn === "ABS") return numVal(Math.abs(n));
            if (fn === "INT") return numVal(Math.floor(n));
            return n < 0 ? errVal("#NUM!") : numVal(Math.sqrt(n));
          }
          case "ROUND": {
            if (args.length < 1 || args.length > 2 || args[0].kind === "range") return errVal("#VALUE!");
            const n = toNumber(args[0].value);
            if (typeof n !== "number") return n;
            const digits = args[1] ? (args[1].kind === "range" ? errVal("#VALUE!") : toNumber(args[1].value)) : 0;
            if (typeof digits !== "number") return digits;
            const factor = 10 ** Math.trunc(digits);
            return numVal(Math.round(n * factor) / factor);
          }
          case "MOD":
          case "POWER": {
            if (args.length !== 2 || args[0].kind === "range" || args[1].kind === "range") return errVal("#VALUE!");
            const a = toNumber(args[0].value);
            const b = toNumber(args[1].value);
            if (typeof a !== "number") return a;
            if (typeof b !== "number") return b;
            if (fn === "MOD") return b === 0 ? errVal("#DIV/0!") : numVal(((a % b) + b) % b);
            return numVal(a ** b);
          }
          case "CONCAT": {
            let out = "";
            for (const arg of args) {
              if (arg.kind === "range") {
                const vals = collectRangeValues(arg.range, false);
                if (!Array.isArray(vals)) return vals;
                for (const v of vals) out += toStringValue(v);
              } else {
                if (arg.value.kind === "error") return arg.value;
                out += toStringValue(arg.value);
              }
            }
            return strVal(out);
          }
          case "LEN":
          case "UPPER":
          case "LOWER":
          case "TRIM": {
            if (args.length !== 1 || args[0].kind === "range") return errVal("#VALUE!");
            if (args[0].value.kind === "error") return args[0].value;
            const s = toStringValue(args[0].value);
            if (fn === "LEN") return numVal(Array.from(s).length);
            if (fn === "UPPER") return strVal(s.toUpperCase());
            if (fn === "LOWER") return strVal(s.toLowerCase());
            return strVal(s.trim().replace(/\s+/g, " "));
          }
          case "LEFT":
          case "RIGHT": {
            if (args.length < 1 || args.length > 2 || args[0].kind === "range") return errVal("#VALUE!");
            if (args[0].value.kind === "error") return args[0].value;
            const chars = Array.from(toStringValue(args[0].value));
            const countVal = args[1] ? (args[1].kind === "range" ? errVal("#VALUE!") : toNumber(args[1].value)) : 1;
            if (typeof countVal !== "number") return countVal;
            const n = Math.trunc(countVal);
            if (n < 0) return errVal("#VALUE!");
            return strVal(fn === "LEFT" ? chars.slice(0, n).join("") : chars.slice(Math.max(0, chars.length - n)).join(""));
          }
          case "COUNTIF":
          case "SUMIF": {
            if (args.length < 2 || args.length > 3 || args[0].kind !== "range" || args[1].kind === "range") return errVal("#VALUE!");
            const rA = args[0].range;
            const criteria = args[1].value;
            if (criteria.kind === "error") return criteria;
            const rB = args[2]?.kind === "range" ? args[2].range : rA;
            const tA = sheetMap.get(rA.sheetId);
            const tB = sheetMap.get(rB.sheetId);
            if (!tA || !tB || rA.bottom >= tA.ws.rows.length || rA.right >= tA.ws.columns.length || rB.bottom >= tB.ws.rows.length || rB.right >= tB.ws.columns.length) {
              return errVal("#REF!");
            }
            const h = rA.bottom - rA.top + 1;
            const w = rA.right - rA.left + 1;
            let count = 0;
            let sum = 0;
            for (let dr = 0; dr < h; dr++) {
              for (let dc = 0; dc < w; dc++) {
                if (++ops > MAX_OPS) return errVal("#LIMIT!");
                const evA = evalCell(rA.sheetId, rA.top + dr, rA.left + dc, depth + 1);
                if (evA.kind === "error") return evA;
                if (!matchCriteria(evA, criteria)) continue;
                count++;
                if (fn === "SUMIF") {
                  const targetRow = rB.top + dr;
                  const targetCol = rB.left + dc;
                  if (targetRow >= tB.ws.rows.length || targetCol >= tB.ws.columns.length) continue;
                  const evB = evalCell(rB.sheetId, targetRow, targetCol, depth + 1);
                  if (evB.kind === "error") return evB;
                  if (evB.kind === "number") sum += evB.value;
                }
              }
            }
            return numVal(fn === "COUNTIF" ? count : sum);
          }
          case "PI":
            return args.length ? errVal("#VALUE!") : numVal(Math.PI);
          case "TODAY":
            return args.length ? errVal("#VALUE!") : strVal(new Date().toISOString().slice(0, 10));
          case "NOW":
            return args.length ? errVal("#VALUE!") : strVal(new Date().toISOString().slice(0, 16).replace("T", " "));
          default:
            return errVal("#NAME?");
        }
      }
      return errVal("#ERROR!");
    };

    const parseUnary = (nesting: number): EvalValue => {
      let val = parsePrimary(nesting);
      while (tokens?.[pos]?.kind === "op" && tokens[pos].text === "%") {
        pos++;
        const n = toNumber(val);
        val = typeof n === "number" ? numVal(n / 100) : n;
      }
      return val;
    };

    const precedenceOf = (op: string): number => {
      if (op === "=" || op === "<>" || op === "<" || op === "<=" || op === ">" || op === ">=") return 1;
      if (op === "&") return 2;
      if (op === "+" || op === "-") return 3;
      if (op === "*" || op === "/") return 4;
      if (op === "^") return 5;
      return 0;
    };

    const parseExpr = (minPrec: number, nesting: number): EvalValue => {
      if (nesting > MAX_DEPTH || ++ops > MAX_OPS) return errVal("#LIMIT!");
      let left = parseUnary(nesting + 1);
      while (tokens && pos < tokens.length && tokens[pos].kind === "op") {
        const op = tokens[pos].text;
        const prec = precedenceOf(op);
        if (!prec || prec < minPrec) break;
        pos++;
        const right = parseExpr(op === "^" ? prec : prec + 1, nesting + 1);
        if (left.kind === "error") return left;
        if (right.kind === "error") return right;
        if (op === "&") {
          left = strVal(toStringValue(left) + toStringValue(right));
        } else if (op === "=" || op === "<>" || op === "<" || op === "<=" || op === ">" || op === ">=") {
          const cmp = compareValues(left, right);
          left = boolVal(op === "=" ? cmp === 0 : op === "<>" ? cmp !== 0 : op === "<" ? cmp < 0 : op === "<=" ? cmp <= 0 : op === ">" ? cmp > 0 : cmp >= 0);
        } else {
          const a = toNumber(left);
          const b = toNumber(right);
          if (typeof a !== "number") return a;
          if (typeof b !== "number") return b;
          if (op === "+") left = numVal(a + b);
          else if (op === "-") left = numVal(a - b);
          else if (op === "*") left = numVal(a * b);
          else if (op === "/") left = b === 0 ? errVal("#DIV/0!") : numVal(a / b);
          else left = numVal(a ** b);
        }
      }
      return left;
    };

    let result = tokens ? parseExpr(0, 0) : errVal("#ERROR!");
    if (result.kind !== "error" && tokens && pos !== tokens.length) result = errVal("#ERROR!");
    if (result.kind === "number") result = numVal(Number(result.value.toPrecision(15)));
    active.delete(cKey);
    if (result.kind !== "error" || result.error !== "#LIMIT!") cache.set(cKey, result);
    return result;
  };

  const out = new Map<number, Record<string, EvalValue>>();
  for (const ws of sheets) {
    const map: Record<string, EvalValue> = {};
    const { cellByKey } = buildWorksheetGridMap(ws);
    for (const [key] of cellByKey) {
      const [row, col] = key.split(":").map(Number);
      ops = 0;
      map[key] = evalCell(ws.id, row, col, 0);
    }
    out.set(ws.id, map);
  }
  return out;
}

export function extractFormulaReferences(raw: string, activeSheetId: number, sheets: readonly SheetWorksheet[]): FormulaRefHighlight[] {
  if (!raw.startsWith("=")) return [];
  const tokens = tokenizeFormula(raw.slice(1));
  if (!tokens) return [];
  const byTitle = new Map<string, number>();
  for (const s of sheets) byTitle.set(s.title.trim().toLowerCase(), s.id);
  const out: FormulaRefHighlight[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t0 = tokens[i];
    if (t0.kind !== "ref") continue;
    const sid = t0.sheetName ? (byTitle.get(t0.sheetName.trim().toLowerCase()) ?? -1) : activeSheetId;
    const nextOp = tokens[i + 1];
    const nextRef = tokens[i + 2];
    if (nextOp?.kind === "op" && nextOp.text === ":" && nextRef?.kind === "ref" && !nextRef.sheetName) {
      const t2 = nextRef;
      if (sid > 0) {
        out.push({
          sheetId: sid,
          top: Math.min(t0.ref.row, t2.ref.row),
          left: Math.min(t0.ref.col, t2.ref.col),
          bottom: Math.max(t0.ref.row, t2.ref.row),
          right: Math.max(t0.ref.col, t2.ref.col),
          color: FORMULA_REF_PALETTE[out.length % FORMULA_REF_PALETTE.length],
          text: `${t0.text}:${t2.text}`,
        });
      }
      i += 2;
      continue;
    }
    if (sid > 0) {
      out.push({
        sheetId: sid,
        top: t0.ref.row,
        left: t0.ref.col,
        bottom: t0.ref.row,
        right: t0.ref.col,
        color: FORMULA_REF_PALETTE[out.length % FORMULA_REF_PALETTE.length],
        text: t0.text,
      });
    }
  }
  return out;
}

export function translateWorkbookFormula(raw: string, rowDelta: number, colDelta: number, maxRows: number, maxCols: number): string {
  if (!raw.startsWith("=")) return raw;
  let i = 1;
  let out = "=";
  while (i < raw.length) {
    const rest = raw.slice(i);
    if (rest[0] === '"') {
      let end = 1;
      while (end < rest.length) {
        if (rest[end] === '"') {
          if (rest[end + 1] === '"') {
            end += 2;
            continue;
          }
          end++;
          break;
        }
        end++;
      }
      out += rest.slice(0, end);
      i += end;
      continue;
    }
    const sheetRef = /^((?:'(?:[^']|'')+'|[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]{0,30})!)(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})/.exec(rest);
    if (sheetRef) {
      const parsed = parseA1Token(sheetRef[2]);
      if (!parsed) {
        out += "#REF!";
      } else {
        const nextRow = parsed.rowAbs ? parsed.row : parsed.row + rowDelta;
        const nextCol = parsed.colAbs ? parsed.col : parsed.col + colDelta;
        if (nextRow < 0 || nextCol < 0 || nextRow >= maxRows || nextCol >= maxCols) out += "#REF!";
        else out += `${sheetRef[1]}${parsed.colAbs ? "$" : ""}${columnName(nextCol)}${parsed.rowAbs ? "$" : ""}${nextRow + 1}`;
      }
      i += sheetRef[0].length;
      continue;
    }
    const word = /^(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}|[A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (word) {
      const parsed = parseA1Token(word[0]);
      if (parsed && !/^\s*\(/.test(rest.slice(word[0].length))) {
        const nextRow = parsed.rowAbs ? parsed.row : parsed.row + rowDelta;
        const nextCol = parsed.colAbs ? parsed.col : parsed.col + colDelta;
        if (nextRow < 0 || nextCol < 0 || nextRow >= maxRows || nextCol >= maxCols) out += "#REF!";
        else out += `${parsed.colAbs ? "$" : ""}${columnName(nextCol)}${parsed.rowAbs ? "$" : ""}${nextRow + 1}`;
      } else {
        out += word[0];
      }
      i += word[0].length;
      continue;
    }
    out += raw[i++];
  }
  return out;
}

export function formatCellDisplay(raw: string, evalVal: EvalValue | undefined, style?: SheetCellStyle): string {
  if (!raw && (!evalVal || evalVal.kind === "empty")) return "";
  if (evalVal?.kind === "error") return evalVal.error;
  const val = evalVal?.kind === "boolean" ? (evalVal.value ? "TRUE" : "FALSE") : evalVal?.kind === "number" ? evalVal.value : raw.startsWith("=") ? String(evalVal?.value ?? "") : raw;
  const fmt = style?.numFmt ?? "";
  if (typeof val === "number") {
    if (fmt === "currency") return `¥${val.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (fmt === "percent") return `${(val * 100).toFixed(1).replace(/\.0$/, "")}%`;
    if (fmt === "decimal2") return val.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (fmt === "decimal1") return val.toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (fmt === "integer") return Math.round(val).toLocaleString("zh-CN");
    if (fmt === "date" && val > 0 && val < 2958466) {
      const epoch = Date.UTC(1899, 11, 30) + Math.round(val) * 86400000;
      return new Date(epoch).toISOString().slice(0, 10);
    }
    return String(val);
  }
  if (fmt === "date" && typeof val === "string") {
    const ts = Date.parse(val);
    if (Number.isFinite(ts)) return new Date(ts).toISOString().slice(0, 10);
  }
  return String(val);
}

export type MergeCellInfo =
  | { kind: "master"; rowSpan: number; colSpan: number; merge: SheetMerge }
  | { kind: "covered"; masterRow: number; masterCol: number; merge: SheetMerge };

export function buildMergeLookup(merges: readonly SheetMerge[]): Map<string, MergeCellInfo> {
  const map = new Map<string, MergeCellInfo>();
  for (const merge of merges) {
    for (let r = merge.top; r <= merge.bottom; r++) {
      for (let c = merge.left; c <= merge.right; c++) {
        if (r === merge.top && c === merge.left) {
          map.set(`${r}:${c}`, {
            kind: "master",
            rowSpan: merge.bottom - merge.top + 1,
            colSpan: merge.right - merge.left + 1,
            merge,
          });
        } else {
          map.set(`${r}:${c}`, { kind: "covered", masterRow: merge.top, masterCol: merge.left, merge });
        }
      }
    }
  }
  return map;
}

export function normalizePointForMerge(point: SheetPoint, mergeLookup: Map<string, MergeCellInfo>): SheetPoint {
  const info = mergeLookup.get(pointKey(point));
  if (info?.kind === "covered") return { row: info.masterRow, col: info.masterCol };
  return point;
}

export function getVisibleRowIndices(ws: SheetWorksheet, evalMap: Record<string, EvalValue>): number[] {
  const count = ws.rows.length;
  const all = Array.from({ length: count }, (_, i) => i);
  if (!ws.filter?.enabled || !ws.filter.rules || Object.keys(ws.filter.rules).length === 0) return all;
  const headerRow = Math.max(0, ws.filter.headerRow ?? 0);
  const { cellByKey } = buildWorksheetGridMap(ws);
  const rules = Object.entries(ws.filter.rules);
  return all.filter((row) => {
    if (row <= headerRow) return true;
    for (const [colKey, rule] of rules) {
      const col = Number(colKey);
      const cell = cellByKey.get(`${row}:${col}`);
      const ev = evalMap[`${row}:${col}`];
      const text = formatCellDisplay(cell?.raw ?? "", ev, cell?.style);
      if (rule.query && !text.toLowerCase().includes(rule.query.toLowerCase())) return false;
      if (rule.values && rule.values.length > 0 && !rule.values.includes(text)) return false;
    }
    return true;
  });
}

export function computeSortedRowWrites(
  ws: SheetWorksheet,
  evalMap: Record<string, EvalValue>,
  col: number,
  ascending: boolean,
  headerRow = 0,
): SheetCellWrite[] {
  if (ws.merges.length > 0) return [];
  const { cellByKey } = buildWorksheetGridMap(ws);
  let lastNonEmpty = -1;
  for (let r = headerRow + 1; r < ws.rows.length; r++) {
    for (let c = 0; c < ws.columns.length; c++) {
      const cell = cellByKey.get(`${r}:${c}`);
      if (cell && (cell.raw !== "" || (cell.style && Object.keys(cell.style).length > 0))) {
        lastNonEmpty = r;
        break;
      }
    }
  }
  if (lastNonEmpty <= headerRow + 1) return [];
  const dataRows = Array.from({ length: lastNonEmpty - headerRow }, (_, idx) => headerRow + 1 + idx);
  const compareRows = (rA: number, rB: number) => {
    const vA = evalMap[`${rA}:${col}`];
    const vB = evalMap[`${rB}:${col}`];
    const eA = !vA || vA.kind === "empty" || (vA.kind === "string" && vA.value === "");
    const eB = !vB || vB.kind === "empty" || (vB.kind === "string" && vB.value === "");
    if (eA && eB) return rA - rB;
    if (eA) return 1;
    if (eB) return -1;
    const cmp = compareValues(vA, vB);
    return ascending ? cmp : -cmp;
  };
  const sortedIndices = [...dataRows].sort(compareRows);
  const writes: SheetCellWrite[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const targetRow = dataRows[i];
    const srcRow = sortedIndices[i];
    if (targetRow === srcRow) continue;
    for (let c = 0; c < ws.columns.length; c++) {
      const targetCell = cellByKey.get(`${targetRow}:${c}`);
      const srcCell = cellByKey.get(`${srcRow}:${c}`);
      const nextRaw = srcCell?.raw ?? "";
      const nextStyle = srcCell?.style ?? {};
      const curRaw = targetCell?.raw ?? "";
      const curStyle = targetCell?.style ?? {};
      if (nextRaw === curRaw && JSON.stringify(nextStyle) === JSON.stringify(curStyle)) continue;
      writes.push({
        rowId: ws.rows[targetRow].id,
        columnId: ws.columns[c].id,
        expectedRevision: targetCell?.revision ?? 0,
        raw: nextRaw,
        style: nextStyle,
      });
    }
  }
  return writes;
}

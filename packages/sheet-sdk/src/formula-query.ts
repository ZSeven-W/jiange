import type { EvalValue } from "./types.js";

const EMPTY: EvalValue = { kind: "empty", value: "" };
const err = (code: string): EvalValue => ({ kind: "error", value: code, error: code });
const num = (n: number): EvalValue => (Number.isFinite(n) ? { kind: "number", value: n === 0 ? 0 : n } : err("#NUM!"));
const str = (s: string): EvalValue => ({ kind: "string", value: s });
const bool = (b: boolean): EvalValue => ({ kind: "boolean", value: b });
const arr = (rows: EvalValue[][]): EvalValue => ({ kind: "array", value: rows });

type QueryAggFn = "SUM" | "AVG" | "COUNT" | "MIN" | "MAX";

type QueryToken =
  | { kind: "word"; text: string; upper: string }
  | { kind: "string"; text: string }
  | { kind: "number"; value: number }
  | { kind: "op"; text: string };

type SelectItem =
  | { kind: "col"; colIndex: number; key: string; alias?: string }
  | { kind: "agg"; fn: QueryAggFn; colIndex: number | "*"; key: string; alias?: string };

type OrderItem = {
  target: { kind: "col"; colIndex: number } | { kind: "agg"; fn: QueryAggFn; colIndex: number | "*"; key: string };
  asc: boolean;
};

type WhereExpr =
  | { kind: "or"; left: WhereExpr; right: WhereExpr }
  | { kind: "and"; left: WhereExpr; right: WhereExpr }
  | { kind: "not"; arg: WhereExpr }
  | { kind: "isnull"; target: WhereValue; negated: boolean }
  | { kind: "cmp"; op: string; left: WhereValue; right: WhereValue };

type WhereValue =
  | { kind: "col"; colIndex: number }
  | { kind: "lit"; value: EvalValue }
  | { kind: "unary"; op: "+" | "-"; arg: WhereValue }
  | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: WhereValue; right: WhereValue };

interface ParsedQuery {
  selectAll: boolean;
  selectItems: SelectItem[];
  where?: WhereExpr;
  groupBy: number[];
  orderBy: OrderItem[];
  limit?: number;
  offset?: number;
  labels: Map<string, string>;
}

const AGG_FNS = new Set<QueryAggFn>(["SUM", "AVG", "COUNT", "MIN", "MAX"]);
const CLAUSE_KEYWORDS = new Set(["SELECT", "WHERE", "GROUP", "ORDER", "LIMIT", "OFFSET", "LABEL"]);

function tokenizeQuery(input: string): QueryToken[] | null {
  const tokens: QueryToken[] = [];
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) { i++; continue; }
    const ch = input[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let s = "";
      let closed = false;
      while (j < input.length) {
        if (input[j] === "\\" && j + 1 < input.length) {
          s += input[j + 1];
          j += 2;
          continue;
        }
        if (input[j] === quote) {
          if (input[j + 1] === quote) { s += quote; j += 2; continue; }
          closed = true;
          j++;
          break;
        }
        s += input[j++];
      }
      if (!closed) return null;
      tokens.push({ kind: "string", text: s });
      i = j;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "!=" || two === "<>") {
      tokens.push({ kind: "op", text: two });
      i += 2;
      continue;
    }
    if ("=<>+-*/(),".includes(ch)) {
      tokens.push({ kind: "op", text: ch });
      i++;
      continue;
    }
    const numM = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(input.slice(i));
    if (numM) {
      tokens.push({ kind: "number", value: Number(numM[0]) });
      i += numM[0].length;
      continue;
    }
    const wordM = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i));
    if (wordM) {
      tokens.push({ kind: "word", text: wordM[0], upper: wordM[0].toUpperCase() });
      i += wordM[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

function resolveQueryColumn(name: string, startCol: number, numCols: number): number | null {
  const colM = /^col([1-9]\d*)$/i.exec(name);
  if (colM) {
    const idx = Number(colM[1]) - 1;
    return idx >= 0 && idx < numCols ? idx : null;
  }
  if (/^[A-Za-z]{1,3}$/.test(name)) {
    let abs = 0;
    for (const ch of name.toUpperCase()) abs = abs * 26 + ch.charCodeAt(0) - 64;
    const idx = abs - 1 - startCol;
    return idx >= 0 && idx < numCols ? idx : null;
  }
  return null;
}

function aggKey(fn: QueryAggFn, colIndex: number | "*"): string {
  return `${fn}(${colIndex})`;
}

function parseQueryString(query: string, startCol: number, numCols: number): ParsedQuery | null {
  const trimmed = query.trim();
  if (!trimmed) {
    return { selectAll: true, selectItems: [], groupBy: [], orderBy: [], labels: new Map() };
  }
  const tokens = tokenizeQuery(trimmed);
  if (!tokens) return null;

  let pos = 0;
  const peek = () => tokens[pos];
  const isWord = (kw: string) => {
    const t = tokens[pos];
    return t?.kind === "word" && t.upper === kw;
  };
  const consumeWord = (kw: string) => {
    if (!isWord(kw)) return false;
    pos++;
    return true;
  };
  const isOp = (op: string) => {
    const t = tokens[pos];
    return t?.kind === "op" && t.text === op;
  };
  const consumeOp = (op: string) => {
    if (!isOp(op)) return false;
    pos++;
    return true;
  };

  const parseColOrAgg = (): { kind: "col"; colIndex: number; key: string } | { kind: "agg"; fn: QueryAggFn; colIndex: number | "*"; key: string } | null => {
    const t = peek();
    if (!t || t.kind !== "word") return null;
    const nextTok = tokens[pos + 1];
    if (AGG_FNS.has(t.upper as QueryAggFn) && nextTok?.kind === "op" && nextTok.text === "(") {
      const fn = t.upper as QueryAggFn;
      pos += 2;
      let colIndex: number | "*";
      if (fn === "COUNT" && consumeOp("*")) {
        colIndex = "*";
      } else {
        const argTok = peek();
        if (!argTok || argTok.kind !== "word") return null;
        const resolved = resolveQueryColumn(argTok.text, startCol, numCols);
        if (resolved === null) return null;
        pos++;
        colIndex = resolved;
      }
      if (!consumeOp(")")) return null;
      return { kind: "agg", fn, colIndex, key: aggKey(fn, colIndex) };
    }
    if (CLAUSE_KEYWORDS.has(t.upper)) return null;
    const idx = resolveQueryColumn(t.text, startCol, numCols);
    if (idx === null) return null;
    pos++;
    return { kind: "col", colIndex: idx, key: `COL(${idx})` };
  };

  // Arithmetic / value expressions inside WHERE
  const parseWherePrimary = (): WhereValue | null => {
    const t = peek();
    if (!t) return null;
    if (consumeOp("(")) {
      const inner = parseWhereAdd();
      if (!inner || !consumeOp(")")) return null;
      return inner;
    }
    if (consumeOp("+")) {
      const arg = parseWherePrimary();
      return arg ? { kind: "unary", op: "+", arg } : null;
    }
    if (consumeOp("-")) {
      const arg = parseWherePrimary();
      return arg ? { kind: "unary", op: "-", arg } : null;
    }
    if (t.kind === "number") {
      pos++;
      return { kind: "lit", value: num(t.value) };
    }
    if (t.kind === "string") {
      pos++;
      return { kind: "lit", value: str(t.text) };
    }
    if (t.kind === "word") {
      if (t.upper === "TRUE") { pos++; return { kind: "lit", value: bool(true) }; }
      if (t.upper === "FALSE") { pos++; return { kind: "lit", value: bool(false) }; }
      if (t.upper === "NULL") { pos++; return { kind: "lit", value: EMPTY }; }
      const idx = resolveQueryColumn(t.text, startCol, numCols);
      if (idx === null) return null;
      pos++;
      return { kind: "col", colIndex: idx };
    }
    return null;
  };

  const parseWhereMul = (): WhereValue | null => {
    let left = parseWherePrimary();
    if (!left) return null;
    while (isOp("*") || isOp("/")) {
      const op = (tokens[pos++] as Extract<QueryToken, { kind: "op" }>).text as "*" | "/";
      const right = parseWherePrimary();
      if (!right) return null;
      left = { kind: "bin", op, left, right };
    }
    return left;
  };

  const parseWhereAdd = (): WhereValue | null => {
    let left = parseWhereMul();
    if (!left) return null;
    while (isOp("+") || isOp("-")) {
      const op = (tokens[pos++] as Extract<QueryToken, { kind: "op" }>).text as "+" | "-";
      const right = parseWhereMul();
      if (!right) return null;
      left = { kind: "bin", op, left, right };
    }
    return left;
  };

  const parseWhereAtom = (): WhereExpr | null => {
    if (consumeWord("NOT")) {
      const arg = parseWhereAtom();
      return arg ? { kind: "not", arg } : null;
    }
    if (isOp("(")) {
      const save = pos;
      pos++;
      const sub = parseWhereOr();
      if (sub && consumeOp(")")) return sub;
      pos = save;
    }
    const left = parseWhereAdd();
    if (!left) return null;

    if (consumeWord("IS")) {
      const negated = consumeWord("NOT");
      if (!consumeWord("NULL")) return null;
      return { kind: "isnull", target: left, negated };
    }
    if (consumeWord("CONTAINS")) {
      const right = parseWhereAdd();
      return right ? { kind: "cmp", op: "CONTAINS", left, right } : null;
    }
    if (consumeWord("STARTS")) {
      if (!consumeWord("WITH")) return null;
      const right = parseWhereAdd();
      return right ? { kind: "cmp", op: "STARTS WITH", left, right } : null;
    }
    if (consumeWord("ENDS")) {
      if (!consumeWord("WITH")) return null;
      const right = parseWhereAdd();
      return right ? { kind: "cmp", op: "ENDS WITH", left, right } : null;
    }
    if (consumeWord("LIKE")) {
      const right = parseWhereAdd();
      return right ? { kind: "cmp", op: "LIKE", left, right } : null;
    }
    const t = peek();
    if (t?.kind === "op" && ["=", "!=", "<>", "<", "<=", ">", ">="].includes(t.text)) {
      pos++;
      const right = parseWhereAdd();
      return right ? { kind: "cmp", op: t.text, left, right } : null;
    }
    return null;
  };

  const parseWhereAnd = (): WhereExpr | null => {
    let left = parseWhereAtom();
    if (!left) return null;
    while (consumeWord("AND")) {
      const right = parseWhereAtom();
      if (!right) return null;
      left = { kind: "and", left, right };
    }
    return left;
  };

  const parseWhereOr = (): WhereExpr | null => {
    let left = parseWhereAnd();
    if (!left) return null;
    while (consumeWord("OR")) {
      const right = parseWhereAnd();
      if (!right) return null;
      left = { kind: "or", left, right };
    }
    return left;
  };

  const result: ParsedQuery = {
    selectAll: true,
    selectItems: [],
    groupBy: [],
    orderBy: [],
    labels: new Map(),
  };

  if (consumeWord("SELECT")) {
    if (consumeOp("*")) {
      result.selectAll = true;
    } else {
      result.selectAll = false;
      while (true) {
        const item = parseColOrAgg();
        if (!item) return null;
        let alias: string | undefined;
        if (consumeWord("AS")) {
          const at = peek();
          if (at?.kind === "string") { alias = at.text; pos++; }
          else if (at?.kind === "word") { alias = at.text; pos++; }
          else return null;
        }
        result.selectItems.push({ ...item, alias });
        if (!consumeOp(",")) break;
      }
    }
  }

  if (consumeWord("WHERE")) {
    const w = parseWhereOr();
    if (!w) return null;
    result.where = w;
  }

  if (consumeWord("GROUP")) {
    if (!consumeWord("BY")) return null;
    while (true) {
      const t = peek();
      if (!t || t.kind !== "word") return null;
      const idx = resolveQueryColumn(t.text, startCol, numCols);
      if (idx === null) return null;
      pos++;
      result.groupBy.push(idx);
      if (!consumeOp(",")) break;
    }
  }

  if (consumeWord("ORDER")) {
    if (!consumeWord("BY")) return null;
    while (true) {
      const target = parseColOrAgg();
      if (!target) return null;
      let asc = true;
      if (consumeWord("ASC")) asc = true;
      else if (consumeWord("DESC")) asc = false;
      result.orderBy.push({ target, asc });
      if (!consumeOp(",")) break;
    }
  }

  if (consumeWord("LIMIT")) {
    const t = peek();
    if (!t || t.kind !== "number" || !Number.isInteger(t.value) || t.value < 0) return null;
    pos++;
    result.limit = t.value;
  }

  if (consumeWord("OFFSET")) {
    const t = peek();
    if (!t || t.kind !== "number" || !Number.isInteger(t.value) || t.value < 0) return null;
    pos++;
    result.offset = t.value;
  }

  if (consumeWord("LABEL")) {
    while (true) {
      const target = parseColOrAgg();
      if (!target) return null;
      const lbl = peek();
      if (!lbl || lbl.kind !== "string") return null;
      pos++;
      result.labels.set(target.key, lbl.text);
      if (!consumeOp(",")) break;
    }
  }

  if (pos !== tokens.length) return null;
  return result;
}

function scalarText(v: EvalValue): string {
  if (v.kind === "empty") return "";
  if (v.kind === "boolean") return v.value ? "TRUE" : "FALSE";
  if (v.kind === "error") return v.error;
  if (v.kind === "array") return scalarText(v.value[0]?.[0] ?? EMPTY);
  return String(v.value);
}

function scalarNum(v: EvalValue): number | null {
  if (v.kind === "number") return v.value;
  if (v.kind === "boolean") return v.value ? 1 : 0;
  if (v.kind === "string" && v.value.trim() !== "") {
    const n = Number(v.value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function cmpEval(a: EvalValue, b: EvalValue): number {
  const ea = a.kind === "empty" || (a.kind === "string" && a.value === "");
  const eb = b.kind === "empty" || (b.kind === "string" && b.value === "");
  if (ea && eb) return 0;
  if (ea) return -1;
  if (eb) return 1;
  if (a.kind === "number" && b.kind === "number") return a.value - b.value;
  if (a.kind === "boolean" && b.kind === "boolean") return Number(a.value) - Number(b.value);
  return scalarText(a).toLowerCase().localeCompare(scalarText(b).toLowerCase());
}

function evalWhereVal(node: WhereValue, row: readonly EvalValue[]): EvalValue {
  switch (node.kind) {
    case "col":
      return row[node.colIndex] ?? EMPTY;
    case "lit":
      return node.value;
    case "unary": {
      const n = scalarNum(evalWhereVal(node.arg, row));
      if (n === null) return err("#VALUE!");
      return num(node.op === "-" ? -n : n);
    }
    case "bin": {
      const a = scalarNum(evalWhereVal(node.left, row));
      const b = scalarNum(evalWhereVal(node.right, row));
      if (a === null || b === null) return err("#VALUE!");
      if (node.op === "+") return num(a + b);
      if (node.op === "-") return num(a - b);
      if (node.op === "*") return num(a * b);
      return b === 0 ? err("#DIV/0!") : num(a / b);
    }
  }
}

function likeMatch(text: string, pattern: string): boolean {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "%") re += ".*";
    else if (ch === "_") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re, "i").test(text);
}

function evalWhere(expr: WhereExpr, row: readonly EvalValue[]): boolean {
  switch (expr.kind) {
    case "or":
      return evalWhere(expr.left, row) || evalWhere(expr.right, row);
    case "and":
      return evalWhere(expr.left, row) && evalWhere(expr.right, row);
    case "not":
      return !evalWhere(expr.arg, row);
    case "isnull": {
      const v = evalWhereVal(expr.target, row);
      const isNull = v.kind === "empty" || (v.kind === "string" && v.value === "");
      return expr.negated ? !isNull : isNull;
    }
    case "cmp": {
      const lv = evalWhereVal(expr.left, row);
      const rv = evalWhereVal(expr.right, row);
      if (lv.kind === "error" || rv.kind === "error") return false;
      if (expr.op === "CONTAINS") return scalarText(lv).toLowerCase().includes(scalarText(rv).toLowerCase());
      if (expr.op === "STARTS WITH") return scalarText(lv).toLowerCase().startsWith(scalarText(rv).toLowerCase());
      if (expr.op === "ENDS WITH") return scalarText(lv).toLowerCase().endsWith(scalarText(rv).toLowerCase());
      if (expr.op === "LIKE") return likeMatch(scalarText(lv), scalarText(rv));

      const ln = lv.kind === "number" ? lv.value : null;
      const rn = rv.kind === "number" ? rv.value : null;
      let cmp: number;
      if (ln !== null && rn !== null) {
        cmp = ln - rn;
      } else if (lv.kind === "boolean" && rv.kind === "boolean") {
        cmp = Number(lv.value) - Number(rv.value);
      } else {
        const ls = scalarText(lv);
        const rs = scalarText(rv);
        if (expr.op === "=" || expr.op === "!=" || expr.op === "<>") {
          cmp = ls === rs ? 0 : ls.localeCompare(rs);
        } else {
          cmp = ls.localeCompare(rs);
        }
      }
      if (expr.op === "=") return cmp === 0;
      if (expr.op === "!=" || expr.op === "<>") return cmp !== 0;
      if (expr.op === "<") return cmp < 0;
      if (expr.op === "<=") return cmp <= 0;
      if (expr.op === ">") return cmp > 0;
      return cmp >= 0;
    }
  }
}

function computeAggregate(fn: QueryAggFn, colIndex: number | "*", rows: readonly EvalValue[][]): EvalValue {
  if (fn === "COUNT") {
    if (colIndex === "*") return num(rows.length);
    let count = 0;
    for (const r of rows) {
      const v = r[colIndex] ?? EMPTY;
      if (v.kind !== "empty" && !(v.kind === "string" && v.value === "")) count++;
    }
    return num(count);
  }
  const idx = colIndex as number;
  if (fn === "SUM" || fn === "AVG") {
    let sum = 0;
    let count = 0;
    for (const r of rows) {
      const v = r[idx] ?? EMPTY;
      if (v.kind === "number") { sum += v.value; count++; }
    }
    if (fn === "SUM") return num(sum);
    return count > 0 ? num(sum / count) : EMPTY;
  }
  // MIN / MAX
  let best: EvalValue | null = null;
  for (const r of rows) {
    const v = r[idx] ?? EMPTY;
    if (v.kind === "empty" || (v.kind === "string" && v.value === "") || v.kind === "error") continue;
    if (!best) { best = v; continue; }
    const c = cmpEval(v, best);
    if (fn === "MIN" ? c < 0 : c > 0) best = v;
  }
  return best ?? EMPTY;
}

function detectHeaderCount(data: readonly EvalValue[][]): number {
  if (data.length <= 1) return 0;
  const firstRow = data[0];
  let hasString = false;
  for (const cell of firstRow) {
    if (cell.kind === "number" || cell.kind === "boolean") return 0;
    if (cell.kind === "string" && cell.value.trim() !== "") hasString = true;
  }
  if (!hasString) return 0;
  // Look for at least one column where row 0 is a non-empty string and a body row has a number/boolean
  for (let c = 0; c < firstRow.length; c++) {
    const hdrCell = firstRow[c];
    if (hdrCell.kind !== "string" || hdrCell.value.trim() === "") continue;
    for (let r = 1; r < Math.min(data.length, 20); r++) {
      const cell = data[r][c];
      if (cell && (cell.kind === "number" || cell.kind === "boolean")) return 1;
    }
  }
  return 0;
}

/**
 * Evaluate `QUERY(data_range, query_string, [headers])` with practical GVQL support:
 * SELECT, WHERE, GROUP BY, ORDER BY, LIMIT, OFFSET, LABEL, and SUM/AVG/COUNT/MIN/MAX.
 */
export function evaluateQuery(
  data: EvalValue[][],
  queryString: string,
  startCol: number,
  headersArg: number | undefined,
  tickOp: () => boolean,
): EvalValue {
  if (!data.length || !data[0]?.length) return err("#VALUE!");
  const numCols = data[0].length;
  const parsed = parseQueryString(queryString, startCol, numCols);
  if (!parsed) return err("#VALUE!");

  const headerCount =
    headersArg !== undefined && headersArg >= 0
      ? Math.min(Math.trunc(headersArg), data.length)
      : detectHeaderCount(data);

  const headerRows = data.slice(0, headerCount);
  const bodyRows = data.slice(headerCount);

  const colHeaders: string[] = [];
  for (let c = 0; c < numCols; c++) {
    const parts: string[] = [];
    for (const hr of headerRows) {
      const t = scalarText(hr[c] ?? EMPTY).trim();
      if (t) parts.push(t);
    }
    colHeaders.push(parts.join(" "));
  }

  const selectItems: SelectItem[] = parsed.selectAll
    ? Array.from({ length: numCols }, (_, i) => ({ kind: "col" as const, colIndex: i, key: `COL(${i})` }))
    : parsed.selectItems;

  const hasAgg = selectItems.some((s) => s.kind === "agg") || parsed.orderBy.some((o) => o.target.kind === "agg");
  const hasGroup = parsed.groupBy.length > 0;

  if (hasAgg || hasGroup) {
    const groupSet = new Set(parsed.groupBy);
    for (const item of selectItems) {
      if (item.kind === "col" && !groupSet.has(item.colIndex)) {
        return err("#VALUE!");
      }
    }
  }

  // Filter rows via WHERE
  const filtered: EvalValue[][] = [];
  for (const row of bodyRows) {
    if (!tickOp()) return err("#LIMIT!");
    if (!parsed.where || evalWhere(parsed.where, row)) {
      filtered.push(row);
    }
  }

  interface CandidateRow {
    projected: EvalValue[];
    sortKeys: EvalValue[];
  }

  const candidates: CandidateRow[] = [];

  if (hasAgg || hasGroup) {
    if (hasGroup) {
      const groups = new Map<string, { keyVals: Map<number, EvalValue>; rows: EvalValue[][] }>();
      for (const row of filtered) {
        if (!tickOp()) return err("#LIMIT!");
        const gKey = parsed.groupBy
          .map((ci) => {
            const v = row[ci] ?? EMPTY;
            return `${v.kind}:${scalarText(v).toLowerCase()}`;
          })
          .join("\u001f");
        let grp = groups.get(gKey);
        if (!grp) {
          const keyVals = new Map<number, EvalValue>();
          for (const ci of parsed.groupBy) keyVals.set(ci, row[ci] ?? EMPTY);
          grp = { keyVals, rows: [] };
          groups.set(gKey, grp);
        }
        grp.rows.push(row);
      }
      for (const grp of groups.values()) {
        const aggCache = new Map<string, EvalValue>();
        const getAgg = (fn: QueryAggFn, colIndex: number | "*", key: string) => {
          let v = aggCache.get(key);
          if (!v) { v = computeAggregate(fn, colIndex, grp.rows); aggCache.set(key, v); }
          return v;
        };
        const projected = selectItems.map((item) =>
          item.kind === "col"
            ? (grp.keyVals.get(item.colIndex) ?? EMPTY)
            : getAgg(item.fn, item.colIndex, item.key),
        );
        const sortKeys = parsed.orderBy.map((o) =>
          o.target.kind === "col"
            ? (grp.keyVals.get(o.target.colIndex) ?? EMPTY)
            : getAgg(o.target.fn, o.target.colIndex, o.target.key),
        );
        candidates.push({ projected, sortKeys });
      }
    } else {
      // Pure aggregate without GROUP BY -> single summary row
      const aggCache = new Map<string, EvalValue>();
      const getAgg = (fn: QueryAggFn, colIndex: number | "*", key: string) => {
        let v = aggCache.get(key);
        if (!v) { v = computeAggregate(fn, colIndex, filtered); aggCache.set(key, v); }
        return v;
      };
      const projected = selectItems.map((item) =>
        item.kind === "agg" ? getAgg(item.fn, item.colIndex, item.key) : EMPTY,
      );
      const sortKeys = parsed.orderBy.map((o) =>
        o.target.kind === "agg" ? getAgg(o.target.fn, o.target.colIndex, o.target.key) : EMPTY,
      );
      candidates.push({ projected, sortKeys });
    }
  } else {
    for (const row of filtered) {
      if (!tickOp()) return err("#LIMIT!");
      const projected = selectItems.map((item) => (item.kind === "col" ? (row[item.colIndex] ?? EMPTY) : EMPTY));
      const sortKeys = parsed.orderBy.map((o) =>
        o.target.kind === "col" ? (row[o.target.colIndex] ?? EMPTY) : EMPTY,
      );
      candidates.push({ projected, sortKeys });
    }
  }

  if (parsed.orderBy.length > 0 && candidates.length > 1) {
    candidates.sort((a, b) => {
      for (let i = 0; i < parsed.orderBy.length; i++) {
        const cmp = cmpEval(a.sortKeys[i], b.sortKeys[i]);
        if (cmp !== 0) return parsed.orderBy[i].asc ? cmp : -cmp;
      }
      return 0;
    });
  }

  const startOffset = parsed.offset ?? 0;
  const sliced =
    parsed.limit !== undefined
      ? candidates.slice(startOffset, startOffset + parsed.limit)
      : candidates.slice(startOffset);

  if (sliced.length === 0) return err("#N/A");

  const out: EvalValue[][] = [];
  const includeHeader =
    headerCount > 0 ||
    parsed.labels.size > 0 ||
    selectItems.some((item) => item.alias !== undefined);

  if (includeHeader) {
    out.push(
      selectItems.map((item) => {
        const explicit = parsed.labels.get(item.key) ?? item.alias;
        if (explicit !== undefined) return str(explicit);
        if (item.kind === "col") return str(colHeaders[item.colIndex] ?? "");
        const base = item.colIndex === "*" ? "" : (colHeaders[item.colIndex] ?? "");
        return str(base ? `${item.fn.toLowerCase()} ${base}` : item.fn.toLowerCase());
      }),
    );
  }

  for (const row of sliced) {
    out.push(row.projected);
  }

  if (out.length === 1 && out[0].length === 1) {
    return out[0][0];
  }
  return arr(out);
}

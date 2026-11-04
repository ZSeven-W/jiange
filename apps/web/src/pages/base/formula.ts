/**
 * 自研公式引擎（多维表格 formula 字段）。
 *
 * 语法（Go 侧 btformula 校验器接受同一份语法）：
 *   字面量: 123 4.5 "文本" TRUE FALSE
 *   引用:   [字段名]（解析为字段 id 后求值）
 *   运算符: + - * / % ^ 与比较 = != <> < <= > >=，字符串拼接 &，一元 -
 *   函数:   FN(a, b, ...)（见 FUNCS，约 30 个）
 *
 * 求值环境是一个 (字段名 → 值) 映射；formula 字段之间的引用由 evalRecord
 * 按依赖图拓扑序求值（环返回 #CYCLE）。
 */

export type FormulaValue = number | string | boolean | null;

export interface FormulaEnv {
  /** 字段名（小写键）→ 当前值 */
  get(name: string): FormulaValue;
}

// ---------- tokenizer ----------

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; v: string }
  | { t: "ident"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const v = Number(src.slice(i, j));
      if (Number.isNaN(v)) throw new FormulaError("#NUM?");
      toks.push({ t: "num", v });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== '"') {
        v += src[j];
        j++;
      }
      if (j >= src.length) throw new FormulaError("#SYNTAX");
      toks.push({ t: "str", v });
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) throw new FormulaError("#SYNTAX");
      toks.push({ t: "ref", v: src.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      toks.push({ t: "ident", v: src.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "!=" || two === "<>") {
      toks.push({ t: "op", v: two === "<>" ? "!=" : two });
      i += 2;
      continue;
    }
    if ("+-*/%^&=<>(),".includes(ch)) {
      toks.push({ t: "op", v: ch });
      i++;
      continue;
    }
    throw new FormulaError("#SYNTAX");
  }
  return toks;
}

export class FormulaError extends Error {}

// ---------- parser (recursive descent, ^ 右结合) ----------

// precedence: & < 比较 < + - < * / % < 一元- < ^
const PREC: Record<string, number> = { "&": 1, "=": 2, "!=": 2, "<": 2, "<=": 2, ">": 2, ">=": 2, "+": 3, "-": 3, "*": 4, "/": 4, "%": 4 };

class Parser {
  i = 0;
  constructor(readonly toks: Tok[]) {}
  peek(): Tok | null {
    return this.toks[this.i] ?? null;
  }
  next(): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new FormulaError("#SYNTAX");
    return t;
  }
  parseExpr(minPrec = 0): Node {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== "op") break;
      const prec = PREC[t.v];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.parseExpr(prec + 1);
      left = { t: "bin", op: t.v, l: left, r: right };
    }
    return left;
  }
  parseUnary(): Node {
    const t = this.peek();
    if (t && t.t === "op" && (t.v === "-" || t.v === "+")) {
      this.next();
      const v = this.parseUnary();
      return t.v === "-" ? { t: "neg", v } : v;
    }
    return this.parsePow();
  }
  parsePow(): Node {
    const base = this.parseAtom();
    const t = this.peek();
    if (t && t.t === "op" && t.v === "^") {
      this.next();
      return { t: "bin", op: "^", l: base, r: this.parseUnary() }; // 右结合
    }
    return base;
  }
  parseAtom(): Node {
    const t = this.next();
    switch (t.t) {
      case "num":
        return { t: "lit", v: t.v };
      case "str":
        return { t: "lit", v: t.v };
      case "ref":
        return { t: "ref", name: t.v };
      case "ident": {
        if (t.v === "TRUE") return { t: "lit", v: true };
        if (t.v === "FALSE") return { t: "lit", v: false };
        const open = this.peek();
        if (open && open.t === "op" && open.v === "(") {
          this.next();
          const args: Node[] = [];
          const close = this.peek();
          if (!(close && close.t === "op" && close.v === ")")) {
            args.push(this.parseExpr());
            for (;;) {
              const c = this.peek();
              if (c && c.t === "op" && c.v === ",") {
                this.next();
                args.push(this.parseExpr());
              } else break;
            }
          }
          const end = this.next();
          if (!(end.t === "op" && end.v === ")")) throw new FormulaError("#SYNTAX");
          return { t: "call", fn: t.v, args };
        }
        throw new FormulaError("#NAME?");
      }
      case "op":
        if (t.v === "(") {
          const e = this.parseExpr();
          const close = this.next();
          if (!(close.t === "op" && close.v === ")")) throw new FormulaError("#SYNTAX");
          return e;
        }
        throw new FormulaError("#SYNTAX");
    }
  }
}

type Node =
  | { t: "lit"; v: FormulaValue }
  | { t: "ref"; name: string }
  | { t: "neg"; v: Node }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "call"; fn: string; args: Node[] };

export function parseFormula(src: string): Node {
  const p = new Parser(tokenize(src));
  const n = p.parseExpr();
  if (p.i !== p.toks.length) throw new FormulaError("#SYNTAX");
  return n;
}

// ---------- evaluation ----------

function num(v: FormulaValue, what = "#VALUE?"): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n) && v.trim() !== "") return n;
  }
  throw new FormulaError(what);
}

function str(v: FormulaValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  return v;
}

function bool(v: FormulaValue): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  return false;
}

export const FUNCS: Record<string, (args: FormulaValue[]) => FormulaValue> = {
  // 数学
  ABS: (a) => Math.abs(num(a[0])),
  ROUND: (a) => { const p = a.length > 1 ? num(a[1]) : 0; const m = 10 ** p; return Math.round(num(a[0]) * m) / m; },
  FLOOR: (a) => Math.floor(num(a[0])),
  CEILING: (a) => Math.ceil(num(a[0])),
  MOD: (a) => { const b = num(a[1]); if (b === 0) throw new FormulaError("#DIV/0!"); return num(a[0]) % b; },
  POW: (a) => num(a[0]) ** num(a[1]),
  SQRT: (a) => { const x = num(a[0]); if (x < 0) throw new FormulaError("#NUM?"); return Math.sqrt(x); },
  INT: (a) => Math.trunc(num(a[0])),
  MIN: (a) => Math.min(...a.map((x) => num(x))),
  MAX: (a) => Math.max(...a.map((x) => num(x))),
  SUM: (a) => a.reduce((s: number, x) => s + num(x), 0),
  AVERAGE: (a) => { if (!a.length) throw new FormulaError("#DIV/0!"); return a.reduce((s: number, x) => s + num(x), 0) / a.length; },
  // 逻辑
  IF: (a) => (bool(a[0]) ? a[1] : a[2] ?? null),
  IFS: (a) => { for (let i = 0; i + 1 < a.length; i += 2) if (bool(a[i])) return a[i + 1]; return a.length % 2 ? a[a.length - 1] : null; },
  AND: (a) => a.every(bool),
  OR: (a) => a.some(bool),
  NOT: (a) => !bool(a[0]),
  ISBLANK: (a) => a[0] === null || a[0] === "",
  // 文本
  LEN: (a) => [...str(a[0])].length,
  UPPER: (a) => str(a[0]).toUpperCase(),
  LOWER: (a) => str(a[0]).toLowerCase(),
  CONCATENATE: (a) => a.map(str).join(""),
  LEFT: (a) => str(a[0]).slice(0, num(a[1])),
  RIGHT: (a) => { const n = num(a[1]); const cs = [...str(a[0])]; return n >= cs.length ? str(a[0]) : cs.slice(cs.length - n).join(""); },
  MID: (a) => str(a[0]).slice(num(a[1]) - 1, num(a[1]) - 1 + num(a[2])),
  TRIM: (a) => str(a[0]).trim(),
  CONTAINS: (a) => str(a[0]).includes(str(a[1])),
  // 信息
  BLANK: () => null,
  VALUE: (a) => num(str(a[0]) || "0"),
  TEXT: (a) => str(a[0]),
  // 日期（配合 date 字段的 YYYY-MM-DD 字符串）
  TODAY: () => new Date().toISOString().slice(0, 10),
  NOW: () => new Date().toISOString(),
  YEAR: (a) => new Date(str(a[0])).getFullYear(),
  MONTH: (a) => new Date(str(a[0])).getMonth() + 1,
  DAY: (a) => new Date(str(a[0])).getDate(),
};

function cmp(op: string, l: FormulaValue, r: FormulaValue): boolean {
  if (typeof l === "string" || typeof r === "string") {
    const a = str(l);
    const b = str(r);
    switch (op) {
      case "=": return a === b;
      case "!=": return a !== b;
      case "<": return a < b;
      case "<=": return a <= b;
      case ">": return a > b;
      case ">=": return a >= b;
    }
  }
  const a = num(l, "#VALUE?");
  const b = num(r, "#VALUE?");
  switch (op) {
    case "=": return a === b;
    case "!=": return a !== b;
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
  }
  throw new FormulaError("#SYNTAX");
}

export function evalNode(n: Node, env: FormulaEnv): FormulaValue {
  switch (n.t) {
    case "lit":
      return n.v;
    case "ref":
      return env.get(n.name);
    case "neg":
      return -num(evalNode(n.v, env));
    case "bin": {
      if (n.op === "&") return str(evalNode(n.l, env)) + str(evalNode(n.r, env));
      if (["=", "!=", "<", "<=", ">", ">="].includes(n.op)) return cmp(n.op, evalNode(n.l, env), evalNode(n.r, env));
      const a = evalNode(n.l, env);
      const b = evalNode(n.r, env);
      const x = num(a);
      const y = num(b);
      switch (n.op) {
        case "+": return x + y;
        case "-": return x - y;
        case "*": return x * y;
        case "/": if (y === 0) throw new FormulaError("#DIV/0!"); return x / y;
        case "%": if (y === 0) throw new FormulaError("#DIV/0!"); return x % y;
        case "^": return x ** y;
      }
      throw new FormulaError("#SYNTAX");
    }
    case "call": {
      // IF / IFS 短路：只求值需要的分支（否则空值参与算术会报 #VALUE?）
      if (n.fn === "IF") {
        if (n.args.length < 2) throw new FormulaError("#SYNTAX");
        return bool(evalNode(n.args[0], env)) ? evalNode(n.args[1], env) : n.args[2] !== undefined ? evalNode(n.args[2], env) : null;
      }
      if (n.fn === "IFS") {
        for (let i = 0; i + 1 < n.args.length; i += 2) {
          if (bool(evalNode(n.args[i], env))) return evalNode(n.args[i + 1], env);
        }
        return n.args.length % 2 ? evalNode(n.args[n.args.length - 1], env) : null;
      }
      const fn = FUNCS[n.fn];
      if (!fn) throw new FormulaError("#NAME?");
      return fn(n.args.map((a) => evalNode(a, env)));
    }
  }
}

/** 编译 + 求值一个公式（字段名经 env.get 解析，大小写不敏感；缺省 env 全为空）。 */
export function evalFormula(src: string, env: FormulaEnv = { get: () => null }): FormulaValue {
  return evalNode(parseFormula(src), env);
}

/** 提取公式引用的字段名（去重，保持出现顺序）。 */
export function formulaRefs(src: string): string[] {
  const seen = new Set<string>();
  for (const t of tokenize(src)) if (t.t === "ref" && !seen.has(t.v)) seen.add(t.v);
  return [...seen];
}

/** 语法是否合法（Go 校验器用同一组测试表达式对齐）。 */
export function formulaValid(src: string): boolean {
  try {
    parseFormula(src);
    return true;
  } catch {
    return false;
  }
}

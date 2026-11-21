import { columnName, selectionBounds, sheetAddress, type SheetPoint, type SheetSelection } from "./grid.js";
import type { FormulaRefHighlight, SheetWorksheet } from "./types.js";

export const FORMULA_REF_PALETTE = ["#ff8800", "#7b56d9", "#1456f0", "#00b42a", "#d83931"] as const;

const MAX_TOKENS = 4096;
const MAX_PARSE_DEPTH = 64;
const AST_CACHE_LIMIT = 4096;

export interface CellRefToken {
  row: number;
  col: number;
  rowAbs: boolean;
  colAbs: boolean;
}

export interface RangeRefNode {
  kind: "range";
  sheetName?: string;
  /** Whole-column refs (e.g. `A:B`) use row = -1; whole-row refs (`1:5`) use col = -1. */
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  rawText: string;
}

export type FormulaAst =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "error"; code: string }
  | { kind: "cell"; sheetName?: string; row: number; col: number; rowAbs: boolean; colAbs: boolean; rawText: string }
  | RangeRefNode
  | { kind: "name"; name: string }
  | { kind: "unary"; op: "+" | "-"; arg: FormulaAst }
  | { kind: "percent"; arg: FormulaAst }
  | { kind: "binary"; op: string; left: FormulaAst; right: FormulaAst }
  | { kind: "call"; name: string; args: FormulaAst[] }
  | { kind: "array"; rows: FormulaAst[][] };

export function parseA1Token(text: string): CellRefToken | null {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})$/.exec(text);
  if (!m) return null;
  let col = 0;
  for (const ch of m[2].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  const row = Number(m[4]);
  if (col < 1 || col > 16384 || row < 1 || row > 1048576) return null;
  return { row: row - 1, col: col - 1, colAbs: !!m[1], rowAbs: !!m[3] };
}

export function parseColToken(text: string): { col: number; abs: boolean } | null {
  const m = /^(\$?)([A-Za-z]{1,3})$/.exec(text);
  if (!m) return null;
  let col = 0;
  for (const ch of m[2].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  if (col < 1 || col > 16384) return null;
  return { col: col - 1, abs: !!m[1] };
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

type Token =
  | { kind: "number"; text: string; num: number }
  | { kind: "string"; text: string; str: string }
  | { kind: "bool"; text: string; bool: boolean }
  | { kind: "error"; text: string }
  | { kind: "cell"; text: string; sheetName?: string; ref: CellRefToken }
  | { kind: "colrange"; text: string; sheetName?: string; c1: number; c2: number }
  | { kind: "rowrange"; text: string; sheetName?: string; r1: number; r2: number }
  | { kind: "name"; text: string }
  | { kind: "op"; text: string };

const ERROR_TOKEN_RE = /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|NUM!|N\/A|NULL!|SPILL!|CALC!|CYCLE!|ERROR!)/i;
const SHEET_PREFIX_RE = /^(?:'((?:[^']|'')+)'|([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_.\u4e00-\u9fa5]{0,30}))!/;

function tokenizeFormula(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }
    const rest = expr.slice(i);

    if (rest[0] === '"') {
      let end = 1;
      let str = "";
      let closed = false;
      while (end < rest.length) {
        if (rest[end] === '"') {
          if (rest[end + 1] === '"') { str += '"'; end += 2; continue; }
          closed = true;
          end++;
          break;
        }
        str += rest[end++];
      }
      if (!closed) return null;
      tokens.push({ kind: "string", text: rest.slice(0, end), str });
      i += end;
    } else if (ERROR_TOKEN_RE.test(rest)) {
      const m = ERROR_TOKEN_RE.exec(rest)!;
      tokens.push({ kind: "error", text: m[0].toUpperCase() });
      i += m[0].length;
    } else {
      const sp = SHEET_PREFIX_RE.exec(rest);
      if (sp) {
        const sheetName = sp[1] !== undefined ? sp[1].replace(/''/g, "'") : sp[2];
        const after = rest.slice(sp[0].length);
        const cellM = /^(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})/.exec(after);
        const colRangeM = !cellM ? /^(\$?[A-Za-z]{1,3}):(\$?[A-Za-z]{1,3})(?![A-Za-z0-9_(])/.exec(after) : null;
        const rowRangeM = !cellM && !colRangeM ? /^(\$?[1-9]\d{0,6}):(\$?[1-9]\d{0,6})(?![0-9.])/.exec(after) : null;
        if (cellM) {
          const parsed = parseA1Token(cellM[1]);
          const full = sp[0] + cellM[0];
          if (!parsed) tokens.push({ kind: "error", text: "#REF!" });
          else tokens.push({ kind: "cell", text: full, sheetName, ref: parsed });
          i += full.length;
        } else if (colRangeM) {
          const a = parseColToken(colRangeM[1]);
          const b = parseColToken(colRangeM[2]);
          const full = sp[0] + colRangeM[0];
          if (!a || !b) tokens.push({ kind: "error", text: "#REF!" });
          else tokens.push({ kind: "colrange", text: full, sheetName, c1: Math.min(a.col, b.col), c2: Math.max(a.col, b.col) });
          i += full.length;
        } else if (rowRangeM) {
          const r1 = Number(rowRangeM[1].replace("$", "")) - 1;
          const r2 = Number(rowRangeM[2].replace("$", "")) - 1;
          const full = sp[0] + rowRangeM[0];
          if (r1 < 0 || r2 < 0 || r1 >= 1048576 || r2 >= 1048576) tokens.push({ kind: "error", text: "#REF!" });
          else tokens.push({ kind: "rowrange", text: full, sheetName, r1: Math.min(r1, r2), r2: Math.max(r1, r2) });
          i += full.length;
        } else {
          return null;
        }
      } else {
        const colRangeM = /^(\$?[A-Za-z]{1,3}):(\$?[A-Za-z]{1,3})(?![A-Za-z0-9_(])/.exec(rest);
        if (colRangeM) {
          const a = parseColToken(colRangeM[1]);
          const b = parseColToken(colRangeM[2]);
          if (a && b) {
            tokens.push({ kind: "colrange", text: colRangeM[0], c1: Math.min(a.col, b.col), c2: Math.max(a.col, b.col) });
            i += colRangeM[0].length;
            if (tokens.length > MAX_TOKENS) return null;
            continue;
          }
        }
        const rowRangeM = /^(\$?[1-9]\d{0,6}):(\$?[1-9]\d{0,6})(?![0-9.])/.exec(rest);
        if (rowRangeM) {
          const r1 = Number(rowRangeM[1].replace("$", "")) - 1;
          const r2 = Number(rowRangeM[2].replace("$", "")) - 1;
          if (r1 >= 0 && r2 >= 0 && r1 < 1048576 && r2 < 1048576) {
            tokens.push({ kind: "rowrange", text: rowRangeM[0], r1: Math.min(r1, r2), r2: Math.max(r1, r2) });
            i += rowRangeM[0].length;
            if (tokens.length > MAX_TOKENS) return null;
            continue;
          }
        }
        const numMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
        if (numMatch) {
          tokens.push({ kind: "number", text: numMatch[0], num: Number(numMatch[0]) });
          i += numMatch[0].length;
        } else {
          const twoCharOp = /^(?:<>|<=|>=)/.exec(rest);
          if (twoCharOp) {
            tokens.push({ kind: "op", text: twoCharOp[0] });
            i += 2;
          } else if ("+-*/^%(),:&=<>{};".includes(rest[0])) {
            tokens.push({ kind: "op", text: rest[0] });
            i++;
          } else {
            const word = /^(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}|[A-Za-z_][A-Za-z0-9_.]*)/.exec(rest);
            if (!word) return null;
            const upper = word[0].toUpperCase();
            const isCall = /^\s*\(/.test(rest.slice(word[0].length));
            if ((upper === "TRUE" || upper === "FALSE") && !isCall) {
              tokens.push({ kind: "bool", text: word[0], bool: upper === "TRUE" });
            } else {
              const ref = !isCall ? parseA1Token(word[0]) : null;
              if (ref) tokens.push({ kind: "cell", text: word[0], ref });
              else tokens.push({ kind: "name", text: word[0] });
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

const astCache = new Map<string, FormulaAst | null>();

function precedenceOf(op: string): number {
  if (op === "=" || op === "<>" || op === "<" || op === "<=" || op === ">" || op === ">=") return 1;
  if (op === "&") return 2;
  if (op === "+" || op === "-") return 3;
  if (op === "*" || op === "/") return 4;
  if (op === "^") return 5;
  return 0;
}

/** Parse a formula expression (with or without leading `=`) into a cached AST. */
export function parseFormulaAst(raw: string): FormulaAst | null {
  const expr = raw.startsWith("=") ? raw.slice(1) : raw;
  const cached = astCache.get(expr);
  if (cached !== undefined) return cached;

  const tokens = tokenizeFormula(expr);
  if (!tokens || tokens.length === 0) {
    cacheAst(expr, null);
    return null;
  }
  let pos = 0;

  const parsePrimary = (depth: number): FormulaAst | null => {
    if (depth > MAX_PARSE_DEPTH) return null;
    const tok = tokens[pos++];
    if (!tok) return null;

    if (tok.kind === "number") return { kind: "number", value: tok.num };
    if (tok.kind === "string") return { kind: "string", value: tok.str };
    if (tok.kind === "bool") return { kind: "boolean", value: tok.bool };
    if (tok.kind === "error") return { kind: "error", code: tok.text };
    if (tok.kind === "colrange") {
      return {
        kind: "range",
        sheetName: tok.sheetName,
        startRow: -1,
        endRow: -1,
        startCol: tok.c1,
        endCol: tok.c2,
        rawText: tok.text,
      };
    }
    if (tok.kind === "rowrange") {
      return {
        kind: "range",
        sheetName: tok.sheetName,
        startRow: tok.r1,
        endRow: tok.r2,
        startCol: -1,
        endCol: -1,
        rawText: tok.text,
      };
    }
    if (tok.kind === "cell") {
      if (tokens[pos]?.kind === "op" && tokens[pos].text === ":" && tokens[pos + 1]?.kind === "cell") {
        const endTok = tokens[pos + 1] as Extract<Token, { kind: "cell" }>;
        if (!endTok.sheetName) {
          pos += 2;
          return {
            kind: "range",
            sheetName: tok.sheetName,
            startRow: Math.min(tok.ref.row, endTok.ref.row),
            startCol: Math.min(tok.ref.col, endTok.ref.col),
            endRow: Math.max(tok.ref.row, endTok.ref.row),
            endCol: Math.max(tok.ref.col, endTok.ref.col),
            rawText: `${tok.text}:${endTok.text}`,
          };
        }
      }
      return {
        kind: "cell",
        sheetName: tok.sheetName,
        row: tok.ref.row,
        col: tok.ref.col,
        rowAbs: tok.ref.rowAbs,
        colAbs: tok.ref.colAbs,
        rawText: tok.text,
      };
    }
    if (tok.kind === "op" && (tok.text === "+" || tok.text === "-")) {
      const arg = parseUnary(depth + 1);
      return arg ? { kind: "unary", op: tok.text, arg } : null;
    }
    if (tok.kind === "op" && tok.text === "(") {
      const inner = parseExpr(0, depth + 1);
      if (!inner || tokens[pos]?.kind !== "op" || tokens[pos].text !== ")") return null;
      pos++;
      return inner;
    }
    if (tok.kind === "op" && tok.text === "{") {
      const rows: FormulaAst[][] = [];
      let currentRow: FormulaAst[] = [];
      if (tokens[pos]?.kind === "op" && tokens[pos].text === "}") return null;
      while (pos < tokens.length) {
        const elem = parseExpr(0, depth + 1);
        if (!elem) return null;
        currentRow.push(elem);
        const sep = tokens[pos];
        if (sep?.kind === "op" && sep.text === ",") { pos++; continue; }
        if (sep?.kind === "op" && sep.text === ";") { rows.push(currentRow); currentRow = []; pos++; continue; }
        if (sep?.kind === "op" && sep.text === "}") { rows.push(currentRow); pos++; return { kind: "array", rows }; }
        return null;
      }
      return null;
    }
    if (tok.kind === "name") {
      if (tokens[pos]?.kind === "op" && tokens[pos].text === "(") {
        pos++;
        const args: FormulaAst[] = [];
        if (!(tokens[pos]?.kind === "op" && tokens[pos].text === ")")) {
          while (true) {
            // Handle omitted optional args like INDEX(A1:B2,,2) -> empty string/missing
            if (tokens[pos]?.kind === "op" && (tokens[pos].text === "," || tokens[pos].text === ")")) {
              args.push({ kind: "error", code: "__MISSING__" });
            } else {
              const arg = parseExpr(0, depth + 1);
              if (!arg) return null;
              args.push(arg);
            }
            if (tokens[pos]?.kind === "op" && tokens[pos].text === ",") {
              pos++;
              continue;
            }
            break;
          }
        }
        if (tokens[pos]?.kind !== "op" || tokens[pos].text !== ")") return null;
        pos++;
        return { kind: "call", name: tok.text.toUpperCase(), args };
      }
      return { kind: "name", name: tok.text };
    }
    return null;
  };

  const parseUnary = (depth: number): FormulaAst | null => {
    let node = parsePrimary(depth);
    if (!node) return null;
    while (tokens[pos]?.kind === "op" && tokens[pos].text === "%") {
      pos++;
      node = { kind: "percent", arg: node };
    }
    return node;
  };

  const parseExpr = (minPrec: number, depth: number): FormulaAst | null => {
    if (depth > MAX_PARSE_DEPTH) return null;
    let left = parseUnary(depth + 1);
    if (!left) return null;
    while (pos < tokens.length && tokens[pos].kind === "op") {
      const op = tokens[pos].text;
      const prec = precedenceOf(op);
      if (!prec || prec < minPrec) break;
      pos++;
      const right = parseExpr(op === "^" ? prec : prec + 1, depth + 1);
      if (!right) return null;
      left = { kind: "binary", op, left, right };
    }
    return left;
  };

  const root = parseExpr(0, 0);
  const result = root && pos === tokens.length ? root : null;
  cacheAst(expr, result);
  return result;
}

function cacheAst(expr: string, ast: FormulaAst | null): void {
  if (astCache.size >= AST_CACHE_LIMIT) {
    astCache.delete(astCache.keys().next().value!);
  }
  astCache.set(expr, ast);
}

export interface AstReferenceSummary {
  cells: { sheetName?: string; row: number; col: number }[];
  ranges: { sheetName?: string; startRow: number; startCol: number; endRow: number; endCol: number }[];
  names: string[];
  hasVolatile: boolean;
  hasDynamicRef: boolean;
}

const VOLATILE_FNS = new Set(["TODAY", "NOW", "RAND", "RANDBETWEEN"]);
const DYNAMIC_REF_FNS = new Set(["INDIRECT", "OFFSET"]);

/** Static reference extraction over an AST for building dependency graphs without evaluating. */
export function extractAstReferences(ast: FormulaAst): AstReferenceSummary {
  const out: AstReferenceSummary = { cells: [], ranges: [], names: [], hasVolatile: false, hasDynamicRef: false };
  const walk = (node: FormulaAst) => {
    switch (node.kind) {
      case "cell":
        out.cells.push({ sheetName: node.sheetName, row: node.row, col: node.col });
        break;
      case "range":
        out.ranges.push({
          sheetName: node.sheetName,
          startRow: node.startRow,
          startCol: node.startCol,
          endRow: node.endRow,
          endCol: node.endCol,
        });
        break;
      case "name":
        out.names.push(node.name);
        break;
      case "unary":
      case "percent":
        walk(node.arg);
        break;
      case "binary":
        walk(node.left);
        walk(node.right);
        break;
      case "call":
        if (VOLATILE_FNS.has(node.name)) out.hasVolatile = true;
        if (DYNAMIC_REF_FNS.has(node.name)) out.hasDynamicRef = true;
        for (const a of node.args) walk(a);
        break;
      case "array":
        for (const row of node.rows) for (const item of row) walk(item);
        break;
    }
  };
  walk(ast);
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
    if (t0.kind === "colrange") {
      const sid = t0.sheetName ? (byTitle.get(t0.sheetName.trim().toLowerCase()) ?? -1) : activeSheetId;
      const targetSheet = sheets.find((s) => s.id === sid);
      if (sid > 0 && targetSheet) {
        out.push({
          sheetId: sid,
          top: 0,
          left: t0.c1,
          bottom: Math.max(0, targetSheet.rows.length - 1),
          right: t0.c2,
          color: FORMULA_REF_PALETTE[out.length % FORMULA_REF_PALETTE.length],
          text: t0.text,
        });
      }
      continue;
    }
    if (t0.kind !== "cell") continue;
    const sid = t0.sheetName ? (byTitle.get(t0.sheetName.trim().toLowerCase()) ?? -1) : activeSheetId;
    const nextOp = tokens[i + 1];
    const nextRef = tokens[i + 2];
    if (nextOp?.kind === "op" && nextOp.text === ":" && nextRef?.kind === "cell" && !nextRef.sheetName) {
      if (sid > 0) {
        out.push({
          sheetId: sid,
          top: Math.min(t0.ref.row, nextRef.ref.row),
          left: Math.min(t0.ref.col, nextRef.ref.col),
          bottom: Math.max(t0.ref.row, nextRef.ref.row),
          right: Math.max(t0.ref.col, nextRef.ref.col),
          color: FORMULA_REF_PALETTE[out.length % FORMULA_REF_PALETTE.length],
          text: `${t0.text}:${nextRef.text}`,
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
          if (rest[end + 1] === '"') { end += 2; continue; }
          end++;
          break;
        }
        end++;
      }
      out += rest.slice(0, end);
      i += end;
      continue;
    }
    const sheetRef = /^((?:'(?:[^']|'')+'|[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_.\u4e00-\u9fa5]{0,30})!)(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})/.exec(rest);
    if (sheetRef) {
      const parsed = parseA1Token(sheetRef[2]);
      if (!parsed) out += "#REF!";
      else {
        const nextRow = parsed.rowAbs ? parsed.row : parsed.row + rowDelta;
        const nextCol = parsed.colAbs ? parsed.col : parsed.col + colDelta;
        if (nextRow < 0 || nextCol < 0 || nextRow >= maxRows || nextCol >= maxCols) out += "#REF!";
        else out += `${sheetRef[1]}${parsed.colAbs ? "$" : ""}${columnName(nextCol)}${parsed.rowAbs ? "$" : ""}${nextRow + 1}`;
      }
      i += sheetRef[0].length;
      continue;
    }
    const word = /^(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}|[A-Za-z_][A-Za-z0-9_.]*)/.exec(rest);
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

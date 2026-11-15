import { pointKey, PREVIEW_COLS, PREVIEW_ROWS, type SheetCells, type SheetPoint } from "./gridModel";

/** A deliberately small, bounded formula subset for the transient grid preview. */
export type FormulaValue = number | string;
type Failure = { error: string };
type Value = number | Failure;
type Ref = { row: number; col: number; rowAbsolute: boolean; colAbsolute: boolean };
type Token = { kind: string; text: string };
const fail = (error: string): Failure => ({ error });
const isFailure = (value: Value): value is Failure => typeof value !== "number";
const MAX_TOKENS = 1024, MAX_DEPTH = 80, MAX_OPERATIONS = 20000;

function reference(text: string): Ref | null {
  const match = /^(\$?)([A-Za-z]+)(\$?)([1-9]\d*)$/.exec(text);
  if (!match || match[2].length > 3 || match[4].length > 7) return null;
  let col = 0;
  for (const ch of match[2].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  return { col: col - 1, row: Number(match[4]) - 1, colAbsolute: !!match[1], rowAbsolute: !!match[3] };
}
function inBounds(ref: Ref): boolean { return ref.row >= 0 && ref.row < PREVIEW_ROWS && ref.col >= 0 && ref.col < PREVIEW_COLS; }
function tokenize(input: string): Token[] | null {
  const result: Token[] = [];
  let pos = 0;
  while (pos < input.length) {
    if (/\s/.test(input[pos])) { pos++; continue; }
    const rest = input.slice(pos);
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (match) { result.push({ kind: "number", text: match[0] }); pos += match[0].length; }
    else {
      const word = /^(?:\$?[A-Za-z]+\$?[1-9]\d*|[A-Za-z_][A-Za-z_0-9]*)(?![A-Za-z_0-9])/.exec(rest);
      if (word) { result.push({ kind: reference(word[0]) ? "ref" : "name", text: word[0] }); pos += word[0].length; }
      else if (rest.startsWith("#REF!")) { result.push({ kind: "badref", text: "#REF!" }); pos += 5; }
      else if ("+-*/^(),:".includes(input[pos])) { result.push({ kind: input[pos], text: input[pos++] }); }
      else return null;
    }
    if (result.length > MAX_TOKENS) return null;
  }
  return result;
}

/** Recalculate dependent cells from raw contents without evaluating JavaScript. */
export function calculateSheet(cells: SheetCells): Record<string, FormulaValue> {
  const cache: Record<string, Value> = {}, active = new Set<string>();
  let operations = 0;
  const evaluate = (point: SheetPoint, depth: number): Value => {
    const key = pointKey(point);
    if (cache[key] !== undefined) return cache[key];
    if (active.has(key)) return fail("#CYCLE!");
    if (depth > MAX_DEPTH || ++operations > MAX_OPERATIONS) return fail("#LIMIT!");
    const raw = cells[key] ?? "";
    if (!raw.startsWith("=")) {
      if (!raw.trim()) return 0;
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? numeric : fail("#VALUE!");
    }
    active.add(key);
    const tokens = tokenize(raw.slice(1));
    let index = 0;
    const parse = (minimum: number, nesting: number): Value => {
      if (nesting > MAX_DEPTH || ++operations > MAX_OPERATIONS) return fail("#LIMIT!");
      const token = tokens?.[index++];
      if (!token) return fail("#ERROR!");
      let value: Value;
      if (token.kind === "number") value = Number(token.text);
      else if (token.kind === "+" || token.kind === "-") {
        value = parse(4, nesting + 1);
        if (!isFailure(value) && token.kind === "-") value = -value;
      } else if (token.kind === "(") {
        value = parse(0, nesting + 1);
        if (isFailure(value)) return value;
        if (tokens?.[index++]?.kind !== ")") return fail("#ERROR!");
      } else if (token.kind === "badref") value = fail("#REF!");
      else if (token.kind === "ref") {
        const ref = reference(token.text)!;
        value = inBounds(ref) ? evaluate(ref, depth + 1) : fail("#REF!");
      } else if (token.kind === "name") {
        const name = token.text.toUpperCase();
        if (tokens?.[index++]?.kind !== "(") return fail("#NAME?");
        if (!["SUM", "AVERAGE", "MIN", "MAX", "COUNT"].includes(name)) return fail("#NAME?");
        const values: number[] = [];
        if (tokens[index]?.kind !== ")") {
          while (true) {
            if (tokens[index]?.kind === "ref" && tokens[index + 1]?.kind === ":" && tokens[index + 2]?.kind === "ref") {
              const a = reference(tokens[index].text)!, b = reference(tokens[index + 2].text)!; index += 3;
              if (!inBounds(a) || !inBounds(b)) return fail("#REF!");
              for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col++) {
                if (++operations > MAX_OPERATIONS) return fail("#LIMIT!");
                const item = cells[pointKey({ row, col })] ?? "";
                if (!item.trim()) continue;
                if (!item.startsWith("=") && !Number.isFinite(Number(item))) continue;
                const number = evaluate({ row, col }, depth + 1);
                if (isFailure(number)) return number;
                values.push(number);
              }
            } else {
              const item = parse(0, nesting + 1);
              if (isFailure(item)) return item;
              values.push(item);
            }
            if (tokens[index]?.kind !== ",") break;
            index++;
          }
        }
        if (tokens[index++]?.kind !== ")") return fail("#ERROR!");
        if (name === "COUNT") value = values.length;
        else if (name === "SUM") value = values.reduce((a, b) => a + b, 0);
        else if (name === "AVERAGE") value = values.length ? values.reduce((a, b) => a + b, 0) / values.length : fail("#DIV/0!");
        else value = values.length ? (name === "MIN" ? Math.min(...values) : Math.max(...values)) : 0;
      } else return fail("#ERROR!");
      while (tokens && index < tokens.length) {
        const operator = tokens[index].kind;
        const precedence = operator === "+" || operator === "-" ? 1 : operator === "*" || operator === "/" ? 2 : operator === "^" ? 3 : 0;
        if (!precedence || precedence < minimum) break;
        index++;
        const right = parse(precedence + (operator === "^" ? 0 : 1), nesting + 1);
        if (isFailure(value)) return value;
        if (isFailure(right)) return right;
        if (operator === "+") value += right;
        else if (operator === "-") value -= right;
        else if (operator === "*") value *= right;
        else if (operator === "/") value = right === 0 ? fail("#DIV/0!") : value / right;
        else value **= right;
      }
      return !isFailure(value) && !Number.isFinite(value) ? fail("#NUM!") : value;
    };
    let result = tokens ? parse(0, 0) : fail("#ERROR!");
    if (!isFailure(result) && index !== tokens?.length) result = fail("#ERROR!");
    active.delete(key);
    // A budget/depth failure depends on the current root; do not poison other cells.
    if (!isFailure(result) || result.error !== "#LIMIT!") cache[key] = result;
    return result;
  };
  const output: Record<string, FormulaValue> = {};
  for (const [key, raw] of Object.entries(cells)) {
    if (!raw.startsWith("=")) { output[key] = raw; continue; }
    const [row, col] = key.split(":").map(Number);
    operations = 0;
    const value = evaluate({ row, col }, 0);
    output[key] = isFailure(value) ? value.error : Number(value.toPrecision(15));
  }
  return output;
}

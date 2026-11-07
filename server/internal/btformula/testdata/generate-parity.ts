// Regenerate with: packages/collab/node_modules/.bin/tsx server/internal/btformula/testdata/generate-parity.ts
// This executes the actual frontend engine. The resulting JSON is consumed by
// Go tests, so both implementations share the same expected cases.
import { evalFormula, FormulaError, type FormulaValue } from "../../../../apps/web/src/pages/base/formula";

type Case = { expression: string; values?: Record<string, FormulaValue> };
const cases: Case[] = [
  { expression: "2 ^ 3 ^ 2" }, { expression: "-[价格]+10", values: { 价格: 4 } },
  { expression: "[数量]*[单价]", values: { 数量: 3, 单价: 2.5 } },
  { expression: 'IF([分]>=60,"通过",1/0)', values: { 分: 88 } },
  { expression: 'IF(TRUE,1,UNKNOWN())' }, { expression: 'IFS(FALSE,0,TRUE,4)' },
  { expression: 'SUM(1,2,3.5)' }, { expression: 'NOT()' }, { expression: 'ISBLANK()' },
  { expression: 'VALUE()' }, { expression: 'LEN()' }, { expression: 'UPPER()' },
  { expression: 'TRIM()' }, { expression: 'CONTAINS()' }, { expression: 'CONTAINS("undefined")' },
  { expression: 'LEFT()' }, { expression: 'LEFT("x")' }, { expression: 'TEXT()' },
  { expression: 'VALUE("Inf")' }, { expression: 'VALUE("1_2")' },
  { expression: 'VALUE("0x+1")' }, { expression: 'VALUE("0x10000000000000000")' },
  { expression: 'VALUE("0b101")' }, { expression: 'VALUE("1e400")' },
  { expression: 'TRIM("\ufeffx\ufeff")' }, { expression: 'TRIM("\u0085x\u0085")' },
  { expression: '[i̇]', values: { İ: 42 } }, { expression: '[\ufeff金额\ufeff]', values: { 金额: 2 } },
  { expression: 'UPPER("straße")' }, { expression: 'RIGHT("abcde",2.5)' },
  { expression: 'MID("abcdef",2.5,1.5)' }, { expression: 'LEFT("😀",1)' },
  { expression: '"𐀀" < ""' }, { expression: 'TEXT(0.0000001)' },
  { expression: 'FOO(1/0)' }, { expression: '1/0' }, { expression: 'SQRT(-1)' },
  { expression: 'ROUND(1.4999999999999998)' }, { expression: 'ROUND(-0.5)' },
  { expression: '(-1)^VALUE("Infinity")' }, { expression: 'POW(1,VALUE("Infinity"))' },
  { expression: 'TEXT(2^2.5)' }, { expression: '(2^2.5)=5.65685424949238' }, { expression: 'ROUND(2,0.5)' },
];

// Exercise conversions and ordering across the literal value classes the UI
// can actually produce. A fixed corpus makes output reproducible in CI.
const literals = ["0", "1", "-1", "2.5", "TRUE", "FALSE", "BLANK()", '""', '" 2 "', '"x"', '"😀"', '"0x10"'];
for (const left of literals) for (const right of literals) {
  for (const op of ["+", "-", "*", "/", "%", "^", "&", "=", "!=", "<", ">="]) cases.push({ expression: `(${left})${op}(${right})` });
}
for (const value of literals) for (const fn of ["ABS", "FLOOR", "CEILING", "INT", "SQRT", "NOT", "ISBLANK", "LEN", "UPPER", "LOWER", "TRIM", "VALUE", "TEXT"]) cases.push({ expression: `${fn}(${value})` });

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

const vectors = cases.map(({ expression, values = {} }) => {
  const byName = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  try {
    const result = evalFormula(expression, { get: (name) => byName.get(name.toLowerCase()) ?? null });
    if (result === undefined || (typeof result === "number" && !Number.isFinite(result)) || (typeof result === "string" && hasLoneSurrogate(result))) return { expression, values, unsupported: true };
    // Fractional powers are explicitly unsupported by the Go evaluator until
    // browser-compatible numerical semantics can be guaranteed. In particular,
    // even one ULP can change a subsequent TEXT() or equality result.
    if ((expression.endsWith('^(2.5)') && typeof result === "number" && result !== 0 && result !== 1) ||
        ["TEXT(2^2.5)", "(2^2.5)=5.65685424949238", "ROUND(2,0.5)"].includes(expression)) return { expression, values, unsupported: true, reason: "fractional-pow" };
    return { expression, values, result };
  } catch (error) {
    return { expression, values, error: error instanceof FormulaError ? error.message : "#错误" };
  }
});
process.stdout.write(JSON.stringify(vectors, null, 2) + "\n");

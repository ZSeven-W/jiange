import { describe, expect, it } from "vitest";
import { evalFormula, FormulaError, formulaRefs, formulaValid } from "./formula";

const env = (vars: Record<string, unknown>) => ({
  get: (name: string) => {
    const k = Object.keys(vars).find((x) => x.toLowerCase() === name.toLowerCase());
    if (k === undefined) return null;
    const v = vars[k];
    return v === undefined ? null : (v as number | string | boolean | null);
  },
});

describe("formula engine", () => {
  it("arithmetic, precedence and right-associative power", () => {
    expect(evalFormula("1 + 2 * 3", env({}))).toBe(7);
    expect(evalFormula("(1 + 2) * 3", env({}))).toBe(9);
    expect(evalFormula("2 ^ 3 ^ 2", env({}))).toBe(512);
    expect(evalFormula("-[价格] + 10", env({ 价格: 4 }))).toBe(6);
    expect(evalFormula("10 % 3", env({}))).toBe(1);
    expect(evalFormula('"a" & "b" & 1', env({}))).toBe("ab1");
  });

  it("field refs are case-insensitive and missing refs are blank", () => {
    expect(evalFormula("[数量] * [单价]", env({ 数量: 3, 单价: 2.5 }))).toBe(7.5);
    expect(evalFormula("[不存在] & \"\"", env({}))).toBe("");
    expect(formulaRefs("[A] + [b] * [A]")).toEqual(["A", "b"]);
  });

  it("comparison and logic", () => {
    expect(evalFormula("[分] >= 60", env({ 分: 75 }))).toBe(true);
    expect(evalFormula('IF([分] >= 90, "优", IF([分] >= 60, "及格", "不及格"))', env({ 分: 88 }))).toBe("及格");
    expect(evalFormula("AND(TRUE, [开])", env({ 开: true }))).toBe(true);
    expect(evalFormula("NOT(FALSE)")).toBe(true);
    expect(evalFormula("IFS([x] > 10, \"大\", [x] > 5, \"中\", TRUE, \"小\")", env({ x: 7 }))).toBe("中");
  });

  it("covers the function library", () => {
    expect(evalFormula("ABS(-3.5)", env({}))).toBe(3.5);
    expect(evalFormula("ROUND(2.678, 2)", env({}))).toBe(2.68);
    expect(evalFormula("MOD(10, 4)", env({}))).toBe(2);
    expect(evalFormula("POW(2, 8)", env({}))).toBe(256);
    expect(evalFormula("SQRT(81)", env({}))).toBe(9);
    expect(evalFormula("MIN(3, 1, 2) + MAX(3, 1, 2)", env({}))).toBe(4);
    expect(evalFormula("SUM(1, 2, 3.5)", env({}))).toBe(6.5);
    expect(evalFormula("AVERAGE(2, 4, 6)", env({}))).toBe(4);
    expect(evalFormula('LEN("你好世界")', env({}))).toBe(4);
    expect(evalFormula('UPPER("abc") & LOWER("DEF")', env({}))).toBe("ABCdef");
    expect(evalFormula('CONCATENATE("a", 1, TRUE)', env({}))).toBe("a1TRUE");
    expect(evalFormula('LEFT("飞书多维表格", 2)', env({}))).toBe("飞书");
    expect(evalFormula('RIGHT("飞书多维表格", 3)', env({}))).toBe("维表格");
    expect(evalFormula('MID("abcdef", 2, 3)', env({}))).toBe("bcd");
    expect(evalFormula('TRIM("  x  ") & "|"', env({}))).toBe("x|");
    expect(evalFormula('CONTAINS("hello", "ell")', env({}))).toBe(true);
    expect(evalFormula("ISBLANK([v])", env({ v: "" }))).toBe(true);
    expect(evalFormula("VALUE(\"42\") + 1", env({}))).toBe(43);
    expect(evalFormula('YEAR("2026-03-05")', env({}))).toBe(2026);
    expect(evalFormula('MONTH("2026-03-05")', env({}))).toBe(3);
    expect(evalFormula('DAY("2026-03-05")', env({}))).toBe(5);
    expect(evalFormula("YEAR(TODAY())", env({}))).toBe(new Date().getFullYear());
  });

  it("error values and syntax rejection", () => {
    expect(() => evalFormula("1 / 0", env({}))).toThrow(FormulaError);
    expect(() => evalFormula("1 +", env({}))).toThrow(FormulaError);
    expect(() => evalFormula("[x", env({}))).toThrow(FormulaError);
    expect(() => evalFormula("NOSUCHFN(1)", env({}))).toThrow(/#NAME\?/);
    expect(formulaValid("[a] + 1")).toBe(true);
    expect(formulaValid("[a] +")).toBe(false);
    expect(formulaValid("IF(1, 2)")).toBe(true);
    // string comparison
    expect(evalFormula('"b" > "a"', env({}))).toBe(true);
    expect(evalFormula('[状态] = "完成"', env({ 状态: "完成" }))).toBe(true);
  });
});

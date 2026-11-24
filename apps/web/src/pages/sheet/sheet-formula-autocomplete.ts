import { SUPPORTED_FORMULA_FUNCTIONS } from "@jiange/sheet-sdk/formula-functions";

export type FormulaCategory =
  | "math"
  | "stat"
  | "logic"
  | "lookup"
  | "text"
  | "date"
  | "array"
  | "finance"
  | "info";

export interface FormulaFunctionSpec {
  name: string;
  category: FormulaCategory;
  args: readonly string[];
  description: string;
  popular?: boolean;
}

export const FORMULA_CATEGORY_LABELS: Record<FormulaCategory, string> = {
  math: "数学",
  stat: "统计",
  logic: "逻辑",
  lookup: "查找",
  text: "文本",
  date: "日期",
  array: "数组",
  finance: "财务",
  info: "信息",
};

const CURATED_SPECS: readonly FormulaFunctionSpec[] = [
  // Math & Stats
  { name: "SUM", category: "math", args: ["数值1", "[数值2]", "..."], description: "计算单元格区域或数值之和", popular: true },
  { name: "AVERAGE", category: "stat", args: ["数值1", "[数值2]", "..."], description: "计算参数的算术平均值", popular: true },
  { name: "COUNT", category: "stat", args: ["值1", "[值2]", "..."], description: "统计包含数字的单元格个数", popular: true },
  { name: "COUNTA", category: "stat", args: ["值1", "[值2]", "..."], description: "统计非空单元格个数", popular: true },
  { name: "COUNTBLANK", category: "stat", args: ["区域"], description: "统计区域内空白单元格个数" },
  { name: "MIN", category: "stat", args: ["数值1", "[数值2]", "..."], description: "返回一组数值中的最小值", popular: true },
  { name: "MAX", category: "stat", args: ["数值1", "[数值2]", "..."], description: "返回一组数值中的最大值", popular: true },
  { name: "MEDIAN", category: "stat", args: ["数值1", "[数值2]", "..."], description: "返回给定数值集合的中位数" },
  { name: "PRODUCT", category: "math", args: ["数值1", "[数值2]", "..."], description: "计算所有参数的乘积" },
  { name: "SUMPRODUCT", category: "math", args: ["数组1", "[数组2]", "..."], description: "返回对应数组元素乘积之和", popular: true },
  { name: "SUBTOTAL", category: "math", args: ["函数编号", "引用1", "[引用2]", "..."], description: "返回列表或数据区域中的分类汇总" },
  { name: "ROUND", category: "math", args: ["数值", "小数位数"], description: "按指定位数四舍五入", popular: true },
  { name: "ROUNDUP", category: "math", args: ["数值", "小数位数"], description: "远离零值向上舍入数值" },
  { name: "ROUNDDOWN", category: "math", args: ["数值", "小数位数"], description: "趋近零值向下舍入数值" },
  { name: "ABS", category: "math", args: ["数值"], description: "返回数值的绝对值" },
  { name: "INT", category: "math", args: ["数值"], description: "将数值向下取整为最接近的整数" },
  { name: "MOD", category: "math", args: ["被除数", "除数"], description: "返回两数相除的余数" },
  { name: "POWER", category: "math", args: ["底数", "幂"], description: "返回数字的乘幂结果" },
  { name: "SQRT", category: "math", args: ["数值"], description: "返回正平方根" },
  { name: "RANK", category: "stat", args: ["数值", "引用区域", "[排序方式]"], description: "返回某数值在区域中的排名" },
  { name: "LARGE", category: "stat", args: ["区域", "第K大"], description: "返回数据集中第 K 个最大值" },
  { name: "SMALL", category: "stat", args: ["区域", "第K小"], description: "返回数据集中第 K 个最小值" },
  { name: "PERCENTILE", category: "stat", args: ["区域", "百分位K"], description: "返回区域中数值的第 K 个百分点值" },
  { name: "STDEV", category: "stat", args: ["数值1", "[数值2]", "..."], description: "基于样本估算标准偏差" },
  { name: "RANDBETWEEN", category: "math", args: ["最小值", "最大值"], description: "返回指定两个整数之间的随机整数" },

  // Conditional Aggregation
  { name: "SUMIF", category: "math", args: ["条件区域", "条件", "[求和区域]"], description: "对满足单个条件的单元格求和", popular: true },
  { name: "SUMIFS", category: "math", args: ["求和区域", "条件区域1", "条件1", "..."], description: "对满足多个条件的单元格求和", popular: true },
  { name: "COUNTIF", category: "stat", args: ["区域", "条件"], description: "统计区域中满足指定条件的单元格数", popular: true },
  { name: "COUNTIFS", category: "stat", args: ["条件区域1", "条件1", "..."], description: "统计同时满足多个条件的单元格数", popular: true },
  { name: "AVERAGEIF", category: "stat", args: ["条件区域", "条件", "[均值区域]"], description: "计算满足单个条件的单元格平均值" },
  { name: "AVERAGEIFS", category: "stat", args: ["均值区域", "条件区域1", "条件1", "..."], description: "计算满足多个条件的单元格平均值" },
  { name: "MAXIFS", category: "stat", args: ["最大值区域", "条件区域1", "条件1", "..."], description: "返回同时满足多个条件的最大值" },
  { name: "MINIFS", category: "stat", args: ["最小值区域", "条件区域1", "条件1", "..."], description: "返回同时满足多个条件的最小值" },

  // Logic
  { name: "IF", category: "logic", args: ["判断条件", "真值结果", "[假值结果]"], description: "根据逻辑条件返回不同结果", popular: true },
  { name: "IFS", category: "logic", args: ["条件1", "结果1", "[条件2]", "[结果2]", "..."], description: "依次检查多个条件并返回首个为真的结果", popular: true },
  { name: "SWITCH", category: "logic", args: ["表达式", "值1", "结果1", "[默认值]"], description: "将表达式与值列表匹配并返回对应结果" },
  { name: "IFERROR", category: "logic", args: ["表达式", "出错返回值"], description: "公式计算出错时返回指定替代值", popular: true },
  { name: "IFNA", category: "logic", args: ["表达式", "NA替代值"], description: "公式返回 #N/A 时返回指定替代值" },
  { name: "AND", category: "logic", args: ["逻辑值1", "[逻辑值2]", "..."], description: "所有参数均为真时返回 TRUE" },
  { name: "OR", category: "logic", args: ["逻辑值1", "[逻辑值2]", "..."], description: "任一参数为真时返回 TRUE" },
  { name: "NOT", category: "logic", args: ["逻辑值"], description: "对逻辑值求反" },
  { name: "XOR", category: "logic", args: ["逻辑值1", "[逻辑值2]", "..."], description: "返回全部参数的逻辑异或结果" },

  // Lookup & Reference
  { name: "VLOOKUP", category: "lookup", args: ["查找值", "查找区域", "返回列序", "[精确匹配]"], description: "在表格首列纵向查找并返回指定列数据", popular: true },
  { name: "HLOOKUP", category: "lookup", args: ["查找值", "查找区域", "返回行序", "[精确匹配]"], description: "在表格首行横向查找并返回指定行数据" },
  { name: "XLOOKUP", category: "lookup", args: ["查找值", "查找数组", "返回数组", "[未找到值]", "[匹配模式]", "[搜索模式]"], description: "现代查找函数，支持任意方向与默认兜底值", popular: true },
  { name: "INDEX", category: "lookup", args: ["区域", "行号", "[列号]"], description: "返回区域中指定行列交叉处的值", popular: true },
  { name: "MATCH", category: "lookup", args: ["查找值", "查找区域", "[匹配类型]"], description: "返回指定项在区域中的相对位置", popular: true },
  { name: "XMATCH", category: "lookup", args: ["查找值", "查找数组", "[匹配模式]", "[搜索模式]"], description: "返回项在数组中的精确或近似位置" },
  { name: "CHOOSE", category: "lookup", args: ["索引号", "值1", "[值2]", "..."], description: "根据索引号从参数列表中选择对应值" },
  { name: "OFFSET", category: "lookup", args: ["基点引用", "行偏移", "列偏移", "[高度]", "[宽度]"], description: "以指定引用为基点按偏移量返回新区域" },
  { name: "INDIRECT", category: "lookup", args: ["文本引用"], description: "返回由文本字符串指定的单元格引用" },
  { name: "TRANSPOSE", category: "lookup", args: ["数组"], description: "转置单元格区域的行和列" },
  { name: "HYPERLINK", category: "lookup", args: ["链接地址", "[显示文本]"], description: "创建可点击跳转的超链接文本" },

  // Text
  { name: "CONCAT", category: "text", args: ["文本1", "[文本2]", "..."], description: "合并多个文本或单元格区域", popular: true },
  { name: "CONCATENATE", category: "text", args: ["文本1", "[文本2]", "..."], description: "将多个文本字符串联接为一个" },
  { name: "TEXTJOIN", category: "text", args: ["分隔符", "忽略空值", "文本1", "..."], description: "用分隔符拼接多段文本并支持忽略空值", popular: true },
  { name: "LEFT", category: "text", args: ["文本", "[字符数]"], description: "从文本左侧提取指定数量的字符" },
  { name: "RIGHT", category: "text", args: ["文本", "[字符数]"], description: "从文本右侧提取指定数量的字符" },
  { name: "MID", category: "text", args: ["文本", "起始位置", "字符数"], description: "从文本指定位置截取定长子串" },
  { name: "LEN", category: "text", args: ["文本"], description: "返回文本字符串的字符长度" },
  { name: "FIND", category: "text", args: ["查找文本", "目标文本", "[起始位置]"], description: "区分大小写查找子串起始位置" },
  { name: "SEARCH", category: "text", args: ["查找文本", "目标文本", "[起始位置]"], description: "不区分大小写查找子串起始位置" },
  { name: "SUBSTITUTE", category: "text", args: ["原文本", "旧文本", "新文本", "[替换序数]"], description: "将文本中的指定旧内容替换为新内容" },
  { name: "REPLACE", category: "text", args: ["原文本", "起始位置", "替换长度", "新文本"], description: "按起始位置和长度替换部分文本" },
  { name: "TRIM", category: "text", args: ["文本"], description: "清除文本首尾及多余空格" },
  { name: "UPPER", category: "text", args: ["文本"], description: "将文本转换为全大写" },
  { name: "LOWER", category: "text", args: ["文本"], description: "将文本转换为全小写" },
  { name: "TEXT", category: "text", args: ["数值", "格式代码"], description: "按指定数字格式将数值转为文本", popular: true },
  { name: "VALUE", category: "text", args: ["文本"], description: "将表示数字的文本转换为数值" },
  { name: "SPLIT", category: "text", args: ["文本", "分隔符"], description: "按分隔符将文本拆分为数组" },
  { name: "REGEXMATCH", category: "text", args: ["文本", "正则表达式"], description: "判断文本是否匹配正则表达式", popular: true },
  { name: "REGEXREPLACE", category: "text", args: ["文本", "正则表达式", "替换文本"], description: "使用正则表达式替换文本中的匹配内容" },
  { name: "REGEXEXTRACT", category: "text", args: ["文本", "正则表达式"], description: "使用正则表达式提取首个匹配子串或捕获组" },

  // Date & Time
  { name: "TODAY", category: "date", args: [], description: "返回当前系统日期", popular: true },
  { name: "NOW", category: "date", args: [], description: "返回当前系统日期和时间" },
  { name: "DATE", category: "date", args: ["年", "月", "日"], description: "根据年月日构造日期值" },
  { name: "YEAR", category: "date", args: ["日期"], description: "提取日期中的年份" },
  { name: "MONTH", category: "date", args: ["日期"], description: "提取日期中的月份（1-12）" },
  { name: "DAY", category: "date", args: ["日期"], description: "提取日期中的天数（1-31）" },
  { name: "DAYS", category: "date", args: ["结束日期", "开始日期"], description: "计算两个日期之间相差的天数" },
  { name: "DATEDIF", category: "date", args: ["开始日期", "结束日期", "单位"], description: "计算两日期之间的年/月/日差值（Y/M/D）", popular: true },
  { name: "EDATE", category: "date", args: ["开始日期", "月数"], description: "返回指定日期前后若干月的日期" },
  { name: "EOMONTH", category: "date", args: ["开始日期", "月数"], description: "返回指定月数前后对应的月末日期" },
  { name: "WEEKDAY", category: "date", args: ["日期", "[返回类型]"], description: "返回日期对应的星期序号" },
  { name: "WORKDAY", category: "date", args: ["开始日期", "天数", "[节假日]"], description: "返回指定工作日天数之后的日期" },
  { name: "NETWORKDAYS", category: "date", args: ["开始日期", "结束日期", "[节假日]"], description: "计算两日期之间的完整工作日天数" },

  // Dynamic Array
  { name: "FILTER", category: "array", args: ["数组", "筛选条件", "[空结果替代]"], description: "按条件动态筛选数组中的记录", popular: true },
  { name: "SORT", category: "array", args: ["数组", "[排序列]", "[排序顺序]", "[按列排序]"], description: "对区域或数组内容进行动态排序", popular: true },
  { name: "SORTBY", category: "array", args: ["数组", "依据数组1", "[排序顺序1]", "..."], description: "按另一区域的值对数组进行排序" },
  { name: "UNIQUE", category: "array", args: ["数组", "[按列比较]", "[仅出现一次]"], description: "提取区域或数组中的唯一值列表", popular: true },
  { name: "SEQUENCE", category: "array", args: ["行数", "[列数]", "[起始值]", "[步长]"], description: "生成等差连续数字序列数组" },
  { name: "ARRAYFORMULA", category: "array", args: ["数组公式"], description: "启用数组运算并自动溢出多行多列结果", popular: true },
  { name: "QUERY", category: "array", args: ["数据区域", "查询语句", "[表头行数]"], description: "使用类 SQL 语句筛选、分组、聚合和排序区域数据", popular: true },
  { name: "LET", category: "logic", args: ["名称1", "值1", "...", "计算表达式"], description: "在公式内定义局部变量并复用中间计算结果", popular: true },
  { name: "LAMBDA", category: "logic", args: ["[参数1]", "...", "函数体"], description: "定义可立即调用或配合 LET 复用的匿名函数" },
  { name: "IMAGE", category: "info", args: ["图片地址", "[替代文本]", "[缩放模式]"], description: "在单元格内嵌显示安全图片缩略图" },

  // Finance
  { name: "PMT", category: "finance", args: ["利率", "期数", "现值", "[终值]", "[类型]"], description: "计算等额分期付款的每期金额" },
  { name: "PV", category: "finance", args: ["利率", "期数", "每期付款", "[终值]", "[类型]"], description: "计算系列未来付款的现值" },
  { name: "FV", category: "finance", args: ["利率", "期数", "每期付款", "[现值]", "[类型]"], description: "计算固定利率下的投资未来值" },
  { name: "NPV", category: "finance", args: ["折现率", "现金流1", "[现金流2]", "..."], description: "计算定期现金流的净现值" },
  { name: "IRR", category: "finance", args: ["现金流区域", "[预估值]"], description: "计算一系列现金流的内部收益率" },

  // Info
  { name: "ISBLANK", category: "info", args: ["值"], description: "判断单元格是否为空白" },
  { name: "ISNUMBER", category: "info", args: ["值"], description: "判断值是否为有效数字" },
  { name: "ISTEXT", category: "info", args: ["值"], description: "判断值是否为文本类型" },
  { name: "ISERROR", category: "info", args: ["值"], description: "判断值是否为任意公式错误" },
  { name: "ISNA", category: "info", args: ["值"], description: "判断值是否为 #N/A 错误" },
];

function inferFallbackCategory(name: string): FormulaCategory {
  if (name.startsWith("IS") || name === "NA") return "info";
  if (name.startsWith("STDEV") || name.startsWith("VAR") || name === "MODE" || name === "QUARTILE") return "stat";
  if (["DATEVALUE", "TIME", "HOUR", "MINUTE", "SECOND", "WEEKNUM", "ISOWEEKNUM", "YEARFRAC"].includes(name)) return "date";
  if (["PMT", "PV", "FV", "NPV", "IRR", "NPER", "RATE"].includes(name)) return "finance";
  if (["ROW", "COLUMN", "ROWS", "COLUMNS"].includes(name)) return "lookup";
  if (["PROPER", "CLEAN", "REPT", "EXACT", "CHAR", "CODE"].includes(name)) return "text";
  if (["TRUE", "FALSE"].includes(name)) return "logic";
  return "math";
}

function buildFormulaCatalog(): { list: readonly FormulaFunctionSpec[]; map: ReadonlyMap<string, FormulaFunctionSpec> } {
  const byName = new Map<string, FormulaFunctionSpec>();
  for (const spec of CURATED_SPECS) {
    byName.set(spec.name, spec);
  }
  for (const rawName of SUPPORTED_FORMULA_FUNCTIONS) {
    const name = rawName.toUpperCase();
    if (!byName.has(name)) {
      const cat = inferFallbackCategory(name);
      const zeroArgs = name === "PI" || name === "RAND" || name === "TRUE" || name === "FALSE" || name === "NA";
      byName.set(name, {
        name,
        category: cat,
        args: zeroArgs ? [] : ["参数1", "..."],
        description: `内置${FORMULA_CATEGORY_LABELS[cat]}函数 ${name}`,
      });
    }
  }
  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { list, map: byName };
}

const CATALOG = buildFormulaCatalog();
export const FORMULA_CATALOG: readonly FormulaFunctionSpec[] = CATALOG.list;
export const FORMULA_SPEC_MAP: ReadonlyMap<string, FormulaFunctionSpec> = CATALOG.map;

export type FormulaCaretInspection =
  | {
      mode: "complete";
      prefix: string;
      replaceStart: number;
      replaceEnd: number;
      matches: FormulaFunctionSpec[];
    }
  | {
      mode: "signature";
      name: string;
      spec: FormulaFunctionSpec;
      activeArgIndex: number;
    }
  | {
      mode: "none";
    };

const IDENT_CHAR = /[A-Za-z0-9_.]/;
const ALLOWED_PREFIX_BOUNDARY = new Set([
  "=",
  "(",
  ",",
  "+",
  "-",
  "*",
  "/",
  "^",
  "&",
  "<",
  ">",
  ";",
  "{",
  " ",
  "\t",
  "\n",
]);

export function searchFormulaFunctions(prefix: string, limit = 12): FormulaFunctionSpec[] {
  const q = prefix.trim().toUpperCase();
  if (!q) return [];
  const exactPrefix: FormulaFunctionSpec[] = [];
  const substring: FormulaFunctionSpec[] = [];
  for (const spec of FORMULA_CATALOG) {
    if (spec.name.startsWith(q)) exactPrefix.push(spec);
    else if (q.length >= 2 && spec.name.includes(q)) substring.push(spec);
  }
  const rank = (a: FormulaFunctionSpec, b: FormulaFunctionSpec) => {
    if (a.name === q && b.name !== q) return -1;
    if (b.name === q && a.name !== q) return 1;
    if (!!a.popular !== !!b.popular) return a.popular ? -1 : 1;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name);
  };
  exactPrefix.sort(rank);
  substring.sort(rank);
  return [...exactPrefix, ...substring].slice(0, limit);
}

interface ParenFrame {
  fnName: string | null;
  argIndex: number;
}

/**
 * Pure parser that inspects a formula bar string + caret index and determines
 * whether the user should see live function autocomplete (`complete`),
 * parameter signature hints (`signature`), or nothing (`none`).
 */
export function inspectFormulaCaret(text: string, caret: number, limit = 12): FormulaCaretInspection {
  if (!text.startsWith("=")) return { mode: "none" };
  const clampedCaret = Math.max(0, Math.min(caret, text.length));
  if (clampedCaret < 1) return { mode: "none" };

  let inDoubleQuote = false;
  let inSingleQuote = false;
  const stack: ParenFrame[] = [];

  for (let i = 1; i < clampedCaret; i++) {
    const ch = text[i];
    if (inDoubleQuote) {
      if (ch === '"') {
        if (i + 1 < clampedCaret && text[i + 1] === '"') {
          i++; // escaped quote ""
        } else {
          inDoubleQuote = false;
        }
      }
      continue;
    }
    if (inSingleQuote) {
      if (ch === "'") {
        if (i + 1 < clampedCaret && text[i + 1] === "'") {
          i++; // escaped single quote ''
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }

    if (ch === "(") {
      let fnEnd = i;
      let fnStart = fnEnd;
      while (fnStart > 1 && IDENT_CHAR.test(text[fnStart - 1])) fnStart--;
      const rawName = text.slice(fnStart, fnEnd).toUpperCase();
      const prevCh = fnStart > 0 ? text[fnStart - 1] : "";
      const validBoundary = ALLOWED_PREFIX_BOUNDARY.has(prevCh);
      const spec = validBoundary && rawName ? FORMULA_SPEC_MAP.get(rawName) : undefined;
      stack.push({ fnName: spec ? spec.name : null, argIndex: 0 });
    } else if (ch === ",") {
      if (stack.length > 0) {
        stack[stack.length - 1].argIndex += 1;
      }
    } else if (ch === ")") {
      if (stack.length > 0) {
        stack.pop();
      }
    }
  }

  // 1. Check autocomplete mode (only when NOT inside a string literal or quoted sheet name)
  if (!inDoubleQuote && !inSingleQuote) {
    let start = clampedCaret;
    while (start > 1 && IDENT_CHAR.test(text[start - 1])) start--;
    let end = clampedCaret;
    while (end < text.length && IDENT_CHAR.test(text[end])) end++;

    const rawToken = text.slice(start, clampedCaret);
    const prevChar = start > 0 ? text[start - 1] : "";
    const nextChar = end < text.length ? text[end] : "";
    if (
      rawToken.length >= 1 &&
      /^[A-Za-z][A-Za-z0-9_.]*$/.test(rawToken) &&
      ALLOWED_PREFIX_BOUNDARY.has(prevChar) &&
      nextChar !== "(" &&
      nextChar !== "!"
    ) {
      const matches = searchFormulaFunctions(rawToken, limit);
      if (matches.length > 0) {
        return {
          mode: "complete",
          prefix: rawToken.toUpperCase(),
          replaceStart: start,
          replaceEnd: end,
          matches,
        };
      }
    }
  }

  // 2. Check enclosing function call for signature tooltip
  for (let idx = stack.length - 1; idx >= 0; idx--) {
    const frame = stack[idx];
    if (!frame.fnName) continue;
    const spec = FORMULA_SPEC_MAP.get(frame.fnName);
    if (spec) {
      return {
        mode: "signature",
        name: spec.name,
        spec,
        activeArgIndex: frame.argIndex,
      };
    }
  }

  return { mode: "none" };
}

/**
 * Resolve which index in `spec.args` should be highlighted for a 0-based `activeArgIndex`,
 * clamping variadic `"..."` tails cleanly onto the trailing variadic slot.
 */
export function resolveActiveArgHighlightIndex(args: readonly string[], activeArgIndex: number): number {
  if (args.length === 0) return -1;
  if (activeArgIndex < 0) return 0;
  if (activeArgIndex < args.length) return activeArgIndex;
  const last = args[args.length - 1];
  if (last === "...") {
    return args.length - 1;
  }
  return args.length - 1;
}

/**
 * Apply an autocomplete selection by replacing `[replaceStart, replaceEnd]` with `FUNC(`
 * (without duplicating an already-present `(`) and returning the updated string and caret.
 */
export function applyFormulaCompletion(
  text: string,
  inspection: Extract<FormulaCaretInspection, { mode: "complete" }>,
  fnName: string,
): { nextValue: string; nextCaret: number } {
  const before = text.slice(0, inspection.replaceStart);
  const after = text.slice(inspection.replaceEnd);
  const hasParen = after.startsWith("(");
  const insert = hasParen ? fnName : `${fnName}(`;
  const nextValue = `${before}${insert}${after}`;
  const nextCaret = before.length + fnName.length + 1;
  return { nextValue, nextCaret };
}

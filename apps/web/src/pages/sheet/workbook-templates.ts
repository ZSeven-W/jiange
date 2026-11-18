import type { SheetCellStyle } from "@/lib/api";

export function formatSheetRefPrefix(title: string): string {
  if (/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/.test(title)) {
    return `${title}!`;
  }
  return `'${title.replace(/'/g, "''")}'!`;
}

export interface SheetTemplateCell {
  row: number;
  col: number;
  raw: string;
  style?: SheetCellStyle;
}

export interface SheetStarterTemplate {
  id: string;
  name: string;
  tag: string;
  cells: SheetTemplateCell[];
}

const HEADER_STYLE: SheetCellStyle = {
  bold: true,
  bg: "#eef3ff",
  color: "#1f2329",
  align: "center",
  borders: { top: true, right: true, bottom: true, left: true, color: "#dee0e3" },
};

const CELL_BORDER: SheetCellStyle = {
  borders: { top: true, right: true, bottom: true, left: true, color: "#dee0e3" },
};

export const SHEET_STARTER_TEMPLATES: SheetStarterTemplate[] = [
  {
    id: "project-tracker",
    name: "项目进度跟进表",
    tag: "项目管理",
    cells: [
      { row: 0, col: 0, raw: "任务模块", style: HEADER_STYLE },
      { row: 0, col: 1, raw: "负责人", style: HEADER_STYLE },
      { row: 0, col: 2, raw: "预算(元)", style: HEADER_STYLE },
      { row: 0, col: 3, raw: "实际支出", style: HEADER_STYLE },
      { row: 0, col: 4, raw: "偏差率", style: HEADER_STYLE },
      { row: 1, col: 0, raw: "需求评审与原型设计", style: CELL_BORDER },
      { row: 1, col: 1, raw: "张敏", style: { ...CELL_BORDER, align: "center" } },
      { row: 1, col: 2, raw: "12000", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 1, col: 3, raw: "11500", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 1, col: 4, raw: "=(D2-C2)/C2", style: { ...CELL_BORDER, numFmt: "percent" } },
      { row: 2, col: 0, raw: "核心模块研发", style: CELL_BORDER },
      { row: 2, col: 1, raw: "李强", style: { ...CELL_BORDER, align: "center" } },
      { row: 2, col: 2, raw: "45000", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 2, col: 3, raw: "43800", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 2, col: 4, raw: "=(D3-C3)/C3", style: { ...CELL_BORDER, numFmt: "percent" } },
      { row: 3, col: 0, raw: "联调测试与上线", style: CELL_BORDER },
      { row: 3, col: 1, raw: "王芳", style: { ...CELL_BORDER, align: "center" } },
      { row: 3, col: 2, raw: "18000", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 3, col: 3, raw: "18000", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 3, col: 4, raw: "=(D4-C4)/C4", style: { ...CELL_BORDER, numFmt: "percent" } },
      { row: 4, col: 0, raw: "合计", style: { ...HEADER_STYLE, bg: "#f7f8fa" } },
      { row: 4, col: 1, raw: "", style: { ...HEADER_STYLE, bg: "#f7f8fa" } },
      { row: 4, col: 2, raw: "=SUM(C2:C4)", style: { ...HEADER_STYLE, bg: "#f7f8fa", numFmt: "currency", align: "right" } },
      { row: 4, col: 3, raw: "=SUM(D2:D4)", style: { ...HEADER_STYLE, bg: "#f7f8fa", numFmt: "currency", align: "right" } },
      { row: 4, col: 4, raw: "=(D5-C5)/C5", style: { ...HEADER_STYLE, bg: "#f7f8fa", numFmt: "percent", align: "right" } },
    ],
  },
  {
    id: "department-budget",
    name: "部门费用明细表",
    tag: "财务报销",
    cells: [
      { row: 0, col: 0, raw: "费用类别", style: HEADER_STYLE },
      { row: 0, col: 1, raw: "一月", style: HEADER_STYLE },
      { row: 0, col: 2, raw: "二月", style: HEADER_STYLE },
      { row: 0, col: 3, raw: "三月", style: HEADER_STYLE },
      { row: 0, col: 4, raw: "季度合计", style: HEADER_STYLE },
      { row: 1, col: 0, raw: "云服务与算力", style: CELL_BORDER },
      { row: 1, col: 1, raw: "8600", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 1, col: 2, raw: "9200", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 1, col: 3, raw: "9800", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 1, col: 4, raw: "=SUM(B2:D2)", style: { ...CELL_BORDER, bold: true, numFmt: "currency" } },
      { row: 2, col: 0, raw: "差旅与协作", style: CELL_BORDER },
      { row: 2, col: 1, raw: "3200", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 2, col: 2, raw: "2800", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 2, col: 3, raw: "4100", style: { ...CELL_BORDER, numFmt: "currency" } },
      { row: 2, col: 4, raw: "=SUM(B3:D3)", style: { ...CELL_BORDER, bold: true, numFmt: "currency" } },
      { row: 3, col: 0, raw: "月度总计", style: { ...HEADER_STYLE, bg: "#f7f8fa" } },
      { row: 3, col: 1, raw: "=SUM(B2:B3)", style: { ...HEADER_STYLE, bg: "#f7f8fa", numFmt: "currency", align: "right" } },
      { row: 3, col: 2, raw: "=SUM(C2:C3)", style: { ...HEADER_STYLE, bg: "#f7f8fa", numFmt: "currency", align: "right" } },
      { row: 3, col: 3, raw: "=SUM(D2:D3)", style: { ...HEADER_STYLE, bg: "#f7f8fa", numFmt: "currency", align: "right" } },
      { row: 3, col: 4, raw: "=SUM(E2:E3)", style: { ...HEADER_STYLE, bg: "#f7f8fa", numFmt: "currency", align: "right" } },
    ],
  },
  {
    id: "team-roster",
    name: "团队值班排班表",
    tag: "团队协作",
    cells: [
      { row: 0, col: 0, raw: "值班日期", style: HEADER_STYLE },
      { row: 0, col: 1, raw: "主值班", style: HEADER_STYLE },
      { row: 0, col: 2, raw: "备班支持", style: HEADER_STYLE },
      { row: 0, col: 3, raw: "响应 SLA", style: HEADER_STYLE },
      { row: 1, col: 0, raw: "周一", style: { ...CELL_BORDER, align: "center" } },
      { row: 1, col: 1, raw: "陈浩", style: { ...CELL_BORDER, align: "center" } },
      { row: 1, col: 2, raw: "周婷", style: { ...CELL_BORDER, align: "center" } },
      { row: 1, col: 3, raw: "15分钟内", style: { ...CELL_BORDER, align: "center" } },
      { row: 2, col: 0, raw: "周二", style: { ...CELL_BORDER, align: "center" } },
      { row: 2, col: 1, raw: "周婷", style: { ...CELL_BORDER, align: "center" } },
      { row: 2, col: 2, raw: "赵磊", style: { ...CELL_BORDER, align: "center" } },
      { row: 2, col: 3, raw: "15分钟内", style: { ...CELL_BORDER, align: "center" } },
    ],
  },
];

export const FORMULA_QUICK_LIST = [
  { name: "SUM", snippet: "=SUM()", summary: "计算区域或数值之和" },
  { name: "AVERAGE", snippet: "=AVERAGE()", summary: "计算算术平均值" },
  { name: "IF", snippet: "=IF(, , )", summary: "根据条件返回不同结果" },
  { name: "COUNT", snippet: "=COUNT()", summary: "统计数值单元格个数" },
  { name: "COUNTA", snippet: "=COUNTA()", summary: "统计非空单元格个数" },
  { name: "COUNTIF", snippet: "=COUNTIF(, )", summary: "按条件统计单元格数量" },
  { name: "SUMIF", snippet: "=SUMIF(, , )", summary: "按条件求和" },
  { name: "MAX", snippet: "=MAX()", summary: "返回最大值" },
  { name: "MIN", snippet: "=MIN()", summary: "返回最小值" },
  { name: "ROUND", snippet: "=ROUND(, 2)", summary: "按指定位数四舍五入" },
  { name: "CONCAT", snippet: "=CONCAT()", summary: "拼接多段文本或单元格" },
] as const;

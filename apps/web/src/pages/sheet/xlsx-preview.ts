import { type XlsxCell, type XlsxSheet, type XlsxWorkbook } from "@jiange/sheet-sdk/xlsx";
import { pointKey, PREVIEW_COLS, PREVIEW_ROWS, type SheetCells } from "./grid-model";

type OriginalCell = { text: string; cell: XlsxCell };
export type PreviewXlsx = { name: string; cells: SheetCells; originals: Record<string, OriginalCell>; losses: string[] };

export function describeImportWarnings(warnings: string[]): string[] {
  const descriptions: Record<string, string> = {
    styles_not_preserved: "单元格样式、数字格式不会保留。",
    cell_formatting_not_preserved: "单元格样式、数字格式不会保留。",
    row_formatting_not_preserved: "行格式不会保留。",
    rich_text_formatting_not_preserved: "单元格内的富文本格式不会保留。",
    sheet_visibility_not_preserved: "工作表隐藏状态不会保留。",
    worksheet_features_not_preserved: "合并单元格、行列布局或其他工作表功能可能不会保留。",
    empty_formula_cache_not_preserved: "空字符串公式缓存不会保留，公式将重新计算。",
  };
  return [...new Set(warnings.map((warning) => descriptions[warning] ?? "部分文件信息或附加内容不会保留。"))];
}

/** Convert only a workbook that fits entirely in the temporary preview. */
export function toPreview(workbook: XlsxWorkbook): PreviewXlsx {
  if (workbook.sheets.length !== 1) throw new Error("开发预览只能打开单工作表文件；文件未导入。");
  const sheet = workbook.sheets[0], cells: Record<string, string> = {}, originals: Record<string, OriginalCell> = {};
  const losses = new Set<string>();
  for (const cell of sheet.cells) {
    if (cell.row >= PREVIEW_ROWS || cell.col >= PREVIEW_COLS) throw new Error("工作表超出预览的 100 行、26 列范围；文件未导入。");
    const value = cell.value;
    if (!cell.formula && typeof value === "string" && value.startsWith("=")) throw new Error("文件含以 = 开头的普通文本，预览无法安全区分公式；文件未导入。");
    const raw = cell.formula ?? (typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : typeof value === "object" ? value.error : String(value ?? ""));
    if (!raw) { losses.add("空文本单元格不会保留。"); continue; }
    const key = pointKey(cell);
    cells[key] = raw;
    originals[key] = { text: raw, cell };
    if (cell.formula) losses.add("预览仅能计算部分公式，其他公式的结果可能显示为错误；导出时请求表格应用重新计算。");
  }
  return { name: sheet.name, cells, originals, losses: [...losses] };
}

/** Preserve imported scalar types while unchanged. Never reuse formula caches. */
export function fromPreview(name: string, cells: SheetCells, originals: PreviewXlsx["originals"]): XlsxSheet {
  const output: XlsxCell[] = [];
  for (const [key, text] of Object.entries(cells)) {
    const [row, col] = key.split(":").map(Number);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= PREVIEW_ROWS || col < 0 || col >= PREVIEW_COLS) throw new Error("预览单元格坐标无效。");
    const old = originals[key];
    if (old && old.text === text && !old.cell.formula) { output.push(old.cell); continue; }
    if (text.startsWith("=")) { output.push({ row, col, formula: text }); continue; }
    const n = Number(text);
    output.push({ row, col, value: /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(n) ? n : text });
  }
  return { name, cells: output };
}

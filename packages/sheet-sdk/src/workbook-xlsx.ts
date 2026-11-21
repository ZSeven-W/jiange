import { buildWorksheetGridMap } from "./formula-engine.js";
import type {
  ImportedSheetCell,
  ImportedWorksheet,
  SheetCellStyle,
  SheetMerge,
  SheetNumFmt,
  SheetWorksheet,
} from "./types.js";
import { writeXlsx, writeXlsxAsync, type WriteXlsxOptions, type XlsxCell, type XlsxSheet, type XlsxStyle } from "./xlsx.js";
import { readXlsx, XLSX_MAX_INPUT_BYTES, type ReadXlsxOptions } from "./xlsx-read.js";

const NUM_FMT_CODES: Record<string, string> = {
  currency: '"¥"#,##0.00',
  percent: "0.0%",
  decimal2: "#,##0.00",
  decimal1: "#,##0.0",
  integer: "#,##0",
  date: "yyyy-mm-dd",
};

/** Best-effort classification of an imported Excel format code into semantic presets. */
export function numFmtFromCode(code: string | undefined): SheetNumFmt | undefined {
  if (!code) return undefined;
  for (const [fmt, known] of Object.entries(NUM_FMT_CODES)) if (known === code) return fmt as SheetNumFmt;
  const plain = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, (m) => (m.startsWith('"') && /[¥$€£]/.test(m)) || m.startsWith("[$") ? "¤" : "");
  if (/%/.test(plain)) return "percent";
  if (/[¥$€£¤]/.test(plain)) return "currency";
  if (/[yd]/i.test(plain) || /m{1,4}[/-]|[/-]m{1,4}/i.test(plain)) return "date";
  if (/0\.0{2,}/.test(plain)) return "decimal2";
  if (/0\.0(?!0)/.test(plain)) return "decimal1";
  if (/^[#,0]+$/.test(plain.split(";")[0])) return "integer";
  return undefined;
}

export function sheetStyleToXlsx(style: SheetCellStyle | undefined): XlsxStyle | undefined {
  if (!style) return undefined;
  const out: XlsxStyle = {};
  if (style.bold) out.bold = true;
  if (style.italic) out.italic = true;
  if (style.underline) out.underline = true;
  if (style.strike) out.strike = true;
  if (style.fontFamily) out.fontName = style.fontFamily.slice(0, 31);
  if (style.fontSize) out.fontSize = style.fontSize;
  if (style.color && /^#[0-9a-f]{6}$/i.test(style.color)) out.color = style.color;
  if (style.bg && /^#[0-9a-f]{6}$/i.test(style.bg)) out.fill = style.bg;
  if (style.align) out.horizontal = style.align;
  if (style.valign) out.vertical = style.valign === "middle" ? "center" : style.valign;
  if (style.wrap) out.wrap = true;
  const b = style.borders;
  if (b && (b.top || b.right || b.bottom || b.left)) {
    out.border = {
      ...(b.top ? { top: true } : {}),
      ...(b.right ? { right: true } : {}),
      ...(b.bottom ? { bottom: true } : {}),
      ...(b.left ? { left: true } : {}),
      ...(b.color && /^#[0-9a-f]{6}$/i.test(b.color) ? { color: b.color } : {}),
    };
  }
  if (style.numFmt && style.numFmt !== "general") {
    out.numFmt = NUM_FMT_CODES[style.numFmt] ?? style.numFmt;
  }
  return Object.keys(out).length ? out : undefined;
}

export function xlsxStyleToSheet(style: XlsxStyle | undefined): SheetCellStyle | undefined {
  if (!style) return undefined;
  const out: SheetCellStyle = {};
  if (style.bold) out.bold = true;
  if (style.italic) out.italic = true;
  if (style.underline) out.underline = true;
  if (style.strike) out.strike = true;
  if (style.fontName) out.fontFamily = style.fontName.slice(0, 64);
  if (style.fontSize) out.fontSize = Math.min(72, Math.max(8, Math.round(style.fontSize)));
  if (style.color) out.color = style.color;
  if (style.fill) out.bg = style.fill;
  if (style.horizontal) out.align = style.horizontal;
  if (style.vertical) out.valign = style.vertical === "center" ? "middle" : style.vertical;
  if (style.wrap) out.wrap = true;
  if (style.border) out.borders = { ...style.border };
  const fmt = numFmtFromCode(style.numFmt);
  if (fmt) out.numFmt = fmt;
  return Object.keys(out).length ? out : undefined;
}

function buildXlsxSheets(sheets: readonly SheetWorksheet[]): XlsxSheet[] {
  return sheets.map((ws) => {
    const { cellByKey } = buildWorksheetGridMap(ws);
    const cells: XlsxCell[] = [];
    for (let r = 0; r < ws.rows.length; r++) {
      for (let c = 0; c < ws.columns.length; c++) {
        const cell = cellByKey.get(`${r}:${c}`);
        if (!cell) continue;
        const style = sheetStyleToXlsx(cell.style);
        const styled = style ? { style } : {};
        const raw = cell.raw;
        if (!raw) {
          if (style) cells.push({ row: r, col: c, style });
          continue;
        }
        if (raw.startsWith("=") && raw.length >= 2) {
          cells.push({ row: r, col: c, formula: raw, ...styled });
          continue;
        }
        const trimmed = raw.trim();
        if (/^(true|false)$/i.test(trimmed)) {
          cells.push({ row: r, col: c, value: trimmed.toUpperCase() === "TRUE", ...styled });
          continue;
        }
        if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) && Number.isFinite(Number(trimmed))) {
          cells.push({ row: r, col: c, value: Number(trimmed), ...styled });
          continue;
        }
        cells.push({ row: r, col: c, value: raw, ...styled });
      }
    }
    const merges = ws.merges.map((m) => ({ top: m.top, left: m.left, bottom: m.bottom, right: m.right }));
    const frozen = ws.frozenRows || ws.frozenCols ? { rows: ws.frozenRows, cols: ws.frozenCols } : undefined;
    const colWidths: Record<number, number> = {};
    ws.columns.forEach((col, idx) => {
      if (col.size && col.size > 0) colWidths[idx] = Math.min(255, Math.max(1, Number((col.size / 7.5).toFixed(2))));
    });
    const rowHeights: Record<number, number> = {};
    ws.rows.forEach((row, idx) => {
      if (row.size && row.size > 0) rowHeights[idx] = Math.min(409, Math.max(1, Number((row.size * 0.75).toFixed(2))));
    });
    return {
      name: ws.title,
      cells,
      ...(merges.length ? { merges } : {}),
      ...(frozen ? { frozen } : {}),
      ...(Object.keys(colWidths).length ? { colWidths } : {}),
      ...(Object.keys(rowHeights).length ? { rowHeights } : {}),
      ...(ws.validations?.length ? { validations: ws.validations } : {}),
      ...(ws.hyperlinks?.length ? { hyperlinks: ws.hyperlinks } : {}),
    };
  });
}

export function exportWorkbookToXlsx(sheets: readonly SheetWorksheet[], options?: WriteXlsxOptions): Uint8Array {
  return writeXlsx({ sheets: buildXlsxSheets(sheets) }, options);
}

export async function exportWorkbookToXlsxAsync(sheets: readonly SheetWorksheet[], options?: WriteXlsxOptions): Promise<Uint8Array> {
  return writeXlsxAsync({ sheets: buildXlsxSheets(sheets) }, options);
}

export interface WorkbookImportPreview {
  sheets: ImportedWorksheet[];
  warnings: string[];
  cellCount: number;
}

const WARNING_LABELS: Record<string, string> = {
  styles_not_preserved: "部分单元格字体或数字格式将恢复为默认格式",
  cell_formatting_not_preserved: "部分原文件样式（如渐变填充、粗边框、缩进或特殊数字格式）未完全导入",
  style_colors_not_preserved: "使用主题色的字体或填充颜色将恢复为默认颜色",
  row_formatting_not_preserved: "原文件行高属性未导入",
  rich_text_formatting_not_preserved: "单元格内富文本样式将保留为纯文本",
  sheet_visibility_not_preserved: "隐藏工作表将按可见工作表导入",
  worksheet_features_not_preserved: "条件格式、数据验证或筛选等附加特性可能未完全导入",
  empty_formula_cache_not_preserved: "公式结果将在打开后自动重新计算",
  merges_trimmed: "部分超出范围或重叠的合并单元格未导入",
  frozen_trimmed: "冻结行列超过上限（50 行 / 20 列），已按上限导入",
};

const MAX_ROWS = 5000;
const MAX_COLS = 256;

export async function parseXlsxBytesForWorkbook(
  bytes: Uint8Array,
  options?: ReadXlsxOptions,
): Promise<WorkbookImportPreview> {
  const maxBytes = options?.limits?.maxFileBytes ?? XLSX_MAX_INPUT_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new Error("XLSX 文件不能超过 20 MiB。");
  }
  const parsed = await readXlsx(bytes, options);
  if (parsed.workbook.sheets.length > 50) {
    throw new Error("单次最多导入 50 个工作表。");
  }
  const extraWarnings = new Set<string>();
  let cellCount = 0;
  const sheets: ImportedWorksheet[] = parsed.workbook.sheets.map((sheet) => {
    let maxRow = 100;
    let maxCol = 26;
    const cells: ImportedSheetCell[] = [];
    const grow = (row: number, col: number) => {
      if (row >= MAX_ROWS || col >= MAX_COLS) {
        throw new Error(`工作表「${sheet.name}」超出 ${MAX_ROWS} 行或 ${MAX_COLS} 列的上限。`);
      }
      maxRow = Math.max(maxRow, row + 11);
      maxCol = Math.max(maxCol, col + 5);
    };
    for (const c of sheet.cells) {
      grow(c.row, c.col);
      let raw = "";
      if (c.formula) raw = c.formula;
      else if (typeof c.value === "boolean") raw = c.value ? "TRUE" : "FALSE";
      else if (typeof c.value === "object" && c.value !== null) raw = c.value.error;
      else if (c.value !== undefined) raw = String(c.value);
      const style = xlsxStyleToSheet(c.style);
      if (!raw && !style) continue;
      if (raw) cellCount++;
      cells.push(style ? { row: c.row, col: c.col, raw, style } : { row: c.row, col: c.col, raw });
    }
    const rows = Math.min(MAX_ROWS, maxRow);
    const cols = Math.min(MAX_COLS, maxCol);
    const merges: SheetMerge[] = [];
    const covered = new Set<string>();
    for (const m of sheet.merges ?? []) {
      if (m.bottom >= rows || m.right >= cols || (m.bottom - m.top + 1) * (m.right - m.left + 1) > 10000) {
        extraWarnings.add("merges_trimmed");
        continue;
      }
      let overlaps = false;
      for (let r = m.top; r <= m.bottom && !overlaps; r++) {
        for (let c = m.left; c <= m.right; c++) if (covered.has(`${r}:${c}`)) { overlaps = true; break; }
      }
      if (overlaps) { extraWarnings.add("merges_trimmed"); continue; }
      for (let r = m.top; r <= m.bottom; r++) for (let c = m.left; c <= m.right; c++) covered.add(`${r}:${c}`);
      merges.push({ top: m.top, left: m.left, bottom: m.bottom, right: m.right });
    }
    let frozenRows = sheet.frozen?.rows ?? 0;
    let frozenCols = sheet.frozen?.cols ?? 0;
    const capRows = Math.min(50, rows - 1);
    const capCols = Math.min(20, cols - 1);
    if (frozenRows > capRows || frozenCols > capCols) extraWarnings.add("frozen_trimmed");
    frozenRows = Math.min(frozenRows, capRows);
    frozenCols = Math.min(frozenCols, capCols);
    return {
      title: sheet.name,
      rows,
      cols,
      cells,
      ...(merges.length ? { merges } : {}),
      ...(frozenRows ? { frozenRows } : {}),
      ...(frozenCols ? { frozenCols } : {}),
      ...(sheet.colWidths ? { colWidths: { ...sheet.colWidths } } : {}),
      ...(sheet.rowHeights ? { rowHeights: { ...sheet.rowHeights } } : {}),
      ...(sheet.validations?.length ? { validations: [...sheet.validations] } : {}),
      ...(sheet.hyperlinks?.length ? { hyperlinks: [...sheet.hyperlinks] } : {}),
    };
  });
  const warnings = [...new Set([...parsed.warnings, ...extraWarnings].map((w) => WARNING_LABELS[w] ?? "部分扩展属性未导入"))];
  return { sheets, warnings, cellCount };
}

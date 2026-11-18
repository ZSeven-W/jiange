import type { ImportedSheetCell, ImportedWorksheet, SheetWorksheet } from "@/lib/api";
import { writeXlsx, type XlsxCell, type XlsxSheet } from "@jiange/sheet-sdk/xlsx";
import { readXlsx, XLSX_MAX_INPUT_BYTES } from "@jiange/sheet-sdk/xlsx-read";
import { buildWorksheetGridMap } from "./workbook-engine";

export function exportWorkbookToXlsx(sheets: readonly SheetWorksheet[]): Uint8Array {
  const exportedSheets: XlsxSheet[] = sheets.map((ws) => {
    const { cellByKey } = buildWorksheetGridMap(ws);
    const cells: XlsxCell[] = [];
    for (let r = 0; r < ws.rows.length; r++) {
      for (let c = 0; c < ws.columns.length; c++) {
        const cell = cellByKey.get(`${r}:${c}`);
        if (!cell || !cell.raw) continue;
        const raw = cell.raw;
        if (raw.startsWith("=") && raw.length >= 2) {
          cells.push({ row: r, col: c, formula: raw });
          continue;
        }
        const trimmed = raw.trim();
        if (/^(true|false)$/i.test(trimmed)) {
          cells.push({ row: r, col: c, value: trimmed.toUpperCase() === "TRUE" });
          continue;
        }
        if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) && Number.isFinite(Number(trimmed))) {
          cells.push({ row: r, col: c, value: Number(trimmed) });
          continue;
        }
        cells.push({ row: r, col: c, value: raw });
      }
    }
    return { name: ws.title, cells };
  });
  return writeXlsx({ sheets: exportedSheets });
}

export interface WorkbookImportPreview {
  sheets: ImportedWorksheet[];
  warnings: string[];
  cellCount: number;
}

const WARNING_LABELS: Record<string, string> = {
  styles_not_preserved: "部分单元格字体或数字格式将恢复为默认格式",
  cell_formatting_not_preserved: "部分原文件样式未完全导入",
  row_formatting_not_preserved: "原文件行高属性未导入",
  rich_text_formatting_not_preserved: "单元格内富文本样式将保留为纯文本",
  sheet_visibility_not_preserved: "隐藏工作表将按可见工作表导入",
  worksheet_features_not_preserved: "合并单元格或筛选等附加特性可能未完全导入",
  empty_formula_cache_not_preserved: "公式结果将在打开后自动重新计算",
};

export async function parseXlsxForWorkbook(file: File): Promise<WorkbookImportPreview> {
  if (file.size > XLSX_MAX_INPUT_BYTES) {
    throw new Error("XLSX 文件不能超过 20 MiB。");
  }
  const parsed = await readXlsx(new Uint8Array(await file.arrayBuffer()));
  if (parsed.workbook.sheets.length > 50) {
    throw new Error("单次最多导入 50 个工作表。");
  }
  let cellCount = 0;
  const sheets: ImportedWorksheet[] = parsed.workbook.sheets.map((sheet) => {
    // Row/column counts (not indexes): keep the default 100×26 grid and leave
    // headroom after the last imported cell.
    let maxRow = 100;
    let maxCol = 26;
    const cells: ImportedSheetCell[] = [];
    for (const c of sheet.cells) {
      if (c.row >= 5000 || c.col >= 256) {
        throw new Error(`工作表「${sheet.name}」超出 5000 行或 256 列的上限。`);
      }
      maxRow = Math.max(maxRow, c.row + 11);
      maxCol = Math.max(maxCol, c.col + 5);
      let raw = "";
      if (c.formula) {
        raw = c.formula;
      } else if (typeof c.value === "boolean") {
        raw = c.value ? "TRUE" : "FALSE";
      } else if (typeof c.value === "object" && c.value !== null) {
        raw = c.value.error;
      } else if (c.value !== undefined) {
        raw = String(c.value);
      }
      if (!raw) continue;
      cellCount++;
      if (cellCount > 50000) {
        throw new Error("导入单元格总数不能超过 50,000 个。");
      }
      cells.push({ row: c.row, col: c.col, raw });
    }
    return {
      title: sheet.name,
      rows: Math.min(5000, maxRow),
      cols: Math.min(256, maxCol),
      cells,
    };
  });
  const warnings = [...new Set(parsed.warnings.map((w) => WARNING_LABELS[w] ?? "部分扩展属性未导入"))];
  return { sheets, warnings, cellCount };
}

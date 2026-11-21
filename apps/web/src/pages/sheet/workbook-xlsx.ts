import {
  exportWorkbookToXlsx,
  exportWorkbookToXlsxAsync,
  numFmtFromCode,
  parseXlsxBytesForWorkbook,
  sheetStyleToXlsx,
  xlsxStyleToSheet,
  type WorkbookImportPreview,
} from "@jiange/sheet-sdk/workbook-xlsx";
import { XLSX_MAX_INPUT_BYTES } from "@jiange/sheet-sdk/xlsx-read";

export {
  exportWorkbookToXlsx,
  exportWorkbookToXlsxAsync,
  numFmtFromCode,
  parseXlsxBytesForWorkbook,
  sheetStyleToXlsx,
  xlsxStyleToSheet,
  type WorkbookImportPreview,
};

export async function parseXlsxForWorkbook(file: File): Promise<WorkbookImportPreview> {
  if (file.size > XLSX_MAX_INPUT_BYTES) {
    throw new Error("XLSX 文件不能超过 20 MiB。");
  }
  return parseXlsxBytesForWorkbook(new Uint8Array(await file.arrayBuffer()));
}

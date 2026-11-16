import { createZip, type ZipEntryInput } from "@jiange/ooxml/zip";
import { escapeXml } from "@jiange/ooxml/xml";
import { columnName } from "./grid.js";

/** Zero-based coordinates; formula strings include the leading `=`. */
export type XlsxCellError = { error: "#NULL!" | "#DIV/0!" | "#VALUE!" | "#REF!" | "#NAME?" | "#NUM!" | "#N/A" | "#GETTING_DATA" | "#SPILL!" | "#CALC!" };
export type XlsxScalar = string | number | boolean | XlsxCellError;
export type XlsxCell = { row: number; col: number; value: XlsxScalar; formula?: never } | { row: number; col: number; formula: string; value?: XlsxScalar };
export interface XlsxSheet { name: string; cells: readonly XlsxCell[] }
export interface XlsxWorkbook { sheets: readonly XlsxSheet[] }
export class XlsxError extends Error { constructor(message: string) { super(message); this.name = "XlsxError"; } }

export const XLSX_MAX_SHEETS = 100, XLSX_MAX_CELLS = 50_000, XLSX_MAX_XML_BYTES = 32 * 1024 * 1024, XLSX_MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 1_048_576, MAX_COLS = 16_384, MAX_CELL_TEXT = 32_767, MAX_FORMULA = 8_192;
const encoder = new TextEncoder();
const xmlText = (value: string) => escapeXml(value).replace(/\r/g, "&#13;");

function object(value: unknown, keys: readonly string[], context: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new XlsxError(`${context} must be an object`);
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new XlsxError(`${context} contains unsupported properties`);
}
function text(value: string, limit: number, context: string) {
  if (value.length > limit) throw new XlsxError(`${context} is too long`);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffe || c === 0xffff || (c >= 0xdc00 && c <= 0xdfff)) throw new XlsxError(`${context} contains invalid XML characters`);
    if (c >= 0xd800 && c <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new XlsxError(`${context} contains invalid XML characters`); }
  }
}
const ERROR_VALUES = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA", "#SPILL!", "#CALC!"]);
function scalar(value: unknown): value is XlsxScalar {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)
    || !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "error") && typeof (value as XlsxCellError).error === "string" && ERROR_VALUES.has((value as XlsxCellError).error);
}
function cellXml(raw: unknown): { row: number; col: number; xml: string } {
  object(raw, ["row", "col", "value", "formula"], "cell");
  const { row, col, formula, value } = raw;
  if (!Number.isInteger(row) || (row as number) < 0 || (row as number) >= MAX_ROWS || !Number.isInteger(col) || (col as number) < 0 || (col as number) >= MAX_COLS) throw new XlsxError("cell coordinates are out of range");
  const isFormula = formula !== undefined;
  if (isFormula) {
    if (typeof formula !== "string" || !formula.startsWith("=") || formula.length < 2) throw new XlsxError("formula must start with = and contain an expression");
    text(formula, MAX_FORMULA, "formula");
  }
  if ((!isFormula && !Object.hasOwn(raw, "value")) || (value !== undefined && !scalar(value)) || (!isFormula && value === undefined)) throw new XlsxError("cell value must be text, a finite number, a boolean, or a supported error");
  if (isFormula && value === "") throw new XlsxError("empty formula caches are ambiguous; omit the value and recalculate");
  if (typeof value === "string") text(value, MAX_CELL_TEXT, "cell text");
  const address = `${columnName(col as number)}${(row as number) + 1}`;
  if (!isFormula && typeof value === "string") return { row: row as number, col: col as number, xml: `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>` };
  const type = typeof value === "string" ? ' t="str"' : typeof value === "boolean" ? ' t="b"' : value && typeof value === "object" ? ' t="e"' : "";
  const f = isFormula ? `<f>${xmlText((formula as string).slice(1))}</f>` : "";
  const v = value === undefined ? "" : `<v>${typeof value === "boolean" ? (value ? "1" : "0") : xmlText(typeof value === "object" ? (value as XlsxCellError).error : String(value))}</v>`;
  return { row: row as number, col: col as number, xml: `<c r="${address}"${type}>${f}${v}</c>` };
}

/** Create a bounded XLSX file. Unsupported workbook properties are rejected, not dropped. */
export function writeXlsx(workbook: XlsxWorkbook, options: { modified?: Date } = {}): Uint8Array {
  object(workbook, ["sheets"], "workbook"); object(options, ["modified"], "options");
  if (!Array.isArray(workbook.sheets) || !workbook.sheets.length || workbook.sheets.length > XLSX_MAX_SHEETS) throw new XlsxError("workbook must contain 1 to 100 sheets");
  if (options.modified !== undefined && (!(options.modified instanceof Date) || !Number.isFinite(options.modified.getTime()))) throw new XlsxError("invalid modified date");
  const names = new Set<string>(), sheets: { name: string; rows: string }[] = [];
  let cellsTotal = 0, xmlBytes = 0;
  for (const raw of workbook.sheets) {
    object(raw, ["name", "cells"], "sheet");
    if (typeof raw.name !== "string" || !raw.name || raw.name.length > 31 || /[\[\]:*?/\\\u0000-\u001f]/.test(raw.name) || raw.name.startsWith("'") || raw.name.endsWith("'")) throw new XlsxError("invalid sheet name");
    text(raw.name, 31, "sheet name");
    const normalized = raw.name.toLowerCase(); if (names.has(normalized)) throw new XlsxError("duplicate sheet name"); names.add(normalized);
    if (!Array.isArray(raw.cells) || (cellsTotal += raw.cells.length) > XLSX_MAX_CELLS) throw new XlsxError("too many cells or invalid cell list");
    const seen = new Set<string>(), cells: {row:number;col:number;xml:string}[] = [];
    for (const item of raw.cells) {
      const cell = cellXml(item), key = `${cell.row}:${cell.col}`;
      if (seen.has(key)) throw new XlsxError("duplicate cell coordinate"); seen.add(key);
      xmlBytes += encoder.encode(cell.xml).byteLength; if (xmlBytes > XLSX_MAX_XML_BYTES) throw new XlsxError("workbook content exceeds the export limit");
      cells.push(cell);
    }
    cells.sort((a, b) => a.row - b.row || a.col - b.col);
    const rows: string[] = [];
    for (let i = 0; i < cells.length;) {
      const row = cells[i].row, rowCells: string[] = [];
      while (i < cells.length && cells[i].row === row) rowCells.push(cells[i++].xml);
      rows.push(`<row r="${row + 1}">${rowCells.join("")}</row>`);
    }
    sheets.push({ name: raw.name, rows: rows.join("") });
  }
  const sheetNS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main", relNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const entries: ZipEntryInput[] = [];
  const add = (name: string, body: string) => { const data = encoder.encode(header + body); xmlBytes += data.byteLength; if (xmlBytes > XLSX_MAX_XML_BYTES * 2) throw new XlsxError("workbook XML exceeds the export limit"); entries.push({ name, data }); };
  add("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  add("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add("xl/workbook.xml", `<workbook xmlns="${sheetNS}" xmlns:r="${relNS}"><sheets>${sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`);
  add("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${relNS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`);
  sheets.forEach((sheet, i) => add(`xl/worksheets/sheet${i + 1}.xml`, `<worksheet xmlns="${sheetNS}"><sheetData>${sheet.rows}</sheetData></worksheet>`));
  const result = createZip(entries, options.modified);
  if (result.length > XLSX_MAX_FILE_BYTES) throw new XlsxError("XLSX file exceeds the export limit");
  return result;
}

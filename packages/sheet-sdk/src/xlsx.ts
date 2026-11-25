import { createZip, createZipAsync, type ZipEntryInput } from "@zseven-w/ooxml/zip";
import { escapeXml } from "@zseven-w/ooxml/xml";
import { columnName } from "./grid.js";
import type { SheetCondFormatOp, SheetConditionalFormat, SheetDataValidation, SheetDefinedName, SheetHyperlink } from "./types.js";
import { normalizeXlsxStyle, XlsxStyleTable, type XlsxFrozen, type XlsxMerge, type XlsxStyle } from "./xlsx-style.js";

export type { XlsxBorder, XlsxDxfStyle, XlsxFrozen, XlsxMerge, XlsxStyle } from "./xlsx-style.js";

/** Zero-based coordinates; formula strings include the leading `=`. */
export type XlsxCellError = { error: "#NULL!" | "#DIV/0!" | "#VALUE!" | "#REF!" | "#NAME?" | "#NUM!" | "#N/A" | "#GETTING_DATA" | "#SPILL!" | "#CALC!" };
export type XlsxScalar = string | number | boolean | XlsxCellError;
export type XlsxCell =
  | { row: number; col: number; value: XlsxScalar; formula?: never; style?: XlsxStyle }
  | { row: number; col: number; formula: string; value?: XlsxScalar; style?: XlsxStyle }
  | { row: number; col: number; style: XlsxStyle; value?: never; formula?: never };

export interface XlsxComment {
  row: number;
  col: number;
  text: string;
  author?: string;
}

export interface XlsxSheet {
  name: string;
  cells: readonly XlsxCell[];
  merges?: readonly XlsxMerge[];
  frozen?: XlsxFrozen;
  /** Zero-based column index → Excel character width (1..255). */
  colWidths?: Readonly<Record<number, number>>;
  /** Zero-based row index → Excel row height in points (1..409). */
  rowHeights?: Readonly<Record<number, number>>;
  validations?: readonly SheetDataValidation[];
  conditionalFormats?: readonly SheetConditionalFormat[];
  hyperlinks?: readonly SheetHyperlink[];
  comments?: readonly XlsxComment[];
}

export interface XlsxWorkbook {
  sheets: readonly XlsxSheet[];
  definedNames?: readonly SheetDefinedName[];
}

export interface XlsxLimits {
  maxSheets: number;
  maxCells: number;
  maxXmlBytes: number;
  maxFileBytes: number;
}

export interface WriteXlsxOptions {
  modified?: Date;
  limits?: Partial<XlsxLimits>;
  /** Deduplicate strings into `xl/sharedStrings.xml` (default false for sync compat, true in `writeXlsxAsync`). */
  sharedStrings?: boolean;
  /** Used by `writeXlsxAsync` (default `"deflate"`). */
  compression?: "deflate" | "store";
}

export class XlsxError extends Error { constructor(message: string) { super(message); this.name = "XlsxError"; } }

export const XLSX_MAX_SHEETS = 100, XLSX_MAX_CELLS = 50_000, XLSX_MAX_XML_BYTES = 32 * 1024 * 1024, XLSX_MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 1_048_576, MAX_COLS = 16_384, MAX_CELL_TEXT = 32_767, MAX_FORMULA = 8_192;
const encoder = new TextEncoder();
const xmlText = (value: string) => escapeXml(value).replace(/\r/g, "&#13;");

export function resolveXlsxLimits(partial?: Partial<XlsxLimits>): XlsxLimits {
  const maxSheets = partial?.maxSheets ?? XLSX_MAX_SHEETS;
  const maxCells = partial?.maxCells ?? XLSX_MAX_CELLS;
  const maxXmlBytes = partial?.maxXmlBytes ?? XLSX_MAX_XML_BYTES;
  const maxFileBytes = partial?.maxFileBytes ?? XLSX_MAX_FILE_BYTES;
  if (![maxSheets, maxCells, maxXmlBytes, maxFileBytes].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new XlsxError("invalid XLSX limits");
  }
  return { maxSheets, maxCells, maxXmlBytes, maxFileBytes };
}

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

class SharedStringTable {
  private readonly map = new Map<string, number>();
  readonly items: string[] = [];
  count = 0;

  intern(value: string): number {
    this.count++;
    const existing = this.map.get(value);
    if (existing !== undefined) return existing;
    const idx = this.items.length;
    this.items.push(value);
    this.map.set(value, idx);
    return idx;
  }

  xml(ns: string): string {
    return `<sst xmlns="${ns}" count="${this.count}" uniqueCount="${this.items.length}">${this.items.map((s) => `<si><t xml:space="preserve">${xmlText(s)}</t></si>`).join("")}</sst>`;
  }
}

function cellXml(raw: unknown, styles: XlsxStyleTable, sst: SharedStringTable | null): { row: number; col: number; xml: string } {
  object(raw, ["row", "col", "value", "formula", "style"], "cell");
  const { row, col, formula, value } = raw;
  if (!Number.isInteger(row) || (row as number) < 0 || (row as number) >= MAX_ROWS || !Number.isInteger(col) || (col as number) < 0 || (col as number) >= MAX_COLS) throw new XlsxError("cell coordinates are out of range");
  const styleIndex = styles.index(normalizeXlsxStyle(raw.style));
  const s = styleIndex ? ` s="${styleIndex}"` : "";
  const address = `${columnName(col as number)}${(row as number) + 1}`;
  const isFormula = formula !== undefined;
  if (!isFormula && value === undefined && raw.style !== undefined) {
    if (Object.hasOwn(raw, "value")) throw new XlsxError("cell value must be text, a finite number, a boolean, or a supported error");
    return { row: row as number, col: col as number, xml: `<c r="${address}"${s}/>` };
  }
  if (isFormula) {
    if (typeof formula !== "string" || !formula.startsWith("=") || formula.length < 2) throw new XlsxError("formula must start with = and contain an expression");
    text(formula, MAX_FORMULA, "formula");
  }
  if ((!isFormula && !Object.hasOwn(raw, "value")) || (value !== undefined && !scalar(value)) || (!isFormula && value === undefined)) throw new XlsxError("cell value must be text, a finite number, a boolean, or a supported error");
  if (isFormula && value === "") throw new XlsxError("empty formula caches are ambiguous; omit the value and recalculate");
  if (typeof value === "string") text(value, MAX_CELL_TEXT, "cell text");
  if (!isFormula && typeof value === "string") {
    if (sst) return { row: row as number, col: col as number, xml: `<c r="${address}"${s} t="s"><v>${sst.intern(value)}</v></c>` };
    return { row: row as number, col: col as number, xml: `<c r="${address}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>` };
  }
  const type = typeof value === "string" ? ' t="str"' : typeof value === "boolean" ? ' t="b"' : value && typeof value === "object" ? ' t="e"' : "";
  const f = isFormula ? `<f>${xmlText((formula as string).slice(1))}</f>` : "";
  const v = value === undefined ? "" : `<v>${typeof value === "boolean" ? (value ? "1" : "0") : xmlText(typeof value === "object" ? (value as XlsxCellError).error : String(value))}</v>`;
  return { row: row as number, col: col as number, xml: `<c r="${address}"${s}${type}>${f}${v}</c>` };
}

function safeHyperlinkUrl(target: string): string {
  try {
    const u = new URL(target);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") return target;
  } catch { /* fall through */ }
  throw new XlsxError("unsupported hyperlink URL scheme");
}

const COND_FMT_OPERATORS: Record<SheetCondFormatOp, string> = {
  gt: "greaterThan",
  gte: "greaterThanOrEqual",
  lt: "lessThan",
  lte: "lessThanOrEqual",
  eq: "equal",
  neq: "notEqual",
  between: "between",
  contains: "containsText",
  empty: "containsBlanks",
  not_empty: "notContainsBlanks",
};

function cfFormulaLiteral(value: string): string {
  const trimmed = value.trim();
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return xmlText(trimmed);
  return `&quot;${xmlText(value.replace(/"/g, '""'))}&quot;`;
}

interface SheetRelEntry {
  id: string;
  type: "hyperlink" | "comments";
  target: string;
  external?: boolean;
}

function sheetExtras(raw: Record<string, unknown>, styles: XlsxStyleTable, sheetIndex: number, sheetNS: string): {
  views: string;
  cols: string;
  merges: string;
  conditionalFormats: string;
  validations: string;
  hyperlinks: string;
  commentsXml: string;
  rels: SheetRelEntry[];
  rowHeights: Map<number, number>;
} {
  let views = "", cols = "", merges = "", conditionalFormats = "", validations = "", hyperlinks = "", commentsXml = "";
  const rels: SheetRelEntry[] = [];
  const rowHeights = new Map<number, number>();

  if (raw.frozen !== undefined) {
    object(raw.frozen, ["rows", "cols"], "frozen panes");
    const { rows, cols: fCols } = raw.frozen;
    if (!Number.isInteger(rows) || !Number.isInteger(fCols) || (rows as number) < 0 || (fCols as number) < 0 || (rows as number) >= MAX_ROWS || (fCols as number) >= MAX_COLS) throw new XlsxError("invalid frozen panes");
    const r = rows as number, c = fCols as number;
    if (r || c) {
      const pane = r && c ? "bottomRight" : r ? "bottomLeft" : "topRight";
      views = `<sheetViews><sheetView workbookViewId="0"><pane${c ? ` xSplit="${c}"` : ""}${r ? ` ySplit="${r}"` : ""} topLeftCell="${columnName(c)}${r + 1}" activePane="${pane}" state="frozen"/></sheetView></sheetViews>`;
    }
  }

  if (raw.colWidths !== undefined) {
    if (!raw.colWidths || typeof raw.colWidths !== "object" || Array.isArray(raw.colWidths)) throw new XlsxError("invalid colWidths");
    const items: string[] = [];
    for (const [k, v] of Object.entries(raw.colWidths as Record<string, unknown>)) {
      const colIdx = Number(k);
      if (!Number.isInteger(colIdx) || colIdx < 0 || colIdx >= MAX_COLS || typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 255) {
        throw new XlsxError("invalid column width");
      }
      items.push(`<col min="${colIdx + 1}" max="${colIdx + 1}" width="${Number(v.toFixed(2))}" customWidth="1"/>`);
    }
    if (items.length) cols = `<cols>${items.join("")}</cols>`;
  }

  if (raw.rowHeights !== undefined) {
    if (!raw.rowHeights || typeof raw.rowHeights !== "object" || Array.isArray(raw.rowHeights)) throw new XlsxError("invalid rowHeights");
    for (const [k, v] of Object.entries(raw.rowHeights as Record<string, unknown>)) {
      const rowIdx = Number(k);
      if (!Number.isInteger(rowIdx) || rowIdx < 0 || rowIdx >= MAX_ROWS || typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 409) {
        throw new XlsxError("invalid row height");
      }
      rowHeights.set(rowIdx, Number(v.toFixed(2)));
    }
  }

  if (raw.merges !== undefined) {
    if (!Array.isArray(raw.merges) || raw.merges.length > 10_000) throw new XlsxError("invalid merge list");
    const covered = new Set<string>(), refs: string[] = [];
    for (const item of raw.merges as unknown[]) {
      object(item, ["top", "left", "bottom", "right"], "merge");
      const { top, left, bottom, right } = item;
      if (![top, left, bottom, right].every((n) => Number.isInteger(n) && (n as number) >= 0) || (bottom as number) >= MAX_ROWS || (right as number) >= MAX_COLS || (top as number) > (bottom as number) || (left as number) > (right as number) || (top === bottom && left === right)) throw new XlsxError("invalid merge range");
      if (((bottom as number) - (top as number) + 1) * ((right as number) - (left as number) + 1) > 1_000_000) throw new XlsxError("merge range is too large");
      for (let r = top as number; r <= (bottom as number); r++) for (let c = left as number; c <= (right as number); c++) {
        const key = `${r}:${c}`; if (covered.has(key)) throw new XlsxError("overlapping merge ranges"); covered.add(key);
      }
      refs.push(`<mergeCell ref="${columnName(left as number)}${(top as number) + 1}:${columnName(right as number)}${(bottom as number) + 1}"/>`);
    }
    if (refs.length) merges = `<mergeCells count="${refs.length}">${refs.join("")}</mergeCells>`;
  }

  if (raw.validations !== undefined) {
    if (!Array.isArray(raw.validations) || raw.validations.length > 1000) throw new XlsxError("invalid validations");
    const items: string[] = [];
    for (const item of raw.validations as SheetDataValidation[]) {
      const ref = `${columnName(item.left)}${item.top + 1}:${columnName(item.right)}${item.bottom + 1}`;
      const errStyle = item.strict ? "stop" : "warning";
      const promptAttr = item.hint ? ` error="${escapeXml(item.hint)}"` : "";
      if (item.type === "list" && item.options?.length) {
        const formula = `"${item.options.join(",").replace(/"/g, '""')}"`;
        items.push(`<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="${errStyle}"${promptAttr} sqref="${ref}"><formula1>${escapeXml(formula)}</formula1></dataValidation>`);
      } else if (item.type === "number" || item.type === "date") {
        const dvType = item.type === "number" ? "decimal" : "date";
        const op = item.min && item.max ? "between" : item.min ? "greaterThanOrEqual" : item.max ? "lessThanOrEqual" : "between";
        const f1 = item.min ?? item.max ?? "0";
        const f2 = item.min && item.max ? `<formula2>${escapeXml(item.max)}</formula2>` : "";
        items.push(`<dataValidation type="${dvType}" operator="${op}" allowBlank="1" showErrorMessage="1" errorStyle="${errStyle}"${promptAttr} sqref="${ref}"><formula1>${escapeXml(f1)}</formula1>${f2}</dataValidation>`);
      }
    }
    if (items.length) validations = `<dataValidations count="${items.length}">${items.join("")}</dataValidations>`;
  }

  if (raw.hyperlinks !== undefined) {
    if (!Array.isArray(raw.hyperlinks) || raw.hyperlinks.length > 5000) throw new XlsxError("invalid hyperlinks");
    const items: string[] = [];
    for (const hl of raw.hyperlinks as SheetHyperlink[]) {
      if (!Number.isInteger(hl.row) || !Number.isInteger(hl.col) || hl.row < 0 || hl.col < 0 || hl.row >= MAX_ROWS || hl.col >= MAX_COLS) {
        throw new XlsxError("invalid hyperlink coordinates");
      }
      const url = safeHyperlinkUrl(hl.target);
      const rid = `rId${rels.length + 1}`;
      rels.push({ id: rid, type: "hyperlink", target: url, external: true });
      const ref = `${columnName(hl.col)}${hl.row + 1}`;
      const tip = hl.tooltip ? ` tooltip="${escapeXml(hl.tooltip)}"` : "";
      items.push(`<hyperlink ref="${ref}" r:id="${rid}"${tip}/>`);
    }
    if (items.length) hyperlinks = `<hyperlinks>${items.join("")}</hyperlinks>`;
  }

  if (raw.conditionalFormats !== undefined) {
    if (!Array.isArray(raw.conditionalFormats) || raw.conditionalFormats.length > 1000) throw new XlsxError("invalid conditionalFormats");
    const blocks: string[] = [];
    let priority = 1;
    for (const cf of raw.conditionalFormats as SheetConditionalFormat[]) {
      if (
        !cf || typeof cf !== "object"
        || !Number.isInteger(cf.top) || !Number.isInteger(cf.left) || !Number.isInteger(cf.bottom) || !Number.isInteger(cf.right)
        || cf.top < 0 || cf.left < 0 || cf.bottom >= MAX_ROWS || cf.right >= MAX_COLS || cf.top > cf.bottom || cf.left > cf.right
        || !Object.hasOwn(COND_FMT_OPERATORS, cf.op)
      ) {
        throw new XlsxError("invalid conditional format rule");
      }
      const dxfId = styles.dxfIndex({ bg: cf.bg, color: cf.color, bold: cf.bold });
      const dxfAttr = dxfId !== undefined ? ` dxfId="${dxfId}"` : "";
      const topLeft = `${columnName(cf.left)}${cf.top + 1}`;
      const sqref = cf.top === cf.bottom && cf.left === cf.right ? topLeft : `${topLeft}:${columnName(cf.right)}${cf.bottom + 1}`;
      let ruleXml: string;
      if (cf.op === "empty") {
        ruleXml = `<cfRule type="containsBlanks"${dxfAttr} priority="${priority++}"><formula>LEN(TRIM(${topLeft}))=0</formula></cfRule>`;
      } else if (cf.op === "not_empty") {
        ruleXml = `<cfRule type="notContainsBlanks"${dxfAttr} priority="${priority++}"><formula>LEN(TRIM(${topLeft}))&gt;0</formula></cfRule>`;
      } else if (cf.op === "contains") {
        const v1 = cf.value1 ?? "";
        text(v1, MAX_FORMULA, "conditional format value");
        ruleXml = `<cfRule type="containsText"${dxfAttr} priority="${priority++}" operator="containsText" text="${escapeXml(v1)}"><formula>NOT(ISERROR(SEARCH(&quot;${xmlText(v1.replace(/"/g, '""'))}&quot;,${topLeft})))</formula></cfRule>`;
      } else {
        const v1 = cf.value1 ?? "0";
        text(v1, MAX_FORMULA, "conditional format value");
        const f1 = `<formula>${cfFormulaLiteral(v1)}</formula>`;
        let f2 = "";
        if (cf.op === "between") {
          const v2 = cf.value2 ?? v1;
          text(v2, MAX_FORMULA, "conditional format value");
          f2 = `<formula>${cfFormulaLiteral(v2)}</formula>`;
        }
        ruleXml = `<cfRule type="cellIs"${dxfAttr} priority="${priority++}" operator="${COND_FMT_OPERATORS[cf.op]}">${f1}${f2}</cfRule>`;
      }
      blocks.push(`<conditionalFormatting sqref="${sqref}">${ruleXml}</conditionalFormatting>`);
    }
    conditionalFormats = blocks.join("");
  }

  if (raw.comments !== undefined) {
    if (!Array.isArray(raw.comments) || raw.comments.length > 5000) throw new XlsxError("invalid comments");
    const authorMap = new Map<string, number>();
    const authors: string[] = [];
    const seenCoords = new Set<string>();
    const items: string[] = [];
    for (const cm of raw.comments as unknown[]) {
      object(cm, ["row", "col", "text", "author"], "comment");
      const { row, col, text: body, author } = cm;
      if (!Number.isInteger(row) || !Number.isInteger(col) || (row as number) < 0 || (col as number) < 0 || (row as number) >= MAX_ROWS || (col as number) >= MAX_COLS) {
        throw new XlsxError("invalid comment coordinates");
      }
      if (typeof body !== "string") throw new XlsxError("invalid comment text");
      text(body, MAX_CELL_TEXT, "comment text");
      if (author !== undefined && typeof author !== "string") throw new XlsxError("invalid comment author");
      const authorName = author ?? "";
      text(authorName, 255, "comment author");
      const key = `${row}:${col}`;
      if (seenCoords.has(key)) throw new XlsxError("duplicate comment coordinate");
      seenCoords.add(key);
      let authorId = authorMap.get(authorName);
      if (authorId === undefined) {
        authorId = authors.length;
        authors.push(authorName);
        authorMap.set(authorName, authorId);
      }
      const ref = `${columnName(col as number)}${(row as number) + 1}`;
      items.push(`<comment ref="${ref}" authorId="${authorId}"><text><t xml:space="preserve">${xmlText(body)}</t></text></comment>`);
    }
    if (items.length) {
      commentsXml = `<comments xmlns="${sheetNS}"><authors>${authors.map((a) => `<author>${xmlText(a)}</author>`).join("")}</authors><commentList>${items.join("")}</commentList></comments>`;
      rels.push({ id: `rId${rels.length + 1}`, type: "comments", target: `../comments${sheetIndex + 1}.xml` });
    }
  }

  return { views, cols, merges, conditionalFormats, validations, hyperlinks, commentsXml, rels, rowHeights };
}

function buildXlsxEntries(workbook: XlsxWorkbook, options: WriteXlsxOptions, useSharedStrings: boolean): { entries: ZipEntryInput[]; limits: XlsxLimits } {
  const rawOptions = options as WriteXlsxOptions;
  object(workbook, ["sheets", "definedNames"], "workbook");
  object(options, ["modified", "limits", "sharedStrings", "compression"], "options");
  const limits = resolveXlsxLimits(rawOptions.limits);
  if (!Array.isArray(workbook.sheets) || !workbook.sheets.length || workbook.sheets.length > limits.maxSheets) {
    throw new XlsxError(`workbook must contain 1 to ${limits.maxSheets} sheets`);
  }
  if (options.modified !== undefined && (!(options.modified instanceof Date) || !Number.isFinite(options.modified.getTime()))) {
    throw new XlsxError("invalid modified date");
  }
  const sheetNS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const relNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const names = new Set<string>();
  const sheetNameToIdx = new Map<string, number>();
  const styles = new XlsxStyleTable();
  const sst = useSharedStrings ? new SharedStringTable() : null;
  const builtSheets: { name: string; rows: string; views: string; cols: string; merges: string; conditionalFormats: string; validations: string; hyperlinks: string; commentsXml: string; rels: SheetRelEntry[] }[] = [];
  let cellsTotal = 0, xmlBytes = 0;

  for (let sheetIndex = 0; sheetIndex < workbook.sheets.length; sheetIndex++) {
    const raw = workbook.sheets[sheetIndex];
    object(raw, ["name", "cells", "merges", "frozen", "colWidths", "rowHeights", "validations", "conditionalFormats", "hyperlinks", "comments"], "sheet");
    if (typeof raw.name !== "string" || !raw.name || raw.name.length > 31 || /[\[\]:*?/\\\u0000-\u001f]/.test(raw.name) || raw.name.startsWith("'") || raw.name.endsWith("'")) {
      throw new XlsxError("invalid sheet name");
    }
    text(raw.name, 31, "sheet name");
    const normalized = raw.name.toLowerCase();
    if (names.has(normalized)) throw new XlsxError("duplicate sheet name");
    names.add(normalized);
    sheetNameToIdx.set(normalized, sheetIndex);
    if (!Array.isArray(raw.cells) || (cellsTotal += raw.cells.length) > limits.maxCells) {
      throw new XlsxError("too many cells or invalid cell list");
    }

    const extras = sheetExtras(raw as unknown as Record<string, unknown>, styles, sheetIndex, sheetNS);
    const seen = new Set<string>(), cells: { row: number; col: number; xml: string }[] = [];
    for (const item of raw.cells) {
      const cell = cellXml(item, styles, sst), key = `${cell.row}:${cell.col}`;
      if (seen.has(key)) throw new XlsxError("duplicate cell coordinate");
      seen.add(key);
      xmlBytes += encoder.encode(cell.xml).byteLength;
      if (xmlBytes > limits.maxXmlBytes) throw new XlsxError("workbook content exceeds the export limit");
      cells.push(cell);
    }
    cells.sort((a, b) => a.row - b.row || a.col - b.col);

    // Emit rows that have cells or custom row heights.
    const rowCellsMap = new Map<number, string[]>();
    for (const c of cells) {
      let arr = rowCellsMap.get(c.row);
      if (!arr) { arr = []; rowCellsMap.set(c.row, arr); }
      arr.push(c.xml);
    }
    for (const rIdx of extras.rowHeights.keys()) {
      if (!rowCellsMap.has(rIdx)) rowCellsMap.set(rIdx, []);
    }
    const sortedRows = [...rowCellsMap.keys()].sort((a, b) => a - b);
    const rows = sortedRows.map((rIdx) => {
      const ht = extras.rowHeights.get(rIdx);
      const htAttr = ht !== undefined ? ` ht="${ht}" customHeight="1"` : "";
      const inner = rowCellsMap.get(rIdx)!.join("");
      return inner ? `<row r="${rIdx + 1}"${htAttr}>${inner}</row>` : `<row r="${rIdx + 1}"${htAttr}/>`;
    });

    builtSheets.push({ name: raw.name, rows: rows.join(""), views: extras.views, cols: extras.cols, merges: extras.merges, conditionalFormats: extras.conditionalFormats, validations: extras.validations, hyperlinks: extras.hyperlinks, commentsXml: extras.commentsXml, rels: extras.rels });
  }

  let definedNamesXml = "";
  if (workbook.definedNames !== undefined) {
    if (!Array.isArray(workbook.definedNames) || workbook.definedNames.length > 1000) throw new XlsxError("invalid definedNames");
    const dnItems: string[] = [];
    for (const dn of workbook.definedNames) {
      if (!dn.name || !dn.ref || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(dn.name)) throw new XlsxError("invalid defined name");
      const localAttr = dn.sheetName !== undefined
        ? (() => {
            const idx = sheetNameToIdx.get(dn.sheetName.toLowerCase());
            if (idx === undefined) throw new XlsxError("defined name references unknown sheet");
            return ` localSheetId="${idx}"`;
          })()
        : "";
      const refClean = dn.ref.startsWith("=") ? dn.ref.slice(1) : dn.ref;
      dnItems.push(`<definedName name="${escapeXml(dn.name)}"${localAttr}>${escapeXml(refClean)}</definedName>`);
    }
    if (dnItems.length) definedNamesXml = `<definedNames>${dnItems.join("")}</definedNames>`;
  }

  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const entries: ZipEntryInput[] = [];
  const add = (name: string, body: string) => {
    const data = encoder.encode(header + body);
    xmlBytes += data.byteLength;
    if (xmlBytes > limits.maxXmlBytes * 2) throw new XlsxError("workbook XML exceeds the export limit");
    entries.push({ name, data });
  };
  const withStyles = styles.used;
  const withSst = !!sst && sst.items.length > 0;
  let nextRelId = builtSheets.length + 1;
  const stylesRelId = withStyles ? nextRelId++ : 0;
  const sstRelId = withSst ? nextRelId++ : 0;

  add(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${builtSheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}${builtSheets.map((sheet, i) => sheet.commentsXml ? `<Override PartName="/xl/comments${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>` : "").join("")}${withStyles ? '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' : ""}${withSst ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : ""}</Types>`,
  );
  add("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add(
    "xl/workbook.xml",
    `<workbook xmlns="${sheetNS}" xmlns:r="${relNS}"><sheets>${builtSheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${definedNamesXml}<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`,
  );
  add(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${builtSheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${relNS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}${withStyles ? `<Relationship Id="rId${stylesRelId}" Type="${relNS}/styles" Target="styles.xml"/>` : ""}${withSst ? `<Relationship Id="rId${sstRelId}" Type="${relNS}/sharedStrings" Target="sharedStrings.xml"/>` : ""}</Relationships>`,
  );
  builtSheets.forEach((sheet, i) => {
    const rNsAttr = sheet.hyperlinks ? ` xmlns:r="${relNS}"` : "";
    add(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<worksheet xmlns="${sheetNS}"${rNsAttr}>${sheet.views}${sheet.cols}<sheetData>${sheet.rows}</sheetData>${sheet.merges}${sheet.conditionalFormats}${sheet.validations}${sheet.hyperlinks}</worksheet>`,
    );
    if (sheet.commentsXml) add(`xl/comments${i + 1}.xml`, sheet.commentsXml);
    if (sheet.rels.length) {
      add(
        `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheet.rels.map((r) => `<Relationship Id="${r.id}" Type="${relNS}/${r.type}" Target="${escapeXml(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`,
      );
    }
  });
  if (withStyles) add("xl/styles.xml", styles.xml(sheetNS));
  if (withSst && sst) add("xl/sharedStrings.xml", sst.xml(sheetNS));

  return { entries, limits };
}

/** Create a bounded XLSX file synchronously (STORE ZIP). Unsupported workbook properties are rejected, not dropped. */
export function writeXlsx(workbook: XlsxWorkbook, options: WriteXlsxOptions = {}): Uint8Array {
  const { entries, limits } = buildXlsxEntries(workbook, options, options.sharedStrings ?? false);
  const result = createZip(entries, options.modified);
  if (result.length > limits.maxFileBytes) throw new XlsxError("XLSX file exceeds the export limit");
  return result;
}

/**
 * Create a bounded XLSX file asynchronously using DEFLATE compression and
 * sharedStrings deduplication by default (60%–85% smaller output).
 */
export async function writeXlsxAsync(workbook: XlsxWorkbook, options: WriteXlsxOptions = {}): Promise<Uint8Array> {
  const { entries, limits } = buildXlsxEntries(workbook, options, options.sharedStrings ?? true);
  const result = await createZipAsync(entries, { modified: options.modified, compression: options.compression ?? "deflate" });
  if (result.length > limits.maxFileBytes) throw new XlsxError("XLSX file exceeds the export limit");
  return result;
}

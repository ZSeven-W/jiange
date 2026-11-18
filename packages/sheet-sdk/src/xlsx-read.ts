import { listZip, readZipEntry, type ZipEntry } from "@jiange/ooxml/zip";
import { xattr, xchild, xchildren, xlsxXml, xtext, type XlsxXmlNode } from "./xlsx-xml.js";
import { XlsxError, XLSX_MAX_CELLS, XLSX_MAX_FILE_BYTES, XLSX_MAX_SHEETS, type XlsxCell, type XlsxCellError, type XlsxScalar, type XlsxSheet, type XlsxWorkbook } from "./xlsx.js";
import { parseMergeRef, readXlsxStyles, type XlsxMerge, type XlsxStyle } from "./xlsx-style.js";

export const XLSX_MAX_INPUT_BYTES = XLSX_MAX_FILE_BYTES;
const MAX_PART = XLSX_MAX_FILE_BYTES, MAX_TOTAL = 64 * 1024 * 1024, MAX_ENTRIES = 4096;
const SHEET_NS = new Set(["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"]);
const DOC_REL_NS = new Set(["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"]);
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const ERRORS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA", "#SPILL!", "#CALC!"]);

export interface XlsxImportResult { workbook: XlsxWorkbook; warnings: string[] }
type Relationship = { id: string; type: string; target: string; external: boolean };

function safePath(base: string, target: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(target); } catch { throw new XlsxError("invalid relationship target"); }
  if (!decoded || /[\\\0?#]/.test(decoded)) throw new XlsxError("invalid relationship target");
  const parts = decoded.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) throw new XlsxError("relationship escapes the package"); parts.pop(); }
    else parts.push(part);
  }
  if (!parts.length) throw new XlsxError("invalid relationship target");
  return parts.join("/");
}
function relPath(path: string): string { const parts = path.split("/"), name = parts.pop()!; return [...parts, "_rels", `${name}.rels`].join("/"); }
function relKind(type: string, kind: string): boolean { return [...DOC_REL_NS].some((base) => type === `${base}/${kind}`); }
function relationships(root: XlsxXmlNode): Relationship[] {
  if (root.name !== "Relationships" || root.ns !== PACKAGE_REL_NS) throw new XlsxError("invalid relationship part");
  const seen = new Set<string>();
  return xchildren(root, "Relationship").map((entry) => {
    const id = xattr(entry, "Id") ?? "", type = xattr(entry, "Type") ?? "", target = xattr(entry, "Target") ?? "";
    const mode = (xattr(entry, "TargetMode") ?? "internal").toLowerCase();
    if (!id || !type || !target || seen.has(id)) throw new XlsxError("invalid or duplicate relationship");
    if (mode !== "internal" && mode !== "external") throw new XlsxError("invalid relationship target mode");
    seen.add(id); return { id, type, target, external: mode === "external" };
  });
}
function address(value: string): {row:number;col:number} {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  if (!match) throw new XlsxError("invalid cell reference");
  let col = 0; for (const ch of match[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (col > 16_384 || row > 1_048_576) throw new XlsxError("cell reference is out of range");
  return { row: row - 1, col: col - 1 };
}
function checkedText(value: string, limit: number, what: string): string {
  if (value.length > limit) throw new XlsxError(`${what} is too long`);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffe || c === 0xffff || (c >= 0xdc00 && c <= 0xdfff)) throw new XlsxError(`${what} contains invalid XML characters`);
    if (c >= 0xd800 && c <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new XlsxError(`${what} contains invalid XML characters`); }
  }
  return value;
}
function plainText(node: XlsxXmlNode): string {
  if (node.children.some((child) => typeof child !== "string")) throw new XlsxError("unexpected nested text element");
  return xtext(node);
}
function hasOtherChildren(node: XlsxXmlNode, allowed: readonly string[]): boolean {
  return node.children.some((value) => typeof value !== "string" && (value.ns !== node.ns || !allowed.includes(value.name)));
}
function stringItem(node: XlsxXmlNode, warn: Set<string>): string {
  const direct = xchildren(node, "t"), runs = xchildren(node, "r");
  if (direct.length > 1 || direct.length && runs.length) throw new XlsxError("invalid rich string");
  if (runs.length) warn.add("rich_text_formatting_not_preserved");
  if (hasOtherChildren(node, ["t", "r"])) warn.add("string_metadata_not_preserved");
  const value = direct.length ? plainText(direct[0]) : runs.map((run) => {
    const texts = xchildren(run, "t"); if (texts.length !== 1) throw new XlsxError("invalid rich string run");
    if (hasOtherChildren(run, ["t"])) warn.add("rich_text_formatting_not_preserved");
    return plainText(texts[0]);
  }).join("");
  return checkedText(value, 32_767, "cell text");
}

/** Read XLSX cells without evaluating formulas or fetching external relationships. */
export async function readXlsx(bytes: Uint8Array): Promise<XlsxImportResult> {
  if (!(bytes instanceof Uint8Array) || bytes.length > XLSX_MAX_INPUT_BYTES) throw new XlsxError("XLSX file exceeds the input limit");
  try {
    const listed = listZip(bytes);
    if (listed.length > MAX_ENTRIES) throw new XlsxError("too many ZIP entries");
    const entries = new Map<string, ZipEntry>(), caseNames = new Set<string>();
    for (const entry of listed) {
      if (entry.name.endsWith("/")) continue;
      if (!entry.name || entry.name.startsWith("/") || /[\\\0\uFFFD]/.test(entry.name) || entry.name.split("/").some((part) => !part || part === "." || part === "..")) throw new XlsxError("invalid ZIP entry name");
      const folded = entry.name.toLowerCase(); if (caseNames.has(folded)) throw new XlsxError("duplicate ZIP entry");
      caseNames.add(folded); entries.set(entry.name, entry);
    }
    let total = 0;
    const cache = new Map<string, XlsxXmlNode>();
    const xml = async (path: string): Promise<XlsxXmlNode> => {
      const cached = cache.get(path); if (cached) return cached;
      const entry = entries.get(path); if (!entry) throw new XlsxError(`missing required part: ${path}`);
      total += entry.size; if (total > MAX_TOTAL) throw new XlsxError("XLSX expanded content exceeds the limit");
      const content = await readZipEntry(bytes, entry, MAX_PART), source = new TextDecoder("utf-8", { fatal: true }).decode(content);
      const node = xlsxXml(source); cache.set(path, node); return node;
    };
    const contentTypes = await xml("[Content_Types].xml");
    if (contentTypes.name !== "Types" || contentTypes.ns !== CONTENT_NS) throw new XlsxError("invalid content types");
    const overrideNames = new Set<string>();
    for (const item of xchildren(contentTypes, "Override")) {
      const name = xattr(item, "PartName") ?? "";
      if (!name.startsWith("/") || overrideNames.has(name.toLowerCase())) throw new XlsxError("invalid or duplicate content type override");
      overrideNames.add(name.toLowerCase());
    }
    const rootRels = relationships(await xml("_rels/.rels"));
    const office = rootRels.filter((rel) => relKind(rel.type, "officeDocument"));
    if (office.length !== 1 || office[0].external) throw new XlsxError("invalid workbook relationship");
    const workbookPath = safePath("", office[0].target);
    const declared = xchildren(contentTypes, "Override").filter((node) => xattr(node, "PartName") === `/${workbookPath}`);
    if (declared.length !== 1 || xattr(declared[0], "ContentType") !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml") throw new XlsxError("unsupported workbook type");
    const workbook = await xml(workbookPath);
    if (workbook.name !== "workbook" || !SHEET_NS.has(workbook.ns)) throw new XlsxError("unsupported workbook namespace");
    const rels = relationships(await xml(relPath(workbookPath))), byId = new Map(rels.map((rel) => [rel.id, rel]));
    const warnings = new Set<string>();
    if (rootRels.some((rel) => !relKind(rel.type, "officeDocument"))) warnings.add("package_metadata_not_preserved");
    if (hasOtherChildren(workbook, ["sheets", "calcPr", "fileVersion"])) warnings.add("workbook_metadata_not_preserved");
    if (rels.some((rel) => !["worksheet", "sharedStrings", "styles", "theme"].some((kind) => relKind(rel.type, kind)))) warnings.add("workbook_relationships_not_preserved");
    const styleRels = rels.filter((rel) => relKind(rel.type, "styles"));
    if (styleRels.length > 1 || styleRels[0]?.external) throw new XlsxError("invalid styles relationship");
    let cellStyles: (XlsxStyle | undefined)[] = [];
    if (styleRels.length) {
      const root = await xml(safePath(workbookPath, styleRels[0].target));
      if (root.ns !== workbook.ns) throw new XlsxError("invalid styles part");
      cellStyles = readXlsxStyles(root, warnings);
    }
    const sharedRels = rels.filter((rel) => relKind(rel.type, "sharedStrings"));
    if (sharedRels.length > 1 || sharedRels[0]?.external) throw new XlsxError("invalid shared strings relationship");
    let shared: string[] = [];
    if (sharedRels.length) {
      const root = await xml(safePath(workbookPath, sharedRels[0].target));
      if (root.name !== "sst" || root.ns !== workbook.ns) throw new XlsxError("invalid shared strings");
      if (hasOtherChildren(root, ["si"])) warnings.add("string_metadata_not_preserved");
      const items = xchildren(root, "si"); if (items.length > XLSX_MAX_CELLS) throw new XlsxError("too many shared strings");
      shared = items.map((item) => stringItem(item, warnings));
    }
    const lists = xchildren(workbook, "sheets");
    if (lists.length !== 1) throw new XlsxError("invalid workbook sheets");
    const list = lists[0], descriptors = xchildren(list, "sheet");
    if (hasOtherChildren(list, ["sheet"])) warnings.add("workbook_metadata_not_preserved");
    if (!descriptors.length || descriptors.length > XLSX_MAX_SHEETS) throw new XlsxError("invalid number of worksheets");
    const names = new Set<string>(), sheetIds = new Set<number>(), usedParts = new Set<string>(), sheets: XlsxSheet[] = [];
    let count = 0;
    for (const descriptor of descriptors) {
      const name = xattr(descriptor, "name") ?? "";
      if (!name || name.length > 31 || /[\[\]:*?/\\\u0000-\u001f]/.test(name) || name.startsWith("'") || name.endsWith("'")) throw new XlsxError("invalid sheet name");
      checkedText(name, 31, "sheet name");
      const folded = name.toLowerCase(); if (names.has(folded)) throw new XlsxError("duplicate sheet name"); names.add(folded);
      const sheetId = xattr(descriptor, "sheetId") ?? "";
      if (!/^[1-9]\d{0,9}$/.test(sheetId) || Number(sheetId) > 0xffffffff || sheetIds.has(Number(sheetId))) throw new XlsxError("invalid or duplicate sheet id");
      sheetIds.add(Number(sheetId));
      const visibility = xattr(descriptor, "state") ?? "visible";
      if (!["visible", "hidden", "veryHidden"].includes(visibility)) throw new XlsxError("invalid sheet visibility");
      if (visibility !== "visible") warnings.add("sheet_visibility_not_preserved");
      const ids = [...DOC_REL_NS].map((ns) => xattr(descriptor, "id", ns)).filter((id): id is string => !!id);
      if (ids.length !== 1) throw new XlsxError("invalid worksheet relationship id");
      const rel = byId.get(ids[0]); if (!rel || rel.external || !relKind(rel.type, "worksheet")) throw new XlsxError("unsupported worksheet relationship");
      const path = safePath(workbookPath, rel.target); if (usedParts.has(path)) throw new XlsxError("duplicate worksheet part"); usedParts.add(path);
      const sheet = await xml(path);
      if (sheet.name !== "worksheet" || sheet.ns !== workbook.ns) throw new XlsxError("invalid worksheet part");
      if (hasOtherChildren(sheet, ["sheetData", "dimension", "sheetViews", "sheetFormatPr", "mergeCells", "pageMargins"])) warnings.add("worksheet_features_not_preserved");
      let frozen: { rows: number; cols: number } | undefined;
      const view = xchildren(xchildren(sheet, "sheetViews")[0] ?? sheet, "sheetView")[0];
      const pane = view ? xchildren(view, "pane")[0] : undefined;
      if (pane) {
        const state = xattr(pane, "state") ?? "split", split = (name: string) => { const v = xattr(pane, name) ?? "0"; return /^\d{1,7}$/.test(v) ? Number(v) : NaN; };
        const rows = split("ySplit"), cols = split("xSplit");
        if ((state === "frozen" || state === "frozenSplit") && Number.isInteger(rows) && Number.isInteger(cols) && rows < 1_048_576 && cols < 16_384) { if (rows || cols) frozen = { rows, cols }; }
        else warnings.add("worksheet_features_not_preserved");
      }
      const merges: XlsxMerge[] = [];
      const mergeList = xchildren(sheet, "mergeCells")[0];
      if (mergeList) {
        const items = xchildren(mergeList, "mergeCell");
        if (items.length > 10_000) throw new XlsxError("too many merged ranges");
        for (const item of items) merges.push(parseMergeRef(xattr(item, "ref") ?? "", address));
      }
      const data = xchildren(sheet, "sheetData"); if (data.length !== 1) throw new XlsxError("invalid worksheet data");
      if (hasOtherChildren(data[0], ["row"])) warnings.add("worksheet_features_not_preserved");
      const cells: XlsxCell[] = [], seen = new Set<string>();
      for (const row of xchildren(data[0], "row")) {
        const rowNumber = xattr(row, "r");
        if (rowNumber !== undefined && (!/^[1-9]\d{0,6}$/.test(rowNumber) || Number(rowNumber) > 1_048_576)) throw new XlsxError("invalid row reference");
        if (Object.keys(row.attrs).some((key) => key !== "|r" && key !== "|spans")) warnings.add("row_formatting_not_preserved");
        if (hasOtherChildren(row, ["c"])) warnings.add("row_metadata_not_preserved");
        for (const cell of xchildren(row, "c")) {
          if (++count > XLSX_MAX_CELLS) throw new XlsxError("too many worksheet cells");
          const point = address(xattr(cell, "r") ?? ""), key = `${point.row}:${point.col}`;
          if (rowNumber !== undefined && Number(rowNumber) !== point.row + 1) throw new XlsxError("cell and row references disagree");
          if (seen.has(key)) throw new XlsxError("duplicate cell reference"); seen.add(key);
          const styleAttr = xattr(cell, "s"); if (styleAttr && !/^\d+$/.test(styleAttr)) throw new XlsxError("invalid cell style index");
          let style: XlsxStyle | undefined;
          if (styleAttr && styleAttr !== "0") {
            const idx = Number(styleAttr);
            if (idx >= cellStyles.length) { if (cellStyles.length) throw new XlsxError("invalid cell style index"); warnings.add("cell_formatting_not_preserved"); }
            else style = cellStyles[idx];
          }
          if (Object.keys(cell.attrs).some((key) => !["|r", "|s", "|t"].includes(key))) warnings.add("cell_metadata_not_preserved");
          if (hasOtherChildren(cell, ["f", "v", "is"])) warnings.add("cell_metadata_not_preserved");
          const formulas = xchildren(cell, "f"), values = xchildren(cell, "v"), inline = xchildren(cell, "is");
          if (formulas.length > 1 || values.length > 1 || inline.length > 1) throw new XlsxError("invalid cell content");
          let formula: string | undefined;
          if (formulas.length) {
            const f = formulas[0], kind = xattr(f, "t");
            if (kind && kind !== "normal") throw new XlsxError("shared, array or data-table formulas are not supported");
            if (Object.keys(f.attrs).some((key) => key !== "|t")) warnings.add("formula_metadata_not_preserved");
            const value = checkedText(plainText(f), 8_191, "formula");
            if (!value || value.startsWith("=")) throw new XlsxError("invalid formula");
            formula = `=${value}`;
          }
          const type = xattr(cell, "t") ?? "n";
          const raw = values.length ? plainText(values[0]) : undefined;
          let value: XlsxScalar | undefined;
          if (type === "inlineStr") { if (formula || values.length || inline.length !== 1) throw new XlsxError("invalid inline string"); value = stringItem(inline[0], warnings); }
          else if (type === "s") {
            if (formula || inline.length || raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) >= shared.length) throw new XlsxError("invalid shared string index");
            value = shared[Number(raw)];
          } else if (type === "str") { if (inline.length) throw new XlsxError("invalid string cell"); if (raw !== undefined) value = checkedText(raw, 32_767, "cell text"); }
          else if (type === "b") { if (inline.length || raw !== undefined && raw !== "0" && raw !== "1") throw new XlsxError("invalid boolean cell"); if (raw !== undefined) value = raw === "1"; }
          else if (type === "e") { if (inline.length || raw !== undefined && !ERRORS.has(raw)) throw new XlsxError("unsupported error cell"); if (raw !== undefined) value = {error: raw as XlsxCellError["error"]}; }
          else if (type === "n") {
            if (inline.length || raw !== undefined && raw !== "" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) throw new XlsxError("invalid numeric cell");
            if (raw !== undefined && raw !== "") { value = Number(raw); if (!Number.isFinite(value)) throw new XlsxError("numeric cell is out of range"); }
          } else throw new XlsxError(`unsupported cell type: ${type}`);
          if (formula !== undefined && type === "str" && value === "") { warnings.add("empty_formula_cache_not_preserved"); value = undefined; }
          if (formula === undefined && type !== "n" && value === undefined) throw new XlsxError("missing typed cell value");
          const styled = style ? { style } : {};
          if (formula !== undefined) cells.push({ ...point, formula, ...(value === undefined ? {} : { value }), ...styled });
          else if (value !== undefined) cells.push({ ...point, value, ...styled });
          else if (style) cells.push({ ...point, style });
        }
      }
      sheets.push({ name, cells, ...(merges.length ? { merges } : {}), ...(frozen ? { frozen } : {}) });
    }
    if ([...entries.keys()].some((path) => !cache.has(path))) warnings.add("package_parts_not_preserved");
    return { workbook: { sheets }, warnings: [...warnings].sort() };
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    throw new XlsxError("invalid or unsupported XLSX file");
  }
}

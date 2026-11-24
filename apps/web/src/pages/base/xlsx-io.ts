import { writeXlsx, type XlsxCell, type XlsxStyle } from "@jiange/sheet-sdk/xlsx";
import { readXlsx, XLSX_MAX_INPUT_BYTES } from "@jiange/sheet-sdk/xlsx-read";
import { numFmtFromCode } from "@jiange/sheet-sdk/workbook-xlsx";
import type { BaseRecord, Cell, Field, User } from "@/lib/api";
import { displayValue, evalFormulas, formatTime, memberName, personIDs, REGISTRY, setFormulaCache } from "./registry";

const MAX_IMPORT_ROWS = 10_000;
const MAX_IMPORT_COLS = 500;
const MAX_CELL_TEXT = 32_767;

const HEADER_STYLE: XlsxStyle = {
  bold: true,
  fill: "#F2F3F5",
  color: "#1F2329",
  horizontal: "left",
  vertical: "center",
  border: { bottom: true, color: "#DEE0E3" },
};

const READONLY_OR_DERIVED_TYPES = new Set([
  "formula",
  "lookup",
  "link",
  "attachment",
  "created_by",
  "created_at",
  "modified_at",
  "autonumber",
  "button",
]);

function sanitizeXmlString(value: string): string {
  // Remove illegal XML 1.0 control chars and unpaired surrogates so writeXlsx never fails.
  let out = "";
  for (let i = 0; i < value.length && out.length < MAX_CELL_TEXT; i++) {
    const c = value.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffe || c === 0xffff) continue;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i] + value[i + 1];
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += value[i];
  }
  return out;
}

function sanitizeSheetName(raw: string): string {
  const cleaned = sanitizeXmlString(raw)
    .replace(/[:\\/?*[\]]/g, " ")
    .replace(/^'+|'+$/g, "")
    .trim()
    .slice(0, 31)
    .replace(/^'+|'+$/g, "")
    .trim();
  return cleaned || "数据表";
}

function visualCharWidth(text: string): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += text.charCodeAt(i) > 0x7f ? 2 : 1;
  }
  return w;
}

function formatBaseCellForXlsx(
  rec: BaseRecord,
  f: Field,
  members: User[],
): string | number | boolean | null {
  const val = displayValue(rec, f, members);
  if (val === undefined || val === null || val === "") return null;

  switch (f.type) {
    case "number":
    case "rating":
    case "currency":
    case "progress": {
      if (typeof val === "number" && Number.isFinite(val)) return val;
      const n = Number(val);
      return Number.isFinite(n) ? n : sanitizeXmlString(String(val));
    }
    case "autonumber":
    case "button":
      return sanitizeXmlString(REGISTRY[f.type].format(val, f, members));
    case "checkbox":
      return typeof val === "boolean" ? val : Boolean(val);
    case "select":
    case "date":
    case "text":
    case "url":
    case "phone":
    case "email":
    case "location":
      return sanitizeXmlString(String(val));
    case "multi_select":
      return Array.isArray(val)
        ? sanitizeXmlString(val.filter((x): x is string => typeof x === "string").join("; "))
        : sanitizeXmlString(String(val));
    case "person": {
      const ids = personIDs(val);
      if (!ids.length) return null;
      return sanitizeXmlString(ids.map((id) => memberName(id, members) || String(id)).join("、"));
    }
    case "created_by":
      return typeof val === "number" && val > 0
        ? sanitizeXmlString(memberName(val, members) || String(val))
        : sanitizeXmlString(String(val));
    case "created_at":
    case "modified_at":
      return typeof val === "string" ? sanitizeXmlString(formatTime(val)) : sanitizeXmlString(String(val));
    case "formula": {
      if (typeof val === "number" && Number.isFinite(val)) return val;
      if (typeof val === "boolean") return val;
      return sanitizeXmlString(String(val));
    }
    case "lookup":
    case "link": {
      if (Array.isArray(val)) {
        const text = val
          .map((item) => (typeof item === "object" && item && "name" in item ? String(item.name) : String(item)))
          .filter(Boolean)
          .join(", ");
        return text ? sanitizeXmlString(text) : null;
      }
      return sanitizeXmlString(String(val));
    }
    case "attachment": {
      if (Array.isArray(val)) {
        const names = val
          .map((item) => (typeof item === "object" && item && "name" in item ? String(item.name) : String(item)))
          .filter(Boolean)
          .join(", ");
        return names ? sanitizeXmlString(names) : null;
      }
      return sanitizeXmlString(String(val));
    }
    default:
      return sanitizeXmlString(String(val));
  }
}

/**
 * Exports Base fields and records to a real `.xlsx` workbook with a styled bold
 * header row, frozen top row, native Excel number/boolean types, and auto column widths.
 */
export function exportBaseToXlsx(
  tableName: string,
  fields: Field[],
  records: BaseRecord[],
  members: User[] = [],
): Uint8Array {
  for (const rec of records) {
    try {
      setFormulaCache(rec, evalFormulas(fields, rec, members));
    } catch {
      /* ignore malformed formula expressions during export */
    }
  }

  const cells: XlsxCell[] = [];
  const maxWidthByCol: number[] = fields.map((f) => visualCharWidth(f.name));

  fields.forEach((f, col) => {
    cells.push({
      row: 0,
      col,
      value: sanitizeXmlString(f.name),
      style: HEADER_STYLE,
    });
  });

  records.forEach((rec, rowIdx) => {
    const excelRow = rowIdx + 1;
    fields.forEach((f, col) => {
      const value = formatBaseCellForXlsx(rec, f, members);
      if (value === null) return;
      cells.push({ row: excelRow, col, value });
      const text = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
      const w = visualCharWidth(text.split("\n")[0] ?? "");
      if (w > maxWidthByCol[col]) maxWidthByCol[col] = w;
    });
  });

  const colWidths: Record<number, number> = {};
  maxWidthByCol.forEach((w, col) => {
    colWidths[col] = Math.min(50, Math.max(10, w + 4));
  });

  return writeXlsx({
    sheets: [
      {
        name: sanitizeSheetName(tableName),
        cells,
        colWidths,
        rowHeights: { 0: 24 },
        ...(fields.length > 0 ? { frozen: { rows: 1, cols: 0 } } : {}),
      },
    ],
  });
}

export interface ParsedXlsxBaseRows {
  headers: string[];
  rows: Record<string, Cell>[];
  rawRows: string[][];
  warnings: string[];
}

function excelSerialToIsoDate(serial: number): string {
  // Excel 1900 date system epoch (1899-12-30 accounts for the Lotus 1900 leap-year bug).
  const wholeDays = Math.floor(serial);
  const ms = Date.UTC(1899, 11, 30) + wholeDays * 86_400_000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeDateText(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (slash) {
    const base = `${slash[1]}-${slash[2].padStart(2, "0")}-${slash[3].padStart(2, "0")}`;
    return slash[4] !== undefined ? `${base} ${slash[4].padStart(2, "0")}:${slash[5]}` : base;
  }
  const dt = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (dt) return `${dt[1]} ${dt[2]}:${dt[3]}`;
  return null;
}

function parseCellForExistingField(
  rawValue: string | number | boolean,
  field: Field,
  members: User[],
): { ok: true; value: Cell } | { ok: false; empty?: boolean } {
  if (READONLY_OR_DERIVED_TYPES.has(field.type)) {
    return { ok: false, empty: true };
  }
  const text = typeof rawValue === "string" ? rawValue.trim() : String(rawValue);
  if (text === "") return { ok: false, empty: true };

  switch (field.type) {
    case "number": {
      if (typeof rawValue === "number" && Number.isFinite(rawValue)) return { ok: true, value: rawValue };
      const n = Number(text);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case "currency": {
      if (typeof rawValue === "number" && Number.isFinite(rawValue)) return { ok: true, value: rawValue };
      const cleaned = text.replace(/HK\$|[¥$€£,\s]/gi, "").trim();
      const n = Number(cleaned);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case "progress": {
      const cleaned = text.replace(/%$/, "").trim();
      const n = typeof rawValue === "number" ? rawValue : Number(cleaned);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? { ok: true, value: n } : { ok: false };
    }
    case "rating": {
      if (typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue >= 1 && rawValue <= 5) {
        return { ok: true, value: rawValue };
      }
      if (/^★{1,5}$/.test(text)) return { ok: true, value: text.length };
      const n = Number(text);
      return Number.isInteger(n) && n >= 1 && n <= 5 ? { ok: true, value: n } : { ok: false };
    }
    case "checkbox": {
      if (typeof rawValue === "boolean") return { ok: true, value: rawValue };
      const lower = text.toLowerCase();
      if (["true", "1", "yes", "是", "✓", "x"].includes(lower)) return { ok: true, value: true };
      if (["false", "0", "no", "否"].includes(lower)) return { ok: true, value: false };
      return { ok: false };
    }
    case "date": {
      if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue > 0) {
        return { ok: true, value: excelSerialToIsoDate(rawValue) };
      }
      const norm = normalizeDateText(text);
      return norm ? { ok: true, value: norm } : { ok: false };
    }
    case "select": {
      const options = field.options ?? [];
      if (options.length === 0 || options.includes(text)) return { ok: true, value: text };
      return { ok: false };
    }
    case "multi_select": {
      const parts = text
        .split(/[,，;；]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!parts.length) return { ok: false, empty: true };
      const options = field.options ?? [];
      if (options.length > 0 && !parts.every((p) => options.includes(p))) return { ok: false };
      return { ok: true, value: parts };
    }
    case "person": {
      const parsed = REGISTRY.person.parse(text, field, members);
      if (parsed === null || parsed === undefined) return { ok: false };
      return { ok: true, value: parsed };
    }
    default: {
      const parsed = REGISTRY[field.type].parse(text, field, members);
      if (parsed === null || parsed === undefined) return { ok: false };
      return { ok: true, value: parsed };
    }
  }
}

/**
 * Parses the first worksheet of an uploaded `.xlsx` file into Base headers,
 * matched structured cell records (keyed by existing field ID), raw string rows,
 * and non-fatal warnings.
 */
export async function parseXlsxToBaseRows(
  buffer: Uint8Array | ArrayBuffer,
  existingFields: Field[],
  members: User[] = [],
): Promise<ParsedXlsxBaseRows> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength > XLSX_MAX_INPUT_BYTES) {
    throw new Error("Excel 文件不能超过 20 MiB。");
  }
  const parsed = await readXlsx(bytes);
  const warnings: string[] = [];
  const sheet = parsed.workbook.sheets[0];
  if (!sheet || sheet.cells.length === 0) {
    return { headers: [], rows: [], rawRows: [], warnings: ["工作表为空"] };
  }

  let maxRow = 0;
  let maxCol = 0;
  const grid = new Map<string, string | number | boolean>();
  let truncated = false;

  for (const cell of sheet.cells) {
    if (cell.row > MAX_IMPORT_ROWS || cell.col >= MAX_IMPORT_COLS) {
      truncated = true;
      continue;
    }
    let val: string | number | boolean | undefined;
    if (cell.value !== undefined) {
      if (typeof cell.value === "object" && cell.value !== null && "error" in cell.value) {
        val = cell.value.error;
      } else if (typeof cell.value === "number" && numFmtFromCode(cell.style?.numFmt) === "date") {
        val = excelSerialToIsoDate(cell.value);
      } else {
        val = cell.value;
      }
    }
    if (val === undefined) continue;
    grid.set(`${cell.row}:${cell.col}`, val);
    if (cell.row > maxRow) maxRow = cell.row;
    if (cell.col > maxCol) maxCol = cell.col;
  }

  if (truncated) {
    warnings.push(`超出上限（${MAX_IMPORT_ROWS} 行 / ${MAX_IMPORT_COLS} 列）的部分单元格已忽略`);
  }

  const colCount = maxCol + 1;
  const headers: string[] = [];
  for (let c = 0; c < colCount; c++) {
    const raw = grid.get(`0:${c}`);
    const trimmed = raw === undefined ? "" : String(raw).trim();
    headers.push(trimmed || `列${c + 1}`);
  }

  const byExactName = new Map<string, Field>();
  const byLowerName = new Map<string, Field>();
  for (const f of existingFields) {
    byExactName.set(f.name.trim(), f);
    byLowerName.set(f.name.trim().toLowerCase(), f);
  }
  const matchedFields: (Field | undefined)[] = headers.map(
    (h) => byExactName.get(h) ?? byLowerName.get(h.toLowerCase()),
  );

  const rows: Record<string, Cell>[] = [];
  const rawRows: string[][] = [];
  let invalidCellCount = 0;

  for (let r = 1; r <= maxRow; r++) {
    const rawRow: string[] = [];
    const rowCells: Record<string, Cell> = {};
    let hasAnyValue = false;

    for (let c = 0; c < colCount; c++) {
      const cellVal = grid.get(`${r}:${c}`);
      if (cellVal === undefined || (typeof cellVal === "string" && cellVal.trim() === "")) {
        rawRow.push("");
        continue;
      }
      hasAnyValue = true;
      const strVal = typeof cellVal === "boolean" ? (cellVal ? "TRUE" : "FALSE") : String(cellVal);
      rawRow.push(strVal);

      const field = matchedFields[c];
      if (!field) continue;
      const coerced = parseCellForExistingField(cellVal, field, members);
      if (coerced.ok) {
        rowCells[String(field.id)] = coerced.value;
      } else if (!coerced.empty) {
        invalidCellCount++;
      }
    }

    if (!hasAnyValue) continue;
    rawRows.push(rawRow);
    rows.push(rowCells);
  }

  if (invalidCellCount > 0) {
    warnings.push(`有 ${invalidCellCount} 个单元格值与现有字段类型不匹配`);
  }

  return { headers, rows, rawRows, warnings };
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serializes parsed XLSX rows into UTF-8 CSV compatible with `POST /api/bases/:id/import`
 * (`baseApi.importCSV`), automatically skipping existing readonly/derived fields and
 * normalizing multi-select/date formatting so round-trip Excel import succeeds cleanly.
 */
export function xlsxToImportCsv(
  parsed: ParsedXlsxBaseRows,
  existingFields: Field[],
): { csv: string; skippedReadonlyHeaders: string[] } {
  const byName = new Map<string, Field>();
  for (const f of existingFields) {
    byName.set(f.name.trim(), f);
  }

  const keptIndexes: number[] = [];
  const skippedReadonlyHeaders: string[] = [];
  const keptHeaders: string[] = [];
  const keptFields: (Field | undefined)[] = [];

  parsed.headers.forEach((h, idx) => {
    const matched = byName.get(h.trim());
    if (matched && READONLY_OR_DERIVED_TYPES.has(matched.type)) {
      skippedReadonlyHeaders.push(h);
      return;
    }
    keptIndexes.push(idx);
    keptHeaders.push(h);
    keptFields.push(matched);
  });

  if (keptHeaders.length === 0) {
    return { csv: "", skippedReadonlyHeaders };
  }

  const lines: string[] = [keptHeaders.map(escapeCsvCell).join(",")];
  for (const row of parsed.rawRows) {
    const cells = keptIndexes.map((origIdx, k) => {
      let val = row[origIdx] ?? "";
      const f = keptFields[k];
      if (f && val.trim() !== "") {
        if (f.type === "multi_select") {
          val = val
            .split(/[,，;；]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .join(";");
        } else if (f.type === "date") {
          const norm = normalizeDateText(val);
          if (norm) val = norm.slice(0, 10);
        } else if (f.type === "rating" && /^★{1,5}$/.test(val.trim())) {
          val = String(val.trim().length);
        }
      }
      return escapeCsvCell(val);
    });
    lines.push(cells.join(","));
  }

  return { csv: lines.join("\n"), skippedReadonlyHeaders };
}

/** Triggers a browser download for a generated `.xlsx` Uint8Array. */
export function downloadXlsxBytes(bytes: Uint8Array, fileName: string): void {
  const safeName = fileName.replace(/[\\/:*?"<>|]+/g, "_").trim() || "base-export.xlsx";
  const finalName = safeName.toLowerCase().endsWith(".xlsx") ? safeName : `${safeName}.xlsx`;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = finalName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

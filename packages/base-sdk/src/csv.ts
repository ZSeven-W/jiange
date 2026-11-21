/**
 * RFC 4180 CSV & TSV serializer and parser with schema type inference for `@jiange/base-sdk`.
 */

import { formatCellText } from "./query.js";
import type { BaseCell, BaseField, BaseRecord, FieldType } from "./types.js";

function escapeCsvCell(text: string, delimiter: string): string {
  if (text.includes(delimiter) || text.includes('"') || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Serialize fields and records into RFC 4180 CSV (or TSV with delimiter = "\t"). */
export function exportTableToCsv(
  fields: readonly BaseField[],
  records: readonly BaseRecord[],
  delimiter = ",",
): string {
  const ordered = [...fields].sort((a, b) => a.position - b.position || a.id - b.id);
  const lines: string[] = [ordered.map((f) => escapeCsvCell(f.name, delimiter)).join(delimiter)];
  for (const rec of records) {
    lines.push(ordered.map((f) => escapeCsvCell(formatCellText(rec.cells[String(f.id)]), delimiter)).join(delimiter));
  }
  return lines.join("\n");
}

/** Parse RFC 4180 CSV/TSV text into a 2D string matrix. */
export function parseDelimitedRows(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((v) => v !== "")) rows.push(row);
  }
  return rows;
}

export interface InferredCsvTable {
  fields: Array<{ name: string; type: FieldType; isPrimary?: boolean }>;
  rows: Array<Record<string, BaseCell>>;
}

function inferColumnType(samples: string[]): FieldType {
  const nonEmpty = samples.map((s) => s.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return "text";
  if (nonEmpty.every((s) => /^(true|false)$/i.test(s))) return "checkbox";
  if (nonEmpty.every((s) => /^-?\d+(?:\.\d+)?$/.test(s))) return "number";
  if (nonEmpty.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))) return "date";
  return "text";
}

function coerceCell(raw: string, type: FieldType): BaseCell {
  const trimmed = raw.trim();
  if (type === "number") {
    const n = Number(trimmed);
    return Number.isFinite(n) && trimmed !== "" ? n : trimmed;
  }
  if (type === "checkbox") {
    return trimmed.toLowerCase() === "true";
  }
  return raw;
}

/** Parse CSV/TSV with header row and infer field types for importing into a Base table. */
export function parseCsvToTableData(csvText: string, delimiter = ","): InferredCsvTable {
  const matrix = parseDelimitedRows(csvText, delimiter);
  if (matrix.length === 0) return { fields: [], rows: [] };
  const headers = matrix[0].map((h, idx) => h.trim() || `Field ${idx + 1}`);
  const dataRows = matrix.slice(1);

  const fields = headers.map((name, colIdx) => {
    const colSamples = dataRows.map((r) => r[colIdx] ?? "");
    return {
      name,
      type: colIdx === 0 ? ("text" as FieldType) : inferColumnType(colSamples),
      ...(colIdx === 0 ? { isPrimary: true } : {}),
    };
  });

  const rows = dataRows.map((r) => {
    const obj: Record<string, BaseCell> = {};
    fields.forEach((f, idx) => {
      const raw = r[idx] ?? "";
      if (raw !== "") obj[f.name] = coerceCell(raw, f.type);
    });
    return obj;
  });

  return { fields, rows };
}

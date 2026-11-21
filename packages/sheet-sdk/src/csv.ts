/**
 * RFC 4180 CSV parser and formatter (zero external dependencies).
 * Supports quoted fields, doubled quotes (`""`), embedded commas/newlines,
 * CRLF and LF line endings, and optional custom delimiter.
 */

export interface CsvOptions {
  delimiter?: string;
  lineEnding?: "\n" | "\r\n";
}

export function parseCsv(text: string, options: CsvOptions = {}): string[][] {
  if (!text) return [];
  const delim = options.delimiter ?? ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i++;
    } else if (ch === delim) {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function formatCsv(rows: readonly (readonly string[])[], options: CsvOptions = {}): string {
  const delim = options.delimiter ?? ",";
  const eol = options.lineEnding ?? "\n";
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = cell ?? "";
          if (s.includes('"') || s.includes(delim) || s.includes("\n") || s.includes("\r")) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        })
        .join(delim),
    )
    .join(eol);
}

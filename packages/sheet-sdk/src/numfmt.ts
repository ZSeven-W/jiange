import type { EvalValue, SheetCellStyle } from "./types.js";

/** Excel 1900 epoch (with Lotus 1-2-3 leap-year offset matching Sheets/Excel). */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

export function dateToSerial(date: Date): number {
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());
  return (utc - EXCEL_EPOCH_MS) / MS_PER_DAY;
}

export function serialToDate(serial: number): Date {
  return new Date(EXCEL_EPOCH_MS + Math.round(serial * MS_PER_DAY));
}

/** Parse strict ISO dates (`YYYY-MM-DD` / `YYYY/MM/DD` / ISO datetime) to Excel serial number. */
export function parseDateToSerial(raw: string): number | null {
  const s = raw.trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!iso) return null;
  const y = Number(iso[1]);
  const m = Number(iso[2]);
  const d = Number(iso[3]);
  const hh = iso[4] ? Number(iso[4]) : 0;
  const mm = iso[5] ? Number(iso[5]) : 0;
  const ss = iso[6] ? Number(iso[6]) : 0;
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return dateToSerial(dt);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatDateCode(serial: number, code: string): string {
  const dt = serialToDate(serial);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  const hh = dt.getUTCHours();
  const mm = dt.getUTCMinutes();
  const ss = dt.getUTCSeconds();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthFull = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const lower = code.toLowerCase();
  const hasAmPm = lower.includes("am/pm");
  const h12 = hh % 12 || 12;

  // Replace longest date/time tokens outside literal quotes.
  let out = "";
  let i = 0;
  let seenHour = false;
  while (i < code.length) {
    if (code[i] === '"') {
      const end = code.indexOf('"', i + 1);
      if (end < 0) { out += code.slice(i + 1); break; }
      out += code.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (code[i] === "\\") {
      if (i + 1 < code.length) out += code[i + 1];
      i += 2;
      continue;
    }
    const rest = lower.slice(i);
    if (rest.startsWith("am/pm")) { out += hh >= 12 ? "PM" : "AM"; i += 5; continue; }
    if (rest.startsWith("yyyy")) { out += String(y).padStart(4, "0"); i += 4; continue; }
    if (rest.startsWith("yy")) { out += pad2(y % 100); i += 2; continue; }
    if (rest.startsWith("mmmm")) { out += monthFull[m - 1]; i += 4; continue; }
    if (rest.startsWith("mmm")) { out += monthNames[m - 1]; i += 3; continue; }
    if (rest.startsWith("mm")) {
      const nextIsSec = /^mm\s*:?\s*s/i.test(rest);
      out += seenHour || nextIsSec ? pad2(mm) : pad2(m);
      i += 2;
      continue;
    }
    if (rest[0] === "m") { out += seenHour ? String(mm) : String(m); i += 1; continue; }
    if (rest.startsWith("dd")) { out += pad2(d); i += 2; continue; }
    if (rest[0] === "d") { out += String(d); i += 1; continue; }
    if (rest.startsWith("hh")) { seenHour = true; out += pad2(hasAmPm ? h12 : hh); i += 2; continue; }
    if (rest[0] === "h") { seenHour = true; out += String(hasAmPm ? h12 : hh); i += 1; continue; }
    if (rest.startsWith("ss")) { out += pad2(ss); i += 2; continue; }
    if (rest[0] === "s") { out += String(ss); i += 1; continue; }
    out += code[i++];
  }
  return out;
}

function formatNumberSection(val: number, section: string): string {
  // Strip color/locale tags like [Red] or [$-409].
  const cleaned = section.replace(/\[[^\]]*\]/g, "");
  // Extract quoted literal prefix/suffix or currency symbols.
  const withoutLiterals = cleaned.replace(/"[^"]*"|\\./g, "");
  if (/[yd]/i.test(withoutLiterals) || /m{1,4}[/-]|[/-]m{1,4}/i.test(withoutLiterals) || /h:m/i.test(withoutLiterals)) {
    return formatDateCode(val, cleaned);
  }
  if (/e[+-]0+/i.test(withoutLiterals)) {
    const decMatch = /\.([0#]+)/.exec(withoutLiterals);
    const digits = decMatch ? decMatch[1].length : 2;
    return val.toExponential(digits).toUpperCase();
  }
  const isPercent = withoutLiterals.includes("%");
  const scaled = isPercent ? val * 100 : val;
  const hasComma = withoutLiterals.includes(",");
  const decMatch = /\.([0#?]+)/.exec(withoutLiterals);
  const maxFrac = decMatch ? decMatch[1].length : 0;
  const minFrac = decMatch ? (decMatch[1].match(/0/g)?.length ?? 0) : 0;

  const formattedNum = hasComma
    ? scaled.toLocaleString("en-US", { minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac })
    : maxFrac > 0
      ? scaled.toFixed(maxFrac).replace(new RegExp(`(\\.\\d{${minFrac}}?)0+$`), (_, keep: string) => (keep.endsWith(".") ? "" : keep))
      : String(Math.round(scaled));

  // Preserve leading/trailing literal symbols (e.g. "$", "¥", "%", parentheses).
  const numTokenIdx = cleaned.search(/[0#?]/);
  if (numTokenIdx < 0) return cleaned.replace(/"/g, "");
  const lastNumIdx = Math.max(cleaned.lastIndexOf("0"), cleaned.lastIndexOf("#"), cleaned.lastIndexOf("?"));
  const prefix = cleaned.slice(0, numTokenIdx).replace(/"/g, "").replace(/\\(.)/g, "$1");
  const suffix = cleaned.slice(lastNumIdx + 1).replace(/"/g, "").replace(/\\(.)/g, "$1");
  return `${prefix}${formattedNum}${suffix}`;
}

/** Format a numeric value with either a Jiange semantic preset or an Excel format code. */
export function formatExcelNumber(val: number, fmt: string): string {
  if (!fmt || fmt.toLowerCase() === "general") return String(val);
  if (fmt === "currency") return `¥${val.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (fmt === "percent") return `${(val * 100).toFixed(1).replace(/\.0$/, "")}%`;
  if (fmt === "decimal2") return val.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (fmt === "decimal1") return val.toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (fmt === "integer") return Math.round(val).toLocaleString("zh-CN");
  if (fmt === "date" && val > 0 && val < 2958466) {
    return serialToDate(Math.round(val)).toISOString().slice(0, 10);
  }
  if (fmt === "@") return String(val);

  // Split sections (positive;negative;zero;text) outside quotes.
  const sections: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '"') inQ = !inQ;
    if (ch === ";" && !inQ) { sections.push(cur); cur = ""; continue; }
    cur += ch;
  }
  sections.push(cur);

  if (val < 0 && sections[1]) return formatNumberSection(Math.abs(val), sections[1]);
  if (val === 0 && sections[2]) return formatNumberSection(0, sections[2]);
  return formatNumberSection(val, sections[0]);
}

/** Format a cell's raw text + evaluated result + style into a display string. */
export function formatCellDisplay(raw: string, evalVal: EvalValue | undefined, style?: SheetCellStyle): string {
  if (!raw && (!evalVal || evalVal.kind === "empty")) return "";
  if (evalVal?.kind === "error") return evalVal.error;
  if (evalVal?.kind === "array") {
    const first = evalVal.value[0]?.[0];
    return first ? formatCellDisplay("", first, style) : "";
  }
  const val =
    evalVal?.kind === "boolean"
      ? evalVal.value ? "TRUE" : "FALSE"
      : evalVal?.kind === "number"
        ? evalVal.value
        : raw.startsWith("=")
          ? String(evalVal?.value ?? "")
          : raw;
  const fmt = style?.numFmt ?? "";
  if (typeof val === "number") {
    return formatExcelNumber(val, fmt);
  }
  if (fmt === "date" && typeof val === "string") {
    const ts = Date.parse(val);
    if (Number.isFinite(ts)) return new Date(ts).toISOString().slice(0, 10);
  }
  return String(val);
}

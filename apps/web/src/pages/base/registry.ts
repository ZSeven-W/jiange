import type { AttachmentRef, BaseRecord, Cell, Field, FieldType, User } from "@/lib/api";

export type CellValue = Cell | undefined;

/**
 * The field type registry: one entry per type, owning validation-ish parsing
 * (TSV paste), encoding (TSV copy), sort comparison and column metadata.
 * Rendering/editors live in cells.tsx and key off the same definitions.
 */
export interface FieldTypeDef {
  icon: string;
  label: string;
  width: number;
  /** computed from record metadata — never editable */
  readonly?: boolean;
  /** the options list configures this type */
  hasOptions?: boolean;
  /** plain text → cell value (undefined = cannot paste, null = clear) */
  parse(text: string, f: Field): Cell | null | undefined;
  /** cell value → plain text (copy, filter) */
  format(v: CellValue, f: Field): string;
  /** order two non-empty values (empty cells sort last in view()) */
  compare(a: Cell, b: Cell, f: Field): number;
}

const zh = "zh-CN";

function optIndex(options: string[], v: unknown): number {
  const i = options.indexOf(String(v));
  return i === -1 ? options.length : i;
}

export const REGISTRY: Record<FieldType, FieldTypeDef> = {
  text: {
    icon: "Aa",
    label: "文本",
    width: 240,
    parse: (t) => (t === "" ? null : t),
    format: (v) => (v === undefined ? "" : String(v)),
    compare: (a, b) => String(a).localeCompare(String(b), zh),
  },
  number: {
    icon: "#",
    label: "数字",
    width: 120,
    parse: (t) => {
      if (t.trim() === "") return null;
      const n = Number(t);
      return Number.isNaN(n) ? undefined : n;
    },
    format: (v) => (typeof v === "number" ? String(v) : v === undefined ? "" : String(v)),
    compare: (a, b) => Number(a) - Number(b),
  },
  select: {
    icon: "◉",
    label: "单选",
    width: 130,
    hasOptions: true,
    parse: (t, f) => (t === "" ? null : (f.options ?? []).includes(t) ? t : undefined),
    format: (v) => String(v ?? ""),
    compare: (a, b, f) => optIndex(f.options ?? [], a) - optIndex(f.options ?? [], b),
  },
  multi_select: {
    icon: "◎",
    label: "多选",
    width: 200,
    hasOptions: true,
    parse: (t, f) => {
      if (t === "") return null;
      const parts = t.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      return parts.every((p) => (f.options ?? []).includes(p)) ? parts : undefined;
    },
    format: (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(",") : String(v ?? "")),
    compare: (a, b, f) => {
      const first = (v: Cell) => (Array.isArray(v) && typeof v[0] === "string" ? optIndex(f.options ?? [], v[0]) : (f.options ?? []).length);
      return first(a) - first(b);
    },
  },
  checkbox: {
    icon: "☑",
    label: "复选框",
    width: 80,
    parse: (t) => {
      const s = t.trim().toLowerCase();
      if (s === "") return null;
      if (["true", "1", "yes", "是", "✓", "x"].includes(s)) return true;
      if (["false", "0", "no", "否"].includes(s)) return null;
      return undefined;
    },
    format: (v) => (v === true ? "TRUE" : v === false ? "FALSE" : ""),
    compare: (a, b) => Number(a === true) - Number(b === true),
  },
  date: {
    icon: "▣",
    label: "日期",
    width: 140,
    parse: (t) => (/^\d{4}-\d{2}-\d{2}$/.test(t.trim()) ? t.trim() : t === "" ? null : undefined),
    format: (v) => String(v ?? ""),
    compare: (a, b) => String(a).localeCompare(String(b)),
  },
  person: {
    icon: "☺",
    label: "人员",
    width: 140,
    parse: () => undefined, // no textual round-trip for member ids
    format: (v) => String(v ?? ""),
    compare: (a, b) => Number(a) - Number(b),
  },
  attachment: {
    icon: "🗜",
    label: "附件",
    width: 260,
    readonly: false,
    parse: () => undefined,
    format: (v) => (Array.isArray(v) ? String(v.length) : ""),
    compare: (a, b) => (Array.isArray(a) ? a.length : 0) - (Array.isArray(b) ? b.length : 0),
  },
  created_by: {
    icon: "☺",
    label: "创建人",
    width: 140,
    readonly: true,
    parse: () => undefined,
    format: (v) => String(v ?? ""),
    compare: (a, b) => Number(a) - Number(b),
  },
  created_at: {
    icon: "⏱",
    label: "创建时间",
    width: 180,
    readonly: true,
    parse: () => undefined,
    format: (v) => String(v ?? ""),
    compare: (a, b) => String(a).localeCompare(String(b)),
  },
  modified_at: {
    icon: "✎",
    label: "修改时间",
    width: 180,
    readonly: true,
    parse: () => undefined,
    format: (v) => String(v ?? ""),
    compare: (a, b) => String(a).localeCompare(String(b)),
  },
};

export const FIELD_TYPES = Object.keys(REGISTRY) as FieldType[];

/** Feishu-style preset tag palette: [background, text]. */
export const PALETTE: [string, string][] = [
  ["#E1EAFF", "#245BDB"],
  ["#D9F5D6", "#237B19"],
  ["#FEEAD2", "#B24D00"],
  ["#F8DEF8", "#9F2BA6"],
  ["#F2F3F5", "#646A73"],
  ["#FFF4C9", "#7A6400"],
  ["#FBDC8D", "#8C4A00"],
  ["#FDEBE1", "#A85114"],
  ["#EFF1F4", "#3B7FBB"],
  ["#E8F7E8", "#177E17"],
];

/** (bg, fg) for a select value: explicit palette index, else stable fallback. */
export function optionColor(f: Field, value: string): [string, string] {
  const i = (f.options ?? []).indexOf(value);
  const c = i >= 0 ? f.optionColors?.[i] : undefined;
  if (c !== undefined && c >= 0 && c < PALETTE.length) return PALETTE[c];
  return PALETTE[Math.max(0, i) % PALETTE.length];
}

/** Cell value for display: computed types read from record metadata. */
export function displayValue(rec: BaseRecord | undefined, f: Field, members: User[]): CellValue {
  switch (f.type) {
    case "created_by":
      return rec?.creatorId;
    case "created_at":
      return rec?.createdAt;
    case "modified_at":
      return rec?.updatedAt;
    default:
      return rec?.cells[f.id];
  }
}

export function memberName(id: number | undefined, members: User[]): string {
  return members.find((m) => m.id === id)?.name ?? "";
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function isAttachmentArray(v: CellValue): v is AttachmentRef[] {
  return Array.isArray(v) && (v.length === 0 || typeof v[0] === "object");
}

export function isStringArray(v: CellValue): v is string[] {
  return Array.isArray(v) && (v.length === 0 || typeof v[0] === "string");
}

import type { AttachmentRef, BaseRecord, Cell, Field, FieldType, User } from "@/lib/api";

export type CellValue = Cell | undefined;

/**
 * The field type registry: one entry per type, owning validation-ish parsing
 * (TSV paste), encoding (TSV copy), sort comparison and column metadata.
 * Rendering/editors live in cells.tsx and key off the same definitions.
 */
export interface FieldTypeDef {
  icon: string | React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
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
    icon: LetterText,
    label: "文本",
    width: 240,
    parse: (t) => (t === "" ? null : t),
    format: (v) => (v === undefined ? "" : String(v)),
    compare: (a, b) => String(a).localeCompare(String(b), zh),
  },
  number: {
    icon: Hash,
    label: "数字",
    width: 180,
    parse: (t) => {
      if (t.trim() === "") return null;
      const n = Number(t);
      return Number.isNaN(n) ? undefined : n;
    },
    format: (v) => (typeof v === "number" ? String(v) : v === undefined ? "" : String(v)),
    compare: (a, b) => Number(a) - Number(b),
  },
  select: {
    icon: CircleChevronDown,
    label: "单选",
    width: 180,
    hasOptions: true,
    parse: (t, f) => (t === "" ? null : (f.options ?? []).includes(t) ? t : undefined),
    format: (v) => String(v ?? ""),
    compare: (a, b, f) => optIndex(f.options ?? [], a) - optIndex(f.options ?? [], b),
  },
  multi_select: {
    icon: CircleEllipsis,
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
    icon: SquareCheck,
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
    icon: CalendarDays,
    label: "日期",
    width: 180,
    parse: (t) => (/^\d{4}-\d{2}-\d{2}$/.test(t.trim()) ? t.trim() : t === "" ? null : undefined),
    format: (v) => String(v ?? ""),
    compare: (a, b) => String(a).localeCompare(String(b)),
  },
  person: {
    icon: UserIcon,
    label: "人员",
    width: 140,
    parse: () => undefined, // no textual round-trip for member ids
    format: (v) => String(v ?? ""),
    compare: (a, b) => Number(a) - Number(b),
  },
  attachment: {
    icon: Paperclip,
    label: "附件",
    width: 260,
    readonly: false,
    parse: () => undefined,
    format: (v) => (Array.isArray(v) ? String(v.length) : ""),
    compare: (a, b) => (Array.isArray(a) ? a.length : 0) - (Array.isArray(b) ? b.length : 0),
  },
  created_by: {
    icon: UserIcon,
    label: "创建人",
    width: 140,
    readonly: true,
    parse: () => undefined,
    format: (v) => String(v ?? ""),
    compare: (a, b) => Number(a) - Number(b),
  },
  created_at: {
    icon: Clock3,
    label: "创建时间",
    width: 180,
    readonly: true,
    parse: () => undefined,
    format: (v) => String(v ?? ""),
    compare: (a, b) => String(a).localeCompare(String(b)),
  },
  modified_at: {
    icon: PenLine,
    label: "修改时间",
    width: 180,
    readonly: true,
    parse: () => undefined,
    format: (v) => String(v ?? ""),
    compare: (a, b) => String(a).localeCompare(String(b)),
  },
  url: {
    icon: Link2,
    label: "超链接",
    width: 220,
    parse: (t) => (/^https?:\/\/\S+$/.test(t.trim()) ? t.trim() : t === "" ? null : undefined),
    format: (v) => String(v ?? ""),
    compare: (a, b) => String(a).localeCompare(String(b)),
  },
  phone: {
    icon: Phone,
    label: "电话",
    width: 160,
    parse: (t) => (/^[\d+\- ]{5,24}$/.test(t.trim()) ? t.trim() : t === "" ? null : undefined),
    format: (v) => String(v ?? ""),
    compare: (a, b) => String(a).localeCompare(String(b)),
  },
  email: {
    icon: Mail,
    label: "邮箱",
    width: 200,
    parse: (t) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.trim()) ? t.trim() : t === "" ? null : undefined),
    format: (v) => String(v ?? ""),
    compare: (a, b) => String(a).localeCompare(String(b)),
  },
  rating: {
    icon: Star,
    label: "评分",
    width: 110,
    parse: (t) => {
      const n = Number(t);
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : t === "" ? null : undefined;
    },
    format: (v) => (typeof v === "number" ? "★".repeat(v) : ""),
    compare: (a, b) => Number(a) - Number(b),
  },
  formula: {
    icon: FunctionSquare,
    label: "公式",
    width: 160,
    readonly: true,
    parse: () => undefined,
    format: (v) => String(v ?? ""),
    compare: (a, b) => {
      if (typeof a === "number" && typeof b === "number") return a - b;
      return String(a).localeCompare(String(b));
    },
  },
  link: {
    icon: ArrowLeftRight,
    label: "关联",
    width: 200,
    parse: () => undefined, // 由 bt_links 存储，编辑走 link 选择器
    format: (v) => (Array.isArray(v) ? String(v.length) : ""),
    compare: (a, b) => (Array.isArray(a) ? a.length : 0) - (Array.isArray(b) ? b.length : 0),
  },
  lookup: {
    icon: Search,
    label: "查找引用",
    width: 180,
    readonly: true,
    parse: () => undefined,
    format: (v) => (Array.isArray(v) ? v.map((x) => String(x)).join(",") : String(v ?? "")),
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

/** Cell value for display: computed types read from record metadata; formula
 * types read the memoized dependency-graph evaluation (setFormulaCache). */
const formulaCache = new WeakMap<BaseRecord, Map<number, FormulaValue>>();

export function setFormulaCache(rec: BaseRecord, values: Map<number, FormulaValue>) {
  formulaCache.set(rec, values);
}

/** The primary field is stable even when the visible field set changes. */
export function recordTitleField(fields: readonly Field[]): Field | undefined {
  const primary = fields.find((field) => field.isPrimary);
  if (primary) return primary;
  // The new server explicitly includes false for every non-primary field.
  // If no true marker is visible, the primary is outside this projection;
  // do not present a different visible field as its title. An old server has
  // no marker at all and retains its legacy first-text behavior.
  if (fields.some((field) => typeof field.isPrimary === "boolean")) return undefined;
  return fields.find((field) => field.type === "text") ?? fields[0];
}

export function displayValue(rec: BaseRecord | undefined, f: Field | undefined, members: User[]): CellValue {
  if (!rec || !f) return undefined;
  switch (f.type) {
    case "created_by":
      return rec.creatorId;
    case "created_at":
      return rec.createdAt;
    case "modified_at":
      return rec.updatedAt;
    case "formula":
      return formulaCache.get(rec)?.get(f.id) ?? undefined;
    default:
      return rec.cells[f.id];
  }
}

export function memberName(id: number | undefined, members: User[]): string {
  return members.find((m) => m.id === id)?.name ?? "";
}

/** Format the visible record title from the authorized primary field. */
export function recordTitle(record: BaseRecord | undefined, fields: Field[], members: User[]): string {
  const field = recordTitleField(fields);
  if (!field || !record) return "";
  let value: CellValue | null;
  try {
    if (field.type === "formula") {
      // Do not calculate a misleading value when a direct or transitive
      // dependency is absent from the caller's authorized projection.
      const byName = new Map(fields.map((item) => [item.name.toLowerCase(), item]));
      const checked = new Set<number>();
      const visible = (item: Field): boolean => {
        if (checked.has(item.id)) return true; // evalFormulas reports cycles.
        checked.add(item.id);
        for (const name of formulaRefs(item.formula ?? "")) {
          const dependency = byName.get(name.toLowerCase());
          if (!dependency || (dependency.type === "formula" && !visible(dependency))) return false;
        }
        return true;
      };
      if (!visible(field)) return "";
      value = evalFormulas(fields, record, members).get(field.id);
    } else value = displayValue(record, field, members);
  }
  catch { return "#错误"; }
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "person" || field.type === "created_by") return memberName(typeof value === "number" ? value : undefined, members);
  if (field.type === "created_at" || field.type === "modified_at") return formatTime(typeof value === "string" ? value : undefined);
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : typeof item === "object" && item && "name" in item ? String(item.name) : "").filter(Boolean).join(", ");
  return String(value);
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

/**
 * 公式字段的依赖图求值：按拓扑序对每个 formula 字段求值（值来自 record 的
 * 其它字段或先前求出的公式值）；环引用与求值错误返回 "#…" 标记字符串。
 */
export function evalFormulas(fields: Field[], rec: BaseRecord, members: User[]): Map<number, FormulaValue> {
  const out = new Map<number, FormulaValue>();
  const byName = new Map<string, Field>();
  for (const f of fields) byName.set(f.name.toLowerCase(), f);
  const formulas = fields.filter((f) => f.type === "formula" && f.formula);
  const deps = new Map<number, string[]>(); // field id -> referenced field ids
  for (const f of formulas) {
    const ids: string[] = [];
    for (const name of formulaRefs(f.formula!)) {
      const target = byName.get(name.toLowerCase());
      ids.push(target ? String(target.id) : "?");
    }
    deps.set(f.id, ids);
  }
  const state = new Map<number, 0 | 1 | 2>(); // 0 visiting, 1 done
  const env: FormulaEnv = {
    get: (name) => {
      const f = byName.get(name.toLowerCase());
      if (!f) return null;
      if (f.type === "formula") return out.get(f.id) ?? null;
      return displayRaw(rec, f, members);
    },
  };
  const visit = (f: Field): FormulaValue => {
    if (out.has(f.id)) return out.get(f.id)!;
    if (state.get(f.id) === 0) {
      out.set(f.id, "#循环引用");
      return "#循环引用";
    }
    state.set(f.id, 0);
    let v: FormulaValue;
    try {
      for (const dep of deps.get(f.id) ?? []) {
        const depField = fields.find((x) => String(x.id) === dep);
        if (depField?.type === "formula" && !out.has(depField.id)) visit(depField);
      }
      v = evalFormula(f.formula!, env);
    } catch (e) {
      v = e instanceof FormulaError ? (e as Error).message : "#错误";
    }
    out.set(f.id, v);
    state.set(f.id, 1);
    return v;
  };
  for (const f of formulas) visit(f);
  return out;
}

/** 原始单元格值（computed 类型照旧读 record 元数据）。 */
function displayRaw(rec: BaseRecord, f: Field, members: User[]): FormulaValue {
  switch (f.type) {
    case "created_by":
      return rec.creatorId ?? null;
    case "created_at":
      return rec.createdAt ?? null;
    case "modified_at":
      return rec.updatedAt ?? null;
    default: {
      const v = rec.cells[f.id];
      if (v === undefined) return null;
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
      return null; // arrays not usable in formulas
    }
  }
}

import { evalFormula, FormulaError, formulaRefs, type FormulaEnv, type FormulaValue } from "./formula";
import { ArrowLeftRight, CalendarDays, CircleChevronDown, CircleEllipsis, Clock3, FunctionSquare, Hash, Link2, Mail, Paperclip, PenLine, Phone, Search, SquareCheck, Star, LetterText, User as UserIcon } from "lucide-react";

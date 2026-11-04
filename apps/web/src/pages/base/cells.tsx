import { useState } from "react";
import type { Cell, Field, FieldType } from "@/lib/api";
import { cn } from "@/lib/utils";

export const TYPE_ICON: Record<FieldType, string> = { text: "Aa", number: "#", select: "◉", checkbox: "☑", date: "▣" };
export const TYPE_LABEL: Record<FieldType, string> = { text: "文本", number: "数字", select: "单选", checkbox: "复选框", date: "日期" };
export const TAG_COLORS = [
  ["#E1EAFF", "#245BDB"],
  ["#D9F5D6", "#237B19"],
  ["#FEEAD2", "#B24D00"],
  ["#F8DEF8", "#9F2BA6"],
  ["#F2F3F5", "#646A73"],
];
export const W: Record<FieldType, number> = { text: 240, number: 120, select: 130, checkbox: 80, date: 140 };

export function Tag({ field, value }: { field: Field; value: string }) {
  const [bg, fg] = TAG_COLORS[Math.max(0, (field.options ?? []).indexOf(value)) % TAG_COLORS.length];
  return (
    <span className="rounded px-2 py-0.5 text-[12px] font-medium" style={{ background: bg, color: fg }}>
      {value}
    </span>
  );
}

export function CellView({ field, value, onToggle }: { field: Field; value: Cell | undefined; onToggle?: (v: boolean | null) => void }) {
  if (field.type === "checkbox")
    return (
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={value === true}
        disabled={!onToggle}
        onChange={(e) => onToggle?.(e.target.checked ? true : null)}
        aria-label={field.name}
      />
    );
  if (value === undefined || value === "") return null;
  if (field.type === "select") return <Tag field={field} value={String(value)} />;
  return <span className="block truncate">{String(value)}</span>;
}

/** dir tells the grid where to move next: "down" (Enter), "right" (Tab), undefined (blur). */
export function CellEditor({
  field,
  value,
  seed,
  onCommit,
  onCancel,
}: {
  field: Field;
  value: Cell | undefined;
  seed?: string;
  onCommit: (v: Cell | null, dir?: "down" | "right") => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(seed ?? (value === undefined ? "" : String(value)));
  if (field.type === "select")
    return (
      <select autoFocus className="w-full bg-transparent outline-none" value={v} onChange={(e) => onCommit(e.target.value || null)} onBlur={onCancel}>
        <option value="">—</option>
        {(field.options ?? []).map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  const commit = (dir?: "down" | "right") => {
    if (field.type === "number") {
      const n = Number(v);
      return onCommit(v.trim() === "" || Number.isNaN(n) ? null : n, dir);
    }
    onCommit(v === "" ? null : v, dir);
  };
  return (
    <input
      autoFocus
      type={field.type === "date" ? "date" : "text"}
      inputMode={field.type === "number" ? "decimal" : undefined}
      className={cn("w-full bg-transparent outline-none", field.type === "number" && "text-right")}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit("down");
        }
        if (e.key === "Tab") {
          e.preventDefault();
          commit("right");
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

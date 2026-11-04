import { useEffect, useRef, useState } from "react";
import type { Field, FieldType } from "@/lib/api";
import { TYPE_ICON, TYPE_LABEL } from "./cells";

/** Shared form for creating and editing a field. */
export function FieldForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: Field;
  onSubmit: (f: Partial<Field>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<FieldType>(initial?.type ?? "text");
  const [opts, setOpts] = useState((initial?.options ?? []).join(", "));
  const typeChanged = initial !== undefined && initial.type !== type;
  return (
    <form
      className="absolute right-0 top-10 z-20 w-64 space-y-2 rounded-lg border bg-white p-3 text-left text-[13px] font-normal text-foreground shadow-lg"
      data-field-form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name: name.trim() || initial?.name || "新字段", type, options: type === "select" ? opts.split(/[,，\s]+/).filter(Boolean) : undefined });
        onCancel();
      }}
    >
      <input autoFocus={!initial} value={name} onChange={(e) => setName(e.target.value)} placeholder="字段名称" className="h-8 w-full rounded-md border px-2 outline-none focus:border-primary" />
      <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className="h-8 w-full rounded-md border bg-white px-2" data-field-type>
        {(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => (
          <option key={t} value={t}>
            {TYPE_ICON[t]} {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      {type === "select" && <input value={opts} onChange={(e) => setOpts(e.target.value)} placeholder="选项，用逗号分隔" className="h-8 w-full rounded-md border px-2 outline-none focus:border-primary" />}
      {typeChanged && <p className="text-[12px] leading-4 text-amber-600">切换类型会自动转换兼容的值，不兼容的值将被清空。</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="h-7 rounded-md border px-3">
          取消
        </button>
        <button type="submit" className="h-7 rounded-md bg-primary px-3 text-white">
          确定
        </button>
      </div>
    </form>
  );
}

/** Header dropdown: edit field / delete field. */
export function FieldMenu({ field, onEdit, onDelete }: { field: Field; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button className="hidden rounded px-0.5 text-subtle hover:bg-hover hover:text-foreground group-hover/th:inline" onClick={() => setOpen((v) => !v)} aria-label={`字段菜单 ${field.name}`} data-field-menu>
        ▾
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-20 w-32 rounded-lg border bg-white py-1 text-[13px] font-normal shadow-lg" data-field-menu-pop>
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-hover"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            编辑字段
          </button>
          <button
            className="block w-full px-3 py-1.5 text-left text-destructive hover:bg-hover"
            onClick={() => {
              setOpen(false);
              if (confirm(`删除字段「${field.name}」及其所有值？`)) onDelete();
            }}
          >
            删除字段
          </button>
        </div>
      )}
    </div>
  );
}

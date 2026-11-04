import { useEffect, useRef, useState } from "react";
import type { Field, FieldType } from "@/lib/api";
import { FIELD_TYPES, PALETTE, REGISTRY } from "./registry";
import { cn } from "@/lib/utils";
import { ask } from "@/components/ui/ask";

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
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [formula, setFormula] = useState(initial?.formula ?? "");
  const [colors, setColors] = useState<number[]>(initial?.optionColors ?? []);
  const def = REGISTRY[type];
  const typeChanged = initial !== undefined && initial.type !== type;
  const names = opts.split(/[,，\n]+/).map((x) => x.trim()).filter(Boolean);
  const setColor = (i: number, c: number) =>
    setColors((prev) => {
      const next = [...prev];
      while (next.length <= i) next.push(-1);
      next[i] = c;
      return next;
    });
  return (
    <form
      className="absolute right-0 top-10 z-20 w-64 space-y-2 rounded-lg border bg-surface p-3 text-left text-[13px] font-normal text-foreground shadow-lg"
      data-field-form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          name: name.trim() || initial?.name || "新字段",
          type,
          description: desc.trim(),
          formula: type === "formula" ? formula.trim() : undefined,
          options: def.hasOptions ? names : undefined,
          optionColors: def.hasOptions ? colors.slice(0, names.length) : undefined,
        });
        onCancel();
      }}
    >
      <input autoFocus={!initial} value={name} onChange={(e) => setName(e.target.value)} placeholder="字段名称" className="h-8 w-full rounded-md border px-2 outline-none focus:border-primary" />
      <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className="h-8 w-full rounded-md border bg-surface px-2" data-field-type>
        {FIELD_TYPES.map((t) => (
          <option key={t} value={t}>
            {REGISTRY[t].icon} {REGISTRY[t].label}
          </option>
        ))}
      </select>
      {def.hasOptions && (
        <div className="space-y-1.5" data-option-editor>
          {names.map((n, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className="w-16 truncate rounded px-1.5 py-0.5 text-[12px] font-medium" style={{ background: PALETTE[(colors[i] ?? -1) >= 0 ? colors[i] : i]?.[0], color: PALETTE[(colors[i] ?? -1) >= 0 ? colors[i] : i]?.[1] }}>
                {n}
              </span>
              <div className="flex flex-wrap gap-0.5">
                {PALETTE.map(([bg, fg], ci) => (
                  <button
                    key={ci}
                    title={`颜色 ${ci + 1}`}
                    className={cn("h-4 w-4 rounded-full border", (colors[i] ?? -1) === ci ? "ring-1 ring-primary ring-offset-1" : "")}
                    style={{ background: bg }}
                    onClick={() => setColor(i, (colors[i] ?? -1) === ci ? -1 : ci)}
                  />
                ))}
              </div>
            </div>
          ))}
          <input value={opts} onChange={(e) => setOpts(e.target.value)} placeholder="新增选项，用逗号分隔" className="h-8 w-full rounded-md border px-2 outline-none focus:border-primary" />
        </div>
      )}
      <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="字段描述（可选）" className="h-8 w-full rounded-md border px-2 outline-none focus:border-primary" data-field-desc />
      {type === "formula" && (
        <textarea
          value={formula}
          onChange={(e) => setFormula(e.target.value)}
          placeholder='公式，如 [数量] * [单价]。引用字段用 [字段名]'
          rows={3}
          className="w-full rounded-md border px-2 py-1 font-mono text-[12px] outline-none focus:border-primary"
          data-field-formula
        />
      )}
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
      <button
        className="hidden rounded px-0.5 text-subtle hover:bg-hover hover:text-foreground group-hover/th:inline"
        onClick={() => setOpen((v) => !v)}
        aria-label={`字段菜单 ${field.name}`}
        data-field-menu
      >
        ▾
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-20 w-32 rounded-lg border bg-surface py-1 text-[13px] font-normal shadow-lg" data-field-menu-pop>
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
            onClick={async () => {
              setOpen(false);
              if (await ask(`删除字段「${field.name}」？`, "字段及其所有值将被删除。")) onDelete();
            }}
          >
            删除字段
          </button>
        </div>
      )}
    </div>
  );
}

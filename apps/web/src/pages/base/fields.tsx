import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Field, FieldType } from "@/lib/api";
import { FIELD_TYPES, PALETTE, REGISTRY } from "./registry";
import { TypeGlyph } from "./cells";
import { cn } from "@/lib/utils";
import { ask } from "@/components/ui/ask";
import { Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import { popupPosition } from "./popupPosition";

/** Shared form for creating and editing a field. */
export function FieldForm({
  initial,
  onSubmit,
  onCancel,
  onAcknowledge,
}: {
  initial?: Field;
  onSubmit: (f: Partial<Field>) => void | Promise<void>;
  onCancel: () => void;
  onAcknowledge?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<FieldType>(initial?.type ?? "text");
  const [opts, setOpts] = useState((initial?.options ?? []).join(", "));
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [formula, setFormula] = useState(initial?.formula ?? "");
  const [colors, setColors] = useState<number[]>(initial?.optionColors ?? []);
  const [typesOpen, setTypesOpen] = useState(false);
  const [typeQuery, setTypeQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof popupPosition> | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const typeButton = useRef<HTMLButtonElement>(null);
  const [typePosition, setTypePosition] = useState<ReturnType<typeof popupPosition> | null>(null);
  const typeMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const place = () => {
      const rect = anchor.current?.closest("th")?.getBoundingClientRect();
      if (!rect) return;
      setPosition(popupPosition(rect, window.innerWidth, window.innerHeight, 322));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, []);
  useEffect(() => {
    if (!typesOpen) return;
    const place = () => {
      const r = typeButton.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.max(1, Math.min(240, window.innerWidth - 32));
      const left = r.right + width + 16 <= window.innerWidth ? r.right + 12 : Math.max(16, r.left - width - 12);
      const top = Math.max(0, Math.min(r.top, window.innerHeight - 160));
      setTypePosition({ left: Math.max(0, Math.min(left, window.innerWidth - width)), top, width, maxHeight: Math.max(1, window.innerHeight - top - 16) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [typesOpen]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (form.current?.contains(target) || typeMenu.current?.contains(target) || anchor.current?.closest("th")?.contains(target)) return;
      if (!saving && !uncertain) onCancel();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (typesOpen) setTypesOpen(false);
      else if (!saving && !uncertain) onCancel();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [onCancel, saving, typesOpen, uncertain]);
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
  return <><span ref={anchor} />{position && createPortal(<form
      ref={form}
      role="dialog"
      aria-label={initial ? "编辑字段" : "添加字段"}
      style={position}
      className="fixed z-[100] max-h-[calc(100vh-32px)] space-y-4 overflow-y-auto rounded-lg border bg-surface p-3 text-left text-[13px] font-normal text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.16)]"
      data-field-form
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape" && !saving) { event.preventDefault(); if (typesOpen) setTypesOpen(false); else if (!uncertain) onCancel(); } }}
      onPaste={(event) => event.stopPropagation()}
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving || uncertain) return;
        setSaving(true); setError("");
        try {
          await onSubmit({ name: name.trim() || initial?.name || "新字段", type, description: desc.trim(), formula: type === "formula" ? formula.trim() : undefined, options: def.hasOptions ? names : undefined, optionColors: def.hasOptions ? colors.slice(0, names.length) : undefined });
          onCancel();
        } catch {
          setError("无法确认字段是否保存。请先刷新或检查字段列表，避免重复创建；输入已保留。");
          setUncertain(true);
        } finally { setSaving(false); }
      }}
    >
      <label className="block space-y-1.5"><span className="text-[12px] text-muted-foreground">标题</span><input autoFocus={!initial} value={name} onChange={(e) => setName(e.target.value)} placeholder="请输入字段标题" className="h-8 w-full rounded-md border bg-surface px-2.5 outline-none focus:border-primary" /></label>
      <div className="space-y-1.5"><span className="text-[12px] text-muted-foreground">字段类型</span><button ref={typeButton} type="button" aria-haspopup="listbox" aria-expanded={typesOpen} onClick={() => setTypesOpen((open) => !open)} className="flex h-9 w-full items-center gap-2 rounded-md border px-2.5 text-left hover:bg-hover" data-field-type><TypeGlyph t={type} size={15} /><span className="flex-1">{REGISTRY[type].label}</span><ChevronRight size={15} className="text-subtle" /></button></div>
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
                    type="button"
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
      <label className="block space-y-1.5"><span className="text-[12px] text-muted-foreground">字段描述（可选）</span><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="添加字段说明" className="h-9 w-full rounded-md border bg-surface px-2.5 outline-none focus:border-primary" data-field-desc /></label>
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
      {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
      {uncertain && <button type="button" className="text-[12px] text-primary underline" onClick={() => { onAcknowledge?.(); setUncertain(false); setError(""); }}>已核对，允许再次提交</button>}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={saving} onClick={onCancel} className="h-8 rounded-md border px-4 hover:bg-hover disabled:opacity-50">
          取消
        </button>
        <button type="submit" disabled={saving || uncertain} className="h-8 rounded-md bg-primary px-4 text-white hover:bg-primary-hover disabled:opacity-50">
          {saving ? "保存中…" : "确定"}
        </button>
      </div>
    </form>, document.body)}{typesOpen && typePosition && createPortal(<div ref={typeMenu} role="listbox" aria-label="字段类型" style={typePosition} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); setTypesOpen(false); typeButton.current?.focus(); } }} onPaste={(event) => event.stopPropagation()} className="fixed z-[101] max-h-[min(590px,calc(100vh-32px))] overflow-y-auto rounded-lg border bg-surface py-1 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.16)]">
      <label className="mx-2 flex h-9 items-center gap-2 border-b px-1 text-subtle"><Search size={15}/><input autoFocus value={typeQuery} onChange={(e) => setTypeQuery(e.target.value)} placeholder="搜索" className="w-full bg-transparent text-foreground outline-none" /></label>
      <div className="px-4 pb-1 pt-3 text-[12px] text-subtle">字段类型</div>
      {FIELD_TYPES.filter((t) => REGISTRY[t].label.includes(typeQuery.trim())).map((t) => <button key={t} type="button" role="option" aria-selected={t === type} onClick={() => { setType(t); setTypesOpen(false); setTypeQuery(""); }} className="flex h-9 w-full items-center gap-2 px-4 text-left hover:bg-hover"><TypeGlyph t={t} size={15}/><span className="flex-1">{REGISTRY[t].label}</span>{t === type && <Check size={14} className="text-primary"/>}</button>)}
    </div>, document.body)}</>;
}

/** Header dropdown: edit field / delete field. */
export function FieldMenu({ field, onEdit, onDelete }: { field: Field; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof popupPosition> | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) setPosition(popupPosition(rect, window.innerWidth, window.innerHeight, 160, 112));
    };
    const close = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    place();
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        ref={trigger}
        type="button"
        className="inline-flex size-8 touch-manipulation items-center justify-center rounded text-subtle opacity-0 hover:bg-hover hover:text-foreground group-hover/th:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={`字段菜单 ${field.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-field-menu
      >
        <ChevronDown size={15} strokeWidth={1.7} />
      </button>
      {open && position && createPortal(
        <div ref={menu} role="menu" style={position} className="fixed z-[101] overflow-y-auto rounded-lg border bg-surface py-1 text-[13px] font-normal shadow-lg" data-field-menu-pop onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); setOpen(false); trigger.current?.focus(); } }} onPaste={(e) => e.stopPropagation()}>
          <button
            type="button"
            role="menuitem"
            className="block min-h-10 w-full px-3 py-1.5 text-left hover:bg-hover"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            编辑字段
          </button>
          {!field.isPrimary && <button
            type="button"
            role="menuitem"
            className="block min-h-10 w-full px-3 py-1.5 text-left text-destructive hover:bg-hover"
            onClick={async () => {
              setOpen(false);
              if (await ask(`删除字段「${field.name}」？`, "字段及其所有值将被删除。")) onDelete();
            }}
          >
            删除字段
          </button>}
        </div>, document.body
      )}
    </div>
  );
}

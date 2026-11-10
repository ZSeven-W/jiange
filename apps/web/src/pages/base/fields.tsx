import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Cell, Field, FieldType, User } from "@/lib/api";
import { FIELD_TYPES, PALETTE, REGISTRY } from "./registry";
import { TypeGlyph } from "./cells";
import { cn } from "@/lib/utils";
import { ask } from "@/components/ui/ask";
import { ArrowDownAZ, ArrowDownZA, ArrowLeftToLine, ArrowRightToLine, EyeOff, Snowflake, Check, ChevronDown, ChevronRight, Copy, Filter, Info, LayoutPanelTop, Pencil, Search, Trash2 } from "lucide-react";
import { popupPosition } from "./popupPosition";
import { Avatar } from "@/components/brand";
import { colorFor } from "@/lib/presence";

/** Shared form for creating and editing a field. */
export function FieldForm({
  initial,
  onSubmit,
  onCancel,
  onAcknowledge,
  members = [],
}: {
  members?: User[];
  initial?: Field;
  onSubmit: (f: Partial<Field>) => void | Promise<void>;
  onCancel: () => void;
  onAcknowledge?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<FieldType>(initial?.type ?? "text");
  const [multi, setMulti] = useState(initial?.multiple ?? false);
  const [opts, setOpts] = useState((initial?.options ?? []).join(", "));
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [formula, setFormula] = useState(initial?.formula ?? "");
  const [colors, setColors] = useState<number[]>(initial?.optionColors ?? []);
  const [dflt, setDflt] = useState<string>(() => {
    const v = initial?.defaultValue;
    return v === undefined || v === null ? "" : typeof v === "boolean" ? (v ? "true" : "") : Array.isArray(v) ? JSON.stringify(v) : String(v);
  });
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
          await onSubmit({ name: name.trim() || initial?.name || "新字段", type, description: desc.trim(), formula: type === "formula" ? formula.trim() : undefined, options: def.hasOptions ? names : undefined, optionColors: def.hasOptions ? colors.slice(0, names.length) : undefined, multiple: type === "person" ? multi : false, defaultValue: defaultCell(type, dflt, names, members) });
          onCancel();
        } catch {
          setError("无法确认字段是否保存。请先刷新或检查字段列表，避免重复创建；输入已保留。");
          setUncertain(true);
        } finally { setSaving(false); }
      }}
    >
      <label className="block space-y-1.5"><span className="text-[12px] text-muted-foreground">标题</span><input autoFocus={!initial} value={name} onChange={(e) => setName(e.target.value)} placeholder="请输入字段标题" className="h-8 w-full rounded-md border bg-surface px-2.5 outline-none focus:border-primary" /></label>
      <div className="space-y-1.5"><span className="text-[12px] text-muted-foreground">字段类型</span><button ref={typeButton} type="button" aria-haspopup="listbox" aria-expanded={typesOpen} onClick={() => setTypesOpen((open) => !open)} className="flex h-9 w-full items-center gap-2 rounded-md border px-2.5 text-left hover:bg-hover" data-field-type><TypeGlyph t={type} size={15} /><span className="flex-1">{REGISTRY[type].label}</span><ChevronRight size={15} className="text-subtle" /></button></div>
      {type === "person" && (
        <label className="flex items-center gap-2 text-[13px]" data-field-multiple>
          <input type="checkbox" className="accent-primary" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
          允许多选
          <span title="开启后每个单元格可包含多个成员；关闭时多出的成员只保留第一个" className="text-subtle"><Info size={12} /></span>
        </label>
      )}
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
      {DEFAULT_KINDS[type] && (
        <div role="group" aria-label="默认值" className="block space-y-1.5" data-field-default>
          <span className="flex items-center gap-1 text-[12px] text-muted-foreground">默认值<span title="新建记录时自动填入，之后可修改" className="text-subtle"><Info size={12} /></span></span>
          {DEFAULT_KINDS[type] === "multi" ? (
            <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5" data-default-multi>
              {names.length === 0 && <span className="text-[12px] text-subtle">先添加选项</span>}
              {names.map((n, i) => {
                const picked = parseMulti(dflt).includes(n);
                const [bg, fg] = PALETTE[(colors[i] ?? -1) >= 0 ? colors[i] : i % PALETTE.length] ?? PALETTE[0];
                return (
                  <button key={n} type="button" aria-pressed={picked} onClick={() => { const cur = parseMulti(dflt); setDflt(JSON.stringify(picked ? cur.filter((x) => x !== n) : names.filter((x) => x === n || cur.includes(x)))); }}
                    className={cn("flex h-6 items-center gap-1 rounded px-1.5 text-[12px] font-medium", picked ? "ring-1 ring-primary" : "opacity-60 hover:opacity-100")} style={{ background: bg, color: fg }}>
                    {picked && <Check size={11} />}{n}
                  </button>
                );
              })}
            </div>
          ) : DEFAULT_KINDS[type] === "person" ? (
            type === "person" && multi ? (
              <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5" data-default-person-multi>
                {members.length === 0 && <span className="text-[12px] text-subtle">没有可选成员</span>}
                {members.map((m) => {
                  const picked = parseMultiIDs(dflt).includes(m.id);
                  return (
                    <button key={m.id} type="button" aria-pressed={picked} onClick={() => { const cur = parseMultiIDs(dflt); const next = picked ? cur.filter((x) => x !== m.id) : members.map((x) => x.id).filter((id) => id === m.id || cur.includes(id)); setDflt(next.length ? JSON.stringify(next) : ""); }}
                      className={cn("flex h-6 items-center gap-1 rounded px-1.5 text-[12px] font-medium", picked ? "bg-accent ring-1 ring-primary" : "bg-hover opacity-60 hover:opacity-100")}>
                      {picked && <Check size={11} />}{m.name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div role="radiogroup" aria-label="默认人员" className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5" data-default-person>
                {[{ id: 0, name: "无" }, ...members, ...(dflt && !dflt.startsWith("[") && !members.some((m) => String(m.id) === dflt) ? [{ id: Number(dflt), name: `成员 #${dflt}` }] : [])].map((m) => {
                  const picked = m.id === 0 ? !dflt : String(m.id) === dflt;
                  return (
                    <button key={m.id} type="button" role="radio" aria-checked={picked} onClick={() => setDflt(m.id === 0 ? "" : String(m.id))}
                      className={cn("flex h-6 items-center gap-1 rounded-full pl-0.5 pr-2 text-[12px]", m.id === 0 && "pl-2", picked ? "bg-accent text-primary ring-1 ring-primary" : "bg-hover text-muted-foreground hover:text-foreground")} data-person-option={m.id}>
                      {m.id !== 0 && <Avatar name={m.name} color={colorFor(m.id - 1)} size={20} />}{m.name}
                    </button>
                  );
                })}
              </div>
            )
          ) : DEFAULT_KINDS[type] === "select" ? (
            <select value={names.includes(dflt) ? dflt : ""} onChange={(e) => setDflt(e.target.value)} className="h-8 w-full rounded-md border bg-surface px-2 outline-none focus:border-primary">
              <option value="">无</option>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          ) : DEFAULT_KINDS[type] === "checkbox" ? (
            <span className="flex h-8 items-center gap-2"><input type="checkbox" className="accent-primary" checked={dflt === "true"} onChange={(e) => setDflt(e.target.checked ? "true" : "")} />默认勾选</span>
          ) : (
            <input type={DEFAULT_KINDS[type]} value={dflt} onChange={(e) => setDflt(e.target.value)} placeholder="请输入默认值" className="h-8 w-full rounded-md border bg-surface px-2.5 outline-none focus:border-primary" />
          )}
        </div>
      )}
      <label className="block space-y-1.5"><span className="text-[12px] text-muted-foreground">字段描述（可选）</span><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="添加字段说明" className="h-9 w-full rounded-md border bg-surface px-2.5 outline-none focus:border-primary" data-field-desc /></label>
      {!initial && (
        <div className="space-y-1.5" data-field-suggest>
          <span className="text-[12px] text-muted-foreground">推荐</span>
          <div className="flex flex-wrap gap-2">
            {(["formula", "created_by", "link"] as FieldType[]).map((t) => (
              <button key={t} type="button" onClick={() => setType(t)} className={cn("flex h-7 items-center gap-1 rounded-md bg-hover px-2 text-[12px] text-muted-foreground hover:text-foreground", t === type && "bg-accent text-primary")}>
                <TypeGlyph t={t} size={13} /> {REGISTRY[t].label}
              </button>
            ))}
          </div>
        </div>
      )}
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
/** Field types that accept a 默认值, and the input used to edit it. */
const DEFAULT_KINDS: Partial<Record<FieldType, "text" | "number" | "date" | "select" | "checkbox" | "multi" | "person">> = {
  multi_select: "multi", person: "person",
  text: "text", url: "text", phone: "text", email: "text", number: "number", rating: "number", date: "date", select: "select", checkbox: "checkbox",
};

/** Cell value for the 默认值 input; null clears the default. */
export function defaultCell(type: FieldType, raw: string, options: string[], members: User[] = []): Cell | null {
  const kind = DEFAULT_KINDS[type];
  const v = raw.trim();
  if (!kind || !v) return null;
  if (kind === "number") { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (kind === "checkbox") return v === "true" ? true : null;
  if (kind === "select") return options.includes(v) ? v : null;
  if (kind === "multi") { const picked = options.filter((o) => parseMulti(v).includes(o)); return picked.length ? picked : null; }
  if (kind === "person") {
    if (v.startsWith("[")) {
      // 允许多选: the default is a JSON array of member ids, filtered to the
      // workspace directory (when one is given) and ordered by it.
      let ids = parseMultiIDs(v);
      if (members.length) {
        const known = new Set(members.map((m) => m.id));
        const order = new Map(members.map((m, i) => [m.id, i] as const));
        ids = ids.filter((id) => known.has(id));
        ids.sort((a, b) => (order.get(a) ?? members.length) - (order.get(b) ?? members.length));
      }
      return ids.length ? ids : null;
    }
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return v;
}

function parseMulti(raw: string): string[] {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}

function parseMultiIDs(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0) : [];
  } catch { return []; }
}

export type FieldMenuAction = "sort-asc" | "sort-desc" | "group" | "filter" | "insert-left" | "insert-right" | "freeze" | "unfreeze" | "hide";

export function FieldMenu({ field, frozen, onEdit, onDelete, onDuplicate, onAction }: { field: Field; /** this column is the last frozen one */ frozen?: boolean; onEdit: () => void; onDelete: () => void; onDuplicate?: () => void; onAction?: (action: FieldMenuAction) => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof popupPosition> | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) setPosition(popupPosition(rect, window.innerWidth, window.innerHeight, 224, 480));
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
        <div ref={menu} role="menu" style={position} className="fixed z-[101] w-56 overflow-y-auto rounded-lg border bg-surface p-1 text-[13px] font-normal text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.12)]" data-field-menu-pop onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); setOpen(false); trigger.current?.focus(); } }} onPaste={(e) => e.stopPropagation()}>
          {([
            ["edit", "修改字段/列", Pencil],
            ["describe", "编辑字段/列描述", Info],
            ...(onDuplicate ? [["duplicate", "复制字段/列", Copy]] : []),
            ...(onAction ? [
              ["sep0"],
              ...(!field.isPrimary ? [["insert-left", "向左插入字段/列", ArrowLeftToLine]] : []),
              ["insert-right", "向右插入字段/列", ArrowRightToLine],
              frozen ? ["unfreeze", "取消冻结", Snowflake] : ["freeze", "冻结至此列", Snowflake],
              ...(!field.isPrimary ? [["hide", "隐藏字段/列", EyeOff]] : []),
              ["sep1"],
              ["sort-asc", field.type === "number" ? "按 1 → 9 排序" : "按 A 到 Z 排序", ArrowDownAZ],
              ["sort-desc", field.type === "number" ? "按 9 → 1 排序" : "按 Z 到 A 排序", ArrowDownZA],
              ["sep2"],
              ["group", `按 ${field.name} 分组`, LayoutPanelTop],
              ["filter", `按 ${field.name} 筛选`, Filter],
            ] : []),
            ...(!field.isPrimary ? [["sep3"], ["delete", "删除字段/列", Trash2]] : []),
          ] as [string, string?, React.ComponentType<{ size?: number; strokeWidth?: number }>?][]).map(([key, label, Icon]) => !label || !Icon ? <div key={key} className="mx-1 my-1 h-px bg-border" role="separator" /> : (
            <button
              key={key}
              type="button"
              role="menuitem"
              className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover", key === "delete" && "text-destructive")}
              data-field-action={key}
              onClick={async () => {
                setOpen(false);
                if (key === "edit" || key === "describe") onEdit();
                else if (key === "duplicate") onDuplicate?.();
                else if (key === "delete") { if (await ask(`删除字段「${field.name}」？`, "字段及其所有值将被删除。")) onDelete(); }
                else onAction?.(key as FieldMenuAction);
              }}
            >
              <span className="shrink-0 text-muted-foreground"><Icon size={16} strokeWidth={1.6} /></span>
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>, document.body
      )}
    </div>
  );
}

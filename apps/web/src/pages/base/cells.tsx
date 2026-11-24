import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";
import { docsApi, type AttachmentRef, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { FeishuSelect, type FeishuSelectOption } from "@/components/feishu-select";
import { cn } from "@/lib/utils";
import {
  buttonOptions,
  clampProgress,
  CURRENCY_SYMBOLS,
  currencyOptions,
  displayValue,
  formatAutonumber,
  formatCurrency,
  formatLocationValue,
  formatTime,
  interpolateButtonTemplate,
  isAttachmentArray,
  isSafeHttpUrl,
  isStringArray,
  locationMapUrl,
  memberName,
  optionColor,
  parseLocation,
  personIDs,
  progressStyle,
  REGISTRY,
} from "./registry";
import { Copy, ExternalLink, MapPin, Paperclip, Webhook } from "lucide-react";

export const TAG_COLORS = [
  ["#E1EAFF", "#245BDB"],
  ["#D9F5D6", "#237B19"],
  ["#FEEAD2", "#B24D00"],
  ["#F8DEF8", "#9F2BA6"],
  ["#F2F3F5", "#646A73"],
];

export function Tag({ colorIndex, bg, fg, value }: { colorIndex: number; bg?: string; fg?: string; value: string }) {
  const [b, f] = bg && fg ? [bg, fg] : TAG_COLORS[Math.max(0, colorIndex) % TAG_COLORS.length];
  return (
    <span className="rounded px-2 py-0.5 text-[12px] font-medium" style={{ background: b, color: f }}>
      {value}
    </span>
  );
}

/** Grid rows have a fixed height; keep the first value whole and expose the rest. */
function CompactValues({ labels, first, action }: { labels: string[]; first?: ReactNode; action?: ReactNode }) {
  return <span className="flex min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap" title={labels.join("、")}>
    {first && <span className="min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap">{first}</span>}
    {labels.length > 1 && <span className="shrink-0 rounded bg-sidebar px-1 text-[12px] text-subtle" aria-label={t("还有 {n} 项", { n: labels.length - 1 })}>+{labels.length - 1}</span>}
    {action}
  </span>;
}

export function CellView({
  field,
  record,
  members,
  allFields,
  canEdit,
  compact = false,
  onToggle,
  onEdit,
  onButtonFeedback,
}: {
  field: Field;
  record: BaseRecord;
  members: User[];
  allFields?: Field[];
  canEdit: boolean;
  compact?: boolean;
  onToggle?: (v: boolean | null) => void;
  onEdit?: () => void;
  onButtonFeedback?: (message: string, tone?: "info" | "warning" | "error") => void;
}) {
  const v = displayValue(record, field, members);
  const def = REGISTRY[field.type];
  switch (field.type) {
    case "checkbox":
      return (
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={v === true}
          disabled={!onToggle}
          onChange={(e) => onToggle?.(e.target.checked ? true : null)}
          aria-label={field.name}
        />
      );
    case "select": {
      if (typeof v === "string" && v !== "") {
        const [bg, fg] = optionColor(field, v);
        return <Tag colorIndex={-2} bg={bg} fg={fg} value={v} />;
      }
      return null;
    }
    case "multi_select":
      if (compact && isStringArray(v) && v.length) {
        const [bg, fg] = optionColor(field, v[0]);
        return <CompactValues labels={v} first={<Tag colorIndex={-2} bg={bg} fg={fg} value={v[0]} />} />;
      }
      return (
        <span className="flex flex-wrap gap-1 overflow-hidden">
          {isStringArray(v)
            ? v.map((sv) => {
                const [bg, fg] = optionColor(field, sv);
                return <Tag key={sv} colorIndex={-2} bg={bg} fg={fg} value={sv} />;
              })
            : null}
        </span>
      );
    case "person": {
      // 允许多选: the cell may hold an array of member ids (single stays scalar).
      const ids = personIDs(v);
      if (!ids.length) return null;
      const labels = ids.map((id) => memberName(id, members) || t("成员 #{id}", { id }));
      if (compact && ids.length > 1) {
        return <CompactValues labels={labels} first={<span className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap"><Avatar name={labels[0]} />{labels[0]}</span>} />;
      }
      if (ids.length === 1) return <span className="inline-flex items-center gap-1.5 truncate"><Avatar name={labels[0]} />{labels[0]}</span>;
      return (
        <span className="flex min-w-0 flex-wrap gap-1 overflow-hidden">
          {ids.map((id, i) => (
            <span key={id} className="inline-flex max-w-full items-center gap-1.5 rounded bg-accent px-1.5 py-0.5 text-[12px]"><Avatar name={labels[i]} /><span className="truncate">{labels[i]}</span></span>
          ))}
        </span>
      );
    }
    case "created_by":
      return typeof v === "number" && v !== 0 ? <span className="inline-flex items-center gap-1.5 truncate"><Avatar name={memberName(v, members)} />{memberName(v, members)}</span> : null;
    case "created_at":
    case "modified_at":
      return <span className="block truncate text-[13px] text-muted-foreground">{formatTime(typeof v === "string" ? v : undefined)}</span>;
    case "link": {
      const titles = displayValue(record, field, members);
      if (compact && isStringArray(titles) && titles.length) return <CompactValues labels={titles} first={<span className="rounded bg-[#E1EAFF] px-1.5 py-0.5 text-[12px] font-medium text-primary">{titles[0]}</span>} />;
      if (isStringArray(titles) && titles.length)
        return (
          <span className="flex flex-wrap gap-1 overflow-hidden">
            {titles.map((t) => (
              <span key={t} className="rounded bg-[#E1EAFF] px-1.5 py-0.5 text-[12px] font-medium text-primary">
                {t}
              </span>
            ))}
          </span>
        );
      return null;
    }
    case "lookup": {
      const vals = displayValue(record, field, members);
      if (Array.isArray(vals) && vals.length) return <span className="block truncate">{vals.map((x) => String(x)).join("、")}</span>;
      return null;
    }
    case "attachment":
      if (compact && isAttachmentArray(v) && v.length) return <CompactValues labels={v.map((a) => a.name)} first={<a href={`/api/files/${v[0].id}`} target="_blank" rel="noreferrer" className="rounded bg-accent px-1.5 py-0.5 text-[12px] text-primary hover:underline"><Paperclip size={11} strokeWidth={1.7} className="inline align-[-1px]" /> {v[0].name}</a>} action={canEdit && onEdit ? <button className="shrink-0 rounded px-1 text-[12px] text-subtle hover:bg-hover hover:text-foreground" onClick={(e) => { e.stopPropagation(); onEdit(); }}>{t("+ 上传")}</button> : undefined} />;
      return (
        <span className="flex flex-wrap gap-1 overflow-hidden">
          {isAttachmentArray(v)
            ? v.map((a) => (
                <a key={a.id} href={`/api/files/${a.id}`} target="_blank" rel="noreferrer" className="max-w-[160px] truncate rounded bg-accent px-1.5 py-0.5 text-[12px] text-primary hover:underline" title={`${a.name} (${a.size}B)`}>
                  <Paperclip size={11} strokeWidth={1.7} className="inline align-[-1px]" /> {a.name}
                </a>
              ))
            : null}
          {canEdit && onEdit && (
            <button className="rounded px-1 text-[12px] text-subtle hover:bg-hover hover:text-foreground" onClick={(e) => { e.stopPropagation(); onEdit(); }}>
              {t("+ 上传")}
            </button>
          )}
        </span>
      );
    case "url":
      if (typeof v === "string" && v !== "")
        return (
          <a href={v} target="_blank" rel="noreferrer" className="block truncate text-primary hover:underline">
            {v.replace(/^https?:\/\//, "")}
          </a>
        );
      return null;
    case "email":
      if (typeof v === "string" && v !== "")
        return (
          <a href={`mailto:${v}`} className="block truncate text-primary hover:underline">
            {v}
          </a>
        );
      return null;
    case "phone":
      return typeof v === "string" && v !== "" ? <span className="block truncate">{v}</span> : null;
    case "rating":
      return typeof v === "number" ? (
        <span className="text-[15px] leading-none tracking-tight text-amber-400" title={`${v} / 5`}>
          {"★".repeat(v)}
          <span className="text-[#d8dfe9]">{"★".repeat(5 - v)}</span>
        </span>
      ) : null;
    case "currency":
      return typeof v === "number" && Number.isFinite(v) ? (
        <span className="block w-full truncate text-right font-medium tabular-nums text-foreground" data-cell-currency>
          {formatCurrency(v, field)}
        </span>
      ) : null;
    case "progress": {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      const pct = clampProgress(v);
      const style = progressStyle(field);
      const barColor = pct >= 100 ? "#00b42a" : pct > 0 ? "#3370ff" : "#8f959e";
      if (style === "ring") {
        const r = 7;
        const c = 2 * Math.PI * r;
        const dashOffset = c * (1 - pct / 100);
        return (
          <span className="inline-flex items-center gap-1.5" data-cell-progress="ring" title={`${Math.round(pct)}%`}>
            <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0 -rotate-90" aria-hidden>
              <circle cx="9" cy="9" r={r} fill="none" stroke="#e5e6eb" strokeWidth="2.4" />
              <circle cx="9" cy="9" r={r} fill="none" stroke={barColor} strokeWidth="2.4" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={dashOffset} />
            </svg>
            <span className="text-[12px] font-medium tabular-nums text-foreground">{Math.round(pct)}%</span>
          </span>
        );
      }
      if (style === "percent") {
        return (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium tabular-nums",
              pct >= 100
                ? "bg-[#e8f7e8] text-[#177e17]"
                : pct > 0
                  ? "bg-[#edf2ff] text-primary"
                  : "bg-[#f2f3f5] text-subtle",
            )}
            data-cell-progress="percent"
          >
            {Math.round(pct)}%
          </span>
        );
      }
      return (
        <div className="flex w-full min-w-[76px] items-center gap-2" data-cell-progress="bar" title={`${Math.round(pct)}%`}>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#e5e6eb] dark:bg-hover">
            <div className="h-full rounded-full transition-[width] duration-150" style={{ width: `${pct}%`, background: barColor }} />
          </div>
          <span className="w-9 shrink-0 text-right text-[12px] font-medium tabular-nums text-muted-foreground">{Math.round(pct)}%</span>
        </div>
      );
    }
    case "autonumber":
      return typeof v === "number" && Number.isFinite(v) ? (
        <span className="inline-block max-w-full truncate rounded bg-[#f2f3f5] px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground dark:bg-hover" data-cell-autonumber>
          {formatAutonumber(v, field)}
        </span>
      ) : null;
    case "button":
      return (
        <ButtonCellView
          field={field}
          record={record}
          members={members}
          allFields={allFields}
          onFeedback={onButtonFeedback}
        />
      );
    case "location": {
      if (typeof v !== "string" || !v.trim()) return null;
      const loc = parseLocation(v);
      const mapUrl = locationMapUrl(loc);
      return (
        <span className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden" data-cell-location title={v}>
          <MapPin size={13} strokeWidth={1.8} className="shrink-0 text-primary/80" aria-hidden />
          <span className="min-w-0 truncate text-[13px] text-foreground">{loc.address}</span>
          {loc.coords && !compact && (
            <span className="shrink-0 rounded bg-sidebar px-1.5 py-0.5 font-mono text-[11px] text-subtle">{loc.coords}</span>
          )}
          {mapUrl && (
            <a
              href={mapUrl}
              target="_blank"
              rel="noopener noreferrer"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 rounded p-0.5 text-subtle hover:bg-hover hover:text-primary"
              title={t("在地图中查看")}
              aria-label={t("在地图中查看")}
              data-location-map-link
            >
              <ExternalLink size={12} strokeWidth={1.7} />
            </a>
          )}
        </span>
      );
    }
    default:
      if (v === undefined || v === "") return null;
      return <span className="block truncate">{def.format(v, field)}</span>;
  }
}

function Avatar({ name }: { name: string }) {
  return <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[10px] font-medium text-primary">{(name || "?").slice(0, 1)}</span>;
}

/** dir tells the grid where to move next: "down" (Enter), "right" (Tab), undefined (blur). */
export function CellEditor({
  field,
  record,
  members,
  seed,
  draft,
  onDraft,
  onCommit,
  onCancel,
  onInvalid,
}: {
  field: Field;
  record: BaseRecord;
  members: User[];
  seed?: string;
  /** Parent-owned draft survives a virtualized cell being unmounted. */
  draft?: Cell | null;
  onDraft?: (value: Cell | null) => void;
  onCommit: (v: Cell | null, dir?: "down" | "right", raw?: string) => void;
  onCancel: () => void;
  onInvalid?: (raw: string) => void;
}) {
  const value = draft === undefined ? displayValue(record, field, members) : draft ?? undefined;
  const [text, setText] = useState(seed ?? (typeof value === "string" || typeof value === "number" ? String(value) : ""));
  const completed = useRef(false);

  if (field.type === "select") {
    const selectOptions: FeishuSelectOption[] = [
      { value: "", label: "—" },
      ...(field.options ?? [])
        .filter((o, idx, arr) => o !== "" && arr.indexOf(o) === idx)
        .map((o) => ({ value: o, label: o })),
    ];
    return (
      <SingleSelectCellEditor
        ariaLabel={field.name}
        value={typeof value === "string" ? value : ""}
        options={selectOptions}
        onCommit={(next) => onCommit(next || null)}
        onCancel={onCancel}
        dataAttr={{ "data-select-cell-editor": true }}
      />
    );
  }
  if (field.type === "multi_select") return <MultiSelectEditor field={field} value={isStringArray(value) ? value : []} onCommit={onCommit} onCancel={onCancel} onDraft={onDraft} />;
  if (field.type === "person" && field.multiple) return <PersonMultiEditor members={members} value={personIDs(value)} onCommit={onCommit} onCancel={onCancel} onDraft={onDraft} />;
  if (field.type === "person" || field.type === "created_by") {
    const memberOptions: FeishuSelectOption[] = [
      { value: "", label: "—" },
      ...members.map((m) => ({ value: String(m.id), label: m.name })),
    ];
    return (
      <SingleSelectCellEditor
        ariaLabel={field.name}
        value={typeof value === "number" ? String(value) : ""}
        options={memberOptions}
        onCommit={(next) => onCommit(next === "" ? null : Number(next))}
        onCancel={onCancel}
        dataAttr={{ "data-person-single-editor": true }}
      />
    );
  }
  if (field.type === "attachment")
    return <AttachmentEditor baseId={record.baseId} field={field} value={isAttachmentArray(value) ? value : []} onCommit={onCommit} onCancel={onCancel} />;
  if (field.type === "progress")
    return <ProgressCellEditor value={typeof value === "number" && Number.isFinite(value) ? clampProgress(value) : 0} seed={seed} onDraft={onDraft} onCommit={onCommit} onCancel={onCancel} />;
  if (field.type === "location")
    return <LocationCellEditor value={typeof value === "string" ? value : ""} seed={seed} onDraft={onDraft} onCommit={onCommit} onCancel={onCancel} />;

  const commit = (dir?: "down" | "right") => {
    if (completed.current) return;
    completed.current = true;
    const v = REGISTRY[field.type].parse(text, field);
    if (v === undefined && text !== "") {
      onInvalid?.(text);
      onCancel();
      return;
    }
    onCommit(v === undefined ? null : v, dir, text);
  };
  const isTimedDate = field.type === "date" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(text.trim());
  const inputVal = isTimedDate ? text.trim().replace(" ", "T") : text;
  if (field.type === "currency") {
    const sym = CURRENCY_SYMBOLS[currencyOptions(field).code] ?? "¥";
    return (
      <div className="flex w-full items-center gap-1" data-currency-editor>
        <span className="shrink-0 text-[12px] font-medium text-subtle">{sym}</span>
        <input
          autoFocus
          type="text"
          inputMode="decimal"
          className="w-full bg-transparent text-right tabular-nums outline-none"
          value={inputVal}
          onChange={(e) => {
            setText(e.target.value);
            onDraft?.(e.target.value);
          }}
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
              completed.current = true;
              onCancel();
            }
          }}
        />
      </div>
    );
  }
  return (
    <input
      autoFocus
      type={field.type === "date" ? (isTimedDate ? "datetime-local" : "date") : "text"}
      inputMode={field.type === "number" ? "decimal" : undefined}
      className={cn("w-full bg-transparent outline-none", field.type === "number" && "text-right")}
      value={inputVal}
      onChange={(e) => {
        const next = isTimedDate ? e.target.value.replace("T", " ") : e.target.value;
        setText(next);
        onDraft?.(next);
      }}
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
          completed.current = true;
          onCancel();
        }
      }}
    />
  );
}

function SingleSelectCellEditor({
  ariaLabel,
  value,
  options,
  onCommit,
  onCancel,
  dataAttr,
}: {
  ariaLabel: string;
  value: string;
  options: readonly FeishuSelectOption[];
  onCommit: (next: string) => void;
  onCancel: () => void;
  dataAttr?: Record<string, string | boolean | undefined>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const completed = useRef(false);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const trigger = wrapRef.current?.querySelector<HTMLButtonElement>('button[role="combobox"]');
    if (trigger) {
      trigger.focus();
      trigger.click();
    }
    const finishCancel = () => {
      if (completed.current) return;
      completed.current = true;
      cancelRef.current();
    };
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (wrapRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[role="listbox"]')) return;
      finishCancel();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finishCancel();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className="w-full min-w-0"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <FeishuSelect
        ariaLabel={ariaLabel}
        value={value}
        options={options}
        onChange={(next) => {
          if (completed.current) return;
          completed.current = true;
          onCommit(next);
        }}
        className="h-7 w-full bg-transparent px-1 text-[13px]"
        menuMinWidth={140}
        dataAttr={dataAttr}
      />
    </div>
  );
}

function MultiSelectEditor({ field, value, onCommit, onCancel, onDraft }: { field: Field; value: string[]; onCommit: (v: Cell | null) => void; onCancel: () => void; onDraft?: (value: Cell | null) => void }) {
  const [sel, setSel] = useState<string[]>(value);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onCancel]);
  return (
    <div ref={ref} className="absolute left-0 top-8 z-30 w-48 rounded-lg border bg-surface p-2 shadow-lg" data-multi-editor>
      {(field.options ?? []).map((o) => (
        <label key={o} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[13px] hover:bg-hover">
          <input
            type="checkbox"
            className="accent-primary"
            checked={sel.includes(o)}
            onChange={(e) => {
              const next = e.target.checked ? [...sel, o] : sel.filter((x) => x !== o);
              setSel(next);
              onDraft?.(next.length ? next : null);
            }}
          />
          {o}
        </label>
      ))}
      <div className="mt-1 flex justify-end gap-2 border-t pt-1.5">
        <button className="h-6 rounded border px-2 text-[12px]" onClick={onCancel}>
          {t("取消")}
        </button>
        <button
          className="h-6 rounded bg-primary px-2 text-[12px] text-white"
          onClick={() => onCommit(sel.length ? sel : null)}
        >
          {t("确定")}
        </button>
      </div>
    </div>
  );
}

/** 允许多选人员字段编辑器：与 MultiSelectEditor 相同的弹层交互，成员可多选。 */
function PersonMultiEditor({ members, value, onCommit, onCancel, onDraft }: { members: User[]; value: number[]; onCommit: (v: Cell | null) => void; onCancel: () => void; onDraft?: (value: Cell | null) => void }) {
  const [sel, setSel] = useState<number[]>(value);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onCancel]);
  return (
    <div ref={ref} className="absolute left-0 top-8 z-30 w-48 rounded-lg border bg-surface p-2 shadow-lg" data-person-editor>
      {members.map((m) => (
        <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[13px] hover:bg-hover">
          <input
            type="checkbox"
            className="accent-primary"
            checked={sel.includes(m.id)}
            onChange={(e) => {
              const next = e.target.checked ? [...sel, m.id] : sel.filter((x) => x !== m.id);
              setSel(next);
              onDraft?.(next.length ? next : null);
            }}
          />
          <Avatar name={m.name} />
          <span className="truncate">{m.name}</span>
        </label>
      ))}
      <div className="mt-1 flex justify-end gap-2 border-t pt-1.5">
        <button className="h-6 rounded border px-2 text-[12px]" onClick={onCancel}>
          {t("取消")}
        </button>
        <button
          className="h-6 rounded bg-primary px-2 text-[12px] text-white"
          onClick={() => onCommit(sel.length ? sel : null)}
        >
          {t("确定")}
        </button>
      </div>
    </div>
  );
}

function AttachmentEditor({
  baseId,
  field,
  value,
  onCommit,
  onCancel,
}: {
  baseId: number;
  field: Field;
  value: AttachmentRef[];
  onCommit: (v: Cell | null, dir?: "down" | "right") => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        data-attach-input
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          if (!files.length) return;
          e.currentTarget.value = ""; // selecting the same file after an upload error must fire again
          setBusy(true);
          setError(false);
          try {
            const refs = await Promise.all(files.map((f) => docsApi.upload(baseId, f)));
            onCommit([...value, ...refs]);
          } catch {
            setBusy(false);
            setError(true);
          }
        }}
      />
      <button
        className="h-6 rounded bg-primary px-2 text-[12px] text-white"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        data-attach-upload
      >
        {busy ? t("上传中…") : t("上传（已 {n} 个）", { n: value.length })}
      </button>
      <button className="h-6 rounded border px-2 text-[12px]" disabled={busy} onClick={onCancel}>
        {t("取消")}
      </button>
      {error && <span role="alert" className="text-[12px] text-destructive">{t("上传失败，请重试。")}</span>}
    </div>
  );
}

function ButtonCellView({
  field,
  record,
  members,
  allFields,
  onFeedback,
}: {
  field: Field;
  record: BaseRecord;
  members: User[];
  allFields?: Field[];
  onFeedback?: (message: string, tone?: "info" | "warning" | "error") => void;
}) {
  const cfg = buttonOptions(field);
  const [toast, setToast] = useState<{ text: string; tone: "info" | "warning" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const notify = (text: string, tone: "info" | "warning" | "error" = "info") => {
    onFeedback?.(text, tone);
    setToast({ text, tone });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setToast(null), 2600);
  };

  const runAction = async () => {
    if (busy) return;
    const fieldsForRow = allFields && allFields.length > 0 ? allFields : [field];
    if (cfg.action === "open_url") {
      const resolved = interpolateButtonTemplate(cfg.target, record, fieldsForRow, members).trim();
      if (!isSafeHttpUrl(resolved)) {
        notify(t("链接地址无效或仅支持 http/https 协议"), "warning");
        return;
      }
      window.open(resolved, "_blank", "noopener,noreferrer");
      notify(t("已打开链接"), "info");
      return;
    }
    if (cfg.action === "copy_row") {
      const lines = fieldsForRow
        .filter((f) => f.type !== "button")
        .map((f) => {
          const val = displayValue(record, f, members);
          const text = REGISTRY[f.type].format(val, f, members);
          return text ? `${f.name}: ${text}` : "";
        })
        .filter(Boolean);
      const summary = lines.length > 0 ? lines.join("\n") : `#${record.id}`;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(summary);
          notify(t("已复制记录摘要"), "info");
        } else {
          notify(t("当前环境不支持自动复制"), "warning");
        }
      } catch {
        notify(t("复制失败，请检查剪贴板权限"), "warning");
      }
      return;
    }
    // webhook
    const resolved = interpolateButtonTemplate(cfg.target, record, fieldsForRow, members).trim();
    if (!resolved) {
      notify(t("已执行「{label}」", { label: cfg.label }), "info");
      return;
    }
    if (!isSafeHttpUrl(resolved)) {
      notify(t("已执行「{label}」：{note}", { label: cfg.label, note: resolved }), "info");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(resolved, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseId: record.baseId,
          recordId: record.id,
          fieldId: field.id,
          label: cfg.label,
          cells: record.cells,
        }),
      });
      if (res.ok) notify(t("已触发 Webhook「{label}」", { label: cfg.label }), "info");
      else notify(t("Webhook 返回状态 {status}", { status: res.status }), "warning");
    } catch {
      notify(t("Webhook 请求发送失败，请检查目标地址"), "error");
    } finally {
      setBusy(false);
    }
  };

  const ActionIcon = cfg.action === "copy_row" ? Copy : cfg.action === "webhook" ? Webhook : ExternalLink;
  return (
    <>
      <button
        type="button"
        disabled={busy}
        data-cell-button={field.id}
        data-button-action={cfg.action}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void runAction();
        }}
        className="inline-flex h-6 max-w-full cursor-pointer items-center gap-1 rounded-md border border-primary/30 bg-[#edf2ff] px-2.5 text-[12px] font-medium text-primary transition-colors hover:bg-[#dfe8ff] active:scale-[0.98] disabled:opacity-50 dark:bg-primary/15 dark:hover:bg-primary/25"
        title={cfg.target || cfg.label}
      >
        <ActionIcon size={12} strokeWidth={1.8} className="shrink-0" aria-hidden />
        <span className="truncate">{busy ? t("执行中…") : cfg.label}</span>
      </button>
      {toast && typeof document !== "undefined" && createPortal(
        <div
          role="status"
          data-base-cell-toast
          className={cn(
            "fixed bottom-6 left-1/2 z-[200] -translate-x-1/2 rounded-lg border px-3.5 py-2 text-[13px] font-medium shadow-lg",
            toast.tone === "warning"
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : toast.tone === "error"
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : "border-[#d6e4ff] bg-surface text-foreground",
          )}
        >
          {toast.text}
        </div>,
        document.body,
      )}
    </>
  );
}

function ProgressCellEditor({
  value,
  seed,
  onDraft,
  onCommit,
  onCancel,
}: {
  value: number;
  seed?: string;
  onDraft?: (value: Cell | null) => void;
  onCommit: (v: Cell | null, dir?: "down" | "right", raw?: string) => void;
  onCancel: () => void;
}) {
  const initialNum = (() => {
    if (seed !== undefined) {
      const parsed = Number(seed.replace(/%$/, "").trim());
      if (Number.isFinite(parsed)) return clampProgress(parsed);
    }
    return clampProgress(value);
  })();
  const [rawText, setRawText] = useState(seed !== undefined ? seed : String(initialNum));
  const [sliderVal, setSliderVal] = useState(initialNum);
  const wrapRef = useRef<HTMLDivElement>(null);
  const completed = useRef(false);

  const commit = (dir?: "down" | "right") => {
    if (completed.current) return;
    completed.current = true;
    const trimmed = rawText.trim().replace(/%$/, "").trim();
    if (trimmed === "") {
      onCommit(null, dir, "");
      return;
    }
    const n = Number(trimmed);
    const next = Number.isFinite(n) ? clampProgress(n) : sliderVal;
    onCommit(next, dir, String(next));
  };

  return (
    <div
      ref={wrapRef}
      data-progress-editor
      className="flex w-full items-center gap-1.5"
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (wrapRef.current?.contains(e.relatedTarget as Node | null)) return;
        commit();
      }}
    >
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={sliderVal}
        aria-label={t("进度滑块")}
        className="h-1.5 min-w-[44px] flex-1 cursor-pointer accent-primary"
        onChange={(e) => {
          const n = clampProgress(Number(e.target.value));
          setSliderVal(n);
          setRawText(String(n));
          onDraft?.(n);
        }}
      />
      <input
        autoFocus
        type="number"
        min={0}
        max={100}
        step="any"
        aria-label={t("进度数值")}
        className="w-12 rounded border border-primary/40 bg-surface px-1 text-right text-[12px] tabular-nums outline-none"
        value={rawText}
        onChange={(e) => {
          setRawText(e.target.value);
          const n = Number(e.target.value);
          if (Number.isFinite(n)) {
            const clamped = clampProgress(n);
            setSliderVal(clamped);
            onDraft?.(clamped);
          }
        }}
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
            completed.current = true;
            onCancel();
          }
        }}
      />
      <span className="text-[11px] text-subtle">%</span>
    </div>
  );
}

function LocationCellEditor({
  value,
  seed,
  onDraft,
  onCommit,
  onCancel,
}: {
  value: string;
  seed?: string;
  onDraft?: (value: Cell | null) => void;
  onCommit: (v: Cell | null, dir?: "down" | "right", raw?: string) => void;
  onCancel: () => void;
}) {
  const parsed = parseLocation(seed ?? value);
  const [address, setAddress] = useState(parsed.address);
  const [coords, setCoords] = useState(parsed.coords);
  const ref = useRef<HTMLDivElement>(null);
  const completed = useRef(false);

  const commit = (dir?: "down" | "right") => {
    if (completed.current) return;
    completed.current = true;
    const formatted = formatLocationValue(address, coords);
    onCommit(formatted ? formatted : null, dir, formatted);
  };

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) commit();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  });

  const update = (nextAddr: string, nextCoords: string) => {
    setAddress(nextAddr);
    setCoords(nextCoords);
    const f = formatLocationValue(nextAddr, nextCoords);
    onDraft?.(f || null);
  };

  return (
    <div
      ref={ref}
      data-location-editor
      className="absolute left-0 top-8 z-30 w-64 space-y-2 rounded-lg border bg-surface p-2.5 text-[12px] shadow-lg"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">{t("地址")}</span>
        <input
          autoFocus
          value={address}
          onChange={(e) => update(e.target.value, coords)}
          placeholder={t("输入地址，如 北京市海淀区")}
          className="h-7 w-full rounded border bg-surface px-2 text-[12px] outline-none focus:border-primary"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit("down");
            }
            if (e.key === "Escape") {
              e.preventDefault();
              completed.current = true;
              onCancel();
            }
          }}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">{t("经纬度（可选）")}</span>
        <input
          value={coords}
          onChange={(e) => update(address, e.target.value)}
          placeholder={t("如 39.98,116.31")}
          className="h-7 w-full rounded border bg-surface px-2 font-mono text-[12px] outline-none focus:border-primary"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit("down");
            }
            if (e.key === "Escape") {
              e.preventDefault();
              completed.current = true;
              onCancel();
            }
          }}
        />
      </label>
      <div className="flex justify-end gap-1.5 pt-0.5">
        <button
          type="button"
          className="h-6 rounded border px-2 text-[12px] hover:bg-hover"
          onClick={() => {
            completed.current = true;
            onCancel();
          }}
        >
          {t("取消")}
        </button>
        <button
          type="button"
          className="h-6 rounded bg-primary px-2 text-[12px] text-white"
          onClick={() => commit()}
        >
          {t("确定")}
        </button>
      </div>
    </div>
  );
}

/** 渲染字段类型 icon（registry 的 icon 可能是字符串或 lucide 组件）。 */
export function TypeGlyph({ t, size = 13 }: { t: import("@/lib/api").FieldType; size?: number }) {
  const icon = REGISTRY[t].icon;
  if (typeof icon === "string") return <>{icon}</>;
  const C = icon as React.ComponentType<{ size?: number; strokeWidth?: number }>;
  return <C size={size} strokeWidth={1.7} />;
}

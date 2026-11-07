import { useEffect, useRef, useState, type ReactNode } from "react";
import { docsApi, type AttachmentRef, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { displayValue, formatTime, isAttachmentArray, isStringArray, memberName, optionColor, REGISTRY } from "./registry";
import { Paperclip } from "lucide-react";

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
    {labels.length > 1 && <span className="shrink-0 rounded bg-sidebar px-1 text-[12px] text-subtle" aria-label={`还有 ${labels.length - 1} 项`}>+{labels.length - 1}</span>}
    {action}
  </span>;
}

export function CellView({
  field,
  record,
  members,
  canEdit,
  compact = false,
  onToggle,
  onEdit,
}: {
  field: Field;
  record: BaseRecord;
  members: User[];
  canEdit: boolean;
  compact?: boolean;
  onToggle?: (v: boolean | null) => void;
  onEdit?: () => void;
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
    case "person":
      return typeof v === "number" && v !== 0 ? <span className="inline-flex items-center gap-1.5 truncate"><Avatar name={memberName(v, members)} />{memberName(v, members)}</span> : null;
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
      if (compact && isAttachmentArray(v) && v.length) return <CompactValues labels={v.map((a) => a.name)} first={<a href={`/api/files/${v[0].id}`} target="_blank" rel="noreferrer" className="rounded bg-accent px-1.5 py-0.5 text-[12px] text-primary hover:underline"><Paperclip size={11} strokeWidth={1.7} className="inline align-[-1px]" /> {v[0].name}</a>} action={canEdit && onEdit ? <button className="shrink-0 rounded px-1 text-[12px] text-subtle hover:bg-hover hover:text-foreground" onClick={(e) => { e.stopPropagation(); onEdit(); }}>+ 上传</button> : undefined} />;
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
              + 上传
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

  if (field.type === "select")
    return (
      <select autoFocus className="w-full bg-transparent outline-none" value={typeof value === "string" ? value : ""} onChange={(e) => onCommit(e.target.value || null)} onBlur={onCancel}>
        <option value="">—</option>
        {(field.options ?? []).map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  if (field.type === "multi_select") return <MultiSelectEditor field={field} value={isStringArray(value) ? value : []} onCommit={onCommit} onCancel={onCancel} onDraft={onDraft} />;
  if (field.type === "person" || field.type === "created_by")
    return (
      <select
        autoFocus
        className="w-full bg-transparent outline-none"
        value={typeof value === "number" ? String(value) : ""}
        onChange={(e) => onCommit(e.target.value === "" ? null : Number(e.target.value))}
        onBlur={onCancel}
      >
        <option value="">—</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    );
  if (field.type === "attachment")
    return <AttachmentEditor baseId={record.baseId} field={field} value={isAttachmentArray(value) ? value : []} onCommit={onCommit} onCancel={onCancel} />;

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
  return (
    <input
      autoFocus
      type={field.type === "date" ? "date" : "text"}
      inputMode={field.type === "number" ? "decimal" : undefined}
      className={cn("w-full bg-transparent outline-none", field.type === "number" && "text-right")}
      value={text}
      onChange={(e) => { setText(e.target.value); onDraft?.(e.target.value); }}
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
          取消
        </button>
        <button
          className="h-6 rounded bg-primary px-2 text-[12px] text-white"
          onClick={() => onCommit(sel.length ? sel : null)}
        >
          确定
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
        {busy ? "上传中…" : `上传（已 ${value.length} 个）`}
      </button>
      <button className="h-6 rounded border px-2 text-[12px]" disabled={busy} onClick={onCancel}>
        取消
      </button>
      {error && <span role="alert" className="text-[12px] text-destructive">上传失败，请重试。</span>}
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

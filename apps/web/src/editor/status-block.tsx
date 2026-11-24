import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { t, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type StatusTone = "blue" | "green" | "orange" | "red" | "purple" | "gray";

export interface StatusTagItem {
  id: string;
  text: string;
  color: StatusTone;
}

export const STATUS_TONES: Record<StatusTone, { bg: string; fg: string; border: string; label: string }> = {
  blue: { bg: "#E1EAFF", fg: "#245BDB", border: "#BACEFD", label: "蓝色" },
  green: { bg: "#D9F5D6", fg: "#1C7C2C", border: "#B7EDB1", label: "绿色" },
  orange: { bg: "#FEF1E1", fg: "#B85C00", border: "#F9D7AF", label: "橙色" },
  red: { bg: "#FDE2E2", fg: "#C92A2A", border: "#F8C4C2", label: "红色" },
  purple: { bg: "#F3E8FF", fg: "#6B21A8", border: "#DFC3FB", label: "紫色" },
  gray: { bg: "#EFF0F1", fg: "#4E5969", border: "#DEE0E3", label: "灰色" },
};

const PRESETS: { text: string; color: StatusTone }[] = [
  { text: "待开始", color: "gray" },
  { text: "进行中", color: "blue" },
  { text: "已完成", color: "green" },
  { text: "待确认", color: "orange" },
  { text: "风险", color: "red" },
  { text: "P0", color: "purple" },
];

export function parseStatusItems(raw: string | undefined): StatusTagItem[] {
  if (!raw) return [{ id: "st-1", text: t("进行中"), color: "blue" }];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x, idx) => ({
          id: typeof x.id === "string" && x.id ? x.id : `st-${idx + 1}`,
          text: typeof x.text === "string" && x.text.trim() ? x.text.trim() : t("状态"),
          color: (typeof x.color === "string" && x.color in STATUS_TONES ? x.color : "blue") as StatusTone,
        }));
    }
  } catch { /* fall back to default */ }
  return [{ id: "st-1", text: t("进行中"), color: "blue" }];
}

export function StatusBlockView({
  raw,
  readOnly,
  onChange,
  onDelete,
}: {
  raw?: string;
  readOnly?: boolean;
  onChange?: (nextRaw: string) => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const items = parseStatusItems(raw);
  const [editingId, setEditingId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editingId) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setEditingId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditingId(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [editingId]);

  const commit = (next: StatusTagItem[]) => {
    if (!next.length) {
      onDelete?.();
      return;
    }
    onChange?.(JSON.stringify(next));
  };

  const editingItem = editingId ? items.find((i) => i.id === editingId) : null;

  return (
    <div ref={wrapRef} contentEditable={false} data-status-block className="group/status relative my-1.5 flex flex-wrap items-center gap-1.5 select-none">
      {items.map((item) => {
        const tone = STATUS_TONES[item.color] ?? STATUS_TONES.blue;
        return (
          <button
            key={item.id}
            type="button"
            disabled={readOnly}
            onClick={() => !readOnly && setEditingId((cur) => (cur === item.id ? null : item.id))}
            style={{ backgroundColor: tone.bg, color: tone.fg, borderColor: tone.border }}
            className={cn(
              "inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-medium transition-shadow",
              !readOnly && "cursor-pointer hover:shadow-xs",
              editingId === item.id && "ring-2 ring-[#3370ff]/40",
            )}
            data-status-pill={item.text}
          >
            {item.text}
          </button>
        );
      })}
      {!readOnly && onChange && (
        <button
          type="button"
          title={t("添加状态标签")}
          aria-label={t("添加状态标签")}
          onClick={() => {
            const id = `st-${Date.now().toString(36)}`;
            const next = [...items, { id, text: t("待确认"), color: "orange" as StatusTone }];
            commit(next);
            setEditingId(id);
          }}
          className="grid size-6 place-items-center rounded-md border border-dashed border-[#d0d3d6] text-[#8f959e] opacity-0 transition-opacity hover:border-[#3370ff] hover:text-[#3370ff] group-hover/status:opacity-100 focus-visible:opacity-100"
        >
          <Plus size={12} />
        </button>
      )}
      {!readOnly && onDelete && (
        <button
          type="button"
          title={t("删除状态栏")}
          aria-label={t("删除状态栏")}
          onClick={onDelete}
          className="grid size-6 place-items-center rounded-md text-[#8f959e] opacity-0 transition-opacity hover:bg-[#eff0f1] hover:text-destructive group-hover/status:opacity-100"
        >
          <Trash2 size={12} />
        </button>
      )}

      {editingItem && !readOnly && onChange && (
        <div
          role="dialog"
          aria-label={t("编辑状态标签")}
          className="absolute left-0 top-8 z-40 w-[236px] rounded-lg border border-[#dee0e3] bg-surface p-3 shadow-[0_6px_24px_rgba(31,35,41,0.14)] dark:border-border"
        >
          <div className="mb-2 flex items-center justify-between text-[12px] font-medium text-[#646a73]">
            <span>{t("状态标签")}</span>
            <button type="button" onClick={() => setEditingId(null)} className="text-[#8f959e] hover:text-foreground" aria-label={t("关闭")}><X size={13} /></button>
          </div>
          <input
            autoFocus
            value={editingItem.text}
            maxLength={24}
            onChange={(e) => commit(items.map((it) => (it.id === editingItem.id ? { ...it, text: e.target.value } : it)))}
            onKeyDown={(e) => { if (e.key === "Enter") setEditingId(null); }}
            placeholder={t("输入状态文字")}
            className="mb-2.5 h-8 w-full rounded-md border border-[#dee0e3] bg-surface px-2.5 text-[13px] text-foreground outline-none focus:border-[#3370ff]"
          />
          <div className="mb-2.5 flex items-center gap-1.5">
            {(Object.keys(STATUS_TONES) as StatusTone[]).map((toneKey) => {
              const tone = STATUS_TONES[toneKey];
              return (
                <button
                  key={toneKey}
                  type="button"
                  title={t(tone.label)}
                  aria-label={t(tone.label)}
                  onClick={() => commit(items.map((it) => (it.id === editingItem.id ? { ...it, color: toneKey } : it)))}
                  style={{ backgroundColor: tone.bg, borderColor: tone.fg }}
                  className={cn("size-5 rounded-full border", editingItem.color === toneKey && "ring-2 ring-[#3370ff] ring-offset-1")}
                />
              );
            })}
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {PRESETS.map((p) => {
              const tone = STATUS_TONES[p.color];
              const presetLabel = t(p.text);
              return (
                <button
                  key={p.text}
                  type="button"
                  onClick={() => {
                    commit(items.map((it) => (it.id === editingItem.id ? { ...it, text: presetLabel, color: p.color } : it)));
                    setEditingId(null);
                  }}
                  style={{ backgroundColor: tone.bg, color: tone.fg }}
                  className="rounded px-1.5 py-0.5 text-[11px] font-medium hover:opacity-85"
                >
                  {presetLabel}
                </button>
              );
            })}
          </div>
          <div className="border-t border-[#eff0f1] pt-2 text-right dark:border-border">
            <button
              type="button"
              onClick={() => {
                const next = items.filter((it) => it.id !== editingItem.id);
                setEditingId(null);
                commit(next);
              }}
              className="text-[12px] text-[#d83931] hover:underline"
            >
              {t("移除标签")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

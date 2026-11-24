import { useEffect, useRef, useState } from "react";
import { Bell, Calendar, Check, Clock, Trash2 } from "lucide-react";
import { t, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Format a local Date as YYYY-MM-DD. */
export function formatLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDaysIso(days: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return formatLocalIsoDate(d);
}

export interface ReminderBadge {
  text: string;
  tone: "done" | "overdue" | "today" | "soon" | "future" | "unset";
}

/** Pure relative status calculation for a date reminder block. */
export function reminderStatus(date: string | undefined, time: string | undefined, done: boolean, now = new Date()): ReminderBadge {
  if (done) return { text: t("已完成"), tone: "done" };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { text: t("未设日期"), tone: "unset" };
  const [y, m, d] = date.split("-").map(Number);
  const targetDay = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((targetDay.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) return { text: t("已过期 {days} 天", { days: Math.abs(diffDays) }), tone: "overdue" };
  if (diffDays === 0) {
    if (time && /^\d{2}:\d{2}$/.test(time)) {
      const [hh, mm] = time.split(":").map(Number);
      const targetExact = new Date(y, m - 1, d, hh, mm);
      if (targetExact.getTime() < now.getTime()) return { text: t("今日已过时"), tone: "overdue" };
    }
    return { text: t("今天"), tone: "today" };
  }
  if (diffDays === 1) return { text: t("明天"), tone: "soon" };
  if (diffDays <= 7) return { text: t("{days} 天后", { days: diffDays }), tone: "soon" };
  return { text: t("{days} 天后", { days: diffDays }), tone: "future" };
}

const BADGE_CLASS: Record<ReminderBadge["tone"], string> = {
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300",
  overdue: "bg-rose-100 text-rose-700 dark:bg-rose-950/70 dark:text-rose-300",
  today: "bg-blue-100 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300",
  soon: "bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300",
  future: "bg-muted text-muted-foreground",
  unset: "bg-muted text-muted-foreground",
};

export function ReminderBlockView({
  date,
  time,
  label,
  done,
  readOnly,
  onChange,
  onDelete,
}: {
  date?: string;
  time?: string;
  label?: string;
  done?: boolean;
  readOnly?: boolean;
  onChange?: (key: "date" | "time" | "label" | "done", value: string) => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(label ?? "");
  const [lastPropLabel, setLastPropLabel] = useState(label ?? "");
  const saveTimer = useRef<number | null>(null);
  if ((label ?? "") !== lastPropLabel) {
    setLastPropLabel(label ?? "");
    setDraftLabel(label ?? "");
  }

  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
  }, []);

  const badge = reminderStatus(date, time, !!done);

  const commitLabel = (nextVal = draftLabel) => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (!onChange) return;
    const trimmed = nextVal.trim();
    if (trimmed !== (label ?? "")) onChange("label", trimmed);
  };

  return (
    <div
      contentEditable={false}
      data-reminder-block
      data-reminder-done={done ? "true" : "false"}
      className={cn(
        "my-2 max-w-full rounded-lg border px-3.5 py-2.5 text-[13px] transition-colors",
        done
          ? "border-border/80 bg-muted/30"
          : badge.tone === "overdue"
            ? "border-rose-200 bg-rose-50/30 dark:border-rose-900/70 dark:bg-rose-950/15"
            : "border-blue-200/90 bg-blue-50/25 dark:border-blue-900/70 dark:bg-blue-950/15",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={readOnly || !onChange}
          onClick={() => onChange?.("done", done ? "" : "true")}
          aria-label={done ? t("标记为未完成") : t("标记为已完成")}
          aria-pressed={!!done}
          data-reminder-toggle
          className={cn(
            "grid size-4.5 shrink-0 place-items-center rounded border transition-colors",
            done
              ? "border-emerald-600 bg-emerald-600 text-white"
              : "border-[#BBBFC4] bg-surface hover:border-primary disabled:opacity-60",
          )}
        >
          {done && <Check size={12} strokeWidth={2.5} />}
        </button>

        <span className="inline-flex shrink-0 items-center gap-1 font-medium text-primary">
          <Bell size={13} />
          <span data-reminder-display-date>{date || t("选择日期")}</span>
          {time && <span className="text-[12px] text-muted-foreground" data-reminder-display-time>{time}</span>}
        </span>

        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", BADGE_CLASS[badge.tone])} data-reminder-badge>
          {badge.text}
        </span>

        {!readOnly && onChange ? (
          <input
            type="text"
            value={draftLabel}
            onChange={(e) => {
              const next = e.target.value;
              setDraftLabel(next);
              if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
              saveTimer.current = window.setTimeout(() => commitLabel(next), 250);
            }}
            onBlur={() => commitLabel()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitLabel();
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder={t("输入提醒事项…")}
            data-reminder-label
            className={cn(
              "min-w-[140px] flex-1 rounded bg-transparent px-1.5 py-0.5 text-[13px] outline-none focus:bg-surface focus:ring-1 focus:ring-primary/40",
              done && "text-muted-foreground line-through",
            )}
          />
        ) : (
          <span className={cn("min-w-0 flex-1 break-words text-[13px]", done && "text-muted-foreground line-through")} data-reminder-label-readonly>
            {label || t("日期提醒")}
          </span>
        )}

        {!readOnly && onChange && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              data-reminder-edit-time
              className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              <Calendar size={11} />
              {editing ? t("收起时间") : t("设置时间")}
            </button>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                aria-label={t("删除日期提醒")}
                className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-destructive"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {!readOnly && onChange && editing && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5 text-[12px]" data-reminder-controls>
          <label className="inline-flex items-center gap-1 text-muted-foreground">
            <Calendar size={12} />
            <input
              type="date"
              value={date || ""}
              onChange={(e) => onChange("date", e.target.value)}
              data-reminder-date
              className="h-7 rounded border bg-surface px-2 text-[12px] text-foreground outline-none focus:border-primary"
            />
          </label>
          <label className="inline-flex items-center gap-1 text-muted-foreground">
            <Clock size={12} />
            <input
              type="time"
              value={time || ""}
              onChange={(e) => onChange("time", e.target.value)}
              data-reminder-time
              className="h-7 rounded border bg-surface px-2 text-[12px] text-foreground outline-none focus:border-primary"
            />
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onChange("date", addDaysIso(0))}
              data-reminder-preset="today"
              className="h-6 rounded border bg-surface px-2 text-[11px] hover:bg-hover"
            >
              {t("今天")}
            </button>
            <button
              type="button"
              onClick={() => onChange("date", addDaysIso(1))}
              data-reminder-preset="tomorrow"
              className="h-6 rounded border bg-surface px-2 text-[11px] hover:bg-hover"
            >
              {t("明天")}
            </button>
            <button
              type="button"
              onClick={() => onChange("date", addDaysIso(7))}
              data-reminder-preset="nextweek"
              className="h-6 rounded border bg-surface px-2 text-[11px] hover:bg-hover"
            >
              {t("下周")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

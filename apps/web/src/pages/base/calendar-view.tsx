import { useEffect, useMemo, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { t, useI18n } from "@/lib/i18n";
import { ApiError, baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { recordTitle } from "./registry";
import { refreshWrites, useWriteLedger } from "./write-safety";
import { definedCells, type UndoCellChange, type UndoStep } from "./undo";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_HEIGHT = 48;
const SNAP_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CalendarScale = "day" | "week" | "month";

/** Date-only values represent civil days; UTC is used only for arithmetic. */
export function calendarDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Use UTC civil dates to avoid local DST transitions and skipped midnights.
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

export interface ParsedCalendarDateTime {
  dayKey: string;
  date: Date;
  minutes: number | null;
  isAllDay: boolean;
}

/**
 * Parses either a civil date ("YYYY-MM-DD") or a minute-precision local wall
 * datetime ("YYYY-MM-DD HH:mm"). Rejects ISO timezone strings and invalid dates.
 */
export function calendarDateTime(value: unknown): ParsedCalendarDateTime | null {
  if (typeof value !== "string") return null;
  if (value.length === 10) {
    const d = calendarDate(value);
    return d ? { dayKey: value, date: d, minutes: null, isAllDay: true } : null;
  }
  if (value.length === 16) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(value);
    if (!m) return null;
    const d = calendarDate(m[1]);
    if (!d) return null;
    const hh = Number(m[2]), mm = Number(m[3]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return { dayKey: m[1], date: d, minutes: hh * 60 + mm, isAllDay: false };
  }
  return null;
}

export function formatMinutesHHMM(minutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function formatCalendarDateTime(dayKey: string, minutes: number): string {
  return `${dayKey} ${formatMinutesHHMM(minutes)}`;
}

export function calendarKey(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function civilDay(date: Date): Date {
  const day = new Date(date);
  day.setUTCHours(12, 0, 0, 0);
  return day;
}
function addDays(date: Date, delta: number): Date {
  const day = civilDay(date);
  day.setUTCDate(day.getUTCDate() + delta);
  return day;
}
function dayDiff(fromKey: string, toKey: string): number {
  const a = calendarDate(fromKey), b = calendarDate(toKey);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}
function shiftDateTimeByDays(raw: unknown, deltaDays: number): string | null {
  const parsed = calendarDateTime(raw);
  if (!parsed) return null;
  const nextKey = calendarKey(addDays(parsed.date, deltaDays));
  return parsed.isAllDay || parsed.minutes === null ? nextKey : formatCalendarDateTime(nextKey, parsed.minutes);
}
function weekStart(date: Date): Date { return addDays(date, -((date.getUTCDay() + 6) % 7)); }

export function calendarDays(cursor: Date, scale: CalendarScale): Date[] {
  if (scale === "day") return [civilDay(cursor)];
  if (scale === "week") return Array.from({ length: 7 }, (_, i) => addDays(weekStart(cursor), i));
  const first = civilDay(cursor);
  first.setUTCDate(1);
  const start = weekStart(first);
  const last = civilDay(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const count = Math.ceil((last.getUTCDate() + (first.getUTCDay() + 6) % 7) / 7) * 7;
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

export function shiftCalendar(cursor: Date, scale: CalendarScale, amount: number): Date {
  if (scale !== "month") return addDays(cursor, amount * (scale === "week" ? 7 : 1));
  const result = civilDay(cursor);
  const desiredDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + amount);
  const end = civilDay(result);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  result.setUTCDate(Math.min(desiredDay, end.getUTCDate()));
  return result;
}

/** Group valid date or datetime values by civil day. Missing/invalid values stay unscheduled. */
export function groupCalendarRecords(records: BaseRecord[], dateFieldId?: number): { byDay: Map<string, BaseRecord[]>; unscheduled: BaseRecord[] } {
  const byDay = new Map<string, BaseRecord[]>();
  const unscheduled: BaseRecord[] = [];
  for (const record of records) {
    const raw = dateFieldId === undefined ? undefined : record.cells[dateFieldId];
    const parsed = calendarDateTime(raw);
    if (!parsed) { unscheduled.push(record); continue; }
    const list = byDay.get(parsed.dayKey);
    if (list) list.push(record); else byDay.set(parsed.dayKey, [record]);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => {
      const pa = dateFieldId === undefined ? null : calendarDateTime(a.cells[dateFieldId]);
      const pb = dateFieldId === undefined ? null : calendarDateTime(b.cells[dateFieldId]);
      const ma = pa?.minutes ?? -1;
      const mb = pb?.minutes ?? -1;
      return ma !== mb ? ma - mb : a.id - b.id;
    });
  }
  return { byDay, unscheduled };
}

/** Compute start/end minutes within a day for a timed event block (default 60 min). */
export function calendarTimedSpan(startRaw: unknown, endRaw: unknown, sameField: boolean): { dayKey: string; startMin: number; endMin: number; duration: number } | null {
  const s = calendarDateTime(startRaw);
  if (!s || s.isAllDay || s.minutes === null) return null;
  let duration = 60;
  if (!sameField) {
    const e = calendarDateTime(endRaw);
    if (e && !e.isAllDay && e.minutes !== null) {
      const diff = dayDiff(s.dayKey, e.dayKey) * 1440 + (e.minutes - s.minutes);
      if (diff >= 15) duration = Math.min(diff, 1440 - s.minutes);
    }
  }
  const endMin = Math.min(1440, Math.max(s.minutes + 30, s.minutes + duration));
  return { dayKey: s.dayKey, startMin: s.minutes, endMin, duration: endMin - s.minutes };
}

/** Assign side-by-side layout columns for overlapping timed events on the same day. */
export function layoutDayTimedEvents(items: { id: number; startMin: number; endMin: number }[]): Map<number, { col: number; cols: number }> {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin || a.id - b.id);
  const out = new Map<number, { col: number; cols: number }>();
  let cluster: { id: number; startMin: number; endMin: number; col: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const cols = Math.max(...cluster.map((c) => c.col)) + 1;
    for (const c of cluster) out.set(c.id, { col: c.col, cols });
    cluster = [];
    clusterEnd = -1;
  };
  let colEnds: number[] = [];
  for (const item of sorted) {
    if (cluster.length && item.startMin >= clusterEnd) {
      flush();
      colEnds = [];
    }
    let col = colEnds.findIndex((end) => end <= item.startMin);
    if (col < 0) col = colEnds.length;
    colEnds[col] = item.endMin;
    cluster.push({ ...item, col });
    if (item.endMin > clusterEnd) clusterEnd = item.endMin;
  }
  flush();
  return out;
}

function todayCalendar(): Date {
  const now = new Date();
  return calendarDate(`${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`)!;
}

type PointerScheduleDraft = {
  recordId: number;
  mode: "move" | "resize";
  dayKey: string;
  startMin: number;
  endMin: number;
};

/** Calendar view over date/datetime fields with Month overview + Week/Day hourly scheduling. */
export function CalendarView({
  baseId, tableId, canEdit, fields, records, members, dateFieldId, endDateFieldId, onMutate, onOpen, onRecordUndo,
}: {
  baseId: number;
  tableId?: number;
  canEdit: boolean;
  fields: Field[];
  records: BaseRecord[];
  members: User[];
  dateFieldId?: number | null;
  endDateFieldId?: number | null;
  onMutate: () => void;
  onOpen?: (record: BaseRecord) => void;
  onRecordUndo?: (step: UndoStep) => void;
}) {
  useI18n();
  const dateFields = fields.filter((f) => f.type === "date");
  const dateField = fields.find((f) => f.id === dateFieldId && f.type === "date") ?? dateFields[0];
  const endDateField =
    fields.find((f) => f.id === endDateFieldId && f.type === "date" && f.id !== dateField?.id)
    ?? dateFields.find((f) => f.id !== dateField?.id)
    ?? null;
  const hasSeparateEnd = !!(dateField && endDateField && endDateField.id !== dateField.id);

  const [cursor, setCursor] = useState(todayCalendar);
  const [scale, setScale] = useState<CalendarScale>("month");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pointerDraft, setPointerDraft] = useState<PointerScheduleDraft | null>(null);
  const busyRef = useRef(false);
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const { ledger } = useWriteLedger(baseId);
  const scope = useRef({ baseId, generation: 0, mounted: true });
  if (scope.current.baseId !== baseId) scope.current = { baseId, generation: scope.current.generation + 1, mounted: true };
  const cleanupPointerRef = useRef<(() => void) | null>(null);
  const hourlyScrollRef = useRef<HTMLDivElement>(null);
  const hourlyGridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scope.current.mounted = true;
    return () => {
      scope.current.mounted = false;
      cleanupPointerRef.current?.();
      cleanupPointerRef.current = null;
    };
  }, []);

  // Scroll Week/Day hourly grid to 08:00 when entering hourly mode.
  useEffect(() => {
    if (scale === "week" || scale === "day") {
      if (hourlyScrollRef.current && hourlyScrollRef.current.scrollTop === 0) {
        hourlyScrollRef.current.scrollTop = 8 * HOUR_HEIGHT;
      }
    }
  }, [scale]);

  const dragRef = useRef<{ baseId: number; recordId: number; fieldId: number; expectedStart: string | null; expectedEnd: string | null } | null>(null);
  useEffect(() => {
    dragRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setError(null);
    setPointerDraft(null);
  }, [baseId]);

  const { byDay, unscheduled } = useMemo(() => groupCalendarRecords(records, dateField?.id), [records, dateField?.id]);
  const days = useMemo(() => calendarDays(cursor, scale), [cursor, scale]);
  const today = calendarKey(todayCalendar());

  if (!dateField) {
    return (
      <div className="grid flex-1 place-items-center px-4 text-center text-[14px] text-muted-foreground">
        <p>{t("日历需要日期字段，请先在表格视图中添加日期字段。")}</p>
      </div>
    );
  }

  const label = (record: BaseRecord) => recordTitle(record, fields, members) || t("未命名");

  const commitDateChange = async (
    rid: number,
    expectedStart: string | null,
    expectedEnd: string | null,
    nextStart: string,
    nextEnd: string | null,
    undoLabel: string,
  ) => {
    if (!canEdit || busyRef.current || ledger.blocked("batch")) return;
    if (expectedStart === nextStart && (!hasSeparateEnd || expectedEnd === nextEnd)) return;
    const expected: Record<string, Cell | null> = { [dateField.id]: expectedStart };
    const cells: Record<string, Cell | null> = { [dateField.id]: nextStart };
    if (hasSeparateEnd && endDateField) {
      expected[endDateField.id] = expectedEnd;
      cells[endDateField.id] = nextEnd;
    }
    const op = ledger.begin(t("记录 #{rid} · {field}", { rid, field: dateField.name }), nextStart, `cell:${rid}:${dateField.id}`, undefined, false, true);
    if (op === null) return;
    const requestedBase = baseId, generation = scope.current.generation;
    const stillCurrent = () => scope.current.mounted && scope.current.baseId === requestedBase && scope.current.generation === generation;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      await baseApi.compareCells(requestedBase, rid, expected, cells);
      ledger.complete(op);
      const changes: UndoCellChange[] = [{ rid, fid: dateField.id, before: expectedStart, after: nextStart }];
      if (hasSeparateEnd && endDateField && expectedEnd !== nextEnd) {
        changes.push({ rid, fid: endDateField.id, before: expectedEnd, after: nextEnd });
      }
      onRecordUndo?.({ label: undoLabel, cells: changes, created: [] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "conflict") {
        ledger.complete(op);
        if (stillCurrent()) setError(t("日期已被修改，请检查后重新拖动。"));
      } else {
        ledger.fail(op, t("无法确认日期是否更新，请刷新并核对记录后再操作。"));
        if (stillCurrent()) setError(t("无法确认日期是否更新，请检查记录后重试。"));
      }
    } finally {
      if (stillCurrent()) { busyRef.current = false; setBusy(false); }
      refreshWrites(onMutate);
    }
  };

  /** Move an event to a day (Month view or All-day row), preserving HH:mm in month view or clearing time in all-day row. */
  const move = async (day: string, rid: number, targetMode: "preserve-time" | "all-day" | { hour: number } = "preserve-time") => {
    if (!canEdit || busyRef.current || ledger.blocked("batch") || !calendarDate(day)) return;
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.baseId !== baseId || drag.recordId !== rid || drag.fieldId !== dateField.id) return;
    const record = recordsRef.current.find((r) => r.id === rid);
    if (!record) { setError(t("记录已发生变化，请刷新后重试。")); onMutate(); return; }
    const actualStart = (record.cells[dateField.id] ?? null) as string | null;
    const actualEnd = hasSeparateEnd && endDateField ? ((record.cells[endDateField.id] ?? null) as string | null) : null;
    if (actualStart !== drag.expectedStart || actualEnd !== drag.expectedEnd) {
      setError(t("日期已被修改，请检查后重新拖动。"));
      onMutate();
      return;
    }

    let nextStart = day;
    let nextEnd: string | null = actualEnd;
    if (typeof targetMode === "object") {
      const startMin = targetMode.hour * 60;
      const oldSpan = calendarTimedSpan(actualStart, actualEnd, !hasSeparateEnd);
      const dur = oldSpan ? oldSpan.duration : 60;
      nextStart = formatCalendarDateTime(day, startMin);
      nextEnd = hasSeparateEnd ? formatCalendarDateTime(day, Math.min(23 * 60 + 59, startMin + dur)) : null;
    } else if (targetMode === "all-day") {
      nextStart = day;
      if (hasSeparateEnd && actualEnd) {
        const parsedStart = calendarDateTime(actualStart);
        const parsedEnd = calendarDateTime(actualEnd);
        if (parsedStart && parsedEnd) {
          const spanDays = Math.max(0, dayDiff(parsedStart.dayKey, parsedEnd.dayKey));
          nextEnd = calendarKey(addDays(calendarDate(day)!, spanDays));
        } else {
          nextEnd = day;
        }
      }
    } else {
      const parsedStart = calendarDateTime(actualStart);
      if (parsedStart && !parsedStart.isAllDay && parsedStart.minutes !== null) {
        nextStart = formatCalendarDateTime(day, parsedStart.minutes);
        if (hasSeparateEnd && actualEnd) {
          const delta = dayDiff(parsedStart.dayKey, day);
          nextEnd = shiftDateTimeByDays(actualEnd, delta) ?? actualEnd;
        }
      } else {
        nextStart = day;
        if (hasSeparateEnd && actualEnd && parsedStart) {
          const delta = dayDiff(parsedStart.dayKey, day);
          nextEnd = shiftDateTimeByDays(actualEnd, delta) ?? actualEnd;
        }
      }
    }

    await commitDateChange(rid, drag.expectedStart, drag.expectedEnd, nextStart, nextEnd, t("调整日历排期"));
  };

  const add = async (day: string, hour?: number) => {
    if (!canEdit || busyRef.current || ledger.blocked("batch") || !calendarDate(day)) return;
    const startVal = hour === undefined ? day : formatCalendarDateTime(day, hour * 60);
    const endVal = hour !== undefined && hasSeparateEnd
      ? formatCalendarDateTime(day, Math.min(23 * 60 + 59, (hour + 1) * 60))
      : undefined;
    const op = ledger.begin(t("日历新增记录"), startVal, "record:create");
    if (op === null) return;
    const requestedBase = baseId, generation = scope.current.generation;
    const stillCurrent = () => scope.current.mounted && scope.current.baseId === requestedBase && scope.current.generation === generation;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const payload: Record<string, Cell> = { [dateField.id]: startVal };
      if (endVal && endDateField) payload[endDateField.id] = endVal;
      const rec = await baseApi.addRecord(requestedBase, payload, tableId);
      ledger.complete(op);
      onRecordUndo?.({
        label: hour === undefined ? t("日历新增记录") : t("新增小时排程"),
        cells: [],
        created: [{ rid: rec.id, cells: definedCells(rec.cells) }],
      });
    } catch {
      ledger.fail(op, t("无法确认日程是否创建，请刷新并核对记录，勿直接重复新增。"));
      if (stillCurrent()) setError(t("无法确认日程是否创建，请检查记录后重试。"));
    } finally {
      if (stillCurrent()) { busyRef.current = false; setBusy(false); }
      refreshWrites(onMutate);
    }
  };

  /** Start smooth pointer drag (move across hours/days or resize duration bottom edge) in Week/Day hourly grid. */
  const startTimedPointer = (
    mode: "move" | "resize",
    record: BaseRecord,
    span: { dayKey: string; startMin: number; endMin: number; duration: number },
    e: React.PointerEvent,
  ) => {
    if (!canEdit || busyRef.current || ledger.blocked("batch") || ledger.blocked(`cell:${record.id}:${dateField.id}`)) return;
    if (mode === "resize" && !hasSeparateEnd) return;
    e.stopPropagation();
    e.preventDefault();
    cleanupPointerRef.current?.();

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const origStartRaw = (record.cells[dateField.id] ?? null) as string | null;
    const origEndRaw = hasSeparateEnd && endDateField ? ((record.cells[endDateField.id] ?? null) as string | null) : null;
    const dayKeys = days.map(calendarKey);
    const origDayIndex = dayKeys.indexOf(span.dayKey);
    let moved = false;
    let latest: PointerScheduleDraft = {
      recordId: record.id,
      mode,
      dayKey: span.dayKey,
      startMin: span.startMin,
      endMin: span.endMin,
    };

    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startClientY;
      const dx = ev.clientX - startClientX;
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      moved = true;
      const deltaSnaps = Math.round(dy / ((HOUR_HEIGHT * SNAP_MINUTES) / 60));
      const deltaMin = deltaSnaps * SNAP_MINUTES;

      if (mode === "move") {
        let nextDayKey = span.dayKey;
        if (dayKeys.length > 1 && hourlyGridRef.current && origDayIndex >= 0) {
          const rect = hourlyGridRef.current.getBoundingClientRect();
          const colW = rect.width / dayKeys.length;
          if (colW > 0) {
            const targetIdx = Math.max(0, Math.min(dayKeys.length - 1, Math.floor((ev.clientX - rect.left) / colW)));
            nextDayKey = dayKeys[targetIdx];
          }
        }
        const nextStart = Math.max(0, Math.min(24 * 60 - span.duration, span.startMin + deltaMin));
        latest = {
          recordId: record.id,
          mode,
          dayKey: nextDayKey,
          startMin: nextStart,
          endMin: nextStart + span.duration,
        };
      } else {
        const nextEnd = Math.max(span.startMin + SNAP_MINUTES, Math.min(24 * 60 - 1, span.endMin + deltaMin));
        latest = {
          recordId: record.id,
          mode,
          dayKey: span.dayKey,
          startMin: span.startMin,
          endMin: nextEnd,
        };
      }
      setPointerDraft(latest);
    };

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      cleanupPointerRef.current = null;
      setPointerDraft(null);
      if (!moved) {
        if (mode === "move") onOpen?.(record);
        return;
      }
      const nextStart = formatCalendarDateTime(latest.dayKey, latest.startMin);
      const nextEnd = hasSeparateEnd ? formatCalendarDateTime(latest.dayKey, Math.min(23 * 60 + 59, latest.endMin)) : null;
      void commitDateChange(
        record.id,
        origStartRaw,
        origEndRaw,
        nextStart,
        nextEnd,
        mode === "resize" ? t("调整日程时长") : t("调整小时排程"),
      );
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    cleanupPointerRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  };

  const eventChip = (record: BaseRecord) => {
    const name = label(record);
    const parsed = calendarDateTime(record.cells[dateField.id]);
    const timeTag = parsed && !parsed.isAllDay && parsed.minutes !== null ? formatMinutesHHMM(parsed.minutes) : null;
    return (
      <button
        key={record.id}
        type="button"
        aria-disabled={!onOpen || undefined}
        tabIndex={onOpen ? 0 : -1}
        draggable={canEdit && !busy && !ledger.blocked("batch") && !ledger.blocked(`cell:${record.id}:${dateField.id}`)}
        onClick={() => onOpen?.(record)}
        onDragStart={(e) => {
          if (!canEdit || busy || ledger.blocked("batch") || ledger.blocked(`cell:${record.id}:${dateField.id}`)) { e.preventDefault(); return; }
          const raw = record.cells[dateField.id];
          if (raw != null && !calendarDateTime(raw)) { e.preventDefault(); setError(t("记录日期无效，请先在详情中修正。")); return; }
          const endRaw = hasSeparateEnd && endDateField ? record.cells[endDateField.id] : null;
          dragRef.current = {
            baseId,
            recordId: record.id,
            fieldId: dateField.id,
            expectedStart: raw == null ? null : (raw as string),
            expectedEnd: endRaw == null ? null : (endRaw as string),
          };
          e.dataTransfer.setData("text/rid", String(record.id));
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => { dragRef.current = null; }}
        className={cn(
          "flex w-full items-center gap-1 truncate rounded bg-[#edf2ff] px-2 py-1 text-left text-[12px] text-primary",
          onOpen && "hover:bg-[#e1eaff]",
          canEdit && "cursor-grab",
        )}
        title={timeTag ? `${timeTag} ${name}` : name}
        data-event={record.id}
      >
        {timeTag && <span className="shrink-0 font-mono text-[10px] font-semibold text-[#245bdb]">{timeTag}</span>}
        <span className="truncate">{name}</span>
      </button>
    );
  };

  const range = scale === "month"
    ? t("{y} 年 {m} 月", { y: cursor.getUTCFullYear(), m: cursor.getUTCMonth() + 1 })
    : scale === "day"
      ? t("{y} 年 {m} 月 {d} 日", { y: cursor.getUTCFullYear(), m: cursor.getUTCMonth() + 1, d: cursor.getUTCDate() })
      : `${days[0].getUTCFullYear()}/${days[0].getUTCMonth() + 1}/${days[0].getUTCDate()} – ${days[6].getUTCFullYear()}/${days[6].getUTCMonth() + 1}/${days[6].getUTCDate()}`;

  const nowDate = new Date();
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-calendar data-calendar-scale={scale}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[14px] font-medium">
        <button type="button" aria-label={t("上一时间段")} className="grid size-8 place-items-center rounded hover:bg-hover" onClick={() => setCursor((c) => shiftCalendar(c, scale, -1))}>‹</button>
        <button type="button" aria-label={t("下一时间段")} className="grid size-8 place-items-center rounded hover:bg-hover" onClick={() => setCursor((c) => shiftCalendar(c, scale, 1))}>›</button>
        <button type="button" className="h-8 rounded-md border px-3 text-[13px] font-normal hover:bg-hover" onClick={() => setCursor(todayCalendar())}>{t("今天")}</button>
        <span className="min-w-[160px]" aria-live="polite">{range}</span>
        <span className="hidden text-[12px] font-normal text-subtle sm:inline">
          {hasSeparateEnd && endDateField
            ? t("按「{start}」–「{end}」排布", { start: dateField.name, end: endDateField.name })
            : t("按「{name}」排布", { name: dateField.name })}
        </span>
        <div className="ml-auto flex rounded-md border p-0.5 text-[12px] font-normal" role="group" aria-label={t("日历显示维度")}>
          {([["day", "日"], ["week", "周"], ["month", "月"]] as const).map(([value, name]) => (
            <button
              key={value}
              type="button"
              data-calendar-scale-btn={value}
              aria-pressed={scale === value}
              className={cn("rounded px-3 py-1", scale === value ? "bg-accent text-primary" : "text-muted-foreground hover:bg-hover")}
              onClick={() => setScale(value)}
            >
              {t(name)}
            </button>
          ))}
        </div>
      </div>
      {error && <div role="alert" className="border-b px-4 py-2 text-[12px] text-destructive">{error}</div>}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {scale === "month" ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            <div className="flex min-h-full min-w-[700px] flex-col">
              <div className="grid border-b bg-sidebar/60 text-center text-[12px] text-muted-foreground" style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}>
                {WEEK.map((w) => <div key={w} className="py-2">{t("周{day}", { day: t(w) })}</div>)}
              </div>
              <div className="grid flex-1" style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}>
                {days.map((day) => {
                  const key = calendarKey(day), isToday = key === today, list = byDay.get(key) ?? [];
                  return (
                    <div
                      key={key}
                      className={cn("min-h-28 border-b border-r p-2", day.getUTCMonth() !== cursor.getUTCMonth() && "bg-sidebar/30", isToday && "bg-accent/30")}
                      data-day={key}
                      onDragOver={(e) => { if (canEdit && !busy) e.preventDefault(); }}
                      onDrop={(e) => { if (!canEdit || busy) return; e.preventDefault(); const rid = Number(e.dataTransfer.getData("text/rid")); if (Number.isSafeInteger(rid) && rid > 0) void move(key, rid, "preserve-time"); }}
                    >
                      <div className={cn("mb-1 inline-grid size-6 place-items-center rounded-full text-[12px]", isToday ? "bg-primary font-medium text-white" : "text-subtle")}>{day.getUTCDate()}</div>
                      <div className="space-y-1">
                        {list.map(eventChip)}
                        {canEdit && (
                          <button
                            type="button"
                            disabled={busy || ledger.blocked("batch") || ledger.blocked("record:create")}
                            className="w-full rounded px-1 text-left text-[12px] text-subtle hover:bg-hover disabled:opacity-50"
                            aria-label={t("{key} 新增记录", { key })}
                            onClick={() => void add(key)}
                          >
                            ＋
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          /* Week & Day Hourly Schedule Grid (00:00 – 23:00 with All-day band, 30-min drag/resize snap) */
          <div ref={hourlyScrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto" data-calendar-hourly-grid>
            <div className={cn("flex flex-col", scale === "week" && "min-w-[760px]")}>
              {/* Sticky weekday + date header */}
              <div className="sticky top-0 z-20 flex border-b bg-surface">
                <div className="flex w-14 shrink-0 items-center justify-center border-r bg-sidebar/60 text-[11px] text-subtle">
                  <Clock size={13} />
                </div>
                <div className="grid min-w-0 flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
                  {days.map((day) => {
                    const key = calendarKey(day);
                    const isToday = key === today;
                    const wd = WEEK[(day.getUTCDay() + 6) % 7];
                    return (
                      <div key={key} className={cn("flex items-center justify-center gap-1.5 border-r py-2 text-[12px]", isToday ? "bg-accent/40 font-semibold text-primary" : "bg-sidebar/60 text-muted-foreground")}>
                        <span>{t("周{day}", { day: t(wd) })}</span>
                        <span className={cn("inline-grid size-6 place-items-center rounded-full", isToday && "bg-primary text-white")}>{day.getUTCDate()}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Sticky All-day row */}
              <div className="sticky top-[41px] z-10 flex border-b bg-surface/95 backdrop-blur-sm">
                <div className="flex w-14 shrink-0 items-center justify-center border-r py-1.5 text-[11px] text-subtle">
                  {t("全天")}
                </div>
                <div className="grid min-w-0 flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
                  {days.map((day) => {
                    const key = calendarKey(day);
                    const dayAll = (byDay.get(key) ?? []).filter((r) => calendarDateTime(r.cells[dateField.id])?.isAllDay);
                    return (
                      <div
                        key={key}
                        data-day={key}
                        data-calendar-allday={key}
                        onDragOver={(e) => { if (canEdit && !busy) e.preventDefault(); }}
                        onDrop={(e) => { if (!canEdit || busy) return; e.preventDefault(); const rid = Number(e.dataTransfer.getData("text/rid")); if (Number.isSafeInteger(rid) && rid > 0) void move(key, rid, "all-day"); }}
                        className="min-h-10 space-y-1 border-r p-1.5"
                      >
                        {dayAll.map(eventChip)}
                        {canEdit && (
                          <button
                            type="button"
                            disabled={busy || ledger.blocked("batch") || ledger.blocked("record:create")}
                            className="w-full rounded px-1 text-left text-[11px] text-subtle hover:bg-hover disabled:opacity-50"
                            aria-label={t("{key} 新增记录", { key })}
                            onClick={() => void add(key)}
                          >
                            ＋
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 24-Hour Timed Grid */}
              <div className="relative flex" style={{ height: 24 * HOUR_HEIGHT }}>
                {/* Left Time Ruler */}
                <div className="w-14 shrink-0 border-r bg-sidebar/30 text-right text-[10px] font-mono text-subtle select-none">
                  {HOURS.map((h) => (
                    <div key={h} className="relative pr-2" style={{ height: HOUR_HEIGHT }}>
                      <span className="relative -top-2">{`${String(h).padStart(2, "0")}:00`}</span>
                    </div>
                  ))}
                </div>

                {/* Day Columns */}
                <div ref={hourlyGridRef} className="relative grid min-w-0 flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
                  {days.map((day) => {
                    const key = calendarKey(day);
                    const isToday = key === today;
                    // Collect timed events belonging to this day (including active pointer draft moved onto this day).
                    const timedEntries: { rec: BaseRecord; span: { dayKey: string; startMin: number; endMin: number; duration: number }; isDraft: boolean }[] = [];
                    for (const rec of records) {
                      const span = calendarTimedSpan(rec.cells[dateField.id], endDateField ? rec.cells[endDateField.id] : null, !hasSeparateEnd);
                      if (!span) continue;
                      if (pointerDraft?.recordId === rec.id) {
                        if (pointerDraft.dayKey === key) {
                          timedEntries.push({
                            rec,
                            span: { dayKey: key, startMin: pointerDraft.startMin, endMin: pointerDraft.endMin, duration: pointerDraft.endMin - pointerDraft.startMin },
                            isDraft: true,
                          });
                        }
                      } else if (span.dayKey === key) {
                        timedEntries.push({ rec, span, isDraft: false });
                      }
                    }
                    const layout = layoutDayTimedEvents(timedEntries.map((x) => ({ id: x.rec.id, startMin: x.span.startMin, endMin: x.span.endMin })));

                    return (
                      <div key={key} className={cn("relative border-r", isToday && "bg-accent/15")} data-calendar-day-col={key}>
                        {HOURS.map((h) => (
                          <div
                            key={h}
                            data-calendar-slot={`${key}:${String(h).padStart(2, "0")}`}
                            onClick={() => { if (canEdit && !busy) void add(key, h); }}
                            onDragOver={(e) => { if (canEdit && !busy) e.preventDefault(); }}
                            onDrop={(e) => {
                              if (!canEdit || busy) return;
                              e.preventDefault();
                              const rid = Number(e.dataTransfer.getData("text/rid"));
                              if (Number.isSafeInteger(rid) && rid > 0) void move(key, rid, { hour: h });
                            }}
                            style={{ height: HOUR_HEIGHT }}
                            className={cn(
                              "border-b border-[#eff0f1] transition-colors",
                              canEdit && "cursor-pointer hover:bg-[#edf2ff]/40",
                            )}
                            title={canEdit ? t("点击在 {time} 新建排程", { time: `${key} ${String(h).padStart(2, "0")}:00` }) : undefined}
                          />
                        ))}

                        {/* Current-time indicator line */}
                        {isToday && (
                          <div
                            aria-hidden
                            className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                            style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                          >
                            <span className="-ml-1 size-2 rounded-full bg-[#f54a45]" />
                            <span className="h-[1.5px] flex-1 bg-[#f54a45]" />
                          </div>
                        )}

                        {/* Timed Event Cards */}
                        {timedEntries.map(({ rec, span, isDraft }) => {
                          const pos = layout.get(rec.id) ?? { col: 0, cols: 1 };
                          const topPx = (span.startMin / 60) * HOUR_HEIGHT;
                          const heightPx = Math.max(22, ((span.endMin - span.startMin) / 60) * HOUR_HEIGHT - 2);
                          const widthPct = 100 / pos.cols;
                          const leftPct = pos.col * widthPct;
                          const rangeText = `${formatMinutesHHMM(span.startMin)}–${formatMinutesHHMM(span.endMin)}`;
                          return (
                            <div
                              key={rec.id}
                              data-calendar-timed-event={rec.id}
                              data-event={rec.id}
                              data-calendar-time-range={rangeText}
                              onPointerDown={(e) => startTimedPointer("move", rec, span, e)}
                              style={{
                                top: topPx + 1,
                                height: heightPx,
                                left: `calc(${leftPct}% + 2px)`,
                                width: `calc(${widthPct}% - 4px)`,
                              }}
                              className={cn(
                                "absolute z-10 flex flex-col overflow-hidden rounded-md border border-[#c4d5ff] border-l-[3px] border-l-[#3370ff] bg-[#edf2ff] px-1.5 py-0.5 text-[11px] text-[#1f2329] shadow-sm select-none",
                                canEdit && !busy && "cursor-grab active:cursor-grabbing",
                                isDraft && "z-20 ring-2 ring-[#3370ff] shadow-md opacity-95",
                              )}
                              title={`${rangeText} ${label(rec)}`}
                            >
                              <div className="flex items-center justify-between gap-1 leading-tight">
                                <span className="truncate font-semibold text-[#1f2329]">{label(rec)}</span>
                                <span className="shrink-0 font-mono text-[10px] text-[#245bdb]">{rangeText}</span>
                              </div>
                              {canEdit && hasSeparateEnd && !busy && (
                                <div
                                  data-calendar-event-resize={rec.id}
                                  title={t("拖拽调整时长")}
                                  onPointerDown={(e) => startTimedPointer("resize", rec, span, e)}
                                  className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize hover:bg-[#3370ff]/25"
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {unscheduled.length > 0 && (
          <aside className="w-full shrink-0 border-t p-3 lg:w-56 lg:border-l lg:border-t-0 overflow-y-auto" aria-label={t("未排期记录")}>
            <div className="mb-2 text-[13px] font-medium">{t("未排期")} <span className="text-subtle">{unscheduled.length}</span></div>
            <p className="mb-2 text-[12px] text-subtle">{canEdit ? t("日期为空或无效的记录不会显示在日历中，可拖至日期或时段安排。") : t("日期为空或无效的记录不会显示在日历中。")}</p>
            <div className="space-y-1">{unscheduled.map(eventChip)}</div>
          </aside>
        )}
      </div>
    </div>
  );
}

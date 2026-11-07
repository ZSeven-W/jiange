import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, baseApi, type BaseRecord, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { displayValue } from "./registry";
import { refreshWrites, useWriteLedger } from "./writeSafety";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
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

/** Group only valid date-only values. Missing/invalid dates never become today. */
export function groupCalendarRecords(records: BaseRecord[], dateFieldId?: number): { byDay: Map<string, BaseRecord[]>; unscheduled: BaseRecord[] } {
  const byDay = new Map<string, BaseRecord[]>();
  const unscheduled: BaseRecord[] = [];
  for (const record of records) {
    const raw = dateFieldId === undefined ? undefined : record.cells[dateFieldId];
    if (!calendarDate(raw)) { unscheduled.push(record); continue; }
    const key = raw as string;
    const list = byDay.get(key);
    if (list) list.push(record); else byDay.set(key, [record]);
  }
  return { byDay, unscheduled };
}

function todayCalendar(): Date {
  const now = new Date();
  // Today follows the user's timezone; subsequent arithmetic stays in UTC civil days.
  return calendarDate(`${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`)!;
}

/** Calendar view over a date field; all views operate on the same records. */
export function CalendarView({
  baseId, canEdit, fields, records, members, dateFieldId, onMutate, onOpen,
}: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  records: BaseRecord[];
  members: User[];
  dateFieldId?: number | null;
  onMutate: () => void;
  onOpen?: (record: BaseRecord) => void;
}) {
  const dateField = fields.find((f) => f.id === dateFieldId && f.type === "date") ?? fields.find((f) => f.type === "date");
  const title = fields.find((f) => f.type === "text") ?? fields[0];
  const [cursor, setCursor] = useState(todayCalendar);
  const [scale, setScale] = useState<CalendarScale>("month");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const { ledger } = useWriteLedger(baseId);
  const scope = useRef({ baseId, generation: 0, mounted: true });
  if (scope.current.baseId !== baseId) scope.current = { baseId, generation: scope.current.generation + 1, mounted: true };
  useEffect(() => {
    scope.current.mounted = true;
    return () => { scope.current.mounted = false; };
  }, []);
  // Capture the date at drag start; a newer render must not silently replace it.
  const dragRef = useRef<{ baseId: number; recordId: number; fieldId: number; expected: string | null } | null>(null);
  useEffect(() => { dragRef.current = null; busyRef.current = false; setBusy(false); setError(null); }, [baseId]);
  const { byDay, unscheduled } = useMemo(() => groupCalendarRecords(records, dateField?.id), [records, dateField?.id]);
  const days = useMemo(() => calendarDays(cursor, scale), [cursor, scale]);
  const today = calendarKey(todayCalendar());

  if (!dateField) return <div className="grid flex-1 place-items-center px-4 text-center text-[14px] text-muted-foreground"><p>日历需要日期字段，请先在表格视图中添加日期字段。</p></div>;

  const label = (record: BaseRecord) => title ? String(displayValue(record, title, members) ?? "") || "未命名" : "未命名";
  const move = async (day: string, rid: number) => {
    if (!canEdit || busyRef.current || ledger.blocked("batch") || !calendarDate(day)) return;
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.baseId !== baseId || drag.recordId !== rid || drag.fieldId !== dateField.id) return;
    const record = records.find((r) => r.id === rid);
    if (!record) { setError("记录已发生变化，请刷新后重试。"); onMutate(); return; }
    if ((record.cells[dateField.id] ?? null) !== drag.expected) { setError("日期已被修改，请检查后重新拖动。"); onMutate(); return; }
    if (drag.expected === day) return;
    const op = ledger.begin(`记录 #${rid} · ${dateField.name}`, day, `cell:${rid}:${dateField.id}`, undefined, false, true);
    if (op === null) return;
    const requestedBase = baseId, generation = scope.current.generation;
    const stillCurrent = () => scope.current.mounted && scope.current.baseId === requestedBase && scope.current.generation === generation;
    busyRef.current = true; setBusy(true); setError(null);
    try { await baseApi.compareCells(requestedBase, rid, { [dateField.id]: drag.expected }, { [dateField.id]: day }); ledger.complete(op); }
    catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "conflict") { ledger.complete(op); if (stillCurrent()) setError("日期已被修改，请检查后重新拖动。"); }
      else { ledger.fail(op, "无法确认日期是否更新，请刷新并核对记录后再操作。"); if (stillCurrent()) setError("无法确认日期是否更新，请检查记录后重试。"); }
    }
    finally { if (stillCurrent()) { busyRef.current = false; setBusy(false); } refreshWrites(onMutate); }
  };
  const add = async (day: string) => {
    if (!canEdit || busyRef.current || ledger.blocked("batch") || !calendarDate(day)) return;
    const op = ledger.begin("日历新增记录", day, "record:create");
    if (op === null) return;
    const requestedBase = baseId, generation = scope.current.generation;
    const stillCurrent = () => scope.current.mounted && scope.current.baseId === requestedBase && scope.current.generation === generation;
    busyRef.current = true; setBusy(true); setError(null);
    try { await baseApi.addRecord(requestedBase, { [dateField.id]: day }); ledger.complete(op); }
    catch { ledger.fail(op, "无法确认日程是否创建，请刷新并核对记录，勿直接重复新增。"); if (stillCurrent()) setError("无法确认日程是否创建，请检查记录后重试。"); }
    finally { if (stillCurrent()) { busyRef.current = false; setBusy(false); } refreshWrites(onMutate); }
  };
  const event = (record: BaseRecord) => {
    const name = label(record);
    return <button key={record.id} type="button" aria-disabled={!onOpen || undefined} tabIndex={onOpen ? 0 : -1} draggable={canEdit && !busy && !ledger.blocked("batch") && !ledger.blocked(`cell:${record.id}:${dateField.id}`)} onClick={() => onOpen?.(record)} onDragStart={(e) => {
      if (!canEdit || busy || ledger.blocked("batch") || ledger.blocked(`cell:${record.id}:${dateField.id}`)) { e.preventDefault(); return; }
      const raw = record.cells[dateField.id];
      if (raw != null && !calendarDate(raw)) { e.preventDefault(); setError("记录日期无效，请先在详情中修正。"); return; }
      dragRef.current = { baseId, recordId: record.id, fieldId: dateField.id, expected: raw == null ? null : raw as string };
      e.dataTransfer.setData("text/rid", String(record.id)); e.dataTransfer.effectAllowed = "move";
    }} onDragEnd={() => { dragRef.current = null; }} className={cn("block w-full truncate rounded bg-[#edf2ff] px-2 py-1 text-left text-[12px] text-primary", onOpen && "hover:bg-[#e1eaff]", canEdit && "cursor-grab")} title={name} data-event={record.id}>{name}</button>;
  };
  const range = scale === "month" ? `${cursor.getUTCFullYear()} 年 ${cursor.getUTCMonth() + 1} 月` : scale === "day" ? `${cursor.getUTCFullYear()} 年 ${cursor.getUTCMonth() + 1} 月 ${cursor.getUTCDate()} 日` : `${days[0].getUTCFullYear()}/${days[0].getUTCMonth() + 1}/${days[0].getUTCDate()} – ${days[6].getUTCFullYear()}/${days[6].getUTCMonth() + 1}/${days[6].getUTCDate()}`;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-calendar>
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[14px] font-medium">
      <button type="button" aria-label="上一时间段" className="grid size-8 place-items-center rounded hover:bg-hover" onClick={() => setCursor((c) => shiftCalendar(c, scale, -1))}>‹</button>
      <button type="button" aria-label="下一时间段" className="grid size-8 place-items-center rounded hover:bg-hover" onClick={() => setCursor((c) => shiftCalendar(c, scale, 1))}>›</button>
      <button type="button" className="h-8 rounded-md border px-3 text-[13px] font-normal hover:bg-hover" onClick={() => setCursor(todayCalendar())}>今天</button>
      <span className="min-w-[160px]" aria-live="polite">{range}</span>
      <span className="hidden text-[12px] font-normal text-subtle sm:inline">按「{dateField.name}」排布</span>
      <div className="ml-auto flex rounded-md border p-0.5 text-[12px] font-normal" role="group" aria-label="日历显示维度">{([['day', '日'], ['week', '周'], ['month', '月']] as const).map(([value, name]) => <button key={value} type="button" aria-pressed={scale === value} className={cn("rounded px-3 py-1", scale === value ? "bg-accent text-primary" : "text-muted-foreground hover:bg-hover")} onClick={() => setScale(value)}>{name}</button>)}</div>
    </div>
    {error && <div role="alert" className="border-b px-4 py-2 text-[12px] text-destructive">{error}</div>}
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row">
      <div className="min-h-0 min-w-0 flex-1 overflow-x-auto">
        <div className={cn("flex min-h-full flex-col", scale !== "day" && "min-w-[700px]")}>
          <div className="grid border-b bg-sidebar/60 text-center text-[12px] text-muted-foreground" style={{ gridTemplateColumns: `repeat(${scale === "day" ? 1 : 7}, minmax(0, 1fr))` }}>
            {(scale === "day" ? [WEEK[(cursor.getUTCDay() + 6) % 7]] : WEEK).map((w) => <div key={w} className="py-2">周{w}</div>)}
          </div>
          <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${scale === "day" ? 1 : 7}, minmax(0, 1fr))` }}>
            {days.map((day) => {
              const key = calendarKey(day), isToday = key === today, list = byDay.get(key) ?? [];
              return <div key={key} className={cn("min-h-28 border-b border-r p-2", scale === "month" && day.getUTCMonth() !== cursor.getUTCMonth() && "bg-sidebar/30", isToday && "bg-accent/30")} data-day={key}
                onDragOver={(e) => { if (canEdit && !busy) e.preventDefault(); }} onDrop={(e) => { if (!canEdit || busy) return; e.preventDefault(); const rid = Number(e.dataTransfer.getData("text/rid")); if (Number.isSafeInteger(rid) && rid > 0) void move(key, rid); }}>
                <div className={cn("mb-1 inline-grid size-6 place-items-center rounded-full text-[12px]", isToday ? "bg-primary font-medium text-white" : "text-subtle")}>{day.getUTCDate()}</div>
                <div className="space-y-1">{list.map(event)}{canEdit && <button type="button" disabled={busy || ledger.blocked("batch") || ledger.blocked("record:create")} className="w-full rounded px-1 text-left text-[12px] text-subtle hover:bg-hover disabled:opacity-50" aria-label={`${key} 新增记录`} onClick={() => void add(key)}>＋</button>}</div>
              </div>;
            })}
          </div>
        </div>
      </div>
      {unscheduled.length > 0 && <aside className="w-full shrink-0 border-t p-3 lg:w-56 lg:border-l lg:border-t-0" aria-label="未排期记录"><div className="mb-2 text-[13px] font-medium">未排期 <span className="text-subtle">{unscheduled.length}</span></div><p className="mb-2 text-[12px] text-subtle">日期为空或无效的记录不会显示在日历中{canEdit ? "，可拖至日期安排。" : "。"}</p><div className="space-y-1">{unscheduled.map(event)}</div></aside>}
    </div>
  </div>;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { calendarDate, calendarKey } from "./CalendarView";
import { recordTitle } from "./registry";

const DAY = 24 * 60 * 60 * 1000;
const DAY_WIDTH = 30;

/** A date-only value is a civil day, independent of local offsets and DST. */
export function ganttDay(value: unknown): number | null {
  const date = calendarDate(value);
  return date ? Math.floor(date.getTime() / DAY) : null;
}

export function ganttDate(day: number): string | null {
  if (!Number.isSafeInteger(day)) return null;
  const date = new Date(day * DAY + DAY / 2);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return null;
  return calendarKey(date);
}

export interface GanttRange { start: number; end: number; hasEnd: boolean }
/** Incomplete and reversed ranges cannot safely be rescheduled as a valid span. */
export function ganttRange(start: unknown, end: unknown, sameField: boolean): GanttRange | null {
  const first = ganttDay(start);
  if (first === null) return null;
  if (sameField || end === undefined || end === null) return { start: first, end: first, hasEnd: false };
  const last = ganttDay(end);
  if (last === null || last < first) return null;
  return { start: first, end: last, hasEnd: true };
}

/** Preserve the untrimmed span and the grabbed day, not the visible-month slice. */
export function rescheduleGantt(range: GanttRange, dropDay: number, grabbedOffset: number): { start: string; end: string | null } | null {
  if (!Number.isSafeInteger(dropDay) || !Number.isSafeInteger(grabbedOffset) || grabbedOffset < 0 || grabbedOffset > range.end - range.start) return null;
  const first = dropDay - grabbedOffset;
  const start = ganttDate(first), end = range.hasEnd ? ganttDate(first + range.end - range.start) : null;
  return start && (!range.hasEnd || end) ? { start, end } : null;
}

/** Resolve a drop against the actual scrollable timeline, including its width. */
export function ganttDropIndex(clientX: number, left: number, width: number, days: number): number | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0 || !Number.isInteger(days) || days <= 0) return null;
  const x = clientX - left;
  if (x < 0 || x >= width) return null;
  return Math.min(days - 1, Math.floor((x / width) * days));
}

/** Both request maps contain the same fields; an empty end date stays empty. */
export function ganttMoveCells(startField: number, endField: number, startValue: Cell | undefined, endValue: Cell | undefined, target: { start: string; end: string | null }): { expected: Record<string, Cell | null>; cells: Record<string, Cell | null> } {
  const expected: Record<string, Cell | null> = { [startField]: startValue ?? null };
  const cells: Record<string, Cell | null> = { [startField]: target.start };
  if (endField !== startField) {
    expected[endField] = endValue ?? null;
    cells[endField] = target.end ?? endValue ?? null;
  }
  return { expected, cells };
}

type DragState = { id: number; startField: number; endField: number; startValue: Cell | undefined; endValue: Cell | undefined; range: GanttRange; grabbedOffset: number };
type Bar = { rec: BaseRecord; range: GanttRange; visibleStart: number; visibleEnd: number; label: string };

/** Month timeline over the same date fields and records as other views. */
export function Gantt({ baseId, canEdit, fields, records, members, startFieldId, endFieldId, onMutate, onOpen }: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  records: BaseRecord[];
  members: User[];
  startFieldId?: number | null;
  endFieldId?: number | null;
  onMutate: () => void;
  onOpen?: (record: BaseRecord) => void;
}) {
  const dateFields = fields.filter((f) => f.type === "date");
  const startField = fields.find((f) => f.id === startFieldId && f.type === "date") ?? dateFields[0];
  const endField = fields.find((f) => f.id === endFieldId && f.type === "date") ?? dateFields[1] ?? startField;
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const recordsRef = useRef(records); recordsRef.current = records;
  const scope = useRef({ baseId, generation: 0 });
  if (scope.current.baseId !== baseId) scope.current = { baseId, generation: scope.current.generation + 1 };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { busyRef.current = false; setBusy(false); setError(null); dragRef.current = null; }, [baseId]);
  const monthKey = `${String(month.year).padStart(4, "0")}-${String(month.month).padStart(2, "0")}-01`;
  const first = ganttDay(monthKey);
  const days = new Date(Date.UTC(month.year, month.month, 0)).getUTCDate();
  const bars = useMemo(() => {
    if (!startField || !endField || first === null) return [];
    const out: Bar[] = [];
    for (const rec of records) {
      const range = ganttRange(rec.cells[startField.id], rec.cells[endField.id], startField.id === endField.id);
      if (!range || range.end < first || range.start >= first + days) continue;
      out.push({ rec, range, visibleStart: Math.max(range.start, first), visibleEnd: Math.min(range.end, first + days - 1), label: recordTitle(rec, fields, members) || "未命名" });
    }
    return out;
  }, [records, startField, endField, first, days, fields, members]);

  if (!startField || !endField || first === null) return <div className="grid flex-1 place-items-center px-4 text-center text-[14px] text-muted-foreground"><p>甘特需要日期字段，请先添加日期字段作为开始时间。</p></div>;

  const shiftMonth = (amount: number) => setMonth((current) => {
    const index = current.year * 12 + current.month - 1 + amount;
    const year = Math.floor(index / 12), nextMonth = index - year * 12 + 1;
    return year >= 1 && year <= 9999 ? { year, month: nextMonth } : current;
  });

  const drop = async (dropDay: number) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !canEdit || busyRef.current || drag.startField !== startField.id || drag.endField !== endField.id) return;
    const record = recordsRef.current.find((r) => r.id === drag.id);
    // Catch changes already received before sending the server-side CAS.
    if (!record || record.cells[startField.id] !== drag.startValue || record.cells[endField.id] !== drag.endValue) {
      setError("记录日期已变化，请检查后重新拖动。"); return;
    }
    const target = rescheduleGantt(drag.range, dropDay, drag.grabbedOffset);
    if (!target) { setError("目标日期超出支持范围，记录未修改。"); return; }
    const { expected, cells } = ganttMoveCells(startField.id, endField.id, drag.startValue, drag.endValue, target);
    if (record.cells[startField.id] === target.start && (target.end === null || record.cells[endField.id] === target.end)) return;
    const requestedBase = baseId, requestedGeneration = scope.current.generation;
    const stillCurrent = () => mounted.current && scope.current.baseId === requestedBase && scope.current.generation === requestedGeneration;
    busyRef.current = true; setBusy(true); setError(null);
    try { await baseApi.compareCells(requestedBase, drag.id, expected, cells); }
    catch (reason) {
      if (stillCurrent()) setError(reason instanceof ApiError && reason.status === 409 ? "记录日期已变化，请检查后重新拖动。" : "无法确认日期是否更新，请检查记录后重试。");
    }
    finally {
      if (stillCurrent()) { busyRef.current = false; setBusy(false); onMutate(); }
    }
  };

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-gantt>
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[14px] font-medium">
      <button type="button" aria-label="上个月" className="grid size-8 place-items-center rounded hover:bg-hover" onClick={() => shiftMonth(-1)}>‹</button>
      <button type="button" aria-label="下个月" className="grid size-8 place-items-center rounded hover:bg-hover" onClick={() => shiftMonth(1)}>›</button>
      <button type="button" className="h-8 rounded-md border px-3 text-[13px] font-normal hover:bg-hover" onClick={() => { const now = new Date(); setMonth({ year: now.getFullYear(), month: now.getMonth() + 1 }); }}>今天</button>
      <span aria-live="polite">{month.year} 年 {month.month} 月</span>
      <span className="hidden text-[12px] font-normal text-subtle sm:inline">开始「{startField.name}」– 结束「{endField.name}」</span>
    </div>
    {error && <div role="alert" className="border-b px-4 py-2 text-[12px] text-destructive">{error}</div>}
    <div className="min-h-0 flex-1 overflow-auto">
      <div style={{ minWidth: 192 + days * DAY_WIDTH }}>
        <div className="flex border-b bg-sidebar/60 text-center text-[11px] text-muted-foreground">
          <div className="w-48 shrink-0 py-1 pl-3 text-left">记录</div>
          {Array.from({ length: days }, (_, i) => {
            const day = new Date((first + i) * DAY + DAY / 2).getUTCDay();
            return <div key={i} className={cn("min-w-[30px] flex-1 py-1", (day === 0 || day === 6) && "text-subtle")}>{i + 1}</div>;
          })}
        </div>
        {bars.length === 0 && <p className="py-12 text-center text-[13px] text-subtle">本月没有排期的记录</p>}
        {bars.map((bar) => {
          const offset = bar.visibleStart - first, length = bar.visibleEnd - bar.visibleStart + 1;
          return <div key={bar.rec.id} className="flex items-stretch border-b" data-gantt-row={bar.rec.id}>
            <button type="button" className="w-48 shrink-0 truncate px-3 py-2 text-left text-[13px]" onClick={() => onOpen?.(bar.rec)} aria-disabled={!onOpen || undefined} tabIndex={onOpen ? 0 : -1} title={bar.label}>{bar.label}</button>
            <div className="relative flex min-h-9 min-w-0 flex-1" data-gantt-timeline={bar.rec.id} onDragOver={(e) => { if (canEdit && !busy && dragRef.current) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }} onDrop={(e) => {
              if (!canEdit || busy || !dragRef.current) return;
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect(), index = ganttDropIndex(e.clientX, rect.left, rect.width, days);
              if (index === null) { dragRef.current = null; return; }
              void drop(first + index);
            }}>
              {Array.from({ length: days }, (_, i) => {
                const weekday = new Date((first + i) * DAY + DAY / 2).getUTCDay();
                return <div key={i} data-gantt-day={i + 1} className={cn("min-w-[30px] flex-1 border-l", (weekday === 0 || weekday === 6) && "bg-sidebar/40")} />;
              })}
              <div draggable={canEdit && !busy} onDragStart={(e) => {
                if (!canEdit || busy) { e.preventDefault(); return; }
                const rect = e.currentTarget.getBoundingClientRect();
                const grabbedVisible = rect.width > 0 ? Math.max(0, Math.min(length - 1, Math.floor(((e.clientX - rect.left) / rect.width) * length))) : 0;
                dragRef.current = { id: bar.rec.id, startField: startField.id, endField: endField.id, startValue: bar.rec.cells[startField.id], endValue: bar.rec.cells[endField.id], range: bar.range, grabbedOffset: bar.visibleStart - bar.range.start + grabbedVisible };
                e.dataTransfer.setData("text/plain", String(bar.rec.id)); e.dataTransfer.effectAllowed = "move";
              }} onDragEnd={() => { dragRef.current = null; }} className={cn("absolute top-2 h-5 overflow-hidden rounded bg-primary/80 text-[11px] leading-5 text-white", canEdit && !busy && "cursor-grab")} style={{ left: `${(offset / days) * 100}%`, width: `${(length / days) * 100}%` }} title={`${bar.label}: ${ganttDate(bar.range.start)} – ${ganttDate(bar.range.end)}`} data-gantt-bar={bar.rec.id}>
                <span className="block truncate px-1.5">{bar.label}</span>
              </div>
            </div>
          </div>;
        })}
      </div>
    </div>
  </div>;
}

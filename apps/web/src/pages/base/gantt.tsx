import { useEffect, useId, useMemo, useRef, useState } from "react";
import { GitBranch, Trash2 } from "lucide-react";
import { t, useI18n } from "@/lib/i18n";
import { ApiError, baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { FeishuSelect } from "@/components/feishu-select";
import { calendarDate, calendarDateTime, calendarKey, formatCalendarDateTime } from "./calendar-view";
import { recordTitle } from "./registry";
import type { UndoCellChange, UndoStep } from "./undo";
import { BaseGanttGpuLayer } from "./base-gpu-layer";
import {
  addGanttDependency,
  computeGanttArrowPath,
  removeGanttDependency,
  sanitizeGanttDependencies,
  type GanttDependency,
} from "./gantt-dependencies";

const DAY = 24 * 60 * 60 * 1000;

export type GanttZoom = "month" | "bimonth" | "quarter";
const ZOOM_META: Record<GanttZoom, { months: number; dayWidth: number; label: string }> = {
  month: { months: 1, dayWidth: 32, label: "月" },
  bimonth: { months: 2, dayWidth: 22, label: "双月" },
  quarter: { months: 3, dayWidth: 16, label: "季度" },
};

/** A date-only value is a civil day, independent of local offsets and DST. */
export function ganttDay(value: unknown): number | null {
  const date = calendarDate(value);
  return date ? Math.floor(date.getTime() / DAY) : null;
}

/** Extracts civil day number and optional clock minutes for either YYYY-MM-DD or YYYY-MM-DD HH:mm. */
function ganttDayTime(value: unknown): { day: number; minutes: number | null } | null {
  const parsed = calendarDateTime(value);
  if (!parsed) return null;
  return { day: Math.floor(parsed.date.getTime() / DAY), minutes: parsed.minutes };
}

function formatGanttCell(day: number, minutes: number | null): string | null {
  const dateStr = ganttDate(day);
  if (!dateStr) return null;
  return minutes === null ? dateStr : formatCalendarDateTime(dateStr, minutes);
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
  const first = ganttDayTime(start);
  if (first === null) return null;
  if (sameField || end === undefined || end === null) return { start: first.day, end: first.day, hasEnd: false };
  const last = ganttDayTime(end);
  if (last === null || last.day < first.day) return null;
  return { start: first.day, end: last.day, hasEnd: true };
}

/** Preserve the untrimmed span and the grabbed day, not the visible-month slice. */
export function rescheduleGantt(range: GanttRange, dropDay: number, grabbedOffset: number): { start: string; end: string | null } | null {
  if (!Number.isSafeInteger(dropDay) || !Number.isSafeInteger(grabbedOffset) || grabbedOffset < 0 || grabbedOffset > range.end - range.start) return null;
  const first = dropDay - grabbedOffset;
  const start = ganttDate(first), end = range.hasEnd ? ganttDate(first + range.end - range.start) : null;
  return start && (!range.hasEnd || end) ? { start, end } : null;
}

/** Resize a Gantt range by dragging its start or end handle by deltaDays. */
export function resizeGanttRange(
  range: GanttRange,
  edge: "start" | "end",
  deltaDays: number,
  sameField: boolean,
): GanttRange | null {
  if (!Number.isSafeInteger(deltaDays) || sameField) return null;
  if (edge === "start") {
    const nextStart = Math.min(range.end, range.start + deltaDays);
    if (!ganttDate(nextStart) || !ganttDate(range.end)) return null;
    return { start: nextStart, end: range.end, hasEnd: true };
  }
  const nextEnd = Math.max(range.start, range.end + deltaDays);
  if (!ganttDate(range.start) || !ganttDate(nextEnd)) return null;
  return { start: range.start, end: nextEnd, hasEnd: true };
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
type PointerBarDraft = { id: number; mode: "move" | "resize-start" | "resize-end"; range: GanttRange };
type Bar = { rec: BaseRecord; range: GanttRange; visibleStart: number; visibleEnd: number; label: string };

/** Timeline Gantt view with real pointer drag-move, left/right edge resize, zoom, and Undo/Redo. */
export function Gantt({ baseId, canEdit, fields, records, members, startFieldId, endFieldId, dependencies, onChangeDependencies, onMutate, onOpen, onRecordUndo }: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  records: BaseRecord[];
  members: User[];
  startFieldId?: number | null;
  endFieldId?: number | null;
  dependencies?: GanttDependency[];
  onChangeDependencies?: (next: GanttDependency[]) => void;
  onMutate: () => void;
  onOpen?: (record: BaseRecord) => void;
  onRecordUndo?: (step: UndoStep) => void;
}) {
  useI18n();
  const dateFields = fields.filter((f) => f.type === "date");
  const autoStart = dateFields.find((f) => /开始|起始|start|begin/i.test(f.name)) ?? dateFields.find((f) => !/结束|截止|到期|end|due|finish/i.test(f.name)) ?? dateFields[0];
  const startField = fields.find((f) => f.id === startFieldId && f.type === "date") ?? autoStart;
  const autoEnd = dateFields.find((f) => f.id !== startField?.id && /结束|截止|到期|end|due|finish/i.test(f.name)) ?? dateFields.find((f) => f.id !== startField?.id) ?? startField;
  const endField = fields.find((f) => f.id === endFieldId && f.type === "date") ?? autoEnd;
  const sameField = !startField || !endField || startField.id === endField.id;

  const [month, setMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [zoom, setZoom] = useState<GanttZoom>("month");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pointerDraft, setPointerDraft] = useState<PointerBarDraft | null>(null);
  const markerUid = useId();
  const [uncontrolledDeps, setUncontrolledDeps] = useState<GanttDependency[]>([]);
  const deps = useMemo(
    () => sanitizeGanttDependencies(dependencies !== undefined ? dependencies : uncontrolledDeps),
    [dependencies, uncontrolledDeps],
  );
  const [depsOpen, setDepsOpen] = useState(false);
  const [depFromId, setDepFromId] = useState<number>(0);
  const [depToId, setDepToId] = useState<number>(0);
  const [depError, setDepError] = useState<string | null>(null);
  const [hoveredDepId, setHoveredDepId] = useState<string | null>(null);
  const depsWrapRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [timelineMetrics, setTimelineMetrics] = useState<{
    width: number;
    height: number;
    rowCenters: Record<number, number>;
  } | null>(null);
  const busyRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const cleanupPointerRef = useRef<(() => void) | null>(null);
  const recordsRef = useRef(records); recordsRef.current = records;
  const scope = useRef({ baseId, generation: 0 });
  if (scope.current.baseId !== baseId) scope.current = { baseId, generation: scope.current.generation + 1 };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cleanupPointerRef.current?.();
      cleanupPointerRef.current = null;
    };
  }, []);
  useEffect(() => {
    busyRef.current = false;
    setBusy(false);
    setError(null);
    dragRef.current = null;
    setPointerDraft(null);
    setUncontrolledDeps([]);
    setDepError(null);
  }, [baseId]);
  useEffect(() => {
    if (!depsOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (depsWrapRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[role="listbox"]')) return;
      setDepsOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDepsOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [depsOpen]);

  const zoomCfg = ZOOM_META[zoom];
  const monthKey = `${String(month.year).padStart(4, "0")}-${String(month.month).padStart(2, "0")}-01`;
  const first = ganttDay(monthKey);
  const monthBuckets = useMemo(() => {
    const out: { year: number; month: number; days: number }[] = [];
    for (let i = 0; i < zoomCfg.months; i++) {
      const idx = month.year * 12 + (month.month - 1) + i;
      const y = Math.floor(idx / 12);
      const m = idx - y * 12 + 1;
      out.push({ year: y, month: m, days: new Date(Date.UTC(y, m, 0)).getUTCDate() });
    }
    return out;
  }, [month.year, month.month, zoomCfg.months]);
  const days = monthBuckets.reduce((acc, b) => acc + b.days, 0);

  const todayNum = useMemo(() => {
    const now = new Date();
    return ganttDay(`${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
  }, []);

  const bars = useMemo(() => {
    if (!startField || !endField || first === null) return [];
    const out: Bar[] = [];
    for (const rec of records) {
      const baseRange = ganttRange(rec.cells[startField.id], rec.cells[endField.id], sameField);
      if (!baseRange) continue;
      const effectiveRange = pointerDraft?.id === rec.id ? pointerDraft.range : baseRange;
      if (effectiveRange.end < first || effectiveRange.start >= first + days) continue;
      out.push({
        rec,
        range: effectiveRange,
        visibleStart: Math.max(effectiveRange.start, first),
        visibleEnd: Math.min(effectiveRange.end, first + days - 1),
        label: recordTitle(rec, fields, members) || t("未命名"),
      });
    }
    return out;
  }, [records, startField, endField, sameField, first, days, fields, members, pointerDraft]);

  const [gpuActive, setGpuActive] = useState(false);
  const ganttScrollRef = useRef<HTMLDivElement>(null);
  const taskOptions = useMemo(() => {
    if (!startField || !endField) return [];
    const out: { id: number; label: string }[] = [];
    for (const rec of records) {
      if (!ganttRange(rec.cells[startField.id], rec.cells[endField.id], sameField)) continue;
      out.push({ id: rec.id, label: recordTitle(rec, fields, members) || t("未命名") });
    }
    return out;
  }, [records, startField, endField, sameField, fields, members]);
  const taskLabelById = useMemo(() => new Map(taskOptions.map((item) => [item.id, item.label])), [taskOptions]);
  useEffect(() => {
    if (taskOptions.length === 0) return;
    if (!taskOptions.some((o) => o.id === depFromId)) {
      setDepFromId(taskOptions[0].id);
    }
    if (!taskOptions.some((o) => o.id === depToId)) {
      setDepToId(taskOptions[1]?.id ?? taskOptions[0].id);
    }
  }, [taskOptions, depFromId, depToId]);
  useEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const measure = () => {
      const timelineW = Math.max(0, el.clientWidth - 192);
      const rowCenters: Record<number, number> = {};
      el.querySelectorAll<HTMLElement>("[data-gantt-row]").forEach((row) => {
        const rid = Number(row.dataset.ganttRow);
        if (rid > 0) rowCenters[rid] = row.offsetTop + Math.min(20, row.offsetHeight / 2);
      });
      setTimelineMetrics({ width: timelineW, height: el.offsetHeight, rowCenters });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bars, zoom, days]);
  const ganttGpuBars = useMemo(
    () =>
      bars.map((bar) => ({
        id: bar.rec.id,
        offset: bar.visibleStart - (first ?? 0),
        length: bar.visibleEnd - bar.visibleStart + 1,
        dragging: pointerDraft?.id === bar.rec.id,
        milestone: bar.range.start === bar.range.end,
      })),
    [bars, first, pointerDraft],
  );

  if (!startField || !endField || first === null) {
    return (
      <div className="grid flex-1 place-items-center px-4 text-center text-[14px] text-muted-foreground">
        <p>{t("甘特需要日期字段，请先添加日期字段作为开始时间。")}</p>
      </div>
    );
  }

  const shiftMonth = (amount: number) => setMonth((current) => {
    const index = current.year * 12 + current.month - 1 + amount;
    const year = Math.floor(index / 12), nextMonth = index - year * 12 + 1;
    return year >= 1 && year <= 9999 ? { year, month: nextMonth } : current;
  });

  const commitBarRange = async (
    recordId: number,
    startVal: Cell | undefined,
    endVal: Cell | undefined,
    nextRange: GanttRange,
    undoLabel: string,
  ) => {
    if (!canEdit || busyRef.current) return;
    const record = recordsRef.current.find((r) => r.id === recordId);
    if (!record || record.cells[startField.id] !== startVal || record.cells[endField.id] !== endVal) {
      setError(t("记录日期已变化，请检查后重新拖动。"));
      return;
    }
    const startMin = ganttDayTime(startVal)?.minutes ?? null;
    const endMin = ganttDayTime(endVal)?.minutes ?? null;
    const startStr = formatGanttCell(nextRange.start, startMin);
    const endStr = nextRange.hasEnd && !sameField ? formatGanttCell(nextRange.end, endMin) : null;
    if (!startStr || (nextRange.hasEnd && !sameField && !endStr)) {
      setError(t("目标日期超出支持范围，记录未修改。"));
      return;
    }
    const { expected, cells } = ganttMoveCells(startField.id, endField.id, startVal, endVal, { start: startStr, end: endStr });
    if (record.cells[startField.id] === cells[startField.id] && (sameField || (record.cells[endField.id] ?? null) === (cells[endField.id] ?? null))) {
      return;
    }

    const requestedBase = baseId, requestedGeneration = scope.current.generation;
    const stillCurrent = () => mounted.current && scope.current.baseId === requestedBase && scope.current.generation === requestedGeneration;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      await baseApi.compareCells(requestedBase, recordId, expected, cells);
      const changes: UndoCellChange[] = [
        { rid: recordId, fid: startField.id, before: startVal ?? null, after: cells[startField.id] },
      ];
      if (!sameField && (endVal ?? null) !== (cells[endField.id] ?? null)) {
        changes.push({ rid: recordId, fid: endField.id, before: endVal ?? null, after: cells[endField.id] });
      }
      onRecordUndo?.({ label: undoLabel, cells: changes, created: [] });
    } catch (reason) {
      if (stillCurrent()) {
        setError(reason instanceof ApiError && reason.status === 409
          ? t("记录日期已变化，请检查后重新拖动。")
          : t("无法确认日期是否更新，请检查记录后重试。"));
      }
    } finally {
      if (stillCurrent()) { busyRef.current = false; setBusy(false); onMutate(); }
    }
  };

  /** Legacy HTML5 drag-drop fallback for direct dragstart/drop interactions. */
  const drop = async (dropDay: number) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !canEdit || busyRef.current || drag.startField !== startField.id || drag.endField !== endField.id) return;
    const target = rescheduleGantt(drag.range, dropDay, drag.grabbedOffset);
    if (!target) { setError(t("目标日期超出支持范围，记录未修改。")); return; }
    const startNum = ganttDay(target.start);
    const endNum = target.end ? ganttDay(target.end) : startNum;
    if (startNum === null || endNum === null) return;
    await commitBarRange(drag.id, drag.startValue, drag.endValue, { start: startNum, end: endNum, hasEnd: drag.range.hasEnd }, t("甘特调整排期"));
  };

  /** Real-time pointer drag-move and left/right edge resize with live snapping preview. */
  const startBarPointer = (
    mode: "move" | "resize-start" | "resize-end",
    bar: Bar,
    timelineEl: HTMLElement | null,
    e: React.PointerEvent,
  ) => {
    if (!canEdit || busyRef.current || !timelineEl) return;
    if ((mode === "resize-start" || mode === "resize-end") && sameField) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    cleanupPointerRef.current?.();

    const startX = e.clientX;
    const timelineWidth = timelineEl.getBoundingClientRect().width;
    const pxPerDay = timelineWidth > 0 ? timelineWidth / days : zoomCfg.dayWidth;
    const origRange = bar.range;
    const startVal = bar.rec.cells[startField.id];
    const endVal = bar.rec.cells[endField.id];
    let moved = false;
    let latestRange: GanttRange = origRange;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const deltaDays = Math.round(dx / pxPerDay);
      if (mode === "move") {
        const nextStart = origRange.start + deltaDays;
        const nextEnd = origRange.end + deltaDays;
        if (ganttDate(nextStart) && ganttDate(nextEnd)) {
          latestRange = { start: nextStart, end: nextEnd, hasEnd: origRange.hasEnd };
        }
      } else {
        const resized = resizeGanttRange(origRange, mode === "resize-start" ? "start" : "end", deltaDays, sameField);
        if (resized) latestRange = resized;
      }
      setPointerDraft({ id: bar.rec.id, mode, range: latestRange });
    };

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      cleanupPointerRef.current = null;
      setPointerDraft(null);
      if (!moved) {
        if (mode === "move") onOpen?.(bar.rec);
        return;
      }
      const actionLabel = mode === "move" ? t("甘特拖拽排期") : t("甘特调整起止日期");
      void commitBarRange(bar.rec.id, startVal, endVal, latestRange, actionLabel);
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

  const titleLabel = zoomCfg.months === 1
    ? t("{year} 年 {month} 月", { year: month.year, month: month.month })
    : `${monthBuckets[0].year}/${monthBuckets[0].month} – ${monthBuckets[monthBuckets.length - 1].year}/${monthBuckets[monthBuckets.length - 1].month}`;

  const commitDeps = (next: GanttDependency[]) => {
    if (onChangeDependencies) onChangeDependencies(next);
    else if (dependencies === undefined) setUncontrolledDeps(next);
  };

  const handleAddDep = () => {
    setDepError(null);
    const res = addGanttDependency(deps, depFromId, depToId);
    if (!res.ok) {
      setDepError(
        res.reason === "cycle"
          ? t("无法添加：该连线会形成循环依赖")
          : res.reason === "self"
            ? t("前置任务和后置任务不能相同")
            : res.reason === "duplicate"
              ? t("该依赖连线已存在")
              : t("请选择有效的前置和后置任务"),
      );
      return;
    }
    commitDeps(res.edges);
  };

  const handleRemoveDep = (id: string) => {
    const next = removeGanttDependency(deps, id);
    commitDeps(next);
    setDepError(null);
  };

  const effectiveTimelineW =
    timelineMetrics?.width && timelineMetrics.width > 0 ? timelineMetrics.width : days * zoomCfg.dayWidth;
  const svgHeight =
    timelineMetrics?.height && timelineMetrics.height > 0 ? timelineMetrics.height : bars.length * 41;
  const barIndexMap = new Map<number, { bar: Bar; index: number }>();
  bars.forEach((bar, index) => barIndexMap.set(bar.rec.id, { bar, index }));
  const arrowItems = deps.flatMap((dep) => {
    const fromEntry = barIndexMap.get(dep.fromId);
    const toEntry = barIndexMap.get(dep.toId);
    if (!fromEntry || !toEntry) return [];
    const fromMilestone = fromEntry.bar.range.start === fromEntry.bar.range.end;
    const toMilestone = toEntry.bar.range.start === toEntry.bar.range.end;
    const fromX = fromMilestone
      ? ((fromEntry.bar.visibleStart - first + 0.5) / days) * effectiveTimelineW + 7
      : ((fromEntry.bar.visibleEnd - first + 1) / days) * effectiveTimelineW;
    const toX = toMilestone
      ? ((toEntry.bar.visibleStart - first + 0.5) / days) * effectiveTimelineW - 7
      : ((toEntry.bar.visibleStart - first) / days) * effectiveTimelineW;
    const fromY = timelineMetrics?.rowCenters[dep.fromId] ?? fromEntry.index * 41 + 20;
    const toY = timelineMetrics?.rowCenters[dep.toId] ?? toEntry.index * 41 + 20;
    return [{ dep, d: computeGanttArrowPath(fromX, fromY, toX, toY) }];
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-gantt data-gantt-zoom={zoom}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[14px] font-medium">
        <button type="button" aria-label={t("上个月")} className="grid size-8 place-items-center rounded hover:bg-hover" onClick={() => shiftMonth(-1)}>‹</button>
        <button type="button" aria-label={t("下个月")} className="grid size-8 place-items-center rounded hover:bg-hover" onClick={() => shiftMonth(1)}>›</button>
        <button type="button" className="h-8 rounded-md border px-3 text-[13px] font-normal hover:bg-hover" onClick={() => { const now = new Date(); setMonth({ year: now.getFullYear(), month: now.getMonth() + 1 }); }}>{t("今天")}</button>
        <span aria-live="polite">{titleLabel}</span>
        <span className="hidden text-[12px] font-normal text-subtle sm:inline">{t("开始「{start}」– 结束「{end}」", { start: startField.name, end: endField.name })}</span>
        <div ref={depsWrapRef} className="relative ml-auto">
          <button
            type="button"
            data-gantt-deps-btn
            aria-expanded={depsOpen}
            aria-haspopup="dialog"
            onClick={() => { setDepsOpen((v) => !v); setDepError(null); }}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-normal transition-colors hover:bg-hover",
              depsOpen || deps.length > 0 ? "border-primary/40 bg-accent text-primary" : "text-muted-foreground",
            )}
          >
            <GitBranch size={13} strokeWidth={1.7} aria-hidden />
            <span>{t("依赖连线")}</span>
            {deps.length > 0 && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-white">
                {deps.length}
              </span>
            )}
          </button>
          {depsOpen && (
            <div
              role="dialog"
              aria-label={t("任务依赖连线")}
              data-gantt-deps-popover
              className="absolute right-0 top-9 z-40 w-[340px] max-w-[calc(100vw-24px)] rounded-lg border border-[#dee0e3] bg-surface p-3 text-[13px] font-normal text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.14)]"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium text-foreground">{t("任务依赖连线")}</span>
                <span className="text-[11px] text-subtle">{t("{n} 条连线", { n: deps.length })}</span>
              </div>
              {canEdit && (
                <div className="space-y-2 rounded-md border border-[#e5e6eb] bg-[#f7f8fa]/70 p-2.5 dark:bg-sidebar/40">
                  {taskOptions.length < 2 ? (
                    <p className="text-[12px] text-subtle">{t("至少需要两条已排期任务才能添加依赖连线。")}</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
                        <div className="min-w-0 space-y-1">
                          <span className="block text-[11px] text-muted-foreground">{t("前置任务")}</span>
                          <FeishuSelect
                            ariaLabel={t("前置任务")}
                            value={depFromId ? String(depFromId) : ""}
                            options={taskOptions.map((item) => ({ value: String(item.id), label: item.label }))}
                            onChange={(val) => { setDepFromId(Number(val)); setDepError(null); }}
                            className="h-7 w-full border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                            chevronSize={11}
                            menuMinWidth={132}
                            dataAttr={{ "data-gantt-dep-from": true }}
                          />
                        </div>
                        <span className="pt-4 text-[12px] text-subtle" aria-hidden>→</span>
                        <div className="min-w-0 space-y-1">
                          <span className="block text-[11px] text-muted-foreground">{t("后置任务")}</span>
                          <FeishuSelect
                            ariaLabel={t("后置任务")}
                            value={depToId ? String(depToId) : ""}
                            options={taskOptions.map((item) => ({ value: String(item.id), label: item.label }))}
                            onChange={(val) => { setDepToId(Number(val)); setDepError(null); }}
                            className="h-7 w-full border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                            chevronSize={11}
                            menuMinWidth={132}
                            dataAttr={{ "data-gantt-dep-to": true }}
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={handleAddDep}
                        data-gantt-dep-add
                        className="h-7 w-full rounded-md bg-primary text-[12px] font-medium text-white hover:opacity-90"
                      >
                        {t("添加连线")}
                      </button>
                    </>
                  )}
                  {depError && (
                    <p role="alert" className="text-[12px] text-destructive" data-gantt-dep-error>
                      {depError}
                    </p>
                  )}
                </div>
              )}
              <div className="mt-2.5 max-h-48 space-y-1 overflow-y-auto">
                {deps.length === 0 ? (
                  <p className="py-3 text-center text-[12px] text-subtle">{t("暂无依赖连线")}</p>
                ) : (
                  deps.map((dep) => (
                    <div
                      key={dep.id}
                      onMouseEnter={() => setHoveredDepId(dep.id)}
                      onMouseLeave={() => setHoveredDepId((cur) => (cur === dep.id ? null : cur))}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px]",
                        hoveredDepId === dep.id ? "border-primary/40 bg-accent/50" : "border-transparent bg-hover/40",
                      )}
                      data-gantt-dep-item={dep.id}
                    >
                      <span className="min-w-0 flex-1 truncate">{taskLabelById.get(dep.fromId) ?? `#${dep.fromId}`}</span>
                      <span className="shrink-0 text-subtle" aria-hidden>→</span>
                      <span className="min-w-0 flex-1 truncate">{taskLabelById.get(dep.toId) ?? `#${dep.toId}`}</span>
                      {canEdit && (
                        <button
                          type="button"
                          aria-label={t("删除依赖连线")}
                          onClick={() => handleRemoveDep(dep.id)}
                          className="grid size-5 shrink-0 place-items-center rounded text-subtle hover:bg-surface hover:text-destructive"
                          data-gantt-dep-remove={dep.id}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <div className="flex rounded-md border p-0.5 text-[12px] font-normal" role="group" aria-label={t("甘特时间刻度")}>
          {(["month", "bimonth", "quarter"] as const).map((z) => (
            <button
              key={z}
              type="button"
              data-gantt-zoom-btn={z}
              aria-pressed={zoom === z}
              onClick={() => setZoom(z)}
              className={cn("rounded px-2.5 py-1", zoom === z ? "bg-accent text-primary" : "text-muted-foreground hover:bg-hover")}
            >
              {t(ZOOM_META[z].label)}
            </button>
          ))}
        </div>
      </div>
      {error && <div role="alert" className="border-b px-4 py-2 text-[12px] text-destructive">{error}</div>}
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <BaseGanttGpuLayer
        scrollContainerRef={ganttScrollRef}
        firstDay={first}
        days={days}
        todayNum={todayNum ?? -1}
        bars={ganttGpuBars}
        zoom={zoom}
        onBackendReady={(backend) => {
          if (backend === "webgpu" || backend === "webgl2") setGpuActive(true);
        }}
      />
      <div ref={ganttScrollRef} className="relative z-[1] min-h-0 flex-1 overflow-auto bg-transparent">
        <div style={{ minWidth: 192 + days * zoomCfg.dayWidth }}>
          {zoomCfg.months > 1 && (
            <div className="flex border-b bg-sidebar/80 text-center text-[11px] font-medium text-muted-foreground">
              <div className="sticky left-0 z-20 w-48 shrink-0 border-r border-[#e5e6eb] bg-sidebar py-1 pl-3 text-left" />
              {monthBuckets.map((mb) => (
                <div key={`${mb.year}-${mb.month}`} className="border-l py-1" style={{ flex: mb.days }}>
                  {t("{year} 年 {month} 月", { year: mb.year, month: mb.month })}
                </div>
              ))}
            </div>
          )}
          <div className="flex border-b bg-sidebar/60 text-center text-[11px] text-muted-foreground">
            <div className="sticky left-0 z-20 w-48 shrink-0 border-r border-[#e5e6eb] bg-sidebar py-1 pl-3 text-left">{t("记录")}</div>
            {Array.from({ length: days }, (_, i) => {
              const d = new Date((first + i) * DAY + DAY / 2);
              const wd = d.getUTCDay();
              const isToday = first + i === todayNum;
              return (
                <div
                  key={i}
                  style={{ minWidth: zoomCfg.dayWidth }}
                  className={cn(
                    "flex-1 py-1",
                    (wd === 0 || wd === 6) && "text-subtle",
                    isToday && "bg-primary/15 font-semibold text-primary",
                  )}
                >
                  {d.getUTCDate()}
                </div>
              );
            })}
          </div>
          {bars.length === 0 && <p className="py-12 text-center text-[13px] text-subtle">{t("本月没有排期的记录")}</p>}
          <div ref={rowsRef} className="relative" data-gantt-rows>
          {bars.length > 0 && (
            <svg
              data-gantt-dep-layer
              aria-hidden="true"
              width={effectiveTimelineW}
              height={svgHeight}
              viewBox={`0 0 ${effectiveTimelineW} ${Math.max(1, svgHeight)}`}
              className="absolute left-48 top-0 z-10 overflow-visible"
              style={{ pointerEvents: "none" }}
            >
              <defs>
                <marker id={`${markerUid}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 1 L 7 4 L 0 7 z" fill="#8f959e" />
                </marker>
                <marker id={`${markerUid}-arrow-active`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 1 L 7 4 L 0 7 z" fill="#3370ff" />
                </marker>
              </defs>
              {arrowItems.map(({ dep, d }) => {
                const active = hoveredDepId === dep.id || pointerDraft?.id === dep.fromId || pointerDraft?.id === dep.toId;
                return (
                  <path
                    key={dep.id}
                    data-gantt-dep-edge={`${dep.fromId}->${dep.toId}`}
                    d={d}
                    fill="none"
                    stroke={active ? "#3370ff" : "#8f959e"}
                    strokeWidth={active ? 1.8 : 1.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    markerEnd={`url(#${active ? `${markerUid}-arrow-active` : `${markerUid}-arrow`})`}
                  />
                );
              })}
            </svg>
          )}
          {bars.map((bar) => {
            const offset = bar.visibleStart - first, length = bar.visibleEnd - bar.visibleStart + 1;
            const totalDays = bar.range.end - bar.range.start + 1;
            const isMilestone = bar.range.start === bar.range.end;
            const isDraggingThis = pointerDraft?.id === bar.rec.id;
            const barDatesLabel = isMilestone ? `${ganttDate(bar.range.start)}` : `${ganttDate(bar.range.start)} – ${ganttDate(bar.range.end)}`;
            return (
              <div key={bar.rec.id} className="flex items-stretch border-b" data-gantt-row={bar.rec.id}>
                <button
                  type="button"
                  className="sticky left-0 z-20 w-48 shrink-0 truncate border-r border-[#e5e6eb] bg-surface px-3 py-2 text-left text-[13px] hover:bg-hover/60"
                  onClick={() => onOpen?.(bar.rec)}
                  aria-disabled={!onOpen || undefined}
                  tabIndex={onOpen ? 0 : -1}
                  title={bar.label}
                >
                  {isMilestone && <span className="mr-1.5 inline-block size-2 rotate-45 rounded-[1px] bg-[#ff8800] align-middle" aria-hidden />}
                  {bar.label}
                </button>
                <div
                  className="relative flex min-h-10 min-w-0 flex-1"
                  data-gantt-timeline={bar.rec.id}
                  onDragOver={(e) => { if (canEdit && !busy && dragRef.current) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
                  onDrop={(e) => {
                    if (!canEdit || busy || !dragRef.current) return;
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect(), index = ganttDropIndex(e.clientX, rect.left, rect.width, days);
                    if (index === null) { dragRef.current = null; return; }
                    void drop(first + index);
                  }}
                >
                  {Array.from({ length: days }, (_, i) => {
                    const weekday = new Date((first + i) * DAY + DAY / 2).getUTCDay();
                    const isToday = first + i === todayNum;
                    return (
                      <div
                        key={i}
                        data-gantt-day={i + 1}
                        style={{ minWidth: zoomCfg.dayWidth }}
                        className={cn(
                          "flex-1",
                          !gpuActive && "border-l",
                          !gpuActive && (weekday === 0 || weekday === 6) && "bg-sidebar/40",
                          !gpuActive && isToday && "bg-primary/5",
                        )}
                      />
                    );
                  })}
                  <div
                    draggable={canEdit && !busy}
                    onPointerDown={(e) => startBarPointer("move", bar, e.currentTarget.parentElement, e)}
                    onDragStart={(e) => {
                      if (!canEdit || busy) { e.preventDefault(); return; }
                      const rect = e.currentTarget.getBoundingClientRect();
                      const grabbedVisible = rect.width > 0 ? Math.max(0, Math.min(length - 1, Math.floor(((e.clientX - rect.left) / rect.width) * length))) : 0;
                      dragRef.current = { id: bar.rec.id, startField: startField.id, endField: endField.id, startValue: bar.rec.cells[startField.id], endValue: bar.rec.cells[endField.id], range: bar.range, grabbedOffset: bar.visibleStart - bar.range.start + grabbedVisible };
                      e.dataTransfer.setData("text/plain", String(bar.rec.id)); e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => { dragRef.current = null; }}
                    className={cn(
                      "group absolute top-2 flex h-6 items-center select-none",
                      isMilestone
                        ? "overflow-visible whitespace-nowrap text-[11px] font-medium text-[#1f2329]"
                        : cn(
                            "rounded text-[11px] leading-6 text-white",
                            gpuActive ? "bg-transparent" : "bg-primary/85 shadow-sm",
                            canEdit && !busy && !gpuActive && "hover:bg-primary",
                            isDraggingThis && (gpuActive ? "z-20" : "z-20 bg-primary ring-2 ring-primary/35 shadow-md"),
                          ),
                      canEdit && !busy && "cursor-grab active:cursor-grabbing",
                      isMilestone && isDraggingThis && "z-20",
                    )}
                    style={
                      isMilestone
                        ? { left: `${((offset + 0.5) / days) * 100}%`, transform: "translateX(-7px)" }
                        : { left: `${(offset / days) * 100}%`, width: `${(length / days) * 100}%` }
                    }
                    title={isMilestone ? `${bar.label} (${t("里程碑")}: ${barDatesLabel})` : `${bar.label}: ${barDatesLabel}`}
                    data-gantt-bar={bar.rec.id}
                    data-gantt-milestone={isMilestone ? "true" : undefined}
                    data-gantt-range={barDatesLabel}
                  >
                    {isMilestone ? (
                      <>
                        <span
                          aria-hidden
                          className={cn(
                            "inline-block size-3.5 shrink-0 rotate-45 rounded-[2px] border border-white bg-[#ff8800] shadow-xs transition-transform group-hover:scale-110",
                            isDraggingThis && "ring-2 ring-[#ff8800]/35",
                          )}
                        />
                        <span className="ml-2 rounded bg-surface/90 px-1 text-[11px] font-medium text-[#1f2329]">{bar.label}</span>
                      </>
                    ) : (
                      <>
                        {canEdit && !busy && !sameField && (
                          <span
                            data-gantt-resize-left={bar.rec.id}
                            title={t("拖拽调整开始日期")}
                            onPointerDown={(e) => startBarPointer("resize-start", bar, e.currentTarget.parentElement?.parentElement ?? null, e)}
                            className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize rounded-l hover:bg-white/35"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate px-2">
                          {bar.label}
                          {totalDays > 1 && <span className="ml-1 opacity-80">({t("{n}天", { n: totalDays })})</span>}
                        </span>
                        {canEdit && !busy && !sameField && (
                          <span
                            data-gantt-resize-right={bar.rec.id}
                            title={t("拖拽调整结束日期")}
                            onPointerDown={(e) => startBarPointer("resize-end", bar, e.currentTarget.parentElement?.parentElement ?? null, e)}
                            className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize rounded-r hover:bg-white/35"
                          />
                        )}
                      </>
                    )}
                    {isDraggingThis && (
                      <span
                        data-gantt-drag-tooltip
                        className="pointer-events-none absolute -top-7 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded bg-[#1f2329] px-2 py-0.5 font-mono text-[10px] text-white shadow"
                      >
                        {isMilestone ? `${barDatesLabel} · ${t("里程碑")}` : `${barDatesLabel} · ${t("{n}天", { n: totalDays })}`}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

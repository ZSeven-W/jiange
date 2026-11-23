import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  FenwickVirtualizer,
  InstanceBatch,
  type GpuBackendKind,
  type GpuSurface,
  type RgbaTuple as RGBA,
} from "@jiange/render-gpu";
import type { BaseRecord, Field, FillRule, User } from "@/lib/api";
import { cssColorToRGBA, GpuLayer, type GpuLayerHandle } from "@/components/gpu-canvas";
import { rowFill } from "./fill";
import type { GridSelection } from "./grid-selection";
import type { GroupedSeries } from "./dashboard-model";

const BASE_HEADER_H = 36;
const BASE_ROW_NUM_W = 64;

const GRID_LINE: RGBA = [0.871, 0.878, 0.89, 1]; // #dee0e3 (Feishu crisp hairline)
const FROZEN_DIVIDER: RGBA = [0.733, 0.749, 0.769, 1]; // #BBBFC4
const SEL_ROW_FILL: RGBA = [0.925, 0.949, 1, 1]; // #ecf2ff
const SEL_CURSOR_FILL: RGBA = [0.878, 0.918, 1, 1]; // #e0eaff
const PRIMARY_BLUE: RGBA = [0.2, 0.439, 1, 1]; // #3370ff
const WHITE: RGBA = [1, 1, 1, 1];
const HEADER_BG: RGBA = [1, 1, 1, 1];

function snapHairline(v: number): number {
  return Math.round(v) - 0.5;
}

export interface BaseGridGpuLayerProps {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  records: readonly BaseRecord[];
  fields: readonly Field[];
  allFields?: readonly Field[];
  members: readonly User[];
  fills?: readonly FillRule[];
  colWidths: readonly number[];
  rowHeight: number;
  nFrozen: number;
  checked: ReadonlySet<number>;
  selection: GridSelection | null;
  grouped: boolean;
  canEdit: boolean;
  onBackendReady?: (backend: GpuBackendKind) => void;
}

/**
 * Hardware-accelerated WebGPU / WebGL2 SDF Base Grid Layer
 * powered by `@jiange/render-gpu` (`GpuSurface` + `InstanceBatch` + `FenwickVirtualizer`).
 */
export function BaseGridGpuLayer({
  scrollContainerRef,
  records,
  fields,
  allFields,
  members,
  fills,
  colWidths,
  rowHeight,
  nFrozen,
  checked,
  selection,
  grouped,
  canEdit,
  onBackendReady,
}: BaseGridGpuLayerProps) {
  const layerRef = useRef<GpuLayerHandle>(null);
  const bodyBatchRef = useRef<InstanceBatch | null>(null);
  const fenwickRef = useRef<FenwickVirtualizer | null>(null);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => layerRef.current?.requestRender();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef]);

  const onRender = useCallback(
    (surface: GpuSurface, width: number, height: number) => {
      const body = (bodyBatchRef.current ??= new InstanceBatch(4096, 4096, 32));
      body.reset();

      const el = scrollContainerRef.current;
      const scrollLeft = el?.scrollLeft ?? 0;
      const scrollTop = el?.scrollTop ?? 0;
      const headerEl = el?.querySelector("thead");
      const headerH = headerEl ? Math.round(headerEl.getBoundingClientRect().height) || BASE_HEADER_H : BASE_HEADER_H;

      surface.setClearColor(WHITE);
      body.pushRect({ x: 0, y: 0, w: width, h: height, fill: WHITE });
      body.pushRect({ x: 0, y: 0, w: width, h: headerH, fill: HEADER_BG });

      // Maintain O(log N) FenwickVirtualizer for variable-row/huge-table offset queries
      const fenwick = (fenwickRef.current ??= new FenwickVirtualizer(records.length, rowHeight));
      if (fenwick.defaultItemSize !== rowHeight) fenwick.resetAll(rowHeight);
      if (fenwick.itemCount !== records.length) fenwick.setCount(records.length);

      // Compute cumulative column X offsets
      const colLefts: number[] = [];
      let cx = BASE_ROW_NUM_W;
      for (let i = 0; i < colWidths.length; i++) {
        colLefts.push(cx);
        cx += colWidths[i];
      }
      const trailingAddW = canEdit ? 44 : 0;
      const totalRight = cx + trailingAddW;
      const frozenW = nFrozen > 0 && nFrozen <= colWidths.length
        ? colLefts[nFrozen - 1] + colWidths[nFrozen - 1]
        : BASE_ROW_NUM_W;

      if (!grouped && records.length > 0 && height > headerH) {
        body.scissor = { x: frozenW, y: headerH, w: Math.max(0, width - frozenW), h: Math.max(0, height - headerH) };
        const vis = fenwick.visibleRange(scrollTop, height - headerH, 2);
        const startRow = Math.max(0, vis.start);
        const endRow = Math.min(records.length - 1, vis.end);

        const rMin = selection ? Math.min(selection.ar, selection.rr) : -1;
        const rMax = selection ? Math.max(selection.ar, selection.rr) : -1;
        const fMin = selection ? Math.min(selection.af, selection.rf) : -1;
        const fMax = selection ? Math.max(selection.af, selection.rf) : -1;

        const visibleRight = Math.min(width, totalRight - scrollLeft);

        for (let r = startRow; r <= endRow; r++) {
          const rec = records[r];
          if (!rec) continue;
          const y = headerH + fenwick.indexToOffset(r) - scrollTop;
          const isChecked = checked.has(rec.id);
          const customFill = rowFill(rec, (allFields ?? fields) as Field[], fills as FillRule[] | undefined, members as User[]);

          // Row background fill (checked or conditional fill)
          if (isChecked) {
            body.pushRect({ x: frozenW, y, w: Math.max(0, visibleRight - frozenW), h: rowHeight, fill: SEL_ROW_FILL });
          } else if (customFill) {
            body.pushRect({
              x: frozenW,
              y,
              w: Math.max(0, visibleRight - frozenW),
              h: rowHeight,
              fill: cssColorToRGBA(customFill),
            });
          }

          // Selection range fills
          if (selection && r >= rMin && r <= rMax) {
            for (let c = Math.max(nFrozen, fMin); c <= Math.min(fields.length - 1, fMax); c++) {
              const x = colLefts[c] - scrollLeft;
              const w = colWidths[c];
              if (x + w < frozenW || x > width) continue;
              const isCursor = selection.rr === r && selection.rf === c;
              body.pushRect({ x, y, w, h: rowHeight, fill: isCursor ? SEL_CURSOR_FILL : SEL_ROW_FILL });
            }
          }

          // Row bottom hairline
          const gy = snapHairline(y + rowHeight);
          body.pushLine({
            x1: frozenW,
            y1: gy,
            x2: visibleRight,
            y2: gy,
            thickness: 1,
            color: GRID_LINE,
          });
        }

        // Column vertical hairlines across visible rows
        const gridBottom = Math.min(height, headerH + fenwick.totalSize - scrollTop);
        for (let c = nFrozen; c < fields.length; c++) {
          const x = snapHairline(colLefts[c] + colWidths[c] - scrollLeft);
          if (x < frozenW || x > width) continue;
          body.pushLine({ x1: x, y1: headerH, x2: x, y2: gridBottom, thickness: 1, color: GRID_LINE });
        }
        if (canEdit) {
          const x = snapHairline(totalRight - scrollLeft);
          if (x >= frozenW && x <= width) {
            body.pushLine({ x1: x, y1: headerH, x2: x, y2: gridBottom, thickness: 1, color: GRID_LINE });
          }
        }

        // Selection outer blue border (inset by 1px so all 4 edges stay 100% inside scissor & clear of frozen column)
        if (selection && fMax >= nFrozen) {
          const selLeft = Math.max(frozenW, colLefts[Math.max(nFrozen, fMin)] - scrollLeft);
          const selRight = colLefts[fMax] + colWidths[fMax] - scrollLeft;
          const selTop = headerH + fenwick.indexToOffset(rMin) - scrollTop;
          const selBottom = headerH + fenwick.indexToOffset(rMax + 1) - scrollTop;
          if (selRight > selLeft && selBottom > selTop) {
            if (fMin >= nFrozen) {
              body.pushLine({ x1: selLeft + 1, y1: selTop, x2: selLeft + 1, y2: selBottom, thickness: 2, color: PRIMARY_BLUE });
            }
            body.pushLine({ x1: selRight - 1, y1: selTop, x2: selRight - 1, y2: selBottom, thickness: 2, color: PRIMARY_BLUE });
            body.pushLine({ x1: selLeft, y1: selTop + 1, x2: selRight, y2: selTop + 1, thickness: 2, color: PRIMARY_BLUE });
            body.pushLine({ x1: selLeft, y1: selBottom - 1, x2: selRight, y2: selBottom - 1, thickness: 2, color: PRIMARY_BLUE });
          }
        }

        // Frozen divider vertical line (placed at frozenW + 0.5 so it never clips at scissor.x)
        if (nFrozen > 0 && frozenW > BASE_ROW_NUM_W) {
          body.pushLine({ x1: frozenW + 0.5, y1: headerH, x2: frozenW + 0.5, y2: gridBottom, thickness: 1, color: FROZEN_DIVIDER });
        }
      } else {
        body.scissor = null;
      }

      return surface.render([body]);
    },
    [scrollContainerRef, records, fields, allFields, members, fills, colWidths, rowHeight, nFrozen, checked, selection, grouped, canEdit],
  );

  return (
    <GpuLayer
      ref={layerRef}
      surfaceKind="base-grid"
      onRender={onRender}
      renderDeps={[records, fields, allFields, members, fills, colWidths, rowHeight, nFrozen, checked, selection, grouped, canEdit]}
      onBackendReady={onBackendReady}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
    />
  );
}

/* ---------------- Base Gantt WebGPU Layer ---------------- */

export interface GanttGpuBar {
  id: number;
  offset: number;
  length: number;
  dragging: boolean;
}

export interface BaseGanttGpuLayerProps {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  firstDay: number;
  days: number;
  todayNum: number;
  bars: readonly GanttGpuBar[];
  zoom: string;
  onBackendReady?: (backend: GpuBackendKind) => void;
}

const WEEKEND_BG: RGBA = [0.969, 0.973, 0.98, 1]; // #f7f8fa
const TODAY_BG: RGBA = [0.2, 0.439, 1, 0.06];
const BAR_FILL: RGBA = [0.2, 0.439, 1, 0.88];
const BAR_DRAG_FILL: RGBA = [0.16, 0.376, 0.92, 1];
const DAY_MS = 86_400_000;

/**
 * Hardware-accelerated WebGPU / WebGL2 SDF Base Gantt Timeline Layer
 * powered by `@jiange/render-gpu`.
 */
export function BaseGanttGpuLayer({
  scrollContainerRef,
  firstDay,
  days,
  todayNum,
  bars,
  zoom,
  onBackendReady,
}: BaseGanttGpuLayerProps) {
  const layerRef = useRef<GpuLayerHandle>(null);
  const gridBatchRef = useRef<InstanceBatch | null>(null);
  const barBatchRef = useRef<InstanceBatch | null>(null);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => layerRef.current?.requestRender();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef]);

  const onRender = useCallback(
    (surface: GpuSurface, width: number, height: number) => {
      const gridBatch = (gridBatchRef.current ??= new InstanceBatch(512, 2048, 0));
      const barBatch = (barBatchRef.current ??= new InstanceBatch(1024, 32, 0));
      gridBatch.reset();
      barBatch.reset();
      surface.setClearColor(WHITE);
      gridBatch.pushRect({ x: 0, y: 0, w: width, h: height, fill: WHITE });

      const el = scrollContainerRef.current;
      if (!el || days <= 0) return surface.render([gridBatch]);

      const hostRect = el.getBoundingClientRect();
      const firstTimeline = el.querySelector<HTMLElement>("[data-gantt-timeline]");
      const timelineRect = firstTimeline?.getBoundingClientRect();
      const leftEdge = timelineRect ? timelineRect.left - hostRect.left : 192 - el.scrollLeft;
      const timelineW = timelineRect ? timelineRect.width : Math.max(1, el.scrollWidth - 192);
      const topEdge = timelineRect ? timelineRect.top - hostRect.top : 28;
      const dayW = timelineW / days;

      const scissor = { x: 192, y: Math.max(0, topEdge), w: Math.max(0, width - 192), h: Math.max(0, height - Math.max(0, topEdge)) };
      gridBatch.scissor = scissor;
      barBatch.scissor = scissor;

      // 1. Weekend bands, today tint, and vertical day gridlines (pass 1 — behind bars)
      for (let i = 0; i < days; i++) {
        const x = leftEdge + i * dayW;
        if (x + dayW < 0 || x > width) continue;
        const wd = new Date((firstDay + i) * DAY_MS + DAY_MS / 2).getUTCDay();
        const isToday = firstDay + i === todayNum;
        if (isToday) {
          gridBatch.pushRect({ x, y: topEdge, w: dayW, h: Math.max(0, height - topEdge), fill: TODAY_BG });
        } else if (wd === 0 || wd === 6) {
          gridBatch.pushRect({ x, y: topEdge, w: dayW, h: Math.max(0, height - topEdge), fill: WEEKEND_BG });
        }
        gridBatch.pushLine({ x1: x, y1: topEdge, x2: x, y2: height, thickness: 1, color: GRID_LINE });
      }

      // 2. Today vertical marker accent (behind bars)
      const todayIdx = todayNum - firstDay;
      if (todayIdx >= 0 && todayIdx < days) {
        const tx = leftEdge + (todayIdx + 0.5) * dayW;
        gridBatch.pushLine({ x1: tx, y1: topEdge, x2: tx, y2: height, thickness: 1.5, color: [0.2, 0.439, 1, 0.4] });
      }

      // 3. Crisp SDF Gantt bars measured against live row positions (pass 2 — cleanly above gridlines)
      const rowEls = el.querySelectorAll<HTMLElement>("[data-gantt-timeline]");
      bars.forEach((bar, idx) => {
        const rowEl = rowEls[idx];
        const rowRect = rowEl?.getBoundingClientRect();
        const rowTop = rowRect ? rowRect.top - hostRect.top : topEdge + idx * 41;
        const rowH = rowRect ? rowRect.height : 40;
        const bx = leftEdge + (bar.offset / days) * timelineW;
        const bw = Math.max(6, (bar.length / days) * timelineW);
        const by = rowTop + 8;
        const bh = 24;
        if (by + bh < 0 || by > height) return;
        gridBatch.pushLine({ x1: leftEdge, y1: rowTop + rowH, x2: leftEdge + timelineW, y2: rowTop + rowH, thickness: 1, color: GRID_LINE });
        barBatch.pushRect({
          x: bx,
          y: by,
          w: bw,
          h: bh,
          fill: bar.dragging ? BAR_DRAG_FILL : BAR_FILL,
          radius: 4,
          borderWidth: bar.dragging ? 2 : 0,
          borderColor: bar.dragging ? [0.2, 0.439, 1, 0.45] : [0, 0, 0, 0],
        });
      });

      return surface.render([gridBatch, barBatch]);
    },
    [scrollContainerRef, firstDay, days, todayNum, bars, zoom],
  );

  return (
    <GpuLayer
      ref={layerRef}
      surfaceKind="base-gantt"
      onRender={onRender}
      renderDeps={[firstDay, days, todayNum, bars, zoom]}
      onBackendReady={onBackendReady}
      className="absolute inset-0 z-0 h-full w-full pointer-events-none"
    />
  );
}

/* ---------------- Base Dashboard Charts WebGPU Layers ---------------- */

function viewBoxProjection(width: number, height: number, vbW: number, vbH: number) {
  const scale = Math.min(width / vbW, height / vbH);
  const ox = (width - vbW * scale) / 2;
  const oy = (height - vbH * scale) / 2;
  return { scale, ox, oy };
}

export function BaseBarChartGpuLayer({
  series,
  totalW,
  chartH,
  topPad,
  bottomPad,
  barW,
  gap,
  onBackendReady,
}: {
  series: GroupedSeries;
  totalW: number;
  chartH: number;
  topPad: number;
  bottomPad: number;
  barW: number;
  gap: number;
  onBackendReady?: (backend: GpuBackendKind) => void;
}) {
  const gridBatchRef = useRef<InstanceBatch | null>(null);
  const barBatchRef = useRef<InstanceBatch | null>(null);
  const onRender = useCallback(
    (surface: GpuSurface, width: number, height: number) => {
      const gridBatch = (gridBatchRef.current ??= new InstanceBatch(0, 32, 0));
      const barBatch = (barBatchRef.current ??= new InstanceBatch(256, 0, 0));
      gridBatch.reset();
      barBatch.reset();
      surface.setClearColor([0, 0, 0, 0]);
      const vbH = chartH + topPad + bottomPad;
      const { scale, ox, oy } = viewBoxProjection(width, height, totalW, vbH);
      const maxVal = Math.max(1, ...series.buckets.map((b) => Math.max(0, b.value)));
      const gridColor = cssColorToRGBA("#eef0f3");

      for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
        const y = oy + (topPad + chartH * (1 - ratio)) * scale;
        gridBatch.pushLine({
          x1: ox + 8 * scale,
          y1: y,
          x2: ox + (totalW - 8) * scale,
          y2: y,
          thickness: Math.max(1, scale),
          color: gridColor,
        });
      }

      series.buckets.forEach((b, i) => {
        const h = Math.max(0, (Math.max(0, b.value) / maxVal) * chartH);
        const x = 16 + i * (barW + gap);
        const y = topPad + chartH - h;
        const barHeight = Math.max(h, b.value > 0 ? 3 : 0);
        if (barHeight <= 0) return;
        barBatch.pushRect({
          x: ox + x * scale,
          y: oy + y * scale,
          w: barW * scale,
          h: barHeight * scale,
          fill: cssColorToRGBA(b.color, 0.88),
          radius: Math.min(4 * scale, (barW * scale) / 2),
        });
      });

      return surface.render([gridBatch, barBatch]);
    },
    [series, totalW, chartH, topPad, bottomPad, barW, gap],
  );

  return (
    <GpuLayer
      surfaceKind="base-chart"
      onRender={onRender}
      renderDeps={[series, totalW, chartH, topPad, bottomPad, barW, gap]}
      onBackendReady={onBackendReady}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
    />
  );
}

export function BasePieChartGpuLayer({
  series,
  onBackendReady,
}: {
  series: GroupedSeries;
  onBackendReady?: (backend: GpuBackendKind) => void;
}) {
  const batchRef = useRef<InstanceBatch | null>(null);
  const onRender = useCallback(
    (surface: GpuSurface, width: number, height: number) => {
      const batch = (batchRef.current ??= new InstanceBatch(32, 32, 128));
      batch.reset();
      surface.setClearColor([0, 0, 0, 0]);
      const positive = series.buckets.filter((b) => b.value > 0);
      const total = positive.reduce((acc, b) => acc + b.value, 0);
      const cx = width / 2;
      const cy = height / 2;
      const scale = Math.min(width, height) / 160;
      const outerR = (56 + 12) * scale;
      const innerR = (56 - 12) * scale;

      const innerRatio = innerR / Math.max(1, outerR);
      batch.pushArc({
        cx,
        cy,
        rx: outerR,
        ry: outerR,
        innerRatio,
        startAngle: 0,
        endAngle: Math.PI * 2,
        color: cssColorToRGBA("#eef0f3"),
      });

      if (total > 0) {
        let angle = -Math.PI / 2;
        for (const b of positive) {
          const sweep = (b.value / total) * Math.PI * 2;
          const gapAngle = positive.length > 1 ? 0.02 : 0;
          batch.pushArc({
            cx,
            cy,
            rx: outerR,
            ry: outerR,
            innerRatio,
            startAngle: angle,
            endAngle: angle + Math.max(0.01, sweep - gapAngle),
            color: cssColorToRGBA(b.color),
          });
          angle += sweep;
        }
      }

      return surface.render([batch]);
    },
    [series],
  );

  return (
    <GpuLayer
      surfaceKind="base-chart"
      onRender={onRender}
      renderDeps={[series]}
      onBackendReady={onBackendReady}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
    />
  );
}

export function BaseLineChartGpuLayer({
  series,
  w,
  h,
  padL,
  padR,
  padT,
  padB,
  onBackendReady,
}: {
  series: GroupedSeries;
  w: number;
  h: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  onBackendReady?: (backend: GpuBackendKind) => void;
}) {
  const batchRef = useRef<InstanceBatch | null>(null);
  const onRender = useCallback(
    (surface: GpuSurface, width: number, height: number) => {
      const batch = (batchRef.current ??= new InstanceBatch(64, 256, 128));
      batch.reset();
      surface.setClearColor([0, 0, 0, 0]);
      const vbH = h + padT + padB;
      const { scale, ox, oy } = viewBoxProjection(width, height, w, vbH);
      const maxVal = Math.max(1, ...series.buckets.map((b) => Math.max(0, b.value)));
      const usableW = w - padL - padR;
      const gridColor = cssColorToRGBA("#eef0f3");

      for (const r of [0, 0.5, 1]) {
        const y = oy + (padT + h * (1 - r)) * scale;
        batch.pushLine({
          x1: ox + padL * scale,
          y1: y,
          x2: ox + (w - padR) * scale,
          y2: y,
          thickness: Math.max(1, scale),
          color: gridColor,
        });
      }

      const pts = series.buckets.map((b, i) => {
        const vx = series.buckets.length === 1 ? padL + usableW / 2 : padL + (i / (series.buckets.length - 1)) * usableW;
        const vy = padT + h - (Math.max(0, b.value) / maxVal) * h;
        return { x: ox + vx * scale, y: oy + vy * scale };
      });

      for (let i = 0; i + 1 < pts.length; i++) {
        batch.pushLine({
          x1: pts[i].x,
          y1: pts[i].y,
          x2: pts[i + 1].x,
          y2: pts[i + 1].y,
          thickness: Math.max(1.8, 2.2 * scale),
          color: PRIMARY_BLUE,
        });
      }

      for (const p of pts) {
        const r = Math.max(3, 4.5 * scale);
        batch.pushArc({ cx: p.x, cy: p.y, rx: r, ry: r, color: PRIMARY_BLUE });
        batch.pushArc({ cx: p.x, cy: p.y, rx: Math.max(1.5, r - 2 * scale), ry: Math.max(1.5, r - 2 * scale), color: WHITE });
      }

      return surface.render([batch]);
    },
    [series, w, h, padL, padR, padT, padB],
  );

  return (
    <GpuLayer
      surfaceKind="base-chart"
      onRender={onRender}
      renderDeps={[series, w, h, padL, padR, padT, padB]}
      onBackendReady={onBackendReady}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
    />
  );
}

export function BaseHBarChartGpuLayer({
  value,
  maxVal,
  color,
  onBackendReady,
}: {
  value: number;
  maxVal: number;
  color: string;
  onBackendReady?: (backend: GpuBackendKind) => void;
}) {
  const batchRef = useRef<InstanceBatch | null>(null);
  const onRender = useCallback(
    (surface: GpuSurface, width: number, height: number) => {
      const batch = (batchRef.current ??= new InstanceBatch(8, 0, 0));
      batch.reset();
      surface.setClearColor([0, 0, 0, 0]);
      batch.pushRect({ x: 0, y: 0, w: width, h: height, fill: cssColorToRGBA("#f2f3f5"), radius: 4 });
      const ratio = Math.max(0, value) / Math.max(1, maxVal);
      if (ratio > 0) {
        batch.pushRect({
          x: 0,
          y: 0,
          w: Math.max(4, width * ratio),
          h: height,
          fill: cssColorToRGBA(color, 0.88),
          radius: 4,
        });
      }
      return surface.render([batch]);
    },
    [value, maxVal, color],
  );

  return (
    <GpuLayer
      surfaceKind="base-chart"
      onRender={onRender}
      renderDeps={[value, maxVal, color]}
      onBackendReady={onBackendReady}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
    />
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { GripHorizontal, Pencil, Trash2 } from "lucide-react";
import { InstanceBatch, type GpuSurface } from "@jiange/render-gpu";
import type { SheetChart, SheetWorksheet } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cssColorToRGBA, GpuLayer } from "@/components/gpu-canvas";
import type { EvaluatedSheetMap } from "./workbook-engine";
import { CHART_PALETTE, extractChartDataset, formatPivotNumber } from "./sheet-analytics";
import { formatSheetRectA1 } from "./sheet-rules";

function formatAxisTick(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function ChartSvg({
  chart,
  sheet,
  evalMap,
}: {
  chart: SheetChart;
  sheet: SheetWorksheet;
  evalMap: EvaluatedSheetMap;
}) {
  const { t } = useI18n();
  const [gpuActive, setGpuActive] = useState(false);
  const gridBatchRef = useRef<InstanceBatch | null>(null);
  const batchRef = useRef<InstanceBatch | null>(null);
  const ds = extractChartDataset(sheet, evalMap, chart);
  const w = Math.max(240, chart.width - 24);
  const legendH = chart.showLegend && ds.series.length > 0 ? 26 : 0;
  const h = Math.max(130, chart.height - 56 - legendH);

  const renderChartGpu = useCallback(
    (surface: GpuSurface) => {
      if (ds.labels.length === 0 || ds.series.length === 0) return null;
      const gridBatch = (gridBatchRef.current ??= new InstanceBatch(16, 128, 0));
      const batch = (batchRef.current ??= new InstanceBatch(512, 512, 128));
      gridBatch.reset();
      batch.reset();

      if (chart.type === "pie") {
        const primary = ds.series[0];
        const slices = ds.labels
          .map((label, idx) => ({
            label,
            value: Math.max(0, primary.values[idx] ?? 0),
            color: CHART_PALETTE[idx % CHART_PALETTE.length],
          }))
          .filter((s) => s.value > 0);
        const sum = slices.reduce((acc, s) => acc + s.value, 0);
        if (sum > 0) {
          const cx = Math.min(w * 0.36, h * 0.5 + 12);
          const cy = h / 2;
          const outerR = Math.max(36, Math.min(cx - 12, cy - 10));
          const innerR = outerR * 0.52;
          let angle = -Math.PI / 2;
          for (const s of slices) {
            const sweep = (s.value / sum) * Math.PI * 2;
            batch.pushArc({
              cx: outerR + 10,
              cy,
              rx: outerR,
              ry: outerR,
              innerRatio: innerR / outerR,
              startAngle: angle,
              endAngle: angle + sweep,
              color: cssColorToRGBA(s.color),
            });
            angle += sweep;
          }
        }
        return surface.render([batch]);
      }

      const maxV = Math.max(1, ds.maxVal);
      const minV = Math.min(0, ds.minVal);
      const span = Math.max(1, maxV - minV);
      const gridColor = cssColorToRGBA("#eff0f1");

      if (chart.type === "bar") {
        const padL = 68;
        const padR = 24;
        const padT = 8;
        const padB = 20;
        const plotW = Math.max(60, w - padL - padR);
        const plotH = Math.max(60, h - padT - padB);
        const groupH = plotH / ds.labels.length;
        const barH = Math.max(4, Math.min(18, (groupH - 6) / ds.series.length));
        for (const frac of [0, 0.5, 1]) {
          const x = padL + frac * plotW;
          gridBatch.pushLine({ x1: x, y1: padT, x2: x, y2: padT + plotH, thickness: 1, color: gridColor });
        }
        ds.labels.forEach((_, i) => {
          const gy = padT + i * groupH;
          ds.series.forEach((s, si) => {
            const val = s.values[i] ?? 0;
            const bw = Math.max(2, ((Math.max(0, val) - minV) / span) * plotW);
            const y = gy + (groupH - barH * ds.series.length) / 2 + si * barH;
            batch.pushRect({ x: padL, y, w: bw, h: Math.max(3, barH - 1.5), fill: cssColorToRGBA(s.color), radius: 2 });
          });
        });
        return surface.render([gridBatch, batch]);
      }

      const padL = 42;
      const padR = 14;
      const padT = 14;
      const padB = 26;
      const plotW = Math.max(60, w - padL - padR);
      const plotH = Math.max(60, h - padT - padB);
      const yFor = (val: number) => padT + plotH - ((val - minV) / span) * plotH;
      const zeroY = yFor(0);
      const groupW = plotW / ds.labels.length;

      for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
        const y = yFor(minV + frac * span);
        gridBatch.pushLine({ x1: padL, y1: y, x2: padL + plotW, y2: y, thickness: 1, color: gridColor });
      }
      gridBatch.pushLine({ x1: padL, y1: zeroY, x2: padL + plotW, y2: zeroY, thickness: 1, color: cssColorToRGBA("#d0d3d6") });

      if (chart.type === "column") {
        ds.labels.forEach((_, i) => {
          const gx = padL + i * groupW;
          const innerW = Math.max(6, groupW * 0.72);
          const barW = Math.max(4, innerW / ds.series.length - 2);
          const startX = gx + (groupW - (barW + 2) * ds.series.length) / 2;
          ds.series.forEach((s, si) => {
            const val = s.values[i] ?? 0;
            const yTop = val >= 0 ? yFor(val) : zeroY;
            const barH = Math.max(2, Math.abs(yFor(val) - zeroY));
            const bx = startX + si * (barW + 2);
            batch.pushRect({ x: bx, y: yTop, w: barW, h: barH, fill: cssColorToRGBA(s.color), radius: 2 });
          });
        });
      } else {
        ds.series.forEach((s) => {
          const col = cssColorToRGBA(s.color);
          const pts = ds.labels.map((_, i) => ({
            x: padL + i * groupW + groupW / 2,
            y: yFor(s.values[i] ?? 0),
          }));
          for (let i = 0; i + 1 < pts.length; i++) {
            batch.pushLine({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y, thickness: 2, color: col });
          }
          for (const pt of pts) {
            batch.pushArc({ cx: pt.x, cy: pt.y, rx: 4, ry: 4, color: col });
            batch.pushArc({ cx: pt.x, cy: pt.y, rx: 2, ry: 2, color: [1, 1, 1, 1] });
          }
        });
      }
      return surface.render([gridBatch, batch]);
    },
    [chart.type, ds, h, w],
  );

  if (ds.labels.length === 0 || ds.series.length === 0) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-[#8f959e]">
        {t("所选区域暂无可绘制的数值数据")}
      </div>
    );
  }

  if (chart.type === "pie") {
    const primary = ds.series[0];
    const slices = ds.labels
      .map((label, idx) => ({
        label,
        value: Math.max(0, primary.values[idx] ?? 0),
        color: CHART_PALETTE[idx % CHART_PALETTE.length],
      }))
      .filter((s) => s.value > 0);
    const sum = slices.reduce((acc, s) => acc + s.value, 0);
    if (sum <= 0) {
      return (
        <div className="grid h-full place-items-center text-[12px] text-[#8f959e]">
          {t("饼图需要正数值数据")}
        </div>
      );
    }
    const cx = Math.min(w * 0.36, h * 0.5 + 12);
    const cy = h / 2;
    const outerR = Math.max(36, Math.min(cx - 12, cy - 10));
    const innerR = outerR * 0.52;
    let angle = -Math.PI / 2;
    const pieW = outerR * 2 + 20;

    return (
      <div className="flex h-full items-center gap-3 overflow-hidden">
        <div className="relative shrink-0" style={{ width: pieW, height: h }}>
          <GpuLayer
            surfaceKind="sheet-chart"
            width={pieW}
            height={h}
            onRender={renderChartGpu}
            renderDeps={[chart, ds]}
            onBackendReady={(k) => { if (k === "webgpu" || k === "webgl2") setGpuActive(true); }}
          />
          <svg width={pieW} height={h} className="relative z-[1] block shrink-0">
            {slices.map((s, i) => {
              const sweep = (s.value / sum) * Math.PI * 2;
              const start = angle;
              angle += sweep;
              if (slices.length === 1) {
                return (
                  <circle key={i} data-chart-pie-slice={i} cx={outerR + 10} cy={cy} r={(outerR + innerR) / 2} fill="none" stroke={gpuActive ? "transparent" : s.color} strokeWidth={outerR - innerR}>
                    <title>{`${s.label}: ${formatPivotNumber(s.value)} (100%)`}</title>
                  </circle>
                );
              }
              const x1 = outerR + 10 + outerR * Math.cos(start);
              const y1 = cy + outerR * Math.sin(start);
              const x2 = outerR + 10 + outerR * Math.cos(angle);
              const y2 = cy + outerR * Math.sin(angle);
              const ix1 = outerR + 10 + innerR * Math.cos(angle);
              const iy1 = cy + innerR * Math.sin(angle);
              const ix2 = outerR + 10 + innerR * Math.cos(start);
              const iy2 = cy + innerR * Math.sin(start);
              const largeArc = sweep > Math.PI ? 1 : 0;
              const d = `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2} ${iy2} Z`;
              const pct = ((s.value / sum) * 100).toFixed(1);
              return (
                <path key={i} data-chart-pie-slice={i} d={d} fill={gpuActive ? "transparent" : s.color} stroke={gpuActive ? "transparent" : "#ffffff"} strokeWidth={1.5}>
                  <title>{`${s.label}: ${formatPivotNumber(s.value)} (${pct}%)`}</title>
                </path>
              );
            })}
            <text x={outerR + 10} y={cy - 3} textAnchor="middle" className="fill-[#8f959e] text-[10px]">
              {t("总计")}
            </text>
            <text x={outerR + 10} y={cy + 13} textAnchor="middle" className="fill-[#1f2329] text-[12px] font-semibold">
              {formatAxisTick(sum)}
            </text>
          </svg>
        </div>
        {chart.showLegend && (
          <div className="min-w-0 flex-1 space-y-1 overflow-y-auto pr-1 text-[11px]">
            {slices.slice(0, 8).map((s, i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
                  <span className="truncate text-[#4b5058]">{s.label}</span>
                </span>
                <span className="shrink-0 font-mono text-[#1f2329]">
                  {((s.value / sum) * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const maxV = Math.max(1, ds.maxVal);
  const minV = Math.min(0, ds.minVal);
  const span = Math.max(1, maxV - minV);

  if (chart.type === "bar") {
    const padL = 68;
    const padR = 24;
    const padT = 8;
    const padB = 20;
    const plotW = Math.max(60, w - padL - padR);
    const plotH = Math.max(60, h - padT - padB);
    const groupH = plotH / ds.labels.length;
    const barH = Math.max(4, Math.min(18, (groupH - 6) / ds.series.length));

    return (
      <div>
        <div className="relative" style={{ width: w, height: h }}>
          <GpuLayer
            surfaceKind="sheet-chart"
            width={w}
            height={h}
            onRender={renderChartGpu}
            renderDeps={[chart, ds]}
            onBackendReady={(k) => { if (k === "webgpu" || k === "webgl2") setGpuActive(true); }}
          />
          <svg width={w} height={h} className="relative z-[1] block overflow-visible">
            {[0, 0.5, 1].map((frac, idx) => {
              const x = padL + frac * plotW;
              const val = minV + frac * span;
              return (
                <g key={idx}>
                  {!gpuActive && <line x1={x} y1={padT} x2={x} y2={padT + plotH} stroke="#eff0f1" strokeWidth={1} />}
                  <text x={x} y={padT + plotH + 14} textAnchor="middle" className="fill-[#8f959e] text-[10px]">
                    {formatAxisTick(val)}
                  </text>
                </g>
              );
            })}
            {ds.labels.map((lbl, i) => {
              const gy = padT + i * groupH;
              return (
                <g key={i}>
                  <text x={padL - 6} y={gy + groupH / 2 + 3} textAnchor="end" className="fill-[#646a73] text-[10px]">
                    {lbl.length > 8 ? `${lbl.slice(0, 7)}…` : lbl}
                  </text>
                  {ds.series.map((s, si) => {
                    const val = s.values[i] ?? 0;
                    const bw = Math.max(2, ((Math.max(0, val) - minV) / span) * plotW);
                    const y = gy + (groupH - barH * ds.series.length) / 2 + si * barH;
                    return (
                      <g key={si}>
                        <rect x={padL} y={y} width={bw} height={Math.max(3, barH - 1.5)} rx={2} fill={gpuActive ? "transparent" : s.color}>
                          <title>{`${lbl} · ${s.name}: ${formatPivotNumber(val)}`}</title>
                        </rect>
                        {chart.showValues && (
                          <text x={padL + bw + 4} y={y + barH - 2} className="fill-[#646a73] text-[9px]">
                            {formatAxisTick(val)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
        {chart.showLegend && (
          <div className="mt-1 flex flex-wrap items-center justify-center gap-3 text-[11px] text-[#646a73]">
            {ds.series.map((s, idx) => (
              <span key={idx} className="inline-flex items-center gap-1">
                <span className="size-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                {s.name}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Column, Line, and Area share cartesian Y-axis layout.
  const padL = 42;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const plotW = Math.max(60, w - padL - padR);
  const plotH = Math.max(60, h - padT - padB);
  const yFor = (val: number) => padT + plotH - ((val - minV) / span) * plotH;
  const zeroY = yFor(0);
  const groupW = plotW / ds.labels.length;

  return (
    <div>
      <div className="relative" style={{ width: w, height: h }}>
        <GpuLayer
          surfaceKind="sheet-chart"
          width={w}
          height={h}
          onRender={renderChartGpu}
          renderDeps={[chart, ds]}
          onBackendReady={(k) => { if (k === "webgpu" || k === "webgl2") setGpuActive(true); }}
        />
        <svg width={w} height={h} className="relative z-[1] block overflow-visible">
          {[0, 0.25, 0.5, 0.75, 1].map((frac, idx) => {
            const val = minV + frac * span;
            const y = yFor(val);
            return (
              <g key={idx}>
                {!gpuActive && <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="#eff0f1" strokeWidth={1} />}
                <text x={padL - 6} y={y + 3} textAnchor="end" className="fill-[#8f959e] text-[10px]">
                  {formatAxisTick(val)}
                </text>
              </g>
            );
          })}
          {!gpuActive && <line x1={padL} y1={zeroY} x2={padL + plotW} y2={zeroY} stroke="#d0d3d6" strokeWidth={1} />}

          {chart.type === "column" &&
            ds.labels.map((lbl, i) => {
              const gx = padL + i * groupW;
              const innerW = Math.max(6, groupW * 0.72);
              const barW = Math.max(4, innerW / ds.series.length - 2);
              const startX = gx + (groupW - (barW + 2) * ds.series.length) / 2;
              return (
                <g key={i}>
                  {ds.series.map((s, si) => {
                    const val = s.values[i] ?? 0;
                    const yTop = val >= 0 ? yFor(val) : zeroY;
                    const barH = Math.max(2, Math.abs(yFor(val) - zeroY));
                    const bx = startX + si * (barW + 2);
                    return (
                      <g key={si}>
                        <rect x={bx} y={yTop} width={barW} height={barH} rx={2} fill={gpuActive ? "transparent" : s.color}>
                          <title>{`${lbl} · ${s.name}: ${formatPivotNumber(val)}`}</title>
                        </rect>
                        {chart.showValues && (
                          <text x={bx + barW / 2} y={yTop - 3} textAnchor="middle" className="fill-[#646a73] text-[9px]">
                            {formatAxisTick(val)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                  <text x={gx + groupW / 2} y={padT + plotH + 15} textAnchor="middle" className="fill-[#646a73] text-[10px]">
                    {lbl.length > 7 ? `${lbl.slice(0, 6)}…` : lbl}
                  </text>
                </g>
              );
            })}

          {(chart.type === "line" || chart.type === "area") && (
            <>
              {ds.series.map((s, si) => {
                const pts = ds.labels.map((_, i) => ({
                  x: padL + i * groupW + groupW / 2,
                  y: yFor(s.values[i] ?? 0),
                  val: s.values[i] ?? 0,
                }));
                const linePath = pts.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
                const areaPath = pts.length > 0
                  ? `${linePath} L ${pts[pts.length - 1].x} ${zeroY} L ${pts[0].x} ${zeroY} Z`
                  : "";
                return (
                  <g key={si}>
                    {chart.type === "area" && areaPath && (
                      <path d={areaPath} fill={s.color} fillOpacity={0.16} />
                    )}
                    {!gpuActive && <path d={linePath} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />}
                    {pts.map((p, idx) => (
                      <g key={idx}>
                        <circle cx={p.x} cy={p.y} r={3.2} fill={gpuActive ? "transparent" : "#ffffff"} stroke={gpuActive ? "transparent" : s.color} strokeWidth={2}>
                          <title>{`${ds.labels[idx]} · ${s.name}: ${formatPivotNumber(p.val)}`}</title>
                        </circle>
                        {chart.showValues && (
                          <text x={p.x} y={p.y - 6} textAnchor="middle" className="fill-[#646a73] text-[9px]">
                            {formatAxisTick(p.val)}
                          </text>
                        )}
                      </g>
                    ))}
                  </g>
                );
              })}
              {ds.labels.map((lbl, i) => (
                <text
                  key={i}
                  x={padL + i * groupW + groupW / 2}
                  y={padT + plotH + 15}
                  textAnchor="middle"
                  className="fill-[#646a73] text-[10px]"
                >
                  {lbl.length > 7 ? `${lbl.slice(0, 6)}…` : lbl}
                </text>
              ))}
            </>
          )}
        </svg>
      </div>
      {chart.showLegend && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-3 text-[11px] text-[#646a73]">
          {ds.series.map((s, idx) => (
            <span key={idx} className="inline-flex items-center gap-1">
              <span className="size-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function SheetChartOverlay({
  sheet,
  evalMap,
  canEdit,
  selectedChartId,
  onSelectChart,
  onEditChart,
  onUpdateChart,
  onDeleteChart,
}: {
  sheet: SheetWorksheet;
  evalMap: EvaluatedSheetMap;
  canEdit: boolean;
  selectedChartId: string | null;
  onSelectChart: (chart: SheetChart) => void;
  onEditChart: (chart: SheetChart) => void;
  onUpdateChart: (chart: SheetChart) => void;
  onDeleteChart: (chartId: string) => void;
}) {
  const { t } = useI18n();
  const charts = sheet.charts ?? [];
  const [dragDraft, setDragDraft] = useState<SheetChart | null>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupDragRef.current?.();
      cleanupDragRef.current = null;
    };
  }, []);

  const startDrag = (mode: "move" | "resize", chart: SheetChart, startX: number, startY: number) => {
    cleanupDragRef.current?.();
    let latest: SheetChart = chart;
    setDragDraft(chart);

    const onMove = (ev: PointerEvent) => {
      const dx = Math.round(ev.clientX - startX);
      const dy = Math.round(ev.clientY - startY);
      latest = mode === "move"
        ? {
            ...chart,
            x: Math.max(0, Math.min(20000, chart.x + dx)),
            y: Math.max(0, Math.min(20000, chart.y + dy)),
          }
        : {
            ...chart,
            width: Math.max(260, Math.min(1200, chart.width + dx)),
            height: Math.max(200, Math.min(800, chart.height + dy)),
          };
      setDragDraft(latest);
    };

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      cleanupDragRef.current = null;
      setDragDraft(null);
      if (latest.x !== chart.x || latest.y !== chart.y || latest.width !== chart.width || latest.height !== chart.height) {
        onUpdateChart(latest);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    cleanupDragRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  };

  if (charts.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20" data-sheet-charts-layer>
      {charts.map((rawChart) => {
        const chart = dragDraft?.id === rawChart.id ? dragDraft : rawChart;
        const isSelected = selectedChartId === chart.id;
        return (
          <div
            key={chart.id}
            data-sheet-chart={chart.id}
            data-sheet-chart-type={chart.type}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelectChart(chart);
            }}
            style={{
              left: chart.x,
              top: chart.y,
              width: chart.width,
              height: chart.height,
            }}
            className={`pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border bg-white shadow-md transition-shadow ${
              isSelected ? "border-[#3370ff] ring-2 ring-[#3370ff]/20" : "border-[#dee0e3] hover:border-[#b8c4e0]"
            }`}
          >
            <div
              data-sheet-chart-drag={chart.id}
              onPointerDown={(e) => {
                if (!canEdit || (e.target as HTMLElement).closest("button")) return;
                e.stopPropagation();
                e.preventDefault();
                startDrag("move", chart, e.clientX, e.clientY);
              }}
              className={`flex h-9 shrink-0 items-center justify-between gap-2 border-b border-[#eff0f1] bg-[#fafbfc] px-3 ${
                canEdit ? "cursor-grab active:cursor-grabbing" : ""
              }`}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                {canEdit && <GripHorizontal size={13} className="shrink-0 text-[#8f959e]" />}
                <span className="truncate text-[13px] font-semibold text-[#1f2329]">
                  {chart.title || t("未命名图表")}
                </span>
                <span className="shrink-0 rounded bg-[#eef3ff] px-1.5 py-0.5 font-mono text-[10px] text-[#3370ff]">
                  {formatSheetRectA1(chart)}
                </span>
              </div>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    title={t("编辑图表")}
                    aria-label={t("编辑图表")}
                    data-sheet-chart-edit={chart.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditChart(chart);
                    }}
                    className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#e9ecf1] hover:text-[#1f2329]"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    title={t("删除图表")}
                    aria-label={t("删除图表")}
                    data-sheet-chart-delete={chart.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteChart(chart.id);
                    }}
                    className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#fee2e2] hover:text-[#d92d20]"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 p-3">
              <ChartSvg chart={chart} sheet={sheet} evalMap={evalMap} />
            </div>

            {canEdit && (
              <div
                data-sheet-chart-resize={chart.id}
                title={t("拖拽调整图表尺寸")}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  startDrag("resize", chart, e.clientX, e.clientY);
                }}
                className="absolute bottom-0 right-0 size-4 cursor-nwse-resize"
              >
                <span className="absolute bottom-1 right-1 block size-2 border-b-2 border-r-2 border-[#b8bec7]" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

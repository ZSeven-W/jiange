import { useState } from "react";
import { t } from "@/lib/i18n";
import { fmtDashNum, type GroupedSeries, type MetricSummary } from "./dashboard-model";
import {
  BaseBarChartGpuLayer,
  BaseHBarChartGpuLayer,
  BaseLineChartGpuLayer,
  BasePieChartGpuLayer,
} from "./base-gpu-layer";

export function MetricWidgetView({ summary }: { summary: MetricSummary }) {
  return (
    <div className="mt-2">
      <div className="text-[30px] font-semibold leading-10 tabular-nums text-[#1f2329]">{summary.headline}</div>
      <div className="mt-1 text-[12px] text-[#646a73]">{summary.subtext}</div>
      {summary.progressPct !== undefined && (
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[#eef0f3]">
          <div
            className="h-full rounded-full bg-[#00b42a] transition-all"
            style={{ width: `${Math.max(0, Math.min(100, summary.progressPct))}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function BarChartView({ series, wide = false }: { series: GroupedSeries; wide?: boolean }) {
  const [gpuActive, setGpuActive] = useState(false);
  if (series.buckets.length === 0) {
    return <EmptyChart />;
  }
  const maxVal = Math.max(1, ...series.buckets.map((b) => Math.max(0, b.value)));
  const chartH = 156;
  const topPad = 22;
  const bottomPad = 28;
  const barW = Math.min(48, Math.max(24, Math.floor((wide ? 520 : 320) / Math.max(1, series.buckets.length))));
  const gap = wide ? 28 : 18;
  const totalW = Math.max(wide ? 560 : 280, series.buckets.length * (barW + gap) + 24);

  return (
    <div className="mt-3 overflow-x-auto" data-dashboard-viz="bar">
      <div className="relative h-52 w-full min-w-[260px]">
      <BaseBarChartGpuLayer
        series={series}
        totalW={totalW}
        chartH={chartH}
        topPad={topPad}
        bottomPad={bottomPad}
        barW={barW}
        gap={gap}
        onBackendReady={(backend) => { if (backend === "webgpu" || backend === "webgl2") setGpuActive(true); }}
      />
      <svg
        viewBox={`0 0 ${totalW} ${chartH + topPad + bottomPad}`}
        className="relative z-[1] h-52 w-full min-w-[260px]"
        role="img"
        aria-label={series.metricLabel}
      >
        {!gpuActive && [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = topPad + chartH * (1 - ratio);
          return (
            <line
              key={ratio}
              x1={8}
              y1={y}
              x2={totalW - 8}
              y2={y}
              stroke="#eef0f3"
              strokeWidth={1}
            />
          );
        })}
        {series.buckets.map((b, i) => {
          const h = Math.max(0, (Math.max(0, b.value) / maxVal) * chartH);
          const x = 16 + i * (barW + gap);
          const y = topPad + chartH - h;
          const shortLabel = b.label.length > 6 ? `${b.label.slice(0, 6)}…` : b.label;
          return (
            <g key={b.key || `empty-${i}`}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(h, b.value > 0 ? 3 : 0)}
                rx={4}
                fill={gpuActive ? "transparent" : b.color}
                opacity={gpuActive ? 1 : 0.88}
              >
                <title>{`${b.label}: ${fmtDashNum(b.value)}`}</title>
              </rect>
              <text
                x={x + barW / 2}
                y={Math.max(13, y - 6)}
                textAnchor="middle"
                className="fill-[#4b5058] text-[11px] font-medium tabular-nums"
              >
                {fmtDashNum(b.value)}
              </text>
              <text
                x={x + barW / 2}
                y={topPad + chartH + 17}
                textAnchor="middle"
                className="fill-[#646a73] text-[11px]"
              >
                {shortLabel}
              </text>
            </g>
          );
        })}
      </svg>
      </div>
    </div>
  );
}

export function HorizontalBarChartView({ series }: { series: GroupedSeries }) {
  const [gpuActive, setGpuActive] = useState(false);
  if (series.buckets.length === 0) {
    return <EmptyChart />;
  }
  const maxVal = Math.max(1, ...series.buckets.map((b) => Math.max(0, b.value)));
  return (
    <div className="mt-3 space-y-2.5" data-dashboard-viz="horizontal_bar">
      {series.buckets.map((b, i) => (
        <div key={b.key || `empty-${i}`} className="flex items-center gap-2.5 text-[12px]">
          <span className="w-24 shrink-0 truncate text-[#4b5058]" title={b.label}>{b.label}</span>
          <div className={gpuActive ? "relative h-5 min-w-0 flex-1 overflow-hidden rounded" : "relative h-5 min-w-0 flex-1 overflow-hidden rounded bg-[#f2f3f5]"}>
            <BaseHBarChartGpuLayer
              value={b.value}
              maxVal={maxVal}
              color={b.color}
              onBackendReady={(backend) => { if (backend === "webgpu" || backend === "webgl2") setGpuActive(true); }}
            />
            <div
              className="relative z-[1] h-5 rounded transition-all"
              style={{
                width: `${(Math.max(0, b.value) / maxVal) * 100}%`,
                backgroundColor: gpuActive ? "transparent" : b.color,
                opacity: b.value > 0 ? 0.88 : 0,
              }}
              title={`${b.label}: ${fmtDashNum(b.value)}`}
            />
          </div>
          <span className="w-14 shrink-0 text-right font-medium tabular-nums text-[#1f2329]">
            {fmtDashNum(b.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function PieChartView({ series }: { series: GroupedSeries }) {
  const [gpuActive, setGpuActive] = useState(false);
  const positive = series.buckets.filter((b) => b.value > 0);
  if (positive.length === 0) {
    return <EmptyChart />;
  }
  const radius = 56;
  const strokeW = 24;
  const circumference = 2 * Math.PI * radius;
  const total = positive.reduce((acc, b) => acc + b.value, 0);

  let cumulative = 0;
  const slices = positive.map((b) => {
    const frac = total > 0 ? b.value / total : 0;
    const length = frac * circumference;
    const offset = -cumulative * circumference;
    cumulative += frac;
    return { ...b, length, offset };
  });

  return (
    <div className="mt-3 flex flex-col items-center gap-4 sm:flex-row sm:items-center" data-dashboard-viz="pie">
      <div className="relative size-40 shrink-0">
        <BasePieChartGpuLayer
          series={series}
          onBackendReady={(backend) => { if (backend === "webgpu" || backend === "webgl2") setGpuActive(true); }}
        />
        <svg viewBox="0 0 160 160" className="relative z-[1] size-full -rotate-90" role="img" aria-label={series.metricLabel}>
          <circle cx={80} cy={80} r={radius} fill="none" stroke={gpuActive ? "transparent" : "#eef0f3"} strokeWidth={strokeW} />
          {slices.map((s, i) => (
            <circle
              key={s.key || `slice-${i}`}
              cx={80}
              cy={80}
              r={radius}
              fill="none"
              stroke={gpuActive ? "transparent" : s.color}
              strokeWidth={strokeW}
              strokeDasharray={`${Math.max(0.5, s.length - 1)} ${circumference}`}
              strokeDashoffset={s.offset}
            >
              <title>{`${s.label}: ${fmtDashNum(s.value)} (${s.sharePct}%)`}</title>
            </circle>
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 z-[2] flex flex-col items-center justify-center text-center">
          <span className="text-[18px] font-semibold tabular-nums text-[#1f2329]">{fmtDashNum(total)}</span>
          <span className="text-[10px] text-[#8f959e]">{t("总计")}</span>
        </div>
      </div>

      <div className="min-w-0 flex-1 space-y-1.5 text-[12px]">
        {series.buckets.map((b, i) => (
          <div key={b.key || `legend-${i}`} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: b.color }} />
              <span className="truncate text-[#4b5058]" title={b.label}>{b.label}</span>
            </span>
            <span className="shrink-0 tabular-nums text-[#1f2329]">
              {fmtDashNum(b.value)} <span className="text-[#8f959e]">({b.sharePct}%)</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LineChartView({ series, wide = false }: { series: GroupedSeries; wide?: boolean }) {
  const [gpuActive, setGpuActive] = useState(false);
  if (series.buckets.length === 0) {
    return <EmptyChart />;
  }
  const w = Math.max(wide ? 760 : 360, series.buckets.length * (wide ? 96 : 64));
  const h = 156;
  const padL = 24;
  const padR = 24;
  const padT = 22;
  const padB = 28;
  const maxVal = Math.max(1, ...series.buckets.map((b) => Math.max(0, b.value)));
  const usableW = w - padL - padR;

  const pts = series.buckets.map((b, i) => {
    const x = series.buckets.length === 1 ? padL + usableW / 2 : padL + (i / (series.buckets.length - 1)) * usableW;
    const y = padT + h - (Math.max(0, b.value) / maxVal) * h;
    return { ...b, x, y };
  });

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const areaPath =
    pts.length > 0
      ? `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${(padT + h).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(padT + h).toFixed(1)} Z`
      : "";

  return (
    <div className="mt-3 overflow-x-auto" data-dashboard-viz="line">
      <div className="relative h-52 w-full min-w-[280px]">
      <BaseLineChartGpuLayer
        series={series}
        w={w}
        h={h}
        padL={padL}
        padR={padR}
        padT={padT}
        padB={padB}
        onBackendReady={(backend) => { if (backend === "webgpu" || backend === "webgl2") setGpuActive(true); }}
      />
      <svg
        viewBox={`0 0 ${w} ${h + padT + padB}`}
        className="relative z-[1] h-52 w-full min-w-[280px]"
        role="img"
        aria-label={series.metricLabel}
      >
        {!gpuActive && [0, 0.5, 1].map((r) => {
          const y = padT + h * (1 - r);
          return <line key={r} x1={padL} y1={y} x2={w - padR} y2={y} stroke="#eef0f3" strokeWidth={1} />;
        })}
        {areaPath && <path d={areaPath} fill="#3370ff" fillOpacity={0.08} />}
        {!gpuActive && linePath && <path d={linePath} fill="none" stroke="#3370ff" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />}
        {pts.map((p, i) => {
          const lbl = p.label.length > 10 ? p.label.slice(5) : p.label;
          return (
            <g key={p.key || `pt-${i}`}>
              <circle cx={p.x} cy={p.y} r={4} fill={gpuActive ? "transparent" : "#ffffff"} stroke={gpuActive ? "transparent" : "#3370ff"} strokeWidth={2}>
                <title>{`${p.label}: ${fmtDashNum(p.value)}`}</title>
              </circle>
              <text x={p.x} y={Math.max(13, p.y - 8)} textAnchor="middle" className="fill-[#1f2329] text-[11px] font-medium tabular-nums">
                {fmtDashNum(p.value)}
              </text>
              <text x={p.x} y={padT + h + 18} textAnchor="middle" className="fill-[#646a73] text-[11px]">
                {lbl}
              </text>
            </g>
          );
        })}
      </svg>
      </div>
    </div>
  );
}

export function PivotTableView({ series }: { series: GroupedSeries }) {
  if (series.buckets.length === 0) {
    return <EmptyChart />;
  }
  return (
    <div className="mt-3 overflow-x-auto" data-dashboard-viz="pivot">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead>
          <tr className="border-b border-[#e5e6eb] bg-[#f7f8fa] text-[#646a73]">
            <th className="px-2.5 py-2 font-medium">{t("分组维度")}</th>
            <th className="px-2.5 py-2 text-right font-medium">{t("记录数")}</th>
            <th className="px-2.5 py-2 text-right font-medium">{series.metricLabel}</th>
            <th className="px-2.5 py-2 text-right font-medium">{t("占比")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#eef0f3]">
          {series.buckets.map((b, i) => (
            <tr key={b.key || `row-${i}`} className="hover:bg-[#f9fafb]">
              <td className="px-2.5 py-2">
                <span className="inline-flex items-center gap-1.5 text-[#1f2329]">
                  <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: b.color }} />
                  <span>{b.label}</span>
                </span>
              </td>
              <td className="px-2.5 py-2 text-right tabular-nums text-[#4b5058]">{fmtDashNum(b.count)}</td>
              <td className="px-2.5 py-2 text-right font-medium tabular-nums text-[#1f2329]">{fmtDashNum(b.value)}</td>
              <td className="px-2.5 py-2 text-right tabular-nums text-[#646a73]">{b.sharePct}%</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-[#dee0e3] bg-[#fafbfc] font-medium text-[#1f2329]">
            <td className="px-2.5 py-2">{t("合计")}</td>
            <td className="px-2.5 py-2 text-right tabular-nums">{fmtDashNum(series.totalCount)}</td>
            <td className="px-2.5 py-2 text-right tabular-nums">{fmtDashNum(series.totalValue)}</td>
            <td className="px-2.5 py-2 text-right tabular-nums">100%</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function EmptyChart() {
  return <div className="grid h-36 place-items-center text-[12px] text-[#8f959e]">{t("暂无可统计数据")}</div>;
}

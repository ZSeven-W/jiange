import { BarChart3, Play, Plus, Sparkles, Table2, Trash2 } from "lucide-react";
import type { SlideShape, SlideShapeAnimation, SlideShapeAnimationEffect, SlideShapeAnimationTrigger } from "@/lib/api";
import { FeishuSelect } from "@/components/feishu-select";
import {
  DEFAULT_SLIDE_ANIMATION_DURATION_MS,
  SLIDE_ANIMATION_OPTIONS,
  SLIDE_ANIMATION_TRIGGER_OPTIONS,
} from "./slides-animations";

export const SLIDE_CHART_PALETTE = [
  "#3370ff",
  "#00b42a",
  "#ff7d00",
  "#722ed1",
  "#f53f3f",
] as const;

export const SLIDE_CHART_TYPE_OPTIONS = [
  { value: "bar", label: "柱状图" },
  { value: "line", label: "折线图" },
  { value: "pie", label: "饼图" },
] as const;

export const MAX_TABLE_ROWS = 12;
export const MAX_TABLE_COLS = 8;
export const MAX_CHART_CATEGORIES = 12;
export const MAX_CHART_SERIES = 6;

export type SlideTableData = NonNullable<SlideShape["table"]>;
export type SlideChartData = NonNullable<SlideShape["chart"]>;

export function createDefaultSlideTable(): SlideTableData {
  return {
    rows: [
      ["项目", "指标", "进展"],
      ["研发效率", "92%", "已完成"],
      ["客户增长", "+34%", "进行中"],
    ],
    headerRow: true,
    headerFill: "#edf2ff",
    borderColor: "#dee0e3",
  };
}

export function createDefaultSlideChart(): SlideChartData {
  return {
    type: "bar",
    title: "季度业绩概览",
    categories: ["Q1", "Q2", "Q3"],
    series: [
      {
        name: "完成值",
        values: [68, 92, 118],
        color: SLIDE_CHART_PALETTE[0],
      },
    ],
  };
}

export function normalizeTableRows(table: SlideTableData | undefined): string[][] {
  const raw = table?.rows;
  if (!raw?.length) return [[""]];
  const cols = Math.max(1, Math.min(MAX_TABLE_COLS, ...raw.map((r) => r.length)));
  return raw.slice(0, MAX_TABLE_ROWS).map((row) =>
    Array.from({ length: cols }, (_, ci) => row[ci] ?? ""),
  );
}

export function updateTableCell(table: SlideTableData, rowIdx: number, colIdx: number, value: string): SlideTableData {
  const rows = normalizeTableRows(table).map((row, ri) =>
    ri === rowIdx ? row.map((cell, ci) => (ci === colIdx ? value : cell)) : row,
  );
  return { ...table, rows };
}

export function addTableRow(table: SlideTableData): SlideTableData {
  const rows = normalizeTableRows(table);
  if (rows.length >= MAX_TABLE_ROWS) return { ...table, rows };
  const cols = rows[0]?.length ?? 1;
  return { ...table, rows: [...rows, Array.from({ length: cols }, () => "")] };
}

export function removeTableRow(table: SlideTableData): SlideTableData {
  const rows = normalizeTableRows(table);
  if (rows.length <= 1) return { ...table, rows };
  return { ...table, rows: rows.slice(0, -1) };
}

export function addTableCol(table: SlideTableData): SlideTableData {
  const rows = normalizeTableRows(table);
  const cols = rows[0]?.length ?? 1;
  if (cols >= MAX_TABLE_COLS) return { ...table, rows };
  return {
    ...table,
    rows: rows.map((row, ri) => [...row, ri === 0 ? `列 ${cols + 1}` : ""]),
  };
}

export function removeTableCol(table: SlideTableData): SlideTableData {
  const rows = normalizeTableRows(table);
  const cols = rows[0]?.length ?? 1;
  if (cols <= 1) return { ...table, rows };
  return { ...table, rows: rows.map((row) => row.slice(0, -1)) };
}

function formatChartNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1000) {
    return `${Math.round((value / 1000) * 10) / 10}k`;
  }
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

function truncateLabel(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

/**
 * Crisp vector SVG renderer for Feishu-styled bar/column, line, and pie charts.
 * Works identically across edit stage, thumbnails, presenter mode, and print.
 */
export function SlideChartSvg({
  chart,
  className = "h-full w-full",
}: {
  chart?: SlideChartData;
  className?: string;
}) {
  const safeChart: SlideChartData = chart ?? createDefaultSlideChart();
  const chartType = safeChart.type === "column" ? "bar" : safeChart.type;
  const categories = safeChart.categories.length > 0 ? safeChart.categories : ["A", "B", "C"];
  const series = safeChart.series.length > 0
    ? safeChart.series
    : [{ name: "系列 1", values: categories.map(() => 0), color: SLIDE_CHART_PALETTE[0] }];

  const W = 400;
  const H = 240;
  const titleText = safeChart.title?.trim() ?? "";
  const hasTitle = titleText.length > 0;
  const legendItems =
    chartType === "pie"
      ? categories.map((cat, idx) => ({
          label: cat || `分类 ${idx + 1}`,
          color: SLIDE_CHART_PALETTE[idx % SLIDE_CHART_PALETTE.length],
        }))
      : series.map((s, idx) => ({
          label: s.name || `系列 ${idx + 1}`,
          color: s.color || SLIDE_CHART_PALETTE[idx % SLIDE_CHART_PALETTE.length],
        }));
  const showLegend = legendItems.length > 0;

  const padLeft = chartType === "pie" ? 16 : 42;
  const padRight = 18;
  const plotTop = hasTitle ? 36 : 18;
  const legendY = H - 14;
  const plotBottom = showLegend ? H - 46 : H - 28;
  const plotW = Math.max(40, W - padLeft - padRight);
  const plotH = Math.max(40, plotBottom - plotTop);

  const allValues = series.flatMap((s) =>
    categories.map((_, ci) => {
      const n = Number(s.values[ci] ?? 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }),
  );
  const rawMax = Math.max(0, ...allValues);
  const maxVal = rawMax > 0 ? rawMax * 1.15 : 10;
  const gridSteps = 4;

  return (
    <div
      data-slide-chart-svg
      data-chart-type={chartType}
      className={`overflow-hidden rounded-[6px] border border-[#e5e6eb] bg-white ${className}`}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-full w-full"
        role="img"
        aria-label={titleText || "幻灯片图表"}
      >
        <rect x="0" y="0" width={W} height={H} fill="#ffffff" />

        {hasTitle && (
          <text
            x={W / 2}
            y={22}
            textAnchor="middle"
            fill="#1f2329"
            fontSize="13.5"
            fontWeight="600"
            fontFamily="Inter, PingFang SC, Microsoft YaHei, sans-serif"
          >
            {truncateLabel(titleText, 28)}
          </text>
        )}

        {chartType === "pie" ? (
          (() => {
            const firstValues = categories.map((_, ci) => {
              const n = Number(series[0]?.values[ci] ?? 0);
              return Number.isFinite(n) && n > 0 ? n : 0;
            });
            const total = firstValues.reduce((acc, v) => acc + v, 0);
            const cx = W / 2;
            const cy = plotTop + plotH / 2 + 4;
            const radius = Math.min(plotW, plotH) * 0.43;

            if (total <= 0) {
              return (
                <g>
                  <circle cx={cx} cy={cy} r={radius} fill="#f2f3f5" stroke="#dee0e3" strokeWidth="1.5" />
                  <text x={cx} y={cy + 4} textAnchor="middle" fill="#8f959e" fontSize="11">
                    暂无数据
                  </text>
                </g>
              );
            }

            const nonZeroIndices = firstValues
              .map((v, idx) => (v > 0 ? idx : -1))
              .filter((idx) => idx >= 0);

            if (nonZeroIndices.length === 1) {
              const idx = nonZeroIndices[0];
              const color = SLIDE_CHART_PALETTE[idx % SLIDE_CHART_PALETTE.length];
              return (
                <g>
                  <circle cx={cx} cy={cy} r={radius} fill={color} />
                  <text
                    x={cx}
                    y={cy + 4}
                    textAnchor="middle"
                    fill="#ffffff"
                    fontSize="11"
                    fontWeight="600"
                  >
                    100% ({formatChartNumber(firstValues[idx])})
                  </text>
                </g>
              );
            }

            let angle = -Math.PI / 2;
            return (
              <g>
                {firstValues.map((val, idx) => {
                  if (val <= 0) return null;
                  const ratio = val / total;
                  const slice = ratio * Math.PI * 2;
                  const startAngle = angle;
                  const endAngle = angle + slice;
                  angle = endAngle;
                  const x1 = cx + radius * Math.cos(startAngle);
                  const y1 = cy + radius * Math.sin(startAngle);
                  const x2 = cx + radius * Math.cos(endAngle);
                  const y2 = cy + radius * Math.sin(endAngle);
                  const largeArc = slice > Math.PI ? 1 : 0;
                  const midAngle = startAngle + slice / 2;
                  const lx = cx + radius * 0.64 * Math.cos(midAngle);
                  const ly = cy + radius * 0.64 * Math.sin(midAngle);
                  const color = SLIDE_CHART_PALETTE[idx % SLIDE_CHART_PALETTE.length];
                  const pct = Math.round(ratio * 100);
                  return (
                    <g key={idx}>
                      <path
                        d={`M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${radius.toFixed(1)} ${radius.toFixed(1)} 0 ${largeArc} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`}
                        fill={color}
                        stroke="#ffffff"
                        strokeWidth="1.5"
                      />
                      {pct >= 7 && (
                        <text
                          x={lx.toFixed(1)}
                          y={(ly + 3.5).toFixed(1)}
                          textAnchor="middle"
                          fill="#ffffff"
                          fontSize="9.5"
                          fontWeight="600"
                        >
                          {pct}%
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })()
        ) : (
          <g>
            {/* Horizontal grid lines + Y-axis labels */}
            {Array.from({ length: gridSteps + 1 }, (_, step) => {
              const frac = step / gridSteps;
              const y = plotBottom - frac * plotH;
              const tickVal = maxVal * frac;
              return (
                <g key={step}>
                  <line
                    x1={padLeft}
                    y1={y.toFixed(1)}
                    x2={padLeft + plotW}
                    y2={y.toFixed(1)}
                    stroke={step === 0 ? "#d0d3d6" : "#eff0f1"}
                    strokeWidth="1"
                    strokeDasharray={step === 0 ? undefined : "3 3"}
                  />
                  <text
                    x={padLeft - 6}
                    y={(y + 3.5).toFixed(1)}
                    textAnchor="end"
                    fill="#8f959e"
                    fontSize="9.5"
                  >
                    {formatChartNumber(tickVal)}
                  </text>
                </g>
              );
            })}

            {/* X-axis category labels */}
            {categories.map((cat, ci) => {
              const cx =
                chartType === "line" && categories.length > 1
                  ? padLeft + (ci / (categories.length - 1)) * plotW
                  : padLeft + ((ci + 0.5) / categories.length) * plotW;
              return (
                <text
                  key={ci}
                  x={cx.toFixed(1)}
                  y={plotBottom + 15}
                  textAnchor="middle"
                  fill="#646a73"
                  fontSize="10"
                >
                  {truncateLabel(cat || `类 ${ci + 1}`, 8)}
                </text>
              );
            })}

            {/* Bar or Line geometry */}
            {chartType === "line" ? (
              <g>
                {series.map((s, si) => {
                  const color = s.color || SLIDE_CHART_PALETTE[si % SLIDE_CHART_PALETTE.length];
                  const pts = categories.map((_, ci) => {
                    const val = Math.max(0, Number(s.values[ci] ?? 0) || 0);
                    const px =
                      categories.length === 1
                        ? padLeft + plotW / 2
                        : padLeft + (ci / (categories.length - 1)) * plotW;
                    const py = plotBottom - (val / maxVal) * plotH;
                    return { px, py, val };
                  });
                  const polyPoints = pts.map((p) => `${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(" ");
                  return (
                    <g key={si}>
                      {pts.length > 1 && (
                        <polyline
                          points={polyPoints}
                          fill="none"
                          stroke={color}
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      )}
                      {pts.map((p, ci) => (
                        <g key={ci}>
                          <circle
                            cx={p.px.toFixed(1)}
                            cy={p.py.toFixed(1)}
                            r="3.8"
                            fill="#ffffff"
                            stroke={color}
                            strokeWidth="2.2"
                          />
                          <text
                            x={p.px.toFixed(1)}
                            y={Math.max(plotTop + 8, p.py - 7).toFixed(1)}
                            textAnchor="middle"
                            fill="#4e5969"
                            fontSize="9"
                            fontWeight="500"
                          >
                            {formatChartNumber(p.val)}
                          </text>
                        </g>
                      ))}
                    </g>
                  );
                })}
              </g>
            ) : (
              <g>
                {categories.map((_, ci) => {
                  const groupW = plotW / categories.length;
                  const innerW = groupW * 0.68;
                  const gap = series.length > 1 ? 3 : 0;
                  const barW = Math.max(6, (innerW - gap * (series.length - 1)) / series.length);
                  const groupStartX = padLeft + ci * groupW + (groupW - (barW * series.length + gap * (series.length - 1))) / 2;
                  return (
                    <g key={ci}>
                      {series.map((s, si) => {
                        const val = Math.max(0, Number(s.values[ci] ?? 0) || 0);
                        const bh = Math.max(val > 0 ? 2 : 0, (val / maxVal) * plotH);
                        const bx = groupStartX + si * (barW + gap);
                        const by = plotBottom - bh;
                        const color = s.color || SLIDE_CHART_PALETTE[si % SLIDE_CHART_PALETTE.length];
                        return (
                          <g key={si}>
                            <rect
                              x={bx.toFixed(1)}
                              y={by.toFixed(1)}
                              width={barW.toFixed(1)}
                              height={bh.toFixed(1)}
                              rx="3"
                              fill={color}
                            />
                            <text
                              x={(bx + barW / 2).toFixed(1)}
                              y={Math.max(plotTop + 8, by - 4).toFixed(1)}
                              textAnchor="middle"
                              fill="#4e5969"
                              fontSize="9"
                              fontWeight="500"
                            >
                              {formatChartNumber(val)}
                            </text>
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </g>
            )}
          </g>
        )}

        {/* Legend */}
        {showLegend && (
          <g data-slide-chart-legend>
            {(() => {
              const visibleLegend = legendItems.slice(0, 6);
              const itemW = Math.min(78, (W - 24) / visibleLegend.length);
              const totalW = itemW * visibleLegend.length;
              const startX = (W - totalW) / 2;
              return visibleLegend.map((item, idx) => {
                const lx = startX + idx * itemW;
                return (
                  <g key={idx}>
                    <rect x={lx.toFixed(1)} y={(legendY - 7).toFixed(1)} width="8" height="8" rx="2" fill={item.color} />
                    <text
                      x={(lx + 11).toFixed(1)}
                      y={legendY}
                      fill="#646a73"
                      fontSize="9.5"
                    >
                      {truncateLabel(item.label, 7)}
                    </text>
                  </g>
                );
              });
            })()}
          </g>
        )}
      </svg>
    </div>
  );
}

/**
 * Compact Feishu inspector editor for a selected `table` slide shape.
 */
export function SlideTableEditor({
  shape,
  canEdit,
  onChange,
}: {
  shape: SlideShape;
  canEdit: boolean;
  onChange: (patch: Partial<SlideShape>) => void;
}) {
  const table: SlideTableData = shape.table ?? createDefaultSlideTable();
  const rows = normalizeTableRows(table);
  const rowCount = rows.length;
  const colCount = rows[0]?.length ?? 1;

  const commitTable = (next: SlideTableData) => {
    if (!canEdit) return;
    onChange({
      table: {
        headerRow: table.headerRow ?? true,
        headerFill: table.headerFill ?? "#edf2ff",
        borderColor: table.borderColor ?? "#dee0e3",
        ...next,
      },
    });
  };

  return (
    <div className="mb-5 border-b border-[#e5e6eb] pb-4" data-slide-table-editor>
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-medium text-[#1f2329]">
          <Table2 size={14} className="text-[#3370ff]" />
          <span>表格数据</span>
        </div>
        <span className="rounded bg-[#f2f3f5] px-1.5 py-0.5 text-[11px] tabular-nums text-[#646a73]">
          {rowCount} × {colCount}
        </span>
      </div>

      <div className="mb-2.5 grid grid-cols-4 gap-1">
        <button
          type="button"
          data-slide-table-add-row
          disabled={!canEdit || rowCount >= MAX_TABLE_ROWS}
          onClick={() => commitTable(addTableRow(table))}
          className="h-7 rounded border border-[#dee0e3] bg-white text-[11px] text-[#1f2329] hover:bg-[#f2f3f5] disabled:opacity-40"
        >
          + 行
        </button>
        <button
          type="button"
          data-slide-table-add-col
          disabled={!canEdit || colCount >= MAX_TABLE_COLS}
          onClick={() => commitTable(addTableCol(table))}
          className="h-7 rounded border border-[#dee0e3] bg-white text-[11px] text-[#1f2329] hover:bg-[#f2f3f5] disabled:opacity-40"
        >
          + 列
        </button>
        <button
          type="button"
          data-slide-table-del-row
          disabled={!canEdit || rowCount <= 1}
          onClick={() => commitTable(removeTableRow(table))}
          className="h-7 rounded border border-[#dee0e3] bg-white text-[11px] text-[#646a73] hover:bg-[#fff2f0] hover:text-[#d83931] disabled:opacity-40"
        >
          - 末行
        </button>
        <button
          type="button"
          data-slide-table-del-col
          disabled={!canEdit || colCount <= 1}
          onClick={() => commitTable(removeTableCol(table))}
          className="h-7 rounded border border-[#dee0e3] bg-white text-[11px] text-[#646a73] hover:bg-[#fff2f0] hover:text-[#d83931] disabled:opacity-40"
        >
          - 末列
        </button>
      </div>

      <div className="max-h-56 overflow-auto rounded-md border border-[#dee0e3]">
        <table className="w-full border-collapse text-[11px]">
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className={ri === 0 ? "bg-[#f0f5ff]" : "bg-white"}>
                {row.map((cell, ci) => (
                  <td key={ci} className="border border-[#e5e6eb] p-0">
                    <input
                      type="text"
                      maxLength={500}
                      aria-label={`表格第 ${ri + 1} 行第 ${ci + 1} 列`}
                      data-slide-table-cell={`${ri}-${ci}`}
                      disabled={!canEdit}
                      value={cell}
                      onChange={(e) => commitTable(updateTableCell(table, ri, ci, e.target.value))}
                      className={`h-7 w-full min-w-[54px] bg-transparent px-1.5 text-[11px] outline-none focus:bg-[#e8efff]/40 ${
                        ri === 0 ? "font-medium text-[#1f2329]" : "text-[#4e5969]"
                      }`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Compact Feishu inspector editor for a selected `chart` slide shape.
 */
export function SlideChartEditor({
  shape,
  canEdit,
  onChange,
}: {
  shape: SlideShape;
  canEdit: boolean;
  onChange: (patch: Partial<SlideShape>) => void;
}) {
  const chart: SlideChartData = shape.chart ?? createDefaultSlideChart();
  const normalizedType = chart.type === "column" ? "bar" : chart.type;
  const categories = chart.categories.length > 0 ? chart.categories : ["Q1"];
  const series = chart.series.length > 0
    ? chart.series
    : [{ name: "系列 1", values: categories.map(() => 0), color: SLIDE_CHART_PALETTE[0] }];

  const commitChart = (next: SlideChartData) => {
    if (!canEdit) return;
    onChange({ chart: next });
  };

  const updateCategory = (idx: number, label: string) => {
    commitChart({
      ...chart,
      categories: categories.map((c, i) => (i === idx ? label : c)),
    });
  };

  const addCategory = () => {
    if (categories.length >= MAX_CHART_CATEGORIES) return;
    const nextLabel = `Q${categories.length + 1}`;
    commitChart({
      ...chart,
      categories: [...categories, nextLabel],
      series: series.map((s) => ({
        ...s,
        values: [...categories.map((_, i) => s.values[i] ?? 0), 50],
      })),
    });
  };

  const removeCategory = (idx: number) => {
    if (categories.length <= 1) return;
    commitChart({
      ...chart,
      categories: categories.filter((_, i) => i !== idx),
      series: series.map((s) => ({
        ...s,
        values: s.values.filter((_, i) => i !== idx),
      })),
    });
  };

  const addSeries = () => {
    if (series.length >= MAX_CHART_SERIES) return;
    const idx = series.length;
    commitChart({
      ...chart,
      series: [
        ...series,
        {
          name: `系列 ${idx + 1}`,
          values: categories.map(() => 40 + idx * 15),
          color: SLIDE_CHART_PALETTE[idx % SLIDE_CHART_PALETTE.length],
        },
      ],
    });
  };

  const removeSeries = (sIdx: number) => {
    if (series.length <= 1) return;
    commitChart({
      ...chart,
      series: series.filter((_, i) => i !== sIdx),
    });
  };

  const updateSeriesName = (sIdx: number, name: string) => {
    commitChart({
      ...chart,
      series: series.map((s, i) => (i === sIdx ? { ...s, name } : s)),
    });
  };

  const updateSeriesValue = (sIdx: number, cIdx: number, raw: string) => {
    const parsed = Number(raw);
    const value = Number.isFinite(parsed) ? parsed : 0;
    commitChart({
      ...chart,
      series: series.map((s, i) => {
        if (i !== sIdx) return s;
        const vals = categories.map((_, k) => (k === cIdx ? value : (s.values[k] ?? 0)));
        return { ...s, values: vals };
      }),
    });
  };

  return (
    <div className="mb-5 border-b border-[#e5e6eb] pb-4" data-slide-chart-editor>
      <div className="mb-3 flex items-center gap-1.5 font-medium text-[#1f2329]">
        <BarChart3 size={14} className="text-[#3370ff]" />
        <span>图表配置</span>
      </div>

      <div className="flex h-9 items-center justify-between gap-2">
        <span className="text-[#4e5969]">图表类型</span>
        <FeishuSelect
          ariaLabel="图表类型"
          title="图表类型"
          value={normalizedType}
          options={SLIDE_CHART_TYPE_OPTIONS}
          disabled={!canEdit}
          onChange={(val) => commitChart({ ...chart, type: val as SlideChartData["type"] })}
          className="h-8 w-[124px] border border-[#dee0e3] px-2 text-[12px]"
          chevronSize={12}
          menuMinWidth={124}
          dataAttr={{ "data-slide-chart-type-select": true }}
        />
      </div>

      <label className="mt-2 block">
        <span className="mb-1 block text-[12px] text-[#4e5969]">图表标题</span>
        <input
          type="text"
          maxLength={120}
          aria-label="图表标题"
          data-slide-chart-title
          disabled={!canEdit}
          value={chart.title ?? ""}
          onChange={(e) => commitChart({ ...chart, title: e.target.value })}
          placeholder="输入图表标题"
          className="h-8 w-full rounded-md border border-[#dee0e3] bg-white px-2 text-[12px] text-[#1f2329] outline-none focus:border-[#3370ff] disabled:opacity-40"
        />
      </label>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12px] font-medium text-[#4e5969]">分类项</span>
          <button
            type="button"
            data-slide-chart-add-category
            disabled={!canEdit || categories.length >= MAX_CHART_CATEGORIES}
            onClick={addCategory}
            className="inline-flex h-6 items-center gap-0.5 rounded border border-[#dee0e3] px-1.5 text-[11px] text-[#3370ff] hover:bg-[#f0f5ff] disabled:opacity-40"
          >
            <Plus size={11} />
            <span>分类</span>
          </button>
        </div>
        <div className="space-y-1">
          {categories.map((cat, ci) => (
            <div key={ci} className="flex items-center gap-1">
              <input
                type="text"
                aria-label={`分类 ${ci + 1}`}
                data-slide-chart-category={ci}
                disabled={!canEdit}
                value={cat}
                onChange={(e) => updateCategory(ci, e.target.value)}
                className="h-7 min-w-0 flex-1 rounded border border-[#dee0e3] px-2 text-[12px] text-[#1f2329] outline-none focus:border-[#3370ff] disabled:opacity-40"
              />
              {categories.length > 1 && (
                <button
                  type="button"
                  aria-label={`删除分类 ${ci + 1}`}
                  disabled={!canEdit}
                  onClick={() => removeCategory(ci)}
                  className="grid size-7 shrink-0 place-items-center rounded text-[#8f959e] hover:bg-[#fff2f0] hover:text-[#d83931] disabled:opacity-40"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12px] font-medium text-[#4e5969]">数据系列</span>
          <button
            type="button"
            data-slide-chart-add-series
            disabled={!canEdit || series.length >= MAX_CHART_SERIES}
            onClick={addSeries}
            className="inline-flex h-6 items-center gap-0.5 rounded border border-[#dee0e3] px-1.5 text-[11px] text-[#3370ff] hover:bg-[#f0f5ff] disabled:opacity-40"
          >
            <Plus size={11} />
            <span>系列</span>
          </button>
        </div>
        <div className="space-y-2">
          {series.map((s, si) => {
            const color = s.color || SLIDE_CHART_PALETTE[si % SLIDE_CHART_PALETTE.length];
            return (
              <div key={si} className="rounded-md border border-[#e5e6eb] bg-[#fafbfc] p-2">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    maxLength={80}
                    aria-label={`系列 ${si + 1} 名称`}
                    data-slide-chart-series-name={si}
                    disabled={!canEdit}
                    value={s.name}
                    onChange={(e) => updateSeriesName(si, e.target.value)}
                    className="h-6 min-w-0 flex-1 rounded border border-[#dee0e3] bg-white px-1.5 text-[11px] font-medium text-[#1f2329] outline-none focus:border-[#3370ff] disabled:opacity-40"
                  />
                  {series.length > 1 && (
                    <button
                      type="button"
                      aria-label={`删除系列 ${si + 1}`}
                      disabled={!canEdit}
                      onClick={() => removeSeries(si)}
                      className="grid size-6 shrink-0 place-items-center rounded text-[#8f959e] hover:bg-[#fff2f0] hover:text-[#d83931] disabled:opacity-40"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {categories.map((cat, ci) => (
                    <label key={ci} className="flex flex-col gap-0.5">
                      <span className="truncate text-[10px] text-[#8f959e]">{cat || `类 ${ci + 1}`}</span>
                      <input
                        type="number"
                        aria-label={`${s.name || `系列 ${si + 1}`} - ${cat || `分类 ${ci + 1}`}`}
                        data-slide-chart-value={`${si}-${ci}`}
                        disabled={!canEdit}
                        value={s.values[ci] ?? 0}
                        onChange={(e) => updateSeriesValue(si, ci, e.target.value)}
                        className="h-6 w-full rounded border border-[#dee0e3] bg-white px-1.5 text-[11px] tabular-nums text-[#1f2329] outline-none focus:border-[#3370ff] disabled:opacity-40"
                      />
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Feishu inspector section for configuring element-level animations on ANY selected shape.
 */
export function SlideElementAnimationControls({
  shapeId,
  animation,
  defaultOrder = 1,
  canEdit,
  onChange,
  onPreview,
}: {
  shapeId: string;
  animation?: SlideShapeAnimation;
  defaultOrder?: number;
  canEdit: boolean;
  onChange: (anim: SlideShapeAnimation | null) => void;
  onPreview?: (shapeId: string, anim: SlideShapeAnimation) => void;
}) {
  const effectValue = animation?.effect ?? "none";
  const triggerValue: SlideShapeAnimationTrigger = animation?.trigger ?? "click";
  const orderValue = animation?.order ?? defaultOrder;
  const durationValue = animation?.durationMs ?? DEFAULT_SLIDE_ANIMATION_DURATION_MS;

  const handleEffectChange = (val: string) => {
    if (!canEdit) return;
    if (val === "none") {
      onChange(null);
      return;
    }
    onChange({
      effect: val as SlideShapeAnimationEffect,
      order: animation?.order ?? Math.max(1, Math.min(100, defaultOrder)),
      durationMs: animation?.durationMs ?? DEFAULT_SLIDE_ANIMATION_DURATION_MS,
      trigger: animation?.trigger ?? "click",
    });
  };

  return (
    <div className="mb-5 border-b border-[#e5e6eb] pb-4" data-slide-element-animation-section>
      <div className="mb-3 flex items-center gap-1.5 font-medium text-[#1f2329]">
        <Sparkles size={14} className="text-[#3370ff]" />
        <span>元素动画</span>
        {animation && (
          <span className="ml-auto grid size-5 place-items-center rounded-full bg-[#3370ff] text-[10px] font-semibold tabular-nums text-white">
            {animation.order}
          </span>
        )}
      </div>

      <div className="flex h-9 items-center justify-between gap-2">
        <span className="text-[#4e5969]">动画效果</span>
        <FeishuSelect
          ariaLabel="元素动画效果"
          title="元素动画效果"
          value={effectValue}
          options={SLIDE_ANIMATION_OPTIONS}
          disabled={!canEdit}
          onChange={handleEffectChange}
          className="h-8 w-[132px] border border-[#dee0e3] px-2 text-[12px]"
          chevronSize={12}
          menuMinWidth={132}
          dataAttr={{ "data-slide-elem-anim-effect": true }}
        />
      </div>

      {animation && (
        <>
          <div className="mt-2 flex h-9 items-center justify-between gap-2">
            <span className="text-[#4e5969]">触发方式</span>
            <FeishuSelect
              ariaLabel="元素动画触发方式"
              title="元素动画触发方式"
              value={triggerValue}
              options={SLIDE_ANIMATION_TRIGGER_OPTIONS}
              disabled={!canEdit}
              onChange={(val) =>
                onChange({
                  ...animation,
                  trigger: val as SlideShapeAnimationTrigger,
                })
              }
              className="h-8 w-[132px] border border-[#dee0e3] px-2 text-[12px]"
              chevronSize={12}
              menuMinWidth={132}
              dataAttr={{ "data-slide-elem-anim-trigger": true }}
            />
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="flex items-center justify-between gap-1.5 rounded-md border border-[#dee0e3] bg-white px-2 py-1">
              <span className="text-[11px] text-[#646a73]">顺序</span>
              <input
                type="number"
                aria-label="动画顺序"
                data-slide-elem-anim-order
                disabled={!canEdit}
                min={1}
                max={100}
                value={orderValue}
                onChange={(e) => {
                  const n = e.target.valueAsNumber;
                  if (Number.isFinite(n)) {
                    onChange({ ...animation, order: Math.max(1, Math.min(100, Math.round(n))) });
                  }
                }}
                className="w-10 bg-transparent text-right text-[12px] tabular-nums text-[#1f2329] outline-none disabled:opacity-40"
              />
            </label>
            <label className="flex items-center justify-between gap-1 rounded-md border border-[#dee0e3] bg-white px-2 py-1">
              <span className="text-[11px] text-[#646a73]">时长</span>
              <input
                type="number"
                aria-label="动画时长(毫秒)"
                data-slide-elem-anim-duration
                disabled={!canEdit}
                min={100}
                max={5000}
                step={50}
                value={durationValue}
                onChange={(e) => {
                  const n = e.target.valueAsNumber;
                  if (Number.isFinite(n)) {
                    onChange({ ...animation, durationMs: Math.max(100, Math.min(5000, Math.round(n))) });
                  }
                }}
                className="w-12 bg-transparent text-right text-[12px] tabular-nums text-[#1f2329] outline-none disabled:opacity-40"
              />
              <span className="text-[10px] text-[#8f959e]">ms</span>
            </label>
          </div>
        </>
      )}

      <button
        type="button"
        data-slide-elem-anim-preview
        disabled={!animation}
        onClick={() => {
          if (animation) onPreview?.(shapeId, animation);
        }}
        className="mt-2.5 flex h-8 w-full items-center justify-center gap-1 rounded-md border border-[#dee0e3] text-[12px] hover:bg-[#f2f3f5] disabled:opacity-40"
      >
        <Play size={12} />
        <span>预览动画</span>
      </button>
    </div>
  );
}

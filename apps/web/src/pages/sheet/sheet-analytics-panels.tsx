import { useEffect, useMemo, useState } from "react";
import { BarChart3, Plus, Sparkles, TableProperties, Trash2 } from "lucide-react";
import type {
  SheetChart,
  SheetChartType,
  SheetPivotAgg,
  SheetPivotSort,
  SheetPivotTable,
  SheetPivotValue,
  SheetWorksheet,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { FeishuSelect } from "@/components/feishu-select";
import { parseRangeInput, type EvaluatedSheetMap } from "./workbook-engine";
import { formatSheetRectA1, makeRuleId, type SheetRect } from "./sheet-rules";
import {
  CHART_TYPE_OPTIONS,
  computePivotTable,
  detectDataTableRange,
  detectFirstNumericColOffset,
  extractPivotSourceHeaders,
  formatPivotNumber,
  PIVOT_AGG_OPTIONS,
  PIVOT_SORT_OPTIONS,
} from "./sheet-analytics";

export function SheetChartsPanel({
  activeSheet,
  evalMap,
  selectionBoundsRect,
  canEdit,
  editingChartId,
  onSelectEditingChart,
  onSelectRange,
  onUpdateCharts,
}: {
  activeSheet: SheetWorksheet;
  evalMap: EvaluatedSheetMap;
  selectionBoundsRect: SheetRect;
  canEdit: boolean;
  editingChartId: string | null;
  onSelectEditingChart: (id: string | null) => void;
  onSelectRange: (rect: SheetRect) => void;
  onUpdateCharts: (next: SheetChart[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const charts = activeSheet.charts ?? [];
  const editingChart = useMemo(
    () => (editingChartId ? charts.find((c) => c.id === editingChartId) ?? null : null),
    [charts, editingChartId],
  );

  const detectedRect = useMemo(
    () => detectDataTableRange(activeSheet, evalMap, selectionBoundsRect),
    [activeSheet, evalMap, selectionBoundsRect],
  );

  const [title, setTitle] = useState("");
  const [chartType, setChartType] = useState<SheetChartType>("column");
  const [rangeText, setRangeText] = useState(() => formatSheetRectA1(detectedRect));
  const [headerRow, setHeaderRow] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [showValues, setShowValues] = useState(true);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editingChart) {
      setTitle(editingChart.title);
      setChartType(editingChart.type);
      setRangeText(formatSheetRectA1(editingChart));
      setHeaderRow(editingChart.headerRow);
      setShowLegend(editingChart.showLegend);
      setShowValues(!!editingChart.showValues);
      setFormError("");
    } else {
      setRangeText(formatSheetRectA1(detectedRect));
    }
  }, [editingChart, detectedRect]);

  const handleSave = async () => {
    const parsed = parseRangeInput(rangeText);
    if (!parsed) {
      setFormError(t("数据区域格式无效，请使用如 A1:D6 的格式"));
      return;
    }
    const maxR = Math.max(0, activeSheet.rows.length - 1);
    const maxC = Math.max(0, activeSheet.columns.length - 1);
    const rect: SheetRect = {
      top: Math.max(0, Math.min(maxR, Math.min(parsed.anchor.row, parsed.focus.row))),
      bottom: Math.max(0, Math.min(maxR, Math.max(parsed.anchor.row, parsed.focus.row))),
      left: Math.max(0, Math.min(maxC, Math.min(parsed.anchor.col, parsed.focus.col))),
      right: Math.max(0, Math.min(maxC, Math.max(parsed.anchor.col, parsed.focus.col))),
    };
    setFormError("");
    setSaving(true);
    try {
      const cleanTitle = title.trim() || t("数据图表");
      if (editingChart) {
        const next = charts.map((c) =>
          c.id === editingChart.id
            ? { ...c, title: cleanTitle, type: chartType, ...rect, headerRow, showLegend, showValues }
            : c,
        );
        await onUpdateCharts(next);
      } else {
        const offset = charts.length * 24;
        const created: SheetChart = {
          id: makeRuleId("chart"),
          title: cleanTitle,
          type: chartType,
          ...rect,
          headerRow,
          x: 60 + offset,
          y: 220 + offset,
          width: 460,
          height: 300,
          showLegend,
          showValues,
        };
        await onUpdateCharts([...charts, created]);
        onSelectEditingChart(created.id);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-sheet-charts-panel>
      {canEdit && (
        <div className="space-y-2.5 rounded-md border border-[#e5e6eb] bg-[#fafbfc] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-[#1f2329]">
              {editingChart ? t("编辑嵌入式图表") : t("插入嵌入式图表")}
            </span>
            {editingChart && (
              <button
                type="button"
                onClick={() => {
                  onSelectEditingChart(null);
                  setTitle("");
                }}
                className="text-[11px] text-[#3370ff] hover:underline"
              >
                {t("改为新建")}
              </button>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-[#646a73]">{t("图表标题")}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("例如：季度营收对比")}
              data-chart-title-input
              className="h-8 w-full rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-[#646a73]">{t("图表类型")}</label>
            <div className="grid grid-cols-3 gap-1">
              {CHART_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.type}
                  type="button"
                  data-chart-type-option={opt.type}
                  onClick={() => setChartType(opt.type)}
                  className={`h-7 rounded border text-[11px] font-medium ${
                    chartType === opt.type
                      ? "border-[#3370ff] bg-[#eef3ff] text-[#3370ff]"
                      : "border-[#dee0e3] bg-white text-[#4b5058] hover:bg-[#f2f3f5]"
                  }`}
                >
                  {t(opt.label)}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-[11px] text-[#646a73]">{t("数据区域")}</label>
              <button
                type="button"
                onClick={() => setRangeText(formatSheetRectA1(detectedRect))}
                className="text-[11px] text-[#3370ff] hover:underline"
              >
                {t("自动识别数据区")}
              </button>
            </div>
            <input
              type="text"
              value={rangeText}
              onChange={(e) => setRangeText(e.target.value)}
              data-chart-range-input
              className="h-8 w-full rounded border border-[#dee0e3] bg-white px-2 font-mono text-[12px] outline-none focus:border-[#3370ff]"
            />
          </div>

          <div className="flex flex-wrap gap-3 text-[11px] text-[#4b5058]">
            <label className="inline-flex items-center gap-1">
              <input type="checkbox" checked={headerRow} onChange={(e) => setHeaderRow(e.target.checked)} />
              {t("首行为系列标题")}
            </label>
            <label className="inline-flex items-center gap-1">
              <input type="checkbox" checked={showLegend} onChange={(e) => setShowLegend(e.target.checked)} />
              {t("显示图例")}
            </label>
            <label className="inline-flex items-center gap-1">
              <input type="checkbox" checked={showValues} onChange={(e) => setShowValues(e.target.checked)} />
              {t("显示数值")}
            </label>
          </div>

          {formError && <p className="text-[11px] text-[#d92d20]">{formError}</p>}

          <button
            type="button"
            disabled={saving}
            data-chart-save-btn
            onClick={() => void handleSave()}
            className="inline-flex h-8 w-full items-center justify-center gap-1 rounded bg-[#3370ff] text-[12px] font-medium text-white hover:bg-[#2860e1] disabled:opacity-50"
          >
            <BarChart3 size={13} />
            {editingChart ? t("保存图表修改") : t("插入图表到画布")}
          </button>
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold text-[#646a73]">
          {t("当前工作表图表 ({count})", { count: charts.length })}
        </p>
        {charts.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-[#8f959e]">
            {t("暂无嵌入式图表，框选数据区域后点击上方按钮即可插入")}
          </p>
        ) : (
          charts.map((c) => (
            <div
              key={c.id}
              data-chart-list-item={c.id}
              className={`flex items-center justify-between gap-2 rounded border px-2.5 py-2 text-[12px] ${
                editingChartId === c.id ? "border-[#3370ff] bg-[#eef3ff]/60" : "border-[#e5e6eb] bg-white"
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  onSelectEditingChart(c.id);
                  onSelectRange({ top: c.top, left: c.left, bottom: c.bottom, right: c.right });
                }}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate font-medium text-[#1f2329]">{c.title || t("未命名图表")}</p>
                <p className="text-[11px] text-[#8f959e]">
                  {t(CHART_TYPE_OPTIONS.find((o) => o.type === c.type)?.label ?? "柱状图")} · {formatSheetRectA1(c)}
                </p>
              </button>
              {canEdit && (
                <button
                  type="button"
                  aria-label={t("删除图表")}
                  onClick={() => {
                    if (editingChartId === c.id) onSelectEditingChart(null);
                    void onUpdateCharts(charts.filter((item) => item.id !== c.id));
                  }}
                  className="grid size-6 shrink-0 place-items-center rounded text-[#8f959e] hover:bg-[#fee2e2] hover:text-[#d92d20]"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function SheetPivotPanel({
  sheets,
  activeSheet,
  evaluatedWorkbook,
  selectionBoundsRect,
  canEdit,
  onUpdatePivotTables,
  onMaterializePivot,
}: {
  sheets: SheetWorksheet[];
  activeSheet: SheetWorksheet;
  evaluatedWorkbook: Map<number, EvaluatedSheetMap>;
  selectionBoundsRect: SheetRect;
  canEdit: boolean;
  onUpdatePivotTables: (next: SheetPivotTable[]) => Promise<void>;
  onMaterializePivot: (pivot: SheetPivotTable, sourceSheet: SheetWorksheet, sourceEvalMap: EvaluatedSheetMap) => Promise<void>;
}) {
  const { t } = useI18n();
  const savedPivots = activeSheet.pivotTables ?? [];

  const [editingId, setEditingId] = useState<string | null>(null);
  const [sourceSheetId, setSourceSheetId] = useState<number>(activeSheet.id);
  const sourceSheet = useMemo(
    () => sheets.find((s) => s.id === sourceSheetId) ?? activeSheet,
    [sheets, sourceSheetId, activeSheet],
  );
  const sourceEvalMap = useMemo(
    () => evaluatedWorkbook.get(sourceSheet.id) ?? {},
    [evaluatedWorkbook, sourceSheet.id],
  );

  const autoRect = useMemo(
    () => detectDataTableRange(sourceSheet, sourceEvalMap, sourceSheet.id === activeSheet.id ? selectionBoundsRect : { top: 0, left: 0, bottom: 0, right: 0 }),
    [sourceSheet, sourceEvalMap, activeSheet.id, selectionBoundsRect],
  );

  const [title, setTitle] = useState(t("数据透视汇总"));
  const [rangeText, setRangeText] = useState(() => formatSheetRectA1(autoRect));
  const [rowFields, setRowFields] = useState<number[]>([0]);
  const [colField, setColField] = useState<number | "">("");
  const [values, setValues] = useState<SheetPivotValue[]>(() => [
    { col: detectFirstNumericColOffset(sourceSheet, sourceEvalMap, autoRect), agg: "sum" },
  ]);
  const [sortBy, setSortBy] = useState<SheetPivotSort>("value_desc");
  const [showRowTotals, setShowRowTotals] = useState(true);
  const [showColTotals, setShowColTotals] = useState(true);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const parsedRect: SheetRect | null = useMemo(() => {
    const p = parseRangeInput(rangeText);
    if (!p) return null;
    const maxR = Math.max(0, sourceSheet.rows.length - 1);
    const maxC = Math.max(0, sourceSheet.columns.length - 1);
    const rect = {
      top: Math.max(0, Math.min(maxR, Math.min(p.anchor.row, p.focus.row))),
      bottom: Math.max(0, Math.min(maxR, Math.max(p.anchor.row, p.focus.row))),
      left: Math.max(0, Math.min(maxC, Math.min(p.anchor.col, p.focus.col))),
      right: Math.max(0, Math.min(maxC, Math.max(p.anchor.col, p.focus.col))),
    };
    return rect.bottom > rect.top ? rect : null;
  }, [rangeText, sourceSheet.rows.length, sourceSheet.columns.length]);

  const sourceHeaders = useMemo(
    () => (parsedRect ? extractPivotSourceHeaders(sourceSheet, sourceEvalMap, parsedRect) : []),
    [sourceSheet, sourceEvalMap, parsedRect],
  );

  // Keep field indices in bounds when source range width changes.
  useEffect(() => {
    if (sourceHeaders.length === 0) return;
    const maxIdx = sourceHeaders.length - 1;
    setRowFields((prev) => {
      const valid = prev.filter((f) => f >= 0 && f <= maxIdx);
      return valid.length > 0 ? valid : [0];
    });
    setColField((prev) => (typeof prev === "number" && prev > maxIdx ? "" : prev));
    setValues((prev) => {
      const valid = prev.filter((v) => v.col >= 0 && v.col <= maxIdx);
      return valid.length > 0 ? valid : [{ col: Math.min(maxIdx, 1), agg: "sum" }];
    });
  }, [sourceHeaders.length]);

  const draftPivot: SheetPivotTable | null = useMemo(() => {
    if (!parsedRect || rowFields.length === 0 || values.length === 0) return null;
    return {
      id: editingId ?? "draft",
      title: title.trim() || t("数据透视汇总"),
      sourceSheetId: sourceSheet.id === activeSheet.id ? 0 : sourceSheet.id,
      ...parsedRect,
      rowFields,
      ...(typeof colField === "number" && !rowFields.includes(colField) ? { colField } : {}),
      values,
      showRowTotals,
      showColTotals,
      sortBy,
    };
  }, [editingId, title, sourceSheet.id, activeSheet.id, parsedRect, rowFields, colField, values, showRowTotals, showColTotals, sortBy, t]);

  const previewResult = useMemo(
    () => (draftPivot ? computePivotTable(sourceSheet, sourceEvalMap, draftPivot) : null),
    [draftPivot, sourceSheet, sourceEvalMap],
  );

  const loadSavedPivot = (pv: SheetPivotTable) => {
    setEditingId(pv.id);
    setTitle(pv.title);
    setSourceSheetId(pv.sourceSheetId && sheets.some((s) => s.id === pv.sourceSheetId) ? pv.sourceSheetId : activeSheet.id);
    setRangeText(formatSheetRectA1(pv));
    setRowFields(pv.rowFields);
    setColField(pv.colField !== undefined ? pv.colField : "");
    setValues(pv.values);
    setSortBy(pv.sortBy || "label_asc");
    setShowRowTotals(pv.showRowTotals);
    setShowColTotals(pv.showColTotals);
    setFormError("");
  };

  const toggleRowField = (idx: number) => {
    setRowFields((prev) => {
      if (prev.includes(idx)) {
        return prev.length > 1 ? prev.filter((f) => f !== idx) : prev;
      }
      if (prev.length >= 3) return prev;
      if (colField === idx) setColField("");
      return [...prev, idx];
    });
  };

  const handleSave = async () => {
    if (!draftPivot) {
      setFormError(t("请选择至少包含表头和 1 行数据的数据区域"));
      return;
    }
    setFormError("");
    setBusy(true);
    try {
      const id = editingId ?? makeRuleId("pivot");
      const toSave: SheetPivotTable = { ...draftPivot, id };
      const exists = savedPivots.some((p) => p.id === id);
      const next = exists
        ? savedPivots.map((p) => (p.id === id ? toSave : p))
        : [...savedPivots, toSave];
      await onUpdatePivotTables(next);
      setEditingId(id);
    } finally {
      setBusy(false);
    }
  };

  const handleMaterialize = async () => {
    if (!draftPivot) {
      setFormError(t("请选择有效数据区域后再生成工作表"));
      return;
    }
    setFormError("");
    setBusy(true);
    try {
      await onMaterializePivot(draftPivot, sourceSheet, sourceEvalMap);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-sheet-pivot-panel>
      <div className="space-y-2.5 rounded-md border border-[#e5e6eb] bg-[#fafbfc] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-semibold text-[#1f2329]">
            {editingId ? t("编辑数据透视表") : t("配置数据透视表")}
          </span>
          {editingId && (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setTitle(t("数据透视汇总"));
              }}
              className="text-[11px] text-[#3370ff] hover:underline"
            >
              {t("新建透视")}
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[11px] text-[#646a73]">{t("透视表名称")}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-pivot-title-input
              className="h-8 w-full rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
            />
          </div>
          <div className="space-y-1">
            <span className="block text-[11px] text-[#646a73]">{t("源工作表")}</span>
            <FeishuSelect
              ariaLabel={t("源工作表")}
              value={String(sourceSheet.id)}
              options={sheets.map((s) => ({ value: String(s.id), label: s.title }))}
              onChange={(val) => setSourceSheetId(Number(val))}
              className="h-8 w-full border border-[#dee0e3] bg-white px-1.5 text-[12px]"
              menuMinWidth={130}
            />
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[11px] text-[#646a73]">{t("源数据区域（首行为列名）")}</label>
            <button
              type="button"
              onClick={() => setRangeText(formatSheetRectA1(autoRect))}
              className="text-[11px] text-[#3370ff] hover:underline"
            >
              {t("自动识别数据区")}
            </button>
          </div>
          <input
            type="text"
            value={rangeText}
            onChange={(e) => setRangeText(e.target.value)}
            data-pivot-range-input
            className="h-8 w-full rounded border border-[#dee0e3] bg-white px-2 font-mono text-[12px] outline-none focus:border-[#3370ff]"
          />
        </div>

        {sourceHeaders.length > 0 && (
          <>
            <div className="space-y-1">
              <label className="text-[11px] text-[#646a73]">{t("行维度（最多选 3 列）")}</label>
              <div className="flex flex-wrap gap-1">
                {sourceHeaders.map((h, idx) => {
                  const active = rowFields.includes(idx);
                  return (
                    <button
                      key={idx}
                      type="button"
                      data-pivot-row-field={idx}
                      onClick={() => toggleRowField(idx)}
                      className={`rounded border px-2 py-0.5 text-[11px] ${
                        active
                          ? "border-[#3370ff] bg-[#eef3ff] font-medium text-[#3370ff]"
                          : "border-[#dee0e3] bg-white text-[#4b5058] hover:bg-[#f2f3f5]"
                      }`}
                    >
                      {h}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <span className="block text-[11px] text-[#646a73]">{t("列交叉维度（可选）")}</span>
                <FeishuSelect
                  ariaLabel={t("列交叉维度（可选）")}
                  value={colField === "" ? "" : String(colField)}
                  dataAttr={{ "data-pivot-col-field": true }}
                  options={[
                    { value: "", label: t("不设列维度") },
                    ...sourceHeaders.map((h, idx) => ({ value: String(idx), label: h, disabled: rowFields.includes(idx) })),
                  ]}
                  onChange={(val) => setColField(val === "" ? "" : Number(val))}
                  className="h-8 w-full border border-[#dee0e3] bg-white px-1.5 text-[12px]"
                  menuMinWidth={130}
                />
              </div>
              <div className="space-y-1">
                <span className="block text-[11px] text-[#646a73]">{t("排序方式")}</span>
                <FeishuSelect
                  ariaLabel={t("排序方式")}
                  value={sortBy}
                  options={PIVOT_SORT_OPTIONS.map((opt) => ({ value: opt.sort, label: t(opt.label) }))}
                  onChange={(val) => setSortBy(val as SheetPivotSort)}
                  className="h-8 w-full border border-[#dee0e3] bg-white px-1.5 text-[12px]"
                  menuMinWidth={130}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] text-[#646a73]">{t("聚合值字段")}</label>
                {values.length < 6 && (
                  <button
                    type="button"
                    onClick={() => setValues((prev) => [...prev, { col: sourceHeaders.length - 1, agg: "sum" }])}
                    className="inline-flex items-center gap-0.5 text-[11px] text-[#3370ff] hover:underline"
                  >
                    <Plus size={11} />
                    {t("添加指标")}
                  </button>
                )}
              </div>
              {values.map((v, vi) => (
                <div key={vi} className="flex items-center gap-1.5">
                  <FeishuSelect
                    ariaLabel={t("聚合值字段")}
                    value={String(v.col)}
                    dataAttr={{ "data-pivot-value-col": String(vi) }}
                    options={sourceHeaders.map((h, idx) => ({ value: String(idx), label: h }))}
                    onChange={(val) =>
                      setValues((prev) => prev.map((item, i) => (i === vi ? { ...item, col: Number(val) } : item)))
                    }
                    className="h-7 min-w-0 flex-1 border border-[#dee0e3] bg-white px-1.5 text-[11px]"
                    chevronSize={11}
                    menuMinWidth={120}
                  />
                  <FeishuSelect
                    ariaLabel={t("聚合方式")}
                    value={v.agg}
                    dataAttr={{ "data-pivot-value-agg": String(vi) }}
                    options={PIVOT_AGG_OPTIONS.map((opt) => ({ value: opt.agg, label: t(opt.label) }))}
                    onChange={(val) =>
                      setValues((prev) => prev.map((item, i) => (i === vi ? { ...item, agg: val as SheetPivotAgg } : item)))
                    }
                    className="h-7 w-20 border border-[#dee0e3] bg-white px-1 text-[11px]"
                    chevronSize={11}
                    menuMinWidth={88}
                  />
                  {values.length > 1 && (
                    <button
                      type="button"
                      aria-label={t("删除指标")}
                      onClick={() => setValues((prev) => prev.filter((_, i) => i !== vi))}
                      className="grid size-6 shrink-0 place-items-center rounded text-[#8f959e] hover:bg-[#fee2e2] hover:text-[#d92d20]"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-3 text-[11px] text-[#4b5058]">
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={showRowTotals} onChange={(e) => setShowRowTotals(e.target.checked)} />
                {t("显示行总计")}
              </label>
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={showColTotals} onChange={(e) => setShowColTotals(e.target.checked)} />
                {t("显示列总计")}
              </label>
            </div>
          </>
        )}

        {formError && <p className="text-[11px] text-[#d92d20]">{formError}</p>}

        {canEdit && (
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              disabled={busy || !draftPivot}
              data-pivot-save-btn
              onClick={() => void handleSave()}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded bg-[#3370ff] text-[12px] font-medium text-white hover:bg-[#2860e1] disabled:opacity-50"
            >
              <TableProperties size={13} />
              {t("保存透视配置")}
            </button>
            <button
              type="button"
              disabled={busy || !draftPivot}
              data-pivot-materialize-btn
              onClick={() => void handleMaterialize()}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded border border-[#3370ff] bg-white text-[12px] font-medium text-[#3370ff] hover:bg-[#eef3ff] disabled:opacity-50"
            >
              <Sparkles size={13} />
              {t("生成到新工作表")}
            </button>
          </div>
        )}
      </div>

      {/* Live Pivot Preview Table */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] text-[#646a73]">
          <span className="font-semibold">{t("实时透视预览")}</span>
          {previewResult && (
            <span>{t("共 {count} 条明细", { count: previewResult.totalRecords })}</span>
          )}
        </div>
        {!previewResult || previewResult.rows.length === 0 ? (
          <p className="rounded border border-dashed border-[#dee0e3] py-5 text-center text-[12px] text-[#8f959e]">
            {t("所选数据区域暂无可汇总记录")}
          </p>
        ) : (
          <div className="max-h-60 overflow-auto rounded border border-[#dee0e3] bg-white">
            <table data-pivot-preview-table className="w-full border-collapse text-[11px]">
              <thead className="sticky top-0 bg-[#eef3ff] text-[#1f2329]">
                <tr>
                  {previewResult.rowFieldHeaders.map((h, i) => (
                    <th key={`rh-${i}`} className="border-b border-r border-[#dee0e3] px-2 py-1 text-left font-semibold whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                  {previewResult.valueColumnHeaders.map((h, i) => (
                    <th key={`vh-${i}`} className="border-b border-r border-[#dee0e3] px-2 py-1 text-right font-semibold whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                  {previewResult.rowTotalHeaders.map((h, i) => (
                    <th key={`th-${i}`} className="border-b border-[#dee0e3] bg-[#e1eaff] px-2 py-1 text-right font-semibold whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewResult.rows.map((r) => (
                  <tr key={r.key} className="hover:bg-[#f7f9fc]">
                    {r.labelCells.map((lbl, i) => (
                      <td key={`rl-${i}`} className="border-b border-r border-[#eff0f1] px-2 py-1 font-medium text-[#1f2329] whitespace-nowrap">
                        {lbl}
                      </td>
                    ))}
                    {r.cells.map((val, i) => (
                      <td key={`rv-${i}`} className="border-b border-r border-[#eff0f1] px-2 py-1 text-right font-mono text-[#1f2329] whitespace-nowrap">
                        {formatPivotNumber(val)}
                      </td>
                    ))}
                    {r.totals.map((val, i) => (
                      <td key={`rt-${i}`} className="border-b border-[#eff0f1] bg-[#fafbfc] px-2 py-1 text-right font-mono font-semibold text-[#1f2329] whitespace-nowrap">
                        {formatPivotNumber(val)}
                      </td>
                    ))}
                  </tr>
                ))}
                {showColTotals && (
                  <tr className="bg-[#f5f6f7] font-semibold text-[#1f2329]">
                    {previewResult.rowFieldHeaders.map((_, i) => (
                      <td key={`gl-${i}`} className="border-r border-[#dee0e3] px-2 py-1 whitespace-nowrap">
                        {i === 0 ? t("总计") : ""}
                      </td>
                    ))}
                    {previewResult.grandTotals.map((val, i) => (
                      <td key={`gv-${i}`} className="border-r border-[#dee0e3] px-2 py-1 text-right font-mono whitespace-nowrap">
                        {formatPivotNumber(val)}
                      </td>
                    ))}
                    {previewResult.grandRowTotals.map((val, i) => (
                      <td key={`gt-${i}`} className="px-2 py-1 text-right font-mono whitespace-nowrap">
                        {formatPivotNumber(val)}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Saved Pivot Definitions */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold text-[#646a73]">
          {t("已保存透视表 ({count})", { count: savedPivots.length })}
        </p>
        {savedPivots.length === 0 ? (
          <p className="py-3 text-center text-[12px] text-[#8f959e]">{t("暂无已保存的透视表配置")}</p>
        ) : (
          savedPivots.map((pv) => (
            <div
              key={pv.id}
              data-pivot-saved-item={pv.id}
              className={`flex items-center justify-between gap-2 rounded border px-2.5 py-2 text-[12px] ${
                editingId === pv.id ? "border-[#3370ff] bg-[#eef3ff]/60" : "border-[#e5e6eb] bg-white"
              }`}
            >
              <button type="button" onClick={() => loadSavedPivot(pv)} className="min-w-0 flex-1 text-left">
                <p className="truncate font-medium text-[#1f2329]">{pv.title}</p>
                <p className="text-[11px] text-[#8f959e]">{formatSheetRectA1(pv)}</p>
              </button>
              {canEdit && (
                <button
                  type="button"
                  aria-label={t("删除透视表")}
                  onClick={() => {
                    if (editingId === pv.id) setEditingId(null);
                    void onUpdatePivotTables(savedPivots.filter((item) => item.id !== pv.id));
                  }}
                  className="grid size-6 shrink-0 place-items-center rounded text-[#8f959e] hover:bg-[#fee2e2] hover:text-[#d92d20]"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

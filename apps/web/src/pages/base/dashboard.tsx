import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  baseApi,
  type BaseDashboard,
  type BaseRecord,
  type DashboardMetric,
  type DashboardWidget,
  type DashboardWidgetType,
  type Field,
  type User,
} from "@/lib/api";
import { t } from "@/lib/i18n";
import { ask, askText } from "@/components/ui/ask";
import { displayValue, memberName, personIDs } from "./registry";
import { TypeGlyph } from "./cells";
import {
  computeGroupedSeries,
  computeMetricWidget,
  defaultDashboardWidgets,
  isGroupableField,
  isNumericField,
  makeWidgetId,
  METRIC_OPTIONS,
  WIDGET_TYPE_OPTIONS,
} from "./dashboard-model";
import {
  BarChartView,
  HorizontalBarChartView,
  LineChartView,
  MetricWidgetView,
  PieChartView,
  PivotTableView,
} from "./dashboard-charts";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Columns2,
  Pencil,
  PieChart,
  Plus,
  RotateCcw,
  Square,
  Table2,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";

export interface DashboardStats {
  total: number;
  numbers: { field: Field; sum: number; avg: number | null; filled: number }[];
  selects: { field: Field; buckets: { key: string; count: number; memberId?: number }[] }[];
  checkboxes: { field: Field; checked: number }[];
}

/** Aggregate the authorized records into summary stats (retained for compatibility & tests). */
export function dashboardStats(records: BaseRecord[], fields: Field[], members: User[]): DashboardStats {
  const numbers = fields.filter((f) => f.type === "number").map((field) => {
    const vals = records.map((r) => displayValue(r, field, members)).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const sum = vals.reduce((a, b) => a + b, 0);
    return { field, sum, avg: vals.length ? sum / vals.length : null, filled: vals.length };
  });
  const selects = fields.filter((f) => f.type === "select" || f.type === "multi_select" || f.type === "person").map((field) => {
    if (field.type === "person") {
      const counts = new Map<number, number>();
      let none = 0;
      for (const record of records) {
        const ids = new Set(personIDs(displayValue(record, field, members)));
        if (!ids.size) none++;
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const names = new Map<string, number>();
      for (const id of counts.keys()) {
        const name = memberName(id, members);
        if (name) names.set(name, (names.get(name) ?? 0) + 1);
      }
      const buckets: { key: string; count: number; memberId?: number }[] = [...counts].map(([id, count]) => {
        const name = memberName(id, members);
        return { key: name ? (names.get(name)! > 1 ? `${name} (#${id})` : name) : t("成员 #{id}", { id }), count, memberId: id };
      });
      if (none) buckets.push({ key: "", count: none });
      return { field, buckets };
    }
    const counts = new Map<string, number>((field.options ?? []).map((o) => [o, 0]));
    let none = 0;
    for (const r of records) {
      const v = displayValue(r, field, members);
      const keys = Array.isArray(v)
        ? v.map(String)
        : typeof v === "string" && v
          ? [v]
          : [];
      if (!keys.length) none++;
      for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const buckets = [...counts].map(([key, count]) => ({ key, count }));
    if (none) buckets.push({ key: "", count: none });
    return { field, buckets };
  });
  const checkboxes = fields.filter((f) => f.type === "checkbox").map((field) => ({ field, checked: records.filter((r) => displayValue(r, field, members) === true).length }));
  return { total: records.length, numbers, selects, checkboxes };
}

export interface DashboardProps {
  baseId?: number;
  activeTableId?: number;
  records: BaseRecord[];
  fields: Field[];
  members: User[];
  canEdit?: boolean;
}

/** 仪表盘：可配置多类型图表并持久化到服务端，严格遵循当前读者的字段与记录权限投影。 */
export function Dashboard({ baseId, activeTableId, records, fields, members, canEdit = false }: DashboardProps) {
  const qc = useQueryClient();
  const dashQueryKey = useMemo(() => ["base-dashboards", baseId ?? 0], [baseId]);

  const dashboardsQ = useQuery({
    queryKey: dashQueryKey,
    queryFn: () => baseApi.listDashboards(baseId!),
    enabled: !!baseId,
    retry: false,
  });

  const dashboards = dashboardsQ.data ?? [];
  const [selectedDashId, setSelectedDashId] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [editorState, setEditorState] = useState<{ open: boolean; editing: DashboardWidget | null }>({ open: false, editing: null });

  const activeDashboard: BaseDashboard | null =
    dashboards.find((d) => d.id === selectedDashId) ?? dashboards[0] ?? null;

  const autoWidgets = useMemo(
    () => defaultDashboardWidgets(fields, activeTableId),
    [fields, activeTableId],
  );

  const widgets = activeDashboard ? activeDashboard.widgets : autoWidgets;

  const persistWidgets = async (nextWidgets: DashboardWidget[]) => {
    if (!baseId || !canEdit) return;
    setSaving(true);
    setErrorMsg("");
    try {
      if (activeDashboard) {
        const updated = await baseApi.updateDashboard(baseId, activeDashboard.id, {
          widgets: nextWidgets,
          expectedRevision: activeDashboard.revision,
        });
        qc.setQueryData<BaseDashboard[]>(dashQueryKey, (old) =>
          (old ?? []).map((d) => (d.id === updated.id ? updated : d)),
        );
      } else {
        const created = await baseApi.createDashboard(baseId, t("仪表盘"), nextWidgets);
        qc.setQueryData<BaseDashboard[]>(dashQueryKey, (old) => [...(old ?? []), created]);
        setSelectedDashId(created.id);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t("保存仪表盘配置失败，请重试。"));
      void qc.invalidateQueries({ queryKey: dashQueryKey });
    } finally {
      setSaving(false);
    }
  };

  const handleCreateDashboard = async () => {
    if (!baseId || !canEdit) return;
    const name = await askText(t("新建仪表盘"), t("仪表盘名称"), `${t("仪表盘")} ${dashboards.length + 1}`);
    if (!name?.trim()) return;
    setSaving(true);
    setErrorMsg("");
    try {
      const created = await baseApi.createDashboard(baseId, name.trim(), autoWidgets);
      qc.setQueryData<BaseDashboard[]>(dashQueryKey, (old) => [...(old ?? []), created]);
      setSelectedDashId(created.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t("新建仪表盘失败"));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteDashboard = async (db: BaseDashboard) => {
    if (!baseId || !canEdit) return;
    if (!(await ask(t("删除仪表盘「{name}」？", { name: db.name }), t("该仪表盘中的所有图表配置将被移除。"), true))) return;
    setSaving(true);
    setErrorMsg("");
    try {
      await baseApi.deleteDashboard(baseId, db.id);
      qc.setQueryData<BaseDashboard[]>(dashQueryKey, (old) => (old ?? []).filter((d) => d.id !== db.id));
      if (selectedDashId === db.id) setSelectedDashId(0);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t("删除仪表盘失败"));
    } finally {
      setSaving(false);
    }
  };

  const handleMoveWidget = async (idx: number, delta: -1 | 1) => {
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= widgets.length) return;
    const next = [...widgets];
    [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
    await persistWidgets(next);
  };

  const handleToggleSpan = async (idx: number) => {
    const next = widgets.map((w, i) => (i === idx ? { ...w, span: (w.span === 2 ? 1 : 2) as 1 | 2 } : w));
    await persistWidgets(next);
  };

  const handleDeleteWidget = async (id: string) => {
    await persistWidgets(widgets.filter((w) => w.id !== id));
  };

  const handleSaveWidget = async (widget: DashboardWidget) => {
    const exists = widgets.some((w) => w.id === widget.id);
    const next = exists ? widgets.map((w) => (w.id === widget.id ? widget : w)) : [...widgets, widget];
    await persistWidgets(next);
    setEditorState({ open: false, editing: null });
  };

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-[#f5f6f7] p-3 sm:p-5" data-dashboard>
      {/* Header & Controls */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="text-[16px] font-semibold text-[#1f2329]">{activeDashboard?.name ?? t("仪表盘")}</h2>
          {dashboards.length > 1 && (
            <div className="flex items-center gap-1" data-dashboard-tabs>
              {dashboards.map((db) => (
                <button
                  key={db.id}
                  type="button"
                  data-dashboard-tab={db.id}
                  onClick={() => setSelectedDashId(db.id)}
                  className={`h-7 rounded-md px-2.5 text-[12px] ${
                    activeDashboard?.id === db.id
                      ? "bg-[#e8efff] font-medium text-[#3370ff]"
                      : "bg-white text-[#646a73] hover:bg-[#eef0f3]"
                  }`}
                >
                  {db.name}
                </button>
              ))}
            </div>
          )}
          <span className="text-[12px] text-[#8f959e]">
            {saving ? t("正在保存…") : t("统计你有权访问的全部记录")}
          </span>
        </div>

        {canEdit && baseId && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={saving}
              data-dashboard-add-widget
              onClick={() => setEditorState({ open: true, editing: null })}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-[#3370ff] px-3 text-[12px] font-medium text-white hover:bg-[#245bdb] disabled:opacity-50"
            >
              <Plus size={14} />
              <span>{t("添加图表")}</span>
            </button>
            <button
              type="button"
              disabled={saving}
              data-dashboard-create-board
              onClick={() => void handleCreateDashboard()}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-[#dee0e3] bg-white px-2.5 text-[12px] text-[#4b5058] hover:bg-[#f2f3f5] disabled:opacity-50"
            >
              <Plus size={13} />
              <span>{t("新建仪表盘")}</span>
            </button>
            <button
              type="button"
              disabled={saving}
              data-dashboard-reset
              onClick={() => void persistWidgets(autoWidgets)}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-[#dee0e3] bg-white px-2.5 text-[12px] text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-50"
              title={t("恢复自动生成的默认图表")}
            >
              <RotateCcw size={13} />
              <span>{t("恢复默认")}</span>
            </button>
            {activeDashboard && dashboards.length > 1 && (
              <button
                type="button"
                disabled={saving}
                aria-label={t("删除当前仪表盘")}
                onClick={() => void handleDeleteDashboard(activeDashboard)}
                className="grid size-8 place-items-center rounded-md border border-[#dee0e3] bg-white text-[#8f959e] hover:bg-[#fff2f0] hover:text-[#d83931]"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {errorMsg && (
        <p role="alert" className="mb-3 rounded-md border border-[#ffccc7] bg-[#fff2f0] px-3 py-2 text-[12px] text-[#cf1322]">
          {errorMsg}
        </p>
      )}

      {widgets.length === 0 ? (
        <div className="grid place-items-center rounded-lg border border-dashed border-[#dee0e3] bg-white py-16 text-center">
          <p className="text-[14px] text-[#646a73]">{t("当前仪表盘暂无图表组件")}</p>
          {canEdit && baseId && (
            <button
              type="button"
              onClick={() => setEditorState({ open: true, editing: null })}
              className="mt-3 inline-flex h-8 items-center gap-1 rounded-md bg-[#3370ff] px-3 text-[12px] font-medium text-white"
            >
              <Plus size={14} />
              {t("添加第一个图表")}
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-6" data-dashboard-grid>
          {widgets.map((widget, idx) => {
            const groupField = widget.groupFieldId ? fields.find((f) => f.id === widget.groupFieldId) : undefined;
            const valueField = widget.valueFieldId ? fields.find((f) => f.id === widget.valueFieldId) : undefined;
            const glyphField = groupField ?? valueField ?? null;
            const spanClass =
              widget.span === 2
                ? "md:col-span-2 lg:col-span-6"
                : widget.type === "metric"
                  ? "lg:col-span-2"
                  : "lg:col-span-3";

            return (
              <section
                key={widget.id}
                data-dashboard-card={widget.id}
                data-dashboard-widget-type={widget.type}
                data-dashboard-widget-span={widget.span}
                className={`group rounded-lg border border-[#dee0e3] bg-white p-4 shadow-[0_1px_2px_rgba(31,35,41,0.03)] ${spanClass}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="flex min-w-0 items-center gap-1.5 break-words text-[13px] font-medium text-[#1f2329]">
                    {glyphField && <TypeGlyph t={glyphField.type} size={14} />}
                    <span className="truncate">{widget.title}</span>
                  </h3>
                  {canEdit && baseId && (
                    <div className="flex shrink-0 items-center gap-0.5 opacity-90 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      <button
                        type="button"
                        disabled={idx === 0 || saving}
                        aria-label={t("前移图表")}
                        title={t("前移图表")}
                        data-widget-move-left={widget.id}
                        onClick={() => void handleMoveWidget(idx, -1)}
                        className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-30"
                      >
                        <ArrowLeft size={12} />
                      </button>
                      <button
                        type="button"
                        disabled={idx === widgets.length - 1 || saving}
                        aria-label={t("后移图表")}
                        title={t("后移图表")}
                        data-widget-move-right={widget.id}
                        onClick={() => void handleMoveWidget(idx, 1)}
                        className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-30"
                      >
                        <ArrowRight size={12} />
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label={widget.span === 2 ? t("切换半宽") : t("切换全宽")}
                        title={widget.span === 2 ? t("切换半宽") : t("切换全宽")}
                        data-widget-toggle-span={widget.id}
                        onClick={() => void handleToggleSpan(idx)}
                        className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"
                      >
                        {widget.span === 2 ? <Columns2 size={12} /> : <Square size={12} />}
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label={t("编辑图表")}
                        title={t("编辑图表")}
                        data-widget-edit={widget.id}
                        onClick={() => setEditorState({ open: true, editing: widget })}
                        className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label={t("删除图表")}
                        title={t("删除图表")}
                        data-widget-delete={widget.id}
                        onClick={() => void handleDeleteWidget(widget.id)}
                        className="grid size-6 place-items-center rounded text-[#8f959e] hover:bg-[#fff2f0] hover:text-[#d83931]"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </div>

                {widget.type === "metric" && (
                  <MetricWidgetView summary={computeMetricWidget(widget, records, fields, members)} />
                )}
                {widget.type === "bar" && (
                  <BarChartView series={computeGroupedSeries(widget, records, fields, members)} wide={widget.span === 2} />
                )}
                {widget.type === "horizontal_bar" && (
                  <HorizontalBarChartView series={computeGroupedSeries(widget, records, fields, members)} />
                )}
                {widget.type === "pie" && (
                  <PieChartView series={computeGroupedSeries(widget, records, fields, members)} />
                )}
                {widget.type === "line" && (
                  <LineChartView series={computeGroupedSeries(widget, records, fields, members)} wide={widget.span === 2} />
                )}
                {widget.type === "pivot" && (
                  <PivotTableView series={computeGroupedSeries(widget, records, fields, members)} />
                )}
              </section>
            );
          })}
        </div>
      )}

      {editorState.open && (
        <WidgetEditorModal
          initial={editorState.editing}
          fields={fields}
          tableId={activeTableId}
          saving={saving}
          onClose={() => setEditorState({ open: false, editing: null })}
          onSave={(w) => void handleSaveWidget(w)}
        />
      )}
    </div>
  );
}

function widgetTypeIcon(type: DashboardWidgetType) {
  switch (type) {
    case "metric": return <Square size={15} />;
    case "bar": return <BarChart3 size={15} />;
    case "horizontal_bar": return <BarChart3 size={15} className="rotate-90" />;
    case "pie": return <PieChart size={15} />;
    case "line": return <TrendingUp size={15} />;
    case "pivot": return <Table2 size={15} />;
  }
}

function WidgetEditorModal({
  initial,
  fields,
  tableId,
  saving,
  onClose,
  onSave,
}: {
  initial: DashboardWidget | null;
  fields: Field[];
  tableId?: number;
  saving: boolean;
  onClose: () => void;
  onSave: (widget: DashboardWidget) => void;
}) {
  const groupableFields = fields.filter(isGroupableField);
  const numericFields = fields.filter(isNumericField);
  const checkboxFields = fields.filter((f) => f.type === "checkbox");

  const [type, setType] = useState<DashboardWidgetType>(initial?.type ?? "bar");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [groupFieldId, setGroupFieldId] = useState<number>(initial?.groupFieldId ?? groupableFields[0]?.id ?? 0);
  const [metric, setMetric] = useState<DashboardMetric>(initial?.metric ?? "count");
  const [valueFieldId, setValueFieldId] = useState<number>(initial?.valueFieldId ?? numericFields[0]?.id ?? 0);
  const [span, setSpan] = useState<1 | 2>(initial?.span ?? (type === "line" || type === "pivot" ? 2 : 1));

  const metricMeta = METRIC_OPTIONS.find((m) => m.value === metric);
  const needsGroup = type !== "metric";
  const valueCandidates = metricMeta?.needsCheckbox ? checkboxFields : numericFields;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const resolvedValueFieldId =
      metricMeta?.needsNumeric || metricMeta?.needsCheckbox
        ? (valueCandidates.some((f) => f.id === valueFieldId) ? valueFieldId : valueCandidates[0]?.id ?? 0)
        : 0;
    const defaultTitle =
      WIDGET_TYPE_OPTIONS.find((item) => item.type === type)?.label ?? "图表";
    onSave({
      id: initial?.id ?? makeWidgetId(),
      type,
      title: title.trim() || t(defaultTitle),
      tableId: initial?.tableId ?? tableId,
      span,
      groupFieldId: needsGroup ? groupFieldId || undefined : undefined,
      metric,
      valueFieldId: resolvedValueFieldId || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4" role="presentation" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="dash-widget-modal-title"
        data-dashboard-widget-modal
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 id="dash-widget-modal-title" className="text-[15px] font-semibold text-[#1f2329]">
            {initial ? t("编辑图表") : t("添加图表")}
          </h2>
          <button type="button" aria-label={t("关闭")} onClick={onClose} className="grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]">
            <X size={15} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5 text-[12px]">
          <div>
            <span className="mb-1.5 block text-[11px] font-medium text-[#646a73]">{t("图表类型")}</span>
            <div className="grid grid-cols-3 gap-2">
              {WIDGET_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.type}
                  type="button"
                  data-widget-type-choice={opt.type}
                  onClick={() => {
                    setType(opt.type);
                    if (!initial && (opt.type === "line" || opt.type === "pivot")) setSpan(2);
                  }}
                  className={`flex flex-col items-start gap-0.5 rounded-md border p-2 text-left transition-colors ${
                    type === opt.type
                      ? "border-[#3370ff] bg-[#eef3ff] text-[#3370ff]"
                      : "border-[#e5e6eb] text-[#4b5058] hover:bg-[#f7f8fa]"
                  }`}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    {widgetTypeIcon(opt.type)}
                    {t(opt.label)}
                  </span>
                  <span className="text-[10px] text-[#8f959e]">{t(opt.desc)}</span>
                </button>
              ))}
            </div>
          </div>

          <label className="grid gap-1">
            <span className="text-[11px] font-medium text-[#646a73]">{t("图表标题")}</span>
            <input
              data-widget-title-input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("输入图表名称，例如：按状态预算分布")}
              className="h-8 rounded border border-[#dee0e3] px-2.5 text-[12px] outline-none focus:border-[#3370ff]"
            />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {needsGroup && (
              <label className="grid gap-1">
                <span className="text-[11px] font-medium text-[#646a73]">{t("分组字段")}</span>
                <select
                  aria-label={t("分组字段")}
                  data-widget-group-select
                  value={groupFieldId}
                  onChange={(e) => setGroupFieldId(Number(e.target.value))}
                  className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
                >
                  {groupableFields.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </label>
            )}

            <label className="grid gap-1">
              <span className="text-[11px] font-medium text-[#646a73]">{t("统计方式")}</span>
              <select
                aria-label={t("统计方式")}
                data-widget-metric-select
                value={metric}
                onChange={(e) => setMetric(e.target.value as DashboardMetric)}
                className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
              >
                {METRIC_OPTIONS.filter((m) => type === "metric" || m.value !== "checked_pct").map((m) => (
                  <option key={m.value} value={m.value}>{t(m.label)}</option>
                ))}
              </select>
            </label>

            {(metricMeta?.needsNumeric || metricMeta?.needsCheckbox) && (
              <label className="grid gap-1">
                <span className="text-[11px] font-medium text-[#646a73]">{t("统计字段")}</span>
                <select
                  aria-label={t("统计字段")}
                  data-widget-value-select
                  value={valueFieldId}
                  onChange={(e) => setValueFieldId(Number(e.target.value))}
                  className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
                >
                  {valueCandidates.length === 0 ? (
                    <option value={0}>{t("无可用字段")}</option>
                  ) : (
                    valueCandidates.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)
                  )}
                </select>
              </label>
            )}

            <label className="grid gap-1">
              <span className="text-[11px] font-medium text-[#646a73]">{t("卡片宽度")}</span>
              <select
                aria-label={t("卡片宽度")}
                data-widget-span-select
                value={span}
                onChange={(e) => setSpan(Number(e.target.value) === 2 ? 2 : 1)}
                className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
              >
                <option value={1}>{t("半宽（1 列）")}</option>
                <option value={2}>{t("全宽（2 列）")}</option>
              </select>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="h-8 rounded-md border border-[#dee0e3] px-3 text-[12px] hover:bg-[#f2f3f5]">
              {t("取消")}
            </button>
            <button
              type="submit"
              disabled={saving}
              data-widget-save-btn
              className="h-8 rounded-md bg-[#3370ff] px-4 text-[12px] font-medium text-white hover:bg-[#245bdb] disabled:opacity-50"
            >
              {initial ? t("保存修改") : t("添加到仪表盘")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

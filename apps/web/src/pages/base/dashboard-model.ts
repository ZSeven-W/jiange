import {
  DASHBOARD_PALETTE,
  isGroupableField,
  isNumericField,
  type GroupedBucket,
} from "@zseven-w/base-sdk/dashboard";
import type { BaseRecord, DashboardMetric, DashboardWidget, DashboardWidgetType, Field, User } from "@/lib/api";
import { t } from "@/lib/i18n";
import { displayValue, memberName, optionColor, personIDs } from "./registry";

export { isGroupableField, isNumericField, type GroupedBucket };
export const CHART_PALETTE = DASHBOARD_PALETTE;

export const WIDGET_TYPE_OPTIONS: { type: DashboardWidgetType; label: string; desc: string }[] = [
  { type: "metric", label: "指标卡", desc: "关键指标大数字与占比" },
  { type: "bar", label: "柱状图", desc: "按分类对比数值高低" },
  { type: "horizontal_bar", label: "条形图", desc: "横向排行与数量分布" },
  { type: "pie", label: "饼图", desc: "环形占比与构成分析" },
  { type: "line", label: "折线图", desc: "按日期或阶段看趋势" },
  { type: "pivot", label: "汇总表", desc: "维度分组计数与聚合明细" },
];

export const METRIC_OPTIONS: { value: DashboardMetric; label: string; needsNumeric?: boolean; needsCheckbox?: boolean }[] = [
  { value: "count", label: "记录数" },
  { value: "sum", label: "求和", needsNumeric: true },
  { value: "avg", label: "平均值", needsNumeric: true },
  { value: "max", label: "最大值", needsNumeric: true },
  { value: "min", label: "最小值", needsNumeric: true },
  { value: "checked_pct", label: "已勾选占比", needsCheckbox: true },
];

export interface MetricSummary {
  headline: string;
  subtext: string;
  progressPct?: number;
}

export interface GroupedSeries {
  buckets: GroupedBucket[];
  totalValue: number;
  totalCount: number;
  metricLabel: string;
}

export function fmtDashNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n)
    ? n.toLocaleString("zh-CN")
    : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function makeWidgetId(): string {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Generate sensible initial widgets from the visible fields when a Base has no persisted dashboard yet. */
export function defaultDashboardWidgets(fields: Field[], tableId?: number): DashboardWidget[] {
  const widgets: DashboardWidget[] = [];
  widgets.push({
    id: "auto-total",
    type: "metric",
    title: t("记录总数"),
    tableId,
    span: 1,
    metric: "count",
  });

  const numField = fields.find(isNumericField);
  if (numField) {
    widgets.push({
      id: `auto-sum-${numField.id}`,
      type: "metric",
      title: t("{name} · 求和", { name: numField.name }),
      tableId,
      span: 1,
      metric: "sum",
      valueFieldId: numField.id,
    });
  }

  const cbField = fields.find((f) => f.type === "checkbox");
  if (cbField) {
    widgets.push({
      id: `auto-cb-${cbField.id}`,
      type: "metric",
      title: t("{name} · 已勾选", { name: cbField.name }),
      tableId,
      span: 1,
      metric: "checked_pct",
      valueFieldId: cbField.id,
    });
  }

  const selectFields = fields.filter((f) => f.type === "select" || f.type === "multi_select" || f.type === "person");
  if (selectFields[0]) {
    const f = selectFields[0];
    widgets.push({
      id: `auto-bar-${f.id}`,
      type: "bar",
      title: numField
        ? t("按「{group}」统计{val}", { group: f.name, val: numField.name })
        : t("按「{name}」统计", { name: f.name }),
      tableId,
      span: 1,
      groupFieldId: f.id,
      metric: numField ? "sum" : "count",
      valueFieldId: numField?.id,
    });
    widgets.push({
      id: `auto-pie-${f.id}`,
      type: "pie",
      title: t("「{name}」分布占比", { name: f.name }),
      tableId,
      span: 1,
      groupFieldId: f.id,
      metric: "count",
    });
  }

  const dateField = fields.find((f) => f.type === "date");
  if (dateField) {
    widgets.push({
      id: `auto-line-${dateField.id}`,
      type: "line",
      title: numField
        ? t("按「{date}」查看{val}趋势", { date: dateField.name, val: numField.name })
        : t("按「{name}」趋势统计", { name: dateField.name }),
      tableId,
      span: 2,
      groupFieldId: dateField.id,
      metric: numField ? "sum" : "count",
      valueFieldId: numField?.id,
    });
  } else if (selectFields[1]) {
    const f = selectFields[1];
    widgets.push({
      id: `auto-hbar-${f.id}`,
      type: "horizontal_bar",
      title: t("按「{name}」排行", { name: f.name }),
      tableId,
      span: 1,
      groupFieldId: f.id,
      metric: "count",
    });
  }

  if (selectFields[0]) {
    widgets.push({
      id: `auto-pivot-${selectFields[0].id}`,
      type: "pivot",
      title: t("「{name}」汇总明细", { name: selectFields[0].name }),
      tableId,
      span: 2,
      groupFieldId: selectFields[0].id,
      metric: numField ? "sum" : "count",
      valueFieldId: numField?.id,
    });
  }

  return widgets;
}

export function computeMetricWidget(
  widget: DashboardWidget,
  records: BaseRecord[],
  fields: Field[],
  members: User[],
): MetricSummary {
  const valField = widget.valueFieldId ? fields.find((f) => f.id === widget.valueFieldId) : undefined;

  if (widget.metric === "checked_pct") {
    const cbField = valField && valField.type === "checkbox" ? valField : fields.find((f) => f.type === "checkbox");
    if (!cbField) {
      return { headline: fmtDashNum(records.length), subtext: t("条记录") };
    }
    const checked = records.filter((r) => displayValue(r, cbField, members) === true).length;
    const pct = records.length ? Math.round((checked / records.length) * 100) : 0;
    return {
      headline: `${pct}%`,
      subtext: t("已勾选 {n} / 共 {total} 条", { n: checked, total: records.length }),
      progressPct: pct,
    };
  }

  if (widget.metric === "count" || !valField) {
    return { headline: fmtDashNum(records.length), subtext: t("条记录") };
  }

  const nums = records
    .map((r) => displayValue(r, valField, members))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  if (nums.length === 0) {
    return { headline: "0", subtext: t("暂无有效数值") };
  }

  const sum = nums.reduce((a, b) => a + b, 0);
  const avg = sum / nums.length;
  const maxVal = Math.max(...nums);
  const minVal = Math.min(...nums);

  switch (widget.metric) {
    case "sum":
      return { headline: fmtDashNum(sum), subtext: t("平均 {avg} · 已填 {n} 条", { avg: fmtDashNum(avg), n: nums.length }) };
    case "avg":
      return { headline: fmtDashNum(avg), subtext: t("总计 {sum} · 已填 {n} 条", { sum: fmtDashNum(sum), n: nums.length }) };
    case "max":
      return { headline: fmtDashNum(maxVal), subtext: t("最小 {min} · 已填 {n} 条", { min: fmtDashNum(minVal), n: nums.length }) };
    case "min":
      return { headline: fmtDashNum(minVal), subtext: t("最大 {max} · 已填 {n} 条", { max: fmtDashNum(maxVal), n: nums.length }) };
    default:
      return { headline: fmtDashNum(records.length), subtext: t("条记录") };
  }
}

export function computeGroupedSeries(
  widget: DashboardWidget,
  records: BaseRecord[],
  fields: Field[],
  members: User[],
): GroupedSeries {
  const groupField =
    (widget.groupFieldId ? fields.find((f) => f.id === widget.groupFieldId) : undefined) ??
    fields.find((f) => f.type === "select" || f.type === "multi_select" || f.type === "person" || f.type === "date") ??
    fields[0];

  const valField =
    widget.metric !== "count" && widget.metric !== "checked_pct" && widget.valueFieldId
      ? fields.find((f) => f.id === widget.valueFieldId)
      : undefined;

  const metricLabel =
    widget.metric === "count" || !valField
      ? t("记录数")
      : `${valField.name} (${t(METRIC_OPTIONS.find((m) => m.value === widget.metric)?.label ?? "求和")})`;

  if (!groupField) {
    return { buckets: [], totalValue: 0, totalCount: records.length, metricLabel };
  }

  type Acc = { key: string; label: string; count: number; nums: number[]; color: string };
  const map = new Map<string, Acc>();

  const ensureBucket = (key: string, label: string, color?: string): Acc => {
    let item = map.get(key);
    if (!item) {
      const idx = map.size;
      const defaultColor = key === "" ? "#9aa0a6" : CHART_PALETTE[idx % CHART_PALETTE.length];
      item = { key, label: label || t("未填写"), count: 0, nums: [], color: color || defaultColor };
      map.set(key, item);
    }
    return item;
  };

  // Preserve configured option order for select / multi_select
  if ((groupField.type === "select" || groupField.type === "multi_select") && groupField.options) {
    for (const opt of groupField.options) {
      const [, fg] = optionColor(groupField, opt);
      ensureBucket(opt, opt, fg);
    }
  }

  // Disambiguate same-named members for person fields
  const memberNameCounts = new Map<string, number>();
  if (groupField.type === "person") {
    for (const m of members) {
      if (m.name) memberNameCounts.set(m.name, (memberNameCounts.get(m.name) ?? 0) + 1);
    }
  }

  for (const rec of records) {
    const rawNum = valField ? displayValue(rec, valField, members) : null;
    const numVal = typeof rawNum === "number" && Number.isFinite(rawNum) ? rawNum : null;

    const gv = displayValue(rec, groupField, members);
    const entries: { key: string; label: string; color?: string }[] = [];

    if (groupField.type === "person") {
      const ids = [...new Set(personIDs(gv))];
      if (ids.length === 0) {
        entries.push({ key: "", label: t("未填写") });
      } else {
        for (const uid of ids) {
          const nm = memberName(uid, members);
          const lbl = nm ? ((memberNameCounts.get(nm) ?? 0) > 1 ? `${nm} (#${uid})` : nm) : t("成员 #{id}", { id: uid });
          entries.push({ key: `member:${uid}`, label: lbl });
        }
      }
    } else if (groupField.type === "checkbox") {
      const checked = gv === true;
      entries.push({
        key: checked ? "true" : "false",
        label: checked ? t("已勾选") : t("未勾选"),
        color: checked ? "#00b42a" : "#9aa0a6",
      });
    } else if (groupField.type === "date") {
      const s = typeof gv === "string" ? gv.trim().slice(0, 10) : "";
      entries.push({ key: s, label: s || t("未填写") });
    } else if (Array.isArray(gv)) {
      const list = gv.map(String).filter(Boolean);
      if (list.length === 0) entries.push({ key: "", label: t("未填写") });
      else {
        for (const item of list) {
          const [, fg] = optionColor(groupField, item);
          entries.push({ key: item, label: item, color: fg });
        }
      }
    } else if (typeof gv === "string" && gv.trim()) {
      const s = gv.trim();
      const color = groupField.type === "select" ? optionColor(groupField, s)[1] : undefined;
      entries.push({ key: s, label: s, color });
    } else {
      entries.push({ key: "", label: t("未填写") });
    }

    for (const ent of entries) {
      const b = ensureBucket(ent.key, ent.label, ent.color);
      b.count++;
      if (numVal !== null) b.nums.push(numVal);
    }
  }

  let accList = [...map.values()];
  if (groupField.type === "date") {
    accList.sort((a, b) => {
      if (a.key === "") return 1;
      if (b.key === "") return -1;
      return a.key.localeCompare(b.key);
    });
  } else if (accList.length > 12) {
    // Keep top 12 non-empty buckets for readability on text/high-cardinality dimensions
    accList = accList.sort((a, b) => b.count - a.count).slice(0, 12);
  }

  const rawBuckets = accList.map((a) => {
    const sum = a.nums.reduce((x, y) => x + y, 0);
    const avg = a.nums.length ? sum / a.nums.length : null;
    let value = a.count;
    if (valField) {
      if (widget.metric === "sum") value = sum;
      else if (widget.metric === "avg") value = avg ?? 0;
      else if (widget.metric === "max") value = a.nums.length ? Math.max(...a.nums) : 0;
      else if (widget.metric === "min") value = a.nums.length ? Math.min(...a.nums) : 0;
    }
    return {
      key: a.key,
      label: a.label,
      count: a.count,
      value,
      sum,
      avg,
      color: a.color,
    };
  });

  const totalValue = rawBuckets.reduce((acc, b) => acc + Math.max(0, b.value), 0);
  const totalCount = rawBuckets.reduce((acc, b) => acc + b.count, 0);
  const buckets: GroupedBucket[] = rawBuckets.map((b) => ({
    ...b,
    sharePct: totalValue > 0 ? Math.round((Math.max(0, b.value) / totalValue) * 1000) / 10 : 0,
  }));

  return { buckets, totalValue, totalCount, metricLabel };
}

/**
 * Pure headless Base Dashboard aggregation engine (`metric`, `bar`, `horizontal_bar`, `pie`, `line`, `pivot`).
 */

import { formatCellText, isCellEmpty } from "./query.js";
import type { BaseField, BaseRecord, DashboardMetric, DashboardWidget } from "./types.js";

export const DASHBOARD_PALETTE = [
  "#3370ff",
  "#00b42a",
  "#ff8800",
  "#7b56d9",
  "#f54a45",
  "#14b8a6",
  "#f59e0b",
  "#6366f1",
] as const;

export interface MetricSummary {
  value: number;
  headline: string;
  subtext: string;
  progressPct?: number;
}

export interface GroupedBucket {
  key: string;
  label: string;
  count: number;
  value: number;
  sum: number;
  avg: number | null;
  sharePct: number;
  color: string;
}

export interface GroupedSeries {
  buckets: GroupedBucket[];
  totalValue: number;
  totalCount: number;
  metric: DashboardMetric;
}

export function isGroupableField(f: Pick<BaseField, "type">): boolean {
  return (
    f.type === "select" ||
    f.type === "multi_select" ||
    f.type === "person" ||
    f.type === "date" ||
    f.type === "checkbox" ||
    f.type === "text" ||
    f.type === "location"
  );
}

export function isNumericField(f: Pick<BaseField, "type">): boolean {
  return (
    f.type === "number" ||
    f.type === "rating" ||
    f.type === "currency" ||
    f.type === "progress" ||
    f.type === "autonumber"
  );
}

function numericValue(record: BaseRecord, fieldId: number | undefined): number | null {
  if (fieldId === undefined) return null;
  const val = record.cells[String(fieldId)];
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim() !== "") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Generate sensible initial dashboard widgets from a table's fields. */
export function defaultDashboardWidgets(fields: readonly BaseField[], tableId?: number): DashboardWidget[] {
  const widgets: DashboardWidget[] = [
    { id: "auto-total", type: "metric", title: "Total Records", tableId, span: 1, metric: "count" },
  ];
  const numField = fields.find(isNumericField);
  if (numField) {
    widgets.push({
      id: `auto-sum-${numField.id}`,
      type: "metric",
      title: `${numField.name} Sum`,
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
      title: `${cbField.name} Checked %`,
      tableId,
      span: 1,
      metric: "checked_pct",
      valueFieldId: cbField.id,
    });
  }
  const selectField = fields.find((f) => f.type === "select" || f.type === "multi_select");
  if (selectField) {
    widgets.push({
      id: `auto-bar-${selectField.id}`,
      type: "bar",
      title: `By ${selectField.name}`,
      tableId,
      span: 1,
      groupFieldId: selectField.id,
      metric: numField ? "sum" : "count",
      valueFieldId: numField?.id,
    });
    widgets.push({
      id: `auto-pie-${selectField.id}`,
      type: "pie",
      title: `${selectField.name} Distribution`,
      tableId,
      span: 1,
      groupFieldId: selectField.id,
      metric: "count",
    });
  }
  const dateField = fields.find((f) => f.type === "date");
  if (dateField) {
    widgets.push({
      id: `auto-line-${dateField.id}`,
      type: "line",
      title: `${dateField.name} Trend`,
      tableId,
      span: 2,
      groupFieldId: dateField.id,
      metric: numField ? "sum" : "count",
      valueFieldId: numField?.id,
    });
  }
  return widgets;
}

export function computeMetricSummary(
  records: readonly BaseRecord[],
  widget: DashboardWidget,
): MetricSummary {
  if (widget.metric === "count") {
    return { value: records.length, headline: fmtNum(records.length), subtext: "records" };
  }
  if (widget.metric === "checked_pct") {
    const checked = records.filter((r) => Boolean(r.cells[String(widget.valueFieldId)])).length;
    const pct = records.length > 0 ? (checked / records.length) * 100 : 0;
    return {
      value: pct,
      headline: `${pct.toFixed(1)}%`,
      subtext: `${checked}/${records.length} checked`,
      progressPct: pct,
    };
  }
  const nums = records
    .map((r) => numericValue(r, widget.valueFieldId))
    .filter((n): n is number => n !== null);
  if (nums.length === 0) {
    return { value: 0, headline: "—", subtext: "0 numeric values" };
  }
  let val = 0;
  if (widget.metric === "sum") val = nums.reduce((a, b) => a + b, 0);
  else if (widget.metric === "avg") val = nums.reduce((a, b) => a + b, 0) / nums.length;
  else if (widget.metric === "min") val = Math.min(...nums);
  else if (widget.metric === "max") val = Math.max(...nums);
  return { value: val, headline: fmtNum(val), subtext: `from ${nums.length} records` };
}

export function computeGroupedSeries(
  records: readonly BaseRecord[],
  fields: readonly BaseField[],
  widget: DashboardWidget,
): GroupedSeries {
  const gField = fields.find((f) => f.id === widget.groupFieldId);
  const acc = new Map<string, { label: string; count: number; nums: number[]; checked: number }>();

  const addTo = (key: string, label: string, rec: BaseRecord) => {
    let entry = acc.get(key);
    if (!entry) {
      entry = { label, count: 0, nums: [], checked: 0 };
      acc.set(key, entry);
    }
    entry.count++;
    const n = numericValue(rec, widget.valueFieldId);
    if (n !== null) entry.nums.push(n);
    if (widget.valueFieldId !== undefined && Boolean(rec.cells[String(widget.valueFieldId)])) {
      entry.checked++;
    }
  };

  for (const rec of records) {
    if (!gField) {
      addTo("all", "All", rec);
      continue;
    }
    const raw = rec.cells[String(gField.id)];
    if (isCellEmpty(raw)) {
      addTo("__empty__", "(Empty)", rec);
    } else if (gField.type === "multi_select" && Array.isArray(raw)) {
      for (const item of raw) addTo(String(item), String(item), rec);
    } else {
      const label = formatCellText(raw);
      addTo(label, label, rec);
    }
  }

  const rawBuckets = [...acc.entries()].map(([key, item], idx) => {
    const sum = item.nums.reduce((a, b) => a + b, 0);
    const avg = item.nums.length > 0 ? sum / item.nums.length : null;
    let value = item.count;
    if (widget.metric === "sum") value = sum;
    else if (widget.metric === "avg") value = avg ?? 0;
    else if (widget.metric === "min") value = item.nums.length > 0 ? Math.min(...item.nums) : 0;
    else if (widget.metric === "max") value = item.nums.length > 0 ? Math.max(...item.nums) : 0;
    else if (widget.metric === "checked_pct") value = (item.checked / item.count) * 100;
    return {
      key,
      label: item.label,
      count: item.count,
      value,
      sum,
      avg,
      sharePct: 0,
      color: DASHBOARD_PALETTE[idx % DASHBOARD_PALETTE.length],
    };
  });

  if (gField?.type === "date") {
    rawBuckets.sort((a, b) => a.label.localeCompare(b.label));
  } else {
    rawBuckets.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  }

  const totalValue = rawBuckets.reduce((s, b) => s + Math.max(0, b.value), 0);
  const totalCount = records.length;
  for (const b of rawBuckets) {
    b.sharePct = totalValue > 0 ? (Math.max(0, b.value) / totalValue) * 100 : 0;
  }

  return { buckets: rawBuckets, totalValue, totalCount, metric: widget.metric };
}

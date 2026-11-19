import { describe, expect, it } from "vitest";
import type { BaseRecord, Field } from "@/lib/api";
import { dashboardStats } from "./dashboard";
import { computeGroupedSeries, computeMetricWidget, defaultDashboardWidgets } from "./dashboard-model";

const fields: Field[] = [
  { id: 1, name: "任务", type: "text", position: 1, isPrimary: true },
  { id: 2, name: "状态", type: "select", position: 2, options: ["进行中", "完成"] },
  { id: 3, name: "工时", type: "number", position: 3 },
  { id: 4, name: "已核对", type: "checkbox", position: 4 },
  { id: 5, name: "成员", type: "person", position: 5, multiple: true },
];
const members = [
  { id: 7, name: "张三", email: "", createdAt: "" },
  { id: 9, name: "李四", email: "", createdAt: "" },
];
const recs: BaseRecord[] = [
  { id: 1, baseId: 1, position: 1, cells: { 2: "进行中", 3: 2, 4: true, 5: [7, 9] } },
  { id: 2, baseId: 1, position: 2, cells: { 2: "完成", 3: 3, 5: 7 } },
  { id: 3, baseId: 1, position: 3, cells: {} },
];

describe("dashboard stats", () => {
  it("counts records, sums numbers, buckets selects and checkboxes", () => {
    const s = dashboardStats(recs, fields, members);
    expect(s.total).toBe(3);
    expect(s.numbers[0]).toMatchObject({ sum: 5, avg: 2.5, filled: 2 });
    expect(s.selects[0].buckets).toEqual([{ key: "进行中", count: 1 }, { key: "完成", count: 1 }, { key: "", count: 1 }]);
    expect(s.checkboxes[0].checked).toBe(1);
  });
  it("buckets person fields per member, counting multi-member cells once each", () => {
    const s = dashboardStats(recs, fields, members);
    expect(s.selects[1].buckets).toEqual([{ key: "张三", count: 2, memberId: 7 }, { key: "李四", count: 1, memberId: 9 }, { key: "", count: 1 }]);
  });
  it("keeps same-named members separate and counts a repeated member only once per record", () => {
    const sameNames = [{ ...members[0], name: "小李" }, { ...members[1], name: "小李" }];
    const records = [{ ...recs[0], cells: { 5: [7, 7, 9] } }, { ...recs[1], cells: { 5: 7 } }];
    expect(dashboardStats(records, fields, sameNames).selects[1].buckets).toEqual([
      { key: "小李 (#7)", count: 2, memberId: 7 }, { key: "小李 (#9)", count: 1, memberId: 9 },
    ]);
  });
  it("does not allow invalid numeric values to corrupt totals", () => {
    const records = [{ ...recs[0], cells: { 3: Infinity } }, { ...recs[1], cells: { 3: 3 } }];
    expect(dashboardStats(records, fields, members).numbers[0]).toMatchObject({ sum: 3, avg: 3, filled: 1 });
  });

  it("generates smart default widgets and computes metric & grouped series for multi-type charts", () => {
    const withDate: Field[] = [...fields, { id: 6, name: "日期", type: "date", position: 6 }];
    const withDateRecs: BaseRecord[] = [
      { id: 1, baseId: 1, position: 1, cells: { 2: "进行中", 3: 10, 4: true, 6: "2026-11-18" } },
      { id: 2, baseId: 1, position: 2, cells: { 2: "完成", 3: 30, 4: false, 6: "2026-11-15" } },
      { id: 3, baseId: 1, position: 3, cells: { 2: "进行中", 3: 20, 4: true, 6: "2026-11-18" } },
    ];
    const defaults = defaultDashboardWidgets(withDate, 100);
    expect(defaults.map((w) => w.type)).toEqual(["metric", "metric", "metric", "bar", "pie", "line", "pivot"]);

    const sumMetric = computeMetricWidget(defaults[1], withDateRecs, withDate, members);
    expect(sumMetric.headline).toBe("60");

    const pctMetric = computeMetricWidget(defaults[2], withDateRecs, withDate, members);
    expect(pctMetric.headline).toBe("67%");
    expect(pctMetric.progressPct).toBe(67);

    const barSeries = computeGroupedSeries(defaults[3], withDateRecs, withDate, members);
    expect(barSeries.buckets.find((b) => b.key === "进行中")?.value).toBe(30);
    expect(barSeries.buckets.find((b) => b.key === "完成")?.value).toBe(30);

    // Date line chart sorts chronologically
    const lineSeries = computeGroupedSeries(defaults[5], withDateRecs, withDate, members);
    expect(lineSeries.buckets.map((b) => b.key)).toEqual(["2026-11-15", "2026-11-18"]);
    expect(lineSeries.buckets.map((b) => b.value)).toEqual([30, 30]);
  });
});

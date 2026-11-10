import { describe, expect, it } from "vitest";
import type { BaseRecord, Field } from "@/lib/api";
import { dashboardStats } from "./Dashboard";

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
    expect(s.selects[1].buckets).toEqual([{ key: "张三", count: 2 }, { key: "李四", count: 1 }, { key: "", count: 1 }]);
  });
});

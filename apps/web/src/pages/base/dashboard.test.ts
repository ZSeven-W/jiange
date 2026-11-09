import { describe, expect, it } from "vitest";
import type { BaseRecord, Field } from "@/lib/api";
import { dashboardStats } from "./Dashboard";

const fields: Field[] = [
  { id: 1, name: "任务", type: "text", position: 1, isPrimary: true },
  { id: 2, name: "状态", type: "select", position: 2, options: ["进行中", "完成"] },
  { id: 3, name: "工时", type: "number", position: 3 },
  { id: 4, name: "已核对", type: "checkbox", position: 4 },
];
const recs: BaseRecord[] = [
  { id: 1, baseId: 1, position: 1, cells: { 2: "进行中", 3: 2, 4: true } },
  { id: 2, baseId: 1, position: 2, cells: { 2: "完成", 3: 3 } },
  { id: 3, baseId: 1, position: 3, cells: {} },
];

describe("dashboard stats", () => {
  it("counts records, sums numbers, buckets selects and checkboxes", () => {
    const s = dashboardStats(recs, fields, []);
    expect(s.total).toBe(3);
    expect(s.numbers[0]).toMatchObject({ sum: 5, avg: 2.5, filled: 2 });
    expect(s.selects[0].buckets).toEqual([{ key: "进行中", count: 1 }, { key: "完成", count: 1 }, { key: "", count: 1 }]);
    expect(s.checkboxes[0].checked).toBe(1);
  });
});

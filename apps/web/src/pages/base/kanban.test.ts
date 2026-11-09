import { describe, expect, it } from "vitest";
import { groupRecords } from "./Kanban";
import type { BaseRecord, Field } from "@/lib/api";

const field: Field = { id: 2, name: "状态", type: "select", options: ["待办", "进行中", "完成"], position: 2 };
const recs: BaseRecord[] = [
  { id: 1, baseId: 1, position: 1, cells: { 2: "进行中" } },
  { id: 2, baseId: 1, position: 2, cells: { 2: "待办" } },
  { id: 3, baseId: 1, position: 3, cells: {} }, // 未分组
  { id: 4, baseId: 1, position: 4, cells: { 2: "完成" } },
  { id: 5, baseId: 1, position: 5, cells: { 2: "不存在" } }, // 未知选项 → 未分组
];

describe("kanban grouping", () => {
  it("columns follow the option order, empties and unknowns go to 未分类 first", () => {
    const cols = groupRecords(recs, field);
    expect(cols.map((c) => c.key)).toEqual(["", "待办", "进行中", "完成"]);
    expect(cols[1].records.map((r) => r.id)).toEqual([2]);
    expect(cols[2].records.map((r) => r.id)).toEqual([1]);
    expect(cols[0].records.map((r) => r.id)).toEqual([3, 5]);
  });
  it("keeps in-column order by record position", () => {
    const cols = groupRecords([...recs].reverse(), field);
    expect(cols[0].records.map((r) => r.id)).toEqual([3, 5]);
  });
});


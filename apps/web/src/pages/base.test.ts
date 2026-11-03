import { describe, expect, it } from "vitest";
import { view } from "./BasePage";
import type { BaseRecord, Field } from "@/lib/api";

const fields: Field[] = [
  { id: 1, name: "标题", type: "text", position: 1 },
  { id: 2, name: "状态", type: "select", options: ["待办", "进行中", "完成"], position: 2 },
  { id: 3, name: "估时", type: "number", position: 3 },
];
const recs: BaseRecord[] = [
  { id: 1, position: 1, cells: { 1: "拖拽", 2: "完成", 3: 10 } },
  { id: 2, position: 2, cells: { 1: "分享", 2: "待办", 3: 2 } },
  { id: 3, position: 3, cells: { 1: "导出" } },
];

describe("grid view", () => {
  it("sorts numbers numerically and select by option order, empties last", () => {
    expect(view(recs, fields, { f: 3, desc: false }, "").map((r) => r.id)).toEqual([2, 1, 3]);
    expect(view(recs, fields, { f: 2, desc: false }, "").map((r) => r.id)).toEqual([2, 1, 3]);
    expect(view(recs, fields, { f: 3, desc: true }, "").map((r) => r.id)).toEqual([1, 2, 3]);
  });
  it("filters by any cell", () => {
    expect(view(recs, fields, null, "待办").map((r) => r.id)).toEqual([2]);
    expect(view(recs, fields, null, "").length).toBe(3);
  });
});

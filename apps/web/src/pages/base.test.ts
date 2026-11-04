import { describe, expect, it } from "vitest";
import { view } from "./base/view";
import type { BaseRecord, Field, User } from "@/lib/api";

const fields: Field[] = [
  { id: 1, name: "标题", type: "text", position: 1 },
  { id: 2, name: "状态", type: "select", options: ["待办", "进行中", "完成"], position: 2 },
  { id: 3, name: "估时", type: "number", position: 3 },
];
const recs: BaseRecord[] = [
  { id: 1, baseId: 1, position: 1, cells: { 1: "拖拽", 2: "完成", 3: 10 } },
  { id: 2, baseId: 1, position: 2, cells: { 1: "分享", 2: "待办", 3: 2 } },
  { id: 3, baseId: 1, position: 3, cells: { 1: "导出" } },
];
const members: User[] = [{ id: 1, email: "k@x.com", name: "Kay", createdAt: "" }];

describe("grid view", () => {
  it("sorts numbers numerically and select by option order, empties last", () => {
    expect(view(recs, fields, members, { f: 3, desc: false }, "").map((r) => r.id)).toEqual([2, 1, 3]);
    expect(view(recs, fields, members, { f: 2, desc: false }, "").map((r) => r.id)).toEqual([2, 1, 3]);
    expect(view(recs, fields, members, { f: 3, desc: true }, "").map((r) => r.id)).toEqual([1, 2, 3]);
  });
  it("filters by any cell", () => {
    expect(view(recs, fields, members, null, "待办").map((r) => r.id)).toEqual([2]);
    expect(view(recs, fields, members, null, "").length).toBe(3);
  });
});

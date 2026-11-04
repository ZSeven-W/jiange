import { describe, expect, it } from "vitest";
import { applyBtEvent, type BaseData, type BtEvent } from "./sync";
import type { BaseRecord, Field } from "@/lib/api";

const data = (): BaseData => ({
  base: { id: 1, workspaceId: 1, parentId: null, title: "需求池", icon: "", creatorId: 1, creatorName: "K", createdAt: "", updatedAt: "", role: "manage", kind: "base" },
  fields: [
    { id: 1, name: "标题", type: "text", position: 1 },
    { id: 2, name: "状态", type: "select", options: ["待办", "完成"], position: 2 },
  ],
  records: [
    { id: 11, baseId: 1, position: 1, cells: { 1: "拖拽", 2: "完成" } },
    { id: 12, baseId: 1, position: 2, cells: { 1: "分享" } },
  ],
  head: 5,
});

const ev = (seq: number, body: BtEvent["body"]): BtEvent => ({ seq, body });

describe("applyBtEvent", () => {
  it("upserts and re-sorts fields", () => {
    const out = applyBtEvent(data(), ev(6, { kind: "field", op: "add", field: { id: 3, name: "估时", type: "number", position: 0.5 } }));
    expect(out.fields.map((f) => f.id)).toEqual([3, 1, 2]);
    const renamed = applyBtEvent(out, ev(7, { kind: "field", op: "update", field: { id: 1, name: "任务", type: "text", position: 1 } }));
    expect(renamed.fields[1].name).toBe("任务");
  });

  it("deleting a field also clears its cells", () => {
    const out = applyBtEvent(data(), ev(6, { kind: "field", op: "del", fid: 2 }));
    expect(out.fields.map((f) => f.id)).toEqual([1]);
    expect(out.records[0].cells).toEqual({ 1: "拖拽" });
  });

  it("upserts records in position order and deletes by id", () => {
    const out = applyBtEvent(data(), ev(6, { kind: "record", op: "add", record: { id: 13, baseId: 1, position: 0.5, cells: { 1: "新行" } } }));
    expect(out.records.map((r) => r.id)).toEqual([13, 11, 12]);
    const upd = applyBtEvent(out, ev(7, { kind: "record", op: "update", record: { id: 13, baseId: 1, position: 0.5, cells: { 1: "改名" } } }));
    expect(upd.records[0].cells[1]).toBe("改名");
    const del = applyBtEvent(upd, ev(8, { kind: "record", op: "del", rid: 11 }));
    expect(del.records.map((r) => r.id)).toEqual([13, 12]);
  });

  it("later events win on the same cell (LWW by seq)", () => {
    let d = data();
    d = applyBtEvent(d, ev(6, { kind: "record", op: "update", record: { id: 12, baseId: 1, position: 2, cells: { 1: "先写" } } }));
    d = applyBtEvent(d, ev(7, { kind: "record", op: "update", record: { id: 12, baseId: 1, position: 2, cells: { 1: "后写" } } }));
    expect(d.records.find((r) => r.id === 12)!.cells[1]).toBe("后写");
  });

  it("leaves state unchanged for reload and unknown kinds", () => {
    const d = data();
    expect(applyBtEvent(d, ev(6, { kind: "reload" }))).toBe(d);
    expect(applyBtEvent(d, ev(6, { kind: "field", op: "del" }))).toBe(d);
  });
});

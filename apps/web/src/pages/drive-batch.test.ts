import { describe, expect, it } from "vitest";
import { batchMessage, pruneSelection, runDriveBatch, toggleId } from "./drive-batch";

describe("drive batch operations", () => {
  it("runs every item sequentially and records failures without stopping", async () => {
    const order: number[] = [];
    const result = await runDriveBatch([{ id: 1 }, { id: 2 }, { id: 3 }], async (item) => {
      order.push(item.id);
      if (item.id === 2) throw new Error("conflict");
    });
    expect(order).toEqual([1, 2, 3]);
    expect(result).toEqual({ done: [1, 3], failed: [2] });
  });
  it("reports partial failure as an error and full success as a notice", () => {
    expect(batchMessage("移动", { done: [1, 2], failed: [] })).toEqual({ notice: "已移动 2 项。", error: "" });
    expect(batchMessage("删除", { done: [1], failed: [2] }).error).toBe("已删除 1 项，1 项未完成（可能已被他人修改或没有权限），已保留选中，请刷新后重试。");
    expect(batchMessage("删除", { done: [], failed: [2] }).error.startsWith("1 项未完成")).toBe(true);
  });
  it("toggles ids and prunes ones that left the list", () => {
    const s = toggleId(new Set([1]), 2);
    expect([...s]).toEqual([1, 2]);
    expect([...toggleId(s, 1)]).toEqual([2]);
    const same = new Set([1, 2]);
    expect(pruneSelection(same, [1, 2, 3])).toBe(same);
    expect([...pruneSelection(same, [2])]).toEqual([2]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBtEvent, createSnapshotRefresher, startRestrictedPolling, type BaseData, type BtEvent } from "./sync";
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

describe("authorized snapshot invalidation", () => {
  it("performs a second fetch when another event arrives during the first", async () => {
    const resolvers: Array<() => void> = [];
    const refresh = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
    const snapshots = createSnapshotRefresher(refresh);
    const first = snapshots.request();
    const second = snapshots.request();
    expect(refresh).toHaveBeenCalledTimes(1);
    resolvers.shift()!();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    resolvers.shift()!();
    await Promise.all([first, second]);
    snapshots.stop();
    await snapshots.request();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed refresh and allows a later retry", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(undefined);
    const snapshots = createSnapshotRefresher(refresh);
    await expect(snapshots.request()).rejects.toThrow("denied");
    await snapshots.request();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not lose an invalidation between completion and promise cleanup", async () => {
    let finish!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const snapshots = createSnapshotRefresher(refresh);
    const first = snapshots.request();
    finish();
    queueMicrotask(() => { void snapshots.request(); });
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    snapshots.stop();
  });
});

describe("restricted base polling", () => {
  afterEach(() => vi.useRealTimers());

  it("polls only in the foreground and coalesces wakeups while a request is running", async () => {
    vi.useFakeTimers();
    let visible = false;
    let wake = () => {};
    let resolve!: () => void;
    const refresh = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const stop = startRestrictedPolling(refresh, {
      visible: () => visible,
      listen: (fn) => { wake = fn; return () => { wake = () => {}; }; },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).not.toHaveBeenCalled();
    visible = true;
    wake(); wake();
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    wake();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not reschedule a failed refresh after it is stopped", async () => {
    vi.useFakeTimers();
    let reject!: (reason: unknown) => void;
    const refresh = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const stop = startRestrictedPolling(refresh, {
      visible: () => true,
      listen: () => () => {},
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    stop();
    reject(new Error("access denied"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
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

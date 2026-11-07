import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { executeCsvImport, importFailureMessage, importResultMessage } from "./CsvImport";
import { WriteLedger } from "./writeSafety";

describe("CSV import feedback", () => {
  it("reports the actual imported and skipped rows", () => {
    expect(importResultMessage({ imported: 2, errors: [] })).toBe("已导入 2 条记录。");
    expect(importResultMessage({ imported: 1, errors: [{ row: 2, err: "无效日期" }] })).toContain("已导入 1 条记录，跳过 1 行：第 2 行 无效日期");
  });
  it("distinguishes a rejected request from a network result that may have committed", () => {
    expect(importFailureMessage(new ApiError(409, "import_conflict", "conflict"))).toContain("未导入数据");
    expect(importFailureMessage(new ApiError(403, "forbidden", "forbidden"))).toContain("无权导入");
    expect(importFailureMessage(new ApiError(500, "error", "failed"))).toContain("无法确认导入是否完成");
    expect(importFailureMessage(new ApiError(408, "timeout", "timeout"))).toContain("无法确认导入是否完成");
    expect(importFailureMessage(new TypeError("network"))).toContain("避免重复导入");
  });
  it("releases the old table's ledger when the file read finishes after unmount", async () => {
    let resolveRead!: (value: ArrayBuffer) => void;
    const file = { name: "test.csv", size: 3, arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { resolveRead = resolve; }) };
    const ledger = new WriteLedger(), send = vi.fn(), onMessage = vi.fn(), onRefresh = vi.fn(async () => {});
    let alive = true;
    const task = executeCsvImport({ file, ledger, valid: () => alive, send, onRefresh, onMessage });
    expect(ledger.blocked("batch")).toBe(true);
    alive = false;
    resolveRead(new Uint8Array([97, 44, 98]).buffer);
    await task;
    expect(send).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(ledger.blocked("batch")).toBe(false);
  });
  it("preserves an uncertain sent import after unmount to prevent a duplicate", async () => {
    let rejectSend!: (error: Error) => void;
    const file = { name: "test.csv", size: 3, arrayBuffer: async () => new Uint8Array([97, 44, 98]).buffer };
    const ledger = new WriteLedger(), onMessage = vi.fn(), onRefresh = vi.fn(async () => {});
    let alive = true;
    const send = vi.fn(() => new Promise<{ imported: number; fields: number; errors: { row: number; err: string }[] }>((_resolve, reject) => { rejectSend = reject; }));
    const task = executeCsvImport({ file, ledger, valid: () => alive, send, onRefresh, onMessage });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    alive = false;
    rejectSend(new TypeError("network"));
    await task;
    expect(ledger.blocked("batch")).toBe(true);
    expect(ledger.snapshot()[0].status).toBe("failed");
    expect(onMessage).not.toHaveBeenCalled();
  });
});

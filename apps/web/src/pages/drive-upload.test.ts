import { describe, expect, it, vi } from "vitest";
import { ApiError, type DriveEntry } from "@/lib/api";
import { DriveUploadManager, planDriveUpload } from "./drive-upload";

function file(name: string, path = name) {
  const value = new File([name], name, { type: "text/plain" });
  Object.defineProperty(value, "webkitRelativePath", { value: path });
  return value;
}
function entry(id: number, kind: "file" | "folder", title: string, parentId: number | null): DriveEntry {
  return { id, kind, title, parentId, workspaceId: 1, role: "manage", revision: 1, updatedAt: "2026-01-01" };
}

describe("drive batch upload", () => {
  it("creates each directory once and preserves nested paths", async () => {
    let id = 0;
    const create = vi.fn(async (title: string, parent: number | null) => entry(++id, "folder", title, parent));
    const upload = vi.fn(async (item: File, parent: number | null) => entry(++id, "file", item.name, parent));
    const done = vi.fn();
    const manager = new DriveUploadManager(1, done, { create, upload });
    await manager.start([file("a.txt", "项目/a.txt"), file("b.txt", "项目/资料/b.txt"), file("c.txt", "项目/资料/c.txt")], "folder", 42, true);
    expect(create.mock.calls.map(([name, parent]) => [name, parent])).toEqual([["项目", 42], ["资料", 1]]);
    expect(upload.mock.calls.map(([item, parent]) => [item.name, parent])).toEqual([["a.txt", 1], ["b.txt", 3], ["c.txt", 3]]);
    expect(manager.snapshot()).toMatchObject({ phase: "complete", total: 3, completed: 3, rootId: 1, rootName: "项目" });
    expect(done).toHaveBeenCalledOnce();
  });
  it("validates every path and size before any mutation", async () => {
    const create = vi.fn(); const upload = vi.fn(); const manager = new DriveUploadManager(1, () => {}, { create, upload });
    const bad = file("x.txt", "项目/../x.txt");
    await manager.start([file("good.txt", "项目/good.txt"), bad], "folder", null, false);
    expect(manager.snapshot().phase).toBe("failed"); expect(create).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
    const huge = file("large.txt"); Object.defineProperty(huge, "size", { value: 20 * 1024 * 1024 + 1 });
    await manager.start([huge], "files", null, false);
    expect(manager.snapshot().message).toContain("20 MB"); expect(upload).not.toHaveBeenCalled();
    expect(() => planDriveUpload([file("a", "x/a"), file("a", "y/a")], "folder")).toThrow("一次选择一个文件夹");
    expect(() => planDriveUpload([file("a", "x/a"), file("a", "x/a")], "folder")).toThrow("重复路径");
    expect(() => planDriveUpload([file("a", "x/a"), file("b", "x/a/b")], "folder")).toThrow("同时是文件和文件夹");
  });
  it("stops without retrying when a request result is uncertain", async () => {
    const create = vi.fn(async (title: string, parent: number | null) => entry(1, "folder", title, parent));
    const upload = vi.fn().mockRejectedValue(new Error("network lost"));
    const manager = new DriveUploadManager(1, () => {}, { create, upload });
    await manager.start([file("a", "项目/a"), file("b", "项目/b")], "folder", null, true);
    expect(manager.snapshot()).toMatchObject({ phase: "failed", rootId: 1, completed: 0, uncertain: true });
    expect(upload).toHaveBeenCalledOnce();
  });
  it("reports a rejected permission as a known failure", async () => {
    const manager = new DriveUploadManager(1, () => {}, { create: vi.fn(), upload: vi.fn().mockRejectedValue(new ApiError(403, "forbidden", "没有上传权限")) });
    await manager.start([file("a")], "files", null, false);
    expect(manager.snapshot()).toMatchObject({ phase: "failed", uncertain: false, message: "没有上传权限" });
  });
  it("keeps completed files and stops after a later definite failure", async () => {
    const create = vi.fn(async (title: string, parent: number | null) => entry(1, "folder", title, parent));
    const upload = vi.fn().mockResolvedValueOnce(entry(2, "file", "a", 1)).mockRejectedValueOnce(new ApiError(403, "forbidden", "权限已变化"));
    const manager = new DriveUploadManager(1, () => {}, { create, upload });
    await manager.start([file("a", "项目/a"), file("b", "项目/b"), file("c", "项目/c")], "folder", null, true);
    expect(manager.snapshot()).toMatchObject({ phase: "failed", rootId: 1, completed: 1, total: 3, uncertain: false, message: "权限已变化" });
    expect(upload).toHaveBeenCalledTimes(2);
  });
  it("marks a cancelled in-flight request as uncertain and sends no later file", async () => {
    const upload = vi.fn((_file: File, _parent: number | null, _personal: boolean, signal: AbortSignal) => new Promise<DriveEntry>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true })));
    const manager = new DriveUploadManager(1, () => {}, { create: vi.fn(), upload });
    const work = manager.start([file("a"), file("b")], "files", null, false);
    manager.cancel(); await work;
    expect(manager.snapshot()).toMatchObject({ phase: "cancelled", uncertain: true, completed: 0 }); expect(upload).toHaveBeenCalledOnce();
  });
});

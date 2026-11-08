import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, type DriveEntry } from "@/lib/api";
import { DriveUploadStatus } from "@/components/DriveUploadStatus";
import { DirectoryPickerGate, DriveUploadManager, planDriveUpload } from "./drive-upload";
import { scanDriveDirectory, type DriveDirectoryHandle, type DriveFileHandle } from "./drive-upload-plan";

function file(name: string, path = name) {
  const value = new File([name], name, { type: "text/plain" });
  Object.defineProperty(value, "webkitRelativePath", { value: path });
  return value;
}
function entry(id: number, kind: "file" | "folder", title: string, parentId: number | null): DriveEntry {
  return { id, kind, title, parentId, workspaceId: 1, role: "manage", revision: 1, updatedAt: "2026-01-01" };
}
const dir = (name: string, children: (DriveDirectoryHandle | DriveFileHandle)[] = []): DriveDirectoryHandle => ({ kind: "directory", name, async *values() { yield* children; } });
const handleFile = (name: string): DriveFileHandle => ({ kind: "file", name, getFile: async () => file(name) });

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
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    manager.cancel(); await work;
    expect(manager.snapshot()).toMatchObject({ phase: "cancelled", uncertain: true, completed: 0 }); expect(upload).toHaveBeenCalledOnce();
  });
  it("does not report an uncertain write if cancellation happens before any request", async () => {
    const upload = vi.fn();
    const manager = new DriveUploadManager(1, () => {}, { create: vi.fn(), upload });
    const work = manager.start([file("a")], "files", null, false);
    manager.cancel(); await work;
    expect(manager.snapshot()).toMatchObject({ phase: "cancelled", uncertain: false, completed: 0 });
    expect(upload).not.toHaveBeenCalled();
  });
  it("enumerates and creates empty nested folders as well as files", async () => {
    const root = dir("项目", [dir("空目录", [dir("更深的空目录")]), dir("资料", [handleFile("a.txt")])]);
    const plan = await scanDriveDirectory(root, new AbortController().signal);
    expect(plan.directories.map((parts) => parts.join("/"))).toEqual(expect.arrayContaining(["项目", "项目/空目录", "项目/空目录/更深的空目录", "项目/资料"]));
    let id = 0;
    const create = vi.fn(async (title: string, parent: number | null) => entry(++id, "folder", title, parent));
    const upload = vi.fn(async (item: File, parent: number | null) => entry(++id, "file", item.name, parent));
    const manager = new DriveUploadManager(1, () => {}, { create, upload });
    await manager.startDirectory(root, null, true);
    expect(manager.snapshot()).toMatchObject({ phase: "complete", completed: 1, total: 1, rootName: "项目" });
    expect(manager.snapshot().message).toContain("已保留空文件夹");
    const dirs = create.mock.calls.map(([name]) => name);
    expect(dirs).toEqual(expect.arrayContaining(["项目", "资料", "空目录", "更深的空目录"]));
    expect(dirs).toHaveLength(4);
    expect(upload).toHaveBeenCalledOnce();
  });
  it("uploads an entirely empty selected root", async () => {
    const create = vi.fn(async (title: string, parent: number | null) => entry(9, "folder", title, parent));
    const upload = vi.fn();
    const manager = new DriveUploadManager(1, () => {}, { create, upload });
    await manager.startDirectory(dir("空项目"), 42, true);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0].slice(0, 3)).toEqual(["空项目", 42, true]);
    expect(upload).not.toHaveBeenCalled();
    expect(manager.snapshot()).toMatchObject({ phase: "complete", rootId: 9, total: 0, completed: 0 });
    const html = renderToStaticMarkup(createElement(DriveUploadStatus, { manager }));
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain("已保留空文件夹");
  });
  it("does not publish anything if directory reading fails", async () => {
    const bad: DriveFileHandle = { kind: "file", name: "locked.txt", getFile: async () => { throw new Error("permission lost"); } };
    const create = vi.fn(); const upload = vi.fn();
    const manager = new DriveUploadManager(1, () => {}, { create, upload });
    await manager.startDirectory(dir("项目", [bad]), null, false);
    expect(manager.snapshot()).toMatchObject({ phase: "failed", uncertain: false });
    expect(create).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  });
  it("cancels scanning before any remote mutation", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const slow: DriveDirectoryHandle = { kind: "directory", name: "项目", async *values() { await wait; yield handleFile("a.txt"); } };
    const create = vi.fn(); const upload = vi.fn();
    const manager = new DriveUploadManager(1, () => {}, { create, upload });
    const work = manager.startDirectory(slow, null, false);
    expect(manager.snapshot().phase).toBe("scanning");
    manager.cancel(); release(); await work;
    expect(manager.snapshot()).toMatchObject({ phase: "cancelled", uncertain: false });
    expect(create).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  });
  it("ignores a directory picker result after another action supersedes it", async () => {
    let resolve!: (handle: DriveDirectoryHandle) => void;
    const pending = new Promise<DriveDirectoryHandle>((done) => { resolve = done; });
    const selected = vi.fn(); const failed = vi.fn(); const gate = new DirectoryPickerGate();
    const picker = vi.fn(() => pending);
    gate.choose(picker, selected, failed);
    expect(picker).toHaveBeenCalledOnce();
    gate.invalidate(); resolve(dir("迟到的选择")); await pending; await Promise.resolve();
    expect(selected).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
  });
  it("reports incomplete directories when a later empty directory fails", async () => {
    let id = 0;
    const create = vi.fn(async (title: string, parent: number | null) => {
      if (title === "空目录") throw new ApiError(403, "forbidden", "权限已变化");
      return entry(++id, "folder", title, parent);
    });
    const upload = vi.fn(async (item: File, parent: number | null) => entry(++id, "file", item.name, parent));
    const manager = new DriveUploadManager(1, () => {}, { create, upload });
    await manager.startDirectory(dir("项目", [handleFile("a.txt"), dir("空目录")]), null, true);
    expect(manager.snapshot()).toMatchObject({ phase: "failed", completed: 1, total: 1, directoriesCompleted: 1, directoriesTotal: 2 });
    const html = renderToStaticMarkup(createElement(DriveUploadStatus, { manager }));
    expect(html).toContain("目录 1/2"); expect(html).toContain('aria-valuenow="2"');
  });
});

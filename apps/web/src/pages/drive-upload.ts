import { ApiError, driveApi, type DriveEntry } from "@/lib/api";

export type UploadMode = "files" | "folder";
export type UploadPhase = "idle" | "uploading" | "complete" | "failed" | "cancelled";
export type UploadSnapshot = { phase: UploadPhase; mode: UploadMode; total: number; completed: number; current: string; rootId: number | null; rootName: string; message: string; uncertain: boolean };
type UploadItem = { file: File; parts: string[] };
const MAX_FILES = 1000;
const MAX_DIRECTORIES = 1000;
const MAX_DEPTH = 32;
const MAX_BYTES = 20 * 1024 * 1024;
const validName = (name: string) => name !== "" && name !== "." && name !== ".." && name.trim() === name && [...name].length <= 100 && !/[\\/\p{Cc}\p{Cs}]/u.test(name);

/** Validate the complete selection before creating any remote nodes. */
export function planDriveUpload(files: readonly File[], mode: UploadMode): { root: string; items: UploadItem[] } {
  if (!files.length) throw new Error("没有选择可上传的文件；空文件夹无法通过当前浏览器选择器读取。");
  if (files.length > MAX_FILES) throw new Error(`一次最多上传 ${MAX_FILES} 个文件。`);
  const seen = new Set<string>(), directories = new Set<string>();
  let root = "";
  const items = files.map((file) => {
    if (file.size > MAX_BYTES) throw new Error(`「${file.name}」超过 20 MB，尚未开始上传。`);
    const path = mode === "folder" ? file.webkitRelativePath : file.name;
    const parts = path.split("/");
    if (mode === "folder" && (parts.length < 2 || parts.at(-1) !== file.name)) throw new Error("无法读取完整文件夹路径，尚未开始上传。");
    if (parts.length > MAX_DEPTH || parts.some((part) => !validName(part))) throw new Error("文件或目录名称无效、过长或目录层级过深，尚未开始上传。");
    if (mode === "folder") { if (!root) root = parts[0]; else if (root !== parts[0]) throw new Error("请一次选择一个文件夹。"); }
    if (seen.has(path)) throw new Error(`存在重复路径「${path}」，尚未开始上传。`);
    seen.add(path);
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
    return { file, parts };
  });
  if (directories.size > MAX_DIRECTORIES) throw new Error(`一次最多上传 ${MAX_DIRECTORIES} 个目录。`);
  for (const path of seen) if (directories.has(path)) throw new Error(`「${path}」同时是文件和文件夹，尚未开始上传。`);
  return { root, items };
}

type UploadAPI = {
  create: (title: string, parent: number | null, personal: boolean, signal: AbortSignal) => Promise<DriveEntry>;
  upload: (file: File, parent: number | null, personal: boolean, signal: AbortSignal) => Promise<DriveEntry>;
};
const initial = (): UploadSnapshot => ({ phase: "idle", mode: "files", total: 0, completed: 0, current: "", rootId: null, rootName: "", message: "", uncertain: false });

/** One account-session owns a queue. A cancelled or ambiguous request is never retried. */
export class DriveUploadManager {
  private state = initial();
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private disposed = false;
  private readonly api: UploadAPI;
  constructor(userId: number, private readonly onSettled: () => void, api?: UploadAPI) {
    this.api = api ?? {
      create: (title, parent, personal, signal) => driveApi.create(title, parent, personal, signal, userId),
      upload: (file, parent, personal, signal) => driveApi.uploadFile(file, parent, personal, signal, userId),
    };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<UploadSnapshot>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  get active() { return this.state.phase === "uploading"; }
  activate() { this.disposed = false; }
  dismiss() { if (!this.active) this.update(initial()); }
  cancel() { this.abort?.abort(); }
  dispose() { this.disposed = true; this.abort?.abort(); this.listeners.clear(); }

  async start(files: readonly File[], mode: UploadMode, parent: number | null, personal: boolean): Promise<void> {
    if (this.active || this.disposed) return;
    let plan: ReturnType<typeof planDriveUpload>;
    try { plan = planDriveUpload(files, mode); }
    catch (error) { this.update({ ...initial(), phase: "failed", mode, message: error instanceof Error ? error.message : "无法读取所选文件。" }); return; }
    const controller = new AbortController(); this.abort = controller;
    this.update({ ...initial(), phase: "uploading", mode, total: plan.items.length, rootName: plan.root });
    let inFlight = false;
    const paths = new Map<string, number>();
    const check = () => { if (controller.signal.aborted) throw new DOMException("cancelled", "AbortError"); };
    const validate = (entry: DriveEntry, kind: "folder" | "file", expectedParent: number | null, expectedTitle: string) => {
      if (!entry || entry.kind !== kind || !Number.isSafeInteger(entry.id) || entry.id <= 0 || entry.parentId !== expectedParent || entry.title !== expectedTitle) throw new Error("服务器返回的数据不完整");
    };
    try {
      for (const item of plan.items) {
        let destination = parent;
        const folders = mode === "folder" ? item.parts.slice(0, -1) : [];
        for (let i = 0; i < folders.length; i++) {
          check();
          const path = folders.slice(0, i + 1).join("/");
          const known = paths.get(path);
          if (known !== undefined) { destination = known; continue; }
          this.update({ current: path }); inFlight = true;
          const entry = await this.api.create(folders[i], destination, personal, controller.signal);
          validate(entry, "folder", destination, folders[i]); inFlight = false;
          destination = entry.id; paths.set(path, entry.id);
          if (i === 0) this.update({ rootId: entry.id });
        }
        check(); this.update({ current: item.parts.join("/") }); inFlight = true;
        const entry = await this.api.upload(item.file, destination, personal, controller.signal);
        validate(entry, "file", destination, item.file.name); inFlight = false;
        this.update({ completed: this.state.completed + 1 });
      }
      if (!this.disposed) this.update({ phase: "complete", current: "", message: mode === "folder" ? "上传完成。空文件夹不会上传；同名目录不会覆盖。" : "上传完成。同名文件不会覆盖。" });
    } catch (error) {
      if (!this.disposed) {
        const cancelled = controller.signal.aborted;
        const uncertain = inFlight && (cancelled || !(error instanceof ApiError && error.status >= 400 && error.status < 500));
        this.update({ phase: cancelled ? "cancelled" : "failed", uncertain, message: uncertain ? "当前项目的结果未确认，请先检查目录，避免重复上传。" : cancelled ? "上传已停止，已完成的内容保留在云盘。" : error instanceof Error ? error.message : "上传未完成，请检查目录。" });
      }
    } finally { this.abort = null; if (!this.disposed) this.onSettled(); }
  }
}

import { ApiError, driveApi, type DriveEntry } from "@/lib/api";
import { planDriveUpload, scanDriveDirectory, type DriveDirectoryHandle, type UploadMode, type UploadPlan } from "./drive-upload-plan";
export { planDriveUpload } from "./drive-upload-plan";
export type { UploadMode } from "./drive-upload-plan";

export type UploadPhase = "idle" | "scanning" | "uploading" | "complete" | "failed" | "cancelled";
export type UploadSnapshot = { phase: UploadPhase; mode: UploadMode; total: number; completed: number; directoriesTotal: number; directoriesCompleted: number; current: string; rootId: number | null; rootName: string; message: string; uncertain: boolean };
type UploadAPI = {
  create: (title: string, parent: number | null, personal: boolean, signal: AbortSignal) => Promise<DriveEntry>;
  upload: (file: File, parent: number | null, personal: boolean, signal: AbortSignal) => Promise<DriveEntry>;
};
const initial = (): UploadSnapshot => ({ phase: "idle", mode: "files", total: 0, completed: 0, directoriesTotal: 0, directoriesCompleted: 0, current: "", rootId: null, rootName: "", message: "", uncertain: false });

/** Ignore results from a picker superseded by another selection or navigation. */
export class DirectoryPickerGate {
  private generation = 0;
  invalidate() { this.generation++; }
  choose(picker: () => Promise<DriveDirectoryHandle>, selected: (handle: DriveDirectoryHandle) => void, failed: (error: unknown) => void) {
    const generation = ++this.generation;
    try {
      // Invoke the picker synchronously to retain the browser's user activation.
      void picker().then((handle) => {
        if (generation !== this.generation) return;
        this.invalidate(); selected(handle);
      }, (error: unknown) => {
        if (generation !== this.generation) return;
        this.invalidate(); failed(error);
      });
    } catch (error) {
      if (generation === this.generation) { this.invalidate(); failed(error); }
    }
  }
}

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
  get active() { return this.state.phase === "scanning" || this.state.phase === "uploading"; }
  activate() { this.disposed = false; }
  dismiss() { if (!this.active) this.update(initial()); }
  cancel() { if (this.abort) { this.update({ message: "正在停止…" }); this.abort.abort(); } }
  dispose() { this.disposed = true; this.abort?.abort(); this.listeners.clear(); }
  selectionError(message: string) { if (!this.active && !this.disposed) this.update({ ...initial(), mode: "folder", phase: "failed", message }); }

  async start(files: readonly File[], mode: UploadMode, parent: number | null, personal: boolean): Promise<void> {
    if (this.active || this.disposed) return;
    let plan: UploadPlan;
    try { plan = planDriveUpload(files, mode); }
    catch (error) { this.update({ ...initial(), phase: "failed", mode, message: error instanceof Error ? error.message : "无法读取所选文件。" }); return; }
    const controller = new AbortController(); this.abort = controller;
    await this.run(plan, mode, parent, personal, controller);
  }

  /** Native directory handles include empty directories; no network writes occur while scanning. */
  async startDirectory(handle: DriveDirectoryHandle, parent: number | null, personal: boolean): Promise<void> {
    if (this.active || this.disposed) return;
    const controller = new AbortController(); this.abort = controller;
    this.update({ ...initial(), phase: "scanning", mode: "folder", rootName: handle.name });
    let plan: UploadPlan;
    try { plan = await scanDriveDirectory(handle, controller.signal); }
    catch (error) {
      if (!this.disposed) this.update({ phase: controller.signal.aborted ? "cancelled" : "failed", message: controller.signal.aborted ? "已停止读取，未上传任何内容。" : error instanceof Error ? `读取文件夹失败：${error.message}` : "无法读取文件夹，未上传任何内容。" });
      this.abort = null;
      return;
    }
    if (this.disposed) { this.abort = null; return; }
    await this.run(plan, "folder", parent, personal, controller);
  }

  private async run(plan: UploadPlan, mode: UploadMode, parent: number | null, personal: boolean, controller: AbortController): Promise<void> {
    this.update({ ...initial(), phase: "uploading", mode, total: plan.items.length, directoriesTotal: plan.directories.length, rootName: plan.root });
    let inFlight = false;
    const paths = new Map<string, number>();
    const check = () => { if (controller.signal.aborted) throw new DOMException("cancelled", "AbortError"); };
    const validate = (entry: DriveEntry, kind: "folder" | "file", expectedParent: number | null, expectedTitle: string) => {
      if (!entry || entry.kind !== kind || !Number.isSafeInteger(entry.id) || entry.id <= 0 || entry.parentId !== expectedParent || entry.title !== expectedTitle) throw new Error("服务器返回的数据不完整");
    };
    const ensurePath = async (folders: string[]) => {
      let destination = parent;
      for (let i = 0; i < folders.length; i++) {
        check();
        const path = folders.slice(0, i + 1).join("/");
        const known = paths.get(path);
        if (known !== undefined) { destination = known; continue; }
        this.update({ current: path }); inFlight = true;
        const entry = await this.api.create(folders[i], destination, personal, controller.signal);
        validate(entry, "folder", destination, folders[i]); inFlight = false;
        destination = entry.id; paths.set(path, entry.id);
        this.update({ directoriesCompleted: this.state.directoriesCompleted + 1, ...(i === 0 ? { rootId: entry.id } : {}) });
      }
      return destination;
    };
    try {
      for (const item of plan.items) {
        const destination = await ensurePath(mode === "folder" ? item.parts.slice(0, -1) : []);
        check(); this.update({ current: item.parts.join("/") }); inFlight = true;
        const entry = await this.api.upload(item.file, destination, personal, controller.signal);
        validate(entry, "file", destination, item.file.name); inFlight = false;
        this.update({ completed: this.state.completed + 1 });
      }
      // The native picker includes directories with no files, including an
      // entirely empty root. Existing paths are skipped by ensurePath.
      for (const directory of plan.directories) await ensurePath(directory);
      if (!this.disposed) this.update({ phase: "complete", current: "", message: mode === "folder" ? plan.completeDirectoryTree ? "上传完成，已保留空文件夹；同名目录不会覆盖。" : "上传完成。空文件夹不会上传；同名目录不会覆盖。" : "上传完成。同名文件不会覆盖。" });
    } catch (error) {
      if (!this.disposed) {
        const cancelled = controller.signal.aborted;
        const uncertain = inFlight && (cancelled || !(error instanceof ApiError && error.status >= 400 && error.status < 500));
        this.update({ phase: cancelled ? "cancelled" : "failed", uncertain, message: uncertain ? "当前项目的结果未确认，请先检查目录，避免重复上传。" : cancelled ? "上传已停止，已完成的内容保留在云盘。" : error instanceof Error ? error.message : "上传未完成，请检查目录。" });
      }
    } finally { this.abort = null; if (!this.disposed) this.onSettled(); }
  }
}

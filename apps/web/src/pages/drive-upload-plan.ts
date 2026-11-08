export type UploadMode = "files" | "folder";
export type UploadItem = { file: File; parts: string[] };
export type UploadPlan = { root: string; items: UploadItem[]; directories: string[][]; completeDirectoryTree: boolean };
export const MAX_FILES = 1000;
export const MAX_DIRECTORIES = 1000;
export const MAX_DEPTH = 32;
export const MAX_BYTES = 20 * 1024 * 1024;
const validName = (name: string) => name !== "" && name !== "." && name !== ".." && name.trim() === name && [...name].length <= 100 && !/[\\/\p{Cc}\p{Cs}]/u.test(name);
const invalid = () => new Error("文件或目录名称无效、过长或目录层级过深，尚未开始上传。");
const checkParts = (parts: string[]) => { if (!parts.length || parts.length > MAX_DEPTH || parts.some((part) => !validName(part))) throw invalid(); };
const checkFile = (file: File) => { if (file.size > MAX_BYTES) throw new Error(`「${file.name}」超过 20 MB，尚未开始上传。`); };

/** Validate the complete input selection before creating any remote nodes. */
export function planDriveUpload(files: readonly File[], mode: UploadMode): UploadPlan {
  if (!files.length) throw new Error("没有选择可上传的文件；空文件夹无法通过当前浏览器选择器读取。");
  if (files.length > MAX_FILES) throw new Error(`一次最多上传 ${MAX_FILES} 个文件。`);
  const seen = new Set<string>(), directories = new Map<string, string[]>();
  let root = "";
  const items = files.map((file) => {
    checkFile(file);
    const path = mode === "folder" ? file.webkitRelativePath : file.name;
    const parts = path.split("/");
    if (mode === "folder" && (parts.length < 2 || parts.at(-1) !== file.name)) throw new Error("无法读取完整文件夹路径，尚未开始上传。");
    checkParts(parts);
    if (mode === "folder") { if (!root) root = parts[0]; else if (root !== parts[0]) throw new Error("请一次选择一个文件夹。"); }
    if (seen.has(path)) throw new Error(`存在重复路径「${path}」，尚未开始上传。`);
    seen.add(path);
    for (let i = 1; i < parts.length; i++) directories.set(parts.slice(0, i).join("/"), parts.slice(0, i));
    return { file, parts };
  });
  if (directories.size > MAX_DIRECTORIES) throw new Error(`一次最多上传 ${MAX_DIRECTORIES} 个目录。`);
  for (const path of seen) if (directories.has(path)) throw new Error(`「${path}」同时是文件和文件夹，尚未开始上传。`);
  return { root, items, directories: [...directories.values()], completeDirectoryTree: false };
}

// The browser's directory handle exposes empty directories, unlike FileList.
// Narrow structural types keep the scanner testable without storing handles.
export type DriveDirectoryHandle = { kind: "directory"; name: string; values: () => AsyncIterable<DriveDirectoryHandle | DriveFileHandle> };
export type DriveFileHandle = { kind: "file"; name: string; getFile: () => Promise<File> };

/** Enumerate and validate everything before publishing a single remote node. */
export async function scanDriveDirectory(rootHandle: DriveDirectoryHandle, signal: AbortSignal): Promise<UploadPlan> {
  const check = () => { if (signal.aborted) throw new DOMException("cancelled", "AbortError"); };
  check(); checkParts([rootHandle.name]);
  const directories: string[][] = [[rootHandle.name]], items: UploadItem[] = [];
  const seenDirs = new Set([rootHandle.name]), seenFiles = new Set<string>();
  const stack: { handle: DriveDirectoryHandle; parts: string[] }[] = [{ handle: rootHandle, parts: [rootHandle.name] }];
  while (stack.length) {
    check();
    const current = stack.pop()!;
    for await (const child of current.handle.values()) {
      check();
      const parts = [...current.parts, child.name]; checkParts(parts);
      const path = parts.join("/");
      if (seenDirs.has(path) || seenFiles.has(path)) throw new Error(`存在重复路径「${path}」，尚未开始上传。`);
      if (child.kind === "directory") {
        seenDirs.add(path); directories.push(parts);
        if (directories.length > MAX_DIRECTORIES) throw new Error(`一次最多上传 ${MAX_DIRECTORIES} 个目录。`);
        stack.push({ handle: child, parts });
      } else if (child.kind === "file") {
        seenFiles.add(path);
        if (items.length >= MAX_FILES) throw new Error(`一次最多上传 ${MAX_FILES} 个文件。`);
        const file = await child.getFile(); check(); checkFile(file);
        if (file.name !== child.name) throw new Error("读取的文件名称已变化，尚未开始上传。");
        items.push({ file, parts });
      } else throw new Error("文件夹包含不支持的条目，尚未开始上传。");
    }
  }
  return { root: rootHandle.name, items, directories, completeDirectoryTree: true };
}

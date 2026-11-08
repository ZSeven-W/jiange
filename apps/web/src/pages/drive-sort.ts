import type { DriveEntry } from "@/lib/api";

export type FolderSortField = "created" | "updated" | "name";
export type FolderSortDirection = "asc" | "desc";

/** The personal root may also show shared roots created by this user. */
export function ownRootFolders(personal: readonly DriveEntry[], shared: readonly DriveEntry[], userId: number, includeShared: boolean, query: string): DriveEntry[] {
  const match = (entry: DriveEntry) => entry.kind === "folder" && (!query || (entry.title || "未命名文件夹").toLocaleLowerCase().includes(query));
  const folders = personal.filter(match);
  const ids = new Set(folders.map((entry) => entry.id));
  if (includeShared) for (const entry of shared) {
    if (entry.creatorId === userId && match(entry) && !ids.has(entry.id)) { folders.push(entry); ids.add(entry.id); }
  }
  return folders;
}

/** Sort folders independently from the document list; unknown dates stay last. */
export function sortDriveFolders(entries: readonly DriveEntry[], field: FolderSortField, direction: FolderSortDirection): DriveEntry[] {
  return [...entries].sort((a, b) => {
    if (field === "name") {
      const result = (a.title || "未命名文件夹").localeCompare(b.title || "未命名文件夹", "zh-CN", { numeric: true });
      return (direction === "asc" ? result : -result) || a.id - b.id;
    }
    const left = Date.parse((field === "created" ? a.createdAt : a.updatedAt) || "");
    const right = Date.parse((field === "created" ? b.createdAt : b.updatedAt) || "");
    if (Number.isNaN(left) || Number.isNaN(right)) return Number.isNaN(left) === Number.isNaN(right) ? a.id - b.id : Number.isNaN(left) ? 1 : -1;
    return (direction === "asc" ? left - right : right - left) || a.id - b.id;
  });
}

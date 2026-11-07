import { ApiError } from "@/lib/api";

export type DocumentPermissions = {
  role?: string;
  copyProtected?: boolean;
  copyMinRole?: string;
  downloadMinRole?: string;
  permissionsRevision?: number;
};

const rank = (role?: string): number => role === "view" ? 1 : role === "edit" ? 2 : role === "manage" ? 3 : 0;

/** Access is checked separately from policy; malformed or incomplete new policy fails closed. */
function permits(meta: DocumentPermissions | undefined, field: "copyMinRole" | "downloadMinRole"): boolean {
  if (!meta || !rank(meta.role)) return false;
  const splitPolicy = meta.copyMinRole !== undefined || meta.downloadMinRole !== undefined || meta.permissionsRevision !== undefined;
  if (!splitPolicy) return !meta.copyProtected || meta.role === "manage";
  if (!Number.isSafeInteger(meta.permissionsRevision) || (meta.permissionsRevision as number) < 0) return false;
  if (!rank(meta.copyMinRole) || !rank(meta.downloadMinRole)) return false;
  return rank(meta.role) >= rank(meta[field]);
}

/** UI copy permission; this does not prevent a reader from extracting delivered bytes. */
export function canCopyContent(meta?: DocumentPermissions): boolean { return permits(meta, "copyMinRole"); }
/** Creation of a document copy, Markdown export and file download share this policy. */
export function canDownloadDocument(meta?: DocumentPermissions): boolean { return permits(meta, "downloadMinRole"); }
/** Kept for callers that use "copy" to mean creating a duplicate document. */
export const canCopyDocument = canDownloadDocument;

/** Ignore an older validation response if another metadata result won first. */
export function mayUseDownloadRecheck<T extends DocumentPermissions & { id: number }>(docId: number, before: T | undefined, current: T | undefined, latest: T): boolean {
  return !!before && current === before && latest.id === docId && canDownloadDocument(current) && canDownloadDocument(latest);
}

/** Preserve this account's unsent operations without embedding server content. */
export function pendingDocumentBackup<T>(userId: number, docId: number, clientId: number, ops: T[]) {
  return { version: 1, userId, docId, clientId, state: null, ops };
}

export function copyErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.message) return error.message;
  return "创建副本失败，请检查网络后重试。";
}

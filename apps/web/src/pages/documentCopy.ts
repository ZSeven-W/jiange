import { ApiError, type DocMeta } from "@/lib/api";

/** A view grant permits a copy unless the owner restricted copying. */
export function canCopyDocument(meta?: DocMeta): boolean {
  return !!meta && (meta.role === "view" || meta.role === "edit" || meta.role === "manage")
    && (!meta.copyProtected || meta.role === "manage");
}

export function copyErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.message) return error.message;
  return "创建副本失败，请检查网络后重试。";
}

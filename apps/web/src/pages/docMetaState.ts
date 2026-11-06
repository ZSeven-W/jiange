import { ApiError, type DocMeta } from "@/lib/api";

export type DocMetaState = "loading" | "ready" | "offline" | "retry" | "denied";

/** The API deliberately uses 404 for both nonexistent and unauthorized docs. */
export function isDocAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404);
}

/** Do not reuse document permission metadata from a different signed-in account. */
export function docMetaKey(docId: number, userId: number) {
  return ["doc", docId, userId] as const;
}

/** Retain same-account cached content for temporary network/server errors only. */
export function docMetaState(data: DocMeta | undefined, isError: boolean, error: unknown): DocMetaState {
  if (isError && isDocAccessDenied(error)) return "denied";
  if (isError) return data ? "offline" : "retry";
  return data ? "ready" : "loading";
}

export function shouldRetryDocMeta(failureCount: number, error: unknown): boolean {
  return !isDocAccessDenied(error) && failureCount < 2;
}

import { ApiError, type DocMeta } from "@/lib/api";
import type { QueryClient } from "@tanstack/react-query";

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

/** Retain offline document drafts but never start a document socket for an
 * unverified or non-document resource. Definitive access denial disconnects. */
export function mayConnectDocument(data: DocMeta | undefined, state: DocMetaState): boolean {
  return data?.kind === "doc" && (state === "ready" || state === "offline");
}

export function shouldRetryDocMeta(failureCount: number, error: unknown): boolean {
  return !isDocAccessDenied(error) && failureCount < 2;
}

/** Remove a definitively denied document from session-scoped lists, then
 * refresh them. Cancel older requests first so a stale response cannot put
 * the inaccessible title back; a later successful metadata read wins. */
export async function removeDeniedDocumentReferences(qc: QueryClient, docId: number, stillDenied: () => boolean): Promise<void> {
  const roots = ["docs", "shared", "favorites", "pins", "recent", "search"] as const;
  await Promise.all(roots.map((root) => qc.cancelQueries({ queryKey: [root] })));
  if (!stillDenied()) return;
  for (const root of roots) {
    qc.setQueriesData<unknown>({ queryKey: [root] }, (previous: unknown) => Array.isArray(previous) ? previous.filter((entry) => !entry || typeof entry !== "object" || !("id" in entry) || entry.id !== docId) : previous);
    void qc.invalidateQueries({ queryKey: [root] });
  }
  void qc.invalidateQueries({ queryKey: ["drive"] });
  void qc.invalidateQueries({ queryKey: ["drive-nav"] });
}

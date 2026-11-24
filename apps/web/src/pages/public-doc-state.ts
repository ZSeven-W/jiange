import type { DocView } from "@/lib/api";
import { canCopyContent, canDownloadDocument } from "./document-copy";

export interface PublicSnapshot {
  title: string;
  updatedAt: string;
  copyProtected?: boolean;
  copyMinRole?: string;
  downloadMinRole?: string;
  permissionsRevision?: number;
  /** Validated by the cover renderer; unknown/legacy servers may omit it. */
  cover?: unknown;
  view: DocView;
}

export type PublicIssue = "login" | "expired" | "temporary" | "unsupported_table" | "table_unavailable" | "password_required";
export type PublicOutcome = { snapshot: PublicSnapshot } | { issue: PublicIssue };
export interface PublicDocState {
  token: string;
  snapshot: PublicSnapshot | null;
  issue: PublicIssue | null;
  /** Retry failed image requests when the connection has recovered. */
  recovery: number;
}

export function initialPublicDocState(token: string): PublicDocState {
  return { token, snapshot: null, issue: null, recovery: 0 };
}

/** A stale snapshot remains readable, but never grants copy/download access. */
export function publicDocumentPermissions(state: PublicDocState, token: string, refreshing = false) {
  const meta = state.token === token && state.snapshot && !state.issue && !refreshing ? { ...state.snapshot, role: "view" } : undefined;
  return { copy: canCopyContent(meta), download: canDownloadDocument(meta) };
}

/** A block link shares the existing token, not the document's text. */
export function mayCopyPublicBlockLink(state: PublicDocState, token: string, refreshing: boolean, visible: boolean, blockId: string): boolean {
  return state.token === token && !!state.snapshot && !state.issue && !refreshing && visible && state.snapshot.view.blocks.some((block) => block.id === blockId && block.type !== "title");
}

/** A definitive denial hides stale content; a network failure preserves it. */
export function updatePublicDocState(previous: PublicDocState, token: string, result: PublicOutcome): PublicDocState {
  const current = previous.token === token ? previous : initialPublicDocState(token);
  if ("snapshot" in result) return { token, snapshot: result.snapshot, issue: null, recovery: current.recovery + (current.issue === "temporary" ? 1 : 0) };
  return { token, snapshot: result.issue === "temporary" ? current.snapshot : null, issue: result.issue, recovery: current.recovery };
}

/** Request only the current link; callers ignore a result after unmount. */
export async function fetchPublicDoc(token: string, signal: AbortSignal): Promise<PublicOutcome> {
  try {
    const response = await fetch(`/api/public/${encodeURIComponent(token)}`, { signal, cache: "no-store", credentials: "same-origin" });
    if (response.status === 401) return { issue: "login" };
    if (response.status === 403) {
      const error: unknown = await response.json().catch(() => null);
      if (error && typeof error === "object" && "error" in error && error.error === "password_required") return { issue: "password_required" };
      return { issue: "expired" };
    }
    if (response.status === 404 || response.status === 410) return { issue: "expired" };
    if (response.status === 409) {
      const error: unknown = await response.json().catch(() => null);
      if (error && typeof error === "object" && "error" in error && error.error === "table_unsupported") return { issue: "unsupported_table" };
      if (error && typeof error === "object" && "error" in error && error.error === "table_unavailable") return { issue: "table_unavailable" };
    }
    if (!response.ok) return { issue: "temporary" };
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") return { issue: "temporary" };
    const data = value as Partial<PublicSnapshot>;
    const role = (v: unknown) => v === "view" || v === "edit" || v === "manage";
    const split = data.copyMinRole !== undefined || data.downloadMinRole !== undefined || data.permissionsRevision !== undefined;
    if (typeof data.title !== "string" || typeof data.updatedAt !== "string" || !data.view || !Array.isArray(data.view.blocks) || (data.copyProtected !== undefined && typeof data.copyProtected !== "boolean") || (split && (!role(data.copyMinRole) || !role(data.downloadMinRole) || !Number.isSafeInteger(data.permissionsRevision) || (data.permissionsRevision as number) < 0))) return { issue: "temporary" };
    return { snapshot: data as PublicSnapshot };
  } catch {
    return { issue: "temporary" };
  }
}

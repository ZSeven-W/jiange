import type { DocView } from "@/lib/api";

export interface PublicSnapshot {
  title: string;
  updatedAt: string;
  copyProtected?: boolean;
  view: DocView;
}

export type PublicIssue = "login" | "expired" | "temporary";
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

/** A definitive denial hides stale content; a network failure preserves it. */
export function updatePublicDocState(previous: PublicDocState, token: string, result: PublicOutcome): PublicDocState {
  const current = previous.token === token ? previous : initialPublicDocState(token);
  if ("snapshot" in result) return { token, snapshot: result.snapshot, issue: null, recovery: current.recovery + (current.issue === "temporary" ? 1 : 0) };
  return { token, snapshot: result.issue === "temporary" ? current.snapshot : null, issue: result.issue, recovery: current.recovery };
}

/** Request only the current link; callers ignore a result after unmount. */
export async function fetchPublicDoc(token: string, signal: AbortSignal): Promise<PublicOutcome> {
  try {
    const response = await fetch(`/api/public/${encodeURIComponent(token)}`, { signal, cache: "no-store" });
    if (response.status === 401) return { issue: "login" };
    if (response.status === 403 || response.status === 404 || response.status === 410) return { issue: "expired" };
    if (!response.ok) return { issue: "temporary" };
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") return { issue: "temporary" };
    const data = value as Partial<PublicSnapshot>;
    if (typeof data.title !== "string" || typeof data.updatedAt !== "string" || !data.view || !Array.isArray(data.view.blocks) || (data.copyProtected !== undefined && typeof data.copyProtected !== "boolean")) return { issue: "temporary" };
    return { snapshot: data as PublicSnapshot };
  } catch {
    return { issue: "temporary" };
  }
}

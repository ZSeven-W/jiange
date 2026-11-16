import { ApiError, type BaseRecord } from "@/lib/api";

let nextScope = 0;

/** A per-mount key prevents old cached queries from reappearing on remount. */
export function newBaseQueryScope(): string {
  return `${Date.now()}-${++nextScope}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

/** Invalidate a query when authorization refresh starts or its snapshot changes. */
export class BaseAuthorizationEpoch {
  private id: number | undefined;
  private snapshot: unknown;
  private fetching = false;
  private revision = 0;

  read(id: number, snapshot: unknown, fetching: boolean): number {
    if (this.id !== id) {
      this.id = id;
      this.snapshot = undefined;
      this.fetching = false;
      this.revision++;
    }
    if (snapshot !== this.snapshot || (fetching && !this.fetching)) this.revision++;
    this.snapshot = snapshot;
    this.fetching = fetching;
    return this.revision;
  }
}

/** A query denial hides all cached Base data until a later access check succeeds. */
export class BaseAuthorizationFence {
  private deniedSnapshot: { data: unknown } | null = null;
  private automaticRetryUsed = false;

  observe(snapshot: unknown, confirmed: boolean, refreshing: boolean, denied: boolean, querySucceeded: boolean): boolean {
    if (denied && !this.deniedSnapshot) this.deniedSnapshot = { data: snapshot };
    if (this.deniedSnapshot && !denied && confirmed && !refreshing && snapshot !== this.deniedSnapshot.data) this.deniedSnapshot = null;
    if (querySucceeded && !refreshing) this.automaticRetryUsed = false;
    return !!this.deniedSnapshot || denied;
  }

  takeAutomaticRetry(denied: boolean): boolean {
    if (!denied || this.automaticRetryUsed) return false;
    this.automaticRetryUsed = true;
    return true;
  }
}

/** Query responses supply order/IDs only. Render cells from the authorized snapshot. */
export function authorizedQueryRecords(snapshot: readonly BaseRecord[], query: readonly BaseRecord[]): BaseRecord[] {
  const permitted = new Map(snapshot.map((record) => [record.id, record]));
  const seen = new Set<number>();
  const result: BaseRecord[] = [];
  for (const row of query) {
    const record = permitted.get(row.id);
    if (record && !seen.has(row.id)) { result.push(record); seen.add(row.id); }
  }
  return result;
}

/** Never display a filtered cache during authorization refresh or before query success. */
export function recordsForAuthorizedQuery(snapshot: readonly BaseRecord[], query: readonly BaseRecord[] | undefined, refreshing: boolean, querySucceeded: boolean): BaseRecord[] {
  return !refreshing && querySucceeded && query ? authorizedQueryRecords(snapshot, query) : [];
}

export function isBaseAuthorizationError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404);
}

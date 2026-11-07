import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { ApiError, type BaseRecord } from "@/lib/api";
import { authorizedQueryRecords, BaseAuthorizationEpoch, BaseAuthorizationFence, isBaseAuthorizationError, newBaseQueryScope, recordsForAuthorizedQuery } from "./queryAuthorization";

const row = (id: number, value: string): BaseRecord => ({ id, baseId: 1, position: id, cells: { "1": value } });

describe("base filtered query authorization", () => {
  it("advances the query generation as soon as access refresh starts and when the snapshot changes", () => {
    const epoch = new BaseAuthorizationEpoch();
    const old = { fields: [1], records: [row(1, "old")] };
    const first = epoch.read(1, old, false);
    expect(epoch.read(1, old, false)).toBe(first);
    const pending = epoch.read(1, old, true);
    expect(pending).toBeGreaterThan(first);
    expect(epoch.read(1, old, true)).toBe(pending);
    const fresh = epoch.read(1, { fields: [], records: [] }, false);
    expect(fresh).toBeGreaterThan(pending);
    expect(epoch.read(2, undefined, false)).toBeGreaterThan(fresh);
  });
  it("never renders unpermitted query rows or cells from an older response", () => {
    const snapshot = [row(1, "visible-new"), row(3, "also-visible")];
    const oldQuery = [row(2, "hidden"), row(3, "stale-cell"), row(1, "old-cell"), row(3, "duplicate")];
    const result = authorizedQueryRecords(snapshot, oldQuery);
    expect(result.map((record) => [record.id, record.cells["1"]])).toEqual([[3, "also-visible"], [1, "visible-new"]]);
    expect(result[0]).toBe(snapshot[1]);
    expect(recordsForAuthorizedQuery(snapshot, oldQuery, true, true)).toEqual([]);
    expect(recordsForAuthorizedQuery(snapshot, oldQuery, false, false)).toEqual([]);
    expect(recordsForAuthorizedQuery(snapshot, oldQuery, false, true)).toEqual(result);
  });
  it("keeps a denial fenced until a later successful access snapshot and retries automatically at most once", () => {
    const fence = new BaseAuthorizationFence();
    const before = { role: "edit" }, after = { role: "view" };
    expect(fence.observe(before, true, false, true, false)).toBe(true);
    expect(fence.takeAutomaticRetry(true)).toBe(true);
    expect(fence.takeAutomaticRetry(true)).toBe(false);
    expect(fence.observe(before, true, true, false, false)).toBe(true);
    expect(fence.observe(before, false, false, false, false)).toBe(true);
    expect(fence.observe(after, true, false, false, false)).toBe(false);
    expect(fence.observe(after, true, false, true, false)).toBe(true);
    expect(fence.takeAutomaticRetry(true)).toBe(false);
    expect(fence.observe({ role: "view" }, true, false, false, true)).toBe(false);
    expect(fence.takeAutomaticRetry(true)).toBe(true);
  });
  it("treats rejected authorization separately from invalid filters and isolates remount keys", () => {
    for (const status of [401, 403, 404]) expect(isBaseAuthorizationError(new ApiError(status, "denied", ""))).toBe(true);
    expect(isBaseAuthorizationError(new ApiError(400, "invalid_query", ""))).toBe(false);
    expect(isBaseAuthorizationError(new TypeError("network"))).toBe(false);
    expect(newBaseQueryScope()).not.toBe(newBaseQueryScope());
  });
  it("cancels an old signal-aware filtered request when the snapshot generation changes", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let started = false, aborted = false;
    const queryFn = ({ signal }: { signal: AbortSignal }) => new Promise<BaseRecord[]>((_resolve, reject) => {
      started = true;
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    });
    const observer = new QueryObserver(client, { queryKey: ["base", 1, "query", "mount", 1], queryFn });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      observer.setOptions({ queryKey: ["base", 1, "query", "mount", 2], queryFn, enabled: false });
      await vi.waitFor(() => expect(aborted).toBe(true));
    } finally { unsubscribe(); client.clear(); }
  });
});

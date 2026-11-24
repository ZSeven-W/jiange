import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueOfflineMutation,
  getOfflineSnapshot,
  listOfflineQueue,
  listOfflineSnapshots,
  resetOfflineDbForTesting,
} from "./offline-db";
import {
  loadSheetOfflineCells,
  loadSlidesOfflinePage,
  queueSheetOfflineCells,
  queueSlidesOfflinePage,
  saveDocCollabReplica,
} from "./offline-collab";
import {
  OFFLINE_SNAPSHOT_EVENT,
  cacheQueryResponse,
  flushOfflineQueue,
  getOfflineStateSnapshot,
  installOfflineAutoSync,
  recordVisitedResourceSnapshot,
  refreshOfflineState,
  resetOfflineSyncStateForTesting,
  setOfflineOnlineState,
  subscribeOfflineState,
  useOfflineState,
  type OfflineMutationFetcher,
  type OfflineStateSnapshot,
  type OfflineWindowLike,
} from "./offline-sync";

class MockWindow implements OfflineWindowLike {
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  location = { origin: "https://jiange.example" };
  fetch?: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetch = fetchImpl;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Event = new Event(type)) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

async function flushMicrotasks(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

describe("offline-sync controller", () => {
  beforeEach(async () => {
    await resetOfflineDbForTesting({ indexedDB: null });
    resetOfflineSyncStateForTesting({ online: true });
  });

  afterEach(async () => {
    resetOfflineSyncStateForTesting({ online: true });
    await resetOfflineDbForTesting();
  });

  it("notifies subscribers when snapshots, queue, or online status change", async () => {
    const seen: OfflineStateSnapshot[] = [];
    const unsub = subscribeOfflineState((snap) => seen.push(snap));

    await recordVisitedResourceSnapshot({
      key: "doc:1",
      kind: "doc",
      resourceId: 1,
      title: "产品路线图",
      data: { id: 1, title: "产品路线图" },
    });

    expect(getOfflineStateSnapshot().cachedSnapshots).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(0);

    setOfflineOnlineState(false);
    expect(getOfflineStateSnapshot().online).toBe(false);

    await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 1,
      title: "修改标题",
      method: "PATCH",
      path: "/api/docs/1",
      body: { title: "产品路线图 v2" },
    });
    await refreshOfflineState();
    expect(getOfflineStateSnapshot().pendingQueue).toHaveLength(1);

    unsub();
  });

  it("replays queued mutations in strict FIFO order and removes 2xx / 404 / 410 items", async () => {
    await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 11,
      title: "更新文档 11",
      method: "PATCH",
      path: "/api/docs/11",
      body: { title: "新标题" },
    });
    await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 12,
      title: "删除已不存在的文档 12",
      method: "DELETE",
      path: "/api/docs/12",
    });
    await enqueueOfflineMutation({
      resourceType: "sheet",
      resourceId: 13,
      title: "更新已归档表格 13",
      method: "POST",
      path: "/api/sheets/13/cells",
      body: { cells: [] },
    });

    const calledPaths: string[] = [];
    const fetcher = vi.fn<OfflineMutationFetcher>(async (path, init) => {
      calledPaths.push(`${init.method} ${path}`);
      if (path === "/api/docs/11") return { ok: true, status: 200, statusText: "OK" };
      if (path === "/api/docs/12") return { ok: false, status: 404, statusText: "Not Found" };
      return { ok: false, status: 410, statusText: "Gone" };
    });

    const summary = await flushOfflineQueue(fetcher);

    expect(calledPaths).toEqual([
      "PATCH /api/docs/11",
      "DELETE /api/docs/12",
      "POST /api/sheets/13/cells",
    ]);
    expect(summary.synced).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.remaining).toBe(0);
    expect(await listOfflineQueue()).toEqual([]);
  });

  it("stops replay immediately on first network failure and increments retries + lastError", async () => {
    const m1 = await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 1,
      title: "第一步",
      method: "PATCH",
      path: "/api/docs/1",
      body: { title: "v1" },
    });
    const m2 = await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 2,
      title: "第二步",
      method: "PATCH",
      path: "/api/docs/2",
      body: { title: "v2" },
    });
    const m3 = await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 3,
      title: "第三步",
      method: "PATCH",
      path: "/api/docs/3",
      body: { title: "v3" },
    });

    const fetcher = vi.fn<OfflineMutationFetcher>(async (path) => {
      if (path === "/api/docs/1") return { ok: true, status: 200, statusText: "OK" };
      if (path === "/api/docs/2") throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, statusText: "OK" };
    });

    const summary = await flushOfflineQueue(fetcher);

    expect(summary.synced).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.remaining).toBe(2);
    // m3 must NOT have been attempted after m2 hit a network failure
    expect(fetcher).toHaveBeenCalledTimes(2);

    const remaining = await listOfflineQueue();
    expect(remaining.map((r) => r.id)).toEqual([m2.id, m3.id]);
    expect(remaining[0].retries).toBe(1);
    expect(remaining[0].lastError).toBe("Failed to fetch");
    expect(remaining[1].retries).toBe(0);
    expect(m1.id).not.toBe(remaining[0].id);
  });

  it("keeps transient 5xx failures with incremented retries and preserves per-resource order", async () => {
    const a1 = await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 50,
      title: "文档 50 修改 1",
      method: "PATCH",
      path: "/api/docs/50",
      body: { title: "A" },
    });
    const a2 = await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 50,
      title: "文档 50 修改 2",
      method: "PATCH",
      path: "/api/docs/50",
      body: { title: "B" },
    });
    await enqueueOfflineMutation({
      resourceType: "sheet",
      resourceId: 88,
      title: "表格 88 修改",
      method: "POST",
      path: "/api/sheets/88/cells",
      body: { cells: [] },
    });

    const fetcher = vi.fn<OfflineMutationFetcher>(async (path) => {
      if (path === "/api/docs/50") {
        return { ok: false, status: 503, statusText: "Service Unavailable" };
      }
      return { ok: true, status: 200, statusText: "OK" };
    });

    const summary = await flushOfflineQueue(fetcher);
    expect(summary.synced).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.remaining).toBe(2);
    // Second edit to doc 50 must be skipped in this pass while independent sheet 88 succeeds
    expect(fetcher).toHaveBeenCalledTimes(2);

    const remaining = await listOfflineQueue();
    expect(remaining.map((r) => r.id)).toEqual([a1.id, a2.id]);
    expect(remaining[0].retries).toBe(1);
    expect(remaining[0].lastError).toBe("HTTP 503 Service Unavailable");
    expect(remaining[1].retries).toBe(0);
  });

  it("skips flushing while offline without calling fetcher", async () => {
    setOfflineOnlineState(false);
    await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 9,
      title: "离线草稿",
      method: "PATCH",
      path: "/api/docs/9",
      body: { title: "草稿" },
    });
    const fetcher = vi.fn<OfflineMutationFetcher>();
    const summary = await flushOfflineQueue(fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(summary.synced).toBe(0);
    expect(summary.remaining).toBe(1);
  });

  it("cacheQueryResponse caches docs list, recent list, doc snapshots, and sheet snapshots while blocking sensitive paths", async () => {
    await cacheQueryResponse("/api/docs", { docs: [{ id: 1, title: "欢迎文档" }] });
    await cacheQueryResponse("/api/recent", { docs: [{ id: 1, title: "欢迎文档", viewedAt: "2026-11-24T09:00:00Z" }] });
    await cacheQueryResponse("/api/docs/1", {
      id: 1,
      title: "欢迎文档",
      blocks: [{ id: "b1", type: "paragraph", spans: [{ text: "正文内容", marks: {} }] }],
    });
    // Subsequent metadata-only refresh must NOT wipe out previously cached blocks!
    await cacheQueryResponse("/api/docs/1", {
      id: 1,
      title: "欢迎文档（已更新）",
      creatorName: "Alice",
    });
    await cacheQueryResponse("/api/sheets/5", {
      nodeId: 5,
      title: "销售报表",
      sheets: [],
    });

    // Sensitive endpoints MUST be ignored
    expect(await cacheQueryResponse("/api/me/tokens", { tokens: [{ rawToken: "secret" }] })).toBeNull();
    expect(await cacheQueryResponse("/api/me/mfa", { enabled: true })).toBeNull();
    expect(await cacheQueryResponse("/api/auth/login", { user: { id: 1 } })).toBeNull();
    expect(await cacheQueryResponse("/api/workspaces/1/webhooks", { webhooks: [] })).toBeNull();

    const docSnap = await getOfflineSnapshot("doc:1");
    expect(docSnap?.title).toBe("欢迎文档（已更新）");
    expect((docSnap?.data as { blocks?: unknown[] }).blocks).toHaveLength(1);
    expect((docSnap?.data as { creatorName?: string }).creatorName).toBe("Alice");

    expect((await getOfflineSnapshot("list:docs"))?.kind).toBe("list");
    expect((await getOfflineSnapshot("list:recent"))?.kind).toBe("list");
    expect((await getOfflineSnapshot("sheet:5"))?.title).toBe("销售报表");
    expect(await listOfflineSnapshots()).toHaveLength(4);
  });

  it("installOfflineAutoSync flushes on online, captures snapshot broadcasts, passively caches safe GET fetch, and cleans up", async () => {
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/docs/77")) {
        return new Response(JSON.stringify({ id: 77, title: "自动缓存文档" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/me/tokens")) {
        return new Response(JSON.stringify({ tokens: [{ id: 1, rawToken: "secret" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const win = new MockWindow(baseFetch);
    const replayFetcher = vi.fn<OfflineMutationFetcher>(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
    }));

    const uninstall = installOfflineAutoSync({
      window: win,
      navigator: { onLine: false },
      fetcher: replayFetcher,
    });

    expect(getOfflineStateSnapshot().online).toBe(false);

    // 1. Passive fetch caches safe GET /api/docs/77, ignores /api/me/tokens
    await win.fetch!("/api/docs/77");
    await win.fetch!("/api/me/tokens");
    await flushMicrotasks(10);
    expect((await getOfflineSnapshot("doc:77"))?.title).toBe("自动缓存文档");
    expect(await listOfflineSnapshots()).toHaveLength(1);

    // 2. Custom snapshot event caches visited resource
    win.dispatch(
      OFFLINE_SNAPSHOT_EVENT,
      new CustomEvent(OFFLINE_SNAPSHOT_EVENT, {
        detail: {
          key: "sheet:99",
          kind: "sheet",
          resourceId: 99,
          title: "财务台账",
          data: { nodeId: 99, title: "财务台账", sheets: [] },
        },
      }),
    );
    await flushMicrotasks(10);
    expect((await getOfflineSnapshot("sheet:99"))?.title).toBe("财务台账");

    // 3. Queue mutation while offline, then trigger online event -> auto-flushes!
    await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 77,
      title: "离线编辑",
      method: "PATCH",
      path: "/api/docs/77",
      body: { title: "恢复后同步" },
    });
    win.dispatch("online");
    await flushMicrotasks(12);

    expect(getOfflineStateSnapshot().online).toBe(true);
    expect(replayFetcher).toHaveBeenCalledTimes(1);
    expect(await listOfflineQueue()).toEqual([]);

    // 4. Uninstall cleanly removes listeners and restores original fetch
    uninstall();
    expect(win.listenerCount("online")).toBe(0);
    expect(win.listenerCount("offline")).toBe(0);
    expect(win.listenerCount(OFFLINE_SNAPSHOT_EVENT)).toBe(0);
    expect(win.fetch).toBe(baseFetch);
  });

  it("useOfflineState renders cleanly in SSR and exposes the complete state & action surface", () => {
    let captured: ReturnType<typeof useOfflineState> | null = null;
    function Probe() {
      captured = useOfflineState();
      return createElement("span", null, captured.online ? "online" : "offline");
    }

    const html = renderToStaticMarkup(createElement(Probe));
    expect(html).toBe("<span>online</span>");
    expect(captured).not.toBeNull();
    expect(typeof captured!.syncNow).toBe("function");
    expect(typeof captured!.removeSnapshot).toBe("function");
    expect(typeof captured!.clearCache).toBe("function");
    expect(typeof captured!.removeQueuedItem).toBe("function");
    expect(Array.isArray(captured!.cachedSnapshots)).toBe(true);
    expect(Array.isArray(captured!.pendingQueue)).toBe(true);
    expect(captured!.offlineCollabCount).toBe(0);
  });

  it("tracks offlineCollabCount and flushes queued sheet & slides collab deltas during flushOfflineQueue / online reconnect", async () => {
    await saveDocCollabReplica(1, 42, {
      snapshot: new Uint8Array([1, 2, 3]),
      seq: 5,
      historyEpoch: 1,
      pendingOpsCount: 2,
    });
    await queueSheetOfflineCells(1, 7, {
      worksheetId: 10,
      baseRevision: 1,
      edits: [{ row: 0, col: 0, raw: "离线数值", updatedAt: 1000 }],
    });
    await queueSlidesOfflinePage(1, 9, {
      pageId: 101,
      shapesJson: JSON.stringify([{ id: "s1", kind: "rectangle" }]),
      baseRevision: 2,
      updatedAt: 2000,
    });

    await refreshOfflineState();
    const before = getOfflineStateSnapshot();
    expect(before.offlineCollabCount).toBe(3);
    expect(before.offlineCollabSummary).toEqual({
      totalCount: 3,
      docReplicaCount: 1,
      docPendingOpsCount: 2,
      sheetDeltaCount: 1,
      sheetEditCount: 1,
      slidesDraftCount: 1,
      pendingMergeCount: 3,
    });

    const called: string[] = [];
    const fetcher = vi.fn<OfflineMutationFetcher>(async (path, init) => {
      called.push(`${init.method} ${path}`);
      return { ok: true, status: 200, statusText: "OK" };
    });

    const summary = await flushOfflineQueue(fetcher);
    expect(called).toEqual([
      "POST /api/sheets/7/cells",
      "PATCH /api/slides/9/pages/101/content",
    ]);
    expect(summary.synced).toBe(2);
    expect(summary.collabFlushed).toBe(2);
    expect(summary.collabFailed).toBe(0);
    expect(summary.collabConflicts).toEqual([]);
    expect(summary.remaining).toBe(0);

    expect(await loadSheetOfflineCells(1, 7)).toBeNull();
    expect(await loadSlidesOfflinePage(1, 9)).toBeNull();
    // Doc CRDT replica remains cached for offline hydration
    expect(getOfflineStateSnapshot().offlineCollabCount).toBe(1);
  });
});

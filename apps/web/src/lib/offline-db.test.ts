import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_OFFLINE_SNAPSHOT_BYTES,
  MAX_OFFLINE_SNAPSHOTS,
  OFFLINE_COLLAB_STORE,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_QUEUE_STORE,
  OFFLINE_SNAPSHOTS_STORE,
  cacheOfflineSnapshot,
  clearOfflineCollabRecords,
  clearOfflineQueue,
  clearOfflineSnapshots,
  deleteOfflineCollabRecord,
  deleteOfflineSnapshot,
  enqueueOfflineMutation,
  getOfflineCollabRecord,
  getOfflineSnapshot,
  isCacheableOfflinePath,
  listOfflineCollabRecords,
  listOfflineQueue,
  listOfflineSnapshots,
  offlineStorageStats,
  putOfflineCollabRecord,
  removeOfflineMutation,
  resetOfflineDbForTesting,
  subscribeOfflineDbChanges,
  updateOfflineMutationError,
} from "./offline-db";

/**
 * Lightweight faithful IDBFactory mock for testing the IndexedDB code path
 * in plain Node without external dependencies.
 */
function createMockIdbFactory() {
  const stores = new Map<string, Map<string, unknown>>();
  const createdIndexes: Array<{ store: string; name: string; keyPath: string }> = [];
  let openedName = "";
  let openedVersion = 0;

  function makeRequest<T>(executor: () => T): IDBRequest<T> {
    const req = {} as {
      result: T;
      error: DOMException | null;
      onsuccess: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
      onerror: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
    };
    queueMicrotask(() => {
      try {
        req.result = executor();
        req.onsuccess?.call(req as unknown as IDBRequest<T>, new Event("success"));
      } catch (err) {
        req.error = err as DOMException;
        req.onerror?.call(req as unknown as IDBRequest<T>, new Event("error"));
      }
    });
    return req as unknown as IDBRequest<T>;
  }

  const fakeDb = {
    objectStoreNames: {
      contains: (name: string) => stores.has(name),
    },
    createObjectStore: (name: string) => {
      if (!stores.has(name)) {
        stores.set(name, new Map());
      }
      return {
        createIndex: (indexName: string, keyPath: string) => {
          createdIndexes.push({ store: name, name: indexName, keyPath });
        },
      };
    },
    transaction: (storeName: string, _mode: IDBTransactionMode) => {
      const map = stores.get(storeName);
      if (!map) {
        throw new Error(`Missing object store: ${storeName}`);
      }
      const tx: Partial<IDBTransaction> = {
        objectStore: () =>
          ({
            get: (key: string) => makeRequest(() => structuredClone(map.get(key))),
            getAll: () =>
              makeRequest(() => Array.from(map.values(), (val) => structuredClone(val))),
            put: (value: Record<string, unknown>) => {
              const keyField = storeName === OFFLINE_QUEUE_STORE ? "id" : "key";
              const key = String(value[keyField]);
              return makeRequest(() => {
                map.set(key, structuredClone(value));
                return key;
              });
            },
            delete: (key: string) =>
              makeRequest(() => {
                map.delete(key);
                return undefined;
              }),
            clear: () =>
              makeRequest(() => {
                map.clear();
                return undefined;
              }),
          }) as unknown as IDBObjectStore,
      };
      queueMicrotask(() => {
        queueMicrotask(() => {
          tx.oncomplete?.call(tx as IDBTransaction, new Event("complete"));
        });
      });
      return tx as IDBTransaction;
    },
    close: vi.fn(),
    onversionchange: null as ((ev: Event) => void) | null,
  };

  const factory = {
    open: vi.fn((name: string, version?: number) => {
      openedName = name;
      openedVersion = version ?? 1;
      const req = {
        result: fakeDb as unknown as IDBDatabase,
      } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => {
        req.onupgradeneeded?.call(req, { target: req } as unknown as IDBVersionChangeEvent);
        req.onsuccess?.call(req, new Event("success"));
      });
      return req;
    }),
  } as unknown as IDBFactory;

  return {
    factory,
    stores,
    createdIndexes,
    getOpenedMeta: () => ({ name: openedName, version: openedVersion }),
  };
}

describe("isCacheableOfflinePath security guard", () => {
  it("allows safe workspace content endpoints", () => {
    const allowed = [
      "/api/docs",
      "/api/docs/42",
      "/api/docs/42?include=meta",
      "/api/docs/42/account-metadata",
      "/api/recent",
      "/api/favorites",
      "/api/pins",
      "/api/sheets/9",
      "/api/sheets/9/cells",
      "/api/bases/3",
      "/api/bases/3?tableId=7",
      "/api/slides/12/pages",
      "/api/drive/children?parent=5",
      "/api/wiki/spaces/4",
      "https://jiange.example/api/docs/100",
    ];
    for (const p of allowed) {
      expect(isCacheableOfflinePath(p), `expected ${p} to be cacheable`).toBe(true);
    }
  });

  it("strictly blocks auth, MFA, PAT tokens, SSO, webhooks, secrets, and malformed paths", () => {
    const blocked = [
      "/api/me/tokens",
      "/api/me/tokens/15",
      "/api/me/tokens?active=1",
      "/api/me/mfa",
      "/api/me/mfa/setup",
      "/api/me/mfa/enable",
      "/api/me/mfa/disable",
      "/api/auth/login",
      "/api/auth/register",
      "/api/auth/logout",
      "/api/auth/mfa/verify",
      "/api/auth/sso/providers",
      "/api/sso/login",
      "/api/workspaces/1/webhooks",
      "/api/workspaces/1/webhooks/7",
      "/api/workspaces/1/webhooks/7/secret",
      "/api/workspaces/1/webhooks/7/deliveries",
      "/api/workspaces/1/sso/providers",
      "/api/workspaces/1/org-sync/sources",
      "/api/docs/42/share-password",
      "/api/me//tokens",
      "/api/%61uth/login",
      "/api/me/%6dfa",
      "/api/docs/../auth/login",
      "/api",
      "/",
      "",
      "/assets/index.js",
      "javascript:alert(1)",
      "ws://jiange.example/api/sync/doc/1",
    ];
    for (const p of blocked) {
      expect(isCacheableOfflinePath(p), `expected ${p} to be blocked`).toBe(false);
    }
  });
});

describe("offline-db in-memory fallback (when indexedDB is unavailable)", () => {
  beforeEach(async () => {
    await resetOfflineDbForTesting({ indexedDB: null });
  });

  afterEach(async () => {
    await resetOfflineDbForTesting();
  });

  it("supports snapshot CRUD and reports memory backend stats", async () => {
    const saved = await cacheOfflineSnapshot({
      key: "doc:42",
      kind: "doc",
      resourceId: 42,
      title: "季度产品规划",
      data: { id: 42, title: "季度产品规划", blocks: [{ id: "b1", type: "paragraph", text: "Hello" }] },
      updatedAt: 1000,
    });

    expect(saved).not.toBeNull();
    expect(saved?.key).toBe("doc:42");
    expect(saved?.sizeBytes).toBeGreaterThan(0);

    const fetched = await getOfflineSnapshot("doc:42");
    expect(fetched).toEqual(saved);

    await cacheOfflineSnapshot({
      key: "sheet:7",
      kind: "sheet",
      resourceId: 7,
      title: "Q4 预算表",
      data: { nodeId: 7, title: "Q4 预算表", sheets: [] },
      updatedAt: 2000,
    });

    // Most recently updated first
    const list = await listOfflineSnapshots();
    expect(list.map((s) => s.key)).toEqual(["sheet:7", "doc:42"]);

    const stats = await offlineStorageStats();
    expect(stats.backend).toBe("memory");
    expect(stats.snapshotCount).toBe(2);
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.maxSnapshots).toBe(MAX_OFFLINE_SNAPSHOTS);
    expect(stats.maxBytes).toBe(MAX_OFFLINE_SNAPSHOT_BYTES);

    await deleteOfflineSnapshot("doc:42");
    expect(await getOfflineSnapshot("doc:42")).toBeNull();
    expect((await listOfflineSnapshots()).map((s) => s.key)).toEqual(["sheet:7"]);

    await clearOfflineSnapshots();
    expect(await listOfflineSnapshots()).toEqual([]);
  });

  it("prunes oldest snapshots automatically when exceeding max 50 entries (LRU)", async () => {
    for (let i = 1; i <= 55; i++) {
      await cacheOfflineSnapshot({
        key: `doc:${i}`,
        kind: "doc",
        resourceId: i,
        title: `文档 ${i}`,
        data: { id: i },
        updatedAt: 10_000 + i,
      });
    }

    const list = await listOfflineSnapshots();
    expect(list).toHaveLength(MAX_OFFLINE_SNAPSHOTS);
    // Oldest 5 (1..5) should have been pruned; newest 50 (6..55) retained
    expect(await getOfflineSnapshot("doc:1")).toBeNull();
    expect(await getOfflineSnapshot("doc:5")).toBeNull();
    expect(await getOfflineSnapshot("doc:6")).not.toBeNull();
    expect(await getOfflineSnapshot("doc:55")).not.toBeNull();
  });

  it("prunes oldest snapshots automatically when exceeding 16 MB total cap", async () => {
    const sixMb = 6 * 1024 * 1024;
    await cacheOfflineSnapshot({
      key: "doc:old",
      kind: "doc",
      resourceId: 1,
      title: "旧大文档",
      data: { stub: 1 },
      updatedAt: 1000,
      sizeBytes: sixMb,
    });
    await cacheOfflineSnapshot({
      key: "doc:mid",
      kind: "doc",
      resourceId: 2,
      title: "中大文档",
      data: { stub: 2 },
      updatedAt: 2000,
      sizeBytes: sixMb,
    });
    await cacheOfflineSnapshot({
      key: "doc:new",
      kind: "doc",
      resourceId: 3,
      title: "新大文档",
      data: { stub: 3 },
      updatedAt: 3000,
      sizeBytes: sixMb,
    });

    const stats = await offlineStorageStats();
    expect(stats.totalBytes).toBeLessThanOrEqual(MAX_OFFLINE_SNAPSHOT_BYTES);
    expect(await getOfflineSnapshot("doc:old")).toBeNull();
    expect(await getOfflineSnapshot("doc:mid")).not.toBeNull();
    expect(await getOfflineSnapshot("doc:new")).not.toBeNull();

    // Rejects a single snapshot larger than 16 MB without evicting valid entries
    const oversized = await cacheOfflineSnapshot({
      key: "doc:huge",
      kind: "doc",
      title: "超大文件",
      data: {},
      sizeBytes: MAX_OFFLINE_SNAPSHOT_BYTES + 1,
    });
    expect(oversized).toBeNull();
    expect(await getOfflineSnapshot("doc:new")).not.toBeNull();
  });

  it("refuses caching sensitive snapshot keys or paths", async () => {
    expect(
      await cacheOfflineSnapshot({
        key: "/api/me/tokens",
        kind: "list",
        title: "Tokens",
        data: { tokens: [] },
      }),
    ).toBeNull();
    expect(
      await cacheOfflineSnapshot({
        key: "/api/me/mfa",
        kind: "list",
        title: "MFA",
        data: { enabled: true },
      }),
    ).toBeNull();
    expect(
      await cacheOfflineSnapshot({
        key: "/api/workspaces/1/webhooks",
        kind: "list",
        title: "Webhooks",
        data: {},
      }),
    ).toBeNull();
    expect(await listOfflineSnapshots()).toEqual([]);
  });

  it("maintains strict FIFO mutation queue order, strips sensitive headers, and tracks retries/errors", async () => {
    const listener = vi.fn();
    const unsub = subscribeOfflineDbChanges(listener);

    const m1 = await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 10,
      title: "更新标题",
      method: "PATCH",
      path: "/api/docs/10",
      body: { title: "新标题" },
      headers: {
        "X-Jiange-User-Id": "7",
        Authorization: "Bearer secret-should-strip",
        Cookie: "session=secret",
      },
    });
    const m2 = await enqueueOfflineMutation({
      resourceType: "sheet",
      resourceId: 20,
      title: "写入单元格",
      method: "POST",
      path: "/api/sheets/20/cells",
      body: { cells: [] },
    });

    expect(m1.headers).toEqual({ "X-Jiange-User-Id": "7" });
    expect(m1.retries).toBe(0);

    const queue = await listOfflineQueue();
    expect(queue.map((q) => q.id)).toEqual([m1.id, m2.id]);

    const errored = await updateOfflineMutationError(m1.id, "HTTP 503 Service Unavailable");
    expect(errored?.retries).toBe(1);
    expect(errored?.lastError).toBe("HTTP 503 Service Unavailable");

    await removeOfflineMutation(m1.id);
    expect((await listOfflineQueue()).map((q) => q.id)).toEqual([m2.id]);

    await clearOfflineQueue();
    expect(await listOfflineQueue()).toEqual([]);

    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(4);
    unsub();
  });

  it("refuses to enqueue mutations targeting sensitive auth/token/mfa/webhook paths", async () => {
    await expect(
      enqueueOfflineMutation({
        resourceType: "other",
        title: "Create PAT",
        method: "POST",
        path: "/api/me/tokens",
        body: { name: "ci" },
      }),
    ).rejects.toThrow();

    await expect(
      enqueueOfflineMutation({
        resourceType: "other",
        title: "Login",
        method: "POST",
        path: "/api/auth/login",
        body: { email: "a@b.com", password: "secret" },
      }),
    ).rejects.toThrow();
  });

  it("falls back transparently to memory when indexedDB.open throws SecurityError", async () => {
    const brokenIdb = {
      open: () => {
        throw new Error("SecurityError: storage disabled in private mode");
      },
    } as unknown as IDBFactory;

    await resetOfflineDbForTesting({ indexedDB: brokenIdb });

    await cacheOfflineSnapshot({
      key: "doc:private-mode",
      kind: "doc",
      title: "隐私模式文档",
      data: { ok: true },
    });
    const stats = await offlineStorageStats();
    expect(stats.backend).toBe("memory");
    expect(stats.snapshotCount).toBe(1);
  });

  it("supports collab_replicas CRUD, kind filtering, and security key guards in memory mode", async () => {
    await putOfflineCollabRecord({
      key: "doc:1:42",
      kind: "doc",
      userId: 1,
      docId: 42,
      snapshotBase64: "AQID",
      seq: 7,
      historyEpoch: 1,
      role: "edit",
      updatedAt: 1000,
      pendingOpsCount: 2,
    });
    await putOfflineCollabRecord({
      key: "sheet:1:9",
      kind: "sheet",
      userId: 1,
      sheetId: 9,
      worksheetId: 1,
      edits: [{ row: 0, col: 0, raw: "42", updatedAt: 2000 }],
      baseRevision: 3,
      updatedAt: 2000,
    });

    // Sensitive key must be rejected
    expect(
      await putOfflineCollabRecord({
        key: "auth:tokens:1",
        kind: "doc",
        userId: 1,
        docId: 99,
        snapshotBase64: "AA==",
        seq: 0,
        historyEpoch: null,
        role: "edit",
        updatedAt: 3000,
        pendingOpsCount: 0,
      }),
    ).toBeNull();

    const docRec = await getOfflineCollabRecord("doc:1:42");
    expect(docRec?.kind).toBe("doc");
    expect((await listOfflineCollabRecords()).map((r) => r.key)).toEqual(["sheet:1:9", "doc:1:42"]);
    expect((await listOfflineCollabRecords("doc")).map((r) => r.key)).toEqual(["doc:1:42"]);
    expect((await offlineStorageStats()).collabCount).toBe(2);

    await deleteOfflineCollabRecord("doc:1:42");
    expect(await getOfflineCollabRecord("doc:1:42")).toBeNull();

    await clearOfflineCollabRecords("sheet");
    expect(await listOfflineCollabRecords()).toEqual([]);
  });
});

describe("offline-db IndexedDB backend integration", () => {
  afterEach(async () => {
    await resetOfflineDbForTesting();
  });

  it("opens jiange-offline-v1 (v2) with snapshots, queue & collab_replicas stores and persists records end-to-end", async () => {
    const mock = createMockIdbFactory();
    await resetOfflineDbForTesting({ indexedDB: mock.factory });

    await cacheOfflineSnapshot({
      key: "doc:101",
      kind: "doc",
      resourceId: 101,
      title: "离线架构设计",
      data: { id: 101, title: "离线架构设计" },
      updatedAt: 5000,
    });
    const queued = await enqueueOfflineMutation({
      resourceType: "doc",
      resourceId: 101,
      title: "离线架构设计 · 重命名",
      method: "PATCH",
      path: "/api/docs/101",
      body: { title: "离线架构设计 v2" },
    });
    await putOfflineCollabRecord({
      key: "doc:7:101",
      kind: "doc",
      userId: 7,
      docId: 101,
      snapshotBase64: "AQIDBA==",
      seq: 12,
      historyEpoch: 2,
      role: "edit",
      updatedAt: 6000,
      pendingOpsCount: 1,
    });

    expect(mock.getOpenedMeta()).toEqual({ name: OFFLINE_DB_NAME, version: OFFLINE_DB_VERSION });
    expect(mock.stores.has(OFFLINE_SNAPSHOTS_STORE)).toBe(true);
    expect(mock.stores.has(OFFLINE_QUEUE_STORE)).toBe(true);
    expect(mock.stores.has(OFFLINE_COLLAB_STORE)).toBe(true);
    expect(mock.createdIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ store: OFFLINE_SNAPSHOTS_STORE, name: "by_updatedAt" }),
        expect.objectContaining({ store: OFFLINE_QUEUE_STORE, name: "by_createdAt" }),
        expect.objectContaining({ store: OFFLINE_COLLAB_STORE, name: "by_updatedAt" }),
        expect.objectContaining({ store: OFFLINE_COLLAB_STORE, name: "by_kind" }),
        expect.objectContaining({ store: OFFLINE_COLLAB_STORE, name: "by_userId" }),
      ]),
    );

    const stats = await offlineStorageStats();
    expect(stats.backend).toBe("indexeddb");
    expect(stats.snapshotCount).toBe(1);
    expect(stats.queueCount).toBe(1);
    expect(stats.collabCount).toBe(1);

    expect((await getOfflineSnapshot("doc:101"))?.title).toBe("离线架构设计");
    expect((await listOfflineQueue()).map((item) => item.id)).toEqual([queued.id]);
    expect((await getOfflineCollabRecord("doc:7:101"))?.key).toBe("doc:7:101");
    expect((await listOfflineCollabRecords("doc")).map((item) => item.key)).toEqual(["doc:7:101"]);

    await updateOfflineMutationError(queued.id, "NetworkError");
    expect((await listOfflineQueue())[0].retries).toBe(1);

    await deleteOfflineSnapshot("doc:101");
    await removeOfflineMutation(queued.id);
    await deleteOfflineCollabRecord("doc:7:101");
    expect(await listOfflineSnapshots()).toEqual([]);
    expect(await listOfflineQueue()).toEqual([]);
    expect(await listOfflineCollabRecords()).toEqual([]);
  });
});

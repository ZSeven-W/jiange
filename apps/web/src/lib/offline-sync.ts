import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import {
  cacheOfflineSnapshot,
  clearOfflineSnapshots,
  deleteOfflineSnapshot,
  enqueueOfflineMutation,
  getOfflineSnapshot,
  isCacheableOfflinePath,
  listOfflineQueue,
  listOfflineSnapshots,
  removeOfflineMutation,
  subscribeOfflineDbChanges,
  updateOfflineMutationError,
  type CacheOfflineSnapshotInput,
  type EnqueueOfflineMutationInput,
  type OfflineMutation,
  type OfflineSnapshot,
  type OfflineSnapshotKind,
} from "./offline-db";

import {
  flushAllOfflineCollab,
  getOfflineCollabSummary,
  type OfflineCollabConflict,
  type OfflineCollabSummary,
} from "./offline-collab";

export const OFFLINE_SNAPSHOT_EVENT = "jiange:offline-snapshot";
export const OFFLINE_ENQUEUE_EVENT = "jiange:offline-enqueue";

export interface OfflineSyncSummary {
  synced: number;
  failed: number;
  remaining: number;
  completedAt: number;
  collabFlushed?: number;
  collabFailed?: number;
  collabConflicts?: OfflineCollabConflict[];
}

export interface OfflineStateSnapshot {
  online: boolean;
  cachedSnapshots: OfflineSnapshot[];
  pendingQueue: OfflineMutation[];
  /** Count of locally persisted offline CRDT replicas and Sheet/Slides offline deltas. */
  offlineCollabCount: number;
  /** Detailed breakdown of offline CRDT replicas and pending collab deltas. */
  offlineCollabSummary?: OfflineCollabSummary;
  syncing: boolean;
  lastSyncSummary: OfflineSyncSummary | null;
}

export interface OfflineStateHookValue extends OfflineStateSnapshot {
  syncNow: () => Promise<OfflineSyncSummary>;
  removeSnapshot: (key: string) => Promise<void>;
  clearCache: () => Promise<void>;
  removeQueuedItem: (id: string) => Promise<void>;
}

export type OfflineMutationFetcher = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "statusText">>;

export interface OfflineWindowLike {
  addEventListener: EventTarget["addEventListener"];
  removeEventListener: EventTarget["removeEventListener"];
  location?: { origin?: string };
  fetch?: typeof fetch;
}

export interface InstallOfflineAutoSyncOptions {
  /** Override global `window` (primarily for tests). */
  window?: OfflineWindowLike | null;
  /** Override global `navigator` (primarily for tests). */
  navigator?: { onLine?: boolean } | null;
  /** Optional custom fetch implementation used when auto-flushing queued mutations. */
  fetcher?: OfflineMutationFetcher;
  /** Passively cache safe GET JSON responses for docs/recent/sheets/bases/slides (defaults to `true`). */
  interceptFetch?: boolean;
}

function readNavigatorOnline(nav?: { onLine?: boolean } | null): boolean {
  const target = nav !== undefined ? nav : typeof navigator !== "undefined" ? navigator : null;
  if (target && typeof target.onLine === "boolean") {
    return target.onLine;
  }
  return true;
}

const EMPTY_COLLAB_SUMMARY: OfflineCollabSummary = {
  totalCount: 0,
  docReplicaCount: 0,
  docPendingOpsCount: 0,
  sheetDeltaCount: 0,
  sheetEditCount: 0,
  slidesDraftCount: 0,
  pendingMergeCount: 0,
};

let state: OfflineStateSnapshot = {
  online: readNavigatorOnline(),
  cachedSnapshots: [],
  pendingQueue: [],
  offlineCollabCount: 0,
  offlineCollabSummary: { ...EMPTY_COLLAB_SUMMARY },
  syncing: false,
  lastSyncSummary: null,
};

const stateListeners = new Set<(snapshot: OfflineStateSnapshot) => void>();
let activeFlushPromise: Promise<OfflineSyncSummary> | null = null;
let pendingRefreshPromise: Promise<OfflineStateSnapshot> | null = null;
let installedUninstall: (() => void) | null = null;
let installedWindowRef: OfflineWindowLike | null = null;

function emitState(): void {
  const current = state;
  for (const listener of stateListeners) {
    try {
      listener(current);
    } catch {
      // keep subscriber callbacks isolated
    }
  }
}

function setState(patch: Partial<OfflineStateSnapshot>): void {
  state = { ...state, ...patch };
  emitState();
}

/**
 * Subscribe to any change in offline snapshots, queued mutations, sync progress, or online status.
 */
export function subscribeOfflineState(
  listener: (snapshot: OfflineStateSnapshot) => void,
): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/**
 * Synchronous read of the latest cached offline state snapshot.
 */
export function getOfflineStateSnapshot(): OfflineStateSnapshot {
  return state;
}

/**
 * Reload snapshots and pending mutation queue from IndexedDB and notify subscribers.
 */
export async function refreshOfflineState(): Promise<OfflineStateSnapshot> {
  const run = async () => {
    const [cachedSnapshots, pendingQueue, offlineCollabSummary] = await Promise.all([
      listOfflineSnapshots(),
      listOfflineQueue(),
      getOfflineCollabSummary(),
    ]);
    setState({
      cachedSnapshots,
      pendingQueue,
      offlineCollabCount: offlineCollabSummary.totalCount,
      offlineCollabSummary,
    });
    return state;
  };
  pendingRefreshPromise = run().finally(() => {
    pendingRefreshPromise = null;
  });
  return pendingRefreshPromise;
}

// Keep reactive offline state synchronized whenever offline-db mutates directly.
subscribeOfflineDbChanges(() => {
  void refreshOfflineState();
});

export function setOfflineOnlineState(online: boolean): void {
  if (state.online === online) return;
  setState({ online });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractString(obj: unknown, key: string): string | null {
  if (!isRecord(obj)) return null;
  const val = obj[key];
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
}

interface ParsedCacheRoute {
  key: string;
  kind: OfflineSnapshotKind;
  resourceId?: number;
  fallbackTitle: string;
  isVersionPreview?: boolean;
}

function normalizeRoutePathname(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  try {
    const parsed = trimmed.startsWith("/")
      ? new URL(trimmed, "https://jiange.local")
      : new URL(trimmed);
    return parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
}

function parseCacheableRoute(path: string): ParsedCacheRoute | null {
  if (!isCacheableOfflinePath(path)) return null;
  const pathname = normalizeRoutePathname(path);
  if (!pathname) return null;

  if (pathname === "/api/docs") {
    return { key: "list:docs", kind: "list", fallbackTitle: t("全部文档") };
  }
  if (pathname === "/api/recent") {
    return { key: "list:recent", kind: "list", fallbackTitle: t("最近访问") };
  }
  if (pathname === "/api/favorites" || pathname === "/api/account-favorites") {
    return { key: "list:favorites", kind: "list", fallbackTitle: t("我的收藏") };
  }

  const docMatch = /^\/api\/docs\/(\d+)(?:\/account-metadata)?$/.exec(pathname);
  if (docMatch) {
    const id = Number(docMatch[1]);
    if (Number.isSafeInteger(id) && id > 0) {
      return { key: `doc:${id}`, kind: "doc", resourceId: id, fallbackTitle: t("未命名文档") };
    }
  }

  const docVersionMatch = /^\/api\/docs\/(\d+)\/versions\/(\d+)$/.exec(pathname);
  if (docVersionMatch) {
    const id = Number(docVersionMatch[1]);
    if (Number.isSafeInteger(id) && id > 0) {
      return {
        key: `doc:${id}`,
        kind: "doc",
        resourceId: id,
        fallbackTitle: t("未命名文档"),
        isVersionPreview: true,
      };
    }
  }

  const sheetMatch = /^\/api\/sheets\/(\d+)$/.exec(pathname);
  if (sheetMatch) {
    const id = Number(sheetMatch[1]);
    if (Number.isSafeInteger(id) && id > 0) {
      return { key: `sheet:${id}`, kind: "sheet", resourceId: id, fallbackTitle: t("未命名电子表格") };
    }
  }

  const baseMatch = /^\/api\/bases\/(\d+)(?:\/account-snapshot)?$/.exec(pathname);
  if (baseMatch) {
    const id = Number(baseMatch[1]);
    if (Number.isSafeInteger(id) && id > 0) {
      return { key: `base:${id}`, kind: "base", resourceId: id, fallbackTitle: t("未命名多维表格") };
    }
  }

  const slidesMatch = /^\/api\/slides\/(\d+)\/pages$/.exec(pathname);
  if (slidesMatch) {
    const id = Number(slidesMatch[1]);
    if (Number.isSafeInteger(id) && id > 0) {
      return {
        key: `slides:${id}`,
        kind: "slides",
        resourceId: id,
        fallbackTitle: `${t("幻灯片")} #${id}`,
      };
    }
  }

  return null;
}

function mergeDocData(existingData: unknown, incomingData: unknown): unknown {
  if (!isRecord(existingData) || !isRecord(incomingData)) {
    return incomingData;
  }
  const merged: Record<string, unknown> = { ...existingData, ...incomingData };
  // Preserve previously cached rich blocks/content when a metadata-only refresh arrives.
  if (incomingData.blocks === undefined && existingData.blocks !== undefined) {
    merged.blocks = existingData.blocks;
  }
  if (incomingData.view === undefined && existingData.view !== undefined) {
    merged.view = existingData.view;
  }
  if (incomingData.content === undefined && existingData.content !== undefined) {
    merged.content = existingData.content;
  }
  if (incomingData.markdown === undefined && existingData.markdown !== undefined) {
    merged.markdown = existingData.markdown;
  }
  return merged;
}

function extractSnapshotTitle(
  route: ParsedCacheRoute,
  payload: unknown,
  existingTitle?: string,
): string {
  if (route.kind === "list") {
    return route.fallbackTitle;
  }
  const directTitle = extractString(payload, "title");
  if (directTitle) return directTitle;

  if (isRecord(payload)) {
    const nested =
      extractString(payload.doc, "title") ??
      extractString(payload.base, "title") ??
      extractString(payload.sheet, "title") ??
      extractString(payload.meta, "title");
    if (nested) return nested;
  }

  if (existingTitle && existingTitle.trim().length > 0) {
    return existingTitle;
  }
  return route.fallbackTitle;
}

/**
 * Lightweight helper that automatically caches workspace doc lists (`/api/docs`),
 * recent lists (`/api/recent`), favorites, document snapshots (`/api/docs/{id}`),
 * sheet snapshots (`/api/sheets/{id}`), base snapshots (`/api/bases/{id}`), and
 * slides pages (`/api/slides/{id}/pages`) into IndexedDB.
 *
 * Strictly enforces `isCacheableOfflinePath(path)` before writing anything.
 */
export async function cacheQueryResponse(
  path: string,
  payload: unknown,
): Promise<OfflineSnapshot | null> {
  if (payload === null || payload === undefined) {
    return null;
  }
  const route = parseCacheableRoute(path);
  if (!route) {
    return null;
  }

  try {
    const existing =
      route.kind === "doc" || route.kind === "slides"
        ? await getOfflineSnapshot(route.key)
        : null;

    let dataToStore: unknown = payload;
    if (route.kind === "doc") {
      if (route.isVersionPreview && isRecord(payload) && isRecord(payload.view)) {
        dataToStore = mergeDocData(existing?.data, { view: payload.view, blocks: payload.view.blocks });
      } else {
        dataToStore = mergeDocData(existing?.data, payload);
      }
    }

    const title = extractSnapshotTitle(route, payload, existing?.title);
    const saved = await cacheOfflineSnapshot({
      key: route.key,
      kind: route.kind,
      resourceId: route.resourceId,
      title,
      data: dataToStore,
    });
    if (saved) {
      await refreshOfflineState();
    }
    return saved;
  } catch {
    return null;
  }
}

/**
 * Explicitly cache a rich resource snapshot (e.g. a document with its live blocks
 * or a sheet snapshot) and immediately refresh subscribers.
 */
export async function recordVisitedResourceSnapshot(
  input: CacheOfflineSnapshotInput,
): Promise<OfflineSnapshot | null> {
  try {
    let data = input.data;
    if (input.kind === "doc") {
      const existing = await getOfflineSnapshot(input.key);
      if (existing) {
        data = mergeDocData(existing.data, input.data);
      }
    }
    const saved = await cacheOfflineSnapshot({ ...input, data });
    if (saved) {
      await refreshOfflineState();
    }
    return saved;
  } catch {
    return null;
  }
}

/**
 * Broadcast a resource snapshot via `window` custom event so any page or module can
 * feed the offline cache without tightly coupling to IndexedDB.
 */
export function dispatchVisitedResourceSnapshot(input: CacheOfflineSnapshotInput): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<CacheOfflineSnapshotInput>(OFFLINE_SNAPSHOT_EVENT, { detail: input }));
}

function buildReplayHeaders(item: OfflineMutation): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(item.headers ?? {}) };
  if (item.body !== undefined) {
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
    if (!hasContentType) {
      headers["Content-Type"] = "application/json";
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Replays queued offline mutations sequentially in strict FIFO order when online.
 * - Removes succeeded (`2xx`) and stale (`404`/`410`) entries.
 * - Keeps transient `5xx`/HTTP error and network failure entries with incremented `retries` + `lastError`.
 * - Stops replay immediately on the first network failure (and skips dependent same-resource
 *   mutations after a `5xx`) so causal order is preserved.
 */
export async function flushOfflineQueue(
  fetcher?: OfflineMutationFetcher,
  options?: { forceOnline?: boolean },
): Promise<OfflineSyncSummary> {
  if (activeFlushPromise) {
    return activeFlushPromise;
  }

  const run = async (): Promise<OfflineSyncSummary> => {
    const online = options?.forceOnline ?? state.online;
    const [initialQueue, initialCollab] = await Promise.all([
      listOfflineQueue(),
      getOfflineCollabSummary(),
    ]);
    const initialCollabDeltas = initialCollab.sheetDeltaCount + initialCollab.slidesDraftCount;

    if (!online) {
      const summary: OfflineSyncSummary = {
        synced: 0,
        failed: 0,
        remaining: initialQueue.length + initialCollabDeltas,
        completedAt: Date.now(),
        collabFlushed: 0,
        collabFailed: 0,
        collabConflicts: [],
      };
      setState({
        pendingQueue: initialQueue,
        offlineCollabCount: initialCollab.totalCount,
        offlineCollabSummary: initialCollab,
      });
      return summary;
    }

    if (initialQueue.length === 0 && initialCollabDeltas === 0) {
      const summary: OfflineSyncSummary = {
        synced: 0,
        failed: 0,
        remaining: 0,
        completedAt: Date.now(),
        collabFlushed: 0,
        collabFailed: 0,
        collabConflicts: [],
      };
      setState({
        pendingQueue: [],
        offlineCollabCount: initialCollab.totalCount,
        offlineCollabSummary: initialCollab,
        lastSyncSummary: summary,
      });
      return summary;
    }

    const effectiveFetcher: OfflineMutationFetcher | undefined =
      fetcher ?? (typeof fetch === "function" ? (fetch as OfflineMutationFetcher) : undefined);

    if (!effectiveFetcher) {
      const summary: OfflineSyncSummary = {
        synced: 0,
        failed: 0,
        remaining: initialQueue.length + initialCollabDeltas,
        completedAt: Date.now(),
        collabFlushed: 0,
        collabFailed: 0,
        collabConflicts: [],
      };
      return summary;
    }

    setState({
      syncing: true,
      pendingQueue: initialQueue,
      offlineCollabCount: initialCollab.totalCount,
      offlineCollabSummary: initialCollab,
    });

    let synced = 0;
    let failed = 0;
    let collabFlushed = 0;
    let collabFailed = 0;
    let collabConflicts: OfflineCollabConflict[] = [];
    let networkAborted = false;
    const failedResourceKeys = new Set<string>();

    try {
      for (const item of initialQueue) {
        const resourceKey =
          item.resourceId !== undefined ? `${item.resourceType}:${item.resourceId}` : null;
        if (resourceKey && failedResourceKeys.has(resourceKey)) {
          continue;
        }

        const headers = buildReplayHeaders(item);
        const init: RequestInit = {
          method: item.method,
          credentials: "same-origin",
          ...(headers ? { headers } : {}),
          ...(item.body !== undefined ? { body: JSON.stringify(item.body) } : {}),
        };

        try {
          const response = await effectiveFetcher(item.path, init);
          if (response.ok || response.status === 404 || response.status === 410) {
            await removeOfflineMutation(item.id);
            synced += 1;
          } else {
            const statusText = response.statusText?.trim() ? ` ${response.statusText.trim()}` : "";
            await updateOfflineMutationError(item.id, `HTTP ${response.status}${statusText}`);
            failed += 1;
            if (resourceKey) {
              failedResourceKeys.add(resourceKey);
            }
          }
        } catch (err) {
          const message =
            err instanceof Error && err.message ? err.message : "Network request failed";
          await updateOfflineMutationError(item.id, message);
          failed += 1;
          networkAborted = true;
          // Stop replay immediately on first network failure to preserve strict FIFO order.
          break;
        }
      }

      if (!networkAborted && initialCollabDeltas > 0) {
        const collabResult = await flushAllOfflineCollab(effectiveFetcher);
        collabFlushed = collabResult.flushed;
        collabFailed = collabResult.failed;
        collabConflicts = collabResult.conflicts;
        synced += collabFlushed;
        failed += collabFailed;
      }

      const [cachedSnapshots, pendingQueue, offlineCollabSummary] = await Promise.all([
        listOfflineSnapshots(),
        listOfflineQueue(),
        getOfflineCollabSummary(),
      ]);
      const remainingCollab =
        offlineCollabSummary.sheetDeltaCount + offlineCollabSummary.slidesDraftCount;
      const summary: OfflineSyncSummary = {
        synced,
        failed,
        remaining: pendingQueue.length + remainingCollab,
        completedAt: Date.now(),
        collabFlushed,
        collabFailed,
        collabConflicts,
      };
      setState({
        syncing: false,
        cachedSnapshots,
        pendingQueue,
        offlineCollabCount: offlineCollabSummary.totalCount,
        offlineCollabSummary,
        lastSyncSummary: summary,
      });
      return summary;
    } catch {
      const [cachedSnapshots, pendingQueue, offlineCollabSummary] = await Promise.all([
        listOfflineSnapshots(),
        listOfflineQueue(),
        getOfflineCollabSummary(),
      ]);
      const remainingCollab =
        offlineCollabSummary.sheetDeltaCount + offlineCollabSummary.slidesDraftCount;
      const summary: OfflineSyncSummary = {
        synced,
        failed,
        remaining: pendingQueue.length + remainingCollab,
        completedAt: Date.now(),
        collabFlushed,
        collabFailed,
        collabConflicts,
      };
      setState({
        syncing: false,
        cachedSnapshots,
        pendingQueue,
        offlineCollabCount: offlineCollabSummary.totalCount,
        offlineCollabSummary,
        lastSyncSummary: summary,
      });
      return summary;
    }
  };

  activeFlushPromise = run().finally(() => {
    activeFlushPromise = null;
  });
  return activeFlushPromise;
}

function resolveFetchRequestInfo(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  winOrigin: string,
): { method: string; pathname: string; sameOrigin: boolean } | null {
  let rawUrl = "";
  let method = (init?.method ?? "").toUpperCase();

  if (typeof input === "string") {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.toString();
  } else if (input && typeof input === "object" && "url" in input) {
    rawUrl = String(input.url);
    if (!method && typeof input.method === "string") {
      method = input.method.toUpperCase();
    }
  } else {
    return null;
  }

  if (!method) method = "GET";
  if (!rawUrl) return null;

  try {
    const base = winOrigin || "https://jiange.local";
    const parsed = new URL(rawUrl, base);
    const sameOrigin = !winOrigin || parsed.origin === winOrigin;
    return { method, pathname: parsed.pathname, sameOrigin };
  } catch {
    return null;
  }
}

/**
 * Installs global offline auto-sync listeners once:
 * - Reacts to `window` `"online"` / `"offline"` events and auto-flushes the FIFO queue when reconnected.
 * - Listens to `"jiange:offline-snapshot"` and `"jiange:offline-enqueue"` broadcasts.
 * - Passively caches safe same-origin GET JSON responses for docs, recent lists, sheets, bases, and slides.
 *
 * Returns an idempotent uninstall/cleanup function.
 */
export function installOfflineAutoSync(options?: InstallOfflineAutoSyncOptions): () => void {
  const win =
    options && "window" in options
      ? options.window
      : typeof window !== "undefined"
        ? (window as unknown as OfflineWindowLike)
        : null;
  const nav =
    options && "navigator" in options
      ? options.navigator
      : typeof navigator !== "undefined"
        ? navigator
        : null;

  setOfflineOnlineState(readNavigatorOnline(nav));
  void refreshOfflineState();

  if (!win) {
    return () => {};
  }

  if (installedUninstall && installedWindowRef === win) {
    return installedUninstall;
  }

  const handleOnline = () => {
    setOfflineOnlineState(true);
    void flushOfflineQueue(options?.fetcher, { forceOnline: true });
  };

  const handleOffline = () => {
    setOfflineOnlineState(false);
  };

  const handleSnapshotBroadcast = (event: Event) => {
    const detail = (event as CustomEvent<CacheOfflineSnapshotInput | undefined>).detail;
    if (!detail || typeof detail.key !== "string" || typeof detail.kind !== "string") {
      return;
    }
    void recordVisitedResourceSnapshot(detail);
  };

  const handleEnqueueBroadcast = (event: Event) => {
    const detail = (event as CustomEvent<EnqueueOfflineMutationInput | undefined>).detail;
    if (!detail || typeof detail.path !== "string" || typeof detail.method !== "string") {
      return;
    }
    void enqueueOfflineMutation(detail)
      .then(() => refreshOfflineState())
      .catch(() => {});
  };

  win.addEventListener("online", handleOnline);
  win.addEventListener("offline", handleOffline);
  win.addEventListener(OFFLINE_SNAPSHOT_EVENT, handleSnapshotBroadcast);
  win.addEventListener(OFFLINE_ENQUEUE_EVENT, handleEnqueueBroadcast);

  const shouldInterceptFetch = options?.interceptFetch !== false;
  const originalFetch = shouldInterceptFetch && typeof win.fetch === "function" ? win.fetch : null;
  let wrappedFetch: typeof fetch | null = null;

  if (originalFetch) {
    const winOrigin = win.location?.origin ?? "";
    wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await originalFetch.call(win, input, init);
      try {
        const info = resolveFetchRequestInfo(input, init, winOrigin);
        if (
          info &&
          info.sameOrigin &&
          info.method === "GET" &&
          response.ok &&
          response.status === 200 &&
          parseCacheableRoute(info.pathname) !== null
        ) {
          const contentType = response.headers?.get?.("content-type") ?? "";
          if (!contentType || contentType.toLowerCase().includes("application/json")) {
            const clone = typeof response.clone === "function" ? response.clone() : null;
            if (clone) {
              void clone
                .json()
                .then((payload) => cacheQueryResponse(info.pathname, payload))
                .catch(() => {});
            }
          }
        }
      } catch {
        // Passive caching must never interfere with normal fetch responses.
      }
      return response;
    }) as typeof fetch;

    win.fetch = wrappedFetch;
  }

  let active = true;
  const uninstall = () => {
    if (!active) return;
    active = false;
    win.removeEventListener("online", handleOnline);
    win.removeEventListener("offline", handleOffline);
    win.removeEventListener(OFFLINE_SNAPSHOT_EVENT, handleSnapshotBroadcast);
    win.removeEventListener(OFFLINE_ENQUEUE_EVENT, handleEnqueueBroadcast);
    if (originalFetch && wrappedFetch && win.fetch === wrappedFetch) {
      win.fetch = originalFetch;
    }
    if (installedWindowRef === win) {
      installedUninstall = null;
      installedWindowRef = null;
    }
  };

  installedUninstall = uninstall;
  installedWindowRef = win;
  return uninstall;
}

/**
 * Test helper to reset module-level reactive state and uninstall any active listeners.
 */
export function resetOfflineSyncStateForTesting(options?: { online?: boolean }): void {
  if (installedUninstall) {
    installedUninstall();
  }
  installedUninstall = null;
  installedWindowRef = null;
  activeFlushPromise = null;
  pendingRefreshPromise = null;
  state = {
    online: options?.online ?? readNavigatorOnline(),
    cachedSnapshots: [],
    pendingQueue: [],
    offlineCollabCount: 0,
    offlineCollabSummary: { ...EMPTY_COLLAB_SUMMARY },
    syncing: false,
    lastSyncSummary: null,
  };
  emitState();
}

/**
 * React hook subscribing to live offline cache snapshots, queued mutations, sync state,
 * and online connectivity, exposing direct management actions.
 */
export function useOfflineState(): OfflineStateHookValue {
  const [snapshot, setSnapshot] = useState<OfflineStateSnapshot>(() => getOfflineStateSnapshot());

  useEffect(() => {
    setSnapshot(getOfflineStateSnapshot());
    const unsub = subscribeOfflineState((next) => {
      setSnapshot(next);
    });
    void refreshOfflineState();
    return unsub;
  }, []);

  const syncNow = useCallback(async (): Promise<OfflineSyncSummary> => {
    return flushOfflineQueue();
  }, []);

  const removeSnapshot = useCallback(async (key: string): Promise<void> => {
    await deleteOfflineSnapshot(key);
    await refreshOfflineState();
  }, []);

  const clearCache = useCallback(async (): Promise<void> => {
    await clearOfflineSnapshots();
    await refreshOfflineState();
  }, []);

  const removeQueuedItem = useCallback(async (id: string): Promise<void> => {
    await removeOfflineMutation(id);
    await refreshOfflineState();
  }, []);

  return {
    ...snapshot,
    syncNow,
    removeSnapshot,
    clearCache,
    removeQueuedItem,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SyncClient, type Peer, type SyncMode, type SyncStatus } from "@zseven-w/collab";
import type { Presence } from "./presence";
import { pendingSessionQueue, prepareBrowserPendingSession, writePendingOps, type PendingSession } from "./pending-ops-storage";
import { loadDocCollabReplica, saveDocCollabReplica } from "./offline-collab";

export const OFFLINE_REPLICA_SAVE_DEBOUNCE_MS = 500;

export interface RemotePeer {
  clientId: number;
  state: Presence;
}

export interface SyncDoc {
  client: SyncClient;
  /** Bumped on every content change; read it to re-render. */
  version: number;
  /** Synchronous change counter for guarding selections across an overlay. */
  getChangeRevision: () => number;
  status: SyncStatus;
  peers: RemotePeer[];
  ready: boolean;
  /** Current connection has received the contiguous history through welcome's head. */
  caughtUp: boolean;
  /** The server rejected a write; pending operations are retained for retry. */
  blocked: string | null;
  storageError: boolean;
  legacyPending: boolean;
  otherPending: boolean;
  /** True when the live CRDT replica was hydrated from a locally cached offline snapshot. */
  offlineHydrated: boolean;
  /** Count of local CRDT ops waiting to be acknowledged by the server. */
  pendingOpsCount: number;
  /** Editors register to capture caret anchors before remote ops land. */
  onBeforeRemote: (fn: () => void) => () => void;
}

export interface DebouncedSaver {
  schedule: () => void;
  flush: () => void;
  cancel: () => void;
}

/** Creates a lightweight debouncer with explicit flush/cancel for IndexedDB CRDT snapshot writes. */
export function createDebouncedReplicaSaver(
  save: () => void | Promise<unknown>,
  delayMs = OFFLINE_REPLICA_SAVE_DEBOUNCE_MS,
): DebouncedSaver {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  const run = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!dirty) return;
    dirty = false;
    try {
      const result = save();
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        void (result as Promise<unknown>).catch(() => {});
      }
    } catch {
      // keep offline persistence isolated from editor updates
    }
  };

  return {
    schedule() {
      dirty = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(run, delayMs);
    },
    flush() {
      run();
    },
    cancel() {
      dirty = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/** Persists the current binary CRDT snapshot of `client` into IndexedDB (`collab_replicas`). */
export async function persistSyncClientSnapshot(
  client: SyncClient,
  userId: number,
  docId: number,
  role?: "view" | "edit" | "manage",
): Promise<boolean> {
  if (
    !client.doc ||
    client.blocked === "table_unsupported" ||
    client.blocked === "projection_unavailable" ||
    client.blocked === "protocol_incompatible"
  ) {
    return false;
  }
  const snapshot = client.exportSnapshot();
  if (!snapshot || snapshot.byteLength === 0) return false;

  const effectiveRole: "view" | "edit" | "manage" =
    client.syncMode === "view" || role === "view"
      ? "view"
      : role === "manage"
        ? "manage"
        : "edit";

  const saved = await saveDocCollabReplica(userId, docId, {
    snapshot,
    seq: client.lastSeq,
    historyEpoch: client.epoch,
    role: effectiveRole,
    clientId: client.clientId > 0 ? client.clientId : undefined,
    pendingOpsCount: client.unacked,
  });
  return saved !== null;
}

/**
 * Loads a cached binary CRDT snapshot from IndexedDB and hydrates `client`
 * when disconnected so offline reading & editing can continue seamlessly.
 */
export async function hydrateSyncClientFromOfflineCache(
  client: SyncClient,
  userId: number,
  docId: number,
  role?: "view" | "edit" | "manage",
): Promise<boolean> {
  if (client.doc || client.blocked === "table_unsupported") return false;
  try {
    const replica = await loadDocCollabReplica(userId, docId);
    if (!replica || client.doc) return false;
    const mode: SyncMode =
      role === "view" || (!role && replica.role === "view") ? "view" : "edit";
    return client.hydrateOffline(replica.snapshot, {
      seq: replica.seq,
      historyEpoch: replica.historyEpoch,
      mode,
      clientId: replica.clientId,
    });
  } catch {
    return false;
  }
}

export interface SyncSocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: Event) => unknown) | null;
  send: (data: Uint8Array) => void;
  close: () => void;
}

export interface SyncConnectionOptions {
  client: SyncClient;
  userId: number;
  docId: number;
  getRole: () => "view" | "edit" | "manage" | undefined;
  onSocketChange?: (sock: SyncSocketLike | null) => void;
  onDisconnectInvalidate?: () => void;
  createSocket?: (url: string) => SyncSocketLike;
  url?: string;
  isOnline?: () => boolean;
  eventTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
}

function isBrowserOnline(): boolean {
  return typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
    ? true
    : navigator.onLine;
}

function syncURL() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/sync?protocol=3`;
}

/**
 * Starts the WebSocket sync loop with automatic offline CRDT snapshot hydration
 * when offline or when the initial socket closes before `welcome`.
 */
export function startSyncDocConnection(options: SyncConnectionOptions): () => void {
  const {
    client,
    userId,
    docId,
    getRole,
    onSocketChange,
    onDisconnectInvalidate,
    createSocket = (url) => new WebSocket(url) as unknown as SyncSocketLike,
    isOnline = isBrowserOnline,
    eventTarget = typeof window !== "undefined" ? window : undefined,
  } = options;

  let ws: SyncSocketLike | null = null;
  let stopped = false;
  let hydrating = false;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tryHydrateOffline = () => {
    if (stopped || hydrating || client.doc || client.blocked === "table_unsupported") return;
    hydrating = true;
    void hydrateSyncClientFromOfflineCache(client, userId, docId, getRole()).finally(() => {
      hydrating = false;
    });
  };

  const connect = () => {
    if (stopped || client.blocked === "table_unsupported") return;
    if (!isOnline()) {
      tryHydrateOffline();
      return;
    }

    let sock: SyncSocketLike;
    try {
      sock = createSocket(options.url ?? syncURL());
    } catch {
      tryHydrateOffline();
      if (!stopped && isOnline()) {
        timer = setTimeout(connect, delay + Math.random() * 300);
        delay = Math.min(delay * 2, 5000);
      }
      return;
    }

    sock.binaryType = "arraybuffer";
    ws = sock;
    onSocketChange?.(sock);

    sock.onopen = () => {
      if (stopped || ws !== sock) {
        sock.close();
        return;
      }
      delay = 1000;
      const openState = typeof WebSocket !== "undefined" ? WebSocket.OPEN : 1;
      client.open((b) => sock.readyState === openState && sock.send(b));
    };

    sock.onmessage = (e) => {
      if (stopped || ws !== sock) return;
      try {
        client.receive(new Uint8Array(e.data as ArrayBuffer));
      } catch (err) {
        console.error("sync receive", err);
        sock.close();
      }
    };

    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      onSocketChange?.(null);
      client.close();
      // If the socket closed before receiving a server snapshot/welcome, fall back to IndexedDB CRDT hydration.
      if (!stopped && !client.doc) {
        tryHydrateOffline();
      }
      // Revocation can close the socket without a protocol error; re-check
      // metadata so a previously editable page becomes read-only.
      if (!stopped) onDisconnectInvalidate?.();
      if (!stopped && client.blocked !== "table_unsupported" && isOnline()) {
        timer = setTimeout(connect, delay + Math.random() * 300);
      }
      delay = Math.min(delay * 2, 5000);
    };
  };

  connect();

  const online = () => {
    const closedState = typeof WebSocket !== "undefined" ? WebSocket.CLOSED : 3;
    const closingState = typeof WebSocket !== "undefined" ? WebSocket.CLOSING : 2;
    if (!ws || ws.readyState === closedState || ws.readyState === closingState) {
      clearTimeout(timer);
      connect();
    }
  };
  // the browser knows it lost the network before TCP does: drop the socket now
  // so edits queue locally and the UI shows offline; they are resent on reconnect
  const offline = () => {
    ws?.close();
    tryHydrateOffline();
  };

  eventTarget?.addEventListener("online", online);
  eventTarget?.addEventListener("offline", offline);

  return () => {
    stopped = true;
    clearTimeout(timer);
    eventTarget?.removeEventListener("online", online);
    eventTarget?.removeEventListener("offline", offline);
    const s = ws;
    ws = null;
    onSocketChange?.(null);
    s?.close();
    client.close();
  };
}

/** Opens a live replica of a document over the Jiange sync protocol, reconnecting with backoff. */
export function useSyncDoc(docId: number, userId: number, enabled = true, role?: "view" | "edit" | "manage"): SyncDoc {
  const qc = useQueryClient();
  const [version, setVersion] = useState(0);
  const changeRevision = useRef(0);
  const getChangeRevision = useCallback(() => changeRevision.current, []);
  const [, setStatusRevision] = useState(0);
  const [, setCatchUpRevision] = useState(0);
  const [, setBlockedRevision] = useState(0);
  const [storageError, setStorageError] = useState(false);
  const [legacyPending, setLegacyPending] = useState(false);
  const [otherPending, setOtherPending] = useState(false);
  const [storageClient, setStorageClient] = useState<SyncClient | null>(null);
  const persist = useRef<(client: SyncClient) => void>(() => {});
  const scheduleReplicaSave = useRef<(client: SyncClient) => void>(() => {});
  const roleRef = useRef(role);
  roleRef.current = role;
  const socket = useRef<SyncSocketLike | null>(null);
  const [peers, setPeers] = useState<RemotePeer[]>([]);
  const before = useRef(new Set<() => void>());

  const client = useMemo(
    () => {
      const c = new SyncClient(docId, {
        beforeRemote: () => before.current.forEach((fn) => fn()),
        change: (remote) => {
          changeRevision.current++;
          persist.current(c);
          // Persist live online snapshots & local offline edits; skip echoing an unchanged hydration frame.
          if (!remote || !c.offlineHydrated) {
            scheduleReplicaSave.current(c);
          }
          setVersion((v) => v + 1);
        },
        status: (nextStatus) => {
          if (nextStatus === "synced") scheduleReplicaSave.current(c);
          setStatusRevision((revision) => revision + 1);
        },
        caughtUp: (isCaughtUp) => {
          if (isCaughtUp) scheduleReplicaSave.current(c);
          setCatchUpRevision((revision) => revision + 1);
        },
        blocked: () => { persist.current(c); setBlockedRevision((revision) => revision + 1); },
        peers: (ps: Peer[]) => setPeers(ps.filter((p) => p.state && typeof p.state === "object") as RemotePeer[]),
        error: (code, msg) => {
          console.warn("sync", code, msg);
          if (code === "gap" || (c.blocked && code !== "missing_dependency" && code !== "invalid_history" && code !== "history_changed")) socket.current?.close();
          if (code === "read_only" || code === "forbidden" || code === "not_found") void qc.invalidateQueries({ queryKey: ["doc", docId] });
        },
      }, { requireMode: true });
      return c;
    },
    [docId, userId, qc],
  );

  // offline durability: unacknowledged local ops + binary CRDT replica survive reloads
  useEffect(() => {
    let stopped = false;
    let pending: PendingSession | null = null;
    // StrictMode and quick navigation may remount before the old Web Lock is
    // actually released. Wait for the same account/document's prior lifetime.
    const lifetime = pendingSessionQueue.reserve(userId, docId), finish = lifetime.release;
    setStorageError(false);
    setLegacyPending(false);
    setOtherPending(false);
    const replicaSaver = createDebouncedReplicaSaver(() => {
      if (stopped) return;
      return persistSyncClientSnapshot(client, userId, docId, roleRef.current);
    });
    scheduleReplicaSave.current = (candidate) => {
      if (candidate === client) replicaSaver.schedule();
    };
    const save = () => {
      if (!pending) return;
      try {
        const ops = client.pendingOps();
        writePendingOps(localStorage, pending.key, ops.length ? { clientId: client.clientId, ops, blocked: client.rejection ?? client.blocked, historyEpoch: client.pendingHistoryEpoch } : null);
      } catch { setStorageError(true); }
    };
    const flushAll = () => {
      save();
      replicaSaver.flush();
    };
    const random = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
    const failed = () => { if (!stopped) { setStorageError(true); setStorageClient(client); } };
    const prepared = (result: PendingSession) => {
      pending = result;
      setLegacyPending(result.legacy);
      setOtherPending(result.otherDrafts);
      if (result.corrupt) setStorageError(true);
      if (result.draft?.ops.length && !client.doc) client.restore(result.draft.clientId, result.draft.ops, result.draft.blocked, result.draft.historyEpoch);
      persist.current = (candidate) => { if (candidate === client) save(); };
      setStorageClient(client);
    };
    void (async () => {
      await lifetime.ready.catch(() => {});
      if (stopped) { finish(); return; }
      let acquired: PendingSession | null = null;
      try {
        acquired = await prepareBrowserPendingSession(() => ({ local: window.localStorage, session: window.sessionStorage, locks: navigator.locks }), userId, docId, random);
        if (stopped) { await acquired.release(); finish(); return; }
        prepared(acquired);
      } catch { if (acquired) { await acquired.release(); pending = null; } failed(); finish(); }
    })();
    const id = setInterval(save, 1000); // remove successfully acknowledged batches
    window.addEventListener("beforeunload", flushAll);
    return () => {
      clearInterval(id);
      window.removeEventListener("beforeunload", flushAll);
      save();
      replicaSaver.flush();
      replicaSaver.cancel();
      stopped = true;
      if (pending) void pending.release().finally(finish);
      persist.current = () => {};
      scheduleReplicaSave.current = () => {};
    };
  }, [client, docId, userId]);

  useEffect(() => {
    if (!enabled || storageClient !== client) return;
    return startSyncDocConnection({
      client,
      userId,
      docId,
      getRole: () => roleRef.current,
      onSocketChange: (sock) => {
        socket.current = sock;
      },
      onDisconnectInvalidate: () => {
        void qc.invalidateQueries({ queryKey: ["doc", docId] });
      },
    });
  }, [client, docId, userId, qc, storageClient, enabled]);

  const onBeforeRemote = useMemo(
    () => (fn: () => void) => {
      before.current.add(fn);
      return () => before.current.delete(fn);
    },
    [],
  );

  // Metadata polling can notice a role change before the next socket frame.
  // Reconnect promptly so the server can switch between projection and edit.
  useEffect(() => {
    if (!role || client.syncMode === null) return;
    const expected = role === "view" ? "view" : "edit";
    if (client.syncMode !== expected) socket.current?.close();
  }, [client, role, version]);

  const status = client.status;
  return {
    client,
    version,
    getChangeRevision,
    status,
    peers,
    ready: client.doc !== null && status !== "connecting",
    caughtUp: client.caughtUp,
    blocked: client.blocked,
    storageError,
    legacyPending,
    otherPending,
    offlineHydrated: client.offlineHydrated,
    pendingOpsCount: client.unacked,
    onBeforeRemote,
  };
}

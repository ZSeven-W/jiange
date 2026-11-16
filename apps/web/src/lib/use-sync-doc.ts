import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SyncClient, type Peer, type SyncStatus } from "@jiange/collab";
import type { Presence } from "./presence";
import { pendingSessionQueue, prepareBrowserPendingSession, writePendingOps, type PendingSession } from "./pending-ops-storage";

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
  /** Editors register to capture caret anchors before remote ops land. */
  onBeforeRemote: (fn: () => void) => () => void;
}

function syncURL() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/sync?protocol=3`;
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
  const socket = useRef<WebSocket | null>(null);
  const [peers, setPeers] = useState<RemotePeer[]>([]);
  const before = useRef(new Set<() => void>());

  const client = useMemo(
    () => {
      const c = new SyncClient(docId, {
        beforeRemote: () => before.current.forEach((fn) => fn()),
        change: () => { changeRevision.current++; persist.current(c); setVersion((v) => v + 1); },
        status: () => setStatusRevision((revision) => revision + 1),
        caughtUp: () => setCatchUpRevision((revision) => revision + 1),
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

  // offline durability: unacknowledged local ops survive reloads
  useEffect(() => {
    let stopped = false;
    let pending: PendingSession | null = null;
    // StrictMode and quick navigation may remount before the old Web Lock is
    // actually released. Wait for the same account/document's prior lifetime.
    const lifetime = pendingSessionQueue.reserve(userId, docId), finish = lifetime.release;
    setStorageError(false);
    setLegacyPending(false);
    setOtherPending(false);
    const save = () => {
      if (!pending) return;
      try {
        const ops = client.pendingOps();
        writePendingOps(localStorage, pending.key, ops.length ? { clientId: client.clientId, ops, blocked: client.rejection ?? client.blocked, historyEpoch: client.pendingHistoryEpoch } : null);
      } catch { setStorageError(true); }
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
    window.addEventListener("beforeunload", save);
    return () => {
      stopped = true;
      clearInterval(id);
      window.removeEventListener("beforeunload", save);
      save();
      if (pending) void pending.release().finally(finish);
      persist.current = () => {};
    };
  }, [client, docId, userId]);

  useEffect(() => {
    if (!enabled || storageClient !== client) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped || client.blocked === "table_unsupported") return;
      const sock = new WebSocket(syncURL());
      sock.binaryType = "arraybuffer";
      ws = sock;
      socket.current = sock;
      sock.onopen = () => {
        if (stopped || ws !== sock) { sock.close(); return; }
        delay = 1000;
        client.open((b) => sock.readyState === WebSocket.OPEN && sock.send(b));
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
        if (socket.current === sock) socket.current = null;
        client.close();
        // Revocation can close the socket without a protocol error; re-check
        // metadata so a previously editable page becomes read-only.
        if (!stopped) void qc.invalidateQueries({ queryKey: ["doc", docId] });
        if (!stopped && client.blocked !== "table_unsupported" && navigator.onLine) timer = setTimeout(connect, delay + Math.random() * 300);
        delay = Math.min(delay * 2, 5000);
      };
    };
    connect();
    const online = () => {
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        clearTimeout(timer);
        connect();
      }
    };
    // the browser knows it lost the network before TCP does: drop the socket now
    // so edits queue locally and the UI shows offline; they are resent on reconnect
    const offline = () => ws?.close();
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      const s = ws;
      ws = null;
      if (socket.current === s) socket.current = null;
      s?.close();
      client.close();
    };
  }, [client, docId, qc, storageClient, enabled]);

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
  return { client, version, getChangeRevision, status, peers, ready: client.doc !== null && status !== "connecting", caughtUp: client.caughtUp, blocked: client.blocked, storageError, legacyPending, otherPending, onBeforeRemote };
}

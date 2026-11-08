import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SyncClient, type Peer, type SyncStatus } from "@jiange/collab";
import type { Presence } from "./presence";
import { prepareBrowserPendingSession, writePendingOps, type PendingSession } from "./pendingOpsStorage";

export interface RemotePeer {
  clientId: number;
  state: Presence;
}

export interface SyncDoc {
  client: SyncClient;
  /** Bumped on every content change; read it to re-render. */
  version: number;
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
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/sync?protocol=2`;
}

/** Opens a live replica of a document over the Jiange sync protocol, reconnecting with backoff. */
export function useSyncDoc(docId: number, userId: number): SyncDoc {
  const qc = useQueryClient();
  const [version, setVersion] = useState(0);
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
        change: () => { persist.current(c); setVersion((v) => v + 1); },
        status: () => setStatusRevision((revision) => revision + 1),
        caughtUp: () => setCatchUpRevision((revision) => revision + 1),
        blocked: () => { persist.current(c); setBlockedRevision((revision) => revision + 1); },
        peers: (ps: Peer[]) => setPeers(ps.filter((p) => p.state && typeof p.state === "object") as RemotePeer[]),
        error: (code, msg) => {
          console.warn("sync", code, msg);
          if (code === "gap" || (c.blocked && code !== "missing_dependency" && code !== "invalid_history")) socket.current?.close();
          if (code === "read_only" || code === "forbidden" || code === "not_found") void qc.invalidateQueries({ queryKey: ["doc", docId] });
        },
      });
      return c;
    },
    [docId, userId, qc],
  );

  // offline durability: unacknowledged local ops survive reloads
  useEffect(() => {
    let stopped = false;
    let pending: PendingSession | null = null;
    setStorageError(false);
    setLegacyPending(false);
    setOtherPending(false);
    const save = () => {
      if (!pending) return;
      try {
        const ops = client.pendingOps();
        writePendingOps(localStorage, pending.key, ops.length ? { clientId: client.clientId, ops, blocked: client.rejection ?? client.blocked } : null);
      } catch { setStorageError(true); }
    };
    const random = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
    const failed = () => { if (!stopped) { setStorageError(true); setStorageClient(client); } };
    const prepared = (result: PendingSession) => {
      if (stopped) { result.release(); return; }
      pending = result;
      setLegacyPending(result.legacy);
      setOtherPending(result.otherDrafts);
      if (result.corrupt) setStorageError(true);
      if (result.draft?.ops.length && !client.doc) client.restore(result.draft.clientId, result.draft.ops, result.draft.blocked);
      persist.current = (candidate) => { if (candidate === client) save(); };
      setStorageClient(client);
    };
    void prepareBrowserPendingSession(() => ({ local: window.localStorage, session: window.sessionStorage, locks: navigator.locks }), userId, docId, random).then(prepared).catch(failed);
    const id = setInterval(save, 1000); // remove successfully acknowledged batches
    window.addEventListener("beforeunload", save);
    return () => {
      stopped = true;
      clearInterval(id);
      window.removeEventListener("beforeunload", save);
      save();
      pending?.release();
      persist.current = () => {};
    };
  }, [client, docId, userId]);

  useEffect(() => {
    if (storageClient !== client) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
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
        if (!stopped && navigator.onLine) timer = setTimeout(connect, delay + Math.random() * 300);
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
  }, [client, docId, qc, storageClient]);

  const onBeforeRemote = useMemo(
    () => (fn: () => void) => {
      before.current.add(fn);
      return () => before.current.delete(fn);
    },
    [],
  );

  const status = client.status;
  return { client, version, status, peers, ready: client.doc !== null && status !== "connecting", caughtUp: client.caughtUp, blocked: client.blocked, storageError, legacyPending, otherPending, onBeforeRemote };
}

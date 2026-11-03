import { useEffect, useMemo, useRef, useState } from "react";
import { SyncClient, type Peer, type SyncStatus } from "@jiange/collab";
import type { Presence } from "./presence";

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
  /** Editors register to capture caret anchors before remote ops land. */
  onBeforeRemote: (fn: () => void) => () => void;
}

function syncURL() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/sync`;
}

/** Opens a live replica of a document over the Jiange sync protocol, reconnecting with backoff. */
export function useSyncDoc(docId: number): SyncDoc {
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [peers, setPeers] = useState<RemotePeer[]>([]);
  const before = useRef(new Set<() => void>());

  const client = useMemo(
    () =>
      new SyncClient(docId, {
        beforeRemote: () => before.current.forEach((fn) => fn()),
        change: () => setVersion((v) => v + 1),
        status: setStatus,
        peers: (ps: Peer[]) => setPeers(ps.filter((p) => p.state && typeof p.state === "object") as RemotePeer[]),
        error: (code, msg) => console.warn("sync", code, msg),
      }),
    [docId],
  );

  // offline durability: unacknowledged local ops survive reloads
  useEffect(() => {
    const key = `jiange:pending:${docId}`;
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null");
      if (saved?.clientId && Array.isArray(saved.ops) && saved.ops.length && !client.doc) client.restore(saved.clientId, saved.ops);
    } catch {
      /* ignore corrupt storage */
    }
    let t: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      const ops = client.pendingOps();
      if (ops.length) localStorage.setItem(key, JSON.stringify({ clientId: client.clientId, ops }));
      else localStorage.removeItem(key);
    };
    const id = setInterval(save, 1000);
    window.addEventListener("beforeunload", save);
    return () => {
      clearInterval(id);
      clearTimeout(t);
      window.removeEventListener("beforeunload", save);
      save();
    };
  }, [client, docId]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const sock = new WebSocket(syncURL());
      sock.binaryType = "arraybuffer";
      ws = sock;
      sock.onopen = () => {
        delay = 1000;
        client.open((b) => sock.readyState === WebSocket.OPEN && sock.send(b));
      };
      sock.onmessage = (e) => {
        try {
          client.receive(new Uint8Array(e.data as ArrayBuffer));
        } catch (err) {
          console.error("sync receive", err);
          sock.close();
        }
      };
      sock.onclose = () => {
        if (ws !== sock) return;
        client.close();
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
      s?.close();
      client.close();
    };
  }, [client]);

  const onBeforeRemote = useMemo(
    () => (fn: () => void) => {
      before.current.add(fn);
      return () => before.current.delete(fn);
    },
    [],
  );

  return { client, version, status, peers, ready: client.doc !== null && status !== "connecting", onBeforeRemote };
}

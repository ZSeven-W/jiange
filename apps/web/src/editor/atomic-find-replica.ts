import { SyncClient } from "@jiange/collab";

/** Obtain an isolated operation author from the authenticated sync service.
 * The returned ID must be used by only one in-flight planner at a time. */
export function allocateAtomicFindReplica(docId: number, signal: AbortSignal, timeoutMs = 15_000): Promise<{ author: number; epoch: number }> {
  if (!Number.isSafeInteger(docId) || docId <= 0 || signal.aborted) return Promise.reject(new Error("invalid replica request"));
  return new Promise((resolve, reject) => {
    let socket: WebSocket | null = null, finished = false;
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timeout); signal.removeEventListener("abort", aborted);
      const result = !error && client.epoch !== null ? { author: client.clientId, epoch: client.epoch } : null;
      socket?.close(); client.close();
      if (result) resolve(result); else reject(error ?? new Error("replica unavailable"));
    };
    const maybe = () => {
      if (client.syncMode === "view" || client.blocked) { finish(new Error("replica is not editable")); return; }
      if (client.caughtUp && client.status === "synced" && client.epoch !== null && Number.isSafeInteger(client.clientId) && client.clientId > 0) finish();
    };
    const client = new SyncClient(docId, { change: maybe, status: maybe, caughtUp: maybe, blocked: maybe, error: () => finish(new Error("replica synchronization failed")) }, { requireMode: true });
    const aborted = () => finish(new Error("replica request aborted"));
    const timeout = setTimeout(() => finish(new Error("replica request timed out")), Math.max(1, timeoutMs));
    signal.addEventListener("abort", aborted, { once: true });
    try {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/sync?protocol=3`);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => { if (!finished && socket) client.open((bytes) => { if (socket?.readyState === WebSocket.OPEN) socket.send(bytes); }); };
      socket.onmessage = (event) => { if (finished) return; try { if (!(event.data instanceof ArrayBuffer)) throw new Error("invalid replica frame"); client.receive(new Uint8Array(event.data)); maybe(); } catch { finish(new Error("invalid replica frame")); } };
      socket.onerror = () => finish(new Error("replica connection failed"));
      socket.onclose = () => { if (!finished) finish(new Error("replica connection closed")); };
    } catch { finish(new Error("replica connection unavailable")); }
  });
}

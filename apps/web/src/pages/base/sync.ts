import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BaseRecord, Cell, DocMeta, Field, User, View } from "@/lib/api";

export interface BaseData {
  base: DocMeta;
  fields: Field[];
  records: BaseRecord[];
  head: number;
  members?: User[];
  views?: View[];
  /** Raw realtime events cannot be safely projected for restricted users. */
  writeRestricted?: boolean;
}

/** One realtime change from the server's globally numbered event log. */
export interface BtEvent {
  seq: number;
  body: {
    kind: "field" | "record" | "reload";
    op?: "add" | "update" | "del";
    field?: Field;
    fid?: number;
    record?: BaseRecord;
    rid?: number;
    cells?: Record<string, Cell>;
  };
}

/** Fold one event into the cached base state (events apply in seq order, so
 * the last committed write to a cell wins everywhere). */
export function applyBtEvent(data: BaseData, ev: BtEvent): BaseData {
  const b = ev.body;
  if (b.kind === "field") {
    if (b.op === "del" && b.fid != null) {
      const fid = b.fid;
      return {
        ...data,
        fields: data.fields.filter((f) => f.id !== fid),
        records: data.records.map((r) => (fid in r.cells ? { ...r, cells: { ...r.cells, [fid]: undefined } } : r)),
      };
    }
    if (b.field) {
      const f = b.field;
      const fields = data.fields.some((x) => x.id === f.id) ? data.fields.map((x) => (x.id === f.id ? f : x)) : [...data.fields, f];
      return { ...data, fields: fields.sort((a, b2) => a.position - b2.position) };
    }
    return data;
  }
  if (b.kind === "record") {
    if (b.op === "del" && b.rid != null) {
      const rid = b.rid;
      return { ...data, records: data.records.filter((r) => r.id !== rid) };
    }
    if (b.record) {
      const rec = b.record;
      const records = data.records.some((r) => r.id === rec.id) ? data.records.map((r) => (r.id === rec.id ? rec : r)) : [...data.records, rec];
      return { ...data, records: records.sort((a, b2) => a.position - b2.position) };
    }
  }
  return data; // "reload" is handled by the hook (invalidates the query)
}

/** Poll only while visible, coalescing focus/visibility events and slow requests. */
export function startRestrictedPolling(refresh: () => Promise<void>, env: {
  visible: () => boolean;
  listen: (wake: () => void) => () => void;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}, interval = 15_000): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unlisten = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) env.clearTimer(timer);
    unlisten();
  };
  const schedule = () => {
    if (!stopped) timer = env.setTimer(tick, interval);
  };
  const tick = () => {
    timer = undefined;
    if (stopped) return;
    if (running || !env.visible()) { schedule(); return; }
    running = true;
    void refresh().catch(() => { stop(); /* page reports the failed access check */ }).finally(() => {
      running = false;
      if (timer === undefined) schedule();
    });
  };
  const wake = () => {
    if (stopped || running || !env.visible()) return;
    if (timer !== undefined) env.clearTimer(timer);
    tick();
  };
  unlisten = env.listen(wake);
  schedule();
  return stop;
}

/** Coalesce invalidations but repeat a fetch if a change arrives while it runs. */
export function createSnapshotRefresher(refresh: () => Promise<void>) {
  let inFlight: Promise<void> | null = null;
  let dirty = false;
  let stopped = false;
  const request = (): Promise<void> => {
      if (stopped) return Promise.resolve();
      if (inFlight) { dirty = true; return inFlight; }
      const run = (async () => {
        do {
          dirty = false;
          await refresh();
        } while (dirty && !stopped);
      })();
      inFlight = run;
      // Install both handlers: using finally without handling its returned
      // promise would introduce an unhandled rejection on network failure.
      void run.then(() => {
        if (inFlight !== run) return;
        inFlight = null;
        // A promise callback may mark dirty after the loop's final check but
        // before this cleanup runs. Do not lose that invalidation.
        if (dirty && !stopped) void request().catch(() => {});
      }, () => { if (inFlight === run) inFlight = null; });
      return run;
  };
  return {
    request,
    stop() { stopped = true; dirty = false; },
  };
}

/** Events are invalidations, not authoritative row patches. Current event IDs
 * are global and the HTTP snapshot and head are not atomic. Periodic checked
 * snapshots provide eventual recovery until the protocol has per-base epochs
 * and an atomic snapshot. Restricted readers never open an unfiltered WS. */
export function useBaseSync(baseId: number, options: { ready: boolean; restricted: boolean }) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!options.ready) return;
    const key = ["base", baseId] as const;
    let ws: WebSocket | null = null;
    let closed = false;
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let stopPolling = () => {};

    // Refetch the authorization-bearing snapshot before reconnecting or
    // refreshing derived query results. A rejected snapshot remains an error
    // in the observed query; BasePage hides its cached data on error.
    const refresh = async () => {
      await qc.invalidateQueries({ queryKey: key, exact: true }, { throwOnError: true });
      if (closed || qc.getQueryState(key)?.status !== "success") return;
      // A failed filtered query should not prevent an otherwise-authorized
      // realtime stream from reconnecting; its own observer reports errors.
      void qc.invalidateQueries({ queryKey: [...key, "query"] });
    };
    const snapshots = createSnapshotRefresher(async () => {
      try { await refresh(); }
      catch (error) {
        failed = true;
        stopPolling();
        snapshots.stop();
        ws?.close();
        throw error;
      }
    });
    stopPolling = startRestrictedPolling(() => snapshots.request(), {
      visible: () => document.visibilityState === "visible",
      listen: (wake) => {
        window.addEventListener("focus", wake);
        document.addEventListener("visibilitychange", wake);
        return () => { window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake); };
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
    });

    if (options.restricted) {
      return () => { closed = true; snapshots.stop(); stopPolling(); };
    }

    const connect = () => {
      const cached = qc.getQueryData<BaseData>(key);
      if (closed || failed || !cached || cached.writeRestricted || qc.getQueryState(key)?.status !== "success") return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/bases/${baseId}/sync`);
      ws.onopen = () => {
        retries = 0;
        ws!.send(JSON.stringify({ t: "hello", lastSeq: qc.getQueryData<BaseData>(key)?.head ?? 0 }));
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.t === "events" && Array.isArray(m.events) && m.events.length) void snapshots.request().catch(() => {});
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (closed || failed) return;
        retries++;
        // A close can mean the grant or lock changed. Never reopen the raw
        // stream using the old grant; re-read permissions first.
        timer = setTimeout(() => { void snapshots.request().then(connect).catch(() => {}); }, Math.min(10000, 500 * 2 ** retries));
      };
    };
    connect();
    return () => {
      closed = true;
      snapshots.stop();
      stopPolling();
      if (timer !== undefined) clearTimeout(timer);
      ws?.close();
    };
  }, [baseId, qc, options.ready, options.restricted]);
}

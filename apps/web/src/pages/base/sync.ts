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

/** One realtime change from the server's per-base event log. */
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
  const schedule = () => {
    if (!stopped) timer = env.setTimer(tick, interval);
  };
  const tick = () => {
    timer = undefined;
    if (stopped) return;
    if (running || !env.visible()) { schedule(); return; }
    running = true;
    void refresh().catch(() => { /* query state reports failure to the page */ }).finally(() => {
      running = false;
      if (timer === undefined) schedule();
    });
  };
  const wake = () => {
    if (stopped || running || !env.visible()) return;
    if (timer !== undefined) env.clearTimer(timer);
    tick();
  };
  const unlisten = env.listen(wake);
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) env.clearTimer(timer);
    unlisten();
  };
}

/** Live updates only after a successful access check. Locked-view readers use
 * authorized HTTP refreshes: the server intentionally denies unfiltered WS. */
export function useBaseSync(baseId: number, options: { ready: boolean; restricted: boolean }) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!options.ready) return;
    const key = ["base", baseId] as const;
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let lastSeq = qc.getQueryData<BaseData>(key)?.head ?? 0;

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

    if (options.restricted) {
      const stop = startRestrictedPolling(refresh, {
        visible: () => document.visibilityState === "visible",
        listen: (wake) => {
          window.addEventListener("focus", wake);
          document.addEventListener("visibilitychange", wake);
          return () => { window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake); };
        },
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (id) => clearTimeout(id),
      });
      return () => { closed = true; stop(); };
    }

    const onEvents = (events: BtEvent[]) => {
      for (const ev of events) {
        const state = qc.getQueryState(key);
        const cached = qc.getQueryData<BaseData>(key);
        if (closed || state?.status !== "success" || !cached || cached.writeRestricted) return;
        // A concurrent HTTP snapshot can replace a newer event cache. Refresh
        // before applying further deltas rather than silently skipping data.
        if (cached.head < lastSeq) { ws?.close(); return; }
        if (cached.head > lastSeq) lastSeq = cached.head;
        if (ev.seq <= lastSeq) continue;
        // Never apply events after a gap: reload a fresh authorized snapshot.
        if (ev.seq !== lastSeq + 1) { ws?.close(); return; }
        lastSeq = ev.seq;
        if (ev.body.kind === "reload") {
          // The payload does not carry a projection and may include a lock or
          // role change. Drop the stream and re-check the complete snapshot.
          ws?.close();
          return;
        }
        qc.setQueryData<BaseData | undefined>(key, (d) => (d ? { ...applyBtEvent(d, ev), head: ev.seq } : d));
      }
    };
    const connect = () => {
      const cached = qc.getQueryData<BaseData>(key);
      if (closed || !cached || cached.writeRestricted || qc.getQueryState(key)?.status !== "success") return;
      lastSeq = cached.head;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/bases/${baseId}/sync`);
      ws.onopen = () => {
        retries = 0;
        ws!.send(JSON.stringify({ t: "hello", lastSeq }));
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.t === "events" && Array.isArray(m.events)) onEvents(m.events);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        retries++;
        // A close can mean the grant or lock changed. Never reopen the raw
        // stream using the old grant; re-read permissions first.
        timer = setTimeout(() => { void refresh().then(connect).catch(() => {}); }, Math.min(10000, 500 * 2 ** retries));
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      ws?.close();
    };
  }, [baseId, qc, options.ready, options.restricted]);
}

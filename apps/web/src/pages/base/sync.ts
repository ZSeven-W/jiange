import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BaseRecord, Cell, DocMeta, Field } from "@/lib/api";

export interface BaseData {
  base: DocMeta;
  fields: Field[];
  records: BaseRecord[];
  head: number;
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

/** Live updates for one base: applies streamed events to the ["base", id]
 * query cache and replays missed events after a reconnect. */
export function useBaseSync(baseId: number) {
  const qc = useQueryClient();
  const lastSeq = useRef(0);
  useEffect(() => {
    const key = ["base", baseId];
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const onEvents = (events: BtEvent[]) => {
      for (const ev of events) {
        if (ev.seq <= lastSeq.current) continue;
        lastSeq.current = ev.seq;
        if (ev.body.kind === "reload") {
          qc.invalidateQueries({ queryKey: key });
          continue;
        }
        qc.setQueryData<BaseData | undefined>(key, (d) => (d ? applyBtEvent(d, ev) : d));
      }
    };
    const connect = () => {
      const cached = qc.getQueryData<BaseData>(key);
      if (cached && lastSeq.current === 0) lastSeq.current = cached.head;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/bases/${baseId}/sync`);
      ws.onopen = () => {
        retries = 0;
        ws!.send(JSON.stringify({ t: "hello", lastSeq: lastSeq.current }));
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
        timer = setTimeout(connect, Math.min(10000, 500 * 2 ** retries));
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [baseId, qc]);
}

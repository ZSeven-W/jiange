import { Reader, Writer } from "./encoding";

/** Sync protocol message types (spec/PROTOCOL.md §Sync). One message per WebSocket binary frame. */
export const MSG = {
  hello: 0x01,
  ops: 0x02,
  ack: 0x03,
  aware: 0x04,
  welcome: 0x11,
  sops: 0x12,
  sack: 0x13,
  saware: 0x14,
  error: 0x15,
} as const;

export type ClientMsg =
  | { type: "hello"; docId: number; clientId: number; lastSeq: number }
  | { type: "ops"; batch: Uint8Array }
  | { type: "ack"; seq: number }
  | { type: "aware"; state: string };

export type ServerMsg =
  | { type: "welcome"; clientId: number; headSeq: number; snapshot: { seq: number; state: Uint8Array } | null }
  | { type: "ops"; firstSeq: number; batch: Uint8Array }
  | { type: "ack"; firstSeq: number; count: number }
  | { type: "aware"; clientId: number; state: string }
  | { type: "error"; code: string; message: string };

function bytes(w: Writer, b: Uint8Array) {
  w.uvar(b.length);
  for (const x of b) w.u8(x);
}

function readBytes(r: Reader): Uint8Array {
  const n = r.uvar();
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = r.u8();
  return out;
}

export function encodeClientMsg(m: ClientMsg): Uint8Array {
  const w = new Writer();
  switch (m.type) {
    case "hello":
      w.u8(MSG.hello); w.uvar(m.docId); w.uvar(m.clientId); w.uvar(m.lastSeq); break;
    case "ops":
      w.u8(MSG.ops); bytes(w, m.batch); break;
    case "ack":
      w.u8(MSG.ack); w.uvar(m.seq); break;
    case "aware":
      w.u8(MSG.aware); w.str(m.state); break;
  }
  return w.bytes();
}

export function decodeClientMsg(b: Uint8Array): ClientMsg {
  const r = new Reader(b);
  const t = r.u8();
  let m: ClientMsg;
  switch (t) {
    case MSG.hello: m = { type: "hello", docId: r.uvar(), clientId: r.uvar(), lastSeq: r.uvar() }; break;
    case MSG.ops: m = { type: "ops", batch: readBytes(r) }; break;
    case MSG.ack: m = { type: "ack", seq: r.uvar() }; break;
    case MSG.aware: m = { type: "aware", state: r.str() }; break;
    default: throw new RangeError(`unknown client message ${t}`);
  }
  if (!r.done) throw new RangeError("trailing bytes");
  return m;
}

export function encodeServerMsg(m: ServerMsg): Uint8Array {
  const w = new Writer();
  switch (m.type) {
    case "welcome":
      w.u8(MSG.welcome); w.uvar(m.clientId); w.uvar(m.headSeq);
      if (m.snapshot) { w.u8(1); w.uvar(m.snapshot.seq); bytes(w, m.snapshot.state); } else w.u8(0);
      break;
    case "ops":
      w.u8(MSG.sops); w.uvar(m.firstSeq); bytes(w, m.batch); break;
    case "ack":
      w.u8(MSG.sack); w.uvar(m.firstSeq); w.uvar(m.count); break;
    case "aware":
      w.u8(MSG.saware); w.uvar(m.clientId); w.str(m.state); break;
    case "error":
      w.u8(MSG.error); w.str(m.code); w.str(m.message); break;
  }
  return w.bytes();
}

export function decodeServerMsg(b: Uint8Array): ServerMsg {
  const r = new Reader(b);
  const t = r.u8();
  let m: ServerMsg;
  switch (t) {
    case MSG.welcome: {
      const clientId = r.uvar(), headSeq = r.uvar();
      const has = r.u8();
      m = { type: "welcome", clientId, headSeq, snapshot: has ? { seq: r.uvar(), state: readBytes(r) } : null };
      break;
    }
    case MSG.sops: m = { type: "ops", firstSeq: r.uvar(), batch: readBytes(r) }; break;
    case MSG.sack: m = { type: "ack", firstSeq: r.uvar(), count: r.uvar() }; break;
    case MSG.saware: m = { type: "aware", clientId: r.uvar(), state: r.str() }; break;
    case MSG.error: m = { type: "error", code: r.str(), message: r.str() }; break;
    default: throw new RangeError(`unknown server message ${t}`);
  }
  if (!r.done) throw new RangeError("trailing bytes");
  return m;
}

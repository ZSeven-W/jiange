import { Reader, Writer } from "./encoding.js";

/** Sync protocol message types (spec/protocol.md §Sync). One message per WebSocket binary frame. */
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
  projection: 0x16,
} as const;

export type ClientMsg =
  | { type: "hello"; docId: number; clientId: number; lastSeq: number }
  // v2 hello carries the cached history epoch as one trailing uvar; an old
  // server rejects the byte and the client falls back to v1 for the session.
  | { type: "hello"; docId: number; clientId: number; lastSeq: number; historyEpoch: number }
  | { type: "ops"; batch: Uint8Array }
  | { type: "ack"; seq: number }
  | { type: "aware"; state: string };

export type ServerMsg =
  | { type: "welcome"; clientId: number; headSeq: number; snapshot: { seq: number; state: Uint8Array } | null }
  // v2 welcome appends the history epoch: a change means the log rewound
  // (restore/PITR) and every cached seq is meaningless — take the snapshot.
  | { type: "welcome"; clientId: number; headSeq: number; snapshot: { seq: number; state: Uint8Array } | null; historyEpoch: number }
  | { type: "welcome"; clientId: number; headSeq: number; snapshot: { seq: number; state: Uint8Array } | null; historyEpoch: number; mode: "edit" | "view" }
  | { type: "projection"; headSeq: number; historyEpoch: number; state: Uint8Array }
  | { type: "ops"; firstSeq: number; batch: Uint8Array }
  | { type: "ack"; firstSeq: number; count: number }
  | { type: "aware"; clientId: number; state: string }
  | { type: "error"; code: string; message: string };

function bytes(w: Writer, b: Uint8Array) {
  w.blob(b);
}

function readBytes(r: Reader): Uint8Array {
  return r.blob();
}

export function encodeClientMsg(m: ClientMsg): Uint8Array {
  const w = new Writer();
  switch (m.type) {
    case "hello":
      w.u8(MSG.hello); w.uvar(m.docId); w.uvar(m.clientId); w.uvar(m.lastSeq);
      if ("historyEpoch" in m) w.uvar(m.historyEpoch); // v2 only: old servers reject the trailing byte
      break;
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
    case MSG.hello:
      m = { type: "hello", docId: r.uvar(), clientId: r.uvar(), lastSeq: r.uvar() };
      if (!r.done) m = { ...m, historyEpoch: r.uvar() }; // v2 server → v2 client
      break;
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
      if ("historyEpoch" in m) w.uvar(m.historyEpoch); // v2 only: v1 clients reject the trailing byte
      if ("mode" in m) w.u8(m.mode === "view" ? 1 : 0);
      break;
    case "projection":
      w.u8(MSG.projection); w.uvar(m.headSeq); w.uvar(m.historyEpoch); bytes(w, m.state); break;
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
      if (has !== 0 && has !== 1) throw new RangeError("invalid snapshot flag");
      const snapshot = has ? { seq: r.uvar(), state: readBytes(r) } : null;
      if (!r.done) {
        // v2 welcome from a v2-aware server; old servers send exactly v1 bytes.
        const historyEpoch = r.uvar();
        if (!r.done) {
          const mode = r.u8();
          if (mode !== 0 && mode !== 1) throw new RangeError("invalid sync mode");
          m = { type: "welcome", clientId, headSeq, snapshot, historyEpoch, mode: mode === 1 ? "view" : "edit" };
        } else m = { type: "welcome", clientId, headSeq, snapshot, historyEpoch };
      } else {
        m = { type: "welcome", clientId, headSeq, snapshot };
      }
      break;
    }
    case MSG.sops: m = { type: "ops", firstSeq: r.uvar(), batch: readBytes(r) }; break;
    case MSG.projection: m = { type: "projection", headSeq: r.uvar(), historyEpoch: r.uvar(), state: readBytes(r) }; break;
    case MSG.sack: m = { type: "ack", firstSeq: r.uvar(), count: r.uvar() }; break;
    case MSG.saware: m = { type: "aware", clientId: r.uvar(), state: r.str() }; break;
    case MSG.error: m = { type: "error", code: r.str(), message: r.str() }; break;
    default: throw new RangeError(`unknown server message ${t}`);
  }
  if (!r.done) throw new RangeError("trailing bytes");
  return m;
}

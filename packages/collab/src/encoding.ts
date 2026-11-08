import type { OpId } from "./id";
import type { Anchor, Op, Side } from "./ops";

/** Batch header: magic 'J' (0x4a) + format version. See spec/PROTOCOL.md. */
export const MAGIC = 0x4a;
export const VERSION = 1;

export const TAG = { bcreate: 1, bmove: 2, bset: 3, bdel: 4, tins: 5, tdel: 6, mark: 7, ttable: 8 } as const;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export class Writer {
  private buf = new Uint8Array(64);
  private n = 0;
  private ensure(k: number) {
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.n + k) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.n));
    this.buf = nb;
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.n++] = v & 0xff;
  }
  /** Unsigned LEB128, up to 2^53-1. */
  uvar(v: number) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`uvar: ${v}`);
    while (v >= 0x80) {
      this.u8((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.u8(v);
  }
  str(s: string) {
    const b = enc.encode(s);
    this.uvar(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  id(id: OpId) {
    this.uvar(id.client);
    this.uvar(id.clock);
  }
  /** Length-prefixed raw bytes. */
  blob(b: Uint8Array) {
    this.uvar(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

export class Reader {
  private i = 0;
  constructor(private b: Uint8Array) {}
  get done() {
    return this.i >= this.b.length;
  }
  u8(): number {
    if (this.i >= this.b.length) throw new RangeError("unexpected end of input");
    return this.b[this.i++];
  }
  uvar(): number {
    let v = 0;
    let mul = 1;
    for (let k = 0; k < 8; k++) {
      const x = this.u8();
      v += (x & 0x7f) * mul;
      if (x < 0x80) return v;
      mul *= 0x80;
    }
    throw new RangeError("varint too long");
  }
  str(): string {
    const n = this.uvar();
    if (this.i + n > this.b.length) throw new RangeError("unexpected end of input");
    const s = dec.decode(this.b.subarray(this.i, this.i + n));
    this.i += n;
    return s;
  }
  id(): OpId {
    return { client: this.uvar(), clock: this.uvar() };
  }
  /** Length-prefixed raw bytes. */
  blob(): Uint8Array {
    const n = this.uvar();
    if (this.i + n > this.b.length) throw new RangeError("unexpected end of input");
    const out = this.b.slice(this.i, this.i + n);
    this.i += n;
    return out;
  }
}

function side(r: Reader): Side {
  const s = r.u8();
  if (s !== 0 && s !== 1) throw new RangeError(`bad side ${s}`);
  return s;
}

function anchor(r: Reader): Anchor {
  return { char: r.id(), side: side(r) };
}

export function writeOp(w: Writer, op: Op): void {
  w.u8(TAG[op.t]);
  w.id(op.id);
  switch (op.t) {
    case "bcreate":
      w.id(op.parent);
      w.str(op.pos);
      w.str(op.type);
      return;
    case "bmove":
      w.id(op.block);
      w.id(op.parent);
      w.str(op.pos);
      return;
    case "bset":
      w.id(op.block);
      w.str(op.key);
      w.str(op.value);
      return;
    case "bdel":
      w.id(op.block);
      return;
    case "tins":
      w.id(op.block);
      w.id(op.parent);
      w.u8(op.side);
      w.str(op.text);
      return;
    case "tdel":
      w.id(op.block);
      w.id(op.target);
      w.uvar(op.len);
      return;
    case "ttable":
      w.id(op.block);
      w.blob(op.payload);
      return;
    case "mark":
      w.id(op.block);
      w.str(op.key);
      if (op.value === null) w.u8(0);
      else {
        w.u8(1);
        w.str(op.value);
      }
      w.id(op.start.char);
      w.u8(op.start.side);
      w.id(op.end.char);
      w.u8(op.end.side);
      return;
  }
}

export function readOp(r: Reader): Op {
  const tag = r.u8();
  const id = r.id();
  switch (tag) {
    case TAG.bcreate:
      return { t: "bcreate", id, parent: r.id(), pos: r.str(), type: r.str() };
    case TAG.bmove:
      return { t: "bmove", id, block: r.id(), parent: r.id(), pos: r.str() };
    case TAG.bset:
      return { t: "bset", id, block: r.id(), key: r.str(), value: r.str() };
    case TAG.bdel:
      return { t: "bdel", id, block: r.id() };
    case TAG.tins:
      return { t: "tins", id, block: r.id(), parent: r.id(), side: side(r), text: r.str() };
    case TAG.tdel:
      return { t: "tdel", id, block: r.id(), target: r.id(), len: r.uvar() };
    case TAG.ttable:
      return { t: "ttable", id, block: r.id(), payload: r.blob() };
    case TAG.mark: {
      const block = r.id();
      const key = r.str();
      const has = r.u8();
      if (has > 1) throw new RangeError("bad value flag");
      const value = has ? r.str() : null;
      return { t: "mark", id, block, key, value, start: anchor(r), end: anchor(r) };
    }
    default:
      throw new RangeError(`unknown op tag ${tag}`);
  }
}

export function encodeOps(ops: Op[]): Uint8Array {
  const w = new Writer();
  w.u8(MAGIC);
  w.u8(VERSION);
  w.uvar(ops.length);
  for (const op of ops) writeOp(w, op);
  return w.bytes();
}

export function decodeOps(b: Uint8Array): Op[] {
  const r = new Reader(b);
  if (r.u8() !== MAGIC) throw new RangeError("bad magic");
  const v = r.u8();
  if (v !== VERSION) throw new RangeError(`unsupported version ${v}`);
  const n = r.uvar();
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) ops.push(readOp(r));
  if (!r.done) throw new RangeError("trailing bytes");
  return ops;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

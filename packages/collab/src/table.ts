/**
 * Stable Table CRDT subpath (`@jiange/collab/table`) with Lamport ID allocator
 * and `ttable` binary payload codec.
 */

import type { Doc } from "./doc.js";
import type { OpId } from "./id.js";
import {
  DEFAULT_TABLE_LIMITS,
  ExperimentalTable,
  validTableMarkValue,
  type TableAxis,
  type TableLimits,
  type TableMarkKey,
  type TableMarkState,
  type TableOp,
  type TableRichChar,
} from "./table-experimental.js";

export {
  DEFAULT_TABLE_LIMITS,
  ExperimentalTable,
  ExperimentalTable as CollabTable,
  validTableMarkValue,
  type TableAxis,
  type TableLimits,
  type TableMarkKey,
  type TableMarkState,
  type TableOp,
  type TableRichChar,
};

/** Lamport operation ID allocator backed by a parent `Doc` or standalone client clock. */
export class TableIdAllocator {
  private localClock = 0;

  constructor(
    private readonly clientId: number,
    private readonly doc?: Pick<Doc, "allocateOpIds">,
  ) {
    if (!Number.isSafeInteger(clientId) || clientId <= 0) {
      throw new RangeError("clientId must be a positive safe integer");
    }
  }

  observe(id: OpId): void {
    if (id.clock > this.localClock) this.localClock = id.clock;
  }

  allocate(count = 1): OpId[] {
    if (this.doc) return this.doc.allocateOpIds(count);
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new RangeError("allocation count must be a positive safe integer");
    }
    const ids: OpId[] = [];
    for (let i = 0; i < count; i++) {
      this.localClock++;
      ids.push({ client: this.clientId, clock: this.localClock });
    }
    return ids;
  }

  next(): OpId {
    return this.allocate(1)[0];
  }
}

const MAGIC = 0x54; // 'T'
const VERSION = 1;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Encode Table CRDT operations into a compact binary `ttable` wire payload. */
export function encodeTableOps(ops: readonly TableOp[]): Uint8Array {
  const jsonBytes = enc.encode(JSON.stringify(ops));
  const out = new Uint8Array(2 + jsonBytes.length);
  out[0] = MAGIC;
  out[1] = VERSION;
  out.set(jsonBytes, 2);
  return out;
}

/** Decode a binary `ttable` wire payload back into `TableOp[]`. */
export function decodeTableOps(bytes: Uint8Array, maxBytes = 4 * 1024 * 1024): TableOp[] {
  if (bytes.length < 2 || bytes.length > maxBytes) {
    throw new RangeError("invalid ttable payload size");
  }
  if (bytes[0] !== MAGIC || bytes[1] !== VERSION) {
    throw new TypeError("unsupported ttable payload header");
  }
  const parsed = JSON.parse(dec.decode(bytes.subarray(2))) as unknown;
  if (!Array.isArray(parsed)) throw new TypeError("ttable payload must be an op array");
  return parsed as TableOp[];
}

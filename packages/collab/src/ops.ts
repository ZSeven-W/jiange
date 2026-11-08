import type { OpId } from "./id";

/** 0 = before the character, 1 = after the character. */
export type Side = 0 | 1;

export interface Anchor {
  char: OpId;
  side: Side;
}

export type Op =
  | { t: "bcreate"; id: OpId; parent: OpId; pos: string; type: string }
  | { t: "bmove"; id: OpId; block: OpId; parent: OpId; pos: string }
  | { t: "bset"; id: OpId; block: OpId; key: string; value: string }
  | { t: "bdel"; id: OpId; block: OpId }
  /** Inserts `text`; char i gets id (id.client, id.clock + i). Char 0 hangs off `parent` on `side`, char i>0 is the right child of char i-1. */
  | { t: "tins"; id: OpId; block: OpId; parent: OpId; side: Side; text: string }
  /** Deletes chars (target.client, target.clock .. target.clock+len-1). */
  | { t: "tdel"; id: OpId; block: OpId; target: OpId; len: number }
  /** Formats the span between two anchors; value null removes the mark key. */
  | { t: "mark"; id: OpId; block: OpId; key: string; value: string | null; start: Anchor; end: Anchor }
  /** Carries one experimental-table sub-CRDT operation for `block` as opaque
   * bytes. Consumes exactly one Lamport tick; the table op's internal OpId is
   * this op's id (reserved via Doc.allocateOpIds). Old clients reject the
   * tag, so servers must gate these ops to v2-negotiated rooms. */
  | { t: "ttable"; id: OpId; block: OpId; payload: Uint8Array };

/** Number of Lamport ticks an op consumes. */
export function opSpan(op: Op): number {
  return op.t === "tins" ? [...op.text].length : 1;
}

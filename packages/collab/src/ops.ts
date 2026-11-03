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
  | { t: "mark"; id: OpId; block: OpId; key: string; value: string | null; start: Anchor; end: Anchor };

/** Number of Lamport ticks an op consumes. */
export function opSpan(op: Op): number {
  return op.t === "tins" ? [...op.text].length : 1;
}

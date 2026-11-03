import { eqId, idKey, ROOT, type OpId } from "./id";
import type { Op } from "./ops";
import type { Doc } from "./doc";

/** Everything needed to recreate a deleted block. */
export interface BlockSnap {
  id: OpId;
  type: string;
  props: Record<string, string>;
  chars: OpId[];
  text: string[];
  marks: Record<string, string>[];
  parent: OpId;
  after: OpId | null;
}

/**
 * An undoable change, expressed against ids (not indices) so it stays
 * meaningful when remote edits land in between.
 */
export type UndoItem =
  | { k: "ins"; block: OpId; chars: OpId[] }
  | { k: "del"; block: OpId; after: OpId | null; chars: OpId[]; text: string[]; marks: Record<string, string>[] }
  | { k: "mark"; block: OpId; chars: OpId[]; key: string; prev: (string | null)[] }
  | { k: "prop"; block: OpId; key: string; prev: string }
  | { k: "create"; block: OpId }
  | { k: "bdel"; snap: BlockSnap }
  | { k: "move"; block: OpId; parent: OpId; after: OpId | null };

/** Index just after `after` among parent's children (0 when null/unknown). */
export function indexAfter(doc: Doc, parent: OpId, after: OpId | null): number {
  if (!after) return 0;
  const kids = doc.children(parent);
  const i = kids.findIndex((k) => eqId(k, after));
  return i < 0 ? kids.length : i + 1;
}

function prevSibling(doc: Doc, block: OpId): { parent: OpId; after: OpId | null } {
  const { parent } = doc.blockInfo(block);
  const kids = doc.children(parent);
  const i = kids.findIndex((k) => eqId(k, block));
  return { parent, after: i > 0 ? kids[i - 1] : null };
}

export function snapshotBlock(doc: Doc, block: OpId): BlockSnap {
  const info = doc.blockInfo(block);
  const rich = doc.richChars(block);
  return {
    id: block,
    type: info.type,
    props: info.props,
    chars: doc.visibleIds(block),
    text: rich.map((r) => r.ch),
    marks: rich.map((r) => r.marks),
    ...prevSibling(doc, block),
  };
}

/** Applies per-char marks to a freshly inserted run [from, from+n). */
export function applyMarks(doc: Doc, block: OpId, from: number, marks: Record<string, string>[]): Op[] {
  const ops: Op[] = [];
  const keys = new Set(marks.flatMap((m) => Object.keys(m)));
  for (const key of [...keys].sort()) {
    let i = 0;
    while (i < marks.length) {
      const v = marks[i][key];
      let j = i + 1;
      while (j < marks.length && marks[j][key] === v) j++;
      if (v !== undefined) {
        const op = doc.format(block, from + i, from + j, key, v);
        if (op) ops.push(op);
      }
      i = j;
    }
  }
  return ops;
}

/**
 * Makes chars [from, from+want.length) carry exactly the marks in `want`
 * (clearing marks inherited from expanding neighbours).
 */
export function reconcileMarks(doc: Doc, block: OpId, from: number, want: Record<string, string>[]): Op[] {
  const have = doc.richChars(block).slice(from, from + want.length);
  const keys = new Set([...have.flatMap((h) => Object.keys(h.marks)), ...want.flatMap((w) => Object.keys(w))]);
  const ops: Op[] = [];
  for (const key of [...keys].sort()) {
    let i = 0;
    while (i < want.length) {
      const v = want[i][key] ?? null;
      let j = i + 1;
      while (j < want.length && (want[j][key] ?? null) === v) j++;
      let differs = false;
      for (let q = i; q < j; q++) if ((have[q]?.marks[key] ?? null) !== v) differs = true;
      if (differs) {
        const op = doc.format(block, from + i, from + j, key, v);
        if (op) ops.push(op);
      }
      i = j;
    }
  }
  return ops;
}

/**
 * A local edit transaction. Each method applies ops to the doc immediately,
 * collects them for sending, and records the inverse information for undo.
 */
export class Tx {
  ops: Op[] = [];
  items: UndoItem[] = [];
  constructor(readonly doc: Doc) {}

  private push(...ops: (Op | null)[]) {
    for (const op of ops) if (op) this.ops.push(op);
  }

  insert(block: OpId, index: number, text: string, marks?: Record<string, string> | Record<string, string>[]): number {
    const op = this.doc.insertText(block, index, text);
    if (!op || op.t !== "tins") return 0;
    this.push(op);
    const n = [...text].length;
    const chars = Array.from({ length: n }, (_, i) => ({ client: op.id.client, clock: op.id.clock + i }));
    this.items.push({ k: "ins", block, chars });
    if (marks) {
      const want = Array.isArray(marks) ? marks : chars.map(() => marks);
      this.push(...reconcileMarks(this.doc, block, index, want));
    }
    return n;
  }

  delete(block: OpId, from: number, to: number) {
    if (to <= from) return;
    const ids = this.doc.visibleIds(block);
    const rich = this.doc.richChars(block).slice(from, to);
    this.items.push({
      k: "del",
      block,
      after: from > 0 ? ids[from - 1] : null,
      chars: ids.slice(from, to),
      text: rich.map((r) => r.ch),
      marks: rich.map((r) => r.marks),
    });
    this.push(...this.doc.deleteText(block, from, to - from));
  }

  format(block: OpId, from: number, to: number, key: string, value: string | null) {
    if (to <= from) return;
    const ids = this.doc.visibleIds(block).slice(from, to);
    const prev = this.doc
      .richChars(block)
      .slice(from, to)
      .map((r) => r.marks[key] ?? null);
    if (prev.every((p) => p === value)) return;
    this.items.push({ k: "mark", block, chars: ids, key, prev });
    this.push(this.doc.format(block, from, to, key, value));
  }

  setProp(block: OpId, key: string, value: string) {
    const info = this.doc.blockInfo(block);
    const prev = key === "type" ? info.type : (info.props[key] ?? "");
    if (prev === value) return;
    this.items.push({ k: "prop", block, key, prev });
    this.push(this.doc.setProp(block, key, value));
  }

  /** Creates a block after `after` (null = first) under parent. */
  create(type: string, after: OpId | null, parent: OpId = ROOT, props: Record<string, string> = {}): OpId {
    const op = this.doc.createBlock(type, parent, indexAfter(this.doc, parent, after));
    this.push(op);
    for (const k of Object.keys(props).sort()) if (props[k] !== "") this.push(this.doc.setProp(op.id, k, props[k]));
    this.items.push({ k: "create", block: op.id });
    return op.id;
  }

  deleteBlock(block: OpId) {
    this.items.push({ k: "bdel", snap: snapshotBlock(this.doc, block) });
    this.push(this.doc.deleteBlock(block));
  }

  move(block: OpId, after: OpId | null, parent: OpId = ROOT) {
    const from = prevSibling(this.doc, block);
    if (eqId(from.parent, parent) && (from.after === after || (from.after && after && eqId(from.after, after)))) return;
    if (after && eqId(after, block)) return;
    this.items.push({ k: "move", block, ...from });
    this.push(this.doc.moveBlock(block, parent, indexAfter(this.doc, parent, after)));
  }
}

export const keyOf = idKey;

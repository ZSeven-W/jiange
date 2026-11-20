import { idKey, ROOT, type OpId } from "./id.js";
import type { Op } from "./ops.js";
import type { Doc } from "./doc.js";
import { applyMarks, indexAfter, reconcileMarks, snapshotBlock, Tx, type BlockSnap, type UndoItem } from "./tx.js";

export interface SerializedUndoEntry {
  items: UndoItem[];
  marker?: string;
}

export interface UndoManagerSnapshot {
  v: 1;
  undos: SerializedUndoEntry[];
  redos: SerializedUndoEntry[];
  remap: [string, OpId][];
}

function isOpId(value: unknown): value is OpId {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as OpId).client) &&
    (value as OpId).client >= 0 &&
    Number.isSafeInteger((value as OpId).clock) &&
    (value as OpId).clock >= 0
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const v of Object.values(value)) {
    if (typeof v !== "string") return false;
  }
  return true;
}

function isBlockSnap(value: unknown): value is BlockSnap {
  if (typeof value !== "object" || value === null) return false;
  const s = value as BlockSnap;
  return (
    isOpId(s.id) &&
    typeof s.type === "string" &&
    isStringRecord(s.props) &&
    Array.isArray(s.chars) &&
    s.chars.every(isOpId) &&
    Array.isArray(s.text) &&
    s.text.every((ch) => typeof ch === "string") &&
    Array.isArray(s.marks) &&
    s.marks.every(isStringRecord) &&
    s.chars.length === s.text.length &&
    s.chars.length === s.marks.length &&
    isOpId(s.parent) &&
    (s.after === null || isOpId(s.after))
  );
}

function isUndoItem(value: unknown): value is UndoItem {
  if (typeof value !== "object" || value === null) return false;
  const it = value as UndoItem;
  switch (it.k) {
    case "ins":
      return isOpId(it.block) && Array.isArray(it.chars) && it.chars.every(isOpId);
    case "del":
      return (
        isOpId(it.block) &&
        (it.after === null || isOpId(it.after)) &&
        Array.isArray(it.chars) &&
        it.chars.every(isOpId) &&
        Array.isArray(it.text) &&
        it.text.every((ch) => typeof ch === "string") &&
        Array.isArray(it.marks) &&
        it.marks.every(isStringRecord) &&
        it.chars.length === it.text.length &&
        it.chars.length === it.marks.length
      );
    case "mark":
      return (
        isOpId(it.block) &&
        Array.isArray(it.chars) &&
        it.chars.every(isOpId) &&
        typeof it.key === "string" &&
        Array.isArray(it.prev) &&
        it.prev.every((v) => v === null || typeof v === "string") &&
        it.chars.length === it.prev.length
      );
    case "prop":
      return isOpId(it.block) && typeof it.key === "string" && typeof it.prev === "string";
    case "create":
      return isOpId(it.block);
    case "bdel":
      return isBlockSnap(it.snap);
    case "move":
      return isOpId(it.block) && isOpId(it.parent) && (it.after === null || isOpId(it.after));
    default:
      return false;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface Entry<S> {
  items: UndoItem[];
  before: S | null;
  after: S | null;
  tag?: string;
  marker?: string;
  time: number;
  insertion?: { previous: Entry<S> | null; sequence: number };
}

/**
 * Collaborative undo/redo over local changes only. Entries are inverted
 * against the *current* document, so remote edits made in between are
 * preserved. Recreated blocks/characters get new ids; an id remap keeps older
 * entries pointing at the live replacements.
 */
export class UndoManager<S = unknown> {
  private undos: Entry<S>[] = [];
  private redos: Entry<S>[] = [];
  private remap = new Map<string, OpId>();
  private revisionValue = 0;
  private navigationRevision = 0;
  private insertionSequence = 0;
  private readonly insertionPoints = new WeakMap<object, { previous: Entry<S> | null; navigation: number; sequence: number }>();
  mergeWindowMs = 800;
  limit = 500;

  get canUndo() {
    return this.undos.length > 0;
  }
  get canRedo() {
    return this.redos.length > 0;
  }

  /** Changes whenever the local history stacks or their grouping change. */
  get revision() { return this.revisionValue; }

  /** A marker lets an editor keep a guarded external action in undo order. */
  recordMarker(marker: string, merged = false) {
    this.revisionValue++;
    this.redos = [];
    if (merged && this.undos.at(-1)?.marker === marker) return;
    this.undos.push({ items: [], before: null, after: null, marker, time: Date.now() });
    if (this.undos.length > this.limit) this.undos.shift();
  }

  peekMarker(redo: boolean): string | null {
    return (redo ? this.redos : this.undos).at(-1)?.marker ?? null;
  }

  /** Check whether a guarded external action is still in either local stack. */
  hasMarker(marker: string): boolean {
    return this.undos.some((entry) => entry.marker === marker) || this.redos.some((entry) => entry.marker === marker);
  }

  /** Reserve the current boundary without changing either history stack. */
  markInsertionPoint(): object {
    // Later typing must not merge into the entry before this boundary.
    this.seal();
    const token = Object.freeze({});
    this.insertionPoints.set(token, { previous: this.undos.at(-1) ?? null, navigation: this.navigationRevision, sequence: ++this.insertionSequence });
    return token;
  }

  /** Insert an asynchronously confirmed action before later local edits. */
  insertMarkerAt(token: object, marker: string): boolean {
    const point = this.insertionPoints.get(token);
    if (!point || !marker || this.hasMarker(marker) || point.navigation !== this.navigationRevision || this.limit < 1) return false;
    let index = point.previous ? this.undos.indexOf(point.previous) + 1 : 0;
    if (point.previous && index === 0) return false;
    while (index < this.undos.length && this.undos[index].insertion?.previous === point.previous && this.undos[index].insertion!.sequence < point.sequence) index++;
    // An insertion at the oldest edge would be immediately evicted.
    if (index === 0 && this.undos.length >= this.limit) return false;
    this.undos.splice(index, 0, { items: [], before: null, after: null, marker, time: Date.now(), insertion: { previous: point.previous, sequence: point.sequence } });
    this.redos = [];
    if (this.undos.length > this.limit) this.undos.shift();
    this.revisionValue++;
    this.insertionPoints.delete(token);
    return true;
  }

  /** Share identifier remaps with another part of the same editor history. */
  shareRemappings<T>(other: UndoManager<T>): void { this.remap = other.remap; }

  /** Preview an inverse on a caller-provided cloned document without consuming this history. */
  preview(doc: Doc, redo: boolean): { ops: Op[]; selection: S | null } | null {
    const copy = new UndoManager<S>();
    copy.undos = this.undos.map((entry) => ({ ...entry, items: [...entry.items] }));
    copy.redos = this.redos.map((entry) => ({ ...entry, items: [...entry.items] }));
    copy.remap = new Map(this.remap);
    copy.revisionValue = this.revisionValue;
    copy.mergeWindowMs = this.mergeWindowMs;
    copy.limit = this.limit;
    return redo ? copy.redo(doc) : copy.undo(doc);
  }

  /** Move a marker only after its owner has safely applied the inverse. */
  moveMarker(redo: boolean, marker: string): boolean {
    const from = redo ? this.redos : this.undos;
    const to = redo ? this.undos : this.redos;
    if (from.at(-1)?.marker !== marker) return false;
    to.push(from.pop()!);
    this.revisionValue++;
    this.navigationRevision++;
    return true;
  }

  /** Drop only an explicitly discarded external action; no document is changed. */
  discardMarker(redo: boolean, marker: string, expectedRevision: number): boolean {
    const stack = redo ? this.redos : this.undos;
    if (this.revisionValue !== expectedRevision || stack.at(-1)?.marker !== marker) return false;
    stack.pop();
    this.revisionValue++;
    this.navigationRevision++;
    return true;
  }

  /** Follows the remap chain to the live id. */
  map = (id: OpId): OpId => {
    let cur = id;
    for (let i = 0; i < 1000; i++) {
      const n = this.remap.get(idKey(cur));
      if (!n) return cur;
      cur = n;
    }
    return cur;
  };

  /** Records a local transaction. Consecutive entries with the same tag (e.g. typing) merge. */
  record(tx: Tx, before: S | null, after: S | null, tag?: string, now = Date.now()) {
    if (tx.items.length === 0) return;
    this.revisionValue++;
    this.redos = [];
    const last = this.undos[this.undos.length - 1];
    if (tag && last && last.tag === tag && now - last.time < this.mergeWindowMs) {
      last.items.push(...tx.items);
      last.after = after;
      last.time = now;
      return;
    }
    this.undos.push({ items: [...tx.items], before, after, tag, time: now });
    if (this.undos.length > this.limit) this.undos.shift();
  }

  /** Stops merging into the last entry (e.g. on caret jump). */
  seal() {
    const last = this.undos[this.undos.length - 1];
    if (last?.tag !== undefined) { last.tag = undefined; this.revisionValue++; }
  }

  /**
   * Serializes local undo/redo entries and OpId remappings for per-tab reload
   * recovery. External markers are excluded unless explicitly permitted.
   */
  exportState(options: { allowMarker?: (marker: string) => boolean; maxUndos?: number; maxRedos?: number } = {}): UndoManagerSnapshot {
    const maxUndos = Math.max(0, options.maxUndos ?? 50);
    const maxRedos = Math.max(0, options.maxRedos ?? 20);
    const pick = (list: Entry<S>[], cap: number): SerializedUndoEntry[] => {
      const kept: SerializedUndoEntry[] = [];
      for (const entry of list) {
        if (entry.marker) {
          if (options.allowMarker?.(entry.marker)) kept.push({ items: [], marker: entry.marker });
        } else if (entry.items.length > 0) {
          kept.push({ items: cloneJson(entry.items) });
        }
      }
      return cap > 0 ? kept.slice(-cap) : [];
    };
    return {
      v: 1,
      undos: pick(this.undos, maxUndos),
      redos: pick(this.redos, maxRedos),
      remap: [...this.remap.entries()].map(([k, v]) => [k, { client: v.client, clock: v.clock }]),
    };
  }

  /**
   * Restores a validated snapshot after reload. Mutates `remap` in place so
   * any sub-history linked via `shareRemappings` stays synchronized.
   */
  importState(snapshot: unknown, options: { allowMarker?: (marker: string) => boolean } = {}): boolean {
    if (typeof snapshot !== "object" || snapshot === null) return false;
    const raw = snapshot as Partial<UndoManagerSnapshot>;
    if (raw.v !== 1 || !Array.isArray(raw.undos) || !Array.isArray(raw.redos) || !Array.isArray(raw.remap)) return false;
    const parseStack = (entries: unknown[]): Entry<S>[] | null => {
      const out: Entry<S>[] = [];
      for (const item of entries) {
        if (typeof item !== "object" || item === null) return null;
        const entry = item as Partial<SerializedUndoEntry>;
        if (entry.marker !== undefined) {
          if (typeof entry.marker !== "string" || !entry.marker) return null;
          if (!options.allowMarker?.(entry.marker)) continue;
          out.push({ items: [], before: null, after: null, marker: entry.marker, time: 0 });
        } else {
          if (!Array.isArray(entry.items) || !entry.items.length || !entry.items.every(isUndoItem)) return null;
          out.push({ items: cloneJson(entry.items), before: null, after: null, time: 0 });
        }
      }
      return out.slice(-this.limit);
    };
    const undos = parseStack(raw.undos);
    const redos = parseStack(raw.redos);
    if (!undos || !redos) return false;
    const remaps: [string, OpId][] = [];
    for (const pair of raw.remap) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !isOpId(pair[1])) return false;
      remaps.push([pair[0], { client: pair[1].client, clock: pair[1].clock }]);
    }
    this.undos = undos;
    this.redos = redos;
    this.remap.clear();
    for (const [k, v] of remaps) this.remap.set(k, v);
    this.revisionValue++;
    this.navigationRevision++;
    return true;
  }

  undo(doc: Doc): { ops: Op[]; selection: S | null } | null {
    return this.step(doc, this.undos, this.redos, "before");
  }

  redo(doc: Doc): { ops: Op[]; selection: S | null } | null {
    return this.step(doc, this.redos, this.undos, "after");
  }

  private step(doc: Doc, from: Entry<S>[], to: Entry<S>[], sel: "before" | "after") {
    // External actions must be processed by their owner, not silently dropped.
    if (from.at(-1)?.marker) return null;
    const e = from.pop();
    if (!e) return null;
    this.revisionValue++;
    this.navigationRevision++;
    const tx = new Tx(doc);
    const inverse: UndoItem[] = [];
    for (let i = e.items.length - 1; i >= 0; i--) {
      const inv = this.invert(doc, tx, e.items[i]);
      if (inv) inverse.push(inv);
    }
    to.push({ items: inverse, before: e.before, after: e.after, time: 0 });
    return { ops: tx.ops, selection: e[sel] };
  }

  private alive(doc: Doc, block: OpId): OpId | null {
    const b = this.map(block);
    return doc.hasBlock(b) ? b : null;
  }

  /** Applies the inverse of `it` and returns the item that would redo it. */
  private invert(doc: Doc, tx: Tx, it: UndoItem): UndoItem | null {
    switch (it.k) {
      case "ins": {
        const block = this.alive(doc, it.block);
        if (!block) return null;
        const ids = doc.visibleIds(block);
        const pos = new Map(ids.map((id, i) => [idKey(id), i]));
        const idx = it.chars.map((c) => pos.get(idKey(this.map(c)))).filter((i): i is number => i !== undefined);
        if (idx.length === 0) return null;
        idx.sort((a, b) => a - b);
        const before = tx.items.length;
        // delete from the back so earlier indices stay valid
        let j = idx.length - 1;
        while (j >= 0) {
          let k = j;
          while (k > 0 && idx[k - 1] === idx[k] - 1) k--;
          tx.delete(block, idx[k], idx[j] + 1);
          j = k - 1;
        }
        const dels = tx.items.slice(before) as Extract<UndoItem, { k: "del" }>[];
        // merge into one redo item (in document order)
        dels.reverse();
        return {
          k: "del",
          block,
          after: dels[0].after,
          chars: dels.flatMap((d) => d.chars),
          text: dels.flatMap((d) => d.text),
          marks: dels.flatMap((d) => d.marks),
        };
      }
      case "del": {
        const block = this.alive(doc, it.block);
        if (!block) return null;
        const index = it.after ? doc.resolveAnchor(block, { char: this.map(it.after), side: 1 }) : 0;
        const op = doc.insertText(block, index, it.text.join(""));
        if (!op || op.t !== "tins") return null;
        tx.ops.push(op);
        const fresh = it.chars.map((_, i) => ({ client: op.id.client, clock: op.id.clock + i }));
        it.chars.forEach((c, i) => this.remap.set(idKey(this.map(c)), fresh[i]));
        // restore exactly the old formatting (clearing inherited expanding marks)
        tx.ops.push(...reconcileMarks(doc, block, index, it.marks));
        return { k: "ins", block, chars: fresh };
      }
      case "mark": {
        const block = this.alive(doc, it.block);
        if (!block) return null;
        const ids = doc.visibleIds(block);
        const pos = new Map(ids.map((id, i) => [idKey(id), i]));
        const rich = doc.richChars(block);
        const chars: OpId[] = [];
        const prev: (string | null)[] = [];
        // group visible chars into contiguous runs with the same target value
        const targets = it.chars
          .map((c, i) => ({ i: pos.get(idKey(this.map(c))), v: it.prev[i] }))
          .filter((x): x is { i: number; v: string | null } => x.i !== undefined)
          .sort((a, b) => a.i - b.i);
        let s = 0;
        while (s < targets.length) {
          let e = s + 1;
          while (e < targets.length && targets[e].i === targets[e - 1].i + 1 && targets[e].v === targets[s].v) e++;
          for (let q = s; q < e; q++) {
            chars.push(ids[targets[q].i]);
            prev.push(rich[targets[q].i].marks[it.key] ?? null);
          }
          const op = doc.format(block, targets[s].i, targets[e - 1].i + 1, it.key, targets[s].v);
          if (op) tx.ops.push(op);
          s = e;
        }
        return chars.length ? { k: "mark", block, chars, key: it.key, prev } : null;
      }
      case "prop": {
        const block = this.alive(doc, it.block);
        if (!block) return null;
        const info = doc.blockInfo(block);
        const cur = it.key === "type" ? info.type : (info.props[it.key] ?? "");
        if (cur !== it.prev) tx.ops.push(doc.setProp(block, it.key, it.prev));
        return { k: "prop", block, key: it.key, prev: cur };
      }
      case "create": {
        const block = this.alive(doc, it.block);
        if (!block) return null;
        const snap = snapshotBlock(doc, block);
        tx.ops.push(doc.deleteBlock(block));
        return { k: "bdel", snap };
      }
      case "bdel": {
        const s = it.snap;
        const parent = s.parent.client === 0 && s.parent.clock === 0 ? ROOT : this.alive(doc, s.parent) ?? ROOT;
        const after = s.after ? this.alive(doc, s.after) : null;
        const op = doc.createBlock(s.type, parent, indexAfter(doc, parent, after));
        tx.ops.push(op);
        this.remap.set(idKey(this.map(s.id)), op.id);
        for (const k of Object.keys(s.props).sort()) tx.ops.push(doc.setProp(op.id, k, s.props[k]));
        if (s.text.length) {
          const ins = doc.insertText(op.id, 0, s.text.join(""));
          if (ins && ins.t === "tins") {
            tx.ops.push(ins);
            s.chars.forEach((c, i) => this.remap.set(idKey(this.map(c)), { client: ins.id.client, clock: ins.id.clock + i }));
            tx.ops.push(...applyMarks(doc, op.id, 0, s.marks));
          }
        }
        return { k: "create", block: op.id };
      }
      case "move": {
        const block = this.alive(doc, it.block);
        if (!block) return null;
        const info = doc.blockInfo(block);
        const kids = doc.children(info.parent);
        const i = kids.findIndex((k) => idKey(k) === idKey(block));
        const back: UndoItem = { k: "move", block, parent: info.parent, after: i > 0 ? kids[i - 1] : null };
        const parent = this.alive(doc, it.parent) ?? ROOT;
        const after = it.after ? this.alive(doc, it.after) : null;
        tx.ops.push(doc.moveBlock(block, parent, indexAfter(doc, parent, after)));
        return back;
      }
    }
  }
}

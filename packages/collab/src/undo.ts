import { idKey, ROOT, type OpId } from "./id";
import type { Op } from "./ops";
import type { Doc } from "./doc";
import { applyMarks, indexAfter, reconcileMarks, snapshotBlock, Tx, type UndoItem } from "./tx";

interface Entry<S> {
  items: UndoItem[];
  before: S | null;
  after: S | null;
  tag?: string;
  marker?: string;
  time: number;
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

  /** Move a marker only after its owner has safely applied the inverse. */
  moveMarker(redo: boolean, marker: string): boolean {
    const from = redo ? this.redos : this.undos;
    const to = redo ? this.undos : this.redos;
    if (from.at(-1)?.marker !== marker) return false;
    to.push(from.pop()!);
    this.revisionValue++;
    return true;
  }

  /** Drop only an explicitly discarded external action; no document is changed. */
  discardMarker(redo: boolean, marker: string, expectedRevision: number): boolean {
    const stack = redo ? this.redos : this.undos;
    if (this.revisionValue !== expectedRevision || stack.at(-1)?.marker !== marker) return false;
    stack.pop();
    this.revisionValue++;
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

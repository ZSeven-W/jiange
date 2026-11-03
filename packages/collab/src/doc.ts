import { cmpId, eqId, idKey, ROOT, type OpId } from "./id";
import { keyBetween } from "./fracindex";
import { opSpan, type Anchor, type Op, type Side } from "./ops";

interface CharNode {
  id: OpId;
  ch: string;
  deleted: boolean;
  left: CharNode[];
  right: CharNode[];
}

interface Reg<T> {
  value: T;
  ts: OpId;
}

interface MarkRec {
  id: OpId;
  key: string;
  value: string | null;
  start: Anchor;
  end: Anchor;
}

interface Block {
  id: OpId;
  loc: Reg<{ parent: OpId; pos: string }>;
  props: Map<string, Reg<string>>;
  deleted: boolean;
  root: CharNode;
  chars: Map<string, CharNode>;
  marks: MarkRec[];
  order: CharNode[] | null; // cached full traversal (incl. tombstones)
}

export interface Span {
  text: string;
  marks: Record<string, string>;
}

export interface BlockView {
  id: string;
  parent: string;
  type: string;
  props: Record<string, string>;
  spans: Span[];
}

export interface DocView {
  blocks: BlockView[];
}

function insertSorted(arr: CharNode[], n: CharNode): void {
  let i = 0;
  while (i < arr.length && cmpId(arr[i].id, n.id) < 0) i++;
  arr.splice(i, 0, n);
}

function newBlock(id: OpId, parent: OpId, pos: string): Block {
  const root: CharNode = { id: ROOT, ch: "", deleted: true, left: [], right: [] };
  return {
    id,
    loc: { value: { parent, pos }, ts: id },
    props: new Map(),
    deleted: false,
    root,
    chars: new Map([[idKey(ROOT), root]]),
    marks: [],
    order: null,
  };
}

/**
 * A Jiange collaborative document: a block tree (LWW registers + move) where
 * every block owns a Fugue-style text sequence with Peritext-style marks.
 *
 * Ops may arrive in any order and any number of times; ops whose causal
 * dependencies are missing are buffered until they become applicable.
 */
export class Doc {
  readonly client: number;
  private clock = 0;
  private blocks = new Map<string, Block>();
  private seen = new Set<string>();
  private pending: Op[] = [];

  constructor(client: number) {
    if (!Number.isInteger(client) || client <= 0) throw new Error("client id must be a positive integer");
    this.client = client;
    this.blocks.set(idKey(ROOT), newBlock(ROOT, ROOT, ""));
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /* ------------------------------------------------------------ apply */

  /** Applies a (remote or local) op. Returns true if it was new. */
  apply(op: Op): boolean {
    const k = idKey(op.id);
    if (this.seen.has(k) || this.pending.some((p) => eqId(p.id, op.id))) return false;
    if (!this.ready(op)) {
      this.pending.push(op);
      return true;
    }
    this.integrate(op);
    // drain pending until fixpoint
    let progress = true;
    while (progress && this.pending.length) {
      progress = false;
      for (let i = 0; i < this.pending.length; i++) {
        const p = this.pending[i];
        if (this.ready(p)) {
          this.pending.splice(i, 1);
          this.integrate(p);
          progress = true;
          i--;
        }
      }
    }
    return true;
  }

  private ready(op: Op): boolean {
    if (op.t === "bcreate") return true;
    const b = this.blocks.get(idKey(op.block));
    if (!b) return false;
    switch (op.t) {
      case "tins":
        return b.chars.has(idKey(op.parent));
      case "tdel":
        for (let i = 0; i < op.len; i++) {
          if (!b.chars.has(idKey({ client: op.target.client, clock: op.target.clock + i }))) return false;
        }
        return true;
      case "mark":
        return b.chars.has(idKey(op.start.char)) && b.chars.has(idKey(op.end.char));
      default:
        return true;
    }
  }

  private integrate(op: Op): void {
    this.seen.add(idKey(op.id));
    const top = op.id.clock + opSpan(op) - 1;
    if (top > this.clock) this.clock = top;
    switch (op.t) {
      case "bcreate": {
        const b = newBlock(op.id, op.parent, op.pos);
        b.props.set("type", { value: op.type, ts: op.id });
        this.blocks.set(idKey(op.id), b);
        return;
      }
      case "bmove": {
        const b = this.blocks.get(idKey(op.block))!;
        if (cmpId(op.id, b.loc.ts) > 0) b.loc = { value: { parent: op.parent, pos: op.pos }, ts: op.id };
        return;
      }
      case "bset": {
        const b = this.blocks.get(idKey(op.block))!;
        const cur = b.props.get(op.key);
        if (!cur || cmpId(op.id, cur.ts) > 0) b.props.set(op.key, { value: op.value, ts: op.id });
        return;
      }
      case "bdel": {
        this.blocks.get(idKey(op.block))!.deleted = true;
        return;
      }
      case "tins": {
        const b = this.blocks.get(idKey(op.block))!;
        let parent = b.chars.get(idKey(op.parent))!;
        let side: Side = op.side;
        let i = 0;
        for (const ch of op.text) {
          const n: CharNode = { id: { client: op.id.client, clock: op.id.clock + i }, ch, deleted: false, left: [], right: [] };
          insertSorted(side === 0 ? parent.left : parent.right, n);
          b.chars.set(idKey(n.id), n);
          parent = n;
          side = 1;
          i++;
        }
        b.order = null;
        return;
      }
      case "tdel": {
        const b = this.blocks.get(idKey(op.block))!;
        for (let i = 0; i < op.len; i++) {
          b.chars.get(idKey({ client: op.target.client, clock: op.target.clock + i }))!.deleted = true;
        }
        b.order = null;
        return;
      }
      case "mark": {
        const b = this.blocks.get(idKey(op.block))!;
        b.marks.push({ id: op.id, key: op.key, value: op.value, start: op.start, end: op.end });
        return;
      }
    }
  }

  /* ------------------------------------------------------------ text internals */

  private order(b: Block): CharNode[] {
    if (b.order) return b.order;
    const out: CharNode[] = [];
    // iterative in-order traversal: left children, node, right children
    const stack: Array<{ n: CharNode; stage: number }> = [{ n: b.root, stage: 0 }];
    while (stack.length) {
      const top = stack.pop()!;
      if (top.stage === 0) {
        stack.push({ n: top.n, stage: 1 });
        for (let i = top.n.left.length - 1; i >= 0; i--) stack.push({ n: top.n.left[i], stage: 0 });
      } else {
        if (top.n !== b.root) out.push(top.n);
        for (let i = top.n.right.length - 1; i >= 0; i--) stack.push({ n: top.n.right[i], stage: 0 });
      }
    }
    b.order = out;
    return out;
  }

  private visible(b: Block): CharNode[] {
    return this.order(b).filter((c) => !c.deleted);
  }

  private block(id: OpId): Block {
    const b = this.blocks.get(idKey(id));
    if (!b || b.deleted) throw new Error(`unknown block ${idKey(id)}`);
    return b;
  }

  private next(span = 1): OpId {
    const id = { client: this.client, clock: this.clock + 1 };
    this.clock += span;
    return id;
  }

  private commit(op: Op): Op {
    // local ops are always ready; integrate directly (clock already advanced)
    this.apply(op);
    return op;
  }

  /* ------------------------------------------------------------ local API */

  text(block: OpId): string {
    return this.visible(this.block(block)).map((c) => c.ch).join("");
  }

  /** Visible children of a block, in order. */
  children(parent: OpId): OpId[] {
    return this.view().blocks.filter((b) => b.parent === idKey(parent)).map((b) => {
      const [c, k] = b.id.split(":");
      return { client: Number(c), clock: Number(k) };
    });
  }

  private childPositions(parent: OpId): string[] {
    const out: string[] = [];
    for (const b of this.blocks.values()) {
      if (b === this.blocks.get(idKey(ROOT)) || b.deleted) continue;
      if (eqId(b.loc.value.parent, parent)) out.push(b.loc.value.pos);
    }
    return out.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  }

  private posAt(parent: OpId, index: number): string {
    const ps = this.childPositions(parent);
    const i = Math.max(0, Math.min(index, ps.length));
    const lo = i > 0 ? ps[i - 1] : "";
    let hi = i < ps.length ? ps[i] : "";
    if (lo !== "" && hi !== "" && lo >= hi) hi = ""; // equal positions from concurrency: append after lo
    return keyBetween(lo, hi);
  }

  createBlock(type: string, parent: OpId = ROOT, index = Number.MAX_SAFE_INTEGER): Op {
    return this.commit({ t: "bcreate", id: this.next(), parent, pos: this.posAt(parent, index), type });
  }

  moveBlock(block: OpId, parent: OpId, index = Number.MAX_SAFE_INTEGER): Op {
    this.block(block);
    return this.commit({ t: "bmove", id: this.next(), block, parent, pos: this.posAt(parent, index) });
  }

  setProp(block: OpId, key: string, value: string): Op {
    this.block(block);
    return this.commit({ t: "bset", id: this.next(), block, key, value });
  }

  deleteBlock(block: OpId): Op {
    this.block(block);
    return this.commit({ t: "bdel", id: this.next(), block });
  }

  insertText(block: OpId, index: number, text: string): Op | null {
    const n = [...text].length;
    if (n === 0) return null;
    const b = this.block(block);
    const vis = this.visible(b);
    if (index < 0 || index > vis.length) throw new RangeError("index out of range");
    const L = index > 0 ? vis[index - 1] : b.root;
    let parent: OpId;
    let side: Side;
    if (L.right.length === 0) {
      parent = L.id;
      side = 1;
    } else {
      // R = next element after L in full order; it has no left children.
      const ord = this.order(b);
      const li = L === b.root ? -1 : ord.indexOf(L);
      const R = ord[li + 1];
      parent = R.id;
      side = 0;
    }
    return this.commit({ t: "tins", id: this.next(n), block, parent, side, text });
  }

  /** Deletes `len` visible chars from `index`; may emit several ops (one per id run). */
  deleteText(block: OpId, index: number, len: number): Op[] {
    const b = this.block(block);
    const vis = this.visible(b).slice(index, index + len);
    const ops: Op[] = [];
    let i = 0;
    while (i < vis.length) {
      const start = vis[i].id;
      let run = 1;
      while (
        i + run < vis.length &&
        vis[i + run].id.client === start.client &&
        vis[i + run].id.clock === start.clock + run
      ) run++;
      ops.push({ t: "tdel", id: this.next(), block, target: start, len: run });
      i += run;
    }
    for (const op of ops) this.apply(op);
    return ops;
  }

  /** Formats visible chars [from, to). value null removes the format. */
  format(block: OpId, from: number, to: number, key: string, value: string | null): Op | null {
    const b = this.block(block);
    const vis = this.visible(b);
    if (from >= to || from < 0 || to > vis.length) return null;
    return this.commit({
      t: "mark",
      id: this.next(),
      block,
      key,
      value,
      start: { char: vis[from].id, side: 0 },
      end: { char: vis[to - 1].id, side: 1 },
    });
  }

  /* ------------------------------------------------------------ view */

  /** Deterministic materialized view; identical across replicas once converged. */
  view(): DocView {
    const rootKey = idKey(ROOT);
    // resolve effective parent: hidden if parent missing/deleted; cycles attach to root
    const eff = new Map<string, string | null>();
    const resolve = (k: string): string | null => {
      if (eff.has(k)) return eff.get(k)!;
      const b = this.blocks.get(k)!;
      // detect cycle
      const visited = new Set<string>([k]);
      let cur = idKey(b.loc.value.parent);
      let result: string | null = idKey(b.loc.value.parent);
      while (cur !== rootKey) {
        if (visited.has(cur)) {
          result = rootKey;
          break;
        }
        visited.add(cur);
        const pb = this.blocks.get(cur);
        if (!pb || pb.deleted) {
          result = null;
          break;
        }
        cur = idKey(pb.loc.value.parent);
      }
      eff.set(k, result);
      return result;
    };
    const kids = new Map<string, Block[]>();
    for (const [k, b] of this.blocks) {
      if (k === rootKey || b.deleted) continue;
      const p = resolve(k);
      if (p === null) continue;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p)!.push(b);
    }
    for (const arr of kids.values()) {
      arr.sort((x, y) => {
        const a = x.loc.value.pos, c = y.loc.value.pos;
        if (a !== c) return a < c ? -1 : 1;
        return cmpId(x.id, y.id);
      });
    }
    const out: BlockView[] = [];
    const walk = (pk: string) => {
      for (const b of kids.get(pk) ?? []) {
        const k = idKey(b.id);
        // a block whose effective parent was rewritten to root by cycle-breaking
        out.push(this.blockView(b, pk));
        walk(k);
      }
    };
    walk(rootKey);
    return { blocks: out };
  }

  private blockView(b: Block, parentKey: string): BlockView {
    const props: Record<string, string> = {};
    for (const k of [...b.props.keys()].sort()) if (k !== "type") props[k] = b.props.get(k)!.value;
    const ord = this.order(b);
    const idx = new Map<string, number>();
    ord.forEach((c, i) => idx.set(idKey(c.id), i));
    const slot = (a: Anchor) => idx.get(idKey(a.char))! * 4 + (a.side === 0 ? 0 : 2);
    const marks = [...b.marks].sort((x, y) => cmpId(x.id, y.id)).map((m) => ({ m, s: slot(m.start), e: slot(m.end) }));
    const spans: Span[] = [];
    ord.forEach((c, i) => {
      if (c.deleted) return;
      const p = i * 4 + 1;
      const cur: Record<string, string | null> = {};
      for (const { m, s, e } of marks) if (s < p && p < e) cur[m.key] = m.value; // later ids win
      const mk: Record<string, string> = {};
      for (const k of Object.keys(cur).sort()) if (cur[k] !== null) mk[k] = cur[k]!;
      const last = spans[spans.length - 1];
      if (last && JSON.stringify(last.marks) === JSON.stringify(mk)) last.text += c.ch;
      else spans.push({ text: c.ch, marks: mk });
    });
    return { id: idKey(b.id), parent: parentKey, type: b.props.get("type")?.value ?? "", props, spans };
  }
}

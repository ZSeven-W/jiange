import { cmpId, eqId, idKey, ROOT, type OpId } from "./id";
import { keyBetween } from "./fracindex";
import { opSpan, type Anchor, type Op, type Side } from "./ops";
import { MAGIC, Reader, VERSION, Writer } from "./encoding";

export const STATE_TAG = 0x53;

/**
 * End-of-text sentinel anchor. A mark ending here keeps growing as text is
 * appended to the block (Peritext "expand" at the end of a block).
 */
export const END_ANCHOR: Anchor = Object.freeze({ char: ROOT, side: 0 as Side });

/** Marks that grow when text is typed at their end (Peritext expand rules). */
export const EXPANDING_MARKS = new Set(["bold", "italic", "underline", "strike", "color"]);

/** Byte-wise (UTF-8 order) comparison, identical to Go string comparison. */
function byteCmp(a: string, b: string): number {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(ea.length, eb.length); i++) if (ea[i] !== eb[i]) return ea[i] - eb[i];
  return ea.length - eb.length;
}

interface CharNode {
  id: OpId;
  ch: string;
  deleted: boolean;
  parent: CharNode | null;
  side: Side;
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
  const root: CharNode = { id: ROOT, ch: "", deleted: true, parent: null, side: 1, left: [], right: [] };
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
  client: number;
  private clock = 0;
  private blocks = new Map<string, Block>();
  private seen = new Set<string>();
  /** Opaque experimental-table sub-CRDT payloads per block (ttable ops). */
  private tables = new Map<string, { id: OpId; list: Uint8Array[] }>();
  private pending: Op[] = [];

  constructor(client: number) {
    if (!Number.isInteger(client) || client <= 0) throw new Error("client id must be a positive integer");
    this.client = client;
    this.blocks.set(idKey(ROOT), newBlock(ROOT, ROOT, ""));
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** IDs of causally buffered operations; callers cannot mutate the queue. */
  pendingIds(): OpId[] {
    return this.pending.map((op) => ({ ...op.id }));
  }

  /* ------------------------------------------------------------ apply */

  /** Applies a (remote or local) op. Returns true if it was new. */
  apply(op: Op): boolean {
    // Reserve every observed ID, including buffered ops. A local edit may be
    // made before those ops become causally ready (e.g. during reconnect).
    const span = Math.max(1, opSpan(op));
    if (!Number.isSafeInteger(op.id.clock) || op.id.clock < 0 || span - 1 > Number.MAX_SAFE_INTEGER - op.id.clock) {
      throw new RangeError("operation clock exceeds safe integer range");
    }
    this.clock = Math.max(this.clock, op.id.clock + (span - 1));
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
    switch (op.t) {
      case "bcreate": {
        if (this.blocks.has(idKey(op.id))) return; // idempotent (e.g. after loading a snapshot)
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
        if (b.chars.has(idKey(op.id))) return; // idempotent
        let parent = b.chars.get(idKey(op.parent))!;
        let side: Side = op.side;
        let i = 0;
        for (const ch of op.text) {
          const n: CharNode = { id: { client: op.id.client, clock: op.id.clock + i }, ch, deleted: false, parent, side, left: [], right: [] };
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
        if (b.marks.some((m) => eqId(m.id, op.id))) return;
        b.marks.push({ id: op.id, key: op.key, value: op.value, start: op.start, end: op.end });
        return;
      }
      case "ttable": {
        // 不透明表格子 CRDT 载荷：按块保存，语义属于表格模型（准入在上游）。
        const key = idKey(op.block);
        const entry = this.tables.get(key) ?? { id: op.block, list: [] };
        entry.list.push(op.payload.slice());
        this.tables.set(key, entry);
        return;
      }
    }
  }

  /** 该副本是否携带表格载荷（状态 v2）；v1 对端不可加入此类文档。 */
  hasTables(): boolean {
    for (const e of this.tables.values()) if (e.list.length) return true;
    return false;
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
    if (!Number.isSafeInteger(span) || span < 1 || span > Number.MAX_SAFE_INTEGER - this.clock) {
      throw new RangeError("operation clock exceeds safe integer range");
    }
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

  /** Reserve `count` document-unique operation IDs for a sub-CRDT (e.g. the
   * experimental table). Allocation advances the Lamport clock; applying
   * remote operations already moves it past every observed ID. Validate
   * admission limits BEFORE reserving — the table's limit errors are atomic
   * and must not consume IDs. */
  allocateOpIds(count = 1): OpId[] {
    if (!Number.isSafeInteger(count) || count < 1 || count > Number.MAX_SAFE_INTEGER - this.clock) {
      throw new RangeError("operation clock exceeds safe integer range");
    }
    const first = this.next(count);
    return Array.from({ length: count }, (_, i) => ({ client: first.client, clock: first.clock + i }));
  }

  /** True if the block exists and is not deleted. */
  hasBlock(id: OpId): boolean {
    const b = this.blocks.get(idKey(id));
    return !!b && !b.deleted;
  }

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

  /**
   * Formats visible chars [from, to). value null removes the format.
   * Peritext anchoring: the span starts *before* its first char (text typed in
   * front is not formatted); an expanding mark ends *before the next char*
   * (or at END_ANCHOR), so text typed at its end inherits it, while a
   * non-expanding mark (link, code) ends *after* its last char.
   */
  format(block: OpId, from: number, to: number, key: string, value: string | null, expand = EXPANDING_MARKS.has(key)): Op | null {
    const b = this.block(block);
    const vis = this.visible(b);
    if (from >= to || from < 0 || to > vis.length) return null;
    const end: Anchor = !expand
      ? { char: vis[to - 1].id, side: 1 }
      : to < vis.length
        ? { char: vis[to].id, side: 0 }
        : END_ANCHOR;
    return this.commit({ t: "mark", id: this.next(), block, key, value, start: { char: vis[from].id, side: 0 }, end });
  }

  /** Ids of the visible chars of a block, in order. */
  visibleIds(block: OpId): OpId[] {
    return this.visible(this.block(block)).map((c) => c.id);
  }

  /** Per-character text and marks of a block. */
  richChars(block: OpId): { ch: string; marks: Record<string, string> }[] {
    const out: { ch: string; marks: Record<string, string> }[] = [];
    for (const sp of this.blockView(this.block(block), "").spans) for (const ch of sp.text) out.push({ ch, marks: sp.marks });
    return out;
  }

  /** Type, props and parent of a block. */
  blockInfo(block: OpId): { type: string; props: Record<string, string>; parent: OpId } {
    const b = this.block(block);
    const props: Record<string, string> = {};
    for (const [k, v] of b.props) if (k !== "type") props[k] = v.value;
    return { type: b.props.get("type")?.value ?? "", props, parent: b.loc.value.parent };
  }

  /** Identity of the winning write, including writes that repeat the same value. */
  propVersion(block: OpId, key: string): OpId | null {
    const ts = this.block(block).props.get(key)?.ts;
    return ts ? { ...ts } : null;
  }

  /** Current Lamport clock (highest clock observed or generated). */
  get lamport(): number {
    return this.clock;
  }

  /** Visible block ids in document order. */
  blockIds(): OpId[] {
    return this.view().blocks.map((b) => {
      const [c, k] = b.id.split(":");
      return { client: Number(c), clock: Number(k) };
    });
  }

  /** Stable position for a caret at visible `index` (survives concurrent edits). */
  anchorAt(block: OpId, index: number): Anchor {
    const vis = this.visible(this.block(block));
    if (index <= 0 || vis.length === 0) return { char: ROOT, side: 1 };
    return { char: vis[Math.min(index, vis.length) - 1].id, side: 1 };
  }

  /** Visible index of an anchor; unknown anchors resolve to the end. */
  resolveAnchor(block: OpId, a: Anchor): number {
    const b = this.blocks.get(idKey(block));
    if (!b) return 0;
    if (eqId(a.char, ROOT)) return 0;
    const target = b.chars.get(idKey(a.char));
    const ord = this.order(b);
    if (!target) return ord.filter((c) => !c.deleted).length;
    let n = 0;
    for (const c of ord) {
      if (c === target) return n + (!c.deleted && a.side === 1 ? 1 : 0);
      if (!c.deleted) n++;
    }
    return n;
  }

  /** Drops buffered ops that can never apply (used after resync). Returns how many were dropped. */
  dropPending(): number {
    const n = this.pending.length;
    this.pending = [];
    return n;
  }

  /* ------------------------------------------------------------ state (snapshot) encoding */

  /** Encodes the full replica state (spec/PROTOCOL.md §State). */
  encodeState(): Uint8Array {
    const w = new Writer();
    // 无表格文档保持 v1 字节不变；含表格载荷才升 v2（读取端两者皆收）。
    const stateVersion = this.hasTables() ? 2 : 1;
    w.u8(MAGIC);
    w.u8(STATE_TAG);
    w.u8(stateVersion);
    w.uvar(this.clock);
    const blocks = [...this.blocks.values()].filter((b) => !eqId(b.id, ROOT)).sort((x, y) => cmpId(x.id, y.id));
    w.uvar(blocks.length);
    for (const b of blocks) {
      w.id(b.id);
      w.id(b.loc.value.parent);
      w.str(b.loc.value.pos);
      w.id(b.loc.ts);
      w.u8(b.deleted ? 1 : 0);
      const keys = [...b.props.keys()].sort(byteCmp);
      w.uvar(keys.length);
      for (const k of keys) {
        const r = b.props.get(k)!;
        w.str(k);
        w.str(r.value);
        w.id(r.ts);
      }
      // chars in pre-order (node, left subtrees, right subtrees): parents precede children
      const list: CharNode[] = [];
      const index = new Map<CharNode, number>([[b.root, 0]]);
      const stack: CharNode[] = [...b.root.right].reverse().concat([...b.root.left].reverse());
      while (stack.length) {
        const n = stack.pop()!;
        list.push(n);
        index.set(n, list.length);
        for (let i = n.right.length - 1; i >= 0; i--) stack.push(n.right[i]);
        for (let i = n.left.length - 1; i >= 0; i--) stack.push(n.left[i]);
      }
      w.uvar(list.length);
      for (const n of list) {
        w.id(n.id);
        w.u8(n.side);
        w.uvar(index.get(n.parent!)!);
        w.u8(n.deleted ? 1 : 0);
        w.str(n.ch);
      }
      const marks = [...b.marks].sort((x, y) => cmpId(x.id, y.id));
      w.uvar(marks.length);
      for (const m of marks) {
        w.id(m.id);
        w.str(m.key);
        if (m.value === null) w.u8(0);
        else {
          w.u8(1);
          w.str(m.value);
        }
        w.id(m.start.char);
        w.u8(m.start.side);
        w.id(m.end.char);
        w.u8(m.end.side);
      }
    }
    if (stateVersion === 2) {
      // v2 段：按块的表格载荷，块按 id 序保证字节确定性。
      const entries = [...this.tables.values()].filter((e) => e.list.length > 0).sort((a, b) => cmpId(a.id, b.id));
      w.uvar(entries.length);
      for (const e of entries) {
        w.id(e.id);
        w.uvar(e.list.length);
        for (const payload of e.list) w.blob(payload);
      }
    }
    return w.bytes();
  }

  /** Rebuilds a replica from `encodeState` output. */
  static fromState(client: number, bytes: Uint8Array): Doc {
    const d = new Doc(client);
    const r = new Reader(bytes);
    if (r.u8() !== MAGIC || r.u8() !== STATE_TAG) throw new RangeError("not a state blob");
    const stateVersion = r.u8();
    if (stateVersion !== 1 && stateVersion !== 2) throw new RangeError(`unsupported state version ${stateVersion}`);
    d.clock = r.uvar();
    if (!Number.isSafeInteger(d.clock)) throw new RangeError("state clock exceeds safe integer range");
    const nb = r.uvar();
    for (let i = 0; i < nb; i++) {
      const id = r.id();
      const parent = r.id();
      const pos = r.str();
      const ts = r.id();
      const b = newBlock(id, parent, pos);
      b.loc.ts = ts;
      b.deleted = r.u8() === 1;
      const np = r.uvar();
      for (let k = 0; k < np; k++) {
        const key = r.str();
        const value = r.str();
        b.props.set(key, { value, ts: r.id() });
      }
      const nc = r.uvar();
      const list: CharNode[] = [b.root];
      for (let k = 0; k < nc; k++) {
        const cid = r.id();
        const side = r.u8();
        const pi = r.uvar();
        const deleted = r.u8() === 1;
        const ch = r.str();
        if ((side !== 0 && side !== 1) || pi >= list.length) throw new RangeError("corrupt state");
        const parentNode = list[pi];
        const n: CharNode = { id: cid, ch, deleted, parent: parentNode, side: side as Side, left: [], right: [] };
        insertSorted(side === 0 ? parentNode.left : parentNode.right, n);
        b.chars.set(idKey(cid), n);
        list.push(n);
      }
      const nm = r.uvar();
      for (let k = 0; k < nm; k++) {
        const mid = r.id();
        const key = r.str();
        const has = r.u8();
        const value = has ? r.str() : null;
        const sc = r.id();
        const ss = r.u8() as Side;
        const ec = r.id();
        const es = r.u8() as Side;
        b.marks.push({ id: mid, key, value, start: { char: sc, side: ss }, end: { char: ec, side: es } });
      }
      d.blocks.set(idKey(id), b);
    }
    if (stateVersion === 2) {
      const nt = r.uvar();
      for (let i = 0; i < nt; i++) {
        const id = r.id();
        const key = idKey(id);
        if (!d.blocks.has(key)) throw new RangeError(`table payloads for unknown block ${key}`);
        const np = r.uvar();
        const list: Uint8Array[] = [];
        for (let k = 0; k < np; k++) list.push(r.blob());
        d.tables.set(key, { id, list });
      }
    }
    if (!r.done) throw new RangeError("trailing bytes in state");
    return d;
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
    const slot = (a: Anchor) =>
      a.side === 0 && eqId(a.char, ROOT) ? Number.MAX_SAFE_INTEGER : idx.get(idKey(a.char))! * 4 + (a.side === 0 ? 0 : 2);
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

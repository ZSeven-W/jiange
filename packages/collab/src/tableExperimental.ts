import { cmpId, idKey, type OpId } from "./id";
import { parseTableSnapshotJson } from "./tableStrictJson";

/**
 * Experimental, transport-independent table CRDT. This is deliberately not
 * exported by the package or used by the document editor. Its operation and
 * snapshot formats are not a compatibility contract for deployed clients.
 *
 * Rows, columns and characters have stable globally unique operation IDs.
 * A row/column delete tombstones its ID; delayed edits remain recoverable via
 * cellText(..., true), but do not make the deleted row/column visible again.
 * Each text insertion carries one Unicode scalar, so it consumes one ID.
 * The eventual client/protocol must allocate IDs unique across the document
 * and advance its Lamport clock past every observed operation; this prototype
 * accepts externally assigned IDs and does not implement that allocator.
 *
 * Operations with missing dependencies are retained, including in snapshots.
 * The first missing dependency is indexed for wake-up. A cycle of known
 * pending dependencies is rejected; an absent dependency remains pending.
 * Admission budgets reserve rows, columns and characters even for pending
 * or rejected operations. A limit error is atomic and reserves no ID, but
 * replicas near a limit can admit different subsets in different orders: an
 * authoritative transport must decide admission before broadcasting ops.
 * No garbage collection is performed: safe GC requires a separately proven
 * causal horizon and recovery protocol. Raw transport frames also require an
 * independent byte limit; this object API measures a decoded-op budget.
 */
export type TableAxis = "row" | "column";
export type TableOp =
  | { kind: "axis-insert"; id: OpId; axis: TableAxis; after: OpId | null }
  | { kind: "axis-delete"; id: OpId; axis: TableAxis; target: OpId }
  | { kind: "text-insert"; id: OpId; row: OpId; column: OpId; after: OpId | null; char: string }
  | { kind: "text-delete"; id: OpId; row: OpId; column: OpId; target: OpId };

type Node = { id: OpId; after: OpId | null; deleted: boolean };
type TextNode = Node & { char: string };
type Cell = { chars: Map<string, TextNode> };
type Entry = { op: TableOp; signature: string; state: "pending" | "applied" | "rejected"; reason?: string };
type Dependency = { kind: "ready" } | { kind: "missing"; key: string } | { kind: "rejected"; reason: string };

/** Local admission budgets, not a distributed consensus or a wire format. */
export interface TableLimits {
  maxRows: number;
  maxColumns: number;
  maxGridCells: number;
  maxCharactersPerCell: number;
  maxOperations: number;
  maxPending: number;
  maxOperationBytes: number;
  maxSnapshotBytes: number;
}
export const DEFAULT_TABLE_LIMITS: Readonly<TableLimits> = Object.freeze({
  maxRows: 10000, maxColumns: 256, maxGridCells: 1000000,
  maxCharactersPerCell: 100000, maxOperations: 200000, maxPending: 10000,
  maxOperationBytes: 512, maxSnapshotBytes: 33554432,
});
const SNAPSHOT_OVERHEAD = 22;
const byteLength = (text: string) => new TextEncoder().encode(text).length;
function validateLimits(limits: TableLimits): TableLimits {
  const result = { ...limits };
  exactKeys(result, Object.keys(DEFAULT_TABLE_LIMITS));
  for (const n of Object.values(result)) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError("table limits must be positive safe integers");
  }
  if (result.maxSnapshotBytes < SNAPSHOT_OVERHEAD) throw new RangeError("table resource limit: maxSnapshotBytes");
  return result;
}
function operationBudget(op: TableOp): number {
  // A deliberately conservative decoded-operation budget, not a network frame
  // length. It bounds canonical JSON including escaping of any Unicode scalar.
  let ids = 1;
  if (op.kind === "axis-insert") ids += op.after === null ? 0 : 1;
  else if (op.kind === "axis-delete") ids++;
  else if (op.kind === "text-insert") ids += 2 + (op.after === null ? 0 : 1);
  else ids += 3;
  return 128 + 64 * ids + (op.kind === "text-insert" ? byteLength(op.char) : 0);
}

function exactKeys(input: object, keys: string[]): void {
  const actual = Object.keys(input).sort();
  if (actual.length !== keys.length || keys.slice().sort().some((key, i) => actual[i] !== key)) throw new TypeError("unsupported table operation fields");
}
function validateId(id: OpId): void {
  if (!id || typeof id !== "object" || Array.isArray(id)) throw new TypeError("invalid table operation ID");
  exactKeys(id, ["client", "clock"]);
  if (!Number.isSafeInteger(id.client) || id.client <= 0 || !Number.isSafeInteger(id.clock) || id.clock <= 0) {
    throw new TypeError("table operation IDs must be positive safe integers");
  }
}

function sameId(a: OpId, b: OpId | null): boolean {
  return !!b && a.client === b.client && a.clock === b.clock;
}

function copyId(id: OpId): OpId { return { client: id.client, clock: id.clock }; }
function optId(id: OpId | null): OpId | null { return id === null ? null : copyId(id); }
function cellKey(row: OpId, column: OpId): string { return `${idKey(row)}/${idKey(column)}`; }

/** Copy and validate incoming data so caller mutation cannot corrupt history. */
function normalize(input: TableOp): TableOp {
  if (!input || typeof input !== "object") throw new TypeError("invalid table operation");
  validateId(input.id);
  switch (input.kind) {
    case "axis-insert": {
      exactKeys(input, ["kind", "id", "axis", "after"]);
      if (input.axis !== "row" && input.axis !== "column") throw new TypeError("invalid table axis");
      if (input.after !== null) validateId(input.after);
      if (sameId(input.id, input.after)) throw new TypeError("axis cannot follow itself");
      return { kind: input.kind, id: copyId(input.id), axis: input.axis, after: optId(input.after) };
    }
    case "axis-delete": {
      exactKeys(input, ["kind", "id", "axis", "target"]);
      if (input.axis !== "row" && input.axis !== "column") throw new TypeError("invalid table axis");
      validateId(input.target);
      if (sameId(input.id, input.target)) throw new TypeError("delete cannot target itself");
      return { kind: input.kind, id: copyId(input.id), axis: input.axis, target: copyId(input.target) };
    }
    case "text-insert": {
      exactKeys(input, ["kind", "id", "row", "column", "after", "char"]);
      validateId(input.row); validateId(input.column);
      if (input.after !== null) validateId(input.after);
      if (sameId(input.id, input.after) || sameId(input.id, input.row) || sameId(input.id, input.column)) throw new TypeError("invalid text identity");
      if (typeof input.char !== "string" || [...input.char].length !== 1) throw new TypeError("text insertion must contain one Unicode scalar");
      const code = input.char.codePointAt(0)!;
      if (code >= 0xd800 && code <= 0xdfff) throw new TypeError("unpaired surrogate is not a Unicode scalar");
      return { kind: input.kind, id: copyId(input.id), row: copyId(input.row), column: copyId(input.column), after: optId(input.after), char: input.char };
    }
    case "text-delete": {
      exactKeys(input, ["kind", "id", "row", "column", "target"]);
      validateId(input.row); validateId(input.column); validateId(input.target);
      if (sameId(input.id, input.target) || sameId(input.id, input.row) || sameId(input.id, input.column)) throw new TypeError("invalid delete identity");
      return { kind: input.kind, id: copyId(input.id), row: copyId(input.row), column: copyId(input.column), target: copyId(input.target) };
    }
    default: throw new TypeError("unknown table operation");
  }
}

/** Newer siblings sort first, so inserting after an anchor precedes its older successor. */
function ordered<T extends Node>(nodes: Map<string, T>): T[] {
  const children = new Map<string, T[]>();
  for (const n of nodes.values()) {
    const key = n.after === null ? "" : idKey(n.after);
    const siblings = children.get(key) ?? [];
    siblings.push(n); children.set(key, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => cmpId(b.id, a.id));
  const out: T[] = [];
  const stack = [...(children.get("") ?? [])].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    const nested = children.get(idKey(n.id)) ?? [];
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]);
  }
  return out;
}

export class ExperimentalTable {
  private rows = new Map<string, Node>();
  private columns = new Map<string, Node>();
  private cells = new Map<string, Cell>();
  /** Includes applied, buffered and rejected operations to detect identity reuse. */
  private entries = new Map<string, Entry>();
  private readonly limits: TableLimits;
  private pending = 0;
  private reservedRows = 0;
  private reservedColumns = 0;
  private reservedCharacters = new Map<string, number>();
  private reservedSnapshotBytes = SNAPSHOT_OVERHEAD;
  /** Each pending operation is indexed by its first missing dependency. */
  private waiters = new Map<string, Set<string>>();
  private blockedOn = new Map<string, string>();
  // Union-find is an over-approximation after edges are removed. It cheaply
  // excludes cycles for disconnected components; possible cycles are checked
  // against the current directed graph before rejecting anything.
  private components = new Map<string, string>();
  private ranks = new Map<string, number>();

  constructor(limits: TableLimits = DEFAULT_TABLE_LIMITS) {
    this.limits = validateLimits(limits);
  }

  get pendingCount(): number { return this.pending; }
  get rejected(): { id: OpId; reason: string }[] {
    return [...this.entries.values()].filter((e) => e.state === "rejected")
      .map((e) => ({ id: copyId(e.op.id), reason: e.reason! })).sort((a, b) => cmpId(a.id, b.id));
  }

  /** Returns false only for an exact retry; reusing an ID for other bytes throws. */
  apply(input: TableOp): boolean {
    return this.admit(input, this.limits.maxPending);
  }

  private admit(input: TableOp, pendingLimit: number): boolean {
    const op = normalize(input), key = idKey(op.id), signature = JSON.stringify(op);
    const old = this.entries.get(key);
    if (old) {
      if (old.signature !== signature) throw new Error(`table operation identity conflict: ${key}`);
      return false;
    }
    const budget = operationBudget(op);
    const fail = (name: keyof TableLimits): never => { throw new RangeError(`table resource limit: ${name}`); };
    if (budget > this.limits.maxOperationBytes) fail("maxOperationBytes");
    if (this.entries.size >= this.limits.maxOperations) fail("maxOperations");
    if (this.reservedSnapshotBytes + budget + 1 > this.limits.maxSnapshotBytes) fail("maxSnapshotBytes");
    let rows = this.reservedRows, columns = this.reservedColumns;
    if (op.kind === "axis-insert") {
      if (op.axis === "row") { if (++rows > this.limits.maxRows) fail("maxRows"); }
      else if (++columns > this.limits.maxColumns) fail("maxColumns");
      if (rows && columns > Math.floor(this.limits.maxGridCells / rows)) fail("maxGridCells");
    }
    if (op.kind === "text-insert" && (this.reservedCharacters.get(cellKey(op.row, op.column)) ?? 0) >= this.limits.maxCharactersPerCell) fail("maxCharactersPerCell");
    const state = this.dependency(op);
    if (state.kind === "missing" && this.pending >= pendingLimit) fail("maxPending");
    this.reservedRows = rows; this.reservedColumns = columns;
    this.reservedSnapshotBytes += budget + 1;
    if (op.kind === "text-insert") {
      const cell = cellKey(op.row, op.column);
      this.reservedCharacters.set(cell, (this.reservedCharacters.get(cell) ?? 0) + 1);
    }
    const entry: Entry = { op, signature, state: state.kind === "ready" ? "applied" : state.kind === "missing" ? "pending" : "rejected", ...(state.kind === "rejected" ? { reason: state.reason } : {}) };
    this.entries.set(key, entry);
    const queue = [key], cycles: string[] = [];
    if (state.kind === "ready") this.integrate(op);
    else if (state.kind === "missing") { this.pending++; this.registerWait(key, state.key, cycles); }
    this.wake(queue, cycles);
    return true;
  }

  private axisMap(axis: TableAxis): Map<string, Node> { return axis === "row" ? this.rows : this.columns; }
  private knownWrongType(id: OpId, expected: "row" | "column" | string): boolean {
    const entry = this.entries.get(idKey(id));
    if (!entry) return false;
    if (entry.state === "rejected") return true;
    const op = entry.op;
    if (expected === "row" || expected === "column") return op.kind !== "axis-insert" || op.axis !== expected;
    return op.kind !== "text-insert" || cellKey(op.row, op.column) !== expected;
  }
  private dependency(op: TableOp): Dependency {
    if (op.kind === "axis-insert" || op.kind === "axis-delete") {
      const dep = op.kind === "axis-insert" ? op.after : op.target;
      if (dep === null || this.axisMap(op.axis).has(idKey(dep))) return { kind: "ready" };
      return this.knownWrongType(dep, op.axis) ? { kind: "rejected", reason: "axis dependency has wrong type" } : { kind: "missing", key: idKey(dep) };
    }
    for (const [id, axis] of [[op.row, "row"], [op.column, "column"]] as const) {
      if (!this.axisMap(axis).has(idKey(id))) return this.knownWrongType(id, axis) ? { kind: "rejected", reason: "cell axis has wrong type" } : { kind: "missing", key: idKey(id) };
    }
    const cell = cellKey(op.row, op.column), dep = op.kind === "text-insert" ? op.after : op.target;
    if (dep === null || this.cells.get(cell)?.chars.has(idKey(dep))) return { kind: "ready" };
    return this.knownWrongType(dep, cell) ? { kind: "rejected", reason: "character dependency belongs to another cell" } : { kind: "missing", key: idKey(dep) };
  }
  private integrate(op: TableOp): void {
    if (op.kind === "axis-insert") {
      this.axisMap(op.axis).set(idKey(op.id), { id: op.id, after: op.after, deleted: false });
    } else if (op.kind === "axis-delete") {
      this.axisMap(op.axis).get(idKey(op.target))!.deleted = true;
    } else {
      const key = cellKey(op.row, op.column);
      let cell = this.cells.get(key);
      if (!cell) { cell = { chars: new Map() }; this.cells.set(key, cell); }
      if (op.kind === "text-insert") cell.chars.set(idKey(op.id), { id: op.id, after: op.after, char: op.char, deleted: false });
      else cell.chars.get(idKey(op.target))!.deleted = true;
    }
  }
  private component(key: string): string {
    if (!this.components.has(key)) this.components.set(key, key);
    let root = key;
    while (this.components.get(root)! !== root) root = this.components.get(root)!;
    while (key !== root) { const next = this.components.get(key)!; this.components.set(key, root); key = next; }
    return root;
  }
  private unindex(key: string): void {
    const dependency = this.blockedOn.get(key);
    if (dependency === undefined) return;
    const set = this.waiters.get(dependency);
    set?.delete(key);
    if (set?.size === 0) this.waiters.delete(dependency);
    this.blockedOn.delete(key);
  }
  private registerWait(key: string, dependency: string, cycles: string[]): void {
    this.blockedOn.set(key, dependency);
    let set = this.waiters.get(dependency);
    if (!set) { set = new Set(); this.waiters.set(dependency, set); }
    set.add(key);
    let left = this.component(key), right = this.component(dependency);
    if (left !== right) {
      if ((this.ranks.get(left) ?? 0) < (this.ranks.get(right) ?? 0)) [left, right] = [right, left];
      this.components.set(right, left);
      if ((this.ranks.get(left) ?? 0) === (this.ranks.get(right) ?? 0)) this.ranks.set(left, (this.ranks.get(left) ?? 0) + 1);
      return;
    }
    // Resolve all queued wake-ups before checking this candidate. A newly
    // arrived operation can make an existing waiting edge the wrong type; a
    // cycle check before that wake-up would misclassify both operations.
    cycles.push(key);
  }
  private rejectCycle(key: string, queue: string[]): void {
    // The undirected component may contain stale edges; only reject a cycle
    // after traversing the live directed edges and identifying its members.
    const positions = new Map<string, number>(), path: string[] = [];
    let cursor: string | undefined = key;
    while (cursor !== undefined && !positions.has(cursor)) {
      positions.set(cursor, path.length); path.push(cursor); cursor = this.blockedOn.get(cursor);
    }
    if (cursor === undefined) return;
    for (const member of path.slice(positions.get(cursor)!)) {
      const entry = this.entries.get(member);
      if (!entry || entry.state !== "pending") continue;
      this.unindex(member); this.pending--;
      entry.state = "rejected"; entry.reason = "cyclic dependency"; queue.push(member);
    }
  }
  private wake(queue: string[], cycles: string[]): void {
    let i = 0, candidate = 0;
    while (i < queue.length || candidate < cycles.length) {
      if (i >= queue.length) { this.rejectCycle(cycles[candidate++], queue); continue; }
      const dependents = [...(this.waiters.get(queue[i]) ?? [])]
        .sort((a, b) => cmpId(this.entries.get(a)!.op.id, this.entries.get(b)!.op.id));
      i++;
      for (const key of dependents) {
        const entry = this.entries.get(key)!;
        if (entry.state !== "pending") continue;
        this.unindex(key);
        const state = this.dependency(entry.op);
        if (state.kind === "missing") this.registerWait(key, state.key, cycles);
        else {
          this.pending--;
          if (state.kind === "ready") { entry.state = "applied"; this.integrate(entry.op); }
          else { entry.state = "rejected"; entry.reason = state.reason; }
          queue.push(key);
        }
      }
    }
  }

  axisIds(axis: TableAxis, includeDeleted = false): OpId[] {
    return ordered(this.axisMap(axis)).filter((n) => includeDeleted || !n.deleted).map((n) => copyId(n.id));
  }
  cellText(row: OpId, column: OpId, includeDeleted = false): string | null {
    const r = this.rows.get(idKey(row)), c = this.columns.get(idKey(column));
    if (!r || !c || (!includeDeleted && (r.deleted || c.deleted))) return null;
    return ordered(this.cells.get(cellKey(row, column))?.chars ?? new Map<string, TextNode>()).filter((n) => !n.deleted).map((n) => n.char).join("");
  }
  view(): string[][] {
    const cols = this.axisIds("column");
    return this.axisIds("row").map((row) => cols.map((column) => this.cellText(row, column)!));
  }

  /** Prototype snapshot retains the complete operation ledger and pending ops. */
  snapshot(): string {
    const result = JSON.stringify({ version: 1, ops: [...this.entries.values()].map((e) => e.op).sort((a, b) => cmpId(a.id, b.id)) });
    if (byteLength(result) > this.limits.maxSnapshotBytes) throw new RangeError("table resource limit: maxSnapshotBytes");
    return result;
  }
  static fromSnapshot(snapshot: string, limits: TableLimits = DEFAULT_TABLE_LIMITS): ExperimentalTable {
    const checked = validateLimits(limits);
    if (typeof snapshot !== "string") throw new TypeError("snapshot must be text");
    if (snapshot.length > checked.maxSnapshotBytes || byteLength(snapshot) > checked.maxSnapshotBytes) throw new RangeError("table resource limit: maxSnapshotBytes");
    const parsed = parseTableSnapshotJson(snapshot, checked.maxOperations);
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1 || !Array.isArray((parsed as { ops?: unknown }).ops)) {
      throw new TypeError("invalid experimental table snapshot");
    }
    exactKeys(parsed, ["version", "ops"]);
    const table = new ExperimentalTable(checked);
    // The canonical snapshot order may place dependencies after dependents.
    // Bound transient pending by the total ledger limit; validate the final
    // pending count against the configured admission limit before returning.
    for (const op of (parsed as { ops: TableOp[] }).ops) table.admit(op, checked.maxOperations);
    if (table.pending > checked.maxPending) throw new RangeError("table resource limit: maxPending");
    return table;
  }
}

import { idKey, Tx, type Doc, type Op, type OpId, type UndoManager } from "@jiange/collab";
import { tableDataOf } from "./table-cells";

type Change = { key: string; before: string; after: string };
type Entry = { block: OpId; changes: Change[]; expected: string; other?: string };
type Transition = { before: string; after: string };
type Transitions = { undo: (Transition | null)[]; redo: (Transition | null)[] };

/** Capture all table registers, including hidden cells, and paragraph text after whole-table deletion. */
function guard(doc: Doc, block: OpId): string {
  const info = doc.blockInfo(block);
  const keys = new Set(["type", "tableData", "tableMerges", "tableWidths", "tableHeader", "tableHeaderColumn", ...Object.keys(info.props).filter((key) => key.startsWith("tbl."))]);
  const versions = [...keys].sort().map((key) => {
    const version = doc.propVersion(block, key);
    return [key, version ? idKey(version) : null];
  });
  return JSON.stringify([versions, tableDataOf(info.props), doc.visibleIds(block).map(idKey), doc.richChars(block)]);
}

/** Only a known local inverse may advance register versions without changing logical state. */
function restored(logical: string, actual: string, ops: Op[], block: OpId, structuralKeys?: Set<string>): boolean {
  const [oldVersions, ...oldContent] = JSON.parse(logical) as [Array<[string, string | null]>, ...unknown[]];
  const [newVersions, ...newContent] = JSON.parse(actual) as [Array<[string, string | null]>, ...unknown[]];
  if (JSON.stringify(oldContent) !== JSON.stringify(newContent)) return false;
  const changed = new Map<string, string>();
  for (const op of ops) {
    if (op.t !== "bset" || idKey(op.block) !== idKey(block) || (structuralKeys ? !structuralKeys.has(op.key) : !(op.key === "tableData" || op.key === "tbl.m" || op.key.startsWith("tbl.c.")))) return false;
    changed.set(op.key, idKey(op.id));
  }
  const before = new Map(oldVersions), after = new Map(newVersions);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (changed.has(key)) { if (after.get(key) !== changed.get(key)) return false; }
    else if ((before.get(key) ?? null) !== (after.get(key) ?? null)) return false;
  }
  return true;
}

function historyVersions(snapshot: string): { data: string | null; guard: string } {
  const [versions] = JSON.parse(snapshot) as [Array<[string, string | null]>];
  const map = new Map(versions);
  return { data: map.get("tableData") ?? null, guard: `${map.get("type") ?? "-"}|${map.get("tableMerges") ?? "-"}` };
}

/** Rebase unchanged cell registers across adjacent local inverses, preserving axis identity. */
function rebaseSnapshot(snapshot: string, logical: string, actual: string, ops: Op[]): string {
  if (snapshot === logical) return actual;
  const [versions, ...content] = JSON.parse(snapshot) as [Array<[string, string | null]>, ...unknown[]];
  const [logicalVersions] = JSON.parse(logical) as [Array<[string, string | null]>];
  const [actualVersions] = JSON.parse(actual) as [Array<[string, string | null]>];
  const current = new Map(versions), old = new Map(logicalVersions), next = new Map(actualVersions);
  for (const key of ["type", "tableMerges", "tbl.v", "tbl.base", "tbl.rows", "tbl.cols"]) {
    if ((current.get(key) ?? null) !== (old.get(key) ?? null)) return snapshot;
  }
  for (const op of ops) {
    if (op.t !== "bset" || !op.key.startsWith("tbl.c.")) continue;
    if ((current.get(op.key) ?? null) === (old.get(op.key) ?? null) && next.has(op.key)) current.set(op.key, next.get(op.key)!);
  }
  return JSON.stringify([[...current].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), ...content]);
}

/** Rebase history snapshots that share the restored structure's register versions. */
function rebaseStructureSnapshot(snapshot: string, logical: string, actual: string, ops: Op[]): string {
  if (snapshot === logical) return actual;
  const [versions, ...content] = JSON.parse(snapshot) as [Array<[string, string | null]>, ...unknown[]];
  const [logicalVersions] = JSON.parse(logical) as [Array<[string, string | null]>];
  const [actualVersions] = JSON.parse(actual) as [Array<[string, string | null]>];
  const current = new Map(versions), old = new Map(logicalVersions), next = new Map(actualVersions);
  for (const key of ["type", "tableMerges", "tbl.v", "tbl.base", "tbl.rows", "tbl.cols"]) {
    if ((current.get(key) ?? null) !== (old.get(key) ?? null)) return snapshot;
  }
  for (const op of ops) {
    if (op.t !== "bset") continue;
    if ((current.get(op.key) ?? null) === (old.get(op.key) ?? null) && next.has(op.key)) current.set(op.key, next.get(op.key)!);
  }
  return JSON.stringify([[...current].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), ...content]);
}

/** Local, guarded undo for a selection deletion that changes table structure. */
export class TableStructureHistory {
  private next = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly transitions = new Map<string, Transitions>();

  /** Capture the table before a known structural/property action for adjacent undo rebasing. */
  snapshot(doc: Doc, block: OpId): string | null {
    return doc.hasBlock(block) ? guard(doc, block) : null;
  }

  private hasLiveStructure<S>(block: OpId, undo: UndoManager<S>): boolean {
    return [...this.entries].some(([key, entry]) => idKey(entry.block) === idKey(block) && undo.hasMarker(key));
  }

  /** Capture only while this table has a live structural history entry. */
  capture<S>(doc: Doc, block: OpId, undo: UndoManager<S>): string | null {
    return this.hasLiveStructure(block, undo) ? guard(doc, block) : null;
  }

  /** Track the exact local states bracketing a cell or paste history entry. */
  recordEdit<S>(doc: Doc, block: OpId, key: string, before: string | null, merged: boolean, undo: UndoManager<S>): void {
    if (before === null || !this.hasLiveStructure(block, undo)) { this.transitions.delete(key); return; }
    let history = this.transitions.get(key);
    if (!history) { history = { undo: [], redo: [] }; this.transitions.set(key, history); }
    const after = guard(doc, block), last = history.undo.at(-1);
    if (merged) {
      if (last && last.after === before) last.after = after;
      else if (history.undo.length) history.undo[history.undo.length - 1] = null;
      else history.undo.push(null);
    } else {
      history.undo.push({ before, after });
      if (history.undo.length > 500) history.undo.shift();
    }
    history.redo = [];
  }

  /** Refuse a tracked cell undo if any table register changed since that edit. */
  beforeEditStep(doc: Doc, block: OpId, key: string, redo: boolean): "untracked" | "ready" | "conflict" {
    const history = this.transitions.get(key), item = (redo ? history?.redo : history?.undo)?.at(-1);
    if (!item) return "untracked";
    return doc.hasBlock(block) && guard(doc, block) === (redo ? item.before : item.after) ? "ready" : "conflict";
  }

  /** Map logical snapshots to versions produced by a verified local inverse. */
  afterEditStep(doc: Doc, block: OpId, key: string, redo: boolean, ops: Op[]): void {
    const history = this.transitions.get(key);
    if (!history) return;
    const from = redo ? history.redo : history.undo, to = redo ? history.undo : history.redo;
    if (!from.length) return;
    const item = from.pop();
    if (!item || !doc.hasBlock(block)) { to.push(null); return; }
    const logical = redo ? item.after : item.before, actual = guard(doc, block);
    if (!restored(logical, actual, ops, block)) { to.push(null); return; }
    for (const entry of this.entries.values()) if (idKey(entry.block) === idKey(block)) entry.expected = rebaseSnapshot(entry.expected, logical, actual, ops);
    for (const [transitionKey, transitions] of this.transitions) for (const tracked of [...transitions.undo, ...transitions.redo]) {
      if (!tracked) continue;
      if (!transitionKey.startsWith(`table:${idKey(block)}:`)) continue;
      tracked.before = rebaseSnapshot(tracked.before, logical, actual, ops);
      tracked.after = rebaseSnapshot(tracked.after, logical, actual, ops);
    }
    if (redo) item.after = actual; else item.before = actual;
    to.push(item);
  }

  record<S>(doc: Doc, block: OpId, tx: Tx, undo: UndoManager<S>, before?: string | null): string | null {
    for (const key of this.entries.keys()) if (!undo.hasMarker(key)) this.entries.delete(key);
    for (const key of this.transitions.keys()) if (!undo.hasMarker(key)) this.transitions.delete(key);
    const changes = new Map<string, Change>();
    const info = doc.blockInfo(block);
    for (const item of tx.items) {
      if (item.k !== "prop" || idKey(item.block) !== idKey(block)) return null;
      const existing = changes.get(item.key);
      const after = item.key === "type" ? info.type : info.props[item.key] ?? "";
      changes.set(item.key, { key: item.key, before: existing?.before ?? item.prev, after });
    }
    if (!changes.size) return null;
    const key = `table-structure:${idKey(block)}:${++this.next}`;
    this.entries.set(key, { block, changes: [...changes.values()], expected: guard(doc, block), other: before ?? undefined });
    return key;
  }

  step<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean): { status: "ready"; ops: Op[]; rebase?: { logical: ReturnType<typeof historyVersions>; actual: ReturnType<typeof historyVersions> } } | { status: "empty" | "conflict" } {
    const entry = this.entries.get(key);
    if (!entry || undo.peekMarker(redo) !== key) return { status: "empty" };
    if (!doc.hasBlock(entry.block) || guard(doc, entry.block) !== entry.expected) return { status: "conflict" };
    const source = entry.expected, target = entry.other;
    const tx = new Tx(doc);
    for (const change of entry.changes) tx.setProp(entry.block, change.key, redo ? change.after : change.before);
    if (!tx.ops.length) return { status: "empty" };
    const actual = guard(doc, entry.block);
    let rebase: { logical: ReturnType<typeof historyVersions>; actual: ReturnType<typeof historyVersions> } | undefined;
    if (target && restored(target, actual, tx.ops, entry.block, new Set(entry.changes.map((change) => change.key)))) {
      for (const [otherKey, other] of this.entries) {
        if (otherKey === key || idKey(other.block) !== idKey(entry.block)) continue;
        other.expected = rebaseStructureSnapshot(other.expected, target, actual, tx.ops);
        if (other.other) other.other = rebaseStructureSnapshot(other.other, target, actual, tx.ops);
      }
      for (const [transitionKey, transitions] of this.transitions) for (const tracked of [...transitions.undo, ...transitions.redo]) {
        if (!tracked || !transitionKey.startsWith(`table:${idKey(entry.block)}:`)) continue;
        tracked.before = rebaseStructureSnapshot(tracked.before, target, actual, tx.ops);
        tracked.after = rebaseStructureSnapshot(tracked.after, target, actual, tx.ops);
      }
      rebase = { logical: historyVersions(target), actual: historyVersions(actual) };
    }
    entry.other = source;
    entry.expected = actual;
    undo.moveMarker(redo, key);
    return { status: "ready", ops: tx.ops, rebase };
  }

  discard(key: string) { this.entries.delete(key); }
}

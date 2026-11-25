import { Doc, encodeClientMsg, encodeOps, eqId, idKey, type Op, type OpId, UndoManager } from "@zseven-w/collab";
import { conditionalBatchBase64, type ConditionalOpsStatus } from "@/lib/api";
import { conditionalOpsDigest, conditionalResolution, type ConditionalAttempt, type ConditionalJournalEnvironment, type ConditionalObservation } from "@/lib/conditional-journal";
import { TITLE } from "./model";
import { searchableLocations } from "./find-replace";
import { writeFindBatchTables } from "./find-batch";
import { readTableFindState } from "./table-find";
import { tableHistoryGuard } from "./table-history-undo";
import { FIND_FRAME_LIMIT } from "./find-replace-safety";
import { atomicFindPostState, validAtomicTitle, type AtomicFindPlan, type AtomicTableChange } from "./atomic-find-batch";

type ReceiptProof = { attempt: ConditionalAttempt; status: ConditionalOpsStatus; observe: () => ConditionalObservation | null; active: () => boolean; digest: ConditionalJournalEnvironment["digest"] };
type TableState = { change: AtomicTableChange; snapshot: string; versions: (string | null)[] };
export type AtomicFindAlias = { key: string; block: string; snapshot: string; versions: (string | null)[] };
type Entry = { doc: Doc; undo: UndoManager<unknown>; text: UndoManager<null>; hasText: boolean; blocks: { block: OpId; parent: OpId }[]; tables: TableState[]; beforeAliases: AtomicFindAlias[]; afterAliases: AtomicFindAlias[] };
type StepRecord = { doc: Doc; undo: UndoManager<unknown>; revision: number; key: string; redo: boolean; author: number; base: Uint8Array; ops: Op[]; textOps: Op[]; post: Uint8Array; aliases: AtomicFindAlias[] };
export type AtomicFindStep = Readonly<{ ops: readonly Op[]; title: string }>;
let serial = 0;

async function confirmed(ops: readonly Op[], proof: ReceiptProof): Promise<boolean> {
  try {
    if (!proof.active() || (proof.attempt.redacted ? proof.attempt.purpose !== "atomic-find" : proof.attempt.batch !== conditionalBatchBase64(encodeOps([...ops])))) return false;
    const actual = await conditionalOpsDigest(proof.attempt.historyEpoch, proof.attempt.expectedSeq, encodeOps([...ops]), proof.digest);
    if (!proof.active() || actual.digest !== proof.attempt.digest || actual.clientId !== proof.attempt.clientId || actual.opCount !== proof.attempt.opCount) return false;
    const observed = proof.observe();
    return !!observed && conditionalResolution(proof.attempt, proof.status, observed) === "committed" && proof.active();
  } catch { return false; }
}
function tableStates(doc: Doc, tables: readonly AtomicTableChange[]): TableState[] | null {
  const result: TableState[] = [];
  for (const change of tables) {
    const state = readTableFindState(doc, change.block); if (!state) return null;
    result.push({ change, snapshot: state.snapshot, versions: change.cells.map((cell) => state.cellVersion(cell.row, cell.col)) });
  }
  return result;
}
function sameBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((value, index) => value === b[index]); }
function withinFrame(ops: readonly Op[]) { return !!ops.length && encodeClientMsg({ type: "ops", batch: encodeOps([...ops]) }).byteLength <= FIND_FRAME_LIMIT; }
function freezeTree(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

/** Records only server-confirmed mixed replacements; inverse batches remain
 * previews until their own receipt and synchronized sequence are confirmed. */
export class AtomicFindHistory {
  private readonly entries = new Map<string, Entry>();
  private readonly steps = new WeakMap<AtomicFindStep, StepRecord>();
  private readonly installed = new WeakMap<AtomicFindPlan, { doc: Doc; undo: UndoManager<unknown>; key: string }>();
  private readonly completed = new WeakMap<AtomicFindStep, { doc: Doc; undo: UndoManager<unknown>; rebases: { block: OpId; logical: string | null; actual: string | null; guard: string }[] }>();
  private readonly tableActions = new Map<string, { undo: { before: AtomicFindAlias[]; after: AtomicFindAlias[] }[]; redo: { before: AtomicFindAlias[]; after: AtomicFindAlias[] }[] }>();
  rebases(plan: AtomicFindStep) { return this.completed.get(plan)?.rebases ?? []; }
  tableBlocks(key: string): OpId[] { return this.entries.get(key)?.tables.map((table) => table.change.block) ?? []; }

  capture(doc: Doc, blocks: readonly OpId[], exclude?: string): AtomicFindAlias[] {
    const keys = new Set(blocks.map(idKey)), states = new Map<string, ReturnType<typeof readTableFindState>>(), result: AtomicFindAlias[] = [];
    for (const [key, entry] of this.entries) {
      if (key === exclude || entry.doc !== doc || !entry.undo.hasMarker(key)) continue;
      for (const table of entry.tables) {
        const block = idKey(table.change.block); if (!keys.has(block)) continue;
        if (!states.has(block)) states.set(block, readTableFindState(doc, table.change.block));
        const state = states.get(block);
        if (state && state.snapshot === table.snapshot && table.change.cells.every((cell, i) => state.cellVersion(cell.row, cell.col) === table.versions[i])) result.push({ key, block, snapshot: table.snapshot, versions: [...table.versions] });
      }
    }
    return result;
  }
  private rebase(doc: Doc, aliases: readonly AtomicFindAlias[], allowed?: ReadonlySet<string>) {
    for (const alias of aliases) {
      if (allowed && !allowed.has(alias.block)) continue;
      const table = this.entries.get(alias.key)?.tables.find((item) => idKey(item.change.block) === alias.block);
      if (!table || table.snapshot !== alias.snapshot || table.versions.some((value, i) => value !== alias.versions[i])) continue;
      const state = readTableFindState(doc, table.change.block); if (!state) continue;
      table.snapshot = state.snapshot; table.versions = table.change.cells.map((cell) => state.cellVersion(cell.row, cell.col));
    }
  }
  recordTableChange(key: string, before: AtomicFindAlias[], merged: boolean) {
    if (!before.length && !this.tableActions.has(key)) return;
    const history = this.tableActions.get(key) ?? { undo: [], redo: [] };
    if (!merged || !history.undo.length) history.undo.push({ before, after: [] });
    history.redo = []; if (history.undo.length > 500) history.undo.shift();
    this.tableActions.delete(key); this.tableActions.set(key, history);
    if (this.tableActions.size > 500) this.tableActions.delete(this.tableActions.keys().next().value!);
  }
  finishTableChange(doc: Doc, key: string, redo: boolean, current: AtomicFindAlias[]) {
    let history = this.tableActions.get(key);
    // The table action may predate the atomic replacement. Capture the
    // currently matching atomic history as its inverse crosses that older
    // action, so redoing it can rebase the newer atomic marker safely.
    if (!history && current.length) { history = { undo: [], redo: [] }; this.tableActions.set(key, history); if (this.tableActions.size > 500) this.tableActions.delete(this.tableActions.keys().next().value!); }
    if (!history) return;
    const from = redo ? history.redo : history.undo, to = redo ? history.undo : history.redo;
    const item = from.pop();
    if (!item) { if (current.length) { to.push(redo ? { before: current, after: [] } : { before: [], after: current }); if (to.length > 500) to.shift(); } return; }
    this.rebase(doc, redo ? item.after : item.before);
    if (redo) item.before = current; else item.after = current;
    to.push(item);
  }
  discardTableChange(key: string, redo: boolean) {
    const history = this.tableActions.get(key); if (!history) return;
    (redo ? history.redo : history.undo).pop();
    if (!history.undo.length && !history.redo.length) this.tableActions.delete(key);
  }

  canSubmit<S>(doc: Doc, undo: UndoManager<S>, plan: AtomicFindStep): boolean {
    const step = this.steps.get(plan);
    if (!step || step.doc !== doc || step.undo !== undo || undo.revision !== step.revision || undo.peekMarker(step.redo) !== step.key) return false;
    try { return sameBytes(doc.encodeState(), step.base); } catch { return false; }
  }

  async install<S>(plan: AtomicFindPlan, doc: Doc, undo: UndoManager<S>, anchor: object, proof: ReceiptProof, beforeAliases: AtomicFindAlias[] = []): Promise<{ status: "recorded"; key: string } | { status: "unobserved" | "conflict" | "no-history" }> {
    if (plan.doc !== doc || !await confirmed(plan.ops, proof) || plan.doc !== doc) return { status: "unobserved" };
    const previous = this.installed.get(plan);
    if (previous) return previous.doc === doc && previous.undo === undo && undo.hasMarker(previous.key) ? { status: "recorded", key: previous.key } : { status: "no-history" };
    try {
      const state = atomicFindPostState(plan); if (!state) return { status: "conflict" };
      const post = Doc.fromState(plan.author, state), tables = tableStates(post, plan.tables);
      if (!tables || !proof.active()) return { status: "conflict" };
      const key = `atomic-find:${++serial}`;
      if (!undo.insertMarkerAt(anchor, key)) return { status: "no-history" };
      for (const [old, entry] of this.entries) if (!entry.undo.hasMarker(old)) this.entries.delete(old);
      const text = new UndoManager<null>(); text.shareRemappings(undo); text.record(plan.text, null, null);
      this.entries.set(key, { doc, undo: undo as UndoManager<unknown>, text, hasText: plan.text.items.length > 0, blocks: [...plan.textBlocks], tables, beforeAliases, afterAliases: [] });
      this.installed.set(plan, { doc, undo: undo as UndoManager<unknown>, key });
      return { status: "recorded", key };
    } catch { return { status: "conflict" }; }
  }

  prepare<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean, author: number, directoryTitle: string): { status: "ready"; plan: AtomicFindStep } | { status: "empty" | "conflict" | "size" } {
    const entry = this.entries.get(key);
    if (!entry || undo.peekMarker(redo) !== key) return { status: "empty" };
    if (entry.doc !== doc || entry.undo !== undo || !Number.isSafeInteger(author) || author <= 0 || author === doc.client || !doc.hasBlock(TITLE) || doc.text(TITLE) !== directoryTitle) return { status: "conflict" };
    const locations = new Map(searchableLocations(doc, { includeMath: true }).map((item) => [idKey(item.block), item.parent]));
    if (entry.blocks.some((item) => !locations.has(idKey(undo.map(item.block))) || !eqId(locations.get(idKey(undo.map(item.block)))!, undo.map(item.parent)))) return { status: "conflict" };
    for (const table of entry.tables) {
      const state = readTableFindState(doc, table.change.block);
      if (!state || state.snapshot !== table.snapshot || table.change.cells.some((cell, i) => state.cellVersion(cell.row, cell.col) !== table.versions[i])) return { status: "conflict" };
    }
    try {
      const base = doc.encodeState(); if (base.byteLength > 16 << 20) return { status: "size" };
      const copy = Doc.fromState(author, base), textOps = entry.hasText ? entry.text.preview(copy, redo)?.ops : [];
      if (!textOps) return { status: "conflict" };
      const tableOps = writeFindBatchTables(copy, entry.tables.map(({ change }) => ({ block: change.block, rows: redo ? change.after : change.before })));
      const ops = [...textOps, ...tableOps], title = copy.text(TITLE);
      if (!validAtomicTitle(title) || ops.some((op) => !("block" in op) || eqId(op.block, TITLE) && op.t !== "tins" && op.t !== "tdel")) return { status: "conflict" };
      if (!withinFrame(ops)) return { status: "size" };
      const post = copy.encodeState(); if (post.byteLength > 16 << 20) return { status: "size" };
      if (!tableStates(copy, entry.tables.map((item) => item.change))) return { status: "conflict" };
      const safeOps: Op[] = typeof structuredClone === "function" ? structuredClone(ops) : JSON.parse(JSON.stringify(ops));
      const safeTextOps = safeOps.slice(0, textOps.length); freezeTree(safeOps);
      const plan = Object.freeze({ ops: safeOps, title });
      this.steps.set(plan, { doc, undo: undo as UndoManager<unknown>, revision: undo.revision, key, redo, author, base, ops: safeOps, textOps: safeTextOps, post, aliases: this.capture(doc, entry.tables.map((table) => table.change.block), key) });
      return { status: "ready", plan };
    } catch { return { status: "conflict" }; }
  }

  async finish<S>(doc: Doc, undo: UndoManager<S>, plan: AtomicFindStep, proof: ReceiptProof): Promise<"ready" | "unobserved" | "conflict"> {
    const step = this.steps.get(plan), entry = step && this.entries.get(step.key);
    if (!step) {
      const done = this.completed.get(plan);
      return done && done.doc === doc && done.undo === undo && await confirmed(plan.ops, proof) ? "ready" : "unobserved";
    }
    if (!step || !entry || step.doc !== doc || step.undo !== undo || !await confirmed(step.ops, proof)) return "unobserved";
    if (!proof.active() || undo.revision !== step.revision || undo.peekMarker(step.redo) !== step.key || entry.doc !== doc) return "conflict";
    try {
      // Confirm determinism before advancing the local inverse history.
      const preview = Doc.fromState(step.author, step.base), predicted = entry.hasText ? entry.text.preview(preview, step.redo)?.ops : [];
      if (!predicted || !sameBytes(encodeOps(predicted), encodeOps(step.textOps))) return "conflict";
      const actualDoc = Doc.fromState(step.author, step.base), actual = entry.hasText ? (step.redo ? entry.text.redo(actualDoc) : entry.text.undo(actualDoc))?.ops : [];
      if (!actual || !sameBytes(encodeOps(actual), encodeOps(step.textOps))) return "conflict";
      const post = Doc.fromState(step.author, step.post), tables = tableStates(post, entry.tables.map((item) => item.change));
      if (!tables || !undo.moveMarker(step.redo, step.key)) return "conflict";
      const rebases = tables.flatMap(({ change, snapshot, versions }) => {
        const current = readTableFindState(doc, change.block);
        if (!current || current.snapshot !== snapshot || change.cells.some((cell, i) => current.cellVersion(cell.row, cell.col) !== versions[i]) || tableHistoryGuard(doc, change.block) !== change.guard) return [];
        const version = doc.propVersion(change.block, "tableData");
        return [{ block: change.block, logical: step.redo ? change.afterData : change.beforeData, actual: version ? idKey(version) : null, guard: change.guard }];
      });
      this.rebase(doc, step.redo ? entry.afterAliases : entry.beforeAliases, new Set(rebases.map((item) => idKey(item.block))));
      if (step.redo) entry.beforeAliases = step.aliases; else entry.afterAliases = step.aliases;
      entry.tables = tables; this.steps.delete(plan); this.completed.set(plan, { doc, undo: undo as UndoManager<unknown>, rebases }); return "ready";
    } catch { return "conflict"; }
  }
  discard(key: string) { this.entries.delete(key); }
}

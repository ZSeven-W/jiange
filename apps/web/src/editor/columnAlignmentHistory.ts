import { idKey, type Doc, type Op, type OpId, type UndoManager } from "@jiange/collab";
import { isColumnText } from "./model";
import { validEditorSelection } from "./selectionSafety";
import { TableCellHistory } from "./tableCellHistory";

let serial = 0;
const prefixOf = (block: OpId) => `column-align:${idKey(block)}:`;
const newKey = (block: OpId) => `${prefixOf(block)}${++serial}`;
const version = (doc: Doc, block: OpId, key: string) => { const id = doc.propVersion(block, key); return id ? idKey(id) : null; };
function guard(doc: Doc, block: OpId): string | null {
  const point = { b: block, o: 0 };
  if (!validEditorSelection(doc, { a: point, f: point }) || !isColumnText(doc, block)) return null;
  const parent = doc.blockInfo(block).parent;
  return JSON.stringify([idKey(parent), version(doc, block, "type"), version(doc, parent, "type")]);
}

export type ColumnAlignmentBefore = { value: string; version: string | null; guard: string };
export type ConditionalAlignmentPlan = Readonly<{ op: Readonly<Extract<Op, { t: "bset" | "bmove" }>> }>;
type PreparedAlignment = { doc: Doc; undo: object; key: string; redo: boolean; revision: number; block: OpId; before: ColumnAlignmentBefore; target: string; opId: OpId };

/** Prepares guarded inverses; only confirmed server operations can advance history. */
export class ColumnAlignmentHistory {
  private history = new TableCellHistory();
  private prepared = new WeakMap<ConditionalAlignmentPlan, PreparedAlignment>();
  capture(doc: Doc, block: OpId): ColumnAlignmentBefore | null {
    const scope = guard(doc, block);
    return scope === null ? null : { value: doc.blockInfo(block).props.align ?? "", version: version(doc, block, "align"), guard: scope };
  }
  record<S>(doc: Doc, undo: UndoManager<S>, block: OpId, before: ColumnAlignmentBefore): void {
    const after = this.capture(doc, block);
    if (!after || before.guard !== after.guard || before.value === after.value) throw new Error("invalid alignment history");
    const key = newKey(block);
    this.history.record(doc, key, before.value, after.value, before.version, after.version, before.guard, undefined, Date.now(), false);
    undo.seal(); undo.recordMarker(key); undo.seal();
  }
  /** Prepare an inverse without changing the document or consuming the undo marker. */
  prepareConditional<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean): { status: "ready"; plan: ConditionalAlignmentPlan } | { status: "empty" | "conflict" | "unsupported" } {
    const match = /^column-align:(\d+):(\d+):(\d+)$/.exec(key);
    if (!match || undo.peekMarker(redo) !== key) return { status: "empty" };
    const block = { client: Number(match[1]), clock: Number(match[2]) };
    const current = this.capture(doc, block);
    if (!current) return { status: "conflict" };
    const candidate = this.history.prepare(doc, key, redo, current.value, current.version, current.guard);
    if (candidate.status !== "ready") return candidate;
    if (!["", "left", "center", "right"].includes(candidate.value) || doc.client <= 0) return { status: "unsupported" };
    let opId: OpId;
    try { [opId] = doc.allocateOpIds(1); } catch { return { status: "unsupported" }; }
    const op = Object.freeze({ t: "bset" as const, id: Object.freeze({ ...opId }), block: Object.freeze({ ...block }), key: "align", value: candidate.value });
    const plan = Object.freeze({ op });
    this.prepared.set(plan, { doc, undo, key, redo, revision: undo.revision, block, before: current, target: candidate.value, opId });
    return { status: "ready", plan };
  }
  /** Recheck the captured action immediately before a request is sent. */
  canSubmitConditional<S>(doc: Doc, undo: UndoManager<S>, plan: ConditionalAlignmentPlan): boolean {
    const entry = this.prepared.get(plan);
    if (!entry || entry.doc !== doc || entry.undo !== undo || entry.revision !== undo.revision || undo.peekMarker(entry.redo) !== entry.key) return false;
    const current = this.capture(doc, entry.block);
    return !!current && current.guard === entry.before.guard && current.value === entry.before.value && current.version === entry.before.version;
  }
  /** Call only after a matching server receipt and the committed operation have both been observed. */
  finishConditional<S>(doc: Doc, undo: UndoManager<S>, plan: ConditionalAlignmentPlan): "ready" | "conflict" {
    const entry = this.prepared.get(plan);
    if (!entry || entry.doc !== doc || entry.undo !== undo || entry.revision !== undo.revision || undo.peekMarker(entry.redo) !== entry.key) return "conflict";
    const current = this.capture(doc, entry.block);
    if (!current || current.guard !== entry.before.guard || current.value !== entry.target || current.version !== idKey(entry.opId)) return "conflict";
    const actualVersion = current.version;
    const logicalVersion = this.history.commit(doc, entry.key, entry.redo, actualVersion);
    this.history.rebase(doc, prefixOf(entry.block), logicalVersion, actualVersion, current.guard);
    if (!undo.moveMarker(entry.redo, entry.key)) throw new Error("alignment marker changed during synchronous completion");
    this.prepared.delete(plan);
    return "ready";
  }
  discard(doc: Doc, key: string, redo: boolean): void { this.history.discard(doc, key, redo); }
}

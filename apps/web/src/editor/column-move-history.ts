import { idKey, type Doc, type OpId, type UndoManager } from "@jiange/collab";
import { captureColumnMove, validColumnPosition, type ColumnMoveSnapshot } from "./column-move";
import { TableCellHistory } from "./table-cell-history";
import type { ConditionalAlignmentPlan } from "./column-alignment-history";

let serial = 0;
const prefix = (parent: OpId, block: OpId) => `column-move:${idKey(parent)}:${idKey(block)}:`;
type Prepared = { doc: Doc; undo: object; key: string; redo: boolean; revision: number; parent: OpId; block: OpId; before: ColumnMoveSnapshot; target: string; opId: OpId };

export class ColumnMoveHistory {
  private history = new TableCellHistory();
  private prepared = new WeakMap<ConditionalAlignmentPlan, Prepared>();
  record<S>(doc: Doc, undo: UndoManager<S>, before: ColumnMoveSnapshot): void {
    const after = captureColumnMove(doc, before.parent, before.block);
    if (!after || before.doc !== doc || before.guard !== after.guard || before.pos === after.pos) throw new Error("invalid column move history");
    const key = `${prefix(before.parent, before.block)}${++serial}`;
    this.history.record(doc, key, before.pos, after.pos, before.version, after.version, before.guard, undefined, Date.now(), false);
    undo.seal(); undo.recordMarker(key); undo.seal();
  }
  prepareConditional<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean): { status: "ready"; plan: ConditionalAlignmentPlan } | { status: "empty" | "conflict" | "unsupported" } {
    const match = /^column-move:(\d+):(\d+):(\d+):(\d+):(\d+)$/.exec(key);
    if (!match || undo.peekMarker(redo) !== key) return { status: "empty" };
    const parent = { client: Number(match[1]), clock: Number(match[2]) }, block = { client: Number(match[3]), clock: Number(match[4]) };
    const current = captureColumnMove(doc, parent, block);
    if (!current) return { status: "conflict" };
    const candidate = this.history.prepare(doc, key, redo, current.pos, current.version, current.guard);
    if (candidate.status !== "ready") return candidate;
    if (!validColumnPosition(candidate.value) || doc.client <= 0) return { status: "unsupported" };
    let opId: OpId;
    try { [opId] = doc.allocateOpIds(1); } catch { return { status: "unsupported" }; }
    const op = Object.freeze({ t: "bmove" as const, id: Object.freeze({ ...opId }), block: Object.freeze({ ...block }), parent: Object.freeze({ ...parent }), pos: candidate.value });
    const plan = Object.freeze({ op });
    this.prepared.set(plan, { doc, undo, key, redo, revision: undo.revision, parent, block, before: current, target: candidate.value, opId });
    return { status: "ready", plan };
  }
  canSubmitConditional<S>(doc: Doc, undo: UndoManager<S>, plan: ConditionalAlignmentPlan): boolean {
    const entry = this.prepared.get(plan);
    if (!entry || entry.doc !== doc || entry.undo !== undo || entry.revision !== undo.revision || undo.peekMarker(entry.redo) !== entry.key) return false;
    const current = captureColumnMove(doc, entry.parent, entry.block);
    return !!current && current.guard === entry.before.guard && current.pos === entry.before.pos && current.version === entry.before.version;
  }
  finishConditional<S>(doc: Doc, undo: UndoManager<S>, plan: ConditionalAlignmentPlan): "ready" | "conflict" {
    const entry = this.prepared.get(plan);
    if (!entry || entry.doc !== doc || entry.undo !== undo || entry.revision !== undo.revision || undo.peekMarker(entry.redo) !== entry.key) return "conflict";
    const current = captureColumnMove(doc, entry.parent, entry.block);
    if (!current || current.guard !== entry.before.guard || current.pos !== entry.target || current.version !== idKey(entry.opId)) return "conflict";
    const logical = this.history.commit(doc, entry.key, entry.redo, current.version);
    this.history.rebase(doc, prefix(entry.parent, entry.block), logical, current.version, current.guard);
    if (!undo.moveMarker(entry.redo, entry.key)) throw new Error("column move marker changed during completion");
    this.prepared.delete(plan);
    return "ready";
  }
  discard(doc: Doc, key: string, redo: boolean): void { this.history.discard(doc, key, redo); }
}

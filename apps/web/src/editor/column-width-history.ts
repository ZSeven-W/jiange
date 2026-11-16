import { idKey, type Doc, type OpId, type UndoManager } from "@jiange/collab";
import { captureColumnWidths, COLUMN_WIDTHS, validColumnWidths } from "./column-widths";
import { TableCellHistory } from "./table-cell-history";
import type { ConditionalAlignmentPlan } from "./column-alignment-history";

let serial = 0;
const prefix = (parent: OpId) => `column-width:${idKey(parent)}:`;
const version = (doc: Doc, parent: OpId, key: string) => { const id = doc.propVersion(parent, key); return id ? idKey(id) : null; };
export type ColumnWidthBefore = { value: string; version: string | null; guard: string };
type Prepared = { doc: Doc; undo: object; key: string; redo: boolean; revision: number; parent: OpId; before: ColumnWidthBefore; target: string; opId: OpId };

/** Keeps width history scoped to the original visible structure and register version. */
export class ColumnWidthHistory {
  private history = new TableCellHistory();
  private prepared = new WeakMap<ConditionalAlignmentPlan, Prepared>();
  capture(doc: Doc, parent: OpId): ColumnWidthBefore | null {
    if (!doc.hasBlock(parent)) return null;
    const ids = doc.children(parent).map(idKey);
    if (ids.length < 2) return null;
    const snapshot = captureColumnWidths(doc, parent, ids[0], ids[1]);
    if (!snapshot) return null;
    return { value: snapshot.raw ?? "", version: snapshot.version, guard: JSON.stringify([snapshot.ids, version(doc, parent, "type")]) };
  }
  record<S>(doc: Doc, undo: UndoManager<S>, parent: OpId, before: ColumnWidthBefore): void {
    const after = this.capture(doc, parent);
    if (!after || before.guard !== after.guard || before.value === after.value) throw new Error("invalid column width history");
    const key = `${prefix(parent)}${++serial}`;
    this.history.record(doc, key, before.value, after.value, before.version, after.version, before.guard, undefined, Date.now(), false);
    undo.seal(); undo.recordMarker(key); undo.seal();
  }
  prepareConditional<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean): { status: "ready"; plan: ConditionalAlignmentPlan } | { status: "empty" | "conflict" | "unsupported" } {
    const match = /^column-width:(\d+):(\d+):(\d+)$/.exec(key);
    if (!match || undo.peekMarker(redo) !== key) return { status: "empty" };
    const parent = { client: Number(match[1]), clock: Number(match[2]) }, current = this.capture(doc, parent);
    if (!current) return { status: "conflict" };
    const candidate = this.history.prepare(doc, key, redo, current.value, current.version, current.guard);
    if (candidate.status !== "ready") return candidate;
    if (!validColumnWidths(candidate.value) || doc.client <= 0) return { status: "unsupported" };
    let opId: OpId;
    try { [opId] = doc.allocateOpIds(1); } catch { return { status: "unsupported" }; }
    const op = Object.freeze({ t: "bset" as const, id: Object.freeze({ ...opId }), block: Object.freeze({ ...parent }), key: COLUMN_WIDTHS, value: candidate.value });
    const plan = Object.freeze({ op });
    this.prepared.set(plan, { doc, undo, key, redo, revision: undo.revision, parent, before: current, target: candidate.value, opId });
    return { status: "ready", plan };
  }
  canSubmitConditional<S>(doc: Doc, undo: UndoManager<S>, plan: ConditionalAlignmentPlan): boolean {
    const entry = this.prepared.get(plan);
    if (!entry || entry.doc !== doc || entry.undo !== undo || entry.revision !== undo.revision || undo.peekMarker(entry.redo) !== entry.key) return false;
    const current = this.capture(doc, entry.parent);
    return !!current && current.guard === entry.before.guard && current.value === entry.before.value && current.version === entry.before.version;
  }
  finishConditional<S>(doc: Doc, undo: UndoManager<S>, plan: ConditionalAlignmentPlan): "ready" | "conflict" {
    const entry = this.prepared.get(plan);
    if (!entry || entry.doc !== doc || entry.undo !== undo || entry.revision !== undo.revision || undo.peekMarker(entry.redo) !== entry.key) return "conflict";
    const current = this.capture(doc, entry.parent);
    if (!current || current.guard !== entry.before.guard || current.value !== entry.target || current.version !== idKey(entry.opId)) return "conflict";
    const logical = this.history.commit(doc, entry.key, entry.redo, current.version);
    this.history.rebase(doc, prefix(entry.parent), logical, current.version, current.guard);
    if (!undo.moveMarker(entry.redo, entry.key)) throw new Error("column width marker changed during completion");
    this.prepared.delete(plan);
    return "ready";
  }
  discard(doc: Doc, key: string, redo: boolean): void { this.history.discard(doc, key, redo); }
}

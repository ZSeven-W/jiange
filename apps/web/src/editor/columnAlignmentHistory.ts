import { idKey, Tx, type Doc, type OpId, type UndoManager } from "@jiange/collab";
import { isColumnText } from "./model";
import { validEditorSelection } from "./selectionSafety";
import { TableCellHistory } from "./tableCellHistory";

const keyOf = (block: OpId) => `column-align:${idKey(block)}:value`;
const version = (doc: Doc, block: OpId, key: string) => { const id = doc.propVersion(block, key); return id ? idKey(id) : null; };
function guard(doc: Doc, block: OpId): string | null {
  const point = { b: block, o: 0 };
  if (!validEditorSelection(doc, { a: point, f: point }) || !isColumnText(doc, block)) return null;
  const parent = doc.blockInfo(block).parent;
  return JSON.stringify([idKey(parent), version(doc, block, "type"), version(doc, parent, "type")]);
}

export type ColumnAlignmentBefore = { value: string; version: string | null; guard: string };

/** Local version checks only; an operation still needs an exact-head server commit to cover in-flight races. */
export class ColumnAlignmentHistory {
  private history = new TableCellHistory();
  capture(doc: Doc, block: OpId): ColumnAlignmentBefore | null {
    const scope = guard(doc, block);
    return scope === null ? null : { value: doc.blockInfo(block).props.align ?? "", version: version(doc, block, "align"), guard: scope };
  }
  record<S>(doc: Doc, undo: UndoManager<S>, block: OpId, before: ColumnAlignmentBefore): void {
    const after = this.capture(doc, block);
    if (!after || before.guard !== after.guard || before.value === after.value) throw new Error("invalid alignment history");
    const key = keyOf(block);
    this.history.record(doc, key, before.value, after.value, before.version, after.version, before.guard, undefined, Date.now(), false);
    undo.seal(); undo.recordMarker(key); undo.seal();
  }
  step<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean): { status: "ready"; tx: Tx } | { status: "empty" | "conflict" } {
    const match = /^column-align:(\d+):(\d+):value$/.exec(key);
    if (!match || undo.peekMarker(redo) !== key) return { status: "empty" };
    const block = { client: Number(match[1]), clock: Number(match[2]) };
    const current = this.capture(doc, block);
    if (!current) return { status: "conflict" };
    const plan = this.history.prepare(doc, key, redo, current.value, current.version, current.guard);
    if (plan.status !== "ready") return plan;
    const tx = new Tx(doc); tx.setProp(block, "align", plan.value);
    if (!tx.ops.length) return { status: "conflict" };
    const actualVersion = version(doc, block, "align");
    const logicalVersion = this.history.commit(doc, key, redo, actualVersion);
    this.history.rebase(doc, key, logicalVersion, actualVersion, current.guard);
    undo.moveMarker(redo, key);
    return { status: "ready", tx };
  }
  discard(doc: Doc, key: string, redo: boolean): void { this.history.discard(doc, key, redo); }
}

import { type Doc, type OpId, type Tx, type UndoManager } from "@zseven-w/collab";
import { captureColumnArchiveTarget, prepareColumnArchive, prepareColumnArchiveTransition, preparedColumnArchiveIsCurrent, recoverColumnArchive, type PreparedColumnArchive } from "@zseven-w/doc-sdk/column-archive-experimental";
import { type ColumnMoveSnapshot } from "@zseven-w/doc-sdk/column-move";

type Entry = { doc: Doc; undo: UndoManager<unknown>; recovery: string | null; created: ColumnMoveSnapshot | null; undoArchived: boolean };
type Step = { doc: Doc; undo: UndoManager<unknown>; key: string; redo: boolean; revision: number };
let serial = 0;

/** Session undo markers for confirmed archive operations. */
export class ColumnArchiveHistory {
  private entries = new Map<string, Entry>();
  private steps = new WeakMap<PreparedColumnArchive, Step>();
  private installed = new WeakMap<PreparedColumnArchive, { doc: Doc; undo: UndoManager<unknown>; key: string }>();
  private completed = new WeakMap<PreparedColumnArchive, { doc: Doc; undo: UndoManager<unknown> }>();

  private prune<S>(undo: UndoManager<S>): void {
    for (const [key, entry] of this.entries) if (entry.undo === undo && !undo.hasMarker(key)) this.entries.delete(key);
  }

  install<S>(doc: Doc, undo: UndoManager<S>, plan: PreparedColumnArchive, anchor: object): "recorded" | "unobserved" | "no-history" {
    if (plan.doc !== doc) return "unobserved";
    const prior = this.installed.get(plan);
    if (prior) return prior.doc === doc && prior.undo === undo && undo.hasMarker(prior.key) ? "recorded" : "no-history";
    const entry = recoverColumnArchive(doc, plan.recovery);
    if (!entry?.archived) return "no-history";
    const key = `column-archive:${++serial}`;
    if (!undo.insertMarkerAt(anchor, key)) return "no-history";
    this.entries.set(key, { doc, undo: undo as UndoManager<unknown>, recovery: plan.recovery, created: null, undoArchived: false });
    this.prune(undo);
    this.installed.set(plan, { doc, undo: undo as UndoManager<unknown>, key });
    return "recorded";
  }

  /** Register a newly created group or column without tombstoning it on undo. */
  recordCreation<S>(doc: Doc, undo: UndoManager<S>, parent: OpId, block: OpId, prefix?: { tx: Tx; before: S | null; after: S | null }): boolean {
    if (undo.limit < 1 || prefix && prefix.tx.doc !== doc) return false;
    let created: ColumnMoveSnapshot | null;
    try { created = captureColumnArchiveTarget(doc, parent, block); } catch { return false; }
    if (!created) return false;
    const key = `column-archive:${++serial}`;
    undo.seal();
    if (prefix?.tx.items.length) { undo.record(prefix.tx, prefix.before, prefix.after); undo.seal(); }
    undo.recordMarker(key); undo.seal();
    this.entries.set(key, { doc, undo: undo as UndoManager<unknown>, recovery: null, created, undoArchived: true });
    this.prune(undo);
    return true;
  }

  prepare<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean, author: number): { status: "ready"; plan: PreparedColumnArchive } | { status: "empty" | "conflict" } {
    const entry = this.entries.get(key);
    if (!entry || entry.doc !== doc || entry.undo !== undo || undo.peekMarker(redo) !== key) return { status: "empty" };
    let plan: PreparedColumnArchive | null;
    if (entry.recovery === null) {
      if (redo || !entry.created) return { status: "conflict" };
      const current = captureColumnArchiveTarget(doc, entry.created.parent, entry.created.block);
      if (!current || current.pos !== entry.created.pos || current.version !== entry.created.version || current.guard !== entry.created.guard || current.ids.length !== entry.created.ids.length || current.ids.some((id, i) => id !== entry.created!.ids[i])) return { status: "conflict" };
      plan = prepareColumnArchive(doc, author, current.parent, current.block);
    } else {
      const current = recoverColumnArchive(doc, entry.recovery);
      if (!current || current.archived !== (redo ? entry.undoArchived : !entry.undoArchived)) return { status: "conflict" };
      plan = prepareColumnArchiveTransition(current, author);
    }
    if (!plan) return { status: "conflict" };
    this.steps.set(plan, { doc, undo: undo as UndoManager<unknown>, key, redo, revision: undo.revision });
    return { status: "ready", plan };
  }

  canSubmit<S>(doc: Doc, undo: UndoManager<S>, plan: PreparedColumnArchive): boolean {
    const step = this.steps.get(plan);
    return !!step && step.doc === doc && step.undo === undo && step.revision === undo.revision && undo.peekMarker(step.redo) === step.key && preparedColumnArchiveIsCurrent(plan, doc);
  }

  finish<S>(doc: Doc, undo: UndoManager<S>, plan: PreparedColumnArchive): "ready" | "conflict" {
    const completed = this.completed.get(plan);
    if (completed) return completed.doc === doc && completed.undo === undo ? "ready" : "conflict";
    const step = this.steps.get(plan), entry = step && this.entries.get(step.key);
    if (!step || !entry || step.doc !== doc || step.undo !== undo || step.revision !== undo.revision || undo.peekMarker(step.redo) !== step.key) return "conflict";
    const result = recoverColumnArchive(doc, plan.recovery);
    if (!result || result.archived !== (step.redo ? !entry.undoArchived : entry.undoArchived)) return "conflict";
    if (!undo.moveMarker(step.redo, step.key)) return "conflict";
    entry.recovery = plan.recovery; entry.created = null; this.steps.delete(plan); this.completed.set(plan, { doc, undo: undo as UndoManager<unknown> });
    return "ready";
  }

  discard(key: string): void { this.entries.delete(key); }
}

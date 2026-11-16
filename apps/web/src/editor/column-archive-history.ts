import { type Doc, type UndoManager } from "@jiange/collab";
import { prepareColumnArchiveTransition, preparedColumnArchiveIsCurrent, recoverColumnArchive, type PreparedColumnArchive } from "@jiange/doc-sdk/column-archive-experimental";

type Entry = { doc: Doc; undo: UndoManager<unknown>; recovery: string };
type Step = { doc: Doc; undo: UndoManager<unknown>; key: string; redo: boolean; revision: number };
let serial = 0;

/** Session undo markers for confirmed archive operations. */
export class ColumnArchiveHistory {
  private entries = new Map<string, Entry>();
  private steps = new WeakMap<PreparedColumnArchive, Step>();
  private installed = new WeakMap<PreparedColumnArchive, { doc: Doc; undo: UndoManager<unknown>; key: string }>();
  private completed = new WeakMap<PreparedColumnArchive, { doc: Doc; undo: UndoManager<unknown> }>();

  install<S>(doc: Doc, undo: UndoManager<S>, plan: PreparedColumnArchive, anchor: object): "recorded" | "unobserved" | "no-history" {
    if (plan.doc !== doc) return "unobserved";
    const prior = this.installed.get(plan);
    if (prior) return prior.doc === doc && prior.undo === undo && undo.hasMarker(prior.key) ? "recorded" : "no-history";
    const entry = recoverColumnArchive(doc, plan.recovery);
    if (!entry?.archived) return "no-history";
    const key = `column-archive:${++serial}`;
    if (!undo.insertMarkerAt(anchor, key)) return "no-history";
    this.entries.set(key, { doc, undo: undo as UndoManager<unknown>, recovery: plan.recovery });
    this.installed.set(plan, { doc, undo: undo as UndoManager<unknown>, key });
    return "recorded";
  }

  prepare<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean, author: number): { status: "ready"; plan: PreparedColumnArchive } | { status: "empty" | "conflict" } {
    const entry = this.entries.get(key);
    if (!entry || entry.doc !== doc || entry.undo !== undo || undo.peekMarker(redo) !== key) return { status: "empty" };
    const current = recoverColumnArchive(doc, entry.recovery);
    if (!current || current.archived === redo) return { status: "conflict" };
    const plan = prepareColumnArchiveTransition(current, author);
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
    if (!result || result.archived !== step.redo) return "conflict";
    if (!undo.moveMarker(step.redo, step.key)) return "conflict";
    entry.recovery = plan.recovery; this.steps.delete(plan); this.completed.set(plan, { doc, undo: undo as UndoManager<unknown> });
    return "ready";
  }

  discard(key: string): void { this.entries.delete(key); }
}

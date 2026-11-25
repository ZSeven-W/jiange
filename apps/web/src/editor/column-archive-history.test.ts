import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager, idKey } from "@zseven-w/collab";
import { prepareColumnArchive } from "@zseven-w/doc-sdk/column-archive-experimental";
import { ColumnArchiveHistory } from "./column-archive-history";

function setup() {
  const doc = new Doc(9), tx = new Tx(doc), parent = tx.create("columns", null, ROOT), left = tx.create("paragraph", null, parent), right = tx.create("paragraph", left, parent);
  tx.insert(left, 0, "原文");
  const undo = new UndoManager<null>(), history = new ColumnArchiveHistory(), anchor = undo.markInsertionPoint();
  const plan = prepareColumnArchive(doc, 19, parent, left); if (!plan) throw new Error("plan unavailable");
  return { doc, parent, left, right, undo, history, anchor, plan };
}
const children = (f: ReturnType<typeof setup>) => f.doc.children(f.parent).map(idKey);

describe("confirmed archive undo history", () => {
  it("undoes and redoes a new group while retaining late collaborator edits", () => {
    const doc = new Doc(1), tx = new Tx(doc), group = tx.create("columns", null, ROOT), left = tx.create("paragraph", null, group), right = tx.create("paragraph", left, group);
    const peer = Doc.fromState(2, doc.encodeState()), undo = new UndoManager<null>(), history = new ColumnArchiveHistory();
    expect(history.recordCreation(doc, undo, ROOT, group)).toBe(true);
    const key = undo.peekMarker(false)!, step = history.prepare(doc, undo, key, false, 19); if (step.status !== "ready") throw new Error(step.status);
    for (const op of step.plan.ops) doc.apply(op);
    expect(history.finish(doc, undo, step.plan)).toBe("ready");
    expect(doc.view().blocks.some((block) => block.id === idKey(group))).toBe(false);
    doc.apply(peer.insertText(left, 0, "协作内容")!);
    const redo = history.prepare(doc, undo, key, true, 20); if (redo.status !== "ready") throw new Error(redo.status);
    for (const op of redo.plan.ops) doc.apply(op);
    expect(history.finish(doc, undo, redo.plan)).toBe("ready");
    expect(doc.children(group).map(idKey)).toEqual([left, right].map(idKey)); expect(doc.text(left)).toBe("协作内容");
    const again = history.prepare(doc, undo, key, false, 21); if (again.status !== "ready") throw new Error(again.status);
    for (const op of again.plan.ops) doc.apply(op); expect(history.finish(doc, undo, again.plan)).toBe("ready");
    const restore = history.prepare(doc, undo, key, true, 22); if (restore.status !== "ready") throw new Error(restore.status);
    for (const op of restore.plan.ops) doc.apply(op); expect(history.finish(doc, undo, restore.plan)).toBe("ready");
    expect(doc.children(group).map(idKey)).toEqual([left, right].map(idKey)); expect(doc.text(left)).toBe("协作内容");
  });
  it("undoes and redoes an added column without losing its original identity", () => {
    const doc = new Doc(1), tx = new Tx(doc), group = tx.create("columns", null, ROOT), left = tx.create("paragraph", null, group), right = tx.create("paragraph", left, group), added = tx.create("paragraph", right, group);
    const peer = Doc.fromState(2, doc.encodeState()), undo = new UndoManager<null>(), history = new ColumnArchiveHistory();
    expect(history.recordCreation(doc, undo, group, added)).toBe(true);
    const key = undo.peekMarker(false)!, step = history.prepare(doc, undo, key, false, 19); if (step.status !== "ready") throw new Error(step.status);
    for (const op of step.plan.ops) doc.apply(op); expect(history.finish(doc, undo, step.plan)).toBe("ready");
    doc.apply(peer.insertText(added, 0, "迟到编辑")!);
    const redo = history.prepare(doc, undo, key, true, 20); if (redo.status !== "ready") throw new Error(redo.status);
    for (const op of redo.plan.ops) doc.apply(op); expect(history.finish(doc, undo, redo.plan)).toBe("ready");
    expect(doc.children(group).map(idKey)).toEqual([left, right, added].map(idKey)); expect(doc.text(added)).toBe("迟到编辑");
  });
  it("keeps a typed slash command as a separate earlier undo action", () => {
    const doc = new Doc(1), init = new Tx(doc), paragraph = init.create("paragraph", null, ROOT); init.insert(paragraph, 0, "/columns");
    const tx = new Tx(doc); tx.delete(paragraph, 0, 8); const group = tx.create("columns", paragraph, ROOT); const left = tx.create("paragraph", null, group); tx.create("paragraph", left, group);
    const prefix = new Tx(doc); prefix.items = tx.items.filter((item) => item.k === "del");
    const undo = new UndoManager<null>(), history = new ColumnArchiveHistory();
    expect(history.recordCreation(doc, undo, ROOT, group, { tx: prefix, before: null, after: null })).toBe(true);
    const key = undo.peekMarker(false)!, step = history.prepare(doc, undo, key, false, 19); if (step.status !== "ready") throw new Error(step.status);
    for (const op of step.plan.ops) doc.apply(op); expect(history.finish(doc, undo, step.plan)).toBe("ready");
    expect(undo.undo(doc)).not.toBeNull(); expect(doc.text(paragraph)).toBe("/columns");
    expect(undo.redo(doc)).not.toBeNull(); expect(doc.text(paragraph)).toBe("");
    const redo = history.prepare(doc, undo, key, true, 20); if (redo.status !== "ready") throw new Error(redo.status);
    for (const op of redo.plan.ops) doc.apply(op); expect(history.finish(doc, undo, redo.plan)).toBe("ready");
    expect(doc.children(group)).toHaveLength(2);
  });
  it("does not create a marker when the original group is no longer safely identifiable", () => {
    const doc = new Doc(1), tx = new Tx(doc), group = tx.create("columns", null, ROOT), child = tx.create("paragraph", null, group);
    tx.create("paragraph", child, group);
    const other = tx.create("paragraph", group, ROOT), loc = doc.blockLocation(group);
    doc.apply({ t: "bmove", id: doc.allocateOpIds()[0], block: other, parent: ROOT, pos: loc.pos });
    const undo = new UndoManager<null>(), history = new ColumnArchiveHistory();
    expect(history.recordCreation(doc, undo, ROOT, group)).toBe(false);
    expect(undo.canUndo).toBe(false); expect(doc.hasBlock(group)).toBe(true);
  });
  it("installs only after observation and preserves ID and late peer text across undo and redo", () => {
    const f = setup(); expect(f.history.install(f.doc, f.undo, f.plan, f.anchor)).toBe("no-history");
    for (const op of f.plan.ops) f.doc.apply(op);
    expect(f.history.install(f.doc, f.undo, f.plan, f.anchor)).toBe("recorded");
    expect(f.history.install(f.doc, f.undo, f.plan, f.anchor)).toBe("recorded");
    const key = f.undo.peekMarker(false)!;
    const prepared = f.history.prepare(f.doc, f.undo, key, false, 20); if (prepared.status !== "ready") throw new Error(prepared.status);
    expect(f.history.canSubmit(f.doc, f.undo, prepared.plan)).toBe(true);
    const peer = Doc.fromState(2, f.doc.encodeState()); f.doc.apply(peer.insertText(f.left, 2, "协作")!);
    expect(f.history.canSubmit(f.doc, f.undo, prepared.plan)).toBe(false);
    const next = f.history.prepare(f.doc, f.undo, key, false, 21); if (next.status !== "ready") throw new Error(next.status);
    for (const op of next.plan.ops) f.doc.apply(op);
    expect(f.history.finish(f.doc, f.undo, next.plan)).toBe("ready");
    expect(f.history.finish(f.doc, f.undo, next.plan)).toBe("ready");
    expect(children(f)).toEqual([f.left, f.right].map(idKey)); expect(f.doc.text(f.left)).toBe("原文协作");
    const redo = f.history.prepare(f.doc, f.undo, key, true, 22); if (redo.status !== "ready") throw new Error(redo.status);
    for (const op of redo.plan.ops) f.doc.apply(op);
    expect(f.history.finish(f.doc, f.undo, redo.plan)).toBe("ready");
    expect(children(f)).toEqual([idKey(f.right)]); expect(f.doc.text(f.left)).toBe("原文协作");
  });
  it("places a confirmed deletion before later local edits", () => {
    const f = setup();
    const later = new Tx(f.doc); later.insert(f.right, 0, "后续"); f.undo.record(later, null, null);
    for (const op of f.plan.ops) f.doc.apply(op);
    expect(f.history.install(f.doc, f.undo, f.plan, f.anchor)).toBe("recorded");
    expect(f.undo.peekMarker(false)).toBeNull(); expect(f.undo.undo(f.doc)).not.toBeNull();
    expect(f.undo.peekMarker(false)).toMatch(/^column-archive:/);
  });
  it("rejects stale layout changes without moving the undo marker", () => {
    const f = setup(); for (const op of f.plan.ops) f.doc.apply(op);
    expect(f.history.install(f.doc, f.undo, f.plan, f.anchor)).toBe("recorded");
    const key = f.undo.peekMarker(false)!;
    f.doc.apply(f.doc.moveBlock(f.right, f.parent, 0));
    expect(f.history.prepare(f.doc, f.undo, key, false, 20).status).toBe("conflict");
    expect(f.undo.peekMarker(false)).toBe(key);
  });
});

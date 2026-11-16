import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager, idKey } from "@jiange/collab";
import { prepareColumnArchive } from "@jiange/doc-sdk/column-archive-experimental";
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

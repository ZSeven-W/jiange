import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, idKey } from "@jiange/collab";
import { captureColumnMove } from "../src/column-move.js";
import { archiveColumn, prepareColumnArchive, prepareColumnArchiveTransition, preparedColumnArchiveIsCurrent, recoverColumnArchive, serializeColumnArchive, toggleArchivedColumn } from "../src/column-archive-experimental.js";

function setup() {
  const doc = new Doc(1), tx = new Tx(doc), parent = tx.create("columns", null, ROOT);
  const left = tx.create("paragraph", null, parent), middle = tx.create("paragraph", left, parent), right = tx.create("paragraph", middle, parent);
  tx.insert(middle, 0, "原文"); tx.format(middle, 0, 2, "bold", "1");
  return { doc, parent, left, middle, right };
}
const children = (doc: Doc, parent: { client: number; clock: number }) => doc.children(parent).map(idKey);

describe("experimental reversible column archive", () => {
  it("prepares a bounded batch on an isolated author without changing the live document", () => {
    const x = setup(), before = x.doc.encodeState();
    expect(prepareColumnArchive(x.doc, x.doc.client, x.parent, x.middle)).toBeNull();
    const plan = prepareColumnArchive(x.doc, 19, x.parent, x.middle)!;
    expect(plan).not.toBeNull(); expect(x.doc.encodeState()).toEqual(before);
    expect(plan.ops.map((op) => op.t)).toEqual(["bcreate", "bdel", "bset", "bmove"]);
    expect(plan.ops.every((op) => op.id.client === 19)).toBe(true);
    const create = plan.ops[0], metadata = plan.ops[2];
    if (create.t !== "bcreate" || metadata.t !== "bset") throw new Error("unexpected archive batch");
    expect(metadata.key).toBe("_column_archive_v1");
    expect(metadata.value).toBe(`v1|${idKey(x.parent)}|${x.doc.blockLocation(x.middle).pos}|${idKey(create.id)}`);
    expect(Object.isFrozen(plan.ops)).toBe(true); expect(Object.isFrozen(plan.ops[0].id)).toBe(true);
    expect(plan.recovery).not.toContain("原文"); expect(preparedColumnArchiveIsCurrent(plan, x.doc)).toBe(true);
    for (const op of plan.ops) x.doc.apply(op);
    expect(preparedColumnArchiveIsCurrent(plan, x.doc)).toBe(false);
    const recovered = recoverColumnArchive(x.doc, plan.recovery)!;
    expect(toggleArchivedColumn(new Tx(x.doc), recovered)?.archived).toBe(false);
    expect(x.doc.text(x.middle)).toBe("原文");
  });
  it("invalidates a prepared batch after an intervening edit", () => {
    const x = setup(), plan = prepareColumnArchive(x.doc, 19, x.parent, x.middle)!;
    const peer = Doc.fromState(2, x.doc.encodeState()); x.doc.apply(peer.insertText(x.right, 0, "协作")!);
    expect(preparedColumnArchiveIsCurrent(plan, x.doc)).toBe(false);
    expect(children(x.doc, x.parent)).toEqual([x.left, x.middle, x.right].map(idKey));
  });
  it("prepares restore and redo without changing the live replica", () => {
    const x = setup(), initial = prepareColumnArchive(x.doc, 19, x.parent, x.middle)!;
    for (const op of initial.ops) x.doc.apply(op);
    const archived = recoverColumnArchive(x.doc, initial.recovery)!, before = x.doc.encodeState();
    const restore = prepareColumnArchiveTransition(archived, 20)!;
    expect(restore.ops.map((op) => op.t)).toEqual(["bmove"]);
    expect(x.doc.encodeState()).toEqual(before);
    expect(preparedColumnArchiveIsCurrent(restore, x.doc)).toBe(true);
    for (const op of restore.ops) x.doc.apply(op);
    const restored = recoverColumnArchive(x.doc, restore.recovery)!;
    expect(restored.archived).toBe(false); expect(x.doc.text(x.middle)).toBe("原文");
    const redo = prepareColumnArchiveTransition(restored, 21)!;
    expect(redo.ops.map((op) => op.t)).toEqual(["bmove"]);
    expect(children(x.doc, x.parent)).toEqual([x.left, x.middle, x.right].map(idKey));
    for (const op of redo.ops) x.doc.apply(op);
    expect(recoverColumnArchive(x.doc, redo.recovery)?.archived).toBe(true);
  });
  it("keeps the block, character IDs and late peer edits through hide, restore and re-hide", () => {
    const x = setup(), peer = Doc.fromState(2, x.doc.encodeState());
    const chars = x.doc.visibleIds(x.middle).map(idKey), snap = captureColumnMove(x.doc, x.parent, x.middle)!;
    const tx = new Tx(x.doc), archived = archiveColumn(tx, snap)!;
    expect(tx.ops.map((op) => op.t)).toEqual(["bcreate", "bdel", "bset", "bmove"]);
    expect(children(x.doc, x.parent)).toEqual([x.left, x.right].map(idKey));
    expect(x.doc.view().blocks.some((b) => b.id === idKey(x.middle))).toBe(false);
    expect(x.doc.hasBlock(x.middle)).toBe(true);
    const late = peer.insertText(x.middle, 2, "协作")!; x.doc.apply(late);
    for (const op of [tx.ops[3], tx.ops[2], tx.ops[1], tx.ops[0]]) peer.apply(op);
    expect(peer.pendingCount).toBe(0);
    expect(peer.view()).toEqual(x.doc.view());
    const restoredTx = new Tx(x.doc), restored = toggleArchivedColumn(restoredTx, archived)!;
    restoredTx.ops.forEach((op) => peer.apply(op));
    expect(peer.view()).toEqual(x.doc.view());
    expect(children(x.doc, x.parent)).toEqual([x.left, x.middle, x.right].map(idKey));
    expect(x.doc.text(x.middle)).toBe("原文协作");
    expect(x.doc.visibleIds(x.middle).slice(0, 2).map(idKey)).toEqual(chars);
    expect(x.doc.richChars(x.middle)[0].marks.bold).toBe("1");
    const redo = new Tx(x.doc), hiddenAgain = toggleArchivedColumn(redo, restored)!;
    expect(hiddenAgain.archived).toBe(true); expect(children(x.doc, x.parent)).toEqual([x.left, x.right].map(idKey));
  });

  it("preserves the hidden child and tombstone type in a cold snapshot", () => {
    const x = setup(), archived = archiveColumn(new Tx(x.doc), captureColumnMove(x.doc, x.parent, x.middle)!)!;
    const cold = Doc.fromState(3, x.doc.encodeState());
    expect(cold.deletedBlockType(archived.archive)).toBe("jiange-column-archive-v1");
    expect(cold.hasBlock(x.middle)).toBe(true); expect(cold.text(x.middle)).toBe("原文");
    expect(cold.view().blocks.some((b) => b.id === idKey(x.middle))).toBe(false);
    expect(toggleArchivedColumn(new Tx(cold), archived)).toBeNull();
    const saved = serializeColumnArchive(archived);
    expect(saved).not.toContain("原文");
    const recovered = recoverColumnArchive(cold, saved)!;
    expect(recovered).not.toBeNull();
    const restored = toggleArchivedColumn(new Tx(cold), recovered)!;
    expect(cold.text(x.middle)).toBe("原文");
    expect(children(cold, x.parent)).toEqual([x.left, x.middle, x.right].map(idKey));
    const coldAgain = Doc.fromState(4, cold.encodeState());
    expect(toggleArchivedColumn(new Tx(coldAgain), recoverColumnArchive(coldAgain, serializeColumnArchive(restored))!)?.archived).toBe(true);
  });

  it("rejects corrupt or stale persisted handles without changing the replica", () => {
    const x = setup(), archived = archiveColumn(new Tx(x.doc), captureColumnMove(x.doc, x.parent, x.middle)!)!;
    const saved = serializeColumnArchive(archived), data = JSON.parse(saved);
    for (const invalid of ["{", JSON.stringify({ ...data, unknown: 1 }), JSON.stringify({ ...data, archive: "1:0" }), JSON.stringify({ ...data, originalPos: "A0" }), JSON.stringify({ ...data, version: "99:99" }), JSON.stringify({ ...data, archived: false })]) expect(recoverColumnArchive(x.doc, invalid)).toBeNull();
    const peer = Doc.fromState(2, x.doc.encodeState()); x.doc.apply(peer.moveBlock(x.right, x.parent, 0));
    expect(recoverColumnArchive(x.doc, saved)).toBeNull();
    expect(x.doc.text(x.middle)).toBe("原文");
  });

  it("rejects stale sibling positions and replaying a prior transition", () => {
    const x = setup(), snap = captureColumnMove(x.doc, x.parent, x.middle)!;
    const archived = archiveColumn(new Tx(x.doc), snap)!;
    const restored = toggleArchivedColumn(new Tx(x.doc), archived)!;
    expect(toggleArchivedColumn(new Tx(x.doc), archived)).toBeNull();
    const peer = Doc.fromState(2, x.doc.encodeState()); x.doc.apply(peer.moveBlock(x.right, x.parent, 0));
    const tx = new Tx(x.doc);
    expect(toggleArchivedColumn(tx, restored)).toBeNull(); expect(tx.ops).toHaveLength(0);
    expect(x.doc.text(x.middle)).toBe("原文");
  });

  it("does not emit operations for stale snapshots or a different document", () => {
    const x = setup(), snap = captureColumnMove(x.doc, x.parent, x.middle)!;
    const peer = Doc.fromState(2, x.doc.encodeState());
    expect(archiveColumn(new Tx(peer), snap)).toBeNull();
    x.doc.apply(peer.moveBlock(x.right, x.parent, 0));
    const tx = new Tx(x.doc);
    expect(archiveColumn(tx, snap)).toBeNull(); expect(tx.ops).toHaveLength(0);
  });

  it("refuses ID exhaustion before making any change", () => {
    const x = setup();
    x.doc.apply({ t: "bcreate", id: { client: 99, clock: Number.MAX_SAFE_INTEGER - 1 }, parent: ROOT, pos: "Z", type: "paragraph" });
    const snapshot = captureColumnMove(x.doc, x.parent, x.middle)!, before = x.doc.encodeState(), tx = new Tx(x.doc);
    expect(archiveColumn(tx, snapshot)).toBeNull(); expect(tx.ops).toHaveLength(0);
    expect(x.doc.encodeState()).toEqual(before);
  });
});

import { describe, expect, it, vi } from "vitest";
import { Doc } from "../src/doc.js";
import { encodeOps } from "../src/encoding.js";
import { ROOT } from "../src/id.js";
import { decodeClientMsg, encodeServerMsg, type ClientMsg } from "../src/protocol.js";
import { SyncClient, type Peer, type SyncStatus } from "../src/sync.js";
import { Tx } from "../src/tx.js";
import { UndoManager } from "../src/undo.js";

function makeRecorder() {
  const sent: ClientMsg[] = [];
  const send = (b: Uint8Array) => sent.push(decodeClientMsg(b));
  return { sent, send };
}

describe("SyncClient edge cases", () => {
  it("handles awareness, peers, syncMode, clientId switch without snapshot, and full handler callbacks", () => {
    const events = {
      beforeRemote: 0,
      changes: [] as boolean[],
      peers: [] as Peer[][],
      statuses: [] as SyncStatus[],
      caughtUp: [] as boolean[],
      errors: [] as [string, string][],
      blocked: [] as (string | null)[],
    };

    const client = new SyncClient(10, {
      beforeRemote: () => events.beforeRemote++,
      change: (r) => events.changes.push(r),
      peers: (p) => events.peers.push(p),
      status: (s) => events.statuses.push(s),
      caughtUp: (c) => events.caughtUp.push(c),
      error: (c, m) => events.errors.push([c, m]),
      blocked: (b) => events.blocked.push(b),
    });

    expect(client.syncMode).toBeNull();

    // Ops before welcome throws
    expect(() =>
      client.receive(encodeServerMsg({ type: "ops", firstSeq: 1, batch: encodeOps([]) })),
    ).toThrow("ops before welcome");

    // Set awareness before opening: queued until welcome
    client.setAwareness({ cursor: 0 });
    const t1 = makeRecorder();
    client.open(t1.send);
    expect(t1.sent).toEqual([{ type: "hello", docId: 10, clientId: 0, lastSeq: 0 }]);

    // Receive welcome (v1, no snapshot): sends saved awareness and fires change(true)
    client.receive(encodeServerMsg({ type: "welcome", clientId: 1, headSeq: 0, snapshot: null }));
    expect(t1.sent.some((m) => m.type === "aware" && m.state === '{"cursor":0}')).toBe(true);
    expect(events.changes).toContain(true);
    expect(events.statuses).toContain("synced");

    // Set awareness while connected sends immediately
    client.setAwareness({ cursor: 5 });
    expect(t1.sent.at(-1)).toEqual({ type: "aware", state: '{"cursor":5}' });

    // Receive server aware messages: own id ignored, valid JSON stored, malformed ignored, empty deletes
    client.receive(encodeServerMsg({ type: "aware", clientId: 1, state: '{"self":true}' }));
    expect(events.peers).toEqual([]);

    client.receive(encodeServerMsg({ type: "aware", clientId: 2, state: '{"user":"alice"}' }));
    expect(events.peers.at(-1)).toEqual([{ clientId: 2, state: { user: "alice" } }]);

    client.receive(encodeServerMsg({ type: "aware", clientId: 3, state: "{bad-json" }));
    expect(events.peers.at(-1)).toEqual([{ clientId: 2, state: { user: "alice" } }]);

    client.receive(encodeServerMsg({ type: "aware", clientId: 2, state: "" }));
    expect(events.peers.at(-1)).toEqual([]);

    // Receive 1 remote op -> lastSeq advances to 1, fires change(true)
    const remoteDoc = new Doc(9);
    const b1 = remoteDoc.createBlock("paragraph");
    client.receive(encodeServerMsg({ type: "ops", firstSeq: 1, batch: encodeOps([b1]) }));
    expect(client.lastSeq).toBe(1);

    // Restore after first connection throws
    expect(() => client.restore(1, [])).toThrow("restore before the first connection");

    // Close clears peers (fires peers([])) and keeps doc
    client.close();
    expect(events.peers.at(-1)).toEqual([]);

    // Reopen and receive welcome with NEW clientId and NO snapshot: preserves doc & lastSeq without rebuilding
    const t2 = makeRecorder();
    client.open(t2.send);
    client.receive(encodeServerMsg({ type: "welcome", clientId: 2, headSeq: 1, snapshot: null }));
    expect(client.clientId).toBe(2);
    expect(client.doc!.client).toBe(2);
    expect(client.lastSeq).toBe(1);

    // Non-empty ACK for sync fence triggers gap
    const localOp = client.doc!.insertText(b1.id, 0, "hi")!;
    client.push([localOp]);
    expect(events.changes.at(-1)).toBe(false);
    // Data ACK enters awaitingFence
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 2, count: 1 }));
    // Non-empty fence ACK triggers gap
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 3, count: 1 }));
    expect(events.errors.at(-1)?.[0]).toBe("gap");

    // Generic server error invokes h.error
    client.receive(encodeServerMsg({ type: "error", code: "rate_limited", message: "slow down" }));
    expect(events.errors.at(-1)).toEqual(["rate_limited", "slow down"]);
  });

  it("handles non-empty fence ACK during causalIssue and valid empty fence ACK during causalIssue", () => {
    const blockedLog: (string | null)[] = [];
    const errors: [string, string][] = [];
    const client = new SyncClient(20, {
      blocked: (b) => blockedLog.push(b),
      error: (c, m) => errors.push([c, m]),
    });
    const t = makeRecorder();
    client.open(t.send);
    client.receive(encodeServerMsg({ type: "welcome", clientId: 1, headSeq: 0, snapshot: null }));

    // Push local op -> inflight
    const b = client.doc!.createBlock("paragraph");
    client.push([b]);
    // Receive data ACK -> awaitingFence = true
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 1, count: 1 }));

    // Remote op with missing dependency triggers causalIssue = "invalid_history" while awaitingFence = true
    const orphanRemote = { t: "bset" as const, id: { client: 9, clock: 5 }, block: { client: 9, clock: 1 }, key: "k", value: "v" };
    client.receive(encodeServerMsg({ type: "ops", firstSeq: 2, batch: encodeOps([orphanRemote]) }));
    expect(client.blocked).toBe("invalid_history");
    expect(blockedLog).toContain("invalid_history");

    // Non-empty ACK while awaitingFence && causalIssue triggers gap
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 3, count: 1 }));
    expect(errors.some(([c, m]) => c === "gap" && m.includes("sync fence"))).toBe(true);
  });

  it("handles restore validation, pending ttable on open, read-only projection edits/tables, unavailable/quarantine callbacks, and welcome gap rebuild", () => {
    // Invalid draft historyEpoch on restore
    const badRestore = new SyncClient(30);
    expect(() => badRestore.restore(1, [], null, 0)).toThrow("invalid draft history epoch");
    expect(() => badRestore.restore(1, [], null, -2)).toThrow("invalid draft history epoch");
    expect(() => badRestore.restore(1, [], null, 1.5)).toThrow("invalid draft history epoch");

    // Restoring a pending ttable op blocks on open()
    const ttableErrors: [string, string][] = [];
    const ttableBlocked: (string | null)[] = [];
    const ttableClient = new SyncClient(31, {
      error: (c, m) => ttableErrors.push([c, m]),
      blocked: (b) => ttableBlocked.push(b),
    });
    ttableClient.restore(1, [{ t: "ttable", id: { client: 1, clock: 2 }, block: { client: 1, clock: 1 }, payload: new Uint8Array([1]) }]);
    ttableClient.open(() => {});
    expect(ttableClient.blocked).toBe("table_unsupported");
    expect(ttableErrors[0]?.[0]).toBe("table_unsupported");
    expect(ttableBlocked).toContain("table_unsupported");

    // Read-only projection mode: syncMode, projection synced callbacks, push in projectionOnly, projection with tables
    const roChanges: boolean[] = [];
    let roBeforeRemote = 0;
    const roErrors: [string, string][] = [];
    const roBlocked: (string | null)[] = [];
    const roStatuses: SyncStatus[] = [];
    const roClient = new SyncClient(32, {
      beforeRemote: () => roBeforeRemote++,
      change: (r) => roChanges.push(r),
      error: (c, m) => roErrors.push([c, m]),
      blocked: (b) => roBlocked.push(b),
      status: (s) => roStatuses.push(s),
    });
    const baseState = new Doc(1).encodeState();
    roClient.open(() => {});
    roClient.receive(
      encodeServerMsg({
        type: "welcome",
        clientId: 1,
        headSeq: 0,
        snapshot: { seq: 0, state: baseState },
        historyEpoch: 1,
        mode: "view",
      }),
    );
    expect(roClient.syncMode).toBe("view");

    // Receive clean projection -> beforeRemote, change(true), synced
    const projDoc = new Doc(2);
    projDoc.createBlock("paragraph");
    roClient.receive(
      encodeServerMsg({
        type: "projection",
        headSeq: 1,
        historyEpoch: 1,
        state: projDoc.encodeState(),
      }),
    );
    expect(roBeforeRemote).toBeGreaterThanOrEqual(2);
    expect(roChanges.at(-1)).toBe(true);
    expect(roClient.status).toBe("synced");

    // Push null in projectionOnly does not block; push real op sets blocked = "read_only"
    roClient.push([null]);
    expect(roClient.blocked).toBeNull();
    const roEdit = roClient.doc!.createBlock("paragraph");
    roClient.push([roEdit]);
    expect(roClient.blocked).toBe("read_only");
    expect(roBlocked).toContain("read_only");

    // Receive another clean projection while blocked -> stays blocked (doesn't set synced)
    roClient.receive(
      encodeServerMsg({
        type: "projection",
        headSeq: 2,
        historyEpoch: 1,
        state: projDoc.encodeState(),
      }),
    );
    expect(roClient.blocked).toBe("read_only");

    // Receive projection containing tables -> blockUnsupportedTable
    const tableDoc = new Doc(3);
    const tb = tableDoc.createBlock("table");
    tableDoc.apply({ t: "ttable", id: { client: 3, clock: 2 }, block: tb.id, payload: new Uint8Array([1, 2]) });
    roClient.receive(
      encodeServerMsg({
        type: "projection",
        headSeq: 3,
        historyEpoch: 1,
        state: tableDoc.encodeState(),
      }),
    );
    expect(roClient.blocked).toBe("table_unsupported");
    expect(roErrors.at(-1)?.[0]).toBe("table_unsupported");

    // blockUnavailable callbacks (change + error) on projection_unavailable and requireMode violation
    const unavailChanges: boolean[] = [];
    const unavailErrors: [string, string][] = [];
    const unavailClient = new SyncClient(
      33,
      { change: (r) => unavailChanges.push(r), error: (c, m) => unavailErrors.push([c, m]) },
      { requireMode: true },
    );
    unavailClient.open(() => {});
    expect(() =>
      unavailClient.receive(encodeServerMsg({ type: "welcome", clientId: 1, headSeq: 0, snapshot: null, historyEpoch: 1 })),
    ).toThrow("sync mode negotiation required");
    expect(unavailChanges).toContain(true);
    expect(unavailErrors[0]?.[0]).toBe("protocol_incompatible");

    // Welcome with rebuilt=true AND sequenceGap (snapshot.seq > headSeq) fires change(true) + gap error
    const gapChanges: boolean[] = [];
    const gapErrors: [string, string][] = [];
    const gapClient = new SyncClient(34, {
      change: (r) => gapChanges.push(r),
      error: (c, m) => gapErrors.push([c, m]),
    });
    gapClient.open(() => {});
    gapClient.receive(
      encodeServerMsg({
        type: "welcome",
        clientId: 1,
        headSeq: 2,
        snapshot: { seq: 5, state: baseState },
      }),
    );
    expect(gapChanges).toContain(true);
    expect(gapErrors[0]?.[0]).toBe("gap");

    // Quarantine error callback & discardQuarantined change callback
    const qChanges: boolean[] = [];
    const qErrors: [string, string][] = [];
    const qClient = new SyncClient(35, {
      change: (r) => qChanges.push(r),
      error: (c, m) => qErrors.push([c, m]),
    });
    const draftOp = new Doc(1).createBlock("paragraph");
    qClient.restore(1, [draftOp], null, 1);
    qClient.open(() => {});
    qClient.receive(
      encodeServerMsg({
        type: "welcome",
        clientId: 1,
        headSeq: 0,
        snapshot: { seq: 0, state: baseState },
        historyEpoch: 2,
      }),
    );
    expect(qErrors.some(([c]) => c === "history_changed")).toBe(true);
    expect(qClient.discardQuarantined()).toBe(true);
    expect(qChanges.at(-1)).toBe(false);
  });
});

describe("UndoManager edge cases", () => {
  it("covers markers, limits, revision, shareRemappings, preview redo, discardMarker, empty tx, and remap cycles", () => {
    const doc = new Doc(1);
    const b1 = doc.createBlock("paragraph");
    const um = new UndoManager<string>();

    expect(um.revision).toBe(0);
    expect(um.peekMarker(false)).toBeNull();
    expect(um.peekMarker(true)).toBeNull();
    expect(um.undo(doc)).toBeNull();
    expect(um.redo(doc)).toBeNull();

    // Empty tx is ignored
    const emptyTx = new Tx(doc);
    um.record(emptyTx, null, null);
    expect(um.canUndo).toBe(false);

    // recordMarker merging and limit eviction
    um.limit = 2;
    um.recordMarker("m1");
    const revAfterM1 = um.revision;
    um.recordMarker("m1", true); // merged with top marker -> returns early
    expect(um.revision).toBe(revAfterM1 + 1);
    expect(um.peekMarker(false)).toBe("m1");
    um.recordMarker("m2", true); // different marker -> pushed
    um.recordMarker("m3", false); // exceeds limit=2 -> shifts "m1"
    expect(um.hasMarker("m1")).toBe(false);
    expect(um.peekMarker(false)).toBe("m3");

    // undo() on marker top returns null
    expect(um.undo(doc)).toBeNull();

    // moveMarker mismatch returns false; valid move puts on redo stack
    expect(um.moveMarker(false, "wrong")).toBe(false);
    expect(um.moveMarker(false, "m3")).toBe(true);
    expect(um.peekMarker(true)).toBe("m3");
    expect(um.redo(doc)).toBeNull(); // marker blocks redo

    // discardMarker: wrong revision, wrong marker, valid undo discard, valid redo discard
    expect(um.discardMarker(true, "m3", um.revision - 1)).toBe(false);
    expect(um.discardMarker(true, "wrong", um.revision)).toBe(false);
    expect(um.discardMarker(true, "m3", um.revision)).toBe(true);
    expect(um.peekMarker(true)).toBeNull();
    expect(um.discardMarker(false, "m2", um.revision)).toBe(true);
    expect(um.canUndo).toBe(false);

    // insertMarkerAt exceeding limit shifts oldest
    um.limit = 2;
    const tx1 = new Tx(doc);
    tx1.insert(b1.id, 0, "a");
    um.record(tx1, "s0", "s1");
    const token = um.markInsertionPoint();
    const tx2 = new Tx(doc);
    tx2.insert(b1.id, 1, "b");
    um.record(tx2, "s1", "s2");
    // Inserting at index 1 makes length 3 > limit 2 -> shifts oldest
    expect(um.insertMarkerAt(token, "inserted")).toBe(true);
    expect(um.hasMarker("inserted")).toBe(true);

    // preview(doc, true) previews redo without mutating manager
    const um2 = new UndoManager<string>();
    const tx3 = new Tx(doc);
    tx3.insert(b1.id, 2, "c");
    um2.record(tx3, "before", "after");
    um2.undo(doc);
    const clone = Doc.fromState(1, doc.encodeState());
    const previewRedo = um2.preview(clone, true);
    expect(previewRedo?.selection).toBe("after");
    expect(um2.canRedo).toBe(true);

    // exportState with maxUndos: 0, maxRedos: 0
    expect(um2.exportState({ maxUndos: 0, maxRedos: 0 })).toEqual({ v: 1, undos: [], redos: [], remap: [] });

    // shareRemappings & map() hitting 1000-step cycle cap
    const shared = new UndoManager<string>();
    shared.shareRemappings(um2);
    expect(
      um2.importState({
        v: 1,
        undos: [],
        redos: [],
        remap: [
          ["1:1", { client: 1, clock: 2 }],
          ["1:2", { client: 1, clock: 1 }],
        ],
      }),
    ).toBe(true);
    expect(shared.map({ client: 1, clock: 1 })).toEqual({ client: 1, clock: 1 });
  });

  it("validates every UndoItem, BlockSnap, marker, and remap branch in importState", () => {
    const um = new UndoManager();
    const id1 = { client: 1, clock: 1 };
    const id2 = { client: 1, clock: 2 };
    const snap = {
      id: id1,
      type: "paragraph",
      props: { level: "1" },
      chars: [id2],
      text: ["a"],
      marks: [{ bold: "1" }],
      parent: ROOT,
      after: null,
    };

    // Valid snapshot covering mark, prop, bdel (isBlockSnap), move, allowed & disallowed markers, and remap
    const valid = {
      v: 1,
      undos: [
        { items: [], marker: "drop-me" },
        { items: [], marker: "keep-me" },
        {
          items: [
            { k: "mark", block: id1, chars: [id2], key: "bold", prev: ["1"] },
            { k: "mark", block: id1, chars: [id2], key: "italic", prev: [null] },
            { k: "prop", block: id1, key: "checked", prev: "false" },
            { k: "bdel", snap },
            { k: "bdel", snap: { ...snap, after: id2 } },
            { k: "move", block: id1, parent: ROOT, after: null },
            { k: "move", block: id1, parent: ROOT, after: id2 },
          ],
        },
      ],
      redos: [],
      remap: [["1:1", { client: 1, clock: 9 }]],
    };
    expect(um.importState(valid, { allowMarker: (m) => m === "keep-me" })).toBe(true);
    expect(um.hasMarker("keep-me")).toBe(true);
    expect(um.hasMarker("drop-me")).toBe(false);
    expect(um.map(id1)).toEqual({ client: 1, clock: 9 });

    // Rejection cases for importState validation
    const badSnapshots: unknown[] = [
      // non-object entry in stack
      { v: 1, undos: [null], redos: [], remap: [] },
      // invalid marker (empty string & non-string)
      { v: 1, undos: [{ items: [], marker: "" }], redos: [], remap: [] },
      { v: 1, undos: [{ items: [], marker: 123 }], redos: [], remap: [] },
      // non-object item
      { v: 1, undos: [{ items: [null] }], redos: [], remap: [] },
      // unknown item kind
      { v: 1, undos: [{ items: [{ k: "bogus" }] }], redos: [], remap: [] },
      // invalid isStringRecord: non-object, array, non-string value
      { v: 1, undos: [{ items: [{ k: "del", block: id1, after: null, chars: [id2], text: ["a"], marks: [null] }] }], redos: [], remap: [] },
      { v: 1, undos: [{ items: [{ k: "del", block: id1, after: null, chars: [id2], text: ["a"], marks: [[]] }] }], redos: [], remap: [] },
      { v: 1, undos: [{ items: [{ k: "del", block: id1, after: null, chars: [id2], text: ["a"], marks: [{ bold: 123 }] }] }], redos: [], remap: [] },
      // invalid isBlockSnap: null snap & mismatched lengths
      { v: 1, undos: [{ items: [{ k: "bdel", snap: null }] }], redos: [], remap: [] },
      { v: 1, undos: [{ items: [{ k: "bdel", snap: { ...snap, text: [] } }] }], redos: [], remap: [] },
      // invalid remap entries
      { v: 1, undos: [], redos: [], remap: ["not-a-pair"] },
      { v: 1, undos: [], redos: [], remap: [["1:1"]] },
      { v: 1, undos: [], redos: [], remap: [[123, id1]] },
      { v: 1, undos: [], redos: [], remap: [["1:1", { client: -1, clock: 1 }]] },
    ];
    for (const bad of badSnapshots) {
      expect(um.importState(bad)).toBe(false);
    }
  });

  it("handles remote deletions, empty ranges, missing props, nested parents, and move boundaries during invert", () => {
    const doc = new Doc(1);
    const parent = doc.createBlock("paragraph");
    const b1 = doc.createBlock("paragraph", parent.id);
    const b2 = doc.createBlock("paragraph", parent.id);

    // 1. Deleted block causes ins, del, mark, prop, create, move inversions to return null safely
    const umDeleted = new UndoManager();
    const txDelCase = new Tx(doc);
    txDelCase.insert(b1.id, 0, "ab");
    txDelCase.format(b1.id, 0, 2, "bold", "1");
    txDelCase.setProp(b1.id, "checked", "true");
    txDelCase.delete(b1.id, 0, 1);
    txDelCase.move(b1.id, b2.id, parent.id);
    const b3 = txDelCase.create("paragraph", null, parent.id);
    umDeleted.record(txDelCase, null, null);
    // Remote peer deletes b1 and b3 before undo
    doc.deleteBlock(b1.id);
    doc.deleteBlock(b3);
    const resDeleted = umDeleted.undo(doc);
    expect(resDeleted?.ops).toEqual([]);

    // 2. ins & mark where chars were deleted remotely, prop where key is unset, del with empty text
    const b4 = doc.createBlock("paragraph");
    const umChars = new UndoManager();
    const txIns = new Tx(doc);
    txIns.insert(b4.id, 0, "xy");
    umChars.record(txIns, null, null);
    umChars.seal();
    const txMark = new Tx(doc);
    txMark.format(b4.id, 0, 2, "bold", "1");
    umChars.record(txMark, null, null);
    // Delete both chars remotely
    doc.deleteText(b4.id, 0, 2);
    // Undo mark -> chars gone -> returns null (no ops)
    expect(umChars.undo(doc)?.ops).toEqual([]);
    // Undo ins -> chars gone -> returns null (no ops)
    expect(umChars.undo(doc)?.ops).toEqual([]);

    // Import synthetic del with empty text (insertText returns null), unset prop, and bdel with [""] text
    const umSynth = new UndoManager();
    expect(
      umSynth.importState({
        v: 1,
        undos: [
          {
            items: [
              { k: "del", block: b4.id, after: null, chars: [], text: [], marks: [] },
              { k: "prop", block: b4.id, key: "neverSet", prev: "val" },
              { k: "prop", block: b4.id, key: "neverSet2", prev: "" },
              {
                k: "bdel",
                snap: {
                  id: { client: 9, clock: 1 },
                  type: "paragraph",
                  props: { checked: "true" },
                  chars: [{ client: 9, clock: 2 }],
                  text: [""],
                  marks: [{}],
                  parent: parent.id,
                  after: null,
                },
              },
            ],
          },
        ],
        redos: [],
        remap: [],
      }),
    ).toBe(true);
    const synthUndo = umSynth.undo(doc);
    expect(synthUndo).not.toBeNull();
    expect(doc.blockInfo(b4.id).props.neverSet).toBe("val");

    // 3. bdel under non-ROOT parent when parent is deleted -> falls back to ROOT, restoring props
    const pTemp = doc.createBlock("paragraph");
    const child = doc.createBlock("paragraph", pTemp.id);
    doc.setProp(child.id, "color", "blue");
    doc.insertText(child.id, 0, "hi");
    const umBdel = new UndoManager();
    const txBdel = new Tx(doc);
    txBdel.deleteBlock(child.id);
    umBdel.record(txBdel, null, null);
    doc.deleteBlock(pTemp.id); // parent deleted before undo
    umBdel.undo(doc);
    const restoredId = umBdel.map(child.id);
    expect(doc.blockInfo(restoredId).parent).toEqual(ROOT);
    expect(doc.blockInfo(restoredId).props.color).toBe("blue");

    // 4. move undo covering i === 0 (after: null), i > 0 (after: prev sibling), deleted it.parent -> ROOT, and it.after non-null vs null
    const docM = new Doc(1);
    const pAlive = docM.createBlock("paragraph");
    const m1 = docM.createBlock("paragraph", pAlive.id);
    const m2 = docM.createBlock("paragraph", pAlive.id);
    const umMove = new UndoManager();
    // Move m2 from after m1 to first under ROOT (i === 0 after move)
    const txM1 = new Tx(docM);
    txM1.move(m2.id, null, ROOT);
    umMove.record(txM1, null, null);
    umMove.seal();
    // Move m2 back after pAlive under ROOT (so m2 is at i > 0)
    const txM2 = new Tx(docM);
    txM2.move(m2.id, pAlive.id, ROOT);
    umMove.record(txM2, null, null);

    // Undo txM2: currently at i > 0 (back.after = pAlive), it.parent = ROOT, it.after = null
    umMove.undo(docM);
    // Delete pAlive before undoing txM1: currently at i === 0 (back.after = null), it.parent = pAlive (deleted -> ROOT!), it.after = m1
    docM.deleteBlock(pAlive.id);
    umMove.undo(docM);
    expect(docM.blockInfo(m2.id).parent).toEqual(ROOT);
  });
});

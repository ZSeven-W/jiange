import { describe, expect, it } from "vitest";
import { decodeClientMsg, decodeServerMsg, Doc, encodeOps, encodeServerMsg, SyncClient, type Op } from "../src/index";

/** Frames captured from the transport. */
const wire: { sent: Uint8Array[]; received: (m: ReturnType<typeof decodeServerMsg>) => void } = {
  sent: [],
  received: () => {},
};
const open = (c: SyncClient) => c.open((b) => wire.sent.push(b));
const lastHello = () => {
  for (let i = wire.sent.length - 1; i >= 0; i--) {
    const m = decodeClientMsg(wire.sent[i]);
    if (m.type === "hello") return m;
  }
  throw new Error("no hello");
};
const welcome = (epoch?: number, snapshot: { seq: number; state: Uint8Array } | null = null, head = 0) =>
  epoch === undefined
    ? encodeServerMsg({ type: "welcome", clientId: 1, headSeq: head, snapshot })
    : encodeServerMsg({ type: "welcome", clientId: 1, headSeq: head, snapshot, historyEpoch: epoch });
const ops = (first: number, batch: Op[]) => encodeServerMsg({ type: "ops", firstSeq: first, batch: encodeOps(batch) });

describe("history epoch negotiation", () => {
  it("first HELLO remains v1-compatible; a capable transport can receive a v2 welcome", () => {
    const c = new SyncClient(9);
    open(c);
    expect(lastHello()).toEqual({ type: "hello", docId: 9, clientId: 0, lastSeq: 0 });
    c.receive(welcome(4, { seq: 2, state: new Doc(1).encodeState() }, 2));
    expect(c.epoch).toBe(4);
    c.close();
    open(c);
    // safeSeq advanced to the snapshot head via the welcome's implicit ack
    expect(lastHello()).toEqual({ type: "hello", docId: 9, clientId: 1, lastSeq: 2, historyEpoch: 4 });
  });

  it("quarantines a v1 draft when the server first advertises an epoch", () => {
    const c = new SyncClient(9);
    open(c);
    const before = new Doc(1);
    const old = before.createBlock("paragraph");
    before.insertText(old.id, 0, "旧");
    c.receive(welcome(undefined, { seq: 2, state: before.encodeState() }, 2));
    const draft = c.doc!.insertText(old.id, 1, "草")!;
    c.push([draft]);
    c.close();
    open(c);
    const after = new Doc(1);
    const block = after.createBlock("paragraph");
    const replay: Op[] = [block, after.insertText(block.id, 0, "新")!];
    c.receive(welcome(2, null, replay.length));
    expect(c.lastSeq).toBe(0);
    expect(c.caughtUp).toBe(false);
    c.receive(ops(1, replay));
    expect(c.doc!.text(block.id)).toBe("新");
    expect(c.pendingOps().map((op) => op.id)).toEqual([draft.id]);
    expect(c.blocked).toBe("history_changed");
    expect(c.pendingHistoryEpoch).toBeNull();
    expect(c.epoch).toBe(2);
  });

  it("rebuilds after an epoch change even when the server also assigns a new client id", () => {
    const c = new SyncClient(9);
    open(c);
    const old = new Doc(1);
    const block = old.createBlock("paragraph");
    old.insertText(block.id, 0, "旧");
    c.receive(welcome(1, { seq: 2, state: old.encodeState() }, 2));
    c.close(); open(c);
    const restored = new Doc(1);
    const restoredBlock = restored.createBlock("paragraph");
    const replay: Op[] = [restoredBlock, restored.insertText(restoredBlock.id, 0, "新")!];
    c.receive(encodeServerMsg({ type: "welcome", clientId: 2, headSeq: 2, snapshot: null, historyEpoch: 2 }));
    c.receive(ops(1, replay));
    expect(c.clientId).toBe(2);
    expect(c.doc!.text(restoredBlock.id)).toBe("新");
    expect(c.caughtUp).toBe(true);
  });

  it("v1 server welcome leaves the client v1 (no epoch, no v2 hello)", () => {
    const c = new SyncClient(9);
    open(c);
    c.receive(welcome());
    expect(c.epoch).toBeNull();
    c.close();
    open(c);
    expect("historyEpoch" in lastHello()).toBe(false);
  });

  it("rejects a silent downgrade after v2 was established", () => {
    const errors: string[] = [];
    const c = new SyncClient(9, { error: (code) => errors.push(code) });
    open(c);
    c.receive(welcome(2));
    c.close();
    open(c);
    expect(() => c.receive(welcome())).toThrow("sync protocol downgrade");
    expect(c.epoch).toBe(2);
    expect(c.caughtUp).toBe(false);
    expect(errors).toEqual(["protocol_downgrade"]);
  });

  it("rejects an invalid zero epoch instead of treating it as a generation", () => {
    const errors: string[] = [];
    const c = new SyncClient(9, { error: (code) => errors.push(code) });
    open(c);
    expect(() => c.receive(welcome(0))).toThrow("invalid sync history epoch");
    expect(c.epoch).toBeNull();
    expect(c.caughtUp).toBe(false);
    expect(errors).toEqual(["invalid_epoch"]);
  });

  it("a changed epoch keeps pending drafts separate from replayed server history", () => {
    const c = new SyncClient(9);
    open(c);
    const base = new Doc(1);
    const p = base.createBlock("paragraph");
    const seed: Op[] = [p, base.insertText(p.id, 0, "史")!];
    c.receive(welcome(1, { seq: seed.length, state: base.encodeState() }, seed.length));
    // The draft was authored against the old history.
    const draft = (c.doc as Doc).insertText(p.id, 1, "草")!;
    c.push([draft]);

    // restore rewound the log to the same head with different content: epoch 2
    const rewound = new Doc(1);
    const p2 = rewound.createBlock("paragraph");
    const history: Op[] = [p2, rewound.insertText(p2.id, 0, "改")!];
    c.receive(welcome(2, null, history.length));
    expect(c.epoch).toBe(2);
    expect(c.droppedOnResync).toBe(1);
    // seq caches are void: the client accepts the replay from seq 1
    c.receive(ops(1, history));
    const view = (c.doc as Doc).view() as { blocks: { spans: { text: string }[] }[] };
    expect(view.blocks[0].spans.map((s) => s.text).join("")).toBe("改");
    expect(c.blocked).toBe("history_changed");
    expect(c.pendingHistoryEpoch).toBe(1);
    // The draft remains available for explicit backup; no retry silently sends it.
    expect(c.pendingOps().map((o) => o.id)).toEqual([draft.id]);
    const sentBefore = wire.sent.length;
    c.retryPending();
    expect(wire.sent).toHaveLength(sentBefore);
  });

  it("replays a persisted draft only when its generation matches", () => {
    const base = new Doc(1), block = base.createBlock("paragraph");
    base.insertText(block.id, 0, "原");
    const draft = base.insertText(block.id, 1, "草")!;
    for (const savedEpoch of [2, 1, null]) {
      const c = new SyncClient(9), sent: ReturnType<typeof decodeClientMsg>[] = [];
      c.restore(1, [draft], null, savedEpoch); c.open((bytes) => sent.push(decodeClientMsg(bytes)));
      const server = new Doc(1), p = server.createBlock("paragraph"); server.insertText(p.id, 0, "原");
      c.receive(welcome(2, { seq: 2, state: server.encodeState() }, 2));
      if (savedEpoch === 2) {
        expect(c.doc!.text(p.id)).toBe("原草");
        expect(c.blocked).toBeNull();
        expect(sent.some((message) => message.type === "ops")).toBe(true);
      } else {
        expect(c.doc!.text(p.id)).toBe("原");
        expect(c.blocked).toBe("history_changed");
        expect(c.pendingOps()).toEqual([draft]);
        expect(sent.some((message) => message.type === "ops")).toBe(false);
      }
    }
  });

  it("tracks the draft generation until the acknowledgement fence completes", () => {
    const c = new SyncClient(9); open(c); c.receive(welcome(3));
    const op = c.doc!.createBlock("paragraph"); c.push([op]);
    expect(c.pendingHistoryEpoch).toBe(3);
    c.receive(encodeServerMsg({ type: "ack", firstSeq: 1, count: 1 }));
    expect(c.pendingHistoryEpoch).toBe(3);
    c.receive(encodeServerMsg({ type: "ack", firstSeq: 2, count: 0 }));
    expect(c.pendingOps()).toEqual([]); expect(c.pendingHistoryEpoch).toBeNull();
  });

  it("keeps quarantine across reload and permits explicit discard only after catch-up", () => {
    const base = new Doc(1), block = base.createBlock("paragraph"); base.insertText(block.id, 0, "原");
    const draft = base.insertText(block.id, 1, "草")!;
    const c = new SyncClient(9); c.restore(1, [draft], "history_changed", 1); open(c);
    c.receive(welcome(2, null, 2));
    expect(c.discardQuarantined()).toBe(false);
    const server = new Doc(1), p = server.createBlock("paragraph"), text = server.insertText(p.id, 0, "新")!;
    c.receive(ops(1, [p, text]));
    expect(c.doc!.text(p.id)).toBe("新");
    expect(c.pendingOps()).toEqual([draft]);
    expect(c.discardQuarantined()).toBe(true);
    expect(c.pendingOps()).toEqual([]); expect(c.blocked).toBeNull(); expect(c.pendingHistoryEpoch).toBeNull();
    expect(c.discardQuarantined()).toBe(false);
  });

  it("does not replay a stale draft onto a new-generation snapshot", () => {
    const old = new Doc(1), block = old.createBlock("paragraph"); old.insertText(block.id, 0, "旧");
    const draft = old.insertText(block.id, 1, "草")!, current = new Doc(1), currentBlock = current.createBlock("paragraph"); current.insertText(currentBlock.id, 0, "新");
    const sent: ReturnType<typeof decodeClientMsg>[] = [], client = new SyncClient(9);
    client.restore(1, [draft], null, 1); client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    client.receive(welcome(2, { seq: 2, state: current.encodeState() }, 2));
    expect(client.blocked).toBe("history_changed"); expect(client.caughtUp).toBe(true);
    expect(client.doc!.text(currentBlock.id)).toBe("新"); expect(client.pendingOps()).toEqual([draft]);
    expect(sent.some((message) => message.type === "ops")).toBe(false);
  });

  it("does not mistake unresolved server history for a quarantined local dependency", () => {
    const source = new Doc(1), block = source.createBlock("paragraph"), draft = source.insertText(block.id, 0, "草")!;
    const c = new SyncClient(9); c.restore(1, [draft], null, 1); open(c);
    c.receive(welcome(2, null, 1)); c.receive(ops(1, [draft]));
    expect(c.blocked).toBe("invalid_history");
    expect(c.rejection).toBe("history_changed");
    expect(c.pendingOps()).toEqual([draft]); expect(c.discardQuarantined()).toBe(false);
  });

  it("retains pending operations if a rebuild callback throws before quarantine", () => {
    let fail = false;
    const c = new SyncClient(9, { beforeRemote: () => { if (fail) throw new Error("capture failed"); } });
    open(c);
    const old = new Doc(1), block = old.createBlock("paragraph"); old.insertText(block.id, 0, "旧");
    c.receive(welcome(1, { seq: 2, state: old.encodeState() }, 2));
    const draft = c.doc!.insertText(block.id, 1, "草")!; c.push([draft]);
    fail = true;
    expect(() => c.receive(welcome(2, null, 2))).toThrow("capture failed");
    expect(c.pendingOps()).toEqual([draft]);
    fail = false; c.close(); open(c);
    const next = new Doc(1), p = next.createBlock("paragraph"), text = next.insertText(p.id, 0, "新")!;
    c.receive(welcome(2, null, 2)); c.receive(ops(1, [p, text]));
    expect(c.blocked).toBe("history_changed"); expect(c.doc!.text(p.id)).toBe("新"); expect(c.pendingOps()).toEqual([draft]);
  });

  it("same epoch welcome does not resync", () => {
    const c = new SyncClient(9);
    open(c);
    const base = new Doc(1);
    const p = base.createBlock("paragraph");
    const seed: Op[] = [p, base.insertText(p.id, 0, "史")!];
    c.receive(welcome(1, { seq: seed.length, state: base.encodeState() }, seed.length));
    const before = c.droppedOnResync;
    c.receive(welcome(1, null, seed.length));
    expect(c.droppedOnResync).toBe(before);
  });
});

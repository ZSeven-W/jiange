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

  it("rebuilds a previously v1 replica when the server first advertises an epoch", () => {
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
    expect(c.doc!.text(block.id)).toBe("新草");
    expect(c.pendingOps().map((op) => op.id)).toEqual([draft.id]);
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

  it("a changed epoch rebuilds the replica from replayed history and keeps pending drafts", () => {
    const c = new SyncClient(9);
    open(c);
    const base = new Doc(1);
    const p = base.createBlock("paragraph");
    const seed: Op[] = [p, base.insertText(p.id, 0, "史")!];
    c.receive(welcome(1, { seq: seed.length, state: base.encodeState() }, seed.length));
    // local unacked draft rides on the restored history
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
    expect(view.blocks[0].spans.map((s) => s.text).join("")).toBe("改草");
    // the pending draft was preserved and is still awaiting its batch
    expect(c.pendingOps().map((o) => o.id)).toEqual([draft.id]);
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

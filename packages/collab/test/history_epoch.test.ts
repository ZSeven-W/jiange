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
  it("first contact stays v1; v2 hello only after a v2 welcome", () => {
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

  it("v1 server welcome leaves the client v1 (no epoch, no v2 hello)", () => {
    const c = new SyncClient(9);
    open(c);
    c.receive(welcome());
    expect(c.epoch).toBeNull();
    c.close();
    open(c);
    expect("historyEpoch" in lastHello()).toBe(false);
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

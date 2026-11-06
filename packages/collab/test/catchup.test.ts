import { describe, expect, it } from "vitest";
import { Doc, encodeOps, encodeServerMsg, SyncClient, type Op } from "../src/index";

const deliver = (client: SyncClient, msg: Parameters<typeof encodeServerMsg>[0]) => client.receive(encodeServerMsg(msg));
function remoteOps(): Op[] {
  const doc = new Doc(91);
  const block = doc.createBlock("paragraph");
  return [block, doc.insertText(block.id, 0, "a")!, doc.insertText(block.id, 1, "b")!];
}

describe("catch-up readiness", () => {
  it("waits for every consecutive batch through welcome head", () => {
    const changes: boolean[] = [];
    const client = new SyncClient(1, { caughtUp: (ready) => changes.push(ready) });
    const ops = remoteOps();
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 4, headSeq: 3, snapshot: null });
    expect(client.caughtUp).toBe(false);
    expect(client.status).toBe("syncing");
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps(ops.slice(0, 1)) });
    expect(client.caughtUp).toBe(false);
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps(ops.slice(1, 2)) });
    expect(client.caughtUp).toBe(false);
    deliver(client, { type: "ops", firstSeq: 3, batch: encodeOps(ops.slice(2)) });
    expect(client.caughtUp).toBe(true);
    expect(client.status).toBe("synced");
    expect(changes).toEqual([true]);
    client.close();
    expect(client.caughtUp).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("sets readiness immediately for a snapshot at head, independently of pending local acknowledgements", () => {
    const serverDoc = new Doc(8);
    const serverBlock = serverDoc.createBlock("paragraph");
    const localDoc = new Doc(9);
    const localBlock = localDoc.createBlock("paragraph");
    const client = new SyncClient(1);
    client.restore(9, [localBlock]);
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 9, headSeq: 1, snapshot: { seq: 1, state: serverDoc.encodeState() } });
    expect(client.caughtUp).toBe(true);
    expect(client.status).toBe("syncing");
    expect(client.unacked).toBe(1);
    deliver(client, { type: "ack", firstSeq: 2, count: 0 });
    deliver(client, { type: "ack", firstSeq: 2, count: 0 }); // empty OPS fence
    expect(client.caughtUp).toBe(true);
    expect(client.status).toBe("synced");
    expect(client.doc?.hasBlock(serverBlock.id)).toBe(true);
  });

  it("waits for post-snapshot history when the snapshot is behind head", () => {
    const authored = new Doc(31);
    const first = authored.createBlock("paragraph");
    const snapshot = authored.encodeState();
    const second = authored.insertText(first.id, 0, "a")!;
    const third = authored.insertText(first.id, 1, "b")!;
    const client = new SyncClient(1);
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 3, headSeq: 3, snapshot: { seq: 1, state: snapshot } });
    expect(client.caughtUp).toBe(false);
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps([second]) });
    expect(client.caughtUp).toBe(false);
    deliver(client, { type: "ops", firstSeq: 3, batch: encodeOps([third]) });
    expect(client.caughtUp).toBe(true);
    expect(client.doc?.text(first.id)).toBe("ab");
  });

  it("rejects an invalid snapshot sequence ahead of its advertised head", () => {
    const doc = new Doc(5);
    doc.createBlock("paragraph");
    const errors: string[] = [];
    const client = new SyncClient(1, { error: (code) => errors.push(code) });
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 5, headSeq: 1, snapshot: { seq: 2, state: doc.encodeState() } });
    expect(client.caughtUp).toBe(false);
    expect(client.status).toBe("syncing");
    expect(errors).toEqual(["gap"]);
  });

  it("does not report readiness for causally unresolved local operations after a snapshot", () => {
    const local = new Doc(7);
    const missing = local.createBlock("paragraph");
    const orphan = local.insertText(missing.id, 0, "x")!;
    const emptyServerDoc = new Doc(8);
    const client = new SyncClient(1);
    client.restore(7, [orphan]);
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 7, headSeq: 0, snapshot: { seq: 0, state: emptyServerDoc.encodeState() } });
    expect(client.doc?.pendingCount).toBe(1);
    expect(client.caughtUp).toBe(false);
    deliver(client, { type: "ack", firstSeq: 1, count: 0 });
    expect(client.caughtUp).toBe(false);
    expect(client.status).toBe("syncing");
  });

  it("does not treat a duplicate ACK as completion of remote catch-up", () => {
    const local = new Doc(7);
    const pending = local.createBlock("paragraph");
    const remote = remoteOps();
    const client = new SyncClient(1);
    client.restore(7, [pending]);
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 7, headSeq: 1, snapshot: null });
    deliver(client, { type: "ack", firstSeq: 2, count: 0 });
    deliver(client, { type: "ack", firstSeq: 2, count: 0 }); // empty OPS fence
    expect(client.unacked).toBe(0);
    expect(client.caughtUp).toBe(false);
    expect(client.status).toBe("syncing");
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps(remote.slice(0, 1)) });
    expect(client.caughtUp).toBe(true);
    expect(client.status).toBe("synced");
  });

  it("invalidates readiness on disconnect and waits for the new welcome head on reconnect", () => {
    const ops = remoteOps();
    const changes: boolean[] = [];
    const client = new SyncClient(1, { caughtUp: (ready) => changes.push(ready) });
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 1, headSeq: 1, snapshot: null });
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps(ops.slice(0, 1)) });
    expect(client.caughtUp).toBe(true);
    client.close();
    client.open(() => {});
    expect(client.caughtUp).toBe(false);
    deliver(client, { type: "welcome", clientId: 1, headSeq: 3, snapshot: null });
    expect(client.caughtUp).toBe(false);
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps(ops.slice(1)) });
    expect(client.caughtUp).toBe(true);
    expect(changes).toEqual([true, false, true]);
  });

  it("fails closed on an operation gap until a new connection catches up", () => {
    const ops = remoteOps();
    const errors: string[] = [];
    const client = new SyncClient(1, { error: (code) => errors.push(code) });
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 1, headSeq: 3, snapshot: null });
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps(ops.slice(1, 2)) });
    expect(client.lastSeq).toBe(0);
    expect(client.caughtUp).toBe(false);
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps(ops) });
    expect(client.lastSeq).toBe(3);
    expect(client.caughtUp).toBe(false);
    expect(client.status).toBe("syncing");
    client.close();
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 1, headSeq: 3, snapshot: null });
    expect(client.caughtUp).toBe(true);
    expect(errors).toEqual(["gap"]);
  });

  it("accepts an ACK for a local batch already observed in replay without moving backwards", () => {
    const errors: string[] = [];
    const client = new SyncClient(1, { error: (code) => errors.push(code) });
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 1, headSeq: 0, snapshot: null });
    const local = client.doc!.createBlock("paragraph");
    client.push([local]);
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([local]) });
    deliver(client, { type: "ack", firstSeq: 1, count: 1 });
    deliver(client, { type: "ack", firstSeq: 2, count: 0 }); // empty OPS fence
    expect(client.lastSeq).toBe(1);
    expect(client.caughtUp).toBe(true);
    expect(client.unacked).toBe(0);
    expect(client.status).toBe("synced");
    expect(errors).toEqual([]);
  });

  it("does not advance the replica sequence or remain ready on an out-of-order ACK", () => {
    const errors: string[] = [];
    const client = new SyncClient(1, { error: (code) => errors.push(code) });
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 1, headSeq: 0, snapshot: null });
    expect(client.caughtUp).toBe(true);
    const local = client.doc!.createBlock("paragraph");
    client.push([local]);
    deliver(client, { type: "ack", firstSeq: 2, count: 1 });
    expect(client.lastSeq).toBe(0);
    expect(client.caughtUp).toBe(false);
    expect(client.status).toBe("syncing");
    expect(client.unacked).toBe(1);
    client.close();
    expect(client.pendingOps()).toEqual([local]);
    expect(errors).toEqual(["gap"]);
  });
});

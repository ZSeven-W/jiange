import { describe, expect, it } from "vitest";
import { decodeClientMsg, Doc, encodeOps, encodeServerMsg, SyncClient, type ClientMsg, type Op } from "../src/index";

const deliver = (client: SyncClient, msg: Parameters<typeof encodeServerMsg>[0]) => client.receive(encodeServerMsg(msg));
const messages = (sent: ClientMsg[], kind: ClientMsg["type"]) => sent.filter((m) => m.type === kind);
function connect(client: SyncClient, sent: ClientMsg[], headSeq = 0) {
  client.open((bytes) => sent.push(decodeClientMsg(bytes)));
  deliver(client, { type: "welcome", clientId: 1, headSeq, snapshot: null });
}
function remote(): Op { return new Doc(2).createBlock("paragraph"); }

describe("safe GC horizon", () => {
  it("does not acknowledge remote changes or local ACK until all queued batches and their fences complete", () => {
    const sent: ClientMsg[] = [], client = new SyncClient(1);
    connect(client, sent);
    const local = client.doc!.createBlock("paragraph");
    const second = client.doc!.insertText(local.id, 0, "待同步")!;
    client.push([local]); client.push([second]);
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([remote()]) });
    deliver(client, { type: "ack", firstSeq: 2, count: 1 });
    expect(messages(sent, "ack")).toEqual([]);
    deliver(client, { type: "ack", firstSeq: 3, count: 0 }); // first fence; second batch now inflight
    expect(client.unacked).toBe(1);
    expect(messages(sent, "ack")).toEqual([]);
    const remote2 = new Doc(3).createBlock("paragraph");
    deliver(client, { type: "ops", firstSeq: 3, batch: encodeOps([remote2]) });
    deliver(client, { type: "ack", firstSeq: 4, count: 1 });
    expect(messages(sent, "ack")).toEqual([]);
    deliver(client, { type: "ack", firstSeq: 5, count: 0 }); // final fence
    expect(client.unacked).toBe(0);
    expect(messages(sent, "ack")).toEqual([{ type: "ack", seq: 4 }]);
  });

  it("reconnects from last safe horizon and tolerates overlapping replay while writes remain pending", () => {
    const sent: ClientMsg[] = [], client = new SyncClient(1);
    connect(client, sent);
    const firstRemote = remote();
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([firstRemote]) });
    expect(messages(sent, "ack")).toEqual([{ type: "ack", seq: 1 }]);
    const local = client.doc!.createBlock("paragraph");
    client.push([local]);
    const later = new Doc(3).createBlock("paragraph");
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps([later]) });
    expect(messages(sent, "ack")).toEqual([{ type: "ack", seq: 1 }]);
    client.close();
    const reconnected: ClientMsg[] = [];
    connect(client, reconnected, 2);
    expect(reconnected[0]).toEqual({ type: "hello", docId: 1, clientId: 1, lastSeq: 1 });
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps([later]) }); // already applied
    expect(client.lastSeq).toBe(2);
    expect(messages(reconnected, "ack")).toEqual([]);
    deliver(client, { type: "ack", firstSeq: 3, count: 1 });
    expect(messages(reconnected, "ack")).toEqual([]);
    deliver(client, { type: "ack", firstSeq: 4, count: 0 });
    expect(messages(reconnected, "ack")).toEqual([{ type: "ack", seq: 3 }]);
    expect(client.doc!.hasBlock(firstRemote.id)).toBe(true);
    expect(client.doc!.hasBlock(later.id)).toBe(true);
    expect(client.doc!.hasBlock(local.id)).toBe(true);
  });

  it("does not acknowledge after rejected writes, even while remote history arrives", () => {
    const sent: ClientMsg[] = [], client = new SyncClient(1);
    connect(client, sent);
    client.push([client.doc!.createBlock("paragraph")]);
    deliver(client, { type: "error", code: "read_only", message: "no edit" });
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([remote()]) });
    expect(messages(sent, "ack")).toEqual([]);
    expect(client.unacked).toBe(1);
    expect(client.blocked).toBe("read_only");
  });
});

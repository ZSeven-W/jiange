import { describe, expect, it } from "vitest";
import { decodeClientMsg, encodeOps, encodeServerMsg, SyncClient, type ClientMsg } from "../src/index";

function connected() {
  const sent: ClientMsg[] = [];
  const client = new SyncClient(42);
  client.open((bytes) => sent.push(decodeClientMsg(bytes)));
  client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 0, snapshot: null }));
  return { client, sent };
}

describe("rejected sync batches", () => {
  it("sends one batch at a time and retains all operations after read_only", () => {
    const { client, sent } = connected();
    const first = client.doc!.createBlock("paragraph");
    const second = client.doc!.insertText(first.id, 0, "保留")!;
    client.push([first]);
    client.push([second]);
    expect(sent.filter((m) => m.type === "ops")).toHaveLength(1);
    client.receive(encodeServerMsg({ type: "error", code: "read_only", message: "no edit permission" }));
    expect(client.blocked).toBe("read_only");
    expect(client.pendingOps()).toEqual([first, second]);
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 1, count: 0 }));
    expect(client.pendingOps()).toEqual([first, second]);
    client.close();
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 0, snapshot: null }));
    expect(sent.filter((m) => m.type === "ops")).toHaveLength(1);
    client.retryPending();
    expect(sent.filter((m) => m.type === "ops")).toHaveLength(2);
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 1, count: 2 }));
    expect(client.pendingOps()).toEqual([first, second]); // wait for the ordered fence
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 3, count: 0 }));
    expect(client.pendingOps()).toEqual([]);
  });

  it("retains a partly accepted batch when the server echoes accepted ops then rejects it", () => {
    const { client, sent } = connected();
    const first = client.doc!.createBlock("paragraph");
    const second = client.doc!.insertText(first.id, 0, "草稿")!;
    client.push([first, second]);
    client.receive(encodeServerMsg({ type: "ops", firstSeq: 1, batch: encodeOps([first]) }));
    client.receive(encodeServerMsg({ type: "error", code: "not_ready", message: "dependency missing" }));
    expect(client.lastSeq).toBe(1);
    expect(client.pendingOps()).toEqual([first, second]);
    expect(client.blocked).toBe("not_ready");
    client.close();
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 1, snapshot: null }));
    client.retryPending();
    expect(sent.filter((m) => m.type === "ops")).toHaveLength(2);
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 2, count: 1 }));
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 3, count: 0 }));
    expect(client.lastSeq).toBe(2);
    expect(client.pendingOps()).toEqual([]);
  });

  it("retains rejected operations with an old server that ACKs before not_ready", () => {
    const { client, sent } = connected();
    const first = client.doc!.createBlock("paragraph");
    const second = client.doc!.insertText(first.id, 0, "保留")!;
    client.push([first]);
    client.push([second]);
    // Legacy server's partial rejection sends an ACK(0), followed by error.
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 1, count: 0 }));
    expect(client.pendingOps()).toEqual([first, second]);
    expect(sent.filter((m) => m.type === "ops")).toHaveLength(2); // real batch + empty fence
    client.receive(encodeServerMsg({ type: "error", code: "not_ready", message: "rejected" }));
    client.retryPending(); // same socket cannot safely be retried
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 1, count: 0 })); // late fence ACK
    expect(client.pendingOps()).toEqual([first, second]);
    expect(client.blocked).toBe("not_ready");
    client.close();
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 0, snapshot: null }));
    client.retryPending();
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 1, count: 2 }));
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 3, count: 0 }));
    expect(client.pendingOps()).toEqual([]);
  });

  it("resends a committed batch if disconnected before its fence ACK", () => {
    const { client, sent } = connected();
    const first = client.doc!.createBlock("paragraph");
    client.push([first]);
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 1, count: 1 }));
    expect(client.pendingOps()).toEqual([first]);
    client.close();
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 1, snapshot: null }));
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 2, count: 0 })); // deduplicated replay
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 2, count: 0 })); // fence
    expect(client.pendingOps()).toEqual([]);
    expect(client.lastSeq).toBe(1);
  });

  it("restores an already blocked draft without transmitting before retry", () => {
    const { client: source } = connected();
    const op = source.doc!.createBlock("paragraph");
    const client = new SyncClient(42);
    client.restore(7, [op], "read_only");
    const sent: ClientMsg[] = [];
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 0, snapshot: null }));
    expect(sent.filter((m) => m.type === "ops")).toHaveLength(0);
    expect(client.pendingOps()).toEqual([op]);
    expect(client.blocked).toBe("read_only");
  });
});

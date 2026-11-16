import { describe, expect, it } from "vitest";
import { Doc, ROOT, decodeClientMsg, encodeOps, encodeServerMsg, SyncClient, type ClientMsg } from "../src/index";

function connected() {
  const sent: ClientMsg[] = [];
  const client = new SyncClient(42);
  client.open((bytes) => sent.push(decodeClientMsg(bytes)));
  client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 0, snapshot: null }));
  return { client, sent };
}

describe("rejected sync batches", () => {
  it("freezes an unsupported table response before welcome and retains a restored draft", () => {
    const { client: source } = connected(), op = source.doc!.createBlock("paragraph");
    const client = new SyncClient(42), sent: ClientMsg[] = [];
    client.restore(7, [op]); client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    client.receive(encodeServerMsg({ type: "error", code: "table_unsupported", message: "unsupported" }));
    expect(client.blocked).toBe("table_unsupported"); expect(client.pendingOps()).toEqual([op]);
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 0, snapshot: null }));
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 1, count: 1 }));
    expect(client.doc).toBeNull(); expect(client.pendingOps()).toEqual([op]);
    client.close(); const count = sent.length; client.open((bytes) => sent.push(decodeClientMsg(bytes))); client.retryPending();
    expect(sent).toHaveLength(count); expect(client.blocked).toBe("table_unsupported");
  });
  it("stops an already-open document even without pending writes", () => {
    const { client, sent } = connected();
    client.receive(encodeServerMsg({ type: "error", code: "table_unsupported", message: "unsupported" }));
    expect(client.blocked).toBe("table_unsupported"); expect(client.status).toBe("offline");
    const op = client.doc!.createBlock("paragraph"); client.push([op]);
    expect(sent.filter((m) => m.type === "ops")).toHaveLength(0);
    expect(client.pendingOps()).toEqual([op]);
  });
  it("rejects an old server's opaque table snapshot before exposing it or consuming a draft", () => {
    const old = new Doc(5), block = old.createBlock("table", ROOT);
    old.apply({ t: "ttable", id: old.allocateOpIds()[0], block: block.id, payload: new Uint8Array([1]) });
    const { client: source } = connected(), pending = source.doc!.createBlock("paragraph");
    const client = new SyncClient(42), sent: ClientMsg[] = [];
    client.restore(7, [pending]); client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 2, snapshot: { seq: 2, state: old.encodeState() } }));
    expect(client.blocked).toBe("table_unsupported"); expect(client.doc).toBeNull();
    expect(client.pendingOps()).toEqual([pending]); expect(sent.filter((m) => m.type === "ops")).toHaveLength(0);
  });
  it("rejects a mixed live batch from an old server without applying its safe prefix or acknowledging it", () => {
    const { client, sent } = connected(), peer = new Doc(8), block = peer.createBlock("table", ROOT);
    const table = { t: "ttable" as const, id: peer.allocateOpIds()[0], block: block.id, payload: new Uint8Array([1]) };
    const before = client.doc!.encodeState();
    client.receive(encodeServerMsg({ type: "ops", firstSeq: 1, batch: encodeOps([block, table]) }));
    expect(client.blocked).toBe("table_unsupported"); expect(client.lastSeq).toBe(0);
    expect(client.doc!.encodeState()).toEqual(before); expect(sent.filter((m) => m.type === "ack")).toHaveLength(0);
  });
  it("retains but never sends locally queued experimental table operations", () => {
    const { client, sent } = connected(), block = client.doc!.createBlock("table", ROOT);
    const table = { t: "ttable" as const, id: client.doc!.allocateOpIds()[0], block: block.id, payload: new Uint8Array([1]) };
    client.push([block, table]);
    expect(client.pendingOps()).toEqual([block, table]); expect(client.blocked).toBe("table_unsupported");
    expect(sent.filter((m) => m.type === "ops")).toHaveLength(0);
  });
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

import { describe, expect, it } from "vitest";
import { decodeClientMsg, decodeOps, Doc, encodeOps, encodeServerMsg, SyncClient, type ClientMsg, type Op } from "../src/index";

const deliver = (client: SyncClient, message: Parameters<typeof encodeServerMsg>[0]) => client.receive(encodeServerMsg(message));
const orphan = (client: number, text: string): [Op, Op] => {
  const source = new Doc(client);
  const block = source.createBlock("paragraph");
  return [block, source.insertText(block.id, 0, text)!];
};
const types = (sent: ClientMsg[], type: ClientMsg["type"]) => sent.filter((m) => m.type === type);

describe("causal recovery", () => {
  it("keeps an orphaned local draft at snapshot head and resumes when its dependency arrives", () => {
    const [missingBlock, localText] = orphan(7, "本地草稿");
    const sent: ClientMsg[] = [], errors: string[] = [];
    const client = new SyncClient(4, { error: (code) => errors.push(code) });
    client.restore(7, [localText]);
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    deliver(client, { type: "welcome", clientId: 7, headSeq: 0, snapshot: { seq: 0, state: new Doc(8).encodeState() } });
    expect(client.blocked).toBe("missing_dependency");
    expect(client.pendingOps()).toEqual([localText]);
    expect(client.doc?.pendingCount).toBe(1);
    expect(types(sent, "ops")).toHaveLength(0);
    expect(types(sent, "ack")).toHaveLength(0);
    expect(errors).toEqual(["missing_dependency"]);

    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([missingBlock]) });
    expect(client.blocked).toBeNull();
    expect(client.doc?.text(missingBlock.id)).toBe("本地草稿");
    expect(client.caughtUp).toBe(true);
    expect(types(sent, "ops")).toHaveLength(1);
    expect(types(sent, "ack")).toHaveLength(0);
    deliver(client, { type: "ack", firstSeq: 2, count: 1 });
    deliver(client, { type: "ack", firstSeq: 3, count: 0 });
    expect(client.pendingOps()).toEqual([]);
    expect(client.status).toBe("synced");
  });

  it("does not drop local drafts after a multi-batch catch-up or across reload", () => {
    const [, localText] = orphan(7, "草稿");
    const remote = new Doc(11), first = remote.createBlock("paragraph"), second = remote.insertText(first.id, 0, "远端")!;
    const client = new SyncClient(4);
    client.restore(7, [localText]);
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 7, headSeq: 2, snapshot: { seq: 0, state: new Doc(8).encodeState() } });
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([first]) });
    expect(client.blocked).toBeNull();
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps([second]) });
    expect(client.blocked).toBe("missing_dependency");
    expect(client.doc?.pendingCount).toBe(1);
    expect(client.pendingOps()).toEqual([localText]);
    expect(client.droppedOnResync).toBe(0);
    const saved = JSON.parse(JSON.stringify({ clientId: client.clientId, ops: client.pendingOps(), blocked: client.blocked }));
    client.close();
    const reloaded = new SyncClient(4);
    reloaded.restore(saved.clientId, saved.ops, saved.blocked);
    reloaded.open(() => {});
    deliver(reloaded, { type: "welcome", clientId: 7, headSeq: 0, snapshot: { seq: 0, state: new Doc(8).encodeState() } });
    expect(reloaded.blocked).toBe("missing_dependency");
    expect(reloaded.pendingOps()).toEqual([localText]);
  });

  it("distinguishes incomplete server history and never ACKs until it resolves", () => {
    const [block, text] = orphan(12, "远端");
    const sent: ClientMsg[] = [], events: string[] = [];
    const client = new SyncClient(4, { error: (code) => events.push(code) });
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    deliver(client, { type: "welcome", clientId: 7, headSeq: 1, snapshot: null });
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([text]) });
    expect(client.blocked).toBe("invalid_history");
    expect(client.doc?.pendingCount).toBe(1);
    expect(client.caughtUp).toBe(false);
    expect(types(sent, "ack")).toHaveLength(0);
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps([block]) });
    expect(client.blocked).toBeNull();
    expect(client.doc?.text(block.id)).toBe("远端");
    expect(client.caughtUp).toBe(true);
    expect(types(sent, "ack")).toEqual([{ type: "ack", seq: 2 }]);
    expect(events).toEqual(["invalid_history"]);
  });

  it("leaves synced status if a later live operation has a missing dependency", () => {
    const [block, text] = orphan(12, "远端");
    const client = new SyncClient(4);
    client.open(() => {});
    deliver(client, { type: "welcome", clientId: 7, headSeq: 0, snapshot: null });
    expect(client.status).toBe("synced");
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([text]) });
    expect(client.blocked).toBe("invalid_history");
    expect(client.status).toBe("syncing");
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps([block]) });
    expect(client.status).toBe("synced");
  });

  it("advances ACK sequence without confirming an inflight draft until dependency and fence", () => {
    const [remoteBlock, remoteText] = orphan(12, "远端");
    const sent: ClientMsg[] = [], errors: string[] = [];
    const client = new SyncClient(4, { error: (code) => errors.push(code) });
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    deliver(client, { type: "welcome", clientId: 7, headSeq: 0, snapshot: null });
    const local = client.doc!.createBlock("paragraph");
    client.push([local]);
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([remoteText]) });
    deliver(client, { type: "ack", firstSeq: 2, count: 1 });
    deliver(client, { type: "ack", firstSeq: 2, count: 1 }); // repeated ACK
    expect(client.lastSeq).toBe(2);
    expect(client.pendingOps()).toEqual([local]);
    expect(types(sent, "ops")).toHaveLength(1);
    expect(types(sent, "ack")).toHaveLength(0);
    // Repeated OPS plus a range overlapping the ACKed local sequence.
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([remoteText]) });
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps([local, remoteBlock]) });
    expect(client.blocked).toBeNull();
    expect(client.doc?.text(remoteBlock.id)).toBe("远端");
    expect(types(sent, "ops")).toHaveLength(2);
    expect(client.pendingOps()).toEqual([local]);
    expect(types(sent, "ack")).toHaveLength(0);
    deliver(client, { type: "ack", firstSeq: 4, count: 0 });
    expect(client.pendingOps()).toEqual([]);
    expect(types(sent, "ack")).toEqual([{ type: "ack", seq: 3 }]);
    expect(client.status).toBe("synced");
    expect(errors).toEqual(["invalid_history"]);
  });

  it("forgets a deferred ACK on disconnect and resends after contiguous history", () => {
    const [remoteBlock, remoteText] = orphan(12, "远端");
    const sent: ClientMsg[] = [];
    const client = new SyncClient(4);
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    deliver(client, { type: "welcome", clientId: 7, headSeq: 0, snapshot: null });
    const local = client.doc!.createBlock("paragraph");
    client.push([local]);
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([remoteText]) });
    deliver(client, { type: "ack", firstSeq: 2, count: 1 });
    client.close();
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    expect(sent.at(-1)).toEqual({ type: "hello", docId: 4, clientId: 7, lastSeq: 0 });
    deliver(client, { type: "welcome", clientId: 7, headSeq: 3, snapshot: null });
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([remoteText, local, remoteBlock]) });
    expect(client.pendingOps()).toEqual([local]);
    expect(types(sent, "ops")).toHaveLength(2);
    deliver(client, { type: "ack", firstSeq: 4, count: 0 });
    deliver(client, { type: "ack", firstSeq: 4, count: 0 });
    expect(client.pendingOps()).toEqual([]);
  });

  it("rejects gaps and conflicting deferred ACKs without releasing the draft", () => {
    for (const conflict of [false, true]) {
      const [remoteBlock, remoteText] = orphan(12, "远端");
      const sent: ClientMsg[] = [], errors: string[] = [];
      const client = new SyncClient(4, { error: (code) => errors.push(code) });
      client.open((bytes) => sent.push(decodeClientMsg(bytes)));
      deliver(client, { type: "welcome", clientId: 7, headSeq: 0, snapshot: null });
      const local = client.doc!.createBlock("paragraph");
      client.push([local]);
      deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([remoteText]) });
      if (conflict) deliver(client, { type: "ack", firstSeq: 2, count: 1 });
      deliver(client, { type: "ack", firstSeq: conflict ? 3 : 4, count: 1 });
      expect(errors).toContain("gap");
      deliver(client, { type: "ops", firstSeq: conflict ? 3 : 2, batch: encodeOps([remoteBlock]) });
      deliver(client, { type: "ack", firstSeq: 4, count: 0 });
      expect(client.pendingOps()).toEqual([local]);
      expect(types(sent, "ack")).toHaveLength(0);
      client.close();
      expect(client.pendingOps()).toEqual([local]);
    }
  });

  it("reports remote corruption ahead of local missing dependencies without losing the draft", () => {
    const [localBlock, localText] = orphan(7, "本地");
    const [remoteBlock, remoteText] = orphan(12, "远端");
    const sent: ClientMsg[] = [], events: string[] = [];
    const client = new SyncClient(4, { error: (code) => events.push(code) });
    client.restore(7, [localText]);
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    deliver(client, { type: "welcome", clientId: 7, headSeq: 1, snapshot: { seq: 0, state: new Doc(8).encodeState() } });
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([remoteText]) });
    expect(client.blocked).toBe("invalid_history");
    expect(client.pendingOps()).toEqual([localText]);
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps([remoteBlock]) });
    expect(client.blocked).toBe("missing_dependency");
    expect(client.pendingOps()).toEqual([localText]);
    expect(types(sent, "ack")).toHaveLength(0);
    deliver(client, { type: "ops", firstSeq: 3, batch: encodeOps([localBlock]) });
    expect(client.blocked).toBeNull();
    expect(client.doc?.text(remoteBlock.id)).toBe("远端");
    expect(client.doc?.text(localBlock.id)).toBe("本地");
    expect(types(sent, "ops")).toHaveLength(1);
    expect(events).toEqual(["invalid_history", "missing_dependency"]);
  });

  it("keeps an earlier permission rejection while a missing draft dependency is resolved", () => {
    const [block, text] = orphan(7, "保留");
    const sent: ClientMsg[] = [];
    const client = new SyncClient(4);
    client.restore(7, [text], "read_only");
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    deliver(client, { type: "welcome", clientId: 7, headSeq: 0, snapshot: { seq: 0, state: new Doc(8).encodeState() } });
    expect(client.blocked).toBe("missing_dependency");
    expect(client.rejection).toBe("read_only");
    deliver(client, { type: "ops", firstSeq: 1, batch: encodeOps([block]) });
    expect(client.blocked).toBe("read_only");
    expect(client.pendingOps()).toEqual([text]);
    expect(types(sent, "ops")).toHaveLength(0);
  });

  it("reserves a restored multi-character draft ID range before edits during catch-up", () => {
    const source = new Doc(7), missing = source.createBlock("paragraph");
    const draft = source.insertText(missing.id, 0, "草😀稿")!;
    const server = new Doc(12), existing = server.createBlock("paragraph");
    const snapshot = server.encodeState(), remote = new Doc(14).createBlock("paragraph");
    const sent: ClientMsg[] = [];
    const client = new SyncClient(4);
    client.restore(7, [draft]);
    client.open((bytes) => sent.push(decodeClientMsg(bytes)));
    deliver(client, { type: "welcome", clientId: 7, headSeq: 3, snapshot: { seq: 1, state: snapshot } });
    const edit = client.doc!.setProp(existing.id, "color", "red");
    client.push([edit]);
    expect(edit.id.clock).toBe(draft.id.clock + 3);
    expect(types(sent, "ops")).toHaveLength(0);
    deliver(client, { type: "ops", firstSeq: 2, batch: encodeOps([missing, remote]) });
    const writes = types(sent, "ops");
    expect(writes).toHaveLength(1);
    const batch = writes[0];
    if (batch.type !== "ops") throw new Error("expected ops");
    const received = decodeOps(batch.batch);
    expect(received.map((op) => op.id)).toEqual([draft.id, edit.id]);
    for (const op of [missing, remote, ...received]) server.apply(op);
    deliver(client, { type: "ack", firstSeq: 4, count: 2 });
    deliver(client, { type: "ack", firstSeq: 6, count: 0 });
    expect(client.pendingOps()).toEqual([]);
    expect(client.status).toBe("synced");
    expect(server.text(missing.id)).toBe("草😀稿");
    expect(server.view().blocks.find((b) => b.id === `${existing.id.client}:${existing.id.clock}`)?.props.color).toBe("red");
  });

  it("reserves remote and duplicate buffered spans and rejects overflow", () => {
    const [missing, draft] = orphan(42, "😀甲乙");
    const doc = new Doc(7);
    expect(doc.apply(draft)).toBe(true);
    expect(doc.apply(draft)).toBe(false);
    const next = doc.createBlock("paragraph");
    expect(next.id.clock).toBe(draft.id.clock + 3);
    doc.apply(missing);
    expect(doc.text(missing.id)).toBe("😀甲乙");
    const tooLarge = { ...draft, id: { client: 42, clock: Number.MAX_SAFE_INTEGER }, text: "ab" };
    expect(() => doc.apply(tooLarge)).toThrow(RangeError);
    const boundary = { ...draft, id: { client: 42, clock: Number.MAX_SAFE_INTEGER }, text: "a" };
    doc.apply(boundary);
    expect(() => doc.createBlock("paragraph")).toThrow(RangeError);
    expect(() => doc.encodeState()).not.toThrow();
  });

  it("does not expose mutable references to buffered operation IDs", () => {
    const [, text] = orphan(7, "草稿");
    const doc = new Doc(8);
    doc.apply(text);
    const ids = doc.pendingIds();
    ids[0].clock = 999;
    expect(doc.pendingIds()).toEqual([text.id]);
  });
});

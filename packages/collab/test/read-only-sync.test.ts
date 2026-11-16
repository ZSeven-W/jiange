import { describe, expect, it } from "vitest";
import { Doc, ROOT, SyncClient, decodeClientMsg, decodeServerMsg, encodeServerMsg, type ClientMsg } from "../src/index";

describe("read-only synchronization protocol", () => {
  it("encodes mode-bound welcomes and replacement projections", () => {
    const state = new Doc(7).encodeState();
    for (const mode of ["edit", "view"] as const) {
      const welcome = { type: "welcome" as const, clientId: 7, headSeq: 3, historyEpoch: 2, snapshot: { seq: 3, state }, mode };
      expect(decodeServerMsg(encodeServerMsg(welcome))).toEqual(welcome);
    }
    const projection = { type: "projection" as const, headSeq: 4, historyEpoch: 2, state };
    expect(decodeServerMsg(encodeServerMsg(projection))).toEqual(projection);
    expect([...encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 3, historyEpoch: 2, snapshot: { seq: 3, state: new Uint8Array([1, 2, 3]) }, mode: "view" })]).toEqual([0x11, 7, 3, 1, 3, 3, 1, 2, 3, 2, 1]);
    expect([...encodeServerMsg({ type: "projection", headSeq: 4, historyEpoch: 2, state: new Uint8Array([1, 2, 3]) })]).toEqual([0x16, 4, 2, 3, 1, 2, 3]);
    expect(() => decodeServerMsg(new Uint8Array([0x11, 7, 3, 2]))).toThrow("invalid snapshot flag");
  });

  it("quarantines edits while viewing, replaces snapshots, and retries only after an editing reconnect", () => {
    const initial = new Doc(1), block = initial.createBlock("paragraph", ROOT);
    const original = initial.encodeState();
    const client = new SyncClient(12, {}, { requireMode: true });
    let sent: ClientMsg[] = [];
    const open = () => { sent = []; client.open((bytes) => sent.push(decodeClientMsg(bytes))); };
    open();
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 1, historyEpoch: 1, snapshot: { seq: 1, state: original }, mode: "edit" }));
    const draft = client.doc!.insertText(block.id, 0, "本地草稿")!;
    client.push([draft]);
    expect(sent.some((m) => m.type === "ops")).toBe(true);
    client.close(); open();
    client.receive(encodeServerMsg({ type: "welcome", clientId: 8, headSeq: 1, historyEpoch: 1, snapshot: { seq: 1, state: original }, mode: "view" }));
    expect(client.projectionOnly).toBe(true);
    expect(client.clientId).toBe(8);
    expect(client.blocked).toBe("read_only");
    expect(client.doc!.text(block.id)).toBe("");
    expect(client.pendingOps()).toEqual([draft]);
    expect(sent.some((m) => m.type === "ops")).toBe(false);
    const remote = Doc.fromState(8, original);
    remote.insertText(block.id, 0, "云端内容");
    client.receive(encodeServerMsg({ type: "projection", headSeq: 2, historyEpoch: 1, state: remote.encodeState() }));
    expect(client.doc!.text(block.id)).toBe("云端内容");
    client.retryPending();
    expect(sent.some((m) => m.type === "ops")).toBe(false);
    expect(() => client.receive(encodeServerMsg({ type: "projection", headSeq: 3, historyEpoch: 2, state: original }))).toThrow("invalid read-only projection");
    client.close(); open();
    client.receive(encodeServerMsg({ type: "welcome", clientId: 8, headSeq: 2, historyEpoch: 1, snapshot: { seq: 2, state: remote.encodeState() }, mode: "edit" }));
    expect(client.projectionOnly).toBe(false);
    expect(client.pendingOps()).toEqual([draft]);
    client.retryPending();
    expect(sent.some((m) => m.type === "ops")).toBe(true);
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 3, count: 1 }));
    client.receive(encodeServerMsg({ type: "ack", firstSeq: 4, count: 0 }));
    expect(client.pendingOps()).toEqual([]);
  });

  it("rejects legacy or incremental data when projection negotiation is required", () => {
    const client = new SyncClient(12, {}, { requireMode: true });
    client.open(() => {});
    expect(() => client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 0, snapshot: null, historyEpoch: 1 }))).toThrow("sync mode negotiation required");
    expect(() => client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 0, snapshot: null, historyEpoch: 1, mode: "view" }))).toThrow("complete snapshot");
    const state = new Doc(1).encodeState();
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 0, snapshot: { seq: 0, state }, historyEpoch: 1, mode: "view" }));
    expect(() => client.receive(encodeServerMsg({ type: "ops", firstSeq: 1, batch: new Uint8Array() }))).toThrow("raw operations");
  });

  it("hides an unavailable projection, retains drafts, and reconnects without automatically sending them", () => {
    const base = new Doc(1), block = base.createBlock("paragraph", ROOT), state = base.encodeState();
    const client = new SyncClient(12, {}, { requireMode: true });
    let sent: ClientMsg[] = [];
    const open = () => { sent = []; client.open((bytes) => sent.push(decodeClientMsg(bytes))); };
    open();
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 1, historyEpoch: 1, snapshot: { seq: 1, state }, mode: "edit" }));
    const draft = client.doc!.insertText(block.id, 0, "未保存")!;
    client.push([draft]);
    client.receive(encodeServerMsg({ type: "error", code: "projection_unavailable", message: "unavailable" }));
    expect(client.doc).toBeNull();
    expect(client.pendingOps()).toEqual([draft]);
    expect(client.blocked).toBe("projection_unavailable");
    client.close(); open();
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 1, historyEpoch: 1, snapshot: { seq: 1, state }, mode: "view" }));
    expect(client.blocked).toBe("read_only");
    expect(client.doc!.text(block.id)).toBe("");
    expect(client.pendingOps()).toEqual([draft]);
    expect(sent.some((m) => m.type === "ops")).toBe(false);
  });

  it("keeps a local draft when an older server does not negotiate a mode", () => {
    const base = new Doc(1), block = base.createBlock("paragraph", ROOT), state = base.encodeState();
    const client = new SyncClient(12, {}, { requireMode: true });
    let sent: ClientMsg[] = [];
    const open = () => { sent = []; client.open((bytes) => sent.push(decodeClientMsg(bytes))); };
    open();
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 1, historyEpoch: 1, snapshot: { seq: 1, state }, mode: "edit" }));
    const draft = client.doc!.insertText(block.id, 0, "本地")!;
    client.push([draft]);
    client.close(); open();
    expect(() => client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 1, historyEpoch: 1, snapshot: { seq: 1, state } }))).toThrow("sync mode negotiation required");
    expect(client.doc).toBeNull();
    expect(client.pendingOps()).toEqual([draft]);
    expect(client.blocked).toBe("protocol_incompatible");
    client.close(); open();
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 1, historyEpoch: 1, snapshot: { seq: 1, state }, mode: "edit" }));
    expect(client.blocked).toBe("not_ready");
    expect(sent.some((m) => m.type === "ops")).toBe(false);
    client.retryPending();
    expect(sent.some((m) => m.type === "ops")).toBe(true);
  });

  it("keeps a changed-epoch draft quarantined across a view-to-edit upgrade", () => {
    const base = new Doc(1), block = base.createBlock("paragraph", ROOT), state = base.encodeState();
    const client = new SyncClient(12, {}, { requireMode: true });
    const open = () => client.open(() => {});
    open();
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 1, historyEpoch: 1, snapshot: { seq: 1, state }, mode: "edit" }));
    const draft = client.doc!.insertText(block.id, 0, "旧代际")!;
    client.push([draft]); client.close(); open();
    client.receive(encodeServerMsg({ type: "welcome", clientId: 8, headSeq: 1, historyEpoch: 2, snapshot: { seq: 1, state }, mode: "view" }));
    expect(client.blocked).toBe("history_changed");
    expect(client.doc!.text(block.id)).toBe("");
    expect(client.pendingOps()).toEqual([draft]);
    client.close(); open();
    client.receive(encodeServerMsg({ type: "welcome", clientId: 8, headSeq: 1, historyEpoch: 2, snapshot: { seq: 1, state }, mode: "edit" }));
    expect(client.blocked).toBe("history_changed");
    expect(client.doc!.text(block.id)).toBe("");
    expect(client.pendingOps()).toEqual([draft]);
  });
});

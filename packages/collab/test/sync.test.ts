import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeClientMsg, decodeOps, decodeServerMsg, Doc, encodeOps, encodeServerMsg, fromHex, rng, ROOT, SyncClient, toHex,
  type Op,
} from "../src/index";

const vec = (f: string) => JSON.parse(readFileSync(resolve(__dirname, "../../../spec/vectors", f), "utf8"));

describe("state encoding", () => {
  const scenarios = vec("scenarios.json") as { name: string; ops: Op[]; expected: unknown }[];
  const states = vec("state.json") as { name: string; hex: string }[];
  for (const [i, s] of scenarios.entries()) {
    it(`round-trips ${s.name}`, () => {
      const d = Doc.fromState(3, fromHex(states[i].hex));
      expect(d.view()).toEqual(s.expected);
      expect(toHex(d.encodeState())).toBe(states[i].hex);
      // a restored replica keeps working: re-applying old ops is a no-op
      for (const op of s.ops) d.apply(op);
      expect(d.view()).toEqual(s.expected);
    });
  }
  it("restored replica continues editing", () => {
    const a = new Doc(1);
    const p = a.createBlock("paragraph");
    a.insertText(p.id, 0, "hello");
    const b = Doc.fromState(2, a.encodeState());
    const op = b.insertText(p.id, 5, "!")!;
    expect(op.id.clock).toBe(a.lamport + 1);
    a.apply(op);
    expect(a.text(p.id)).toBe("hello!");
  });
});

describe("anchors", () => {
  it("survive concurrent inserts and deletes", () => {
    const a = new Doc(1), b = new Doc(2);
    const p = a.createBlock("p");
    const t = a.insertText(p.id, 0, "abcdef")!;
    b.apply(p); b.apply(t);
    const anc = a.anchorAt(p.id, 3); // after "c"
    const ops = [b.insertText(p.id, 0, "XX")!, ...b.deleteText(p.id, 3, 1)]; // XXa|b|cdef -> delete 'b'
    for (const op of ops) a.apply(op);
    expect(a.text(p.id)).toBe("XXacdef");
    expect(a.resolveAnchor(p.id, anc)).toBe(4);
    expect(a.resolveAnchor(p.id, a.anchorAt(p.id, 0))).toBe(0);
  });
});

describe("protocol vectors", () => {
  const msgs = vec("messages.json") as { dir: string; msg: Record<string, unknown>; hex: string }[];
  for (const m of msgs) {
    it(`${m.dir} ${m.msg.type}`, () => {
      const dec = m.dir === "c2s" ? decodeClientMsg(fromHex(m.hex)) : decodeServerMsg(fromHex(m.hex));
      expect(dec.type).toBe(m.msg.type);
    });
  }
});

/** Minimal in-process sequencer mirroring the Go server, to test SyncClient logic. */
class FakeServer {
  log: Op[] = [];
  doc = new Doc(999);
  conns = new Map<number, SyncClient>();
  next = 1;
  connect(c: SyncClient) {
    c.open((b) => this.onMessage(c, b));
  }
  private deliver(c: SyncClient, m: Parameters<typeof encodeServerMsg>[0]) {
    queueMicrotask(() => this.conns.get(c.clientId) === c || m.type === "welcome" ? c.receive(encodeServerMsg(m)) : undefined);
  }
  private onMessage(c: SyncClient, b: Uint8Array) {
    const m = decodeClientMsg(b);
    if (m.type === "hello") {
      const id = m.clientId || this.next++;
      queueMicrotask(() => {
        c.receive(encodeServerMsg({ type: "welcome", clientId: id, headSeq: this.log.length, snapshot: null }));
        this.conns.set(id, c);
        if (this.log.length > m.lastSeq) c.receive(encodeServerMsg({ type: "ops", firstSeq: m.lastSeq + 1, batch: encodeOps(this.log.slice(m.lastSeq)) }));
      });
    } else if (m.type === "ops") {
      const ops = decodeOps(m.batch).filter((op) => this.doc.apply(op));
      const first = this.log.length + 1;
      this.log.push(...ops);
      this.deliver(c, { type: "ack", firstSeq: first, count: ops.length });
      for (const [, o] of this.conns) if (o !== c && ops.length) this.deliver(o, { type: "ops", firstSeq: first, batch: encodeOps(ops) });
    }
  }
  disconnect(c: SyncClient) {
    this.conns.delete(c.clientId);
    c.close();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SyncClient", () => {
  it("converges multiple clients through a sequencer, with disconnects", async () => {
    const s = new FakeServer();
    const clients = [new SyncClient(1), new SyncClient(1), new SyncClient(1)];
    // first client seeds the doc
    s.connect(clients[0]);
    await tick();
    const c0 = clients[0].doc!;
    const blk = c0.createBlock("paragraph");
    clients[0].push([blk]);
    await tick();
    s.connect(clients[1]); s.connect(clients[2]);
    await tick();
    const r = rng(11);
    for (let step = 0; step < 300; step++) {
      const c = clients[Math.floor(r() * 3)];
      if (r() < 0.05) {
        if (c.status === "offline") s.connect(c); else s.disconnect(c);
        await tick();
        continue;
      }
      if (!c.doc) continue;
      const len = [...c.doc.text(blk.id)].length;
      if (r() < 0.7 || len === 0) c.push([c.doc.insertText(blk.id, Math.floor(r() * (len + 1)), "xyz"[Math.floor(r() * 3)])]);
      else c.push(c.doc.deleteText(blk.id, Math.floor(r() * len), 1));
      if (r() < 0.3) await tick();
    }
    for (const c of clients) if (c.status === "offline") s.connect(c);
    for (let i = 0; i < 10; i++) await tick();
    const v = s.doc.view();
    for (const c of clients) {
      expect(c.unacked).toBe(0);
      expect(c.doc!.view()).toEqual(v);
      expect(c.lastSeq).toBe(s.log.length);
    }
    expect(s.doc.text(blk.id).length).toBeGreaterThan(10);
  });

  it("resends unacked ops after reconnect and server dedups", async () => {
    const s = new FakeServer();
    const c = new SyncClient(1);
    s.connect(c);
    await tick();
    const blk = c.doc!.createBlock("p");
    c.push([blk, c.doc!.insertText(blk.id, 0, "hi")]);
    s.disconnect(c); // before ack arrives
    await tick();
    expect(c.unacked).toBe(2);
    s.connect(c);
    for (let i = 0; i < 5; i++) await tick();
    expect(c.unacked).toBe(0);
    expect(s.doc.text(blk.id)).toBe("hi");
    expect(s.log.length).toBe(2);
    expect(c.doc!.client).toBe(c.clientId);
    expect(ROOT.client).toBe(0);
  });

  it("exports snapshots and hydrates offline with pending ops, then auto-merges concurrent remote edits on reconnect", async () => {
    const s = new FakeServer();
    const peer = new SyncClient(1);
    const alice = new SyncClient(1);
    expect(alice.exportSnapshot()).toBeNull();
    expect(alice.offlineHydrated).toBe(false);

    s.connect(alice);
    s.connect(peer);
    await tick();

    const blk = alice.doc!.createBlock("paragraph");
    alice.push([blk, alice.doc!.insertText(blk.id, 0, "hello")]);
    for (let i = 0; i < 4; i++) await tick();

    const snap = alice.exportSnapshot();
    expect(snap).not.toBeNull();
    const savedSeq = alice.lastSeq;
    const savedClientId = alice.clientId;
    s.disconnect(alice);

    // Simulate page reload while offline: fresh SyncClient with restored pending ops + offline snapshot
    const offlineChanges: boolean[] = [];
    const offlineStatuses: string[] = [];
    const reloaded = new SyncClient(1, {
      change: (remote) => offlineChanges.push(remote),
      status: (st) => offlineStatuses.push(st),
    });
    // Create a pending edit from previous offline session and restore it before hydrating
    const scratchDoc = Doc.fromState(savedClientId, snap!);
    const priorOfflineOp = scratchDoc.insertText(blk.id, 5, " offline")!;
    reloaded.restore(savedClientId, [priorOfflineOp]);

    expect(reloaded.hydrateOffline(snap!, { seq: savedSeq })).toBe(true);
    expect(reloaded.offlineHydrated).toBe(true);
    expect(reloaded.syncMode).toBe("edit");
    expect(reloaded.status).toBe("offline");
    expect(reloaded.doc!.text(blk.id)).toBe("hello offline");
    expect(offlineChanges).toEqual([true]);
    expect(offlineStatuses).toEqual(["offline"]);

    // Never clobbers an already-hydrated doc
    expect(reloaded.hydrateOffline(snap!)).toBe(false);

    // Keep editing while offline
    const extraOfflineOp = reloaded.doc!.insertText(blk.id, reloaded.doc!.text(blk.id).length, "!")!;
    reloaded.push([extraOfflineOp]);
    expect(reloaded.doc!.text(blk.id)).toBe("hello offline!");
    expect(reloaded.unacked).toBe(2);

    // Meanwhile peer makes concurrent online edits
    const remoteOp = peer.doc!.insertText(blk.id, 0, "[peer] ")!;
    peer.push([remoteOp]);
    for (let i = 0; i < 4; i++) await tick();
    expect(s.doc.text(blk.id)).toBe("[peer] hello");

    // Reconnect offline client: CRDT auto-merges both concurrent remote and local offline edits
    s.connect(reloaded);
    for (let i = 0; i < 6; i++) await tick();

    expect(reloaded.offlineHydrated).toBe(false);
    expect(reloaded.status).toBe("synced");
    expect(reloaded.unacked).toBe(0);
    expect(reloaded.doc!.view()).toEqual(s.doc.view());
    expect(peer.doc!.view()).toEqual(s.doc.view());
    expect(s.doc.text(blk.id)).toBe("[peer] hello offline!");
  });

  it("handles v3 requireMode offline hydration, snapshot merge, epoch quarantine, view mode, and validation guards", () => {
    const base = new Doc(1);
    const blk = base.createBlock("paragraph");
    base.insertText(blk.id, 0, "base");
    const snap = base.encodeState();

    // Validation errors for seq and historyEpoch
    const invalid = new SyncClient(2);
    expect(() => invalid.hydrateOffline(snap, { seq: -1 })).toThrow("invalid offline sequence");
    expect(() => invalid.hydrateOffline(snap, { seq: 1.5 })).toThrow("invalid offline sequence");
    expect(() => invalid.hydrateOffline(snap, { historyEpoch: 0 })).toThrow("invalid offline history epoch");
    expect(() => invalid.hydrateOffline(snap, { historyEpoch: -3 })).toThrow("invalid offline history epoch");

    // Default options (no clientId, no seq, no mode, no historyEpoch, no handlers)
    const minimal = new SyncClient(2);
    expect(minimal.hydrateOffline(snap)).toBe(true);
    expect(minimal.clientId).toBe(1);
    expect(minimal.lastSeq).toBe(0);
    expect(minimal.epoch).toBeNull();
    expect(minimal.syncMode).toBe("edit");
    expect(minimal.offlineHydrated).toBe(true);

    // Hydrate while transport already opened (this.send !== null) keeps connecting status
    const inFlight = new SyncClient(2, {}, { requireMode: true });
    inFlight.open(() => {});
    expect(inFlight.hydrateOffline(snap, { seq: 2, historyEpoch: 1, mode: "edit", clientId: 7 })).toBe(true);
    expect(inFlight.status).toBe("connecting");
    expect(inFlight.offlineHydrated).toBe(true);

    // Edit offline in v3 mode, then receive v3 welcome with newer server snapshot -> auto-merge!
    const localEdit = inFlight.doc!.insertText(blk.id, 4, " +local")!;
    inFlight.push([localEdit]);
    const serverDoc = Doc.fromState(9, snap);
    serverDoc.insertText(blk.id, 0, "remote+ ");
    const sentFrames: Uint8Array[] = [];
    inFlight.close();
    inFlight.open((b) => sentFrames.push(b));
    inFlight.receive(
      encodeServerMsg({
        type: "welcome",
        clientId: 7,
        headSeq: 3,
        historyEpoch: 1,
        mode: "edit",
        snapshot: { seq: 3, state: serverDoc.encodeState() },
      }),
    );
    expect(inFlight.offlineHydrated).toBe(false);
    expect(inFlight.doc!.text(blk.id)).toBe("remote+ base +local");
    expect(sentFrames.some((f) => decodeClientMsg(f).type === "ops")).toBe(true);

    // View mode does not replay pending ops onto hydrated doc
    const viewClient = new SyncClient(2);
    const pendingOp = Doc.fromState(5, snap).insertText(blk.id, 4, " draft")!;
    viewClient.restore(5, [pendingOp], null, 1);
    expect(viewClient.hydrateOffline(snap, { mode: "view", historyEpoch: 1, seq: 2 })).toBe(true);
    expect(viewClient.projectionOnly).toBe(true);
    expect(viewClient.doc!.text(blk.id)).toBe("base");

    // Epoch mismatch between restored draft and offline snapshot skips replaying stale ops
    const mismatchClient = new SyncClient(2);
    mismatchClient.restore(5, [pendingOp], null, 1);
    expect(mismatchClient.hydrateOffline(snap, { historyEpoch: 2, seq: 2 })).toBe(true);
    expect(mismatchClient.doc!.text(blk.id)).toBe("base");

    // Unsupported tables in snapshot or pending ops block hydration and reject subsequent attempts
    const tableDoc = new Doc(3);
    const tb = tableDoc.createBlock("table");
    tableDoc.apply({ t: "ttable", id: { client: 3, clock: 2 }, block: tb.id, payload: new Uint8Array([1, 2]) });
    const tableSnapClient = new SyncClient(2);
    expect(tableSnapClient.hydrateOffline(tableDoc.encodeState())).toBe(false);
    expect(tableSnapClient.blocked).toBe("table_unsupported");
    expect(tableSnapClient.doc).toBeNull();
    expect(tableSnapClient.hydrateOffline(snap)).toBe(false);

    const pendingTableClient = new SyncClient(2);
    pendingTableClient.restore(3, [{ t: "ttable", id: { client: 3, clock: 2 }, block: blk.id, payload: new Uint8Array([9]) }]);
    expect(pendingTableClient.hydrateOffline(snap)).toBe(false);
    expect(pendingTableClient.blocked).toBe("table_unsupported");
  });
});

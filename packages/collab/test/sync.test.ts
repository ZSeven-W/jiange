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
});

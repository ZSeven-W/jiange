import { describe, expect, it, vi } from "vitest";
import { Doc, decodeOps } from "../src/index.js";
import { CollabTable, TableIdAllocator, decodeTableOps, encodeTableOps } from "../src/table.js";
import { WebSocketSyncAdapter, type WebSocketLike } from "../src/ws.js";
import { IndexedDbDraftStorage, MemoryDraftStorage, type StoredDraft } from "../src/storage.js";
import { AiCollabSession } from "../src/ai-agent.js";

describe("@jiange/collab 0.2.0 subpaths (table, ws, storage, ai-agent)", () => {
  it("table subpath: allocates unique IDs, applies ops, and round-trips binary ttable payloads", () => {
    const doc = new Doc(7);
    const allocFromDoc = new TableIdAllocator(7, doc);
    const r1 = allocFromDoc.next();
    const c1 = allocFromDoc.next();
    const ch1 = allocFromDoc.next();

    const standalone = new TableIdAllocator(9);
    standalone.observe({ client: 1, clock: 50 });
    expect(standalone.next()).toEqual({ client: 9, clock: 51 });
    expect(() => new TableIdAllocator(0)).toThrow(RangeError);
    expect(() => standalone.allocate(0)).toThrow(RangeError);

    const ops = [
      { kind: "axis-insert" as const, id: r1, axis: "row" as const, after: null },
      { kind: "axis-insert" as const, id: c1, axis: "column" as const, after: null },
      { kind: "text-insert" as const, id: ch1, row: r1, column: c1, after: null, char: "A" },
    ];
    const encoded = encodeTableOps(ops);
    const decoded = decodeTableOps(encoded);
    expect(decoded).toEqual(ops);
    expect(() => decodeTableOps(new Uint8Array([0]))).toThrow(RangeError);
    expect(() => decodeTableOps(new Uint8Array([0x00, 1, 0x5b, 0x5d]))).toThrow(TypeError);

    const tbl = new CollabTable();
    for (const op of decoded) tbl.apply(op);
    expect(tbl.cellText(r1, c1)).toBe("A");
  });

  it("ws subpath: queues offline frames, flushes on open, receives binary/text, and reconnects", async () => {
    const sockets: Array<WebSocketLike & { sent: Array<string | Uint8Array>; triggerOpen(): void; triggerClose(): void }> = [];
    const states: string[] = [];
    const received: Array<string | Uint8Array> = [];

    const adapter = new WebSocketSyncAdapter({
      url: "wss://collab.local/doc/1",
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      heartbeatIntervalMs: 10,
      onStateChange: (s) => states.push(s),
      onMessage: (m) => received.push(m),
      createSocket: () => {
        const sock = {
          readyState: 0,
          binaryType: "",
          onopen: null as WebSocketLike["onopen"],
          onmessage: null as WebSocketLike["onmessage"],
          onerror: null as WebSocketLike["onerror"],
          onclose: null as WebSocketLike["onclose"],
          sent: [] as Array<string | Uint8Array>,
          send(data: string | Uint8Array) { this.sent.push(data); },
          close() { this.readyState = 3; this.onclose?.({ code: 1000 }); },
          triggerOpen() { this.readyState = 1; this.onopen?.({}); },
          triggerClose() { this.readyState = 3; this.onclose?.({ code: 1006 }); },
        };
        sockets.push(sock);
        return sock;
      },
    });

    // Queue while disconnected
    expect(adapter.send("offline-msg")).toBe(false);
    expect(adapter.queuedCount).toBe(1);

    adapter.connect();
    expect(adapter.connectionState).toBe("connecting");
    sockets[0].triggerOpen();
    expect(adapter.connectionState).toBe("connected");
    expect(adapter.queuedCount).toBe(0);
    expect(sockets[0].sent).toContain("offline-msg");

    // Receive text, Uint8Array, ArrayBuffer
    sockets[0].onmessage?.({ data: "hello" });
    sockets[0].onmessage?.({ data: new Uint8Array([1, 2, 3]) });
    sockets[0].onmessage?.({ data: new Uint8Array([4, 5]).buffer });
    expect(received).toHaveLength(3);

    // Trigger drop -> automatic reconnect
    sockets[0].triggerClose();
    expect(adapter.connectionState).toBe("disconnected");
    await new Promise((r) => setTimeout(r, 25));
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    adapter.close();
    expect(adapter.connectionState).toBe("closed");
  });

  it("storage subpath: persists and loads snapshots in MemoryDraftStorage and IndexedDbDraftStorage", async () => {
    const mem = new MemoryDraftStorage();
    const doc = new Doc(1);
    doc.createBlock("paragraph");
    await mem.save({ docKey: "doc-1", snapshot: doc.encodeState(), pendingOps: [new Uint8Array([9])], updatedAt: 100 });
    expect(await mem.listKeys()).toEqual(["doc-1"]);
    const loaded = await mem.load("doc-1");
    expect(loaded?.pendingOps[0]).toEqual(new Uint8Array([9]));
    await mem.delete("doc-1");
    expect(await mem.load("doc-1")).toBeNull();

    // Mock IndexedDB factory
    const dbMap = new Map<string, StoredDraft>();
    const makeReq = <T>(val: T) => {
      const req = { result: val, error: null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    };
    const fakeIdb = {
      open: () => {
        const fakeDb = {
          objectStoreNames: { contains: () => false },
          createObjectStore: vi.fn(),
          transaction: () => ({
            objectStore: () => ({
              put: (v: unknown) => { const d = v as StoredDraft; dbMap.set(d.docKey, d); return makeReq(undefined); },
              get: (k: string) => makeReq(dbMap.get(k)),
              delete: (k: string) => { dbMap.delete(k); return makeReq(undefined); },
              getAllKeys: () => makeReq([...dbMap.keys()]),
            }),
          }),
          close: vi.fn(),
        };
        const req = { result: fakeDb, error: null, onupgradeneeded: null as (() => void) | null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
        queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
        return req;
      },
    };
    const idb = new IndexedDbDraftStorage({ indexedDB: fakeIdb });
    await idb.save({ docKey: "d2", snapshot: new Uint8Array([1, 2]), pendingOps: [], updatedAt: 200 });
    expect(await idb.listKeys()).toEqual(["d2"]);
    expect((await idb.load("d2"))?.updatedAt).toBe(200);
    await idb.delete("d2");
    expect(await idb.load("d2")).toBeNull();
  });

  it("ai-agent subpath: collaborates with a human peer over CRDT wire ops and emits awareness", () => {
    const human = new Doc(1);
    const p1 = human.createBlock("paragraph");
    const t1 = human.insertText(p1.id, 0, "Human intro");

    const statuses: string[] = [];
    const emitted: Uint8Array[] = [];
    const ai = new AiCollabSession({
      agentId: "agent-1",
      agentName: "Jiange AI",
      clientId: 9001,
      initialState: human.encodeState(),
      onAwareness: (s) => statuses.push(s.status),
      onEmitOps: (_ops, bytes) => emitted.push(bytes),
    });

    ai.setPresence("thinking", undefined, "Drafting summary");
    const batch = ai.appendParagraph("AI summary section", p1.id);
    expect(statuses).toContain("thinking");
    expect(statuses).toContain("editing");
    expect(statuses[statuses.length - 1]).toBe("idle");
    expect(emitted).toHaveLength(1);

    // Sync AI ops back into human replica & verify convergence
    const blockText = (b: { spans: Array<{ text: string }> }) => b.spans.map((r) => r.text).join("");
    for (const op of decodeOps(batch.encoded)) human.apply(op);
    expect(human.view().blocks.map(blockText)).toEqual(["Human intro", "AI summary section"]);

    // Sync human edit into AI replica
    const hEdit = human.insertText(p1.id, 11, "!");
    ai.receiveRemoteOps([hEdit!]);
    expect(blockText(ai.doc.view().blocks[0])).toBe("Human intro!");
    expect(t1).toBeTruthy();
  });
});

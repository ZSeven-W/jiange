import { afterEach, describe, expect, it, vi } from "vitest";
import { Doc } from "../src/index.js";
import { AiCollabSession } from "../src/ai-agent.js";
import { IndexedDbDraftStorage, type StoredDraft } from "../src/storage.js";
import { TableIdAllocator, decodeTableOps, encodeTableOps } from "../src/table.js";
import { WebSocketSyncAdapter, type WebSocketLike } from "../src/ws.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ai-agent edge cases", () => {
  it("supports minimal options without initialState, agentName, or callbacks", () => {
    const ai = new AiCollabSession({ agentId: "bot-42", clientId: 42 });
    expect(ai.getAwareness()).toMatchObject({
      agentId: "bot-42",
      agentName: "bot-42",
      clientId: 42,
      status: "idle",
    });

    // Empty edit emits nothing and ignores null/undefined ops
    const empty = ai.runEdit("blk-1", (_doc, collect) => {
      collect(null);
      collect(undefined);
    });
    expect(empty.ops).toEqual([]);
    expect(empty.awareness.status).toBe("idle");

    // appendParagraph without `after` and with empty text
    const pEmpty = ai.appendParagraph("");
    expect(pEmpty.ops).toHaveLength(1);
    expect(ai.doc.text(pEmpty.blockId)).toBe("");

    // appendParagraph with explicit `null` after and non-empty text
    const pText = ai.appendParagraph("hello", null);
    expect(pText.ops).toHaveLength(2);
    expect(ai.doc.text(pText.blockId)).toBe("hello");

    // Callback throwing still resets awareness back to idle
    expect(() =>
      ai.runEdit("blk-2", () => {
        throw new Error("edit failed");
      }, "working"),
    ).toThrow("edit failed");
    expect(ai.getAwareness().status).toBe("idle");
  });
});

describe("table subpath edge cases", () => {
  it("validates TableIdAllocator inputs, observe ordering, and decodeTableOps errors", () => {
    expect(() => new TableIdAllocator(-1)).toThrow(RangeError);
    expect(() => new TableIdAllocator(1.5)).toThrow(RangeError);

    const standalone = new TableIdAllocator(3);
    standalone.observe({ client: 1, clock: 10 });
    standalone.observe({ client: 1, clock: 5 }); // lower clock does not regress
    expect(standalone.allocate()).toEqual([{ client: 3, clock: 11 }]);
    expect(standalone.allocate(2)).toEqual([
      { client: 3, clock: 12 },
      { client: 3, clock: 13 },
    ]);
    expect(() => standalone.allocate(-2)).toThrow(RangeError);
    expect(() => standalone.allocate(1.5)).toThrow(RangeError);

    const doc = new Doc(4);
    const backed = new TableIdAllocator(4, doc);
    expect(backed.allocate(2)).toEqual([
      { client: 4, clock: 1 },
      { client: 4, clock: 2 },
    ]);

    // Exceed maxBytes
    const valid = encodeTableOps([]);
    expect(() => decodeTableOps(valid, 1)).toThrow(RangeError);

    // Invalid version byte
    expect(() => decodeTableOps(new Uint8Array([0x54, 2, 0x5b, 0x5d]))).toThrow(TypeError);

    // Valid magic + version, but JSON payload is an object rather than an array
    const notArray = new Uint8Array([0x54, 1, ...new TextEncoder().encode('{"not":"array"}')]);
    expect(() => decodeTableOps(notArray)).toThrow("ttable payload must be an op array");
  });
});

describe("storage subpath edge cases", () => {
  it("falls back to globalThis.indexedDB and throws when unavailable", async () => {
    const g = globalThis as unknown as { indexedDB?: unknown };
    const hadOwn = Object.prototype.hasOwnProperty.call(g, "indexedDB");
    const prev = g.indexedDB;
    try {
      delete g.indexedDB;
      expect(() => new IndexedDbDraftStorage()).toThrow("IndexedDB is unavailable in this environment");

      // Provide a fake global indexedDB where objectStore already exists on upgrade
      const dbMap = new Map<string, StoredDraft>();
      const createObjectStore = vi.fn();
      const makeReq = <T>(val: T) => {
        const req = { result: val, error: null as unknown, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      };
      g.indexedDB = {
        open: () => {
          const db = {
            objectStoreNames: { contains: () => true },
            createObjectStore,
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
          const req = { result: db, error: null, onupgradeneeded: null as (() => void) | null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
          queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
          return req;
        },
      };

      const storage = new IndexedDbDraftStorage({ dbName: "custom-db", storeName: "custom-store" });
      await storage.save({ docKey: "k1", snapshot: new Uint8Array([7]), pendingOps: [], updatedAt: 1 });
      expect(createObjectStore).not.toHaveBeenCalled();
      expect(await storage.listKeys()).toEqual(["k1"]);
    } finally {
      if (hadOwn) g.indexedDB = prev;
      else delete g.indexedDB;
    }
  });

  it("propagates open errors and request errors with fallback messages", async () => {
    // Open error with explicit error
    const failOpenExplicit = new IndexedDbDraftStorage({
      indexedDB: {
        open: () => {
          const req = { result: undefined as never, error: new Error("open-boom"), onupgradeneeded: null, onsuccess: null, onerror: null as (() => void) | null };
          queueMicrotask(() => req.onerror?.());
          return req;
        },
      },
    });
    await expect(failOpenExplicit.listKeys()).rejects.toThrow("open-boom");

    // Open error with null error -> default Error
    const failOpenFallback = new IndexedDbDraftStorage({
      indexedDB: {
        open: () => {
          const req = { result: undefined as never, error: null, onupgradeneeded: null, onsuccess: null, onerror: null as (() => void) | null };
          queueMicrotask(() => req.onerror?.());
          return req;
        },
      },
    });
    await expect(failOpenFallback.load("x")).rejects.toThrow("IndexedDB open failed");

    // Request error with explicit error and null error
    const makeFailingStorage = (err: unknown) =>
      new IndexedDbDraftStorage({
        indexedDB: {
          open: () => {
            const failReq = () => {
              const r = { result: undefined as never, error: err, onsuccess: null, onerror: null as (() => void) | null };
              queueMicrotask(() => r.onerror?.());
              return r;
            };
            const db = {
              objectStoreNames: { contains: () => true },
              createObjectStore: vi.fn(),
              transaction: () => ({
                objectStore: () => ({
                  put: failReq,
                  get: failReq,
                  delete: failReq,
                  getAllKeys: failReq,
                }),
              }),
              close: vi.fn(),
            };
            const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null as (() => void) | null, onerror: null };
            queueMicrotask(() => req.onsuccess?.());
            return req;
          },
        },
      });

    await expect(makeFailingStorage(new Error("req-boom")).delete("x")).rejects.toThrow("req-boom");
    await expect(makeFailingStorage(null).listKeys()).rejects.toThrow("IndexedDB request failed");
  });
});

describe("ws subpath edge cases", () => {
  function makeMockSocket() {
    return {
      readyState: 0,
      binaryType: "",
      onopen: null as WebSocketLike["onopen"],
      onmessage: null as WebSocketLike["onmessage"],
      onerror: null as WebSocketLike["onerror"],
      onclose: null as WebSocketLike["onclose"],
      sent: [] as Array<string | Uint8Array>,
      send(data: string | Uint8Array) {
        this.sent.push(data);
      },
      close() {
        this.readyState = 3;
        this.onclose?.({ code: 1000 });
      },
      open() {
        this.readyState = 1;
        this.onopen?.({});
      },
      drop() {
        this.readyState = 3;
        this.onclose?.({ code: 1006 });
      },
    };
  }

  it("handles duplicate connect/close, immediate send, onerror, heartbeats, and default reconnect backoff", () => {
    vi.useFakeTimers();
    const sockets: ReturnType<typeof makeMockSocket>[] = [];
    const states: string[] = [];

    const adapter = new WebSocketSyncAdapter({
      url: "wss://example.test/ws",
      heartbeatIntervalMs: 50,
      onStateChange: (s) => states.push(s),
      createSocket: () => {
        const s = makeMockSocket();
        sockets.push(s);
        return s;
      },
    });

    adapter.connect();
    // Duplicate connect while connecting is ignored
    adapter.connect();
    expect(sockets).toHaveLength(1);

    // Send while connecting queues
    expect(adapter.send("queued-while-connecting")).toBe(false);

    // Open flushes queue and starts heartbeat
    sockets[0].open();
    // Duplicate connect while connected is ignored
    adapter.connect();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toEqual(["queued-while-connecting"]);

    // Send while open transmits directly
    expect(adapter.send("live-msg")).toBe(true);
    expect(adapter.send(new Uint8Array([9, 8]))).toBe(true);
    expect(sockets[0].sent).toEqual(["queued-while-connecting", "live-msg", new Uint8Array([9, 8])]);

    // Heartbeat fires default ping payload while open
    vi.advanceTimersByTime(50);
    expect(sockets[0].sent.at(-1)).toBe('{"type":"ping"}');

    // Heartbeat skips sending if socket readyState is no longer OPEN
    sockets[0].readyState = 2;
    const countBefore = sockets[0].sent.length;
    vi.advanceTimersByTime(50);
    expect(sockets[0].sent).toHaveLength(countBefore);

    // Unrecognized message payload & missing onMessage handler & onerror do not throw
    sockets[0].onmessage?.({ data: 12345 });
    sockets[0].onmessage?.({ data: "ignored-without-handler" });
    sockets[0].onerror?.(new Error("socket error"));

    // Drop triggers default backoff (500ms base, 15000ms cap, 10 maxRetries)
    sockets[0].drop();
    expect(adapter.connectionState).toBe("disconnected");
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    // Close twice: second close is a no-op for setState
    const stateCountBeforeClose = states.length;
    adapter.close();
    adapter.close();
    expect(states.length).toBe(stateCountBeforeClose + 1);
    expect(adapter.connectionState).toBe("closed");
  });

  it("supports custom heartbeat payload, maxRetries exhaustion, and default global WebSocket factory", () => {
    vi.useFakeTimers();

    // Custom heartbeat payload + maxRetries: 0 (no reconnect)
    const socks: ReturnType<typeof makeMockSocket>[] = [];
    const custom = new WebSocketSyncAdapter({
      url: "wss://example.test/custom",
      heartbeatIntervalMs: 20,
      heartbeatPayload: "PING",
      maxRetries: 0,
      createSocket: () => {
        const s = makeMockSocket();
        socks.push(s);
        return s;
      },
    });
    custom.connect();
    socks[0].open();
    vi.advanceTimersByTime(20);
    expect(socks[0].sent).toEqual(["PING"]);
    socks[0].drop();
    vi.advanceTimersByTime(5000);
    expect(socks).toHaveLength(1);
    custom.close();

    // Default createSocket using globalThis.WebSocket without heartbeatIntervalMs
    const g = globalThis as unknown as { WebSocket?: unknown };
    const prevWs = g.WebSocket;
    const createdUrls: string[] = [];
    const globalSock = makeMockSocket();
    class FakeWebSocket {
      constructor(url: string) {
        createdUrls.push(url);
        return globalSock as unknown as FakeWebSocket;
      }
    }
    try {
      g.WebSocket = FakeWebSocket;
      const defaultAdapter = new WebSocketSyncAdapter({ url: "wss://default.test/ws" });
      defaultAdapter.connect();
      expect(createdUrls).toEqual(["wss://default.test/ws"]);
      globalSock.open();
      expect(defaultAdapter.connectionState).toBe("connected");
      defaultAdapter.close();
    } finally {
      g.WebSocket = prevWs;
    }
  });
});

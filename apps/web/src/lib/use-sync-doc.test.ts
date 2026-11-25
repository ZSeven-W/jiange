import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Doc,
  SyncClient,
  decodeClientMsg,
  decodeOps,
  encodeServerMsg,
} from "@zseven-w/collab";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOfflineDbForTesting } from "./offline-db";
import { loadDocCollabReplica, saveDocCollabReplica } from "./offline-collab";
import {
  createDebouncedReplicaSaver,
  hydrateSyncClientFromOfflineCache,
  persistSyncClientSnapshot,
  startSyncDocConnection,
  useSyncDoc,
  type SyncDoc,
  type SyncSocketLike,
} from "./use-sync-doc";

class MockEventTarget {
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string) {
    const set = this.listeners.get(type);
    if (!set) return;
    const ev = new Event(type);
    for (const fn of [...set]) {
      if (typeof fn === "function") fn(ev);
      else fn.handleEvent(ev);
    }
  }
}

class MockSyncSocket implements SyncSocketLike {
  binaryType: BinaryType = "arraybuffer";
  readyState = 0; // CONNECTING
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: Event) => unknown) | null = null;
  sent: Uint8Array[] = [];
  closed = false;

  open() {
    this.readyState = 1; // OPEN
    this.onopen?.(new Event("open"));
  }

  receiveServer(bytes: Uint8Array) {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.onmessage?.({ data: ab } as MessageEvent);
  }

  send(data: Uint8Array) {
    this.sent.push(data.slice());
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.(new Event("close"));
  }
}

async function flushMicrotasks(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

describe("useSyncDoc offline CRDT hydration & auto-merge", () => {
  beforeEach(async () => {
    await resetOfflineDbForTesting({ indexedDB: null });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await resetOfflineDbForTesting();
  });

  it("renders cleanly in SSR and exposes offlineHydrated & pendingOpsCount on SyncDoc", () => {
    const qc = new QueryClient();
    let captured: SyncDoc | null = null;

    function Probe() {
      captured = useSyncDoc(42, 7, false, "edit");
      return createElement("div", null, `${captured.status}:${captured.pendingOpsCount}`);
    }

    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, createElement(Probe)),
    );
    expect(html).toBe("<div>connecting:0</div>");
    expect(captured).not.toBeNull();
    expect(captured!.offlineHydrated).toBe(false);
    expect(captured!.pendingOpsCount).toBe(0);
    expect(captured!.ready).toBe(false);
    expect(captured!.caughtUp).toBe(false);
  });

  it("debounces, flushes, and cancels CRDT snapshot saves cleanly", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = createDebouncedReplicaSaver(save, 250);

    saver.schedule();
    saver.schedule();
    saver.schedule();
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);

    // Flush immediately executes pending dirty save once
    saver.schedule();
    saver.flush();
    saver.flush();
    expect(save).toHaveBeenCalledTimes(2);

    // Cancel discards pending save
    saver.schedule();
    saver.cancel();
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("persists and hydrates binary CRDT snapshots via IndexedDB while respecting view role and live docs", async () => {
    const seed = new Doc(5);
    const blk = seed.createBlock("paragraph");
    seed.insertText(blk.id, 0, "协同文档内容");

    const onlineClient = new SyncClient(99, {}, { requireMode: true });
    onlineClient.open(() => {});
    onlineClient.receive(
      encodeServerMsg({
        type: "welcome",
        clientId: 5,
        headSeq: 4,
        historyEpoch: 2,
        mode: "edit",
        snapshot: { seq: 4, state: seed.encodeState() },
      }),
    );

    expect(await persistSyncClientSnapshot(onlineClient, 10, 99, "edit")).toBe(true);
    const stored = await loadDocCollabReplica(10, 99);
    expect(stored).not.toBeNull();
    expect(stored?.seq).toBe(4);
    expect(stored?.historyEpoch).toBe(2);
    expect(stored?.clientId).toBe(5);
    expect(stored?.pendingOpsCount).toBe(0);

    // Hydrate a fresh offline client
    const offlineClient = new SyncClient(99, {}, { requireMode: true });
    expect(await hydrateSyncClientFromOfflineCache(offlineClient, 10, 99, "edit")).toBe(true);
    expect(offlineClient.offlineHydrated).toBe(true);
    expect(offlineClient.doc?.text(blk.id)).toBe("协同文档内容");
    expect(offlineClient.syncMode).toBe("edit");
    expect(offlineClient.status).toBe("offline");

    // Never clobbers an already-hydrated or connected doc
    expect(await hydrateSyncClientFromOfflineCache(offlineClient, 10, 99, "edit")).toBe(false);

    // View role hydrates into read-only projection mode
    const viewerClient = new SyncClient(99, {}, { requireMode: true });
    expect(await hydrateSyncClientFromOfflineCache(viewerClient, 10, 99, "view")).toBe(true);
    expect(viewerClient.projectionOnly).toBe(true);
    expect(viewerClient.offlineHydrated).toBe(true);
  });

  it("hydrates immediately when starting offline, retains edits across reload, and auto-merges with concurrent remote edits on reconnect", async () => {
    // Prepare cached CRDT replica from a prior online session
    const initialDoc = new Doc(7);
    const blk = initialDoc.createBlock("paragraph");
    initialDoc.insertText(blk.id, 0, "初始正文");
    await saveDocCollabReplica(1, 55, {
      snapshot: initialDoc.encodeState(),
      seq: 2,
      historyEpoch: 1,
      role: "edit",
      clientId: 7,
      pendingOpsCount: 0,
    });

    // Phase 1: Start offline with a prior pending op restored from localStorage
    const priorScratch = Doc.fromState(7, initialDoc.encodeState());
    const priorOp = priorScratch.insertText(blk.id, 4, "·本地1")!;

    let online = false;
    const target = new MockEventTarget();
    const sockets: MockSyncSocket[] = [];
    const client = new SyncClient(55, {}, { requireMode: true });
    client.restore(7, [priorOp], null, 1);

    const stop = startSyncDocConnection({
      client,
      userId: 1,
      docId: 55,
      getRole: () => "edit",
      url: "ws://jiange.local/api/sync?protocol=3",
      isOnline: () => online,
      eventTarget: target as unknown as Window,
      createSocket: () => {
        const s = new MockSyncSocket();
        sockets.push(s);
        return s;
      },
    });

    await flushMicrotasks();

    // Did NOT open a socket while offline; hydrated CRDT doc is ready!
    expect(sockets).toHaveLength(0);
    expect(client.doc).not.toBeNull();
    expect(client.status).toBe("offline");
    expect(client.offlineHydrated).toBe(true);
    expect(client.doc!.text(blk.id)).toBe("初始正文·本地1");

    // Continue editing while offline
    const secondOp = client.doc!.insertText(blk.id, client.doc!.text(blk.id).length, "·本地2")!;
    client.push([secondOp]);
    expect(client.doc!.text(blk.id)).toBe("初始正文·本地1·本地2");
    expect(client.unacked).toBe(2);

    // Phase 2: Reconnect! Server has concurrent remote edits from another peer
    const serverDoc = Doc.fromState(9, initialDoc.encodeState());
    serverDoc.insertText(blk.id, 0, "[远端] ");

    online = true;
    target.dispatch("online");
    expect(sockets).toHaveLength(1);
    const sock = sockets[0];
    sock.open();

    // Verify hello sent with historyEpoch
    expect(decodeClientMsg(sock.sent[0])).toEqual({
      type: "hello",
      docId: 55,
      clientId: 7,
      lastSeq: 0,
      historyEpoch: 1,
    });

    // Server sends v3 welcome with newer snapshot containing concurrent remote edits
    sock.receiveServer(
      encodeServerMsg({
        type: "welcome",
        clientId: 7,
        headSeq: 3,
        historyEpoch: 1,
        mode: "edit",
        snapshot: { seq: 3, state: serverDoc.encodeState() },
      }),
    );

    // Local offline edits AND concurrent remote edits auto-merged!
    expect(client.offlineHydrated).toBe(false);
    expect(client.doc!.text(blk.id)).toBe("[远端] 初始正文·本地1·本地2");

    // Client automatically flushed both pending offline ops to the server
    const opsFrame = sock.sent.map(decodeClientMsg).find((m) => m.type === "ops");
    expect(opsFrame).toBeDefined();
    if (opsFrame && opsFrame.type === "ops") {
      const sentOps = decodeOps(opsFrame.batch);
      expect(sentOps).toHaveLength(2);
      for (const op of sentOps) serverDoc.apply(op);
    }

    // Server ACKs data batch + sync fence
    sock.receiveServer(encodeServerMsg({ type: "ack", firstSeq: 4, count: 2 }));
    sock.receiveServer(encodeServerMsg({ type: "ack", firstSeq: 6, count: 0 }));

    expect(client.status).toBe("synced");
    expect(client.unacked).toBe(0);
    expect(client.doc!.view()).toEqual(serverDoc.view());

    // Persisting synced replica resets pendingOpsCount to 0 and updates seq
    expect(await persistSyncClientSnapshot(client, 1, 55, "edit")).toBe(true);
    const persisted = await loadDocCollabReplica(1, 55);
    expect(persisted?.pendingOpsCount).toBe(0);
    expect(persisted?.seq).toBe(5);

    stop();
  });

  it("falls back to IndexedDB CRDT hydration when WebSocket fails to connect before welcome", async () => {
    const seed = new Doc(3);
    const blk = seed.createBlock("paragraph");
    seed.insertText(blk.id, 0, "弱网降级内容");
    await saveDocCollabReplica(2, 77, {
      snapshot: seed.encodeState(),
      seq: 6,
      historyEpoch: 1,
      role: "edit",
      clientId: 3,
    });

    const target = new MockEventTarget();
    const sockets: MockSyncSocket[] = [];
    const client = new SyncClient(77, {}, { requireMode: true });

    const stop = startSyncDocConnection({
      client,
      userId: 2,
      docId: 77,
      getRole: () => "edit",
      url: "ws://jiange.local/api/sync?protocol=3",
      isOnline: () => true,
      eventTarget: target as unknown as Window,
      createSocket: () => {
        const s = new MockSyncSocket();
        sockets.push(s);
        return s;
      },
    });

    expect(sockets).toHaveLength(1);
    // Simulate immediate WS disconnect before welcome arrives
    sockets[0].close();
    await flushMicrotasks();

    expect(client.doc).not.toBeNull();
    expect(client.offlineHydrated).toBe(true);
    expect(client.status).toBe("offline");
    expect(client.doc!.text(blk.id)).toBe("弱网降级内容");

    stop();
  });
});

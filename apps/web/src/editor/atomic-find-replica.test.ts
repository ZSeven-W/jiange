import { afterEach, describe, expect, it, vi } from "vitest";
import { Doc, encodeServerMsg } from "@jiange/collab";
import { allocateAtomicFindReplica } from "./atomic-find-replica";

class FakeSocket {
  static OPEN = 1;
  static mode: "edit" | "view" | "silent" | "invalid" = "edit";
  static last: FakeSocket | null = null;
  binaryType = "blob"; readyState = 0; closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.last = this; queueMicrotask(() => { if (!this.closed) { this.readyState = 1; this.onopen?.(); } }); }
  send(_bytes: Uint8Array) {
    if (FakeSocket.mode === "silent") return;
    const mode = FakeSocket.mode;
    queueMicrotask(() => {
      if (this.closed) return;
      const bytes = mode === "invalid" ? new Uint8Array([255]) : encodeServerMsg({ type: "welcome", clientId: 19, headSeq: 0, snapshot: { seq: 0, state: new Doc(19).encodeState() }, historyEpoch: 3, mode });
      this.onmessage?.({ data: Uint8Array.from(bytes).buffer });
    });
  }
  close() { this.closed = true; this.readyState = 3; }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeSocket.last = null; FakeSocket.mode = "edit"; });
function setup(mode: typeof FakeSocket.mode) { FakeSocket.mode = mode; vi.stubGlobal("WebSocket", FakeSocket); vi.stubGlobal("location", { protocol: "https:", host: "jiange.test" }); }

describe("isolated find author", () => {
  it("returns only an editable, synchronized author and closes its socket", async () => {
    setup("edit");
    expect(await allocateAtomicFindReplica(7, new AbortController().signal)).toEqual({ author: 19, epoch: 3 });
    expect(FakeSocket.last?.url).toBe("wss://jiange.test/api/sync?protocol=3"); expect(FakeSocket.last?.closed).toBe(true);
  });
  it("rejects view projections and malformed synchronization frames", async () => {
    setup("view"); await expect(allocateAtomicFindReplica(7, new AbortController().signal)).rejects.toThrow();
    setup("invalid"); await expect(allocateAtomicFindReplica(7, new AbortController().signal)).rejects.toThrow();
  });
  it("closes a pending connection when canceled or timed out", async () => {
    setup("silent"); const controller = new AbortController(), pending = allocateAtomicFindReplica(7, controller.signal); controller.abort();
    await expect(pending).rejects.toThrow(/aborted/); expect(FakeSocket.last?.closed).toBe(true);
    vi.useFakeTimers(); const expired = allocateAtomicFindReplica(7, new AbortController().signal, 50), assertion = expect(expired).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(50); await assertion; expect(FakeSocket.last?.closed).toBe(true);
  });
});

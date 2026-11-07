import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ effect: null as null | (() => void | (() => void)), client: null as any }));
vi.mock("react", () => ({ useEffect: (effect: () => void | (() => void)) => { harness.effect = effect; } }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => harness.client }));
import { useBaseSync, type BaseData } from "./sync";

class Socket {
  static instances: Socket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) { Socket.instances.push(this); }
  send(message: string) { this.sent.push(message); }
  close() { this.onclose?.(); }
}

const initial = (): BaseData => ({
  base: { id: 1, workspaceId: 1, parentId: null, title: "表", icon: "", creatorId: 1, creatorName: "A", createdAt: "", updatedAt: "", role: "view", kind: "base" },
  fields: [], records: [], head: 4,
});

describe("base realtime access lifecycle", () => {
  let data: BaseData;
  let status: "success" | "error";
  let refresh: ReturnType<typeof vi.fn>;
  let stop: void | (() => void);
  beforeEach(() => {
    vi.useFakeTimers();
    Socket.instances = [];
    data = initial(); status = "success";
    refresh = vi.fn(async () => {});
    harness.client = {
      getQueryData: () => data,
      getQueryState: () => ({ status }),
      invalidateQueries: (...args: unknown[]) => refresh(...args),
      setQueryData: (_key: unknown, fn: (value: BaseData) => BaseData) => { data = fn(data); },
    };
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
    vi.stubGlobal("WebSocket", Socket);
    stop = undefined;
  });
  afterEach(() => { if (typeof stop === "function") stop(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("does not start a stream before access is verified", () => {
    useBaseSync(1, { ready: false, restricted: false });
    stop = harness.effect?.();
    expect(Socket.instances).toHaveLength(0);
  });

  it("reauthorizes on disconnect and stops when access is denied", async () => {
    useBaseSync(1, { ready: true, restricted: false });
    stop = harness.effect?.();
    expect(Socket.instances).toHaveLength(1);
    Socket.instances[0].onopen?.();
    expect(JSON.parse(Socket.instances[0].sent[0])).toEqual({ t: "hello", lastSeq: 4 });
    refresh.mockImplementationOnce(async () => { status = "error"; throw new Error("403"); });
    Socket.instances[0].close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(Socket.instances).toHaveLength(1);
  });

  it("does not reconnect an unfiltered stream after the base becomes restricted", async () => {
    useBaseSync(1, { ready: true, restricted: false });
    stop = harness.effect?.();
    refresh.mockImplementationOnce(async () => { data = { ...data, writeRestricted: true }; });
    Socket.instances[0].close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Socket.instances).toHaveLength(1);
  });

  it("discards a sequence gap, fetches a fresh snapshot, and cancels on unmount", async () => {
    useBaseSync(1, { ready: true, restricted: false });
    stop = harness.effect?.();
    Socket.instances[0].onmessage?.({ data: JSON.stringify({ t: "events", events: [{ seq: 6, body: { kind: "record", op: "del", rid: 3 } }] }) });
    expect(data.head).toBe(4);
    if (typeof stop === "function") stop();
    stop = undefined;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(1);
  });
});

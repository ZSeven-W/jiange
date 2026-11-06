import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import type { Me } from "./api";
import { announceAuthChange, createSessionQueryClient, finishLogin, subscribeAuthChanges } from "./sessionCache";

function user(id: number): Me {
  return { user: { id, email: `user${id}@example.test`, name: `用户${id}`, createdAt: "" }, workspaces: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe("authentication session cache", () => {
  it("keeps delayed queries and mutation callbacks from account A out of account B", async () => {
    const auth = new QueryClient();
    const oldSession = createSessionQueryClient(auth);
    oldSession.setQueryData(["docs"], ["A 的文档"]);
    const query = deferred<string>();
    const request = oldSession.fetchQuery({ queryKey: ["comments", 1], queryFn: () => query.promise });
    const mutation = deferred<string>();
    const observer = new MutationObserver(oldSession, { mutationFn: () => mutation.promise, onSuccess: (value) => oldSession.setQueryData(["favorites"], [value]) });
    const write = observer.mutate();

    await finishLogin(auth, user(2));
    const nextSession = createSessionQueryClient(auth);
    expect(nextSession.getQueryData(["docs"])).toBeUndefined();
    query.resolve("A 的评论");
    mutation.resolve("A 的收藏");
    await Promise.all([request, write]);
    expect(nextSession.getQueryData(["comments", 1])).toBeUndefined();
    expect(nextSession.getQueryData(["favorites"])).toBeUndefined();
    expect(auth.getQueryData<Me>(["me"])?.user.id).toBe(2);
  });

  it("uses a fresh cache even when the same account signs in again", async () => {
    const auth = new QueryClient();
    const first = createSessionQueryClient(auth);
    first.setQueryData(["doc", 7], { title: "旧会话内容" });
    await finishLogin(auth, user(1));
    const second = createSessionQueryClient(auth);
    expect(second).not.toBe(first);
    expect(second.getQueryData(["doc", 7])).toBeUndefined();
    expect(first.getQueryData(["doc", 7])).toEqual({ title: "旧会话内容" });
  });

  it("cancels stale auth reads before publishing login and leaves local drafts alone", async () => {
    const auth = new QueryClient();
    const stale = deferred<Me>();
    const read = auth.fetchQuery({ queryKey: ["me"], queryFn: () => stale.promise }).catch(() => undefined);
    auth.setQueryData(["docs"], ["过期缓存"]);
    const storage = { clear: vi.fn(), removeItem: vi.fn(), setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);

    await finishLogin(auth, user(2));
    stale.resolve(user(1));
    await read;
    expect(auth.getQueryData<Me>(["me"])?.user.id).toBe(2);
    expect(auth.getQueryData(["docs"])).toBeUndefined();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("notifies other tabs with an opaque signal and unsubscribes", () => {
    class FakeChannel {
      static all: FakeChannel[] = [];
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(public name: string) { FakeChannel.all.push(this); }
      postMessage(data: unknown) { for (const other of FakeChannel.all) if (other !== this && other.name === this.name) other.onmessage?.({ data }); }
      close() { FakeChannel.all = FakeChannel.all.filter((channel) => channel !== this); }
    }
    vi.stubGlobal("window", {});
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const changed = vi.fn();
    const unsubscribe = subscribeAuthChanges(changed);
    announceAuthChange();
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
    announceAuthChange();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("uses only a dedicated signal key if broadcast channels are unavailable", () => {
    const storage = { setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal("window", {
      localStorage: storage,
      addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    });
    const changed = vi.fn();
    const unsubscribe = subscribeAuthChanges(changed);
    announceAuthChange();
    expect(storage.setItem).toHaveBeenCalledWith("jiange:auth-session-changed", expect.any(String));
    listeners.get("storage")?.({ key: "jiange:auth-session-changed" } as unknown as Event);
    listeners.get("storage")?.({ key: "jiange:pending:v3:1:2:draft" } as unknown as Event);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    unsubscribe();
    expect(listeners.has("storage")).toBe(false);
  });
});

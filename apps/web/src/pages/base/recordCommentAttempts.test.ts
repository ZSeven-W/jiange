import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordCommentAttemptStore } from "./recordCommentAttempts";
import { requireRecordCommentAttempts, sendRecordCommentAttempt } from "./recordCommentAttemptApi";

function storage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null, removeItem: (key) => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
}
const mutation = "1234567890abcdef1234567890abcdef";
afterEach(() => vi.unstubAllGlobals());

describe("record comment attempts", () => {
  it("retains an uncertain immutable request and retries the same identity", async () => {
    const env = { storage: storage(), random: () => mutation };
    const store = new RecordCommentAttemptStore(env, 1, 2, 3);
    await expect(store.prepareAndRun("消息", [4], undefined, async () => { throw new Error("connection lost"); })).rejects.toThrow();
    const attempt = store.list().attempts[0];
    expect(attempt).toMatchObject({ userId: 1, baseId: 2, recordId: 3, mutationId: mutation, body: "消息" });
    await expect(store.prepareAndRun("消息", [4], undefined, async () => true)).rejects.toThrow("unresolved");
    const recovered = await store.run(attempt, async (saved) => saved.mutationId);
    expect(recovered).toEqual({ value: mutation, cleaned: true });
    expect(store.list().attempts).toEqual([]);
  });
  it("isolates records and accounts and does not clear another tab without locks", async () => {
    const env = { storage: storage(), random: () => mutation };
    const owner = new RecordCommentAttemptStore(env, 1, 2, 3);
    const attempt = owner.prepare("消息", []);
    expect(new RecordCommentAttemptStore(env, 1, 2, 4).list().attempts).toEqual([]);
    expect(new RecordCommentAttemptStore(env, 2, 2, 3).list().attempts).toEqual([]);
    const other = new RecordCommentAttemptStore(env, 1, 2, 3);
    expect((await other.run(attempt, async () => true)).cleaned).toBe(false);
    expect(other.list().attempts).toHaveLength(1);
  });
  it("refuses damaged local records rather than silently resending", async () => {
    const env = { storage: storage(), random: () => mutation };
    env.storage.setItem(`jiange:record-comment-attempt:v1:1:2:3:${mutation}`, "broken");
    const store = new RecordCommentAttemptStore(env, 1, 2, 3);
    expect(store.list().damaged).toBe(1);
    await expect(store.prepareAndRun("消息", [], undefined, async () => true)).rejects.toThrow();
  });
  it("serializes new submissions from two tabs when Web Locks are available", async () => {
    const held = new Set<string>();
    const locks = { request: async (name: string, _options: unknown, callback: (lock: Lock | null) => Promise<unknown>) => {
      if (held.has(name)) return callback(null);
      held.add(name); try { return await callback({ name, mode: "exclusive" } as Lock); } finally { held.delete(name); }
    } } as Pick<LockManager, "request">;
    const env = { storage: storage(), locks, random: () => mutation };
    const first = new RecordCommentAttemptStore(env, 1, 2, 3);
    const second = new RecordCommentAttemptStore(env, 1, 2, 3);
    let finish!: () => void;
    const pending = first.prepareAndRun("消息", [], undefined, () => new Promise<boolean>((resolve) => { finish = () => resolve(true); }));
    await expect(second.prepareAndRun("消息", [], undefined, async () => true)).rejects.toThrow("another tab");
    finish();
    expect((await pending).cleaned).toBe(true);
  });
  it("requires the new capability and validates receipt identity", async () => {
    const env = { storage: storage(), random: () => mutation };
    const attempt = new RecordCommentAttemptStore(env, 1, 2, 3).prepare("消息", []);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(Response.json({ version: 1, userId: 1, baseId: 2, recordId: 3 })).mockResolvedValueOnce(Response.json({ mutationId: mutation, userId: 1, baseId: 2, recordId: 4, commentId: 8, state: "committed" })).mockResolvedValueOnce(Response.json({ mutationId: mutation, userId: 1, baseId: 2, recordId: 3, commentId: 8, state: "committed" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requireRecordCommentAttempts(1, 2, 3)).rejects.toThrow();
    await expect(requireRecordCommentAttempts(1, 2, 3)).resolves.toBeUndefined();
    await expect(sendRecordCommentAttempt(attempt)).rejects.toThrow();
    await expect(sendRecordCommentAttempt(attempt)).resolves.toEqual({ state: "committed", commentId: 8 });
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("comment-attempts"))).toBe(true);
  });
  it("retains a content-free confirmation across stores and rejects tampering", () => {
    const env = { storage: storage(), random: () => mutation };
    const sender = new RecordCommentAttemptStore(env, 1, 2, 3);
    const attempt = sender.prepare("私有内容", []);
    const other = new RecordCommentAttemptStore(env, 1, 2, 3);
    other.confirm(attempt, "committed");
    expect(sender.isConfirmed(mutation)).toBe(true);
    const confirmationKey = `jiange:record-comment-confirmation:v1:1:2:3:${mutation}`;
    expect(env.storage.getItem(confirmationKey)).not.toContain("私有内容");
    expect(new RecordCommentAttemptStore(env, 2, 2, 3).isConfirmed(mutation)).toBe(false);
    env.storage.setItem(confirmationKey, "broken");
    expect(() => sender.isConfirmed(mutation)).toThrow();
  });
  it("keeps the pending request when a confirmed marker cannot be saved", async () => {
    const backing = storage();
    const failing: Storage = { ...backing, get length() { return backing.length; }, setItem: (key, value) => { if (key.includes("record-comment-confirmation")) throw new Error("quota"); backing.setItem(key, value); } };
    const store = new RecordCommentAttemptStore({ storage: failing, random: () => mutation }, 1, 2, 3);
    const attempt = store.prepare("消息", []);
    await expect(store.run(attempt, async (saved) => { store.confirm(saved, "committed"); return true; })).rejects.toThrow();
    expect(store.list().attempts).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { commentDraftStorageReady, CommentDraftStorage } from "./commentDraftStorage";

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
class FakeLocks {
  held = new Set<string>();
  request(name: string, _options: unknown, callback: (lock: { name: string } | null) => unknown) {
    if (this.held.has(name)) return Promise.resolve(callback(null));
    this.held.add(name);
    return Promise.resolve(callback({ name })).finally(() => { this.held.delete(name); });
  }
}

describe("persistent comment drafts", () => {
  const draft = (text: string) => ({ text, draft: null });
  it("recovers after page closure while isolating accounts and documents", async () => {
    const storage = new MemoryStorage(), locks = new FakeLocks(); let next = 0;
    const environment = () => ({ storage, locks: locks as unknown as LockManager, random: () => `random-session-${String(++next).padStart(8, "0")}` });
    const first = await CommentDraftStorage.open(environment, 7, 1);
    first.write([draft("草稿甲")], [draft("草稿乙")]); first.close();
    await Promise.resolve();
    const restored = await CommentDraftStorage.open(environment, 7, 1);
    const otherUser = await CommentDraftStorage.open(environment, 7, 2);
    const otherDoc = await CommentDraftStorage.open(environment, 8, 1);
    expect(restored.read()).toEqual([draft("草稿甲"), draft("草稿乙")]);
    expect(otherUser.read()).toEqual([]); expect(otherDoc.read()).toEqual([]);
    expect(await restored.dismiss()).toBe(true);
    expect(restored.read()).toEqual([]);
    restored.close(); otherUser.close(); otherDoc.close();
  });
  it("never clears an active tab, and refuses to delete a changed snapshot", async () => {
    const storage = new MemoryStorage(), locks = new FakeLocks(); let next = 0;
    const environment = () => ({ storage, locks: locks as unknown as LockManager, random: () => `random-session-${String(++next).padStart(8, "0")}` });
    const a = await CommentDraftStorage.open(environment, 7, 1);
    a.write([draft("旧内容")], []);
    const b = await CommentDraftStorage.open(environment, 7, 1);
    expect(b.read()).toEqual([draft("旧内容")]);
    a.write([draft("新内容")], []);
    expect(await b.dismiss()).toBe(false);
    expect(b.read()).toEqual([draft("新内容")]);
    a.close(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await b.dismiss()).toBe(true);
    expect(b.read()).toEqual([]); b.close();
  });
  it("preserves other writers without locks and surfaces quota failures", async () => {
    const storage = new MemoryStorage(); let next = 0;
    const environment = () => ({ storage, random: () => `random-session-${String(++next).padStart(8, "0")}` });
    const a = await CommentDraftStorage.open(environment, 7, 1);
    a.write([draft("保留")], []);
    const b = await CommentDraftStorage.open(environment, 7, 1);
    b.write([draft("另一标签")], []);
    a.write([draft("保留更新")], []);
    expect(await b.dismiss()).toBe(false);
    expect(b.read()).toEqual([draft("保留更新")]);
    storage.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
    expect(() => b.write([draft("失败")], [])).toThrow(); a.close(); b.close();
  });
  it("preserves a record that changed between inspection and removal", async () => {
    const storage = new MemoryStorage(), locks = new FakeLocks(); let next = 0;
    const environment = () => ({ storage, locks: locks as unknown as LockManager, random: () => `random-session-${String(++next).padStart(8, "0")}` });
    const a = await CommentDraftStorage.open(environment, 7, 1);
    a.write([draft("旧内容")], []); a.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const b = await CommentDraftStorage.open(environment, 7, 1);
    const key = [...storage.values.keys()][0];
    storage.setItem(key, JSON.stringify({ version: 1, entries: [draft("新内容")], frozen: [] }));
    expect(await b.dismiss()).toBe(false);
    expect(b.read()).toEqual([draft("新内容")]);
    b.close();
  });
  it("isolates malformed stored data and still recovers valid drafts", async () => {
    const storage = new MemoryStorage();
    const key = "jiange:comment-draft:v1:1:7:locked:existing-session-0000";
    storage.setItem(key, "invalid");
    const valid = "jiange:comment-draft:v1:1:7:locked:existing-session-0001";
    storage.setItem(valid, JSON.stringify({ version: 1, entries: [draft("完好草稿")], frozen: [] }));
    const instance = await CommentDraftStorage.open(() => ({ storage, random: () => "random-session-00000001" }), 7, 1);
    expect(instance.read()).toEqual([draft("完好草稿")]);
    expect(instance.damaged()).toEqual([{ key, raw: "invalid" }]);
    instance.write([draft("新草稿")], []);
    expect(await instance.dismiss()).toBe(false);
    expect(storage.getItem(key)).toBe("invalid");
    instance.close();
  });
  it("times out a nonresponsive lock and releases a late grant", async () => {
    const storage = new MemoryStorage();
    let callback: ((lock: { name: string } | null) => Promise<void>) | undefined;
    const locks = { request: (_name: string, _options: unknown, cb: typeof callback) => { callback = cb; return new Promise<void>(() => {}); } };
    await expect(CommentDraftStorage.open(() => ({ storage, locks: locks as unknown as LockManager, random: () => "random-session-00000001", leaseTimeoutMs: 5 }), 7, 1)).rejects.toThrow("draft lock unavailable");
    expect(callback).toBeDefined();
    // A late grant must return immediately, letting the lock manager release it.
    await expect(callback!({ name: "late" })).resolves.toBeUndefined();
  });
  it("does not reuse readiness after an unavailable period with the same session", () => {
    const target = { doc: 7, user: 1, session: 3 };
    const oldWriter = { ...target, generation: 5 };
    expect(commentDraftStorageReady(oldWriter, target, 5, true)).toBe(true);
    expect(commentDraftStorageReady(oldWriter, target, 5, false)).toBe(false);
    // Cleanup invalidates the old generation even if revalidation keeps the session ID.
    expect(commentDraftStorageReady(oldWriter, target, 6, true)).toBe(false);
    expect(commentDraftStorageReady({ ...target, generation: 7 }, target, 7, true)).toBe(true);
  });
});

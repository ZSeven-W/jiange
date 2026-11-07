import { describe, expect, it } from "vitest";
import { Doc, encodeOps, encodeServerMsg, SyncClient } from "@jiange/collab";
import { pendingOpsKey, prepareBrowserPendingSession, preparePendingSession, readAccountDraftBackups, writePendingOps } from "./pendingOpsStorage";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
    clear: () => items.clear(),
  } as Storage;
}
function fakeLocks() {
  const held = new Set<string>();
  return { request: (name: string, _options: unknown, callback: (lock: Lock | null) => Promise<void>) => {
    if (held.has(name)) return callback(null);
    held.add(name);
    return callback({ name, mode: "exclusive" }).finally(() => held.delete(name));
  } } as unknown as LockManager;
}
const op = new Doc(1).createBlock("paragraph");
const draft = { clientId: 1, ops: [op], blocked: "read_only" };
const fresh = (() => { let n = 0; return () => `12345678-1234-1234-1234-${String(++n).padStart(12, "0")}`; })();
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("offline draft ownership", () => {
  it("turns blocked browser storage getters into recoverable async errors", async () => {
    const denied = new DOMException("storage blocked", "SecurityError");
    let result: Promise<unknown> | undefined;
    expect(() => { result = prepareBrowserPendingSession(() => { throw denied; }, 10, 42, fresh); }).not.toThrow();
    await expect(result).rejects.toBe(denied);
  });
  it("prevents cloned sessionStorage tabs from restoring or overwriting each other", async () => {
    const s = memoryStorage(), firstSession = memoryStorage(), clonedSession = memoryStorage(), locks = fakeLocks();
    const first = await preparePendingSession(s, firstSession, locks, 10, 42, fresh);
    writePendingOps(s, first.key, draft);
    clonedSession.setItem("jiange:pending-session:10:42", first.key.split(":").at(-1)!);
    const second = await preparePendingSession(s, clonedSession, locks, 10, 42, fresh);
    expect(second.key).not.toBe(first.key);
    expect(second.draft).toBeNull();
    expect(second.otherDrafts).toBe(true);
    writePendingOps(s, second.key, { clientId: 2, ops: [op] });
    expect(JSON.parse(s.getItem(first.key)!).clientId).toBe(1);
    first.release(); second.release();
  });
  it("recovers only one abandoned replica under a lock and leaves other drafts intact", async () => {
    const s = memoryStorage(), locks = fakeLocks();
    const first = await preparePendingSession(s, memoryStorage(), locks, 10, 42, fresh);
    const second = await preparePendingSession(s, memoryStorage(), locks, 10, 42, fresh);
    writePendingOps(s, first.key, draft);
    writePendingOps(s, second.key, { clientId: 2, ops: [op] });
    first.release(); second.release(); await settle();
    const recovered = await preparePendingSession(s, memoryStorage(), locks, 10, 42, fresh);
    expect([first.key, second.key]).toContain(recovered.key);
    expect(recovered.draft?.ops).toEqual([op]);
    expect(recovered.otherDrafts).toBe(true);
    expect(s.getItem(first.key)).not.toBeNull();
    expect(s.getItem(second.key)).not.toBeNull();
    recovered.release();
  });
  it("without locks never replays a different tab and exports only the current account", async () => {
    const s = memoryStorage(), session = memoryStorage();
    const previousKey = pendingOpsKey(10, 42, fresh());
    writePendingOps(s, previousKey, draft);
    s.setItem("jiange:pending:v2:10:42", "prior-scoped-data");
    s.setItem("jiange:pending:42", "old-unowned-data");
    s.setItem(pendingOpsKey(11, 42, fresh()), "other-account-data");
    const current = await preparePendingSession(s, session, undefined, 10, 42, fresh);
    expect(current.draft).toBeNull();
    expect(current.legacy).toBe(true);
    expect(current.otherDrafts).toBe(true);
    expect(readAccountDraftBackups(s, 10, 42).map((x) => x.raw)).toEqual(expect.arrayContaining([JSON.stringify(draft), "prior-scoped-data"]));
    expect(JSON.stringify(readAccountDraftBackups(s, 10, 42))).not.toContain("other-account-data");
    expect(JSON.stringify(readAccountDraftBackups(s, 10, 42))).not.toContain("old-unowned-data");
    expect(s.getItem("jiange:pending:42")).toBe("old-unowned-data");
  });
  it("keeps corrupt orphan data available for export", async () => {
    const s = memoryStorage(), key = pendingOpsKey(10, 42, fresh());
    s.setItem(key, "{broken");
    const current = await preparePendingSession(s, memoryStorage(), fakeLocks(), 10, 42, fresh);
    expect(current.draft).toBeNull();
    expect(current.otherDrafts).toBe(true);
    expect(current.corrupt).toBe(true);
    expect(s.getItem(key)).toBe("{broken");
    current.release();
  });
  it("does not replay structurally corrupt operations from valid JSON", async () => {
    const s = memoryStorage(), key = pendingOpsKey(10, 42, fresh());
    const raw = JSON.stringify({ clientId: 1, ops: [{ t: "tins", id: { client: 1, clock: 7 }, text: "丢字段" }] });
    s.setItem(key, raw);
    const current = await preparePendingSession(s, memoryStorage(), fakeLocks(), 10, 42, fresh);
    expect(current.draft).toBeNull();
    expect(current.corrupt).toBe(true);
    expect(current.otherDrafts).toBe(true);
    expect(readAccountDraftBackups(s, 10, 42).some((item) => item.raw === raw)).toBe(true);
    current.release();
  });
  it("retains a missing-dependency draft for its account and derives the block again after reload", async () => {
    const local = new Doc(7), block = local.createBlock("paragraph");
    const text = local.insertText(block.id, 0, "本地草稿")!;
    const storage = memoryStorage(), locks = fakeLocks();
    const owner = await preparePendingSession(storage, memoryStorage(), locks, 10, 42, fresh);
    const client = new SyncClient(42);
    client.restore(7, [text], "read_only");
    client.open(() => {});
    client.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 0, snapshot: { seq: 0, state: new Doc(8).encodeState() } }));
    expect(client.blocked).toBe("missing_dependency");
    expect(client.rejection).toBe("read_only");
    writePendingOps(storage, owner.key, { clientId: client.clientId, ops: client.pendingOps(), blocked: client.rejection ?? client.blocked });
    const other = await preparePendingSession(storage, memoryStorage(), locks, 11, 42, fresh);
    expect(other.draft).toBeNull();
    expect(readAccountDraftBackups(storage, 11, 42)).toEqual([]);
    owner.release(); other.release(); await settle();
    const recovered = await preparePendingSession(storage, memoryStorage(), locks, 10, 42, fresh);
    expect(recovered.draft?.ops).toEqual([text]);
    const reloaded = new SyncClient(42);
    reloaded.restore(recovered.draft!.clientId, recovered.draft!.ops, recovered.draft!.blocked);
    reloaded.open(() => {});
    reloaded.receive(encodeServerMsg({ type: "welcome", clientId: 7, headSeq: 0, snapshot: { seq: 0, state: new Doc(8).encodeState() } }));
    expect(reloaded.blocked).toBe("missing_dependency");
    expect(reloaded.pendingOps()).toEqual([text]);
    reloaded.receive(encodeServerMsg({ type: "ops", firstSeq: 1, batch: encodeOps([block]) }));
    expect(reloaded.blocked).toBe("read_only");
    expect(reloaded.pendingOps()).toEqual([text]);
    recovered.release();
  });
});

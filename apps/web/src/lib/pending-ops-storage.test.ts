import { describe, expect, it } from "vitest";
import { Doc, encodeOps, encodeServerMsg, SyncClient } from "@zseven-w/collab";
import { archivePendingDraft, PendingSessionQueue, pendingOpsKey, prepareBrowserPendingSession, preparePendingSession, readAccountDraftBackups, readRecoveryDraft, recoveryDraftKeys, removeRecoveryDraft, writePendingOps } from "./pending-ops-storage";

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
  it("serializes remounts for the same account and document without blocking other documents", async () => {
    const queue = new PendingSessionQueue(), first = queue.reserve(1, 2), second = queue.reserve(1, 2), other = queue.reserve(1, 3);
    let ready = false; void second.ready.then(() => { ready = true; });
    await first.ready; await other.ready; await settle(); expect(ready).toBe(false);
    first.release(); first.release(); await second.ready; expect(ready).toBe(true);
    second.release(); other.release();
  });
  it("preserves the original epoch in a recovery copy without auto-replaying it", async () => {
    const local = memoryStorage(), session = memoryStorage(), locks = fakeLocks();
    const saved = { clientId: 1, ops: [op], blocked: "history_changed", historyEpoch: 4 };
    const key = archivePendingDraft(local, 10, 42, fresh(), saved);
    expect(readRecoveryDraft(local, 10, 42, key)).toMatchObject(saved);
    expect(readRecoveryDraft(local, 11, 42, key)).toBeNull();
    expect(recoveryDraftKeys(local, 10, 42)).toEqual([key]);
    expect(readAccountDraftBackups(local, 10, 42).map((item) => item.key)).toEqual([key]);
    const next = await preparePendingSession(local, session, locks, 10, 42, fresh);
    expect(next.draft).toBeNull(); next.release();
  });

  it("never overwrites a recovery copy or treats an invalid epoch as a valid draft", async () => {
    const local = memoryStorage(), token = fresh(), saved = { clientId: 1, ops: [op], historyEpoch: 3 };
    const key = archivePendingDraft(local, 10, 42, token, saved), before = local.getItem(key);
    expect(() => archivePendingDraft(local, 10, 42, token, saved)).toThrow();
    expect(local.getItem(key)).toBe(before);
    expect(() => archivePendingDraft(local, 10, 42, fresh(), { ...saved, historyEpoch: 0 })).toThrow();
    expect(local.getItem(key)).toBe(before);
  });
  it("does not let draft metadata change the recovery copy's account scope", () => {
    const local = memoryStorage();
    const forged = { clientId: 1, ops: [op], userId: 11, docId: 99, version: 99 };
    const key = archivePendingDraft(local, 10, 42, fresh(), forged);
    expect(JSON.parse(local.getItem(key)!)).toMatchObject({ userId: 10, docId: 42, version: 1 });
    expect(readRecoveryDraft(local, 11, 99, key)).toBeNull();
    expect(readRecoveryDraft(local, 10, 42, key)?.ops).toEqual([op]);
  });
  it("deletes only the unchanged, confirmed recovery copy within its account and document", () => {
    const local = memoryStorage(), first = archivePendingDraft(local, 10, 42, fresh(), draft);
    const second = archivePendingDraft(local, 10, 42, fresh(), draft);
    const other = archivePendingDraft(local, 11, 42, fresh(), draft);
    const pending = pendingOpsKey(10, 42, fresh()); writePendingOps(local, pending, draft);
    const raw = local.getItem(first)!;
    expect(removeRecoveryDraft(local, 11, 42, first, raw)).toBe(false);
    expect(removeRecoveryDraft(local, 10, 43, first, raw)).toBe(false);
    expect(removeRecoveryDraft(local, 10, 42, pending, local.getItem(pending)!)).toBe(false);
    local.setItem(first, raw + " ");
    expect(removeRecoveryDraft(local, 10, 42, first, raw)).toBe(false);
    expect(local.getItem(first)).toBe(raw + " ");
    expect(removeRecoveryDraft(local, 10, 42, first, raw + " ")).toBe(true);
    expect(removeRecoveryDraft(local, 10, 42, first, raw + " ")).toBe(false);
    expect(local.getItem(second)).not.toBeNull(); expect(local.getItem(other)).not.toBeNull(); expect(local.getItem(pending)).not.toBeNull();
  });
  it("does not claim deletion succeeded when storage refuses it", () => {
    const local = memoryStorage(), key = archivePendingDraft(local, 10, 42, fresh(), draft), raw = local.getItem(key)!;
    local.removeItem = () => { throw new DOMException("storage denied", "SecurityError"); };
    expect(() => removeRecoveryDraft(local, 10, 42, key, raw)).toThrow();
    expect(local.getItem(key)).toBe(raw);
  });
  it("restores unsupported table payload bytes for the owning session, including the older JSON form", async () => {
    const local = memoryStorage(), session = memoryStorage(), locks = fakeLocks(), owner = await preparePendingSession(local, session, locks, 10, 42, fresh);
    const table = { t: "ttable" as const, id: { client: 1, clock: 2 }, block: { client: 1, clock: 1 }, payload: new Uint8Array([0, 17, 128, 255]) };
    const pending = { clientId: 1, ops: [table], blocked: "table_unsupported" };
    writePendingOps(local, owner.key, pending);
    owner.release(); await settle();
    const restored = await preparePendingSession(local, session, locks, 10, 42, fresh);
    expect(restored.draft).toEqual(pending); restored.release(); await settle();
    local.setItem(owner.key, JSON.stringify(pending)); // legacy Uint8Array serializes as numeric keys
    const legacy = await preparePendingSession(local, session, locks, 10, 42, fresh);
    expect(legacy.draft).toEqual(pending); legacy.release();
  });
  it("retains malformed experimental payloads for manual backup", async () => {
    const local = memoryStorage(), key = pendingOpsKey(10, 42, fresh());
    const raw = JSON.stringify({ clientId: 1, ops: [{ t: "ttable", id: { client: 1, clock: 2 }, block: { client: 1, clock: 1 }, payload: [1, 256] }] });
    local.setItem(key, raw);
    const current = await preparePendingSession(local, memoryStorage(), fakeLocks(), 10, 42, fresh);
    expect(current.corrupt).toBe(true); expect(current.draft).toBeNull();
    expect(readAccountDraftBackups(local, 10, 42).some((item) => item.raw === raw)).toBe(true); current.release();
  });
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
  it("waits until a released lease is actually available to the next recovery", async () => {
    const storage = memoryStorage(), locks = fakeLocks();
    const first = await preparePendingSession(storage, memoryStorage(), locks, 10, 42, fresh);
    writePendingOps(storage, first.key, { ...draft, historyEpoch: 3 });
    await first.release();
    const recovered = await preparePendingSession(storage, memoryStorage(), locks, 10, 42, fresh);
    expect(recovered.key).toBe(first.key);
    expect(recovered.draft?.historyEpoch).toBe(3);
    await recovered.release();
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

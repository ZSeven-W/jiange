import { describe, expect, it, vi } from "vitest";
import type { Op } from "@jiange/collab";
import {
  createStorageLeaseLockProvider,
  inspectCrossSessionDrafts,
  pendingOpsKey,
  prepareBrowserPendingSession,
  writePendingOps,
  type PendingOpsDraft,
} from "./pending-ops-storage";
import { TitleAutoSync, titleSyncDurableStorageKey, titleSyncStorageKey, type TitleSyncPoint } from "../pages/title-auto-sync";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key(index: number) { return [...map.keys()][index] ?? null; },
    getItem(key: string) { return map.get(key) ?? null; },
    setItem(key: string, value: string) { map.set(key, value); },
    removeItem(key: string) { map.delete(key); },
    clear() { map.clear(); },
  };
}

const sampleOp: Op = { t: "bset", id: { client: 1, clock: 2 }, block: { client: 0, clock: 1 }, key: "align", value: "center" };
const sampleDraft: PendingOpsDraft = { clientId: 1, ops: [sampleOp], historyEpoch: 1 };

describe("cross-session pending-op & title recovery", () => {
  it("recovers abandoned pending drafts after tab crash via localStorage lease fallback when Web Locks is unavailable", async () => {
    const local = memoryStorage();
    let now = 1_000_000;
    const token1 = "tab-one-token-1234567890";
    const key1 = pendingOpsKey(7, 99, token1);
    writePendingOps(local, key1, sampleDraft);

    // Tab 1 holds an active lease (not expired yet)
    const tab1Locks = createStorageLeaseLockProvider(local, "owner-tab-1", 15_000, () => now);
    let releaseTab1!: () => void;
    const tab1Held = new Promise<void>((r) => { releaseTab1 = r; });
    const tab1LockDone = tab1Locks.request(key1, { ifAvailable: true }, async (lock) => {
      expect(lock).not.toBeNull();
      await tab1Held;
    });

    // While Tab 1's lease is active, Tab 2 cannot steal its draft
    const tab2Locks = createStorageLeaseLockProvider(local, "owner-tab-2", 15_000, () => now);
    const denied = await tab2Locks.request(key1, { ifAvailable: true }, (lock) => lock);
    expect(denied).toBeNull();

    // Simulate browser crash: advance clock past TTL without clean release
    now += 20_000;
    let seq = 0;
    const recovered = await prepareBrowserPendingSession(
      () => ({ local, session: memoryStorage(), locks: createStorageLeaseLockProvider(local, "owner-tab-3", 15_000, () => now) }),
      7,
      99,
      () => `fresh-token-1234567890-${++seq}`,
    );
    expect(recovered.draft).toEqual(sampleDraft);
    expect(recovered.key).toBe(key1);
    expect(inspectCrossSessionDrafts(local, 7, 99)).toEqual({ activeCount: 1, recoveryCount: 0, totalOps: 1 });

    await recovered.release();
    releaseTab1();
    await tab1LockDone;
  });

  it("recovers pending title sync across tab closes via durable localStorage and migrates legacy sessionStorage", async () => {
    const local = memoryStorage();
    const legacySession = memoryStorage();
    let point: TitleSyncPoint = { epoch: 2, head: 10, historyRevision: 0, title: "新文档标题" };
    const commit = vi.fn(async () => 204);
    const read = vi.fn(async () => ({ historyEpoch: 2, head: 10, directoryTitle: "旧文档标题", documentTitle: "新文档标题", differs: true }));

    // Tab 1 edits title and crashes before commit finishes (saved to localStorage)
    const tab1 = new TitleAutoSync(
      () => point,
      { commit, read },
      () => {},
      { storage: local, key: titleSyncDurableStorageKey(7, 99), legacySession: { storage: legacySession, key: titleSyncStorageKey(7, 99) } },
    );
    tab1.edit("旧文档标题", 2, 0, "新文档标题");
    tab1.dispose();

    // Tab 2 opens fresh (empty sessionStorage!) and recovers from durable localStorage
    const committed = vi.fn();
    const tab2 = new TitleAutoSync(
      () => point,
      { commit, read },
      committed,
      { storage: local, key: titleSyncDurableStorageKey(7, 99), legacySession: { storage: memoryStorage(), key: titleSyncStorageKey(7, 99) } },
    );
    tab2.activate();
    expect(tab2.hasPending).toBe(true);
    const outcome = await tab2.step();
    expect(outcome).toBe("done");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(local.getItem(titleSyncDurableStorageKey(7, 99))).toBeNull();
  });
});

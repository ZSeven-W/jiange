import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Doc, encodeOps, ROOT, Tx, type Op } from "@jiange/collab";
import { conditionalBatchBase64, queryConditionalOpsStatus } from "@/lib/api";
import { ConditionalJournal, conditionalJournalStorageKey, type ConditionalAttempt, type ConditionalJournalEnvironment, type ConditionalObservation } from "@/lib/conditional-journal";
import { TITLE } from "./model";
import { findDocumentMatches } from "./table-find";
import { prepareAtomicFindBatch } from "./atomic-find-batch";
import { AtomicFindCommit, atomicFindBatchOps } from "./atomic-find-commit";

class StorageMock implements Storage {
  private data = new Map<string, string>(); get length() { return this.data.size; } clear() { this.data.clear(); } getItem(k: string) { return this.data.get(k) ?? null; } key(i: number) { return [...this.data.keys()][i] ?? null; } removeItem(k: string) { this.data.delete(k); } setItem(k: string, v: string) { this.data.set(k, v); }
}
class LocksMock {
  private held = new Set<string>();
  async request<T>(name: string, _options: unknown, callback: (lock: object | null) => Promise<T>): Promise<T> {
    if (this.held.has(name)) return callback(null); this.held.add(name); try { return await callback({}); } finally { this.held.delete(name); }
  }
}
const hash = async (bytes: Uint8Array) => new Uint8Array(await webcrypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
const signal = () => new AbortController().signal;
function fixture() {
  const doc = new Doc(9); doc.apply({ t: "bcreate", id: TITLE, parent: ROOT, pos: "U", type: "title" }); doc.insertText(TITLE, 0, "目标计划");
  const tx = new Tx(doc), text = tx.create("paragraph", TITLE, ROOT); tx.insert(text, 0, "目标正文");
  const prep = prepareAtomicFindBatch(doc, 19, findDocumentMatches(doc, "目标"), "完成", "目标计划"); if (prep.status !== "ready") throw new Error(prep.status);
  const env: ConditionalJournalEnvironment = { storage: new StorageMock(), locks: new LocksMock() as unknown as Pick<LockManager, "request">, random: () => "a".repeat(32), digest: hash };
  const journal = new ConditionalJournal(env, 7, 2); let active = true;
  let observation: ConditionalObservation | null = { docId: 7, userId: 2, epoch: 1, lastSeq: 5, caughtUp: true, blocked: null, unacked: 0 };
  let state: "unknown" | "committed" = "unknown", head = 5;
  const send = vi.fn(async (_attempt: ConditionalAttempt, _bytes: Uint8Array, _signal: AbortSignal) => {});
  const status = vi.fn(async (attempt: ConditionalAttempt) => {
    const payload = state === "unknown" ? { state, docId: 7, userId: 2, requestId: attempt.requestId, currentEpoch: 1, currentHead: head } : { state, docId: 7, userId: 2, requestId: attempt.requestId, currentEpoch: 1, currentHead: head, historyEpoch: 1, expectedSeq: 5, firstSeq: 6, opCount: attempt.opCount, digest: attempt.digest };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
    return queryConditionalOpsStatus({ docId: 7, userId: 2, requestId: attempt.requestId, signal: signal() });
  });
  const commit = new AtomicFindCommit(journal, { active: () => active, observe: () => observation }, { send, status });
  return { plan: prep.plan, env, journal, commit, send, status, setActive: (value: boolean) => { active = value; }, setObservation: (value: ConditionalObservation | null) => { observation = value; }, setStatus: (value: "unknown" | "committed", newHead: number) => { state = value; head = newHead; } };
}
afterEach(() => vi.unstubAllGlobals());

describe("durable conditional find batches", () => {
  it("accepts title and text edits but refuses unrelated layout and title marks", () => {
    const { plan } = fixture(); expect(atomicFindBatchOps(encodeOps([...plan.ops]))).toHaveLength(plan.ops.length);
    const bad: Op = { t: "bset", id: { client: 19, clock: 100 }, block: { client: 2, clock: 1 }, key: "align", value: "center" };
    expect(atomicFindBatchOps(encodeOps([bad]))).toBeNull();
    const mark: Op = { t: "mark", id: { client: 19, clock: 101 }, block: TITLE, key: "bold", value: "1", start: { char: ROOT, side: 1 }, end: { char: ROOT, side: 1 } };
    expect(atomicFindBatchOps(encodeOps([mark]))).toBeNull();
  });

  it("persists the original batch and retries the identical request after a lost response", async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(new Error("network"));
    expect(await f.commit.start(f.plan.ops, 1, 5, signal())).toBe("pending");
    const saved = await f.journal.read(); expect(saved?.requestId).toBe("a".repeat(32));
    expect(await f.commit.retry(signal())).toBe("sent");
    expect(f.send.mock.calls[0][0].requestId).toBe(f.send.mock.calls[1][0].requestId);
    expect(f.send.mock.calls[0][1]).toEqual(f.send.mock.calls[1][1]);
  });

  it("keeps restricted batch content out of persistent storage while retaining receipt verification", async () => {
    const f = fixture();
    expect(await f.commit.start(f.plan.ops, 1, 5, signal(), () => true, () => {}, false)).toBe("sent");
    const saved = await f.journal.read(); expect(saved?.redacted).toBe(true); expect(saved?.purpose).toBe("atomic-find"); expect(saved?.batch).toBeUndefined();
    expect(f.env.storage.getItem(conditionalJournalStorageKey(2, 7))).not.toContain(conditionalBatchBase64(encodeOps([...f.plan.ops])));
    expect(f.send.mock.calls[0][1]).toEqual(encodeOps([...f.plan.ops]));
    expect(await f.commit.pendingKind()).toBe("redacted"); expect(await f.commit.retry(signal())).toBe("blocked");
    f.setStatus("committed", 5 + f.plan.ops.length);
    f.setObservation({ docId: 7, userId: 2, epoch: 1, lastSeq: 5 + f.plan.ops.length, caughtUp: true, blocked: null, unacked: 0 });
    expect(await f.commit.finish(signal(), async () => true)).toBe("committed"); expect(await f.journal.read()).toBeNull();
  });

  it("redacts a pending find batch without touching other journal entries", async () => {
    const f = fixture(); await f.commit.start(f.plan.ops, 1, 5, signal());
    expect(await f.commit.pendingKind()).toBe("find"); await f.commit.redactPending();
    expect(await f.commit.pendingKind()).toBe("redacted");
  });

  it("retries a redacted request only with the exact in-memory batch", async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(new Error("network"));
    expect(await f.commit.start(f.plan.ops, 1, 5, signal(), () => true, () => {}, false)).toBe("pending");
    const wrong = f.plan.ops.slice(1);
    expect(await f.commit.retry(signal(), () => true, wrong)).toBe("occupied");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(await f.commit.retry(signal(), () => true, f.plan.ops)).toBe("sent");
    expect(f.send.mock.calls[1][1]).toEqual(encodeOps([...f.plan.ops]));
    expect((await f.journal.read())?.redacted).toBe(true);
  });

  it("discards an unsubmitted preparation when the document changes", async () => {
    const f = fixture(); let calls = 0;
    expect(await f.commit.start(f.plan.ops, 1, 5, signal(), () => ++calls === 1)).toBe("blocked");
    expect(f.send).not.toHaveBeenCalled(); expect(await f.journal.read()).toBeNull();
  });

  it("does not settle a confirmed batch until synchronized and locally finalized", async () => {
    const f = fixture(); expect(await f.commit.start(f.plan.ops, 1, 5, signal())).toBe("sent");
    f.setStatus("committed", 5 + f.plan.ops.length);
    const finalize = vi.fn(async () => true);
    expect(await f.commit.finish(signal(), finalize)).toBe("pending"); expect(finalize).not.toHaveBeenCalled();
    f.setObservation({ docId: 7, userId: 2, epoch: 1, lastSeq: 5 + f.plan.ops.length, caughtUp: true, blocked: null, unacked: 0 });
    finalize.mockResolvedValueOnce(false);
    expect(await f.commit.finish(signal(), finalize)).toBe("needs_finalize"); expect(await f.journal.read()).not.toBeNull();
    expect(await f.commit.finish(signal(), finalize)).toBe("committed"); expect(await f.journal.read()).toBeNull();
  });

  it("retains the receipt if observation disappears during finalization", async () => {
    const f = fixture(); await f.commit.start(f.plan.ops, 1, 5, signal()); f.setStatus("committed", 5 + f.plan.ops.length);
    const observed: ConditionalObservation = { docId: 7, userId: 2, epoch: 1, lastSeq: 5 + f.plan.ops.length, caughtUp: true, blocked: null, unacked: 0 }; f.setObservation(observed);
    expect(await f.commit.finish(signal(), async () => { f.setObservation(null); return true; })).toBe("pending");
    expect(await f.journal.read()).not.toBeNull(); f.setObservation(observed);
    expect(await f.commit.finish(signal(), async () => true)).toBe("committed");
  });

  it("leaves a different kind of operation in the shared journal untouched", async () => {
    const f = fixture(), alignment: Op = { t: "bset", id: { client: 19, clock: 100 }, block: { client: 2, clock: 1 }, key: "align", value: "center" };
    await f.journal.run(async (lease) => { await lease.prepare({ historyEpoch: 1, expectedSeq: 5, batch: encodeOps([alignment]), allowPersist: true }); });
    expect(await f.commit.retry(signal())).toBe("occupied"); expect(await f.journal.read()).not.toBeNull();
    await f.journal.run(async (lease) => { await lease.redact(); });
    expect(await f.commit.pendingKind()).toBe("other");
    expect(await f.commit.finish(signal(), async () => true)).toBe("blocked");
  });
});

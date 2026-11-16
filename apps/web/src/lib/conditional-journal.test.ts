import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeOps, type Op } from "@jiange/collab";
import { queryConditionalOpsStatus, type ConditionalOpsStatus } from "./api";
import { ConditionalJournal, conditionalOpsDigest, conditionalResolution, type ConditionalAttempt, type ConditionalJournalEnvironment, type ConditionalJournalLease, type ConditionalObservation } from "./conditional-journal";

class StorageMock implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
class LocksMock {
  private held = new Set<string>();
  async request<T>(name: string, _options: unknown, callback: (lock: object | null) => Promise<T>): Promise<T> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name }); } finally { this.held.delete(name); }
  }
}
const requestId = "0123456789abcdef0123456789abcdef";
const op: Op = { t: "tins", id: { client: 9, clock: 4 }, block: { client: 0, clock: 2 }, parent: { client: 0, clock: 0 }, side: 1, text: "甲" };
const bytes = encodeOps([op]);
const hash = async (value: Uint8Array) => new Uint8Array(await webcrypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer));
const environment = (storage = new StorageMock(), locks = new LocksMock()): ConditionalJournalEnvironment => ({ storage, locks: locks as unknown as Pick<LockManager, "request">, random: () => requestId, digest: hash });
const observed: ConditionalObservation = { docId: 7, userId: 2, epoch: 2, lastSeq: 4, caughtUp: true, blocked: null, unacked: 0 };

async function status(value: Record<string, unknown>): Promise<ConditionalOpsStatus> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { status: 200 })));
  return queryConditionalOpsStatus({ docId: 7, userId: 2, requestId, signal: new AbortController().signal });
}
const unknown = (head: number, epoch = 2) => ({ docId: 7, userId: 2, requestId, state: "unknown", currentEpoch: epoch, currentHead: head });
const committed = (attempt: ConditionalAttempt, epoch = 2) => ({ docId: 7, userId: 2, requestId, state: epoch === 2 ? "committed" : "history_changed", currentEpoch: epoch, currentHead: 4, historyEpoch: 2, expectedSeq: 3, firstSeq: 4, opCount: 1, digest: attempt.digest });

afterEach(() => vi.unstubAllGlobals());

describe("conditional operation journal", () => {
  it("keeps archive records scoped and rejects redaction that would erase their type", async () => {
    const env = environment(), journal = new ConditionalJournal(env, 7, 2);
    await journal.run(async (lease) => {
      const attempt = await lease.prepare({ historyEpoch: 2, expectedSeq: 3, batch: bytes, allowPersist: true, purpose: "column-archive" });
      expect(attempt.purpose).toBe("column-archive");
      await expect(lease.redact()).rejects.toThrow("cannot redact");
      expect((await lease.read())?.purpose).toBe("column-archive");
    });
    expect(await new ConditionalJournal(env, 7, 3).read()).toBeNull();
    expect(await new ConditionalJournal(env, 8, 2).read()).toBeNull();
  });
  it("clears a redacted attempt only after a matching cancellation fence is verified", async () => {
    const journal = new ConditionalJournal(environment(), 7, 2);
    await journal.run(async (lease) => {
      const attempt = await lease.prepare({ historyEpoch: 2, expectedSeq: 3, batch: bytes, allowPersist: false, redactInstead: true, redactedPurpose: "atomic-find" });
      lease.markSubmitting(attempt);
      const body = { docId: 7, userId: 2, requestId, state: "cancelled", currentEpoch: 2, currentHead: 3, historyEpoch: 2, expectedSeq: 3, firstSeq: 4, opCount: 1, clientId: attempt.clientId, digest: attempt.digest };
      const fence = await status(body);
      expect(conditionalResolution(attempt, fence, { ...observed, caughtUp: false })).toBe("pending");
      const wrong = await status({ ...body, clientId: attempt.clientId + 1 });
      expect(conditionalResolution(attempt, wrong, observed)).toBe("mismatch");
      expect(await lease.settle(fence, observed)).toBe("cancelled");
      expect(await lease.read()).toBeNull();
    });
  });
  it("only discards the creating lease's attempt before transport starts", async () => {
    const journal = new ConditionalJournal(environment(), 7, 2);
    await journal.run(async (lease) => {
      const unsent = await lease.prepare({historyEpoch:2,expectedSeq:3,batch:bytes,allowPersist:true});
      await lease.discardUnsubmitted(unsent);
      expect(await lease.read()).toBeNull();
      const sending = await lease.prepare({historyEpoch:2,expectedSeq:3,batch:bytes,allowPersist:true});
      lease.markSubmitting(sending);
      await expect(lease.discardUnsubmitted(sending)).rejects.toThrow(/unsubmitted/);
      expect(await lease.read()).not.toBeNull();
    });
    await journal.run(async (lease) => {
      const existing = await lease.read();
      await expect(lease.discardUnsubmitted(existing!)).rejects.toThrow(/unsubmitted/);
    });
  });
  it("does not remove a journal changed while an unsent discard is being checked", async () => {
    const storage = new StorageMock(), env = environment(storage), journal = new ConditionalJournal(env, 7, 2);
    await journal.run(async (lease) => {
      const attempt = await lease.prepare({historyEpoch:2,expectedSeq:3,batch:bytes,allowPersist:true});
      const key = storage.key(0)!;
      env.digest = async (value) => { storage.setItem(key, "changed-by-another-page"); return hash(value); };
      await expect(lease.discardUnsubmitted(attempt)).rejects.toThrow(/changed/);
      expect(storage.getItem(key)).toBe("changed-by-another-page");
    });
  });
  it("matches the server digest vector and copies the original batch", async () => {
    const proof = await conditionalOpsDigest(2, 3, bytes, hash);
    expect(proof).toEqual({ clientId: 9, opCount: 1, digest: "cfc24dd38d45569dee454d431f0f256f33aa38ce0fdb5cdd75deb2b84da779fc" });
    const env = environment(), journal = new ConditionalJournal(env, 7, 2), source = Uint8Array.from(bytes);
    await journal.run(async (lease) => {
      const attempt = await lease.prepare({ historyEpoch: 2, expectedSeq: 3, batch: source, allowPersist: true });
      source.fill(0);
      expect(await lease.batch(attempt)).toEqual(bytes);
      expect(Object.isFrozen(attempt)).toBe(true);
    });
    expect((await journal.read())?.requestId).toBe(requestId);
    expect(await new ConditionalJournal(env, 7, 3).read()).toBeNull();
    expect(await new ConditionalJournal(env, 8, 2).read()).toBeNull();
  });

  it("requires a held cross-tab lock and never overwrites an unresolved attempt", async () => {
    const storage = new StorageMock(), locks = new LocksMock(), env = environment(storage, locks), first = new ConditionalJournal(env, 7, 2), second = new ConditionalJournal(env, 7, 2);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
    let escaped: ConditionalJournalLease | undefined;
    const run = first.run(async (lease) => { escaped = lease; await lease.prepare({ historyEpoch: 2, expectedSeq: 3, batch: bytes, allowPersist: true }); entered(); await held; });
    await started;
    await expect(second.run(async () => undefined)).rejects.toThrow("another tab");
    release(); await run;
    await expect(escaped!.read()).rejects.toThrow("lease expired");
    await expect(second.run((lease) => lease.prepare({ historyEpoch: 2, expectedSeq: 3, batch: bytes, allowPersist: true }))).rejects.toThrow("already exists");
    const noLocks = new ConditionalJournal({ ...env, locks: undefined }, 7, 2);
    await expect(noLocks.run(async () => undefined)).rejects.toThrow("lock unavailable");
  });

  it("keeps unknown outcomes and clears committed attempts only after the replica has observed them", async () => {
    const env = environment(), journal = new ConditionalJournal(env, 7, 2);
    await journal.run(async (lease) => {
      const attempt = await lease.prepare({ historyEpoch: 2, expectedSeq: 3, batch: bytes, allowPersist: true });
      expect(await lease.settle(await status(unknown(3)), observed)).toBe("pending");
      const receipt = await status(committed(attempt));
      expect(await lease.settle(receipt, { ...observed, lastSeq: 3 })).toBe("pending");
      expect(await lease.settle(receipt, { ...observed, unacked: 1 })).toBe("pending");
      expect(await lease.settle(receipt, { ...observed, userId: 3 })).toBe("pending");
      expect(conditionalResolution(attempt, { ...receipt, currentHead: 99 } as ConditionalOpsStatus, observed)).toBe("mismatch");
      expect(await lease.settle(receipt, observed)).toBe("committed");
      expect(await lease.read()).toBeNull();
    });
  });

  it("clears a proven non-commit only in the same generation with a later head", async () => {
    const journal = new ConditionalJournal(environment(), 7, 2);
    await journal.run(async (lease) => {
      await lease.prepare({ historyEpoch: 2, expectedSeq: 3, batch: bytes, allowPersist: true });
      expect(await lease.settle(await status(unknown(2)), observed)).toBe("pending");
      expect(await lease.settle(await status(unknown(3, 3)), observed)).toBe("history_changed");
      expect(await lease.settle(await status(unknown(4)), observed)).toBe("not_committed");
      expect(await lease.read()).toBeNull();
    });
  });

  it("redacts operation bytes while retaining a receipt-checkable identity", async () => {
    const env = environment(), journal = new ConditionalJournal(env, 7, 2);
    await journal.run(async (lease) => {
      const attempt = await lease.prepare({ historyEpoch: 2, expectedSeq: 3, batch: bytes, allowPersist: true });
      const redacted = await lease.redact(); expect(redacted?.redacted).toBe(true);
      expect(env.storage.getItem(env.storage.key(0)!)!).not.toContain(attempt.batch!);
      await expect(lease.batch(redacted!)).rejects.toThrow("cannot be resent");
      expect(await lease.settle(await status(unknown(4)), observed)).toBe("pending");
      expect(await lease.settle(await status(committed(attempt)), observed)).toBe("committed");
    });
  });

  it("preserves damaged records and refuses storage or permission failures", async () => {
    const storage = new StorageMock(), env = environment(storage), journal = new ConditionalJournal(env, 7, 2);
    await expect(journal.run((lease) => lease.prepare({ historyEpoch: 2, expectedSeq: 3, batch: bytes, allowPersist: false }))).rejects.toThrow("forbidden");
    vi.spyOn(storage, "setItem").mockImplementationOnce(() => { throw new Error("quota"); });
    await expect(journal.run((lease) => lease.prepare({ historyEpoch: 2, expectedSeq: 3, batch: bytes, allowPersist: true }))).rejects.toThrow("quota");
    storage.setItem("jiange:conditional-ops:v1:2:7", "{damaged");
    await expect(journal.read()).rejects.toThrow();
    await expect(journal.run((lease) => lease.prepare({ historyEpoch: 2, expectedSeq: 3, batch: bytes, allowPersist: true }))).rejects.toThrow("already exists");
    expect(storage.getItem("jiange:conditional-ops:v1:2:7")).toBe("{damaged");
  });
});

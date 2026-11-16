import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Doc, ROOT, Tx, encodeOps, type Op } from "@jiange/collab";
import { prepareColumnArchive, prepareColumnArchiveTransition, recoverColumnArchive } from "@jiange/doc-sdk/column-archive-experimental";
import { ApiError, queryConditionalOpsStatus } from "@/lib/api";
import { ConditionalJournal, conditionalJournalStorageKey, type ConditionalAttempt, type ConditionalJournalEnvironment, type ConditionalObservation } from "@/lib/conditional-journal";
import { ColumnAlignmentCommit } from "./column-alignment-commit";
import { AtomicFindCommit } from "./atomic-find-commit";
import { ColumnArchiveCommit, columnArchiveBatch } from "./column-archive-commit";

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
  const doc = new Doc(9), tx = new Tx(doc), parent = tx.create("columns", null, ROOT), left = tx.create("paragraph", null, parent), right = tx.create("paragraph", left, parent);
  tx.insert(left, 0, "受限正文");
  const plan = prepareColumnArchive(doc, 19, parent, left); if (!plan) throw new Error("preparation failed");
  const env: ConditionalJournalEnvironment = { storage: new StorageMock(), locks: new LocksMock() as unknown as Pick<LockManager, "request">, random: () => "a".repeat(32), digest: hash };
  const journal = new ConditionalJournal(env, 7, 2); let active = true;
  let observation: ConditionalObservation = { docId: 7, userId: 2, epoch: 1, lastSeq: 5, caughtUp: true, blocked: null, unacked: 0 };
  let state: "unknown" | "committed" | "cancelled" = "unknown", head = 5;
  const send = vi.fn(async (_attempt: ConditionalAttempt, _bytes: Uint8Array, _signal: AbortSignal) => {});
  const status = vi.fn(async (attempt: ConditionalAttempt) => {
    const payload = state === "unknown" ? { state, docId: 7, userId: 2, requestId: attempt.requestId, currentEpoch: 1, currentHead: head } : { state, docId: 7, userId: 2, requestId: attempt.requestId, currentEpoch: 1, currentHead: head, historyEpoch: 1, expectedSeq: 5, firstSeq: 6, opCount: attempt.opCount, digest: attempt.digest, ...(state === "cancelled" ? { clientId: attempt.clientId } : {}) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
    return queryConditionalOpsStatus({ docId: 7, userId: 2, requestId: attempt.requestId, signal: signal() });
  });
  const cancel = vi.fn(async (attempt: ConditionalAttempt) => { if (state === "unknown") state = "cancelled"; return status(attempt); });
  const context = { active: () => active, observe: () => observation };
  const transport = { send, status, cancel };
  return { doc, parent, left, right, plan, env, journal, commit: new ColumnArchiveCommit(journal, context, transport), context, transport, send, status, cancel, setActive: (value: boolean) => { active = value; }, setObservation: (value: ConditionalObservation) => { observation = value; }, setStatus: (value: typeof state, newHead: number) => { state = value; head = newHead; } };
}
afterEach(() => vi.unstubAllGlobals());

describe("conditional column archive", () => {
  it("accepts root-level group archive and guarded restore without text", () => {
    const f = fixture(), group = prepareColumnArchive(f.doc, 20, ROOT, f.parent)!;
    expect(columnArchiveBatch(encodeOps([...group.ops]))).toHaveLength(4);
    for (const op of group.ops) f.doc.apply(op);
    const restored = prepareColumnArchiveTransition(recoverColumnArchive(f.doc, group.recovery)!, 21)!;
    expect(columnArchiveBatch(encodeOps([...restored.ops]))).toHaveLength(1);
  });
  it("persists no content and retries exactly the same request after a reload", async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(new Error("network"));
    expect(await f.commit.start(f.plan, 1, 5, signal())).toBe("pending");
    const saved = await f.journal.read(); expect(saved?.purpose).toBe("column-archive");
    expect(f.env.storage.getItem(conditionalJournalStorageKey(2, 7))).not.toContain("受限正文");
    const recovered = new ColumnArchiveCommit(new ConditionalJournal(f.env, 7, 2), f.context, f.transport);
    expect(await recovered.pendingKind()).toBe("archive"); expect(await recovered.retry(signal())).toBe("sent");
    expect(f.send.mock.calls[1][0].requestId).toBe(saved?.requestId);
    expect(f.send.mock.calls[1][1]).toEqual(f.send.mock.calls[0][1]);
  });
  it("does not finalize until a matching receipt and the operation are observed", async () => {
    const f = fixture(); await f.commit.start(f.plan, 1, 5, signal());
    f.setStatus("committed", 9); const finalize = vi.fn(async () => true);
    expect(await f.commit.finish(signal(), finalize)).toBe("pending"); expect(finalize).not.toHaveBeenCalled();
    for (const op of f.plan.ops) f.doc.apply(op);
    f.setObservation({ docId: 7, userId: 2, epoch: 1, lastSeq: 9, caughtUp: true, blocked: null, unacked: 0 });
    expect(recoverColumnArchive(f.doc, f.plan.recovery)).not.toBeNull();
    finalize.mockResolvedValueOnce(false);
    expect(await f.commit.finish(signal(), finalize)).toBe("needs_finalize"); expect(await f.journal.read()).not.toBeNull();
    expect(await f.commit.finish(signal(), finalize)).toBe("committed"); expect(await f.journal.read()).toBeNull();
  });
  it("does not submit a plan after the document or account changes", async () => {
    const f = fixture(); const peer = Doc.fromState(2, f.doc.encodeState()); f.doc.apply(peer.insertText(f.right, 0, "新")!);
    expect(await f.commit.start(f.plan, 1, 5, signal())).toBe("blocked"); expect(f.send).not.toHaveBeenCalled();
    expect(await f.journal.read()).toBeNull();
  });
  it("retains uncertain requests when safe cancellation is disabled", async () => {
    const f = fixture(); await f.commit.start(f.plan, 1, 5, signal());
    f.cancel.mockRejectedValueOnce(new ApiError(503, "conditional_cancel_disabled", "disabled"));
    expect(await f.commit.cancel(signal())).toBe("unavailable"); expect(await f.journal.read()).not.toBeNull();
    expect(await f.commit.cancel(signal())).toBe("cancelled"); expect(await f.journal.read()).toBeNull();
  });
  it("does not let other journal consumers mistake an archive for their operation", async () => {
    const f = fixture(); await f.commit.start(f.plan, 1, 5, signal());
    const alignment = new ColumnAlignmentCommit(f.journal, f.context, f.transport);
    const find = new AtomicFindCommit(f.journal, f.context, f.transport);
    expect(await find.pendingKind()).toBe("other"); expect(await find.finish(signal(), async () => true)).toBe("blocked");
    expect(await alignment.finish(signal(), () => true)).toBe("blocked"); expect(await f.journal.read()).not.toBeNull();
  });
  it("rejects unrelated, malformed or text-bearing batches", () => {
    const f = fixture(), unrelated: Op = { t: "tins", id: { client: 19, clock: 99 }, block: f.left, parent: ROOT, side: 1, text: "秘密" };
    expect(columnArchiveBatch(encodeOps([unrelated]))).toBeNull();
    const ops = f.plan.ops.map((op) => structuredClone(op));
    if (ops[2].t !== "bset") throw new Error("unexpected operation"); ops[2].value += "extra";
    expect(columnArchiveBatch(encodeOps(ops))).toBeNull();
    expect(columnArchiveBatch(encodeOps([...f.plan.ops]))).toHaveLength(4);
  });
});

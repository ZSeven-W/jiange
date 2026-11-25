import { decodeOps, encodeOps, eqId, type Op } from "@zseven-w/collab";
import { ApiError, cancelConditionalOps, commitConditionalOps, isVerifiedConditionalStatus, queryConditionalOpsStatus, type ConditionalOpsStatus } from "@/lib/api";
import { ConditionalJournal, conditionalResolution, type ConditionalAttempt, type ConditionalObservation, type ConditionalResolution } from "@/lib/conditional-journal";
import { TITLE } from "./model";

type Transport = { send: (attempt: ConditionalAttempt, bytes: Uint8Array, signal: AbortSignal) => Promise<void>; status: (attempt: ConditionalAttempt, signal: AbortSignal) => Promise<ConditionalOpsStatus>; cancel?: (attempt: ConditionalAttempt, signal: AbortSignal) => Promise<ConditionalOpsStatus> };
type Context = { active: () => boolean; observe: () => ConditionalObservation | null };
export type AtomicFindSendResult = "sent" | "pending" | "blocked" | "occupied" | "needs_resolution";
export type AtomicFindFinishResult = ConditionalResolution | "empty" | "blocked" | "needs_finalize";
const transport: Transport = {
  send: async (attempt, batch, signal) => { await commitConditionalOps({ ...attempt, batch, signal }); },
  status: (attempt, signal) => queryConditionalOpsStatus({ docId: attempt.docId, userId: attempt.userId, requestId: attempt.requestId, signal }),
  cancel: (attempt, signal) => cancelConditionalOps({ ...attempt, signal }),
};
const safeId = (value: number) => Number.isSafeInteger(value) && value >= 0;
const tableKey = (key: string) => ["tableData", "tbl.v", "tbl.base", "tbl.rows", "tbl.cols", "tbl.m"].includes(key) || /^tbl\.c\.[A-Za-z0-9_-]{1,40}\.[A-Za-z0-9_-]{1,40}$/.test(key);

/** Disjoint from column/layout operations sharing the same durable journal. */
export function atomicFindBatchOps(bytes: Uint8Array): Op[] | null {
  try {
    const ops = decodeOps(bytes); if (!ops.length || ops.length > 100000) return null;
    const author = ops[0].id.client;
    if (!safeId(author) || author === 0) return null;
    for (const op of ops) {
      if (op.id.client !== author || !safeId(op.id.clock) || !op.id.clock || !("block" in op) || !safeId(op.block.client) || !safeId(op.block.clock) || op.block.client === 0 && op.block.clock === 0) return null;
      if (op.t === "tins") { if (!op.text || !safeId(op.parent.client) || !safeId(op.parent.clock)) return null; }
      else if (op.t === "tdel") { if (!Number.isSafeInteger(op.len) || op.len <= 0 || !safeId(op.target.client) || !safeId(op.target.clock)) return null; }
      else if (op.t === "mark") { if (eqId(op.block, TITLE)) return null; }
      else if (op.t === "bset") { if (eqId(op.block, TITLE) || !tableKey(op.key)) return null; }
      else return null;
    }
    return ops;
  } catch { return null; }
}

/** Uses the shared per-account/document journal. The caller also holds the
 * document's owner lease while an in-memory undo record awaits confirmation. */
export class AtomicFindCommit {
  constructor(private readonly journal: ConditionalJournal, private readonly context: Context, private readonly network: Transport = transport) {}
  async pendingKind(): Promise<"find" | "other" | "redacted" | "empty"> {
    return this.journal.run(async (lease) => {
      const attempt = await lease.read(); if (!attempt) return "empty";
      if (attempt.redacted) return attempt.purpose === "atomic-find" ? "redacted" : "other";
      if (attempt.purpose) return "other";
      return atomicFindBatchOps(await lease.batch(attempt)) ? "find" : "other";
    });
  }
  async redactPending(): Promise<void> {
    await this.journal.run(async (lease) => {
      const attempt = await lease.read();
      if (attempt && !attempt.redacted && !attempt.purpose && atomicFindBatchOps(await lease.batch(attempt))) await lease.redact("atomic-find");
    });
  }
  private matches(attempt: ConditionalAttempt, observation: ConditionalObservation | null): boolean {
    return !!observation && this.context.active() && observation.docId === this.journal.docId && observation.userId === this.journal.userId && observation.epoch === attempt.historyEpoch && observation.lastSeq === attempt.expectedSeq && observation.caughtUp && !observation.blocked && observation.unacked === 0;
  }
  private validStatus(attempt: ConditionalAttempt, status: ConditionalOpsStatus): boolean {
    return isVerifiedConditionalStatus(status) && status.docId === attempt.docId && status.userId === attempt.userId && status.requestId === attempt.requestId;
  }
  async start(ops: readonly Op[], epoch: number, head: number, signal: AbortSignal, stillValid: () => boolean = () => true, onSubmitting: () => void = () => {}, allowPersist = true): Promise<AtomicFindSendResult> {
    const bytes = encodeOps([...ops]); if (!atomicFindBatchOps(bytes)) throw new Error("invalid atomic find batch");
    return this.journal.run(async (lease) => {
      if (await lease.read()) return "occupied";
      const initial = this.context.observe();
      if (signal.aborted || !stillValid() || !initial || !this.context.active() || initial.docId !== this.journal.docId || initial.userId !== this.journal.userId || initial.epoch !== epoch || initial.lastSeq !== head || !initial.caughtUp || initial.blocked || initial.unacked !== 0) return "blocked";
      const attempt = await lease.prepare({ historyEpoch: epoch, expectedSeq: head, batch: bytes, allowPersist, redactInstead: !allowPersist, redactedPurpose: "atomic-find" });
      if (signal.aborted || !stillValid() || !this.matches(attempt, this.context.observe())) { await lease.discardUnsubmitted(attempt); return "blocked"; }
      const saved = attempt.redacted ? bytes : await lease.batch(attempt);
      if (signal.aborted || !stillValid() || !this.matches(attempt, this.context.observe())) { await lease.discardUnsubmitted(attempt); return "blocked"; }
      lease.markSubmitting(attempt); onSubmitting();
      try { await this.network.send(attempt, saved, signal); return "sent"; } catch { return "pending"; }
    });
  }
  async retry(signal: AbortSignal, stillValid: () => boolean = () => true, inMemoryOps?: readonly Op[]): Promise<AtomicFindSendResult> {
    return this.journal.run(async (lease) => {
      const attempt = await lease.read(); if (!attempt || !this.context.active() || signal.aborted) return "blocked";
      if (!attempt.redacted && attempt.purpose) return "occupied";
      if (attempt.redacted && (attempt.purpose !== "atomic-find" || !inMemoryOps)) return "blocked";
      const bytes = attempt.redacted ? encodeOps([...inMemoryOps!]) : await lease.batch(attempt);
      if (!atomicFindBatchOps(bytes) || attempt.redacted && !await lease.matchesBatch(attempt, bytes)) return "occupied";
      let status: ConditionalOpsStatus; try { status = await this.network.status(attempt, signal); } catch { return "pending"; }
      if (!this.validStatus(attempt, status) || !this.context.active()) return "pending";
      if (status.state !== "unknown" || status.currentEpoch !== attempt.historyEpoch || status.currentHead !== attempt.expectedSeq) return "needs_resolution";
      if (signal.aborted || !stillValid() || !this.matches(attempt, this.context.observe())) return "pending";
      try { await this.network.send(attempt, bytes, signal); return "sent"; } catch { return "pending"; }
    });
  }
  async finish(signal: AbortSignal, finalize: (attempt: ConditionalAttempt, status: ConditionalOpsStatus, observe: () => ConditionalObservation | null) => Promise<boolean>): Promise<AtomicFindFinishResult> {
    return this.journal.run(async (lease) => {
      const attempt = await lease.read(); if (!attempt) return "empty";
      if (!this.context.active() || signal.aborted || attempt.redacted && attempt.purpose !== "atomic-find" || !attempt.redacted && !!attempt.purpose) return "blocked";
      if (!attempt.redacted && !atomicFindBatchOps(await lease.batch(attempt))) return "blocked";
      let status: ConditionalOpsStatus; try { status = await this.network.status(attempt, signal); } catch { return "pending"; }
      const observed = this.context.observe();
      if (!observed || !this.context.active() || !this.validStatus(attempt, status)) return "blocked";
      const result = conditionalResolution(attempt, status, observed);
      if (result === "committed" && !await finalize(attempt, status, () => this.context.observe())) return "needs_finalize";
      if (result !== "committed" && result !== "cancelled" && result !== "not_committed") return result;
      const current = this.context.observe();
      if (!current || !this.context.active() || signal.aborted) return "pending";
      return lease.settle(status, current);
    });
  }
  /** Fence a possibly delayed submission; a committed receipt remains for normal finalization. */
  async cancel(signal: AbortSignal): Promise<AtomicFindFinishResult | "needs_resolution" | "unavailable"> {
    return this.journal.run(async (lease) => {
      const attempt = await lease.read(); if (!attempt) return "empty";
      if (!this.context.active() || signal.aborted || !this.network.cancel || attempt.redacted && attempt.purpose !== "atomic-find" || !attempt.redacted && !!attempt.purpose) return "blocked";
      if (!attempt.redacted && !atomicFindBatchOps(await lease.batch(attempt))) return "blocked";
      let status: ConditionalOpsStatus; try { status = await this.network.cancel(attempt, signal); } catch (error) { return error instanceof ApiError && error.status === 503 && error.code === "conditional_cancel_disabled" ? "unavailable" : "pending"; }
      const observed = this.context.observe();
      if (!observed || !this.context.active() || !this.validStatus(attempt, status)) return "blocked";
      const result = conditionalResolution(attempt, status, observed);
      if (result === "committed") return "needs_resolution";
      if (result !== "cancelled") return result;
      const current = this.context.observe();
      if (!current || !this.context.active() || signal.aborted) return "pending";
      return lease.settle(status, current);
    });
  }
}

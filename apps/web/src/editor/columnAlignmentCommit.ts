import { decodeOps, encodeOps, type Op } from "@jiange/collab";
import { commitConditionalOps, isVerifiedConditionalStatus, queryConditionalOpsStatus, type ConditionalOpsStatus } from "@/lib/api";
import { ConditionalJournal, conditionalResolution, type ConditionalAttempt, type ConditionalObservation, type ConditionalResolution } from "@/lib/conditionalJournal";
import { COLUMN_WIDTHS, validColumnWidths } from "./columnWidths";
import { validColumnPosition } from "./columnMove";

type AlignmentOp = Extract<Op, { t: "bset" | "bmove" }>;
type Transport = {
  send: (attempt: ConditionalAttempt, bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  status: (attempt: ConditionalAttempt, signal: AbortSignal) => Promise<ConditionalOpsStatus>;
};
export const alignmentTransport: Transport = {
  send: async (attempt, batch, signal) => { await commitConditionalOps({ ...attempt, batch, signal }); },
  status: (attempt, signal) => queryConditionalOpsStatus({ docId: attempt.docId, userId: attempt.userId, requestId: attempt.requestId, signal }),
};
type Context = { active: () => boolean; observe: () => ConditionalObservation | null };
type SendResult = "sent" | "pending" | "blocked" | "occupied" | "needs_resolution";
type FinishResult = ConditionalResolution | "empty" | "blocked" | "needs_finalize";

function columnLayoutOp(bytes: Uint8Array): AlignmentOp | null {
  try {
    const ops = decodeOps(bytes), op = ops[0];
    if (ops.length !== 1 || op.t !== "bset" && op.t !== "bmove") return null;
    if (op.t === "bset" && !(op.key === "align" && ["", "left", "center", "right"].includes(op.value) || op.key === COLUMN_WIDTHS && validColumnWidths(op.value))) return null;
    if (op.t === "bmove" && (!validColumnPosition(op.pos) || ![op.parent.client, op.parent.clock].every(Number.isSafeInteger) || op.parent.client < 0 || op.parent.clock < 0 || op.parent.client === 0 && op.parent.clock === 0 || op.parent.client === op.block.client && op.parent.clock === op.block.clock)) return null;
    if (![op.id.client, op.id.clock, op.block.client, op.block.clock].every(Number.isSafeInteger) || op.id.client <= 0 || op.id.clock <= 0 || op.block.client < 0 || op.block.clock < 0 || op.block.client === 0 && op.block.clock <= 1) return null;
    return op;
  } catch { return null; }
}

/** Persistence and retry are scoped to one document/account and one bounded layout operation. */
export class ColumnAlignmentCommit {
  constructor(private readonly journal: ConditionalJournal, private readonly context: Context, private readonly transport: Transport = alignmentTransport) {}

  async hasPending(): Promise<boolean> { return (await this.journal.read()) !== null; }

  private matches(attempt: ConditionalAttempt, observation: ConditionalObservation | null): boolean {
    return !!observation && this.context.active() && observation.docId === this.journal.docId && observation.userId === this.journal.userId && observation.epoch === attempt.historyEpoch && observation.lastSeq === attempt.expectedSeq && observation.caughtUp && !observation.blocked && observation.unacked === 0;
  }
  private validStatus(attempt: ConditionalAttempt, value: ConditionalOpsStatus): boolean {
    return isVerifiedConditionalStatus(value) && value.docId === attempt.docId && value.userId === attempt.userId && value.requestId === attempt.requestId;
  }

  /** Save the exact request before sending; an uncertain response remains recoverable. */
  async start(op: AlignmentOp, epoch: number, head: number, signal: AbortSignal, stillValid: () => boolean = () => true): Promise<SendResult> {
    const bytes = encodeOps([op]);
    if (!columnLayoutOp(bytes)) throw new Error("invalid column layout operation");
    return this.journal.run(async (lease) => {
      if (await lease.read()) return "occupied";
      const initial = this.context.observe();
      if (signal.aborted || !stillValid() || !initial || !this.context.active() || initial.docId !== this.journal.docId || initial.userId !== this.journal.userId || initial.epoch !== epoch || initial.lastSeq !== head || !initial.caughtUp || initial.blocked || initial.unacked !== 0) return "blocked";
      const attempt = await lease.prepare({ historyEpoch: epoch, expectedSeq: head, batch: bytes, allowPersist: true });
      if (signal.aborted || !stillValid() || !this.matches(attempt, this.context.observe())) { await lease.discardUnsubmitted(attempt); return "blocked"; }
      const saved = await lease.batch(attempt);
      if (signal.aborted || !stillValid() || !this.matches(attempt, this.context.observe())) { await lease.discardUnsubmitted(attempt); return "blocked"; }
      lease.markSubmitting(attempt);
      try { await this.transport.send(attempt, saved, signal); return "sent"; }
      catch { return "pending"; }
    });
  }

  /** Retry only the original bytes and request ID after confirming its status is unknown. */
  async retry(signal: AbortSignal, stillValid: () => boolean = () => true): Promise<SendResult> {
    return this.journal.run(async (lease) => {
      const attempt = await lease.read();
      if (!attempt) return "blocked";
      if (attempt.redacted || !this.context.active() || signal.aborted) return "pending";
      const bytes = await lease.batch(attempt);
      if (!columnLayoutOp(bytes)) return "occupied";
      let status: ConditionalOpsStatus;
      try { status = await this.transport.status(attempt, signal); } catch { return "pending"; }
      if (!this.validStatus(attempt, status) || !this.context.active()) return "pending";
      if (status.state !== "unknown" || status.currentEpoch !== attempt.historyEpoch || status.currentHead !== attempt.expectedSeq) return "needs_resolution";
      if (signal.aborted || !stillValid() || !this.matches(attempt, this.context.observe())) return "pending";
      try { await this.transport.send(attempt, bytes, signal); return "sent"; }
      catch { return "pending"; }
    });
  }

  /** Only clear a committed receipt after the owner has finalized its local history. */
  async finish(signal: AbortSignal, finalizeCommitted: (attempt: ConditionalAttempt) => boolean): Promise<FinishResult> {
    return this.journal.run(async (lease) => {
      const attempt = await lease.read(); if (!attempt) return "empty";
      if (attempt.redacted || !this.context.active() || signal.aborted) return "blocked";
      if (!columnLayoutOp(await lease.batch(attempt))) return "blocked";
      let status: ConditionalOpsStatus;
      try { status = await this.transport.status(attempt, signal); } catch { return "pending"; }
      const observed = this.context.observe();
      if (!observed || !this.context.active() || !this.validStatus(attempt, status)) return "blocked";
      const resolution = conditionalResolution(attempt, status, observed);
      if (resolution === "committed" && !finalizeCommitted(attempt)) return "needs_finalize";
      if (resolution !== "committed" && resolution !== "not_committed") return resolution;
      if (!this.context.active() || signal.aborted) return "pending";
      return lease.settle(status, observed);
    });
  }
}

import { decodeOps, encodeOps, type Op } from "@jiange/collab";
import { preparedColumnArchiveIsCurrent, type PreparedColumnArchive } from "@jiange/doc-sdk/column-archive-experimental";
import { ApiError, cancelConditionalOps, commitConditionalOps, isVerifiedConditionalStatus, queryConditionalOpsStatus, type ConditionalOpsStatus } from "@/lib/api";
import { ConditionalJournal, conditionalResolution, type ConditionalAttempt, type ConditionalObservation, type ConditionalResolution } from "@/lib/conditional-journal";

type Transport = {
  send: (attempt: ConditionalAttempt, bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  status: (attempt: ConditionalAttempt, signal: AbortSignal) => Promise<ConditionalOpsStatus>;
  cancel?: (attempt: ConditionalAttempt, signal: AbortSignal) => Promise<ConditionalOpsStatus>;
};
type Context = { active: () => boolean; observe: () => ConditionalObservation | null };
export type ColumnArchiveSendResult = "sent" | "pending" | "blocked" | "occupied" | "needs_resolution";
export type ColumnArchiveFinishResult = ConditionalResolution | "empty" | "blocked" | "needs_finalize" | "needs_resolution" | "unavailable";
const network: Transport = {
  send: async (attempt, batch, signal) => { await commitConditionalOps({ ...attempt, batch, signal }); },
  status: (attempt, signal) => queryConditionalOpsStatus({ docId: attempt.docId, userId: attempt.userId, requestId: attempt.requestId, signal }),
  cancel: (attempt, signal) => cancelConditionalOps({ ...attempt, signal }),
};
const safe = (n: number) => Number.isSafeInteger(n) && n > 0;
const position = (s: string) => /^[0-9A-Za-z]{1,512}$/.test(s) && !s.endsWith("0");
const same = (a: { client: number; clock: number }, b: { client: number; clock: number }) => a.client === b.client && a.clock === b.clock;
const id = (v: { client: number; clock: number }) => `${v.client}:${v.clock}`;

/** Admit only content-free archive or archive-transition operations. */
export function columnArchiveBatch(bytes: Uint8Array): Op[] | null {
  try {
    const ops = decodeOps(bytes);
    if (!ops.every((op) => safe(op.id.client) && safe(op.id.clock))) return null;
    if (ops.length === 1) {
      const op = ops[0];
      if (op.t !== "bmove" || !safe(op.block.clock) || !(safe(op.parent.clock) || op.parent.client === 0 && op.parent.clock === 0) || !Number.isSafeInteger(op.block.client) || op.block.client < 0 || !Number.isSafeInteger(op.parent.client) || op.parent.client < 0 || same(op.block, op.parent) || !position(op.pos)) return null;
      return ops;
    }
    if (ops.length !== 4) return null;
    const [create, del, metadata, move] = ops;
    if (create.t !== "bcreate" || create.parent.client !== 0 || create.parent.clock !== 0 || create.type !== "jiange-column-archive-v1" || create.pos !== "U" || del.t !== "bdel" || metadata.t !== "bset" || move.t !== "bmove" || !same(del.block, create.id) || !same(move.parent, create.id) || !same(metadata.block, move.block) || move.pos !== "U" || metadata.key !== "_column_archive_v1" || !safe(move.block.clock) || !Number.isSafeInteger(move.block.client) || move.block.client < 0) return null;
    if (ops.some((op, i) => op.id.client !== create.id.client || op.id.clock !== create.id.clock + i)) return null;
    if (!new RegExp(`^v1\\|(?:0:0|(?:0|[1-9]\\d*):[1-9]\\d*)\\|[0-9A-Za-z]{1,512}\\|${id(create.id)}$`).test(metadata.value)) return null;
    const origin = metadata.value.split("|");
    if (!position(origin[2]) || origin[1].split(":").some((part) => !Number.isSafeInteger(Number(part)))) return null;
    return ops;
  } catch { return null; }
}

/** Journal one conditional archive operation without persisting document text. */
export class ColumnArchiveCommit {
  constructor(private readonly journal: ConditionalJournal, private readonly context: Context, private readonly transport: Transport = network) {}
  async pendingKind(): Promise<"archive" | "other" | "empty"> {
    return this.journal.run(async (lease) => {
      const row = await lease.read();
      if (!row) return "empty";
      if (row.redacted || row.purpose !== "column-archive") return "other";
      return columnArchiveBatch(await lease.batch(row)) ? "archive" : "other";
    });
  }
  private matches(attempt: ConditionalAttempt, observed: ConditionalObservation | null): boolean {
    return !!observed && this.context.active() && observed.docId === this.journal.docId && observed.userId === this.journal.userId && observed.epoch === attempt.historyEpoch && observed.lastSeq === attempt.expectedSeq && observed.caughtUp && !observed.blocked && observed.unacked === 0;
  }
  private valid(attempt: ConditionalAttempt, status: ConditionalOpsStatus): boolean {
    return isVerifiedConditionalStatus(status) && status.docId === attempt.docId && status.userId === attempt.userId && status.requestId === attempt.requestId;
  }
  async start(plan: PreparedColumnArchive, epoch: number, head: number, signal: AbortSignal, stillValid: () => boolean = () => true, onSubmitting: () => void = () => {}): Promise<ColumnArchiveSendResult> {
    const bytes = encodeOps([...plan.ops]);
    if (!columnArchiveBatch(bytes)) throw new Error("invalid column archive batch");
    return this.journal.run(async (lease) => {
      if (await lease.read()) return "occupied";
      const observe = this.context.observe();
      if (signal.aborted || !stillValid() || !preparedColumnArchiveIsCurrent(plan, plan.doc) || !observe || !this.context.active() || observe.docId !== this.journal.docId || observe.userId !== this.journal.userId || observe.epoch !== epoch || observe.lastSeq !== head || !observe.caughtUp || observe.blocked || observe.unacked !== 0) return "blocked";
      const attempt = await lease.prepare({ historyEpoch: epoch, expectedSeq: head, batch: bytes, allowPersist: true, purpose: "column-archive" });
      if (signal.aborted || !stillValid() || !preparedColumnArchiveIsCurrent(plan, plan.doc) || !this.matches(attempt, this.context.observe())) { await lease.discardUnsubmitted(attempt); return "blocked"; }
      const saved = await lease.batch(attempt);
      if (signal.aborted || !stillValid() || !preparedColumnArchiveIsCurrent(plan, plan.doc) || !this.matches(attempt, this.context.observe())) { await lease.discardUnsubmitted(attempt); return "blocked"; }
      lease.markSubmitting(attempt); onSubmitting();
      try { await this.transport.send(attempt, saved, signal); return "sent"; } catch { return "pending"; }
    });
  }
  async retry(signal: AbortSignal, stillValid: () => boolean = () => true): Promise<ColumnArchiveSendResult> {
    return this.journal.run(async (lease) => {
      const attempt = await lease.read();
      if (!attempt || attempt.redacted || attempt.purpose !== "column-archive" || !this.context.active() || signal.aborted) return "blocked";
      const bytes = await lease.batch(attempt); if (!columnArchiveBatch(bytes)) return "occupied";
      let status: ConditionalOpsStatus; try { status = await this.transport.status(attempt, signal); } catch { return "pending"; }
      if (!this.valid(attempt, status) || !this.context.active()) return "pending";
      if (status.state !== "unknown" || status.currentEpoch !== attempt.historyEpoch || status.currentHead !== attempt.expectedSeq) return "needs_resolution";
      if (signal.aborted || !stillValid() || !this.matches(attempt, this.context.observe())) return "pending";
      try { await this.transport.send(attempt, bytes, signal); return "sent"; } catch { return "pending"; }
    });
  }
  async finish(signal: AbortSignal, finalize: (attempt: ConditionalAttempt, status: ConditionalOpsStatus, observe: () => ConditionalObservation | null) => Promise<boolean>): Promise<ColumnArchiveFinishResult> {
    return this.journal.run(async (lease) => {
      const attempt = await lease.read(); if (!attempt) return "empty";
      if (attempt.redacted || attempt.purpose !== "column-archive" || !this.context.active() || signal.aborted || !columnArchiveBatch(await lease.batch(attempt))) return "blocked";
      let status: ConditionalOpsStatus; try { status = await this.transport.status(attempt, signal); } catch { return "pending"; }
      const observed = this.context.observe();
      if (!observed || !this.context.active() || !this.valid(attempt, status)) return "blocked";
      const result = conditionalResolution(attempt, status, observed);
      if (result === "committed" && !await finalize(attempt, status, () => this.context.observe())) return "needs_finalize";
      if (result !== "committed" && result !== "cancelled" && result !== "not_committed") return result;
      const current = this.context.observe();
      if (!current || !this.context.active() || signal.aborted) return "pending";
      return lease.settle(status, current);
    });
  }
  async cancel(signal: AbortSignal): Promise<ColumnArchiveFinishResult> {
    return this.journal.run(async (lease) => {
      const attempt = await lease.read(); if (!attempt) return "empty";
      if (attempt.redacted || attempt.purpose !== "column-archive" || !this.transport.cancel || !this.context.active() || signal.aborted || !columnArchiveBatch(await lease.batch(attempt))) return "blocked";
      let status: ConditionalOpsStatus;
      try { status = await this.transport.cancel(attempt, signal); }
      catch (error) { return error instanceof ApiError && error.status === 503 && error.code === "conditional_cancel_disabled" ? "unavailable" : "pending"; }
      const observed = this.context.observe();
      if (!observed || !this.context.active() || !this.valid(attempt, status)) return "blocked";
      const result = conditionalResolution(attempt, status, observed);
      if (result === "committed") return "needs_resolution";
      if (result !== "cancelled") return result;
      const current = this.context.observe();
      if (!current || !this.context.active() || signal.aborted) return "pending";
      return lease.settle(status, current);
    });
  }
}

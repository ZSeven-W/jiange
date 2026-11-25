import { decodeOps, encodeOps, type Op } from "@zseven-w/collab";
import { conditionalBatchBase64, isVerifiedConditionalStatus, type ConditionalOpsStatus } from "./api";

type LockProvider = Pick<LockManager, "request">;
export type ConditionalJournalEnvironment = { storage: Storage; locks?: LockProvider; random: () => string; digest: (bytes: Uint8Array) => Promise<Uint8Array> };
type AttemptBase = { version: 1; docId: number; userId: number; requestId: string; historyEpoch: number; expectedSeq: number; opCount: number; clientId: number; digest: string };
export type ConditionalAttempt = AttemptBase & ({ batch: string; redacted?: never; purpose?: "column-archive" } | { redacted: true; batch?: never; purpose?: "atomic-find" });
export type ConditionalResolution = "committed" | "cancelled" | "not_committed" | "pending" | "history_changed" | "mismatch";
export type ConditionalObservation = { docId: number; userId: number; epoch: number | null; lastSeq: number; caughtUp: boolean; blocked: string | null; unacked: number };

const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const requestPattern = /^[0-9a-f]{32}$/;
const digestPattern = /^[0-9a-f]{64}$/;
export const conditionalJournalStorageKey = (user: number, doc: number) => `jiange:conditional-ops:v1:${user}:${doc}`;

function decodeBatch(value: string): Uint8Array {
  if (value.length > Math.ceil((8 << 20) / 3) * 4) throw new Error("invalid conditional batch");
  const binary = atob(value), result = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (!result.length || result.length > (8 << 20) || conditionalBatchBase64(result) !== value) throw new Error("invalid conditional batch");
  return result;
}

function inspectBatch(batch: Uint8Array): { ops: Op[]; clientId: number } {
  if (!batch.length || batch.length > (8 << 20)) throw new Error("invalid conditional batch");
  const ops = decodeOps(batch), canonical = encodeOps(ops);
  if (!ops.length || ops.length > 100000 || canonical.length !== batch.length || canonical.some((value, i) => value !== batch[i])) throw new Error("invalid conditional batch");
  const clientId = ops[0].id.client;
  if (!safe(clientId) || clientId <= 0 || ops.some((op) => op.id.client !== clientId || !safe(op.id.clock) || op.id.clock <= 0)) throw new Error("invalid conditional author");
  return { ops, clientId };
}

/** Matches the server's SHA-256 over epoch, head and canonical single-op frames. */
export async function conditionalOpsDigest(historyEpoch: number, expectedSeq: number, batch: Uint8Array, digest: ConditionalJournalEnvironment["digest"]): Promise<{ digest: string; opCount: number; clientId: number }> {
  if (!safe(historyEpoch) || historyEpoch <= 0 || !safe(expectedSeq) || expectedSeq < 0) throw new Error("invalid conditional version");
  const { ops, clientId } = inspectBatch(batch), parts = ops.map((op) => encodeOps([op]));
  if (expectedSeq + ops.length > Number.MAX_SAFE_INTEGER) throw new Error("invalid conditional version");
  const bytes = parts.reduce((sum, part) => sum + part.length, 0);
  if (bytes > (8 << 20)) throw new Error("conditional batch too large");
  const buffer = new ArrayBuffer(24 + parts.length * 24 + bytes), view = new DataView(buffer), output = new Uint8Array(buffer);
  let offset = 0;
  const put = (value: number) => { view.setBigUint64(offset, BigInt(value), false); offset += 8; };
  put(historyEpoch); put(expectedSeq); put(ops.length);
  for (let i = 0; i < ops.length; i++) { put(ops[i].id.client); put(ops[i].id.clock); put(parts[i].length); output.set(parts[i], offset); offset += parts[i].length; }
  const hash = await digest(output);
  if (!(hash instanceof Uint8Array) || hash.length !== 32) throw new Error("secure digest unavailable");
  return { digest: Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join(""), opCount: ops.length, clientId };
}

export function browserConditionalJournalEnvironment(): ConditionalJournalEnvironment {
  if (!globalThis.crypto?.subtle) throw new Error("secure digest unavailable");
  return { storage: window.localStorage, locks: navigator.locks, random: () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join(""), digest: async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)) };
}

async function parseAttempt(raw: string, docId: number, userId: number, digest: ConditionalJournalEnvironment["digest"]): Promise<ConditionalAttempt> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("damaged conditional attempt");
  const a = value as ConditionalAttempt;
  const allowed = new Set(["version", "docId", "userId", "requestId", "historyEpoch", "expectedSeq", "opCount", "clientId", "digest", "batch", "redacted", "purpose"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || a.version !== 1 || a.docId !== docId || a.userId !== userId || typeof a.requestId !== "string" || !requestPattern.test(a.requestId) || !safe(a.historyEpoch) || a.historyEpoch <= 0 || !safe(a.expectedSeq) || a.expectedSeq < 0 || !safe(a.opCount) || a.opCount <= 0 || a.opCount > 100000 || a.expectedSeq + a.opCount > Number.MAX_SAFE_INTEGER || !safe(a.clientId) || a.clientId <= 0 || typeof a.digest !== "string" || !digestPattern.test(a.digest)) throw new Error("damaged conditional attempt");
  if (a.redacted === true) { if (a.batch !== undefined || a.purpose !== undefined && a.purpose !== "atomic-find") throw new Error("damaged conditional attempt"); return Object.freeze({ ...a }); }
  if (a.redacted !== undefined || a.purpose !== undefined && a.purpose !== "column-archive" || typeof a.batch !== "string") throw new Error("damaged conditional attempt");
  const proof = await conditionalOpsDigest(a.historyEpoch, a.expectedSeq, decodeBatch(a.batch), digest);
  if (proof.digest !== a.digest || proof.opCount !== a.opCount || proof.clientId !== a.clientId) throw new Error("damaged conditional attempt");
  return Object.freeze({ ...a });
}

/** Determine what a receipt proves; never treat a same-head unknown as failure. */
export function conditionalResolution(attempt: ConditionalAttempt, status: ConditionalOpsStatus, observed: ConditionalObservation): ConditionalResolution {
  if (!isVerifiedConditionalStatus(status) || status.docId !== attempt.docId || status.userId !== attempt.userId || status.requestId !== attempt.requestId || !safe(status.currentEpoch) || status.currentEpoch <= 0 || !safe(status.currentHead) || status.currentHead < 0) return "mismatch";
  if (status.currentEpoch !== attempt.historyEpoch || status.state === "history_changed") return "history_changed";
  if (status.state === "cancelled") {
    if (status.historyEpoch !== attempt.historyEpoch || status.expectedSeq !== attempt.expectedSeq || status.firstSeq !== attempt.expectedSeq + 1 || status.opCount !== attempt.opCount || status.clientId !== attempt.clientId || status.digest !== attempt.digest) return "mismatch";
    return observed.docId === attempt.docId && observed.userId === attempt.userId && observed.epoch === attempt.historyEpoch && observed.caughtUp && !observed.blocked && observed.unacked === 0 ? "cancelled" : "pending";
  }
  // A redacted record no longer has the bytes needed to authenticate its base
  // metadata; only a matching server receipt can settle it automatically.
  if (status.state === "unknown") return !attempt.redacted && status.currentHead > attempt.expectedSeq ? "not_committed" : "pending";
  if (status.state !== "committed") return "mismatch";
  if (status.historyEpoch !== attempt.historyEpoch || status.expectedSeq !== attempt.expectedSeq || status.firstSeq !== attempt.expectedSeq + 1 || status.opCount !== attempt.opCount || status.digest !== attempt.digest || status.currentHead < attempt.expectedSeq + attempt.opCount) return "mismatch";
  return observed.docId === attempt.docId && observed.userId === attempt.userId && observed.epoch === attempt.historyEpoch && observed.caughtUp && !observed.blocked && observed.unacked === 0 && safe(observed.lastSeq) && observed.lastSeq >= attempt.expectedSeq + attempt.opCount ? "committed" : "pending";
}

/** One document/account lease prevents another tab from replacing this attempt.
 * Callers must separately verify the current account and document permissions. */
export class ConditionalJournal {
  private readonly key: string;
  constructor(private readonly env: ConditionalJournalEnvironment, readonly docId: number, readonly userId: number) {
    if (!safe(docId) || docId <= 0 || !safe(userId) || userId <= 0) throw new Error("invalid conditional scope");
    this.key = conditionalJournalStorageKey(userId, docId);
  }

  async read(): Promise<ConditionalAttempt | null> {
    const raw = this.env.storage.getItem(this.key); if (raw === null) return null;
    const attempt = await parseAttempt(raw, this.docId, this.userId, this.env.digest);
    if (this.env.storage.getItem(this.key) !== raw) throw new Error("conditional attempt changed");
    return attempt;
  }

  async run<T>(action: (lease: ConditionalJournalLease) => Promise<T>): Promise<T> {
    if (!this.env.locks) throw new Error("conditional lock unavailable");
    return this.env.locks.request(this.key, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("conditional attempt is active in another tab");
      const lease = new ConditionalJournalLease(this.env, this.key, this.docId, this.userId);
      try { return await action(lease); } finally { lease.close(); }
    });
  }
}

export class ConditionalJournalLease {
  private active = true;
  private preparedHere: ConditionalAttempt | null = null;
  constructor(private readonly env: ConditionalJournalEnvironment, private readonly key: string, private readonly docId: number, private readonly userId: number) {}
  close() { this.active = false; }
  private ensure() { if (!this.active) throw new Error("conditional lease expired"); }
  private async row(): Promise<{ raw: string; attempt: ConditionalAttempt } | null> {
    this.ensure(); const raw = this.env.storage.getItem(this.key); if (raw === null) return null;
    const attempt = await parseAttempt(raw, this.docId, this.userId, this.env.digest);
    this.ensure(); if (this.env.storage.getItem(this.key) !== raw) throw new Error("conditional attempt changed");
    return { raw, attempt };
  }
  async read(): Promise<ConditionalAttempt | null> { return (await this.row())?.attempt ?? null; }
  async prepare(input: { historyEpoch: number; expectedSeq: number; batch: Uint8Array; allowPersist: boolean; purpose?: "column-archive"; redactInstead?: boolean; redactedPurpose?: "atomic-find" }): Promise<ConditionalAttempt> {
    this.ensure(); if (!input.allowPersist && !input.redactInstead) throw new Error("conditional persistence forbidden");
    if (input.purpose && (!input.allowPersist || input.redactInstead || input.redactedPurpose)) throw new Error("invalid conditional purpose");
    if (this.env.storage.getItem(this.key) !== null) throw new Error("conditional attempt already exists");
    const requestId = this.env.random(); if (!requestPattern.test(requestId)) throw new Error("secure random unavailable");
    const batch = Uint8Array.from(input.batch), proof = await conditionalOpsDigest(input.historyEpoch, input.expectedSeq, batch, this.env.digest);
    this.ensure(); if (this.env.storage.getItem(this.key) !== null) throw new Error("conditional attempt already exists");
    const raw = JSON.stringify({ version: 1, docId: this.docId, userId: this.userId, requestId, historyEpoch: input.historyEpoch, expectedSeq: input.expectedSeq, ...proof, ...(input.allowPersist ? { batch: conditionalBatchBase64(batch), ...(input.purpose ? { purpose: input.purpose } : {}) } : { redacted: true, ...(input.redactedPurpose ? { purpose: input.redactedPurpose } : {}) }) });
    this.env.storage.setItem(this.key, raw);
    if (this.env.storage.getItem(this.key) !== raw) throw new Error("conditional attempt could not be persisted");
    const saved = await this.row();
    if (!saved || saved.raw !== raw) throw new Error("conditional attempt changed");
    this.preparedHere = saved.attempt;
    return saved.attempt;
  }
  /** Only the lease that just created an attempt may discard it before any send begins. */
  async discardUnsubmitted(attempt: ConditionalAttempt): Promise<void> {
    this.ensure();
    if (this.preparedHere !== attempt) throw new Error("attempt is not an unsubmitted preparation");
    const row = await this.row();
    if (!row || this.preparedHere !== attempt || JSON.stringify(row.attempt) !== JSON.stringify(attempt)) throw new Error("conditional attempt changed");
    this.ensure(); if (this.env.storage.getItem(this.key) !== row.raw) throw new Error("conditional attempt changed");
    this.env.storage.removeItem(this.key);
    if (this.env.storage.getItem(this.key) !== null) throw new Error("conditional attempt could not be cleared");
    this.preparedHere = null;
  }
  /** Seal the preparation before initiating transport; afterward its result is always treated as uncertain. */
  markSubmitting(attempt: ConditionalAttempt): void {
    this.ensure();
    if (this.preparedHere !== attempt) throw new Error("attempt is not an unsubmitted preparation");
    this.preparedHere = null;
  }
  async redact(purpose?: "atomic-find"): Promise<ConditionalAttempt | null> {
    const row = await this.row(); if (!row || row.attempt.redacted) return row?.attempt ?? null;
    if (row.attempt.purpose) throw new Error("cannot redact this conditional attempt");
    const { raw, attempt } = row, { batch: _batch, ...rest } = attempt;
    this.ensure(); if (this.env.storage.getItem(this.key) !== raw) throw new Error("conditional attempt changed");
    const redacted = JSON.stringify({ ...rest, redacted: true, ...(purpose ? { purpose } : {}) });
    this.env.storage.setItem(this.key, redacted);
    if (this.env.storage.getItem(this.key) !== redacted) throw new Error("conditional attempt could not be redacted");
    const saved = await this.row();
    if (!saved || saved.raw !== redacted) throw new Error("conditional attempt changed");
    return saved.attempt;
  }
  async settle(status: ConditionalOpsStatus, observed: ConditionalObservation): Promise<ConditionalResolution> {
    const row = await this.row(); if (!row) return "mismatch";
    const { raw, attempt } = row, outcome = conditionalResolution(attempt, status, observed);
    if (outcome !== "committed" && outcome !== "cancelled" && outcome !== "not_committed") return outcome;
    this.ensure(); if (this.env.storage.getItem(this.key) !== raw) throw new Error("conditional attempt changed");
    this.env.storage.removeItem(this.key);
    if (this.env.storage.getItem(this.key) !== null) throw new Error("conditional attempt could not be cleared");
    return outcome;
  }
  async batch(attempt: ConditionalAttempt): Promise<Uint8Array> {
    const row = await this.row();
    if (!row || JSON.stringify(row.attempt) !== JSON.stringify(attempt)) throw new Error("conditional attempt changed");
    if (row.attempt.redacted) throw new Error("redacted conditional attempt cannot be resent");
    return decodeBatch(row.attempt.batch);
  }
  /** Authenticate an in-memory batch against a redacted durable record. */
  async matchesBatch(attempt: ConditionalAttempt, bytes: Uint8Array): Promise<boolean> {
    const row = await this.row();
    if (!row || JSON.stringify(row.attempt) !== JSON.stringify(attempt)) return false;
    const proof = await conditionalOpsDigest(attempt.historyEpoch, attempt.expectedSeq, bytes, this.env.digest);
    this.ensure();
    if (this.env.storage.getItem(this.key) !== row.raw) throw new Error("conditional attempt changed");
    return proof.digest === attempt.digest && proof.clientId === attempt.clientId && proof.opCount === attempt.opCount;
  }
}

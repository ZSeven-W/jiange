export type RecordCommentAttempt = {
  version: 1; baseId: number; recordId: number; userId: number; mutationId: string;
  body: string; mentions: number[]; parentId?: number;
};
type Environment = { storage: Storage; locks?: Pick<LockManager, "request">; random: () => string };
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const validMutation = (n: unknown): n is string => typeof n === "string" && /^[a-f0-9]{32}$/.test(n);
const prefix = (user: number, base: number, record: number) => `jiange:record-comment-attempt:v1:${user}:${base}:${record}:`;
const confirmationPrefix = (user: number, base: number, record: number) => `jiange:record-comment-confirmation:v1:${user}:${base}:${record}:`;

export function browserRecordAttemptEnvironment(): Environment {
  return { storage: window.localStorage, locks: navigator.locks, random: () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("") };
}

function parse(raw: string, key: string, user: number, base: number, record: number): RecordCommentAttempt {
  const attempt: unknown = JSON.parse(raw);
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) throw new Error("invalid attempt");
  const a = attempt as RecordCommentAttempt;
  if (a.version !== 1 || a.userId !== user || a.baseId !== base || a.recordId !== record || !validMutation(a.mutationId) || key !== prefix(user, base, record) + a.mutationId || typeof a.body !== "string" || !a.body.trim() || [...a.body].length > 2000 || /\p{Surrogate}/u.test(a.body) || !Array.isArray(a.mentions) || a.mentions.length > 20 || a.mentions.some((id) => !positive(id)) || (a.parentId !== undefined && !positive(a.parentId))) throw new Error("invalid attempt");
  return a;
}

/** One immutable request is saved before sending; retries reuse its ID and body. */
export class RecordCommentAttemptStore {
  private owned = new Set<string>();
  private listeners = new Set<() => void>();
  private readonly keyPrefix: string;
  constructor(private env: Environment, private user: number, private base: number, private record: number) {
    if (![user, base, record].every(positive)) throw new Error("invalid attempt scope");
    this.keyPrefix = prefix(user, base, record);
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  /** Publish a content-free receipt before removing the pending request. */
  confirm(attempt: RecordCommentAttempt, state: "committed" | "deleted"): void {
    const key = this.keyPrefix + attempt.mutationId;
    const raw = this.env.storage.getItem(key);
    if (raw === null || JSON.stringify(parse(raw, key, this.user, this.base, this.record)) !== JSON.stringify(attempt)) throw new Error("attempt changed or missing");
    const receiptKey = confirmationPrefix(this.user, this.base, this.record) + attempt.mutationId;
    const receipt = JSON.stringify({ version: 1, userId: this.user, baseId: this.base, recordId: this.record, mutationId: attempt.mutationId, state });
    const previous = this.env.storage.getItem(receiptKey);
    if (previous !== null && previous !== receipt) {
      if (!this.isConfirmed(attempt.mutationId)) throw new Error("confirmation changed");
      const old = JSON.parse(previous) as { state: string };
      if (old.state !== "committed" || state !== "deleted") throw new Error("confirmation changed");
    }
    this.env.storage.setItem(receiptKey, receipt);
    if (this.env.storage.getItem(receiptKey) !== receipt) throw new Error("confirmation could not be saved");
    this.changed();
  }
  isConfirmed(mutationId: string): boolean {
    if (!validMutation(mutationId)) throw new Error("invalid attempt id");
    const raw = this.env.storage.getItem(confirmationPrefix(this.user, this.base, this.record) + mutationId);
    if (raw === null) return false;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("invalid confirmation");
    const receipt = value as Record<string, unknown>;
    if (receipt.version !== 1 || receipt.userId !== this.user || receipt.baseId !== this.base || receipt.recordId !== this.record || receipt.mutationId !== mutationId || (receipt.state !== "committed" && receipt.state !== "deleted")) throw new Error("invalid confirmation");
    return true;
  }
  list(): { attempts: RecordCommentAttempt[]; damaged: number } {
    const attempts: RecordCommentAttempt[] = []; let damaged = 0;
    for (let i = 0; i < this.env.storage.length; i++) {
      const key = this.env.storage.key(i); if (!key?.startsWith(this.keyPrefix)) continue;
      const raw = this.env.storage.getItem(key); if (raw === null) continue;
      try { attempts.push(parse(raw, key, this.user, this.base, this.record)); } catch { damaged++; }
    }
    return { attempts, damaged };
  }
  prepare(body: string, mentions: number[], parentId?: number): RecordCommentAttempt {
    const mutationId = this.env.random(); if (!validMutation(mutationId)) throw new Error("secure random unavailable");
    const key = this.keyPrefix + mutationId; if (this.env.storage.getItem(key) !== null) throw new Error("attempt id already exists");
    const raw = JSON.stringify({ version: 1, userId: this.user, baseId: this.base, recordId: this.record, mutationId, body, mentions, ...(parentId === undefined ? {} : { parentId }) });
    const attempt = parse(raw, key, this.user, this.base, this.record);
    this.env.storage.setItem(key, raw); if (this.env.storage.getItem(key) !== raw) throw new Error("attempt could not be saved");
    this.owned.add(mutationId); this.changed(); return attempt;
  }
  async run<T>(attempt: RecordCommentAttempt, send: (attempt: RecordCommentAttempt) => Promise<T>): Promise<{ value: T; cleaned: boolean }> {
    const key = this.keyPrefix + attempt.mutationId; const raw = this.env.storage.getItem(key);
    if (raw === null || JSON.stringify(parse(raw, key, this.user, this.base, this.record)) !== JSON.stringify(attempt)) throw new Error("attempt changed or missing");
    const execute = async (mayRemove: boolean) => {
      const value = await send(parse(raw, key, this.user, this.base, this.record)); let cleaned = false;
      try { if (mayRemove && this.env.storage.getItem(key) === raw) { this.env.storage.removeItem(key); cleaned = this.env.storage.getItem(key) === null; if (cleaned) this.changed(); } } catch { /* keep the confirmed receipt for later inspection */ }
      return { value, cleaned };
    };
    if (!this.env.locks) return execute(this.owned.has(attempt.mutationId));
    return this.env.locks.request(key, { ifAvailable: true }, async (lock) => { if (!lock || this.env.storage.getItem(key) !== raw) throw new Error("attempt is active or changed"); return execute(true); });
  }
  /** Serializes new attempts across tabs when Web Locks are available. */
  async prepareAndRun<T>(body: string, mentions: number[], parentId: number | undefined, send: (attempt: RecordCommentAttempt) => Promise<T>): Promise<{ value: T; cleaned: boolean }> {
    const run = async () => {
      const list = this.list();
      if (list.damaged || list.attempts.some((a) => a.body === body && (a.parentId ?? null) === (parentId ?? null))) throw new Error("an unresolved attempt already exists");
      return this.run(this.prepare(body, mentions, parentId), send);
    };
    if (!this.env.locks) return run();
    return this.env.locks.request(`${this.keyPrefix}submit`, { ifAvailable: true }, async (lock) => { if (!lock) throw new Error("another tab is submitting"); return run(); });
  }
}

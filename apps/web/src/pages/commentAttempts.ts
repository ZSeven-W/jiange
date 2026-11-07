/** Durable, immutable comment attempts.  A request that may have reached the
 * server is never replaced with a new id or reconstructed from a later draft. */
export type CommentAttemptPayload = {
  body: string;
  mentions: number[];
  parentId?: number;
  block?: string;
  startChar?: string;
  endChar?: string;
  quote?: string;
};
export type CommentAttempt = {
  version: 1;
  docId: number;
  userId: number;
  mutationId: string;
  payload: CommentAttemptPayload;
  /** Protected quote was removed after permission loss; only status lookup is safe. */
  redacted?: true;
};

type AttemptEnvironment = {
  storage: Storage;
  locks?: Pick<LockManager, "request">;
  random: () => string;
};
type AttemptRow = { attempt: CommentAttempt; key: string; raw: string };
const prefix = (doc: number, user: number) => `jiange:comment-attempt:v1:${user}:${doc}:`;
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

function parseAttempt(raw: string, doc: number, user: number, key: string): CommentAttempt {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid comment attempt");
  const a = value as CommentAttempt;
  if (a.version !== 1 || a.docId !== doc || a.userId !== user || !validId(a.mutationId) || key !== prefix(doc, user) + a.mutationId) throw new Error("invalid comment attempt");
  const p = a.payload;
  if (!p || typeof p !== "object" || Array.isArray(p) || typeof p.body !== "string" || !p.body.trim() || !Array.isArray(p.mentions) || p.mentions.some((n) => !positive(n)) || (p.parentId !== undefined && !positive(p.parentId))) throw new Error("invalid comment attempt");
  for (const field of ["block", "startChar", "endChar", "quote"] as const) if (p[field] !== undefined && typeof p[field] !== "string") throw new Error("invalid comment attempt");
  if (a.redacted !== undefined && a.redacted !== true || a.redacted && p.quote !== undefined) throw new Error("invalid comment attempt");
  // Preserve the exact original JSON.  Do not infer mentions or quote from the
  // current document when this payload is retried.
  return a;
}

export function browserCommentAttemptEnvironment(): AttemptEnvironment {
  return { storage: window.localStorage, locks: navigator.locks, random: () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  } };
}

/** The store never clears a different live tab's record without its lock. */
export class CommentAttemptStore {
  private owned = new Set<string>();
  private listeners = new Set<() => void>();
  constructor(private env: AttemptEnvironment, private doc: number, private user: number) {
    if (!positive(doc) || !positive(user)) throw new Error("invalid attempt scope");
  }
  belongsTo(user: number): boolean { return this.user === user; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed(): void { for (const listener of this.listeners) listener(); }

  prepare(payload: CommentAttemptPayload): CommentAttempt {
    const mutationId = this.env.random();
    if (!validId(mutationId)) throw new Error("secure random unavailable");
    const key = prefix(this.doc, this.user) + mutationId;
    if (this.env.storage.getItem(key) !== null) throw new Error("attempt id already exists");
    // Roundtrip removes references to caller-owned arrays/objects. No mutable
    // composer state is subsequently used to retry this attempt.
    const raw = JSON.stringify({ version: 1, docId: this.doc, userId: this.user, mutationId, payload });
    const attempt = parseAttempt(raw, this.doc, this.user, key);
    this.env.storage.setItem(key, raw);
    if (this.env.storage.getItem(key) !== raw) throw new Error("attempt could not be persisted");
    this.owned.add(mutationId);
    this.changed();
    return attempt;
  }

  list(): { attempts: CommentAttempt[]; damaged: number } {
    const rows = this.rows();
    return { attempts: rows.valid.map((row) => row.attempt), damaged: rows.damaged };
  }

  private rows(): { valid: AttemptRow[]; damaged: number } {
    const valid: AttemptRow[] = [];
    let damaged = 0;
    const p = prefix(this.doc, this.user);
    for (let i = 0; i < this.env.storage.length; i++) {
      const key = this.env.storage.key(i);
      if (!key || !key.startsWith(p)) continue;
      const raw = this.env.storage.getItem(key);
      if (raw === null) continue;
      try { valid.push({ key, raw, attempt: parseAttempt(raw, this.doc, this.user, key) }); }
      catch { damaged++; }
    }
    return { valid, damaged };
  }

  /** Remove quoted document content without turning the record into a
   * different request. A redacted attempt may only query its server receipt. */
  async redactQuotes(): Promise<boolean> {
    let complete = true;
    const rows = this.rows();
    if (rows.damaged) complete = false;
    for (const row of rows.valid) {
      if (!row.attempt.payload.quote) continue;
      const redact = () => {
        if (this.env.storage.getItem(row.key) !== row.raw) { complete = false; return; }
        const { quote: _quote, ...payload } = row.attempt.payload;
        const raw = JSON.stringify({ ...row.attempt, payload, redacted: true });
        this.env.storage.setItem(row.key, raw);
        if (this.env.storage.getItem(row.key) !== raw) complete = false;
        else this.changed();
      };
      try {
        if (this.env.locks) {
          await this.env.locks.request(row.key, { ifAvailable: true }, async (lock) => { if (lock) redact(); else complete = false; });
        } else if (this.owned.has(row.attempt.mutationId)) redact();
        else complete = false;
      } catch { complete = false; }
    }
    return complete;
  }

  /** Senders use the same immutable payload; lock prevents simultaneous local
   * cleanup, while the server's idempotency key handles cross-tab races. */
  async run<T>(attempt: CommentAttempt, action: (stored: CommentAttempt) => Promise<T>): Promise<{ value: T; cleaned: boolean }> {
    const key = prefix(this.doc, this.user) + attempt.mutationId;
    const raw = this.env.storage.getItem(key);
    if (raw === null || JSON.stringify(parseAttempt(raw, this.doc, this.user, key)) !== JSON.stringify(attempt)) throw new Error("attempt changed or missing");
    const execute = async (mayRemove: boolean) => {
      const value = await action(parseAttempt(raw, this.doc, this.user, key));
      // A confirmed server receipt is the only reason to clear an attempt.
      // Without Web Locks a recovered record can belong to another live tab.
      let cleaned = false;
      try {
        if (mayRemove && this.env.storage.getItem(key) === raw) {
          this.env.storage.removeItem(key);
          cleaned = this.env.storage.getItem(key) === null;
          if (cleaned) this.changed();
        }
      } catch { /* Server confirmation is still valid; retain the record. */ }
      return { value, cleaned };
    };
    if (!this.env.locks) return execute(this.owned.has(attempt.mutationId));
    return this.env.locks.request(key, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("attempt is active in another tab");
      // Check again after lock acquisition: another tab may have confirmed it.
      if (this.env.storage.getItem(key) !== raw) throw new Error("attempt changed or missing");
      return execute(true);
    });
  }
}

/** Block a second implicit submission of the same unresolved draft even if the
 * current member directory or redaction policy has changed in the meantime. */
export function matchesUnresolvedDraft(attempt: CommentAttempt, payload: CommentAttemptPayload): boolean {
  const a = attempt.payload;
  return a.body === payload.body && (a.parentId ?? null) === (payload.parentId ?? null) && (a.block ?? "") === (payload.block ?? "") && (a.startChar ?? "") === (payload.startChar ?? "") && (a.endChar ?? "") === (payload.endChar ?? "");
}

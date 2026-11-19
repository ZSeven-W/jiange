import { decodeOps, encodeOps, type Op } from "@jiange/collab";

export interface PendingOpsDraft { clientId: number; ops: Op[]; blocked?: string | null; historyEpoch?: number | null }
export interface PendingSession { key: string; draft: PendingOpsDraft | null; legacy: boolean; otherDrafts: boolean; corrupt: boolean; release: () => Promise<void> }

type LockProvider = Pick<LockManager, "request">;
export interface StorageEnvironment { local: Storage; session: Storage; locks?: LockProvider }

/** Serialize same-account/document session lifetimes inside one page process. */
export class PendingSessionQueue {
  private readonly tails = new Map<string, Promise<void>>();
  reserve(userId: number, docId: number): { ready: Promise<void>; release: () => void } {
    const key = `${userId}:${docId}`, ready = this.tails.get(key) ?? Promise.resolve();
    let finish!: () => void, released = false;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const tail = ready.catch(() => {}).then(() => finished);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return { ready, release: () => { if (!released) { released = true; finish(); } } };
  }
}
export const pendingSessionQueue = new PendingSessionQueue();
const base = (userId: number, docId: number) => `jiange:pending:v3:${userId}:${docId}:`;
export const pendingOpsKey = (userId: number, docId: number, token: string) => base(userId, docId) + token;
const v2Key = (userId: number, docId: number) => `jiange:pending:v2:${userId}:${docId}`;
const recoveryBase = (userId: number, docId: number) => `jiange:recovery:v1:${userId}:${docId}:`;

function parse(raw: string | null): PendingOpsDraft | null {
  if (raw === null) return null;
  const draft = JSON.parse(raw) as PendingOpsDraft;
  if (!Number.isSafeInteger(draft?.clientId) || draft.clientId < 1 || !Array.isArray(draft.ops) || (draft.blocked != null && typeof draft.blocked !== "string") || (draft.historyEpoch != null && (!Number.isSafeInteger(draft.historyEpoch) || draft.historyEpoch < 1))) throw new Error("invalid saved operations");
  // JSON cannot preserve Uint8Array. Accept both the current byte array and
  // the older numeric-key object representation, without discarding raw data
  // if the payload is malformed or exceeds the protocol's per-op limit.
  draft.ops = draft.ops.map((op) => {
    if (op?.t !== "ttable") return op;
    const rawPayload: unknown = op.payload;
    let bytes: unknown[];
    if (Array.isArray(rawPayload)) bytes = rawPayload;
    else if (rawPayload && typeof rawPayload === "object") {
      const entries = Object.entries(rawPayload);
      if (entries.some(([key], index) => key !== String(index))) throw new Error("invalid table payload");
      bytes = entries.map(([, value]) => value);
    } else throw new Error("invalid table payload");
    if (!bytes.length || bytes.length > 512 || bytes.some((value) => !Number.isInteger(value) || (value as number) < 0 || (value as number) > 255)) throw new Error("invalid table payload");
    return { ...op, payload: Uint8Array.from(bytes as number[]) };
  });
  // JSON shape must round-trip through the wire codec exactly. Merely checking
  // that ops is an array lets corrupt entries throw later during WELCOME replay.
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  if (JSON.stringify(canonical(decodeOps(encodeOps(draft.ops)))) !== JSON.stringify(canonical(draft.ops))) throw new Error("invalid saved operations");
  return draft.ops.length ? draft : null;
}
function accountKeys(storage: Storage, userId: number, docId: number): string[] {
  const prefix = base(userId, docId), v2 = v2Key(userId, docId), keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && (key.startsWith(prefix) || key === v2)) keys.push(key);
  }
  return keys.sort();
}
/** Exports only account-scoped keys; never reads the old unowned key. */
export function readAccountDraftBackups(storage: Storage, userId: number, docId: number): { key: string; raw: string }[] {
  return [...accountKeys(storage, userId, docId), ...recoveryDraftKeys(storage, userId, docId)].flatMap((key) => {
    const raw = storage.getItem(key);
    return raw === null ? [] : [{ key, raw }];
  });
}

/** Recovery copies are never selected for automatic replay. */
export function recoveryDraftKeys(storage: Storage, userId: number, docId: number): string[] {
  const prefix = recoveryBase(userId, docId), result: string[] = [];
  for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(prefix)) result.push(key); }
  return result.sort();
}

/** Persist and read back an account-scoped copy before the active queue is cleared. */
export function archivePendingDraft(storage: Storage, userId: number, docId: number, token: string, draft: PendingOpsDraft): string {
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(docId) || docId < 1 || !/^[a-zA-Z0-9-]{16,100}$/.test(token) || !draft.ops.length) throw new Error("invalid recovery draft");
  const key = recoveryBase(userId, docId) + token;
  if (storage.getItem(key) !== null) throw new Error("recovery draft already exists");
  const raw = JSON.stringify({ ...draft, version: 1, userId, docId, ops: draft.ops.map((op) => op.t === "ttable" ? { ...op, payload: Array.from(op.payload) } : op) });
  // Validate the exact stored representation before depending on it.
  if (!parse(raw)) throw new Error("invalid recovery draft");
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("recovery draft could not be verified");
  return key;
}

export function readRecoveryDraft(storage: Storage, userId: number, docId: number, key: string): PendingOpsDraft | null {
  if (!key.startsWith(recoveryBase(userId, docId))) return null;
  const raw = storage.getItem(key); if (raw === null) return null;
  const metadata: unknown = JSON.parse(raw);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || (metadata as { version?: unknown }).version !== 1 || (metadata as { userId?: unknown }).userId !== userId || (metadata as { docId?: unknown }).docId !== docId) throw new Error("invalid recovery draft scope");
  return parse(raw);
}

/** Delete only the account/document copy the user confirmed, if it is unchanged. */
export function removeRecoveryDraft(storage: Storage, userId: number, docId: number, key: string, expectedRaw: string): boolean {
  if (!key.startsWith(recoveryBase(userId, docId)) || storage.getItem(key) !== expectedRaw) return false;
  storage.removeItem(key);
  return storage.getItem(key) === null;
}
export function writePendingOps(storage: Storage, key: string, draft: PendingOpsDraft | null): void {
  if (draft?.ops.length) storage.setItem(key, JSON.stringify({ ...draft, ops: draft.ops.map((op) => op.t === "ttable" ? { ...op, payload: Array.from(op.payload) } : op) }));
  else storage.removeItem(key);
}

/** Defer browser storage getters so synchronous SecurityError becomes a rejection. */
export function prepareBrowserPendingSession(getEnvironment: () => StorageEnvironment, userId: number, docId: number, random: () => string): Promise<PendingSession> {
  return Promise.resolve().then(() => {
    const { local, session, locks } = getEnvironment();
    const effectiveLocks = locks ?? createStorageLeaseLockProvider(local, random());
    return preparePendingSession(local, session, effectiveLocks, userId, docId, random);
  });
}

const LEASE_PREFIX = "jiange:pending-lease:v1:";
const DEFAULT_LEASE_TTL_MS = 15_000;

/**
 * Fallback LockProvider backed by localStorage heartbeat leases for browsers
 * without Web Locks (e.g. non-HTTPS LAN / embedded WebViews). Leases expire
 * automatically after tab closes or crashes so a new tab can safely recover
 * abandoned pending drafts.
 */
export function createStorageLeaseLockProvider(
  storage: Storage,
  ownerId: string,
  ttlMs = DEFAULT_LEASE_TTL_MS,
  now: () => number = () => Date.now(),
): LockProvider {
  return {
    async request(name: string, optionsOrCb: unknown, maybeCb?: unknown): Promise<unknown> {
      const cb = (typeof optionsOrCb === "function" ? optionsOrCb : maybeCb) as ((lock: { name: string } | null) => Promise<unknown> | unknown);
      const leaseKey = LEASE_PREFIX + name;
      const t = now();
      try {
        const raw = storage.getItem(leaseKey);
        if (raw) {
          const existing = JSON.parse(raw) as { owner?: unknown; expiresAt?: unknown };
          if (typeof existing?.expiresAt === "number" && existing.expiresAt > t && existing.owner !== ownerId) {
            return await cb(null);
          }
        }
        const writeLease = () => {
          storage.setItem(leaseKey, JSON.stringify({ owner: ownerId, expiresAt: now() + ttlMs }));
        };
        writeLease();
        const verified = JSON.parse(storage.getItem(leaseKey) ?? "null") as { owner?: unknown } | null;
        if (verified?.owner !== ownerId) return await cb(null);
        const heartbeat = typeof setInterval === "function"
          ? setInterval(() => { try { writeLease(); } catch { /* ignore */ } }, Math.max(1000, Math.floor(ttlMs / 3)))
          : null;
        try {
          return await cb({ name });
        } finally {
          if (heartbeat !== null) clearInterval(heartbeat);
          try {
            const cur = JSON.parse(storage.getItem(leaseKey) ?? "null") as { owner?: unknown } | null;
            if (cur?.owner === ownerId) storage.removeItem(leaseKey);
          } catch { /* ignore */ }
        }
      } catch {
        return await cb(null);
      }
    },
  } as LockProvider;
}

/** Summarizes persisted cross-session pending & recovery drafts for a user/doc pair. */
export function inspectCrossSessionDrafts(storage: Storage, userId: number, docId: number): { activeCount: number; recoveryCount: number; totalOps: number } {
  const active = accountKeys(storage, userId, docId);
  const recovery = recoveryDraftKeys(storage, userId, docId);
  let totalOps = 0;
  for (const key of [...active, ...recovery]) {
    try {
      const parsed = parse(storage.getItem(key));
      if (parsed) totalOps += parsed.ops.length;
    } catch { /* corrupt entries remain countable via active/recovery */ }
  }
  return { activeCount: active.length, recoveryCount: recovery.length, totalOps };
}

/** A lease is held until release; an occupied lock is never waited on. */
async function tryLease(locks: LockProvider, name: string): Promise<(() => Promise<void>) | null> {
  let decided = false;
  return new Promise((resolve) => {
    let unlock!: () => void;
    const held = new Promise<void>((r) => { unlock = r; });
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    try {
      void locks.request(name, { ifAvailable: true }, async (lock) => {
        decided = true;
        let released = false;
        resolve(lock ? () => { if (!released) { released = true; unlock(); } return finished; } : null);
        if (lock) await held;
      }).then(done, () => { done(); if (!decided) resolve(null); });
    } catch { done(); resolve(null); }
  });
}

/**
 * Claim at most one replica draft. Web Locks protect against cloned sessionStorage,
 * concurrent recovery and active tabs. Without locks, create a new key and leave
 * all existing account-scoped drafts available for explicit export.
 */
export async function preparePendingSession(
  storage: Storage, session: Storage, locks: LockProvider | undefined,
  userId: number, docId: number, randomToken: () => string,
): Promise<PendingSession> {
  const sessionKey = `jiange:pending-session:${userId}:${docId}`;
  const legacy = storage.getItem(`jiange:pending:${docId}`) !== null;
  let token: string | null = null;
  try { token = session.getItem(sessionKey); } catch { /* recover abandoned draft later */ }
  // Session storage is copied to tabs opened via window.open: never trust it
  // unless its associated exclusive lock is available.
  if (!locks || !token || !/^[a-zA-Z0-9-]{16,100}$/.test(token)) token = randomToken();
  let key = pendingOpsKey(userId, docId, token);
  let release = locks ? await tryLease(locks, key) : null;
  if (locks && !release) {
    token = randomToken(); key = pendingOpsKey(userId, docId, token);
    release = await tryLease(locks, key);
  }
  // If Web Locks fail, use an unpredictable fresh key and never restore or
  // overwrite another session. The user can export account-scoped backups.
  if (!release) { token = randomToken(); key = pendingOpsKey(userId, docId, token); }
  let draft: PendingOpsDraft | null = null;
  let corrupt = false;
  if (release) {
    try { draft = parse(storage.getItem(key)); }
    catch { corrupt = true; await release(); token = randomToken(); key = pendingOpsKey(userId, docId, token); release = await tryLease(locks!, key); }
  }
  if (release && !draft) {
    for (const candidate of accountKeys(storage, userId, docId)) {
      if (candidate === key || !candidate.startsWith(base(userId, docId))) continue;
      const acquired = await tryLease(locks!, candidate);
      if (!acquired) continue;
      try {
        const found = parse(storage.getItem(candidate));
        if (found) { await release(); release = acquired; key = candidate; token = candidate.slice(base(userId, docId).length); draft = found; break; }
      } catch { corrupt = true; /* leave corrupt drafts intact for export */ }
      await acquired();
    }
  }
  try { session.setItem(sessionKey, token); } catch { /* safe: key is still isolated */ }
  return { key, draft, legacy, otherDrafts: accountKeys(storage, userId, docId).some((k) => k !== key), corrupt, release: release ?? (() => Promise.resolve()) };
}

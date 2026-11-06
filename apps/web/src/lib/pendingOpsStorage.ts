import { decodeOps, encodeOps, type Op } from "@jiange/collab";

export interface PendingOpsDraft { clientId: number; ops: Op[]; blocked?: string | null }
export interface PendingSession { key: string; draft: PendingOpsDraft | null; legacy: boolean; otherDrafts: boolean; corrupt: boolean; release: () => void }

type LockProvider = Pick<LockManager, "request">;
export interface StorageEnvironment { local: Storage; session: Storage; locks?: LockProvider }
const base = (userId: number, docId: number) => `jiange:pending:v3:${userId}:${docId}:`;
export const pendingOpsKey = (userId: number, docId: number, token: string) => base(userId, docId) + token;
const v2Key = (userId: number, docId: number) => `jiange:pending:v2:${userId}:${docId}`;

function parse(raw: string | null): PendingOpsDraft | null {
  if (raw === null) return null;
  const draft = JSON.parse(raw) as PendingOpsDraft;
  if (!Number.isSafeInteger(draft?.clientId) || draft.clientId < 1 || !Array.isArray(draft.ops) || (draft.blocked != null && typeof draft.blocked !== "string")) throw new Error("invalid saved operations");
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
  return accountKeys(storage, userId, docId).flatMap((key) => {
    const raw = storage.getItem(key);
    return raw === null ? [] : [{ key, raw }];
  });
}
export function writePendingOps(storage: Storage, key: string, draft: PendingOpsDraft | null): void {
  if (draft?.ops.length) storage.setItem(key, JSON.stringify(draft));
  else storage.removeItem(key);
}

/** Defer browser storage getters so synchronous SecurityError becomes a rejection. */
export function prepareBrowserPendingSession(getEnvironment: () => StorageEnvironment, userId: number, docId: number, random: () => string): Promise<PendingSession> {
  return Promise.resolve().then(() => {
    const { local, session, locks } = getEnvironment();
    return preparePendingSession(local, session, locks, userId, docId, random);
  });
}

/** A lease is held until release; an occupied lock is never waited on. */
async function tryLease(locks: LockProvider, name: string): Promise<(() => void) | null> {
  let decided = false;
  return new Promise((resolve) => {
    let unlock!: () => void;
    const held = new Promise<void>((r) => { unlock = r; });
    try {
      void locks.request(name, { ifAvailable: true }, async (lock) => {
        decided = true;
        resolve(lock ? unlock : null);
        if (lock) await held;
      }).catch(() => { if (!decided) resolve(null); });
    } catch { resolve(null); }
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
    catch { corrupt = true; release(); token = randomToken(); key = pendingOpsKey(userId, docId, token); release = await tryLease(locks!, key); }
  }
  if (release && !draft) {
    for (const candidate of accountKeys(storage, userId, docId)) {
      if (candidate === key || !candidate.startsWith(base(userId, docId))) continue;
      const acquired = await tryLease(locks!, candidate);
      if (!acquired) continue;
      try {
        const found = parse(storage.getItem(candidate));
        if (found) { release(); release = acquired; key = candidate; token = candidate.slice(base(userId, docId).length); draft = found; break; }
      } catch { corrupt = true; /* leave corrupt drafts intact for export */ }
      acquired();
    }
  }
  try { session.setItem(sessionKey, token); } catch { /* safe: key is still isolated */ }
  return { key, draft, legacy, otherDrafts: accountKeys(storage, userId, docId).some((k) => k !== key), corrupt, release: release ?? (() => {}) };
}

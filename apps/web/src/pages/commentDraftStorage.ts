import { matchesCommentTarget, mergeRecoveredCommentDrafts, type CommentTarget, type SavedCommentDraft } from "./commentAccess";

type Locks = Pick<LockManager, "request">;
type Environment = { storage: Storage; locks?: Locks; random: () => string; leaseTimeoutMs?: number };
type Snapshot = { version: 1; entries: SavedCommentDraft[]; frozen: SavedCommentDraft[] };
type Stored = { key: string; raw: string; values: SavedCommentDraft[]; corrupt: boolean };

/** A previous writer must not enable editing after a temporary network failure. */
export function commentDraftStorageReady(prepared: (CommentTarget & { generation: number }) | null, target: CommentTarget, generation: number, available: boolean): boolean {
  return available && matchesCommentTarget(prepared, target.doc, target.user, target.session) && prepared?.generation === generation;
}

const prefix = (doc: number, user: number) => `jiange:comment-draft:v1:${user}:${doc}:`;

function parse(raw: string): SavedCommentDraft[] {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("invalid comment draft");
  const snap = value as Snapshot;
  if (snap.version !== 1 || !Array.isArray(snap.entries) || !Array.isArray(snap.frozen)) throw new Error("invalid comment draft");
  const all: unknown[] = [...snap.entries, ...snap.frozen];
  const safe = all.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid comment draft");
    const draft = item as SavedCommentDraft;
    if (typeof draft.text !== "string" || (draft.parentId !== undefined && (!Number.isSafeInteger(draft.parentId) || draft.parentId < 1))) throw new Error("invalid comment draft");
    if (draft.draft !== null && (!draft.draft || typeof draft.draft.block !== "string" || typeof draft.draft.startChar !== "string" || typeof draft.draft.endChar !== "string" || typeof draft.draft.quote !== "string")) throw new Error("invalid comment draft");
    return { text: draft.text, draft: draft.draft ? { block: draft.draft.block, startChar: draft.draft.startChar, endChar: draft.draft.endChar, quote: draft.draft.quote } : null, ...(draft.parentId === undefined ? {} : { parentId: draft.parentId }) };
  });
  return mergeRecoveredCommentDrafts([], safe.filter((draft) => draft.text.trim()));
}

async function lease(locks: Locks, key: string, timeoutMs = 2000): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    let decided = false;
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const finish = (value: (() => void) | null) => {
      if (decided) return false;
      decided = true;
      clearTimeout(timer);
      resolve(value);
      return true;
    };
    const timer = setTimeout(() => { finish(null); }, timeoutMs);
    try {
      void locks.request(key, { ifAvailable: true }, async (lock) => {
        // If acquisition timed out, returning immediately releases any late lock.
        if (!finish(lock ? release : null)) return;
        if (lock) await held;
      }).catch(() => { finish(null); });
    } catch { finish(null); }
  });
}

/** One independent writer per page. Other tabs' active keys are never overwritten. */
export class CommentDraftStorage {
  private external: Stored[] = [];
  private release: (() => void) | null = null;
  private closed = false;
  private constructor(private env: Environment, private doc: number, private user: number, private key: string, private canLock: boolean) {}

  static async open(getEnvironment: () => Environment, doc: number, user: number): Promise<CommentDraftStorage> {
    const env = getEnvironment();
    const token = env.random();
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(token)) throw new Error("secure random unavailable");
    const key = `${prefix(doc, user)}${env.locks ? "locked" : "unlocked"}:${token}`;
    const instance = new CommentDraftStorage(env, doc, user, key, !!env.locks);
    if (env.locks) {
      instance.release = await lease(env.locks, key, env.leaseTimeoutMs);
      if (!instance.release) throw new Error("draft lock unavailable");
    }
    try {
      if (env.storage.getItem(key) !== null) throw new Error("draft writer key already exists");
      instance.reload();
    }
    catch (error) { instance.close(); throw error; }
    return instance;
  }

  private reload(): void {
    const found: Stored[] = [];
    for (let i = 0; i < this.env.storage.length; i++) {
      const key = this.env.storage.key(i);
      if (!key || key === this.key || !key.startsWith(prefix(this.doc, this.user))) continue;
      const raw = this.env.storage.getItem(key);
      if (raw !== null) {
        try { found.push({ key, raw, values: parse(raw), corrupt: false }); }
        catch { found.push({ key, raw, values: [], corrupt: true }); }
      }
    }
    this.external = found;
  }

  read(): SavedCommentDraft[] { return mergeRecoveredCommentDrafts([], this.external.flatMap((item) => item.values)); }
  damaged(): { key: string; raw: string }[] { return this.external.filter((item) => item.corrupt).map(({ key, raw }) => ({ key, raw })); }
  canClearOtherTabs(): boolean { return this.canLock; }

  write(entries: SavedCommentDraft[], frozen: SavedCommentDraft[]): void {
    if (this.closed) throw new Error("draft session closed");
    if (!entries.length && !frozen.length) this.env.storage.removeItem(this.key);
    else this.env.storage.setItem(this.key, JSON.stringify({ version: 1, entries, frozen } satisfies Snapshot));
  }

  /** Remove only unchanged abandoned keys while holding their exclusive lease. */
  async dismiss(): Promise<boolean> {
    let complete = true;
    for (const item of this.external) {
      if (this.closed) { complete = false; break; }
      if (item.corrupt || !this.canLock || !this.env.locks || !item.key.startsWith(`${prefix(this.doc, this.user)}locked:`)) { complete = false; continue; }
      const release = await lease(this.env.locks, item.key, this.env.leaseTimeoutMs);
      if (!release) { complete = false; continue; }
      try {
        if (this.closed) { complete = false; break; }
        if (this.env.storage.getItem(item.key) === item.raw) this.env.storage.removeItem(item.key);
        else complete = false;
      } finally { release(); }
    }
    this.reload();
    return complete;
  }

  close(): void { if (!this.closed) { this.closed = true; this.release?.(); } }
}

export function browserCommentDraftEnvironment(): Environment {
  return { storage: window.localStorage, locks: navigator.locks, random: () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("");
  } };
}

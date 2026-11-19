import type { TitleConsistencySnapshot } from "./title-consistency";

export type TitleSyncPoint = { epoch: number; head: number; historyRevision: number; title: string };
export type TitleSyncOutcome = "done" | "waiting" | "retry" | "conflict" | "history_changed" | "invalid" | "denied" | "busy";
export type TitleSyncTransport = {
  commit: (snapshot: { historyEpoch: number; head: number; directoryTitle: string; documentTitle: string }, signal: AbortSignal) => Promise<number>;
  read: (signal: AbortSignal) => Promise<TitleConsistencySnapshot>;
};
export class TitleSyncReadError extends Error { constructor(readonly status: number) { super("title snapshot unavailable"); } }
type Pending = { baseline: string; epoch: number | null; historyRevision: number; target?: string; confirmed?: string; uncertain?: { title: string; epoch: number; head: number } };
export type TitleSyncStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Per-tab storage: names never move between accounts or documents. */
export function titleSyncStorageKey(user: number, doc: number) { return `jiange:title-sync:v1:${user}:${doc}`; }
/** Cross-session durable storage key (survives tab closes and browser crashes). */
export function titleSyncDurableStorageKey(user: number, doc: number) { return `jiange:title-sync:v2:${user}:${doc}`; }
const TITLE_SYNC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function titleSyncSessionStorage(user: number, doc: number): { storage: TitleSyncStorage; key: string } | undefined {
  try { return { storage: window.sessionStorage, key: titleSyncStorageKey(user, doc) }; } catch { return undefined; }
}

/**
 * Prefers localStorage so pending title-to-directory syncs survive full tab
 * closes and browser crashes; falls back to sessionStorage if localStorage is
 * unavailable. Legacy v1 session entries are migrated seamlessly on activate().
 */
export function titleSyncDurableStorage(user: number, doc: number): { storage: TitleSyncStorage; key: string; legacySession?: { storage: TitleSyncStorage; key: string } } | undefined {
  const legacySession = titleSyncSessionStorage(user, doc);
  try {
    return { storage: window.localStorage, key: titleSyncDurableStorageKey(user, doc), legacySession };
  } catch {
    return legacySession;
  }
}

function validPending(value: unknown): value is { pending: Pending; conflicted: boolean; updatedAt?: number } {
  if (!value || typeof value !== "object") return false;
  const item = value as { pending?: Pending; conflicted?: unknown; updatedAt?: unknown }, p = item.pending;
  if (item.updatedAt !== undefined && (!Number.isFinite(item.updatedAt) || (item.updatedAt as number) < 0)) return false;
  const validTitle = (s: unknown) => typeof s === "string" && s.length <= 10000;
  const nonnegative = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  return !!p && validTitle(p.baseline) && validTitle(p.target) && (p.epoch === null || nonnegative(p.epoch)) && nonnegative(p.historyRevision) && (p.confirmed === undefined || validTitle(p.confirmed)) && typeof item.conflicted === "boolean" && (p.uncertain === undefined || !!p.uncertain && validTitle(p.uncertain.title) && nonnegative(p.uncertain.epoch) && nonnegative(p.uncertain.head));
}

const deniedRead = (error: unknown) => error instanceof TitleSyncReadError && [401, 403, 404].includes(error.status);

/** Mirrors only locally edited titles. A failed or ambiguous response never
 * grants permission to overwrite a directory name changed by another actor. */
export class TitleAutoSync {
  private pending: Pending | null = null;
  private restored = false;
  private active: AbortController | null = null;
  private disposed = false;
  private conflicted = false;
  constructor(private readonly observe: () => TitleSyncPoint | null, private readonly transport: TitleSyncTransport, private readonly onCommitted: () => void, private readonly storage?: { storage: TitleSyncStorage; key: string; legacySession?: { storage: TitleSyncStorage; key: string } }) {}
  private persist() {
    if (!this.storage) return;
    try {
      if (this.pending?.target !== undefined) this.storage.storage.setItem(this.storage.key, JSON.stringify({ pending: this.pending, conflicted: this.conflicted, updatedAt: Date.now() }));
      else this.storage.storage.removeItem(this.storage.key);
      if (this.storage.legacySession) this.storage.legacySession.storage.removeItem(this.storage.legacySession.key);
    } catch { /* Continue in memory if browser storage is unavailable. */ }
  }
  activate() {
    this.disposed = false;
    if (this.pending || !this.storage) return;
    const tryLoad = (store: TitleSyncStorage, key: string): boolean => {
      try {
        const raw = store.getItem(key);
        if (!raw || raw.length > 50000) return false;
        const parsed: unknown = JSON.parse(raw);
        if (!validPending(parsed)) return false;
        if (parsed.updatedAt !== undefined && Date.now() - parsed.updatedAt > TITLE_SYNC_TTL_MS) {
          store.removeItem(key);
          return false;
        }
        this.pending = parsed.pending; this.conflicted = parsed.conflicted; this.restored = true;
        return true;
      } catch { return false; }
    };
    if (!tryLoad(this.storage.storage, this.storage.key) && this.storage.legacySession) {
      if (tryLoad(this.storage.legacySession.storage, this.storage.legacySession.key)) {
        this.persist();
      }
    }
  }
  edit(baseline: string, epoch: number | null, historyRevision: number, target?: string) {
    if (this.disposed) return;
    if (!this.pending) this.pending = { baseline, epoch, historyRevision, target };
    else if (target !== undefined) this.pending.target = target;
    this.persist();
  }
  get hasPending() { return !!this.pending; }
  clear() { this.pending = null; this.conflicted = false; this.restored = false; this.persist(); }
  clearIfCurrent(title: string) { const point = this.observe(); if (point && point.title === title) this.clear(); }
  dispose() { this.disposed = true; this.active?.abort(); this.active = null; this.pending = null; }
  async step(): Promise<TitleSyncOutcome> {
    if (this.disposed || !this.pending) return "done";
    if (this.conflicted) return "conflict";
    if (this.active) return "busy";
    const point = this.observe();
    if (!point) return "waiting";
    if (this.pending.epoch === null || point.epoch !== this.pending.epoch || point.historyRevision !== this.pending.historyRevision || this.restored && this.pending.historyRevision !== 0) return "history_changed";
    if (this.restored && point.title !== this.pending.target) { this.conflicted = true; this.persist(); return "conflict"; }
    this.restored = false;
    if (point.title !== point.title.trim() || [...point.title].length > 200 || /[\r\n]/.test(point.title)) return "invalid";
    if (this.pending.confirmed === point.title && !this.pending.uncertain) { this.clear(); return "done"; }
    const pending = this.pending, controller = new AbortController(); this.active = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const owns = () => !this.disposed && this.pending === pending;
    const current = () => owns() && !controller.signal.aborted;
    const finish = () => {
      if (!current()) return "waiting" as const;
      const now = this.observe();
      if (now && (now.epoch !== pending.epoch || now.historyRevision !== pending.historyRevision)) return "history_changed" as const;
      if (now && now.title === pending.baseline) { this.clear(); return "done" as const; }
      return "waiting" as const;
    };
    try {
      if (pending.uncertain) {
        let snapshot: TitleConsistencySnapshot;
        try { snapshot = await this.transport.read(controller.signal); } catch (error) { return deniedRead(error) ? "denied" : "retry"; }
        if (!current()) return "waiting";
        if (snapshot.historyEpoch !== pending.uncertain.epoch || snapshot.head < pending.uncertain.head) return "history_changed";
        if (snapshot.directoryTitle === pending.uncertain.title) {
          pending.baseline = pending.uncertain.title; pending.confirmed = pending.uncertain.title; pending.uncertain = undefined; this.persist(); this.onCommitted();
          return finish();
        }
        if (snapshot.directoryTitle !== pending.baseline) { this.conflicted = true; this.persist(); return "conflict"; }
        pending.uncertain = undefined; this.persist();
        return "retry";
      }
      let status: number;
      pending.uncertain = { title: point.title, epoch: point.epoch, head: point.head }; this.persist();
      try { status = await this.transport.commit({ historyEpoch: point.epoch, head: point.head, directoryTitle: pending.baseline, documentTitle: point.title }, controller.signal); }
      catch { if (owns()) pending.uncertain = { title: point.title, epoch: point.epoch, head: point.head }; return "retry"; }
      if (!current()) { if (owns()) pending.uncertain = { title: point.title, epoch: point.epoch, head: point.head }; return "waiting"; }
      if (status === 204) { pending.baseline = point.title; pending.confirmed = point.title; pending.uncertain = undefined; this.persist(); this.onCommitted(); return finish(); }
      pending.uncertain = undefined; this.persist();
      if (status === 401 || status === 403 || status === 404) return "denied";
      if (status === 409) {
        try {
          const snapshot = await this.transport.read(controller.signal);
          if (!current()) return "waiting";
          if (snapshot.historyEpoch !== pending.epoch || snapshot.head < point.head) return "history_changed";
          if (snapshot.directoryTitle !== pending.baseline) { this.conflicted = true; this.persist(); return "conflict"; }
          return "retry";
        } catch (error) { return deniedRead(error) ? "denied" : "retry"; }
      }
      if (status === 400 || status === 413) return "invalid";
      return "retry";
    } finally { clearTimeout(timeout); if (this.active === controller) this.active = null; }
  }
}

import type { TitleConsistencySnapshot } from "./title-consistency";

export type TitleSyncPoint = { epoch: number; head: number; historyRevision: number; title: string };
export type TitleSyncOutcome = "done" | "waiting" | "retry" | "conflict" | "history_changed" | "invalid" | "denied" | "busy";
export type TitleSyncTransport = {
  commit: (snapshot: { historyEpoch: number; head: number; directoryTitle: string; documentTitle: string }, signal: AbortSignal) => Promise<number>;
  read: (signal: AbortSignal) => Promise<TitleConsistencySnapshot>;
};
export class TitleSyncReadError extends Error { constructor(readonly status: number) { super("title snapshot unavailable"); } }
const deniedRead = (error: unknown) => error instanceof TitleSyncReadError && [401, 403, 404].includes(error.status);

/** Mirrors only locally edited titles. A failed or ambiguous response never
 * grants permission to overwrite a directory name changed by another actor. */
export class TitleAutoSync {
  private pending: { baseline: string; epoch: number | null; historyRevision: number; confirmed?: string; uncertain?: { title: string; epoch: number; head: number } } | null = null;
  private active: AbortController | null = null;
  private disposed = false;
  private conflicted = false;
  constructor(private readonly observe: () => TitleSyncPoint | null, private readonly transport: TitleSyncTransport, private readonly onCommitted: () => void) {}
  activate() { this.disposed = false; }
  edit(baseline: string, epoch: number | null, historyRevision: number) { if (!this.disposed && !this.pending) this.pending = { baseline, epoch, historyRevision }; }
  get hasPending() { return !!this.pending; }
  clear() { this.pending = null; this.conflicted = false; }
  clearIfCurrent(title: string) { const point = this.observe(); if (point && point.title === title) this.clear(); }
  dispose() { this.disposed = true; this.active?.abort(); this.active = null; this.pending = null; }
  async step(): Promise<TitleSyncOutcome> {
    if (this.disposed || !this.pending) return "done";
    if (this.conflicted) return "conflict";
    if (this.active) return "busy";
    const point = this.observe();
    if (!point) return "waiting";
    if (this.pending.epoch === null || point.epoch !== this.pending.epoch || point.historyRevision !== this.pending.historyRevision) return "history_changed";
    if (point.title !== point.title.trim() || [...point.title].length > 200 || /[\r\n]/.test(point.title)) return "invalid";
    if (this.pending.confirmed === point.title && !this.pending.uncertain) { this.pending = null; return "done"; }
    const pending = this.pending, controller = new AbortController(); this.active = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const owns = () => !this.disposed && this.pending === pending;
    const current = () => owns() && !controller.signal.aborted;
    const finish = () => {
      if (!current()) return "waiting" as const;
      const now = this.observe();
      if (now && (now.epoch !== pending.epoch || now.historyRevision !== pending.historyRevision)) return "history_changed" as const;
      if (now && now.title === pending.baseline) { this.pending = null; return "done" as const; }
      return "waiting" as const;
    };
    try {
      if (pending.uncertain) {
        let snapshot: TitleConsistencySnapshot;
        try { snapshot = await this.transport.read(controller.signal); } catch (error) { return deniedRead(error) ? "denied" : "retry"; }
        if (!current()) return "waiting";
        if (snapshot.historyEpoch !== pending.uncertain.epoch || snapshot.head < pending.uncertain.head) return "history_changed";
        if (snapshot.directoryTitle === pending.uncertain.title) {
          pending.baseline = pending.uncertain.title; pending.confirmed = pending.uncertain.title; pending.uncertain = undefined; this.onCommitted();
          return finish();
        }
        if (snapshot.directoryTitle !== pending.baseline) { this.conflicted = true; return "conflict"; }
        pending.uncertain = undefined;
        return "retry";
      }
      let status: number;
      try { status = await this.transport.commit({ historyEpoch: point.epoch, head: point.head, directoryTitle: pending.baseline, documentTitle: point.title }, controller.signal); }
      catch { if (owns()) pending.uncertain = { title: point.title, epoch: point.epoch, head: point.head }; return "retry"; }
      if (!current()) { if (owns()) pending.uncertain = { title: point.title, epoch: point.epoch, head: point.head }; return "waiting"; }
      if (status === 204) { pending.baseline = point.title; pending.confirmed = point.title; this.onCommitted(); return finish(); }
      if (status === 401 || status === 403 || status === 404) return "denied";
      if (status === 409) {
        try {
          const snapshot = await this.transport.read(controller.signal);
          if (!current()) return "waiting";
          if (snapshot.historyEpoch !== pending.epoch || snapshot.head < point.head) return "history_changed";
          if (snapshot.directoryTitle !== pending.baseline) { this.conflicted = true; return "conflict"; }
          return "retry";
        } catch (error) { return deniedRead(error) ? "denied" : "retry"; }
      }
      if (status === 400 || status === 413) return "invalid";
      return "retry";
    } finally { clearTimeout(timeout); if (this.active === controller) this.active = null; }
  }
}

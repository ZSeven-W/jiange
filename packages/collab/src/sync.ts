import { Doc } from "./doc";
import { decodeOps, encodeOps } from "./encoding";
import type { Op } from "./ops";
import { decodeServerMsg, encodeClientMsg } from "./protocol";

export type SyncStatus = "connecting" | "synced" | "syncing" | "offline";

export interface Peer {
  clientId: number;
  state: unknown;
}

export interface SyncHandlers {
  /** Called right before remote changes are applied (capture caret anchors here). */
  beforeRemote?: () => void;
  /** Document content changed (local or remote). */
  change?: (remote: boolean) => void;
  peers?: (peers: Peer[]) => void;
  status?: (s: SyncStatus) => void;
  /** The current connection has received the contiguous history advertised by welcome. */
  caughtUp?: (caughtUp: boolean) => void;
  error?: (code: string, message: string) => void;
  /** Pending writes are retained but will not be sent until explicitly retried. */
  blocked?: (code: string | null) => void;
}

/**
 * Transport-agnostic sync client. Owns the local replica, the outgoing queue
 * (ops not yet acknowledged survive disconnects and are resent on reconnect)
 * and remote presence.
 */
export class SyncClient {
  doc: Doc | null = null;
  clientId = 0;
  lastSeq = 0;
  /** Highest contiguous sequence safe to advertise as the GC horizon. */
  private safeSeq = 0;
  private inflight: Op[][] = [];
  private queued: Op[] = [];
  private send: ((b: Uint8Array) => void) | null = null;
  private peers = new Map<number, unknown>();
  private awareness: string | null = null;
  status: SyncStatus = "connecting";
  droppedOnResync = 0;
  /** After a resync, causally-unready ops are only dropped once catch-up reaches this seq. */
  private catchUpTo = -1;
  private welcomeHead: number | null = null;
  private sequenceGap = false;
  private _caughtUp = false;
  private _blocked: string | null = null;
  /** ACKs have no rejection list. Keep a batch until an empty OPS fence is ACKed. */
  private awaitingFence = false;
  private rejectedTransport = false;

  constructor(readonly docId: number, private h: SyncHandlers = {}) {}

  get unacked(): number {
    return this.inflight.reduce((n, b) => n + b.length, 0) + this.queued.length;
  }

  /** True only after this connection has received every operation through welcome's head. */
  get caughtUp(): boolean { return this._caughtUp; }
  get blocked(): string | null { return this._blocked; }

  private setBlocked(code: string | null) {
    if (this._blocked !== code) { this._blocked = code; this.h.blocked?.(code); }
  }

  private refreshCaughtUp() {
    const next = this.send !== null && this.doc !== null && this.doc.pendingCount === 0 && this.welcomeHead !== null && !this.sequenceGap && this.lastSeq >= this.welcomeHead;
    if (next !== this._caughtUp) {
      this._caughtUp = next;
      this.h.caughtUp?.(next);
    }
  }

  private gap(message: string) {
    this.sequenceGap = true;
    this.refreshCaughtUp();
    this.setStatus("syncing");
    this.h.error?.("gap", message);
  }

  private setStatus(s: SyncStatus) {
    if (s !== this.status) {
      this.status = s;
      this.h.status?.(s);
    }
  }

  /** Pending local ops may reference tombstones even after they were received. */
  private acknowledgeIfSafe() {
    if (!this.send || !this.caughtUp || this._blocked || this.awaitingFence || this.inflight.length || this.queued.length || this.lastSeq <= this.safeSeq) return;
    this.safeSeq = this.lastSeq;
    this.send(encodeClientMsg({ type: "ack", seq: this.safeSeq }));
  }

  /** Attach a freshly opened transport. */
  open(send: (b: Uint8Array) => void) {
    this.send = send;
    this.welcomeHead = null;
    this.sequenceGap = false;
    this.refreshCaughtUp();
    this.setStatus("connecting");
    // The server also treats HELLO.lastSeq as an acknowledgement. Do not
    // advertise sequences received while local work remained unconfirmed.
    send(encodeClientMsg({ type: "hello", docId: this.docId, clientId: this.clientId, lastSeq: this.safeSeq }));
  }

  /** Transport closed: keep unacked ops for the next connection. */
  close() {
    this.send = null;
    this.welcomeHead = null;
    this.refreshCaughtUp();
    this.queued = this.inflight.flat().concat(this.queued);
    this.inflight = [];
    this.awaitingFence = false;
    this.rejectedTransport = false;
    this.peers.clear();
    this.h.peers?.([]);
    this.setStatus("offline");
  }

  /** Records locally generated ops (already applied to `doc`) and sends them when possible. */
  push(ops: (Op | null)[]) {
    for (const op of ops) if (op) this.queued.push(op);
    this.h.change?.(false);
    this.flush();
  }

  private flush() {
    // ACKs have no batch identifiers, so never have two batches outstanding.
    if (!this.send || this.status === "connecting" || this._blocked || this.inflight.length || this.queued.length === 0) return;
    const batch = this.queued;
    this.queued = [];
    this.inflight.push(batch);
    this.send(encodeClientMsg({ type: "ops", batch: encodeOps(batch) }));
    this.setStatus("syncing");
  }

  /** Local ops not yet acknowledged by the server (persist these for offline durability). */
  pendingOps(): Op[] {
    return this.inflight.flat().concat(this.queued);
  }

  /** Retry retained writes after the caller has checked access/connection state. */
  retryPending() {
    if (!this._blocked) return;
    // A late ACK from the rejected connection must never acknowledge a retry.
    if (this.rejectedTransport) return;
    this.queued = this.inflight.flat().concat(this.queued);
    this.inflight = [];
    this.awaitingFence = false;
    this.setBlocked(null);
    this.flush();
  }

  /**
   * Restores ops saved by a previous session (e.g. from localStorage) before
   * the first connection. They are replayed onto the fresh replica and resent;
   * the server deduplicates anything it already has.
   */
  restore(clientId: number, ops: Op[], blocked?: string | null) {
    if (this.doc) throw new Error("restore before the first connection");
    this.clientId = clientId;
    this.queued = ops.concat(this.queued);
    if (blocked && ops.length) this.setBlocked(blocked);
  }

  setAwareness(state: unknown) {
    this.awareness = JSON.stringify(state);
    this.send?.(encodeClientMsg({ type: "aware", state: this.awareness }));
  }

  private emitPeers() {
    this.h.peers?.([...this.peers].map(([clientId, state]) => ({ clientId, state })));
  }

  receive(bytes: Uint8Array) {
    const m = decodeServerMsg(bytes);
    switch (m.type) {
      case "welcome": {
        const pending = this.inflight.flat().concat(this.queued);
        this.inflight = [];
        this.awaitingFence = false;
        this.queued = [];
        let rebuilt = false;
        if (m.snapshot || !this.doc || m.clientId !== this.clientId) {
          this.h.beforeRemote?.();
          const fresh = m.snapshot ? Doc.fromState(m.clientId, m.snapshot.state) : new Doc(m.clientId);
          if (!m.snapshot && this.doc && m.clientId !== this.clientId) {
            // server issued a new client id but no snapshot: keep our state, switch id
            this.doc.client = m.clientId;
          } else {
            for (const op of pending) fresh.apply(op);
            this.doc = fresh;
            this.catchUpTo = m.headSeq;
            rebuilt = true;
          }
          this.lastSeq = m.snapshot ? m.snapshot.seq : this.doc && !rebuilt ? this.lastSeq : 0;
        }
        this.clientId = m.clientId;
        this.safeSeq = Math.min(this.safeSeq, m.headSeq);
        this.queued = pending;
        this.welcomeHead = m.headSeq;
        this.sequenceGap = this.lastSeq > m.headSeq;
        this.refreshCaughtUp();
        this.setStatus(pending.length || !this.caughtUp ? "syncing" : "synced");
        if (this.sequenceGap) {
          this.h.error?.("gap", `welcome head ${m.headSeq} is behind replica seq ${this.lastSeq}`);
          if (rebuilt) this.h.change?.(true);
          return;
        }
        // resend unacked ops BEFORE acknowledging anything new (required for safe tombstone GC)
        if (pending.length && !this._blocked) {
          const batch = this.queued;
          this.queued = [];
          this.inflight.push(batch);
          this.send?.(encodeClientMsg({ type: "ops", batch: encodeOps(batch) }));
        }
        if (this.awareness) this.send?.(encodeClientMsg({ type: "aware", state: this.awareness }));
        if (rebuilt) this.h.change?.(true);
        this.acknowledgeIfSafe();
        return;
      }
      case "ops": {
        if (!this.doc) throw new Error("ops before welcome");
        if (m.firstSeq > this.lastSeq + 1) {
          this.gap(`expected seq ${this.lastSeq + 1}, got ${m.firstSeq}`);
          return;
        }
        const ops = decodeOps(m.batch);
        // HELLO advertises the safe horizon, which can lag the applied view.
        // Replayed prefixes are already present; only apply new contiguous ops.
        const skip = Math.min(ops.length, Math.max(0, this.lastSeq + 1 - m.firstSeq));
        if (skip < ops.length) {
          this.h.beforeRemote?.();
          for (const op of ops.slice(skip)) this.doc.apply(op);
          this.lastSeq = m.firstSeq + ops.length - 1;
        }
        if (this.catchUpTo >= 0 && this.lastSeq >= this.catchUpTo) {
          this.droppedOnResync += this.doc.dropPending();
          this.catchUpTo = -1;
        }
        this.refreshCaughtUp();
        if (skip < ops.length) this.h.change?.(true);
        this.acknowledgeIfSafe();
        if (this.caughtUp && !this._blocked && !this.inflight.length && !this.queued.length) this.setStatus("synced");
        return;
      }
      case "ack": {
        // A failed batch is never acknowledged by current servers. A late or
        // stray ACK must not remove the retained batch while writes are blocked.
        if (this._blocked || !this.inflight.length) return;
        if (this.awaitingFence) {
          if (m.count !== 0) { this.gap("non-empty ACK for sync fence"); return; }
          this.awaitingFence = false;
          this.inflight.shift();
          this.flush();
          this.acknowledgeIfSafe();
          if (this.caughtUp && !this._blocked && !this.inflight.length && !this.queued.length) this.setStatus("synced");
          return;
        }
        if (m.count > 0 && m.firstSeq > this.lastSeq + 1) {
          // Keep the batch inflight: close() must be able to resend it after resync.
          this.gap(`ack out of order: expected seq ${this.lastSeq + 1}, got ${m.firstSeq}`);
          return;
        }
        if (m.count > 0) {
          // A reconnect may replay an accepted local batch before its ACK arrives.
          // Overlap is safe; never move the contiguous cursor backwards.
          this.lastSeq = Math.max(this.lastSeq, m.firstSeq + m.count - 1);
          this.refreshCaughtUp();
        }
        // Older servers acknowledge a partially accepted batch and only then
        // send not_ready. An empty batch is a wire-compatible ordered fence:
        // its ACK cannot arrive before the preceding batch's error.
        this.awaitingFence = true;
        this.send?.(encodeClientMsg({ type: "ops", batch: encodeOps([]) }));
        return;
      }
      case "aware": {
        if (m.clientId === this.clientId) return;
        if (m.state === "") this.peers.delete(m.clientId);
        else {
          try {
            this.peers.set(m.clientId, JSON.parse(m.state));
          } catch {
            /* ignore malformed presence */
          }
        }
        this.emitPeers();
        return;
      }
      case "error":
        if (this.inflight.length && ["read_only", "not_ready", "forbidden", "bad_ops"].includes(m.code)) {
          this.setBlocked(m.code);
          // Freeze immediately, before the UI closes the transport. This
          // prevents retry before a late ACK from the rejected socket drains.
          this.send = null;
          this.rejectedTransport = true;
          this.refreshCaughtUp();
          this.setStatus("offline");
        }
        this.h.error?.(m.code, m.message);
        return;
    }
  }
}

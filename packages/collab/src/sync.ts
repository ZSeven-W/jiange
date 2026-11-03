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
  error?: (code: string, message: string) => void;
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
  private inflight: Op[][] = [];
  private queued: Op[] = [];
  private send: ((b: Uint8Array) => void) | null = null;
  private peers = new Map<number, unknown>();
  private awareness: string | null = null;
  status: SyncStatus = "connecting";
  droppedOnResync = 0;
  /** After a resync, causally-unready ops are only dropped once catch-up reaches this seq. */
  private catchUpTo = -1;

  constructor(readonly docId: number, private h: SyncHandlers = {}) {}

  get unacked(): number {
    return this.inflight.reduce((n, b) => n + b.length, 0) + this.queued.length;
  }

  private setStatus(s: SyncStatus) {
    if (s !== this.status) {
      this.status = s;
      this.h.status?.(s);
    }
  }

  /** Attach a freshly opened transport. */
  open(send: (b: Uint8Array) => void) {
    this.send = send;
    this.setStatus("connecting");
    send(encodeClientMsg({ type: "hello", docId: this.docId, clientId: this.clientId, lastSeq: this.lastSeq }));
  }

  /** Transport closed: keep unacked ops for the next connection. */
  close() {
    this.send = null;
    this.queued = this.inflight.flat().concat(this.queued);
    this.inflight = [];
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
    if (!this.send || this.status === "connecting" || this.queued.length === 0) return;
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

  /**
   * Restores ops saved by a previous session (e.g. from localStorage) before
   * the first connection. They are replayed onto the fresh replica and resent;
   * the server deduplicates anything it already has.
   */
  restore(clientId: number, ops: Op[]) {
    if (this.doc) throw new Error("restore before the first connection");
    this.clientId = clientId;
    this.queued = ops.concat(this.queued);
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
        this.queued = pending;
        this.setStatus(pending.length ? "syncing" : "synced");
        // resend unacked ops BEFORE acknowledging anything new (required for safe tombstone GC)
        if (pending.length) {
          const batch = this.queued;
          this.queued = [];
          this.inflight.push(batch);
          this.send?.(encodeClientMsg({ type: "ops", batch: encodeOps(batch) }));
        }
        if (this.awareness) this.send?.(encodeClientMsg({ type: "aware", state: this.awareness }));
        if (rebuilt) this.h.change?.(true);
        if (m.headSeq === this.lastSeq && !pending.length) this.setStatus("synced");
        return;
      }
      case "ops": {
        if (!this.doc) throw new Error("ops before welcome");
        if (m.firstSeq !== this.lastSeq + 1) {
          this.h.error?.("gap", `expected seq ${this.lastSeq + 1}, got ${m.firstSeq}`);
          return;
        }
        const ops = decodeOps(m.batch);
        this.h.beforeRemote?.();
        for (const op of ops) this.doc.apply(op);
        this.lastSeq += ops.length;
        if (this.catchUpTo >= 0 && this.lastSeq >= this.catchUpTo) {
          this.droppedOnResync += this.doc.dropPending();
          this.catchUpTo = -1;
        }
        this.send?.(encodeClientMsg({ type: "ack", seq: this.lastSeq }));
        this.h.change?.(true);
        if (!this.inflight.length && !this.queued.length) this.setStatus("synced");
        return;
      }
      case "ack": {
        this.inflight.shift();
        if (m.count > 0) {
          if (m.firstSeq !== this.lastSeq + 1) this.h.error?.("gap", "ack out of order");
          this.lastSeq = m.firstSeq + m.count - 1;
          this.send?.(encodeClientMsg({ type: "ack", seq: this.lastSeq }));
        }
        this.flush();
        if (!this.inflight.length && !this.queued.length) this.setStatus("synced");
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
        this.h.error?.(m.code, m.message);
        return;
    }
  }
}

import { Doc } from "./doc.js";
import { decodeOps, encodeOps } from "./encoding.js";
import { idKey } from "./id.js";
import type { Op } from "./ops.js";
import { decodeServerMsg, encodeClientMsg, type ClientMsg } from "./protocol.js";

export type SyncStatus = "connecting" | "synced" | "syncing" | "offline";
export type SyncMode = "edit" | "view";

export interface OfflineHydrateOptions {
  /** Last known server sequence included in the snapshot (defaults to 0). */
  seq?: number;
  /** History epoch of the snapshot (null or omitted for v1/untracked). */
  historyEpoch?: number | null;
  /** Initial replica mode while offline (defaults to "edit"). */
  mode?: SyncMode;
  /** Optional client id to bind to the hydrated replica (defaults to current clientId or 1). */
  clientId?: number;
}

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
  /** History generation of the log this replica last synced with; a change
   * means the server rewound (restore/PITR) and every cached seq is void. */
  private historyEpoch: number | null = null;
  /** Generation in which the pending local operations were authored. */
  private draftEpoch: number | null = null;
  private welcomeHead: number | null = null;
  private sequenceGap = false;
  private _caughtUp = false;
  private _blocked: string | null = null;
  /** Causal errors are derived afresh from the current history, not a rejected write. */
  private causalIssue: "missing_dependency" | "invalid_history" | null = null;
  /** ACKs have no rejection list. Keep a batch until an empty OPS fence is ACKed. */
  private awaitingFence = false;
  /** ACKs received while history is unresolved stay tied to this transport. */
  private deferredAcks: { firstSeq: number; count: number }[] = [];
  private rejectedTransport = false;
  private mode: SyncMode | null = null;
  private _offlineHydrated = false;

  constructor(readonly docId: number, private h: SyncHandlers = {}, private options: { requireMode?: boolean } = {}) {}

  /** A view projection is replaced as a whole and must never be edited. */
  get projectionOnly(): boolean { return this.mode === "view"; }
  get syncMode(): SyncMode | null { return this.mode; }
  /** True when `doc` was hydrated from an offline snapshot and has not yet completed a live welcome. */
  get offlineHydrated(): boolean { return this._offlineHydrated; }

  get unacked(): number {
    return this.inflight.reduce((n, b) => n + b.length, 0) + this.queued.length;
  }

  /** True only after this connection has received every operation through welcome's head. */
  get caughtUp(): boolean { return this._caughtUp; }
  get blocked(): string | null { return this._blocked === "table_unsupported" ? this._blocked : this.causalIssue ?? this._blocked; }
  /** Server rejection, persisted even when a causal problem is also visible. */
  get rejection(): string | null { return this._blocked; }

  private setBlocked(code: string | null) {
    const before = this.blocked;
    const changed = this._blocked !== code;
    this._blocked = code;
    if (changed || before !== this.blocked) this.h.blocked?.(this.blocked);
  }

  private blockUnsupportedTable() {
    this.deferredAcks = [];
    this.setBlocked("table_unsupported");
    this.send = null;
    this.rejectedTransport = true;
    this.refreshCaughtUp();
    this.setStatus("offline");
    this.h.error?.("table_unsupported", "当前版本无法安全显示此文档中的表格内容。");
  }

  private blockUnavailable(code: "projection_unavailable" | "protocol_incompatible", message: string) {
    this.queued = this.inflight.flat().concat(this.queued);
    this.inflight = [];
    this.deferredAcks = [];
    this.setBlocked(code);
    this.doc = null;
    this._offlineHydrated = false;
    this.send = null;
    this.rejectedTransport = true;
    this.refreshCaughtUp();
    this.setStatus("offline");
    this.h.change?.(true);
    this.h.error?.(code, message);
  }

  /** Check only once the advertised server history is fully received. */
  private inspectCausality() {
    if (!this.doc || this.welcomeHead === null || this.sequenceGap || this.lastSeq < this.welcomeHead) return;
    const pending = this.doc.pendingIds();
    let next: "missing_dependency" | "invalid_history" | null = null;
    if (pending.length) {
      // Quarantined ops were never applied to this replica; unresolved ops in
      // the replayed server history cannot be attributed to the local draft.
      const local = new Set(this._blocked === "history_changed" ? [] : this.pendingOps().map((op) => idKey(op.id)));
      next = pending.some((id) => !local.has(idKey(id))) ? "invalid_history" : "missing_dependency";
    }
    const before = this.blocked;
    const previousIssue = this.causalIssue;
    this.causalIssue = next;
    if (next) this.setStatus("syncing");
    if (before !== this.blocked) this.h.blocked?.(this.blocked);
    if (next && next !== previousIssue) {
      this.h.error?.(next, next === "missing_dependency" ? "本地草稿依赖的内容尚不可用，草稿已保留。" : "服务器历史包含无法解析的操作，已暂停同步。");
    }
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
    if (!this.send || !this.caughtUp || this.blocked || this.awaitingFence || this.inflight.length || this.queued.length || this.lastSeq <= this.safeSeq) return;
    this.safeSeq = this.lastSeq;
    this.send(encodeClientMsg({ type: "ack", seq: this.safeSeq }));
  }

  /** History epoch this replica last synced with (null = v1 server / first contact). */
  get epoch(): number | null { return this.historyEpoch; }
  /** Null means the draft predates epoch tracking or came from a v1 server. */
  get pendingHistoryEpoch(): number | null { return this.draftEpoch; }

  /** Attach a freshly opened transport. */
  open(send: (b: Uint8Array) => void) {
    if (this._blocked === "table_unsupported") { this.setStatus("offline"); return; }
    if (this.doc?.hasTables() || this.pendingOps().some((op) => op.t === "ttable")) { this.blockUnsupportedTable(); return; }
    this.send = send;
    this.welcomeHead = null;
    this.sequenceGap = false;
    this.refreshCaughtUp();
    this.setStatus("connecting");
    // The server also treats HELLO.lastSeq as an acknowledgement. Do not
    // advertise sequences received while local work remained unconfirmed.
    // On first contact the transport advertises v2 support separately (the
    // web transport uses ?protocol=2); the v1 frame remains safe for old
    // servers, which ignore the hint and return a v1 WELCOME. Once a v2
    // WELCOME establishes an epoch, subsequent HELLOs include it.
    const hello: ClientMsg = this.historyEpoch === null
      ? { type: "hello", docId: this.docId, clientId: this.clientId, lastSeq: this.safeSeq }
      : { type: "hello", docId: this.docId, clientId: this.clientId, lastSeq: this.safeSeq, historyEpoch: this.historyEpoch };
    send(encodeClientMsg(hello));
  }

  /** Transport closed: keep unacked ops for the next connection. */
  close() {
    this.send = null;
    this.welcomeHead = null;
    this.refreshCaughtUp();
    this.queued = this.inflight.flat().concat(this.queued);
    this.inflight = [];
    this.awaitingFence = false;
    this.deferredAcks = [];
    this.rejectedTransport = false;
    this.peers.clear();
    this.h.peers?.([]);
    this.setStatus("offline");
  }

  /** Records locally generated ops (already applied to `doc`) and sends them when possible. */
  push(ops: (Op | null)[]) {
    if (!this.unacked && ops.some((op) => op !== null)) this.draftEpoch = this.historyEpoch;
    for (const op of ops) if (op) this.queued.push(op);
    this.h.change?.(false);
    if (ops.some((op) => op?.t === "ttable")) { this.blockUnsupportedTable(); return; }
    if (this.projectionOnly && ops.some((op) => op !== null)) this.setBlocked("read_only");
    this.flush();
  }

  private flush() {
    // ACKs have no batch identifiers, so never have two batches outstanding.
    if (!this.send || this.projectionOnly || this.status === "connecting" || !this.caughtUp || this.blocked || this.inflight.length || this.queued.length === 0) return;
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

  /** Encodes the current local CRDT replica state for offline persistence. */
  exportSnapshot(): Uint8Array | null {
    return this.doc ? this.doc.encodeState() : null;
  }

  /**
   * Hydrates `doc` from a locally persisted CRDT snapshot while disconnected
   * so offline reading/editing works immediately. Never clobbers an active
   * replica, replays restored pending ops when safe, and seamlessly merges
   * with server state upon the next `welcome`.
   */
  hydrateOffline(snapshot: Uint8Array, options: OfflineHydrateOptions = {}): boolean {
    if (this.doc || this._blocked === "table_unsupported") return false;
    if (options.seq != null && (!Number.isSafeInteger(options.seq) || options.seq < 0)) {
      throw new RangeError("invalid offline sequence");
    }
    if (options.historyEpoch != null && (!Number.isSafeInteger(options.historyEpoch) || options.historyEpoch < 1)) {
      throw new RangeError("invalid offline history epoch");
    }
    const cid = options.clientId ?? (this.clientId || 1);
    const hydrated = Doc.fromState(cid, snapshot);
    const pending = this.pendingOps();
    if (hydrated.hasTables() || pending.some((op) => op.t === "ttable")) {
      this.blockUnsupportedTable();
      return false;
    }
    const mode: SyncMode = options.mode ?? "edit";
    const epochMismatch = options.historyEpoch != null && this.draftEpoch !== null && this.draftEpoch !== options.historyEpoch;
    if (mode === "edit" && this._blocked !== "history_changed" && !epochMismatch) {
      for (const op of pending) hydrated.apply(op);
    }
    this.doc = hydrated;
    this.clientId = cid;
    this.lastSeq = options.seq ?? 0;
    if (options.historyEpoch != null) this.historyEpoch = options.historyEpoch;
    this.mode = mode;
    this._offlineHydrated = true;
    if (!this.send) this.setStatus("offline");
    this.h.change?.(true);
    return true;
  }

  /** Retry retained writes after the caller has checked access/connection state. */
  retryPending() {
    if (this.projectionOnly || !this._blocked || this._blocked === "table_unsupported" || this._blocked === "history_changed" || this.causalIssue) return;
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
   * the first connection. Epoch-aware drafts are replayed only against the
   * same history. Unknown or changed epochs are retained for manual recovery.
   */
  restore(clientId: number, ops: Op[], blocked?: string | null, historyEpoch?: number | null) {
    if (this.doc) throw new Error("restore before the first connection");
    if (historyEpoch != null && (!Number.isSafeInteger(historyEpoch) || historyEpoch < 1)) throw new RangeError("invalid draft history epoch");
    this.clientId = clientId;
    this.draftEpoch = historyEpoch ?? null;
    if (historyEpoch != null) this.historyEpoch = historyEpoch;
    this.queued = ops.concat(this.queued);
    if (blocked && ops.length && blocked !== "missing_dependency" && blocked !== "invalid_history") this.setBlocked(blocked);
  }

  /** Explicitly discard only a quarantined draft after the caller backs it up. */
  discardQuarantined(): boolean {
    if (this._blocked !== "history_changed" || this.causalIssue || !this.caughtUp || this.inflight.length || !this.queued.length) return false;
    this.queued = [];
    this.draftEpoch = null;
    this.setBlocked(null);
    this.h.change?.(false);
    this.setStatus("synced");
    this.acknowledgeIfSafe();
    return true;
  }

  setAwareness(state: unknown) {
    this.awareness = JSON.stringify(state);
    this.send?.(encodeClientMsg({ type: "aware", state: this.awareness }));
  }

  private emitPeers() {
    this.h.peers?.([...this.peers].map(([clientId, state]) => ({ clientId, state })));
  }

  private handleAck(m: { firstSeq: number; count: number }) {
    if (this.sequenceGap) return;
    // A failed batch is never acknowledged by current servers. A late or
    // stray ACK must not remove the retained batch while writes are blocked.
    if (this.causalIssue && !this._blocked && this.inflight.length) {
      // The data ACK occupies sequence numbers even though we cannot finish
      // confirming the batch yet. Advance only over a contiguous range so
      // following remote OPS can supply the missing causal dependency.
      const previous = this.deferredAcks[0];
      if (previous) {
        if (previous.firstSeq !== m.firstSeq || previous.count !== m.count) this.gap("conflicting deferred ACK");
        return;
      }
      if (this.awaitingFence && m.count !== 0) {
        this.gap("non-empty ACK for sync fence");
        return;
      }
      if (m.count > 0 && m.firstSeq > this.lastSeq + 1) {
        this.gap(`ack out of order: expected seq ${this.lastSeq + 1}, got ${m.firstSeq}`);
        return;
      }
      if (m.count > 0) this.lastSeq = Math.max(this.lastSeq, m.firstSeq + m.count - 1);
      this.deferredAcks.push({ firstSeq: m.firstSeq, count: m.count });
      this.refreshCaughtUp();
      return;
    }
    if (this.blocked || !this.inflight.length) return;
    if (this.awaitingFence) {
      if (m.count !== 0) { this.gap("non-empty ACK for sync fence"); return; }
      this.awaitingFence = false;
      this.inflight.shift();
      if (!this.inflight.length && !this.queued.length) this.draftEpoch = null;
      this.flush();
      this.acknowledgeIfSafe();
      if (this.caughtUp && !this.blocked && !this.inflight.length && !this.queued.length) this.setStatus("synced");
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

  private drainDeferredAcks() {
    while (!this.blocked && this.deferredAcks.length) {
      this.handleAck(this.deferredAcks.shift()!);
    }
  }

  receive(bytes: Uint8Array) {
    // Once incompatible content is reported, neither a late welcome nor an
    // ACK from this transport may expose a partial view or clear local work.
    if (this._blocked === "table_unsupported") return;
    const m = decodeServerMsg(bytes);
    switch (m.type) {
      case "welcome": {
        const incomingMode = "mode" in m ? m.mode : null;
        if ((this.options.requireMode || (this.mode !== null && !this._offlineHydrated)) && incomingMode === null) {
          this.blockUnavailable("protocol_incompatible", "服务器未确认只读同步模式，已停止同步并保留本地草稿。");
          throw new Error("sync mode negotiation required");
        }
        if (incomingMode !== null && (!Number.isSafeInteger(m.clientId) || m.clientId < 1 || !Number.isSafeInteger(m.headSeq) || m.headSeq < 0 || !m.snapshot || m.snapshot.seq !== m.headSeq)) {
          throw new Error("sync mode requires a complete snapshot");
        }
        const snapshot = m.snapshot ? Doc.fromState(m.clientId, m.snapshot.state) : null;
        if (snapshot?.hasTables() || this.doc?.hasTables() || this.pendingOps().some((op) => op.t === "ttable")) { this.blockUnsupportedTable(); return; }
        // A changed epoch invalidates every cached seq even at an unchanged
        // head: the log itself is a different generation (restore/PITR).
        const epoch = "historyEpoch" in m ? m.historyEpoch : undefined;
        if (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 1)) {
          this.h.error?.("invalid_epoch", "服务器返回了无效的历史代际，已停止同步并保留本地草稿。");
          throw new Error("invalid sync history epoch");
        }
        if (epoch === undefined && this.historyEpoch !== null) {
          this.h.error?.("protocol_downgrade", "服务器未确认历史代际，已停止同步并保留本地草稿。");
          throw new Error("sync protocol downgrade after epoch negotiation");
        }
        // Moving from a v1 connection with a cached replica to v2 is also a
        // generation change: v1 sequences cannot be tied to any epoch.
        const pending = this.inflight.flat().concat(this.queued);
        if (this._blocked === "projection_unavailable" || this._blocked === "protocol_incompatible") this.setBlocked(pending.length ? incomingMode === "view" ? "read_only" : "not_ready" : null);
        const epochChanged = epoch !== undefined && epoch !== this.historyEpoch && this.doc !== null;
        // A stale or unidentifiable draft must not be replayed on a new
        // generation: character IDs may now refer to different content.
        const staleDraft = pending.length > 0 && (this._blocked === "history_changed" || epoch !== undefined && (this.draftEpoch === null || this.draftEpoch !== epoch));
        const readonlyDraft = pending.length > 0 && incomingMode === "view";
        const quarantine = staleDraft || readonlyDraft;
        const newlyQuarantined = staleDraft && this._blocked !== "history_changed";
        if (epochChanged) {
          this.lastSeq = 0;
          this.safeSeq = 0;
          this.droppedOnResync++;
        }
        if (epoch !== undefined) this.historyEpoch = epoch;
        this.mode = incomingMode;
        this._offlineHydrated = false;
        this.inflight = [];
        this.awaitingFence = false;
        this.deferredAcks = [];
        // Keep the draft owned even if a callback or snapshot application throws.
        this.queued = pending;
        let rebuilt = false;
        if (m.snapshot || !this.doc || m.clientId !== this.clientId || epochChanged || newlyQuarantined) {
          this.h.beforeRemote?.();
          const fresh = snapshot ?? new Doc(m.clientId);
          if (!m.snapshot && this.doc && m.clientId !== this.clientId && !epochChanged && !newlyQuarantined) {
            // server issued a new client id but no snapshot: keep our state, switch id
            this.doc.client = m.clientId;
          } else {
            if (!quarantine) for (const op of pending) fresh.apply(op);
            this.doc = fresh;
            rebuilt = true;
          }
          this.lastSeq = m.snapshot ? m.snapshot.seq : this.doc && !rebuilt ? this.lastSeq : 0;
        }
        this.clientId = m.clientId;
        this.safeSeq = Math.min(this.safeSeq, m.headSeq);
        if (newlyQuarantined) {
          this.setBlocked("history_changed");
          this.h.error?.("history_changed", "文档历史已变化或草稿版本无法确认，本地草稿未自动合并。");
        }
        if (readonlyDraft && !staleDraft) this.setBlocked("read_only");
        this.welcomeHead = m.headSeq;
        this.sequenceGap = this.lastSeq > m.headSeq;
        this.inspectCausality();
        this.refreshCaughtUp();
        this.setStatus(pending.length || !this.caughtUp ? "syncing" : "synced");
        if (this.sequenceGap) {
          this.h.error?.("gap", `welcome head ${m.headSeq} is behind replica seq ${this.lastSeq}`);
          if (rebuilt) this.h.change?.(true);
          return;
        }
        // Wait for the advertised history before replaying local edits. The
        // nonempty queue prevents advancing the GC horizon while waiting.
        this.flush();
        if (this.awareness) this.send?.(encodeClientMsg({ type: "aware", state: this.awareness }));
        if (rebuilt) this.h.change?.(true);
        this.acknowledgeIfSafe();
        return;
      }
      case "projection": {
        if (!this.projectionOnly || this.historyEpoch !== m.historyEpoch || !Number.isSafeInteger(m.headSeq) || m.headSeq < this.lastSeq || !Number.isSafeInteger(m.historyEpoch) || m.historyEpoch < 1) {
          throw new Error("invalid read-only projection");
        }
        const fresh = Doc.fromState(this.clientId, m.state);
        if (fresh.hasTables()) { this.blockUnsupportedTable(); return; }
        this.h.beforeRemote?.();
        this.doc = fresh;
        this.lastSeq = m.headSeq;
        this.welcomeHead = m.headSeq;
        this.sequenceGap = false;
        this.inspectCausality();
        this.refreshCaughtUp();
        this.h.change?.(true);
        this.acknowledgeIfSafe();
        if (this.caughtUp && !this.blocked && !this.unacked) this.setStatus("synced");
        return;
      }
      case "ops": {
        if (this.projectionOnly) throw new Error("raw operations in read-only projection mode");
        if (!this.doc) throw new Error("ops before welcome");
        if (m.firstSeq > this.lastSeq + 1) {
          this.gap(`expected seq ${this.lastSeq + 1}, got ${m.firstSeq}`);
          return;
        }
        const ops = decodeOps(m.batch);
        if (ops.some((op) => op.t === "ttable")) { this.blockUnsupportedTable(); return; }
        // HELLO advertises the safe horizon, which can lag the applied view.
        // Replayed prefixes are already present; only apply new contiguous ops.
        const skip = Math.min(ops.length, Math.max(0, this.lastSeq + 1 - m.firstSeq));
        if (skip < ops.length) {
          this.h.beforeRemote?.();
          for (const op of ops.slice(skip)) this.doc.apply(op);
          this.lastSeq = m.firstSeq + ops.length - 1;
        }
        this.inspectCausality();
        this.refreshCaughtUp();
        this.drainDeferredAcks();
        if (skip < ops.length) this.h.change?.(true);
        this.flush();
        this.acknowledgeIfSafe();
        if (this.caughtUp && !this.blocked && !this.inflight.length && !this.queued.length) this.setStatus("synced");
        return;
      }
      case "ack":
        this.handleAck(m);
        return;
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
        if (m.code === "table_unsupported") { this.blockUnsupportedTable(); return; }
        if (m.code === "projection_unavailable") {
          this.blockUnavailable("projection_unavailable", m.message);
          return;
        }
        if (this.inflight.length && ["read_only", "not_ready", "forbidden", "bad_ops"].includes(m.code)) {
          this.deferredAcks = [];
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

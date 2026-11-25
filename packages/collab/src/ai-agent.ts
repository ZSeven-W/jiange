/**
 * AI Agent Collaborative Session (`@zseven-w/collab/ai-agent`).
 *
 * Allows an AI agent to join a real-time CRDT `Doc` as a first-class collaborator with
 * dedicated clientId, awareness presence (`thinking` | `editing` | `idle`), atomic batch
 * mutations emitting wire-encoded `Op[]` frames, and rollback safety.
 */

import { Doc } from "./doc.js";
import { encodeOps } from "./encoding.js";
import type { Op, OpId } from "./index.js";

export type AiPresenceStatus = "idle" | "thinking" | "editing";

export interface AiAwarenessState {
  agentId: string;
  agentName: string;
  clientId: number;
  status: AiPresenceStatus;
  focusBlockId?: string;
  message?: string;
  updatedAt: number;
}

export interface AiCollabBatchResult {
  ops: Op[];
  encoded: Uint8Array;
  awareness: AiAwarenessState;
}

export class AiCollabSession {
  readonly doc: Doc;
  private awareness: AiAwarenessState;
  private onAwareness?: (state: AiAwarenessState) => void;
  private onEmitOps?: (ops: Op[], encoded: Uint8Array) => void;

  constructor(options: {
    agentId: string;
    agentName?: string;
    clientId: number;
    initialState?: Uint8Array;
    onAwareness?: (state: AiAwarenessState) => void;
    onEmitOps?: (ops: Op[], encoded: Uint8Array) => void;
  }) {
    this.doc = options.initialState
      ? Doc.fromState(options.clientId, options.initialState)
      : new Doc(options.clientId);
    this.onAwareness = options.onAwareness;
    this.onEmitOps = options.onEmitOps;
    this.awareness = {
      agentId: options.agentId,
      agentName: options.agentName ?? options.agentId,
      clientId: options.clientId,
      status: "idle",
      updatedAt: Date.now(),
    };
  }

  getAwareness(): AiAwarenessState {
    return { ...this.awareness };
  }

  setPresence(status: AiPresenceStatus, focusBlockId?: string, message?: string): AiAwarenessState {
    this.awareness = {
      ...this.awareness,
      status,
      focusBlockId,
      message,
      updatedAt: Date.now(),
    };
    this.onAwareness?.(this.getAwareness());
    return this.getAwareness();
  }

  /** Apply remote collaborator ops into the AI agent's CRDT replica. */
  receiveRemoteOps(ops: readonly Op[]): void {
    for (const op of ops) this.doc.apply(op);
  }

  /** Execute an AI editing callback as an attributed collaborative batch, emitting wire ops. */
  runEdit(
    focusBlockId: string | undefined,
    fn: (doc: Doc, collect: (op: Op | null | undefined) => void) => void,
    message?: string,
  ): AiCollabBatchResult {
    this.setPresence("editing", focusBlockId, message);
    const ops: Op[] = [];
    const collect = (op: Op | null | undefined) => {
      if (op) ops.push(op);
    };
    try {
      fn(this.doc, collect);
    } finally {
      this.setPresence("idle", focusBlockId);
    }
    const encoded = encodeOps(ops);
    if (ops.length > 0) this.onEmitOps?.(ops, encoded);
    return { ops, encoded, awareness: this.getAwareness() };
  }

  /** Convenience helper: append a new block as an AI peer and emit the resulting CRDT ops. */
  appendParagraph(text: string, after?: OpId | null): AiCollabBatchResult & { blockId: OpId } {
    let blockId!: OpId;
    const res = this.runEdit(undefined, (doc, collect) => {
      const created = doc.createBlock("paragraph", after ?? undefined);
      blockId = created.id;
      collect(created);
      if (text) collect(doc.insertText(blockId, 0, text));
    }, "Writing paragraph");
    return { ...res, blockId };
  }
}

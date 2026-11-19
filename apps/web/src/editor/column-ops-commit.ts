import { Doc, encodeOps, eqId, ROOT, Tx, type Op, type OpId } from "@jiange/collab";
import { archiveColumn, captureColumnArchiveTarget } from "@jiange/doc-sdk/column-archive-experimental";
import { ApiError, commitConditionalOps } from "@/lib/api";

export const COLUMN_CHILD_BLOCK_CHOICES: ReadonlyArray<{ type: string; label: string }> = [
  { type: "paragraph", label: "段落" },
  { type: "h2", label: "标题" },
  { type: "bullet", label: "无序列表" },
  { type: "todo", label: "待办事项" },
  { type: "quote", label: "引用" },
  { type: "callout", label: "高亮块" },
  { type: "code", label: "代码块" },
  { type: "divider", label: "分割线" },
];

function randomRequestId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build a conditional ungroup batch that promotes every direct child column of
 * `groupId` to ROOT right after `groupId` (preserving their original IDs,
 * text, and nested child blocks) and archives the now-empty `columns` container.
 */
export function buildColumnUngroupOps(doc: Doc, groupId: OpId): Op[] | null {
  if (!doc.hasBlock(groupId)) return null;
  const info = doc.blockInfo(groupId);
  if (info.type !== "columns" || !eqId(info.parent, ROOT)) return null;
  const cols = doc.children(groupId);
  if (cols.length === 0) return null;

  const client = doc.client;
  if (!Number.isSafeInteger(client) || client <= 0) return null;

  // Clone the doc state to allocate strictly increasing positions and clocks
  // without mutating the live doc until the server commits (or caller applies).
  const probe = Doc.fromState(client, doc.encodeState());
  const tx = new Tx(probe);
  let after: OpId | null = groupId;
  const promoteSubtree = (blockId: OpId) => {
    const nested = probe.children(blockId);
    tx.move(blockId, after, ROOT);
    after = blockId;
    for (const child of nested) promoteSubtree(child);
  };
  for (const col of cols) {
    promoteSubtree(col);
  }

  // Capture the now-empty columns group and append its 4-op archive batch.
  const target = captureColumnArchiveTarget(probe, ROOT, groupId);
  if (!target) return null;
  if (!archiveColumn(tx, target)) return null;
  return [...tx.ops];
}

export type ConditionalColumnOutcome = "committed" | "column_limit" | "conflict" | "error";

export async function submitConditionalColumnOps(params: {
  docId: number;
  userId: number;
  historyEpoch: number;
  expectedSeq: number;
  ops: Op[];
}): Promise<ConditionalColumnOutcome> {
  const controller = new AbortController();
  const timer = typeof window !== "undefined" ? window.setTimeout(() => controller.abort(), 15_000) : null;
  try {
    await commitConditionalOps({
      docId: params.docId,
      userId: params.userId,
      historyEpoch: params.historyEpoch,
      expectedSeq: params.expectedSeq,
      requestId: randomRequestId(),
      batch: encodeOps(params.ops),
      opCount: params.ops.length,
      signal: controller.signal,
    });
    return "committed";
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === "column_limit") return "column_limit";
      if (err.status === 409) return "conflict";
    }
    return "error";
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

import type { ClipBlock } from "./model";
import { ApiError } from "@/lib/api";

export type ClipboardAssets = { sourceDocId: number; fileIds: number[] };
export type ClipboardAssetPlan = { ok: true; assets: ClipboardAssets | null } | { ok: false; message: string };

function fileID(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && String(id) === value ? id : null;
}

function references(block: ClipBlock): number[] | null {
  const ids: number[] = [];
  if ((block.type === "image" || block.type === "file" || block.type === "audio" || block.type === "video") && block.props.fileId) {
    const id = fileID(block.props.fileId); if (id === null) return null; ids.push(id);
  }
  if (block.type === "flowchart") for (const [key, value] of Object.entries(block.props)) {
    if (!key.startsWith("fc.n.") || !value) continue;
    try {
      const node: unknown = JSON.parse(value);
      if (!node || typeof node !== "object" || Array.isArray(node)) return null;
      const item = node as Record<string, unknown>;
      if (item.shape === "image" && item.fileId !== undefined && item.fileId !== null) {
        const id = fileID(item.fileId); if (id === null) return null; ids.push(id);
      }
    } catch { return null; }
  }
  return ids;
}

/** Never guess the origin or source document for a copied file ID. */
export function planClipboardAssets(blocks: readonly ClipBlock[], origin: string): ClipboardAssetPlan {
  let sourceDocId: number | null = null;
  const ids = new Set<number>();
  for (const block of blocks) {
    const refs = references(block);
    if (!refs) return { ok: false, message: "剪贴板中的附件引用无效，未粘贴。" };
    if (!refs.length) continue;
    const source = block.source;
    if (!source || source.origin !== origin || !Number.isSafeInteger(source.docId) || source.docId <= 0) return { ok: false, message: "无法确认附件来源，请在当前站点的源文档中重新复制。" };
    if (sourceDocId !== null && sourceDocId !== source.docId) return { ok: false, message: "暂不支持一次粘贴来自多个文档的附件。" };
    sourceDocId = source.docId;
    for (const id of refs) ids.add(id);
  }
  if (ids.size > 100) return { ok: false, message: "一次最多粘贴 100 个不同附件。" };
  return { ok: true, assets: sourceDocId === null ? null : { sourceDocId, fileIds: [...ids].sort((a, b) => a - b) } };
}

/** Replace only known attachment references after the server validates them. */
export function remapClipboardAssets(blocks: readonly ClipBlock[], assets: ClipboardAssets, value: unknown, targetDocId: number): ClipBlock[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const mapping = value as Record<string, number>;
  const entries = Object.entries(mapping);
  if (entries.length !== assets.fileIds.length || entries.some(([key, value]) => !assets.fileIds.includes(Number(key)) || String(Number(key)) !== key || !Number.isSafeInteger(value) || value <= 0)) return null;
  const targets = assets.fileIds.map((id) => mapping[String(id)]);
  if (targets.some((id) => !id) || new Set(targets).size !== targets.length) return null;
  if (assets.sourceDocId !== targetDocId && targets.some((id) => assets.fileIds.includes(id))) return null;
  try {
    return blocks.map((block) => {
      const props = { ...block.props };
      if ((block.type === "image" || block.type === "file" || block.type === "audio" || block.type === "video") && props.fileId) props.fileId = String(mapping[props.fileId]);
      if (block.type === "flowchart") for (const [key, value] of Object.entries(props)) {
        if (!key.startsWith("fc.n.") || !value) continue;
        const node = JSON.parse(value) as Record<string, unknown>;
        if (node.shape === "image" && node.fileId !== undefined && node.fileId !== null) props[key] = JSON.stringify({ ...node, fileId: mapping[String(node.fileId)] });
      }
      return { ...block, props };
    });
  } catch { return null; }
}

type CopyAssets = (sourceDocId: number, fileIds: number[], requestId: string, signal: AbortSignal) => Promise<{ mapping: Record<string, number> }>;

/** Retry an unknown result using the same request ID; never repeat a denied request. */
export async function copyClipboardAssetsWithRetry(
  copy: CopyAssets,
  blocks: readonly ClipBlock[],
  assets: ClipboardAssets,
  requestId: string,
  targetDocId: number,
  signal: AbortSignal,
  canContinue: () => boolean,
  timeoutMs = 15_000,
): Promise<ClipBlock[]> {
  let lastError: unknown = new Error("copy unavailable");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted || !canContinue()) throw new Error("paste changed");
    const local = new AbortController();
    const cancel = () => local.abort();
    signal.addEventListener("abort", cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        copy(assets.sourceDocId, assets.fileIds, requestId, local.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { local.abort(); reject(new Error("copy timeout")); }, timeoutMs); }),
      ]);
      const remapped = remapClipboardAssets(blocks, assets, result?.mapping, targetDocId);
      if (!remapped) throw new Error("invalid copy response");
      if (signal.aborted || !canContinue()) throw new Error("paste changed");
      return remapped;
    } catch (error) {
      lastError = error;
      if (signal.aborted || !canContinue() || error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  }
  throw lastError;
}

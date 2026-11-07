import { eqId, type OpId, type Tx } from "@jiange/collab";
import { insertSlashBlock, type SlashInsertion } from "./slashInsert";
import type { Pos } from "./model";

export interface UploadedAsset { id: number; name: string; mime: string; size: number }

/** Async uploads must not attach to a block moved or converted by a peer. */
export function uploadTargetUnchanged(captured: SlashInsertion, type: string, parent: OpId, boundaryIds?: readonly OpId[]): boolean {
  const { doc, anchor } = captured;
  if (!doc.hasBlock(anchor)) return false;
  const current = doc.blockInfo(anchor);
  if (current.type !== type || !eqId(current.parent, parent)) return false;
  if (!boundaryIds) return true;
  const ids = doc.visibleIds(anchor);
  return ids.length === boundaryIds.length && boundaryIds.every((id, i) => eqId(id, ids[i]));
}

/** Check the exact command before sending file bytes, without mutating the document. */
export function validateUploadCommand(captured: SlashInsertion): "ok" | "middle" | "changed" {
  if (!captured.doc.hasBlock(captured.anchor)) return "changed";
  if (!captured.commandIds) return "ok";
  const ids = captured.doc.visibleIds(captured.anchor);
  const start = ids.findIndex((id) => eqId(id, captured.commandIds![0]));
  if (start < 0 || captured.commandIds.some((id, i) => !ids[start + i] || !eqId(id, ids[start + i]))) return "changed";
  if (captured.doc.richChars(captured.anchor).slice(start, start + captured.commandIds.length).some((char) => !!char.marks.math)) return "changed";
  return start > 0 && start + captured.commandIds.length < ids.length ? "middle" : "ok";
}

/** Insert uploaded assets without replacing a paragraph that peers may edit. */
export function insertUploadedFiles(tx: Tx, captured: SlashInsertion, assets: readonly UploadedAsset[]): Pos | "middle" | null {
  if (!assets.length) return null;
  let insertion = captured;
  let result: Pos | "middle" | null = null;
  for (const asset of assets) {
    const type = /^image\//i.test(asset.mime) && !/^image\/svg\+xml(?:\s*;|$)/i.test(asset.mime) ? "image" : "file";
    result = insertSlashBlock(tx, insertion, type, { fileId: String(asset.id), name: asset.name, mime: asset.mime, size: String(asset.size) });
    if (!result || result === "middle") return result;
    insertion = { doc: tx.doc, anchor: result.b, beforeAnchor: true, commandIds: null };
  }
  return result;
}

import type { AppNotification } from "./api";

function validId(value: string, allowSystem: boolean): boolean {
  const m = /^(0|[1-9]\d{0,15}):([1-9]\d{0,15})$/.exec(value);
  return !!m && Number.isSafeInteger(Number(m[1])) && Number.isSafeInteger(Number(m[2])) && (allowSystem || Number(m[1]) > 0);
}

export function mentionNotificationHash(n: AppNotification): string {
  if (!Number.isSafeInteger(n.docId) || n.docId <= 0) return "#/";
  const base = `#/doc/${n.docId}`;
  if (n.kind !== "mention" || n.commentId || !n.anchorBlock || !n.anchorChar || !validId(n.anchorBlock, true) || !validId(n.anchorChar, false) || !Number.isSafeInteger(n.anchorEpoch) || n.anchorEpoch! <= 0) return base;
  return `${base}?${new URLSearchParams({ block: n.anchorBlock, mention: n.anchorChar, epoch: String(n.anchorEpoch) })}`;
}

export function parseMentionNotificationHash(hash: string, docId: number): { block: string; char: string; epoch: number } | null {
  const m = /^#\/doc\/(\d+)\?(.+)$/.exec(hash);
  if (!m || Number(m[1]) !== docId) return null;
  const p = new URLSearchParams(m[2]);
  if (["block", "mention", "epoch"].some((key) => p.getAll(key).length !== 1)) return null;
  const block = p.get("block")!, char = p.get("mention")!, rawEpoch = p.get("epoch")!;
  if (!validId(block, true) || !validId(char, false) || !/^[1-9]\d{0,15}$/.test(rawEpoch)) return null;
  const epoch = Number(rawEpoch); return Number.isSafeInteger(epoch) ? { block, char, epoch } : null;
}

import type { SlideTitleDraft } from "./slide-deck-title";

const key = (userId: number, deckId: number) => `jiange:slides-title:${userId}:${deckId}`;

export function readSlideTitleDraft(storage: Pick<Storage, "getItem">, userId: number, deckId: number): SlideTitleDraft | null {
  try {
    const raw = storage.getItem(key(userId, deckId));
    if (!raw || raw.length > 20000) return null;
    const data = JSON.parse(raw) as SlideTitleDraft;
    if (typeof data.value !== "string" || typeof data.base?.title !== "string" || !Number.isSafeInteger(data.base?.revision) || data.base.revision < 0 || !["editing", "saving", "unknown"].includes(data.phase) || typeof data.error !== "string") return null;
    return data.phase === "saving" ? { ...data, phase: "unknown", error: "上次保存结果未确认，请复制输入内容并核对当前名称。" } : data;
  } catch { return null; }
}

export function writeSlideTitleDraft(storage: Pick<Storage, "setItem" | "removeItem">, userId: number, deckId: number, draft: SlideTitleDraft | null) {
  try {
    if (draft && (draft.phase !== "editing" || draft.value !== draft.base.title)) storage.setItem(key(userId, deckId), JSON.stringify(draft));
    else storage.removeItem(key(userId, deckId));
  } catch { /* Storage can be unavailable; the open editor still keeps its draft. */ }
}

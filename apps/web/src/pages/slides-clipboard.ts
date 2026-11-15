const PREFIX = "JIANGE_SLIDE_V1:";
export type SlideClipboard = { origin: string; userId: number; deckId: number; pageId: number; revision: number };

export function encodeSlideClipboard(value: SlideClipboard): string {
  return PREFIX + JSON.stringify(value);
}

export function parseSlideClipboard(text: string): SlideClipboard | null {
  if (!text.startsWith(PREFIX) || text.length > 1024) return null;
  try {
    const data = JSON.parse(text.slice(PREFIX.length));
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).sort().join(",") !== "deckId,origin,pageId,revision,userId") return null;
    if (typeof data.origin !== "string" || data.origin.length > 512) return null;
    const origin = new URL(data.origin);
    if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== data.origin) return null;
    if (![data.userId, data.deckId, data.pageId, data.revision].every((n) => Number.isSafeInteger(n) && n > 0)) return null;
    return { origin: data.origin, userId: data.userId, deckId: data.deckId, pageId: data.pageId, revision: data.revision };
  } catch { return null; }
}

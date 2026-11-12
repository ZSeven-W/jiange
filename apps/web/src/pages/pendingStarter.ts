import type { MdBlock } from "@/lib/markdown";

/** A pending import is scoped to the signed-in user and survives page reloads in this tab. */
export interface PendingStarter {
  markdown: string;
  persistent: boolean;
  /** Pre-parsed seeds (Word import) that keep formatting Markdown cannot express. */
  blocks?: MdBlock[];
}
const pending = new Map<string, PendingStarter>();
const keyFor = (ownerId: number, docId: number) => `jiange:starter:${ownerId}:${docId}`;
const blocksKey = (key: string) => `${key}:blocks`;

function validBlocks(value: unknown): value is MdBlock[] {
  return Array.isArray(value) && value.every((b) => !!b && typeof b === "object"
    && typeof (b as MdBlock).type === "string" && typeof (b as MdBlock).text === "string"
    && !!(b as MdBlock).props && typeof (b as MdBlock).props === "object" && Array.isArray((b as MdBlock).spans));
}

export function stageStarter(ownerId: number, docId: number, markdown: string, blocks?: MdBlock[]): boolean {
  const key = keyFor(ownerId, docId);
  let persistent = false;
  try {
    sessionStorage.setItem(key, markdown);
    if (blocks) sessionStorage.setItem(blocksKey(key), JSON.stringify(blocks));
    else sessionStorage.removeItem(blocksKey(key));
    persistent = true;
  } catch {
    try { sessionStorage.removeItem(key); sessionStorage.removeItem(blocksKey(key)); } catch { /* storage unavailable */ }
    /* keep a memory fallback and warn */
  }
  pending.set(key, blocks ? { markdown, persistent, blocks } : { markdown, persistent });
  return persistent;
}
export function peekStarter(ownerId: number, docId: number): PendingStarter | undefined {
  const key = keyFor(ownerId, docId);
  const cached = pending.get(key);
  if (cached) return cached;
  try {
    const markdown = sessionStorage.getItem(key);
    if (markdown !== null) {
      const value: PendingStarter = { markdown, persistent: true };
      const raw = sessionStorage.getItem(blocksKey(key));
      if (raw !== null) {
        try { const parsed: unknown = JSON.parse(raw); if (validBlocks(parsed)) value.blocks = parsed; } catch { /* fall back to markdown */ }
      }
      pending.set(key, value);
      return value;
    }
  } catch { /* storage unavailable */ }
  return undefined;
}
export function takeStarter(ownerId: number, docId: number): PendingStarter | undefined {
  const key = keyFor(ownerId, docId);
  const value = peekStarter(ownerId, docId);
  pending.delete(key);
  try { sessionStorage.removeItem(key); sessionStorage.removeItem(blocksKey(key)); } catch { /* storage unavailable */ }
  return value;
}

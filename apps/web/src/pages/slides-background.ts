import type { SlidesPage } from "@/lib/api";

export const SLIDE_BACKGROUND_COLORS = [
  "#ffffff", "#f5f6f7", "#dee0e3", "#8f959e", "#1f2329",
  "#fbe5e1", "#fce8d5", "#fff2ce", "#e6f4d7", "#d9f0ea", "#e1eaff", "#ebe4fa",
  "#f2b7ae", "#f7cda8", "#ffe18a", "#c1e59b", "#a3ddd2", "#a6c4ff", "#cbb8f0",
  "#e25555", "#e08a38", "#f5c33b", "#64b85b", "#50b4a1", "#3370ff", "#8054cc",
] as const;

/** Keep the color popover in the viewport, opening above a low mobile panel. */
export function backgroundPopoverPosition(rect: Pick<DOMRect, "right" | "top" | "bottom">, width: number, height: number, desiredHeight: number) {
  const popoverWidth = Math.max(1, Math.min(250, width - 16));
  const left = Math.max(8, Math.min(rect.right - popoverWidth, width - popoverWidth - 8));
  const below = height - rect.bottom - 8;
  const top = below >= desiredHeight ? rect.bottom + 4 : Math.max(8, rect.top - desiredHeight - 4);
  return { left, top, width: popoverWidth, maxHeight: Math.max(1, height - top - 8) };
}

type Receipt = { id: number; revision: number; updatedAt: string };

/** A receipt may only advance the exact submitted pages by the expected amount. */
export function applyBackgroundReceipts(before: readonly SlidesPage[], background: string, value: unknown): SlidesPage[] | null {
  if (!Array.isArray(value) || value.length !== before.length || !before.length || new Set(before.map((page) => page.id)).size !== before.length || before.some((page) => !Number.isSafeInteger(page.id) || page.id <= 0 || !Number.isSafeInteger(page.revision) || page.revision < 1)) return null;
  const byId = new Map<number, Receipt>();
  for (const item of value) {
    if (!item || typeof item !== "object" || !Number.isSafeInteger(item.id) || item.id <= 0 || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt)) || byId.has(item.id)) return null;
    byId.set(item.id, item as Receipt);
  }
  const result: SlidesPage[] = [];
  for (const page of before) {
    const receipt = byId.get(page.id);
    const expected = page.revision + (page.background === background ? 0 : 1);
    if (!receipt || receipt.revision !== expected) return null;
    result.push({ ...page, background, revision: receipt.revision, updatedAt: receipt.updatedAt });
  }
  return result;
}

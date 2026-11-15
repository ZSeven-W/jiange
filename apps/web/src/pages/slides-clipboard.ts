import type { DocMeta, SlidesPage } from "@/lib/api";
import { sameSlideContent } from "./slidesDraft";
const PREFIX = "JIANGE_SLIDE_V1:";
export type SlideClipboard = { origin: string; userId: number; deckId: number; pageId: number; revision: number };

export function encodeSlideClipboard(value: SlideClipboard): string {
  return PREFIX + JSON.stringify(value);
}

export function mayCopySlide(meta: DocMeta | undefined): boolean {
  if (!meta || meta.kind !== "slides") return false;
  const rank = (role?: string) => role === "view" ? 1 : role === "edit" ? 2 : role === "manage" ? 3 : 0;
  const minimum = meta.copyMinRole || (meta.copyProtected ? "manage" : "view");
  return rank(minimum) > 0 && rank(meta.role) >= rank(minimum);
}

/** Check that the server copied all content and remapped exactly the source images. */
export function verifyCrossSlidePaste(source: SlidesPage, targetDeck: number, receipt: unknown): SlidesPage | null {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const { page, mapping } = receipt as { page?: SlidesPage; mapping?: Record<string, unknown> };
  if (!page || !mapping || typeof mapping !== "object" || Array.isArray(mapping) || !Number.isSafeInteger(page.id) || page.id <= 0 || page.id === source.id || page.slidesId !== targetDeck || page.revision !== 1 || page.hidden !== source.hidden || !Number.isFinite(page.pos) || !Array.isArray(page.shapes)) return null;
  const ids = [...new Set(source.shapes.filter((shape) => shape.kind === "image").map((shape) => shape.fileId))];
  if (ids.some((id) => !Number.isSafeInteger(id) || !id || id <= 0) || Object.keys(mapping).length !== ids.length) return null;
  const mapped = new Set<number>();
  for (const id of ids) {
    const next = mapping[String(id)];
    if (!Number.isSafeInteger(next) || (next as number) <= 0 || next === id || mapped.has(next as number)) return null;
    mapped.add(next as number);
  }
  const shapes = source.shapes.map((shape) => shape.kind === "image" ? { ...shape, fileId: mapping[String(shape.fileId)] as number } : shape);
  return sameSlideContent({ ...source, shapes }, page) ? page : null;
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

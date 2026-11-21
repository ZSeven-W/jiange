import type { SlidesPage } from "./model.js";

/** Presentation order keeps editor order while omitting hidden pages. */
export function playableSlides(pages: readonly SlidesPage[]): SlidesPage[] {
  return pages.filter((page) => !page.hidden);
}

/** Start at the selected visible page, or the next visible page, then wrap. */
export function presentationStart(pages: readonly SlidesPage[], currentId: number | null): SlidesPage | null {
  const visible = playableSlides(pages);
  if (!visible.length) return null;
  const selected = pages.findIndex((page) => page.id === currentId);
  if (selected < 0) return visible[0];
  return pages.slice(selected).find((page) => !page.hidden) ?? visible[0];
}

/** Resolve playback keys in visible order; modifiers and focused controls are handled by the caller. */
export function presentationKeyTarget(pages: readonly SlidesPage[], currentId: number, key: string): SlidesPage | null {
  const visible = playableSlides(pages), index = visible.findIndex((page) => page.id === currentId);
  if (index < 0) return null;
  if (key === "Home") return visible[0];
  if (key === "End") return visible[visible.length - 1];
  if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(key)) return visible[Math.min(index + 1, visible.length - 1)];
  if (["ArrowLeft", "ArrowUp", "PageUp"].includes(key)) return visible[Math.max(index - 1, 0)];
  return null;
}

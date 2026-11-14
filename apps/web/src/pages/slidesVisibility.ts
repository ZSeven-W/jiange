import type { SlidesPage } from "@/lib/api";

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

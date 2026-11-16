import type { SlideLayout } from "./model.js";

/** Preserve the existing text geometry when the master is switched to blank. */
export function blankSlideLayout(current: SlideLayout): SlideLayout {
  return current === "title" || current === "blank-title" ? "blank-title" : "blank";
}
export function isBlankSlideLayout(layout: SlideLayout | undefined): boolean {
  return layout === "blank" || layout === "blank-title";
}
export function hasLargeSlideTitle(layout: SlideLayout | undefined): boolean {
  return layout === "title" || layout === "blank-title";
}

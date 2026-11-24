import type { CSSProperties } from "react";
import type { SlidesPage } from "@/lib/api";

export type SlideTransitionKind = "none" | "fade" | "push" | "wipe";

export type SlideTransitionMap = Record<number, SlideTransitionKind>;

export interface SlideTransitionOption {
  value: SlideTransitionKind;
  label: string;
}

export const SLIDE_TRANSITION_OPTIONS: readonly SlideTransitionOption[] = [
  { value: "none", label: "无" },
  { value: "fade", label: "淡入淡出" },
  { value: "push", label: "推入" },
  { value: "wipe", label: "擦除" },
] as const;

export const SLIDE_TRANSITION_DURATION_MS = 380;
export const SLIDE_TRANSITION_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

export const SLIDE_TRANSITION_KEYFRAMES_CSS = `
@keyframes jiange-slide-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes jiange-slide-push {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
@keyframes jiange-slide-wipe {
  from { clip-path: inset(0 100% 0 0); }
  to { clip-path: inset(0 0 0 0); }
}
`;

export function isSlideTransitionKind(value: unknown): value is SlideTransitionKind {
  return value === "none" || value === "fade" || value === "push" || value === "wipe";
}

/** Hydrate per-page slide transitions directly from cloud-persisted page.meta. */
export function hydrateSlideTransitions(
  pages: readonly Pick<SlidesPage, "id" | "meta">[] | undefined,
): SlideTransitionMap {
  if (!pages?.length) return {};
  const result: SlideTransitionMap = {};
  for (const page of pages) {
    const transition = page.meta?.transition;
    if (isSlideTransitionKind(transition) && transition !== "none") {
      result[page.id] = transition;
    }
  }
  return result;
}

export function slideTransitionsStorageKey(deckId: number): string {
  return `jiange:slides:transitions:${deckId}`;
}

export function loadSlideTransitions(deckId: number): SlideTransitionMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(slideTransitionsStorageKey(deckId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: SlideTransitionMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      const pageId = Number(key);
      if (Number.isSafeInteger(pageId) && pageId > 0 && isSlideTransitionKind(value) && value !== "none") {
        result[pageId] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function saveSlideTransitions(deckId: number, transitions: SlideTransitionMap): void {
  if (typeof localStorage === "undefined") return;
  try {
    const clean: SlideTransitionMap = {};
    for (const [key, value] of Object.entries(transitions)) {
      const pageId = Number(key);
      if (Number.isSafeInteger(pageId) && pageId > 0 && isSlideTransitionKind(value) && value !== "none") {
        clean[pageId] = value;
      }
    }
    localStorage.setItem(slideTransitionsStorageKey(deckId), JSON.stringify(clean));
  } catch {
    // Ignore storage quota errors
  }
}

export function getSlideTransition(
  transitions: SlideTransitionMap | undefined,
  pageId: number,
): SlideTransitionKind {
  const value = transitions?.[pageId];
  return isSlideTransitionKind(value) ? value : "none";
}

export function setSlideTransition(
  transitions: SlideTransitionMap,
  pageId: number,
  kind: SlideTransitionKind,
): SlideTransitionMap {
  const next: SlideTransitionMap = { ...transitions };
  if (kind === "none") {
    delete next[pageId];
  } else {
    next[pageId] = kind;
  }
  return next;
}

export function applyTransitionToAllPages(
  transitions: SlideTransitionMap,
  pageIds: readonly number[],
  kind: SlideTransitionKind,
): SlideTransitionMap {
  const next: SlideTransitionMap = { ...transitions };
  for (const pageId of pageIds) {
    if (kind === "none") {
      delete next[pageId];
    } else {
      next[pageId] = kind;
    }
  }
  return next;
}

export function slideTransitionAnimationStyle(
  kind: SlideTransitionKind,
): CSSProperties | undefined {
  if (kind === "none") return undefined;
  const keyframe =
    kind === "fade"
      ? "jiange-slide-fade"
      : kind === "push"
        ? "jiange-slide-push"
        : "jiange-slide-wipe";
  return {
    animation: `${keyframe} ${SLIDE_TRANSITION_DURATION_MS}ms ${SLIDE_TRANSITION_EASING} both`,
  };
}

import type { CSSProperties } from "react";
import type {
  SlideShapeAnimation,
  SlideShapeAnimationEffect,
  SlideShapeAnimationTrigger,
  SlidesPage,
} from "@/lib/api";

export type { SlideShapeAnimation, SlideShapeAnimationEffect, SlideShapeAnimationTrigger };

export type SlideAnimationOptionValue = "none" | SlideShapeAnimationEffect;

export type SlidePageShapeAnimations = Record<string, SlideShapeAnimation>;
export type SlideDeckShapeAnimations = Record<number, SlidePageShapeAnimations>;

export interface SlideAnimationOption {
  value: SlideAnimationOptionValue;
  label: string;
}

export interface SlideAnimationTriggerOption {
  value: SlideShapeAnimationTrigger;
  label: string;
}

export const DEFAULT_SLIDE_ANIMATION_DURATION_MS = 450;
export const SLIDE_ANIMATION_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const SHAPE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const SLIDE_ANIMATION_OPTIONS: readonly SlideAnimationOption[] = [
  { value: "none", label: "无动画" },
  { value: "fade-in", label: "淡入" },
  { value: "slide-up", label: "上浮入场" },
  { value: "zoom-in", label: "缩放出现" },
  { value: "bounce", label: "弹性强调" },
  { value: "pulse", label: "脉冲高亮" },
  { value: "fade-out", label: "淡出" },
] as const;

export const SLIDE_ANIMATION_TRIGGER_OPTIONS: readonly SlideAnimationTriggerOption[] = [
  { value: "click", label: "点击触发" },
  { value: "with_prev", label: "与上一动画同时" },
  { value: "after_prev", label: "上一动画之后" },
] as const;

export const SLIDE_ANIMATION_KEYFRAMES_CSS = `
@keyframes jiange-shape-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes jiange-shape-slide-up {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes jiange-shape-zoom-in {
  from { opacity: 0; transform: scale(0.75); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes jiange-shape-bounce {
  0%, 100% { transform: translateY(0); }
  30% { transform: translateY(-14px); }
  55% { transform: translateY(0); }
  75% { transform: translateY(-6px); }
}
@keyframes jiange-shape-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.08); opacity: 0.85; }
}
@keyframes jiange-shape-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
`;

export function isSlideShapeAnimationEffect(value: unknown): value is SlideShapeAnimationEffect {
  return (
    value === "fade-in" ||
    value === "slide-up" ||
    value === "zoom-in" ||
    value === "bounce" ||
    value === "pulse" ||
    value === "fade-out"
  );
}

export function isSlideShapeAnimationTrigger(value: unknown): value is SlideShapeAnimationTrigger {
  return value === "click" || value === "with_prev" || value === "after_prev";
}

export function isEntranceAnimation(effect: SlideShapeAnimationEffect): boolean {
  return effect === "fade-in" || effect === "slide-up" || effect === "zoom-in";
}

export function isExitAnimation(effect: SlideShapeAnimationEffect): boolean {
  return effect === "fade-out";
}

export function normalizeSlideShapeAnimation(raw: unknown): SlideShapeAnimation | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<SlideShapeAnimation>;
  if (!isSlideShapeAnimationEffect(candidate.effect)) return undefined;
  const order = Number(candidate.order);
  if (!Number.isInteger(order) || order < 1 || order > 100) return undefined;
  let durationMs = DEFAULT_SLIDE_ANIMATION_DURATION_MS;
  if (candidate.durationMs !== undefined) {
    const d = Number(candidate.durationMs);
    if (!Number.isInteger(d) || d < 100 || d > 5000) return undefined;
    durationMs = d;
  }
  const trigger: SlideShapeAnimationTrigger = isSlideShapeAnimationTrigger(candidate.trigger)
    ? candidate.trigger
    : candidate.trigger === undefined
      ? "click"
      : (undefined as unknown as SlideShapeAnimationTrigger);
  if (!trigger) return undefined;
  return {
    effect: candidate.effect,
    order,
    durationMs,
    trigger,
  };
}

export function normalizeSlideShapeAnimations(
  raw: Record<string, unknown> | undefined,
): SlidePageShapeAnimations | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: SlidePageShapeAnimations = {};
  let count = 0;
  for (const [shapeId, val] of Object.entries(raw)) {
    if (!SHAPE_ID_RE.test(shapeId)) continue;
    const norm = normalizeSlideShapeAnimation(val);
    if (!norm) continue;
    out[shapeId] = norm;
    count += 1;
    if (count >= 100) break;
  }
  return count > 0 ? out : undefined;
}

/** Hydrate per-page element animations directly from cloud-persisted page.meta. */
export function hydrateSlideAnimations(
  pages: readonly Pick<SlidesPage, "id" | "meta">[] | undefined,
): SlideDeckShapeAnimations {
  if (!pages?.length) return {};
  const result: SlideDeckShapeAnimations = {};
  for (const page of pages) {
    const clean = normalizeSlideShapeAnimations(page.meta?.animations as Record<string, unknown> | undefined);
    if (clean) result[page.id] = clean;
  }
  return result;
}

export function getPageShapeAnimations(
  map: SlideDeckShapeAnimations | undefined,
  pageId: number,
): SlidePageShapeAnimations {
  return map?.[pageId] ?? {};
}

export function nextSlideAnimationOrder(animations: SlidePageShapeAnimations | undefined): number {
  if (!animations) return 1;
  let maxOrder = 0;
  for (const anim of Object.values(animations)) {
    if (anim.order > maxOrder) maxOrder = anim.order;
  }
  return Math.min(100, maxOrder + 1);
}

export function setShapeAnimation(
  pageAnims: SlidePageShapeAnimations | undefined,
  shapeId: string,
  anim: SlideShapeAnimation | null,
): SlidePageShapeAnimations {
  const next: SlidePageShapeAnimations = { ...(pageAnims ?? {}) };
  if (!anim) {
    delete next[shapeId];
  } else {
    next[shapeId] = {
      effect: anim.effect,
      order: Math.max(1, Math.min(100, Math.round(anim.order))),
      durationMs: Math.max(100, Math.min(5000, Math.round(anim.durationMs ?? DEFAULT_SLIDE_ANIMATION_DURATION_MS))),
      trigger: anim.trigger ?? "click",
    };
  }
  return next;
}

export function pruneShapeAnimations(
  pageAnims: SlidePageShapeAnimations | undefined,
  existingShapeIds: ReadonlySet<string>,
): SlidePageShapeAnimations {
  if (!pageAnims) return {};
  const out: SlidePageShapeAnimations = {};
  for (const [id, anim] of Object.entries(pageAnims)) {
    if (existingShapeIds.has(id)) out[id] = anim;
  }
  return out;
}

export function sameSlideShapeAnimations(
  a: SlidePageShapeAnimations | undefined,
  b: SlidePageShapeAnimations | undefined,
): boolean {
  const keysA = a ? Object.keys(a) : [];
  const keysB = b ? Object.keys(b) : [];
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const left = a![key];
    const right = b?.[key];
    if (
      !right ||
      left.effect !== right.effect ||
      left.order !== right.order ||
      (left.durationMs ?? DEFAULT_SLIDE_ANIMATION_DURATION_MS) !== (right.durationMs ?? DEFAULT_SLIDE_ANIMATION_DURATION_MS) ||
      (left.trigger ?? "click") !== (right.trigger ?? "click")
    ) {
      return false;
    }
  }
  return true;
}

export interface SlideAnimationStepItem {
  shapeId: string;
  animation: SlideShapeAnimation;
  delayMs: number;
}

export interface SlideAnimationStep {
  step: number;
  items: SlideAnimationStepItem[];
}

/**
 * Group page element animations into click-triggered steps.
 * Items with `with_prev` or `after_prev` are grouped onto the preceding click step
 * with computed playback delays.
 */
export function buildAnimationSteps(
  animations: SlidePageShapeAnimations | undefined,
): SlideAnimationStep[] {
  if (!animations) return [];
  const ordered = Object.entries(animations)
    .filter((entry): entry is [string, SlideShapeAnimation] => isSlideShapeAnimationEffect(entry[1]?.effect))
    .sort((a, b) => {
      if (a[1].order !== b[1].order) return a[1].order - b[1].order;
      return a[0].localeCompare(b[0]);
    });
  const steps: SlideAnimationStep[] = [];
  let lastStartMs = 0;
  let lastEndMs = 0;
  for (const [shapeId, anim] of ordered) {
    const durationMs = anim.durationMs ?? DEFAULT_SLIDE_ANIMATION_DURATION_MS;
    const trigger = anim.trigger ?? "click";
    if (steps.length === 0 || trigger === "click") {
      steps.push({
        step: steps.length + 1,
        items: [{ shapeId, animation: anim, delayMs: 0 }],
      });
      lastStartMs = 0;
      lastEndMs = durationMs;
    } else if (trigger === "with_prev") {
      steps[steps.length - 1].items.push({
        shapeId,
        animation: anim,
        delayMs: lastStartMs,
      });
      lastEndMs = Math.max(lastEndMs, lastStartMs + durationMs);
    } else {
      // after_prev
      const startMs = lastEndMs;
      steps[steps.length - 1].items.push({
        shapeId,
        animation: anim,
        delayMs: startMs,
      });
      lastStartMs = startMs;
      lastEndMs = startMs + durationMs;
    }
  }
  return steps;
}

export function slideShapeAnimationPreviewStyle(
  anim: SlideShapeAnimation | undefined,
  delayMs = 0,
): CSSProperties | undefined {
  if (!anim || !isSlideShapeAnimationEffect(anim.effect)) return undefined;
  const durationMs = Math.max(100, Math.min(5000, anim.durationMs ?? DEFAULT_SLIDE_ANIMATION_DURATION_MS));
  const keyframe = `jiange-shape-${anim.effect}`;
  const delayPart = delayMs > 0 ? ` ${delayMs}ms` : "";
  return {
    animation: `${keyframe} ${durationMs}ms ${SLIDE_ANIMATION_EASING}${delayPart} both`,
  };
}

export interface ShapeAnimationPlayState {
  visible: boolean;
  style?: CSSProperties;
}

/**
 * Compute visibility and CSS animation style for a shape at a given playback step
 * (step 0 = before first click; step 1..N = after Nth click).
 */
export function shapeAnimationPlayState(
  shapeId: string,
  animations: SlidePageShapeAnimations | undefined,
  currentStep: number,
): ShapeAnimationPlayState {
  const anim = animations?.[shapeId];
  if (!anim || !isSlideShapeAnimationEffect(anim.effect)) {
    return { visible: true };
  }
  const steps = buildAnimationSteps(animations);
  let targetStep = 0;
  let delayMs = 0;
  for (const step of steps) {
    const match = step.items.find((item) => item.shapeId === shapeId);
    if (match) {
      targetStep = step.step;
      delayMs = match.delayMs;
      break;
    }
  }
  if (targetStep === 0) return { visible: true };

  if (isEntranceAnimation(anim.effect)) {
    if (currentStep < targetStep) {
      return { visible: false, style: { opacity: 0, pointerEvents: "none" } };
    }
    if (currentStep === targetStep) {
      return { visible: true, style: slideShapeAnimationPreviewStyle(anim, delayMs) };
    }
    return { visible: true };
  }

  if (isExitAnimation(anim.effect)) {
    if (currentStep < targetStep) {
      return { visible: true };
    }
    if (currentStep === targetStep) {
      return { visible: true, style: slideShapeAnimationPreviewStyle(anim, delayMs) };
    }
    return { visible: false, style: { opacity: 0, pointerEvents: "none" } };
  }

  // Emphasis animations (bounce, pulse): always visible, animate on their step.
  if (currentStep === targetStep) {
    return { visible: true, style: slideShapeAnimationPreviewStyle(anim, delayMs) };
  }
  return { visible: true };
}

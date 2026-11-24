import { describe, expect, it } from "vitest";
import type { SlidesPage } from "@/lib/api";
import {
  buildAnimationSteps,
  getPageShapeAnimations,
  hydrateSlideAnimations,
  nextSlideAnimationOrder,
  pruneShapeAnimations,
  sameSlideShapeAnimations,
  setShapeAnimation,
  shapeAnimationPlayState,
  SLIDE_ANIMATION_KEYFRAMES_CSS,
  SLIDE_ANIMATION_OPTIONS,
  SLIDE_ANIMATION_TRIGGER_OPTIONS,
  slideShapeAnimationPreviewStyle,
} from "./slides-animations";

function makePage(id: number, meta?: SlidesPage["meta"]): SlidesPage {
  return {
    id,
    slidesId: 9,
    pos: id,
    title: "",
    body: "",
    background: "",
    notes: "",
    shapes: [],
    hidden: false,
    revision: 1,
    updatedAt: "",
    ...(meta ? { meta } : {}),
  };
}

describe("slides element animations engine", () => {
  it("exports curated Feishu animation options, triggers, and CSS keyframes", () => {
    expect(SLIDE_ANIMATION_OPTIONS.map((o) => o.value)).toEqual([
      "none",
      "fade-in",
      "slide-up",
      "zoom-in",
      "bounce",
      "pulse",
      "fade-out",
    ]);
    expect(SLIDE_ANIMATION_TRIGGER_OPTIONS.map((o) => o.value)).toEqual([
      "click",
      "with_prev",
      "after_prev",
    ]);
    for (const effect of ["fade-in", "slide-up", "zoom-in", "bounce", "pulse", "fade-out"]) {
      expect(SLIDE_ANIMATION_KEYFRAMES_CSS).toContain(`@keyframes jiange-shape-${effect}`);
    }
  });

  it("hydrates valid element animations from cloud page.meta and strips invalid entries", () => {
    const pages: SlidesPage[] = [
      makePage(1),
      makePage(2, {
        animations: {
          s1: { effect: "fade-in", order: 1 },
          s2: { effect: "slide-up", order: 2, durationMs: 650, trigger: "after_prev" },
          bad: { effect: "spin" as "fade-in", order: 3 },
          zeroOrder: { effect: "pulse", order: 0 },
        },
      }),
    ];
    const hydrated = hydrateSlideAnimations(pages);
    expect(getPageShapeAnimations(hydrated, 1)).toEqual({});
    expect(getPageShapeAnimations(hydrated, 2)).toEqual({
      s1: { effect: "fade-in", order: 1, durationMs: 450, trigger: "click" },
      s2: { effect: "slide-up", order: 2, durationMs: 650, trigger: "after_prev" },
    });
    expect(hydrateSlideAnimations(undefined)).toEqual({});
  });

  it("groups with_prev and after_prev animations onto the preceding click step with delays", () => {
    const steps = buildAnimationSteps({
      s3: { effect: "zoom-in", order: 3, durationMs: 400, trigger: "after_prev" },
      s1: { effect: "fade-in", order: 1, durationMs: 500, trigger: "click" },
      s2: { effect: "slide-up", order: 2, durationMs: 300, trigger: "with_prev" },
      s4: { effect: "pulse", order: 4, durationMs: 450, trigger: "click" },
      s5: { effect: "fade-out", order: 5, durationMs: 250, trigger: "after_prev" },
    });

    expect(steps).toHaveLength(2);
    expect(steps[0].step).toBe(1);
    expect(steps[0].items.map((i) => [i.shapeId, i.delayMs])).toEqual([
      ["s1", 0],
      ["s2", 0],
      ["s3", 500],
    ]);
    expect(steps[1].step).toBe(2);
    expect(steps[1].items.map((i) => [i.shapeId, i.delayMs])).toEqual([
      ["s4", 0],
      ["s5", 450],
    ]);
  });

  it("computes play state across entrance, emphasis, exit, and unanimated shapes", () => {
    const anims = {
      enter: { effect: "slide-up" as const, order: 1, durationMs: 400, trigger: "click" as const },
      emph: { effect: "bounce" as const, order: 2, durationMs: 500, trigger: "click" as const },
      exit: { effect: "fade-out" as const, order: 3, durationMs: 300, trigger: "click" as const },
    };

    // Unanimated shape is always visible
    expect(shapeAnimationPlayState("static", anims, 0)).toEqual({ visible: true });

    // Step 0: entrance hidden; emphasis & exit visible without animation
    expect(shapeAnimationPlayState("enter", anims, 0).visible).toBe(false);
    expect(shapeAnimationPlayState("enter", anims, 0).style?.opacity).toBe(0);
    expect(shapeAnimationPlayState("emph", anims, 0)).toEqual({ visible: true });
    expect(shapeAnimationPlayState("exit", anims, 0)).toEqual({ visible: true });

    // Step 1: entrance animates in
    const enterStep1 = shapeAnimationPlayState("enter", anims, 1);
    expect(enterStep1.visible).toBe(true);
    expect(enterStep1.style?.animation).toContain("jiange-shape-slide-up 400ms");

    // Step 2: entrance settled; emphasis animates
    expect(shapeAnimationPlayState("enter", anims, 2)).toEqual({ visible: true });
    const emphStep2 = shapeAnimationPlayState("emph", anims, 2);
    expect(emphStep2.visible).toBe(true);
    expect(emphStep2.style?.animation).toContain("jiange-shape-bounce 500ms");

    // Step 3: exit animates out
    const exitStep3 = shapeAnimationPlayState("exit", anims, 3);
    expect(exitStep3.visible).toBe(true);
    expect(exitStep3.style?.animation).toContain("jiange-shape-fade-out 300ms");

    // Step 4: exit is hidden
    const exitStep4 = shapeAnimationPlayState("exit", anims, 4);
    expect(exitStep4.visible).toBe(false);
    expect(exitStep4.style?.opacity).toBe(0);
  });

  it("supports preview styles, order helpers, pruning, and equality checks", () => {
    expect(slideShapeAnimationPreviewStyle(undefined)).toBeUndefined();
    expect(
      slideShapeAnimationPreviewStyle({ effect: "zoom-in", order: 1, durationMs: 600 }, 200)?.animation,
    ).toBe("jiange-shape-zoom-in 600ms cubic-bezier(0.22, 1, 0.36, 1) 200ms both");

    let anims = setShapeAnimation({}, "s1", { effect: "fade-in", order: 1 });
    expect(nextSlideAnimationOrder(anims)).toBe(2);
    anims = setShapeAnimation(anims, "s2", { effect: "pulse", order: 2, trigger: "with_prev" });
    expect(sameSlideShapeAnimations(anims, { ...anims })).toBe(true);

    const pruned = pruneShapeAnimations(anims, new Set(["s1"]));
    expect(Object.keys(pruned)).toEqual(["s1"]);
    expect(sameSlideShapeAnimations(anims, pruned)).toBe(false);

    const cleared = setShapeAnimation(pruned, "s1", null);
    expect(cleared).toEqual({});
  });
});

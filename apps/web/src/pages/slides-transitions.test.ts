import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlidesPage } from "@/lib/api";
import {
  applyTransitionToAllPages,
  getSlideTransition,
  hydrateSlideTransitions,
  isSlideTransitionKind,
  loadSlideTransitions,
  saveSlideTransitions,
  setSlideTransition,
  SLIDE_TRANSITION_DURATION_MS,
  SLIDE_TRANSITION_EASING,
  SLIDE_TRANSITION_KEYFRAMES_CSS,
  SLIDE_TRANSITION_OPTIONS,
  slideTransitionAnimationStyle,
  slideTransitionsStorageKey,
} from "./slides-transitions";
import { SlideFormatPanel } from "./slide-format-panel";
import { PresenterView } from "./slides-presenter";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

const samplePage: SlidesPage = {
  id: 10,
  slidesId: 42,
  pos: 1,
  title: "切换动画页",
  body: "动画正文",
  notes: "",
  background: "#ffffff",
  shapes: [],
  hidden: false,
  revision: 1,
  updatedAt: "",
};

describe("slides transitions persistence and animation helpers", () => {
  const originalStorage = globalThis.localStorage;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalStorage,
      configurable: true,
      writable: true,
    });
  });

  it("exposes the 4 curated Feishu transition options and crisp CSS keyframes", () => {
    expect(SLIDE_TRANSITION_OPTIONS).toEqual([
      { value: "none", label: "无" },
      { value: "fade", label: "淡入淡出" },
      { value: "push", label: "推入" },
      { value: "wipe", label: "擦除" },
    ]);
    expect(SLIDE_TRANSITION_DURATION_MS).toBe(380);
    expect(SLIDE_TRANSITION_EASING).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(SLIDE_TRANSITION_KEYFRAMES_CSS).toContain("@keyframes jiange-slide-fade");
    expect(SLIDE_TRANSITION_KEYFRAMES_CSS).toContain("@keyframes jiange-slide-push");
    expect(SLIDE_TRANSITION_KEYFRAMES_CSS).toContain("translateX(100%)");
    expect(SLIDE_TRANSITION_KEYFRAMES_CSS).toContain("@keyframes jiange-slide-wipe");
    expect(SLIDE_TRANSITION_KEYFRAMES_CSS).toContain("clip-path: inset(0 100% 0 0)");
    expect(isSlideTransitionKind("fade")).toBe(true);
    expect(isSlideTransitionKind("zoom")).toBe(false);
  });

  it("persists per-page transitions in localStorage under jiange:slides:transitions:${deckId}", () => {
    expect(slideTransitionsStorageKey(42)).toBe("jiange:slides:transitions:42");
    expect(loadSlideTransitions(42)).toEqual({});

    let map = setSlideTransition({}, 10, "fade");
    map = setSlideTransition(map, 11, "push");
    map = setSlideTransition(map, 12, "wipe");
    saveSlideTransitions(42, map);

    expect(globalThis.localStorage.getItem("jiange:slides:transitions:42")).toBe(
      JSON.stringify({ 10: "fade", 11: "push", 12: "wipe" }),
    );
    const loaded = loadSlideTransitions(42);
    expect(loaded).toEqual({ 10: "fade", 11: "push", 12: "wipe" });
    expect(getSlideTransition(loaded, 10)).toBe("fade");
    expect(getSlideTransition(loaded, 999)).toBe("none");

    const cleared = setSlideTransition(loaded, 10, "none");
    expect(getSlideTransition(cleared, 10)).toBe("none");
    expect(10 in cleared).toBe(false);
  });

  it("recovers safely from corrupted or invalid localStorage payloads", () => {
    globalThis.localStorage.setItem(slideTransitionsStorageKey(9), "{broken-json");
    expect(loadSlideTransitions(9)).toEqual({});

    globalThis.localStorage.setItem(
      slideTransitionsStorageKey(9),
      JSON.stringify({ 1: "wipe", 2: "invalid", "-3": "fade", foo: "push", 4: "none" }),
    );
    expect(loadSlideTransitions(9)).toEqual({ 1: "wipe" });
  });

  it("applies a transition across all slide pages and clears cleanly when set to none", () => {
    const applied = applyTransitionToAllPages({ 1: "fade" }, [1, 2, 3], "push");
    expect(applied).toEqual({ 1: "push", 2: "push", 3: "push" });

    const reset = applyTransitionToAllPages(applied, [1, 2, 3], "none");
    expect(reset).toEqual({});
  });

  it("hydrates per-page transitions directly from cloud page.meta", () => {
    expect(hydrateSlideTransitions(undefined)).toEqual({});
    expect(
      hydrateSlideTransitions([
        { id: 1, meta: undefined },
        { id: 2, meta: { transition: "fade" } },
        { id: 3, meta: { transition: "none" } },
        { id: 4, meta: { transition: "wipe" } },
      ]),
    ).toEqual({ 2: "fade", 4: "wipe" });
  });

  it("produces matching 380ms animation styles and renders them in FormatPanel & PresenterView", () => {
    expect(slideTransitionAnimationStyle("none")).toBeUndefined();
    expect(slideTransitionAnimationStyle("fade")?.animation).toBe(
      "jiange-slide-fade 380ms cubic-bezier(0.22, 1, 0.36, 1) both",
    );
    expect(slideTransitionAnimationStyle("push")?.animation).toBe(
      "jiange-slide-push 380ms cubic-bezier(0.22, 1, 0.36, 1) both",
    );
    expect(slideTransitionAnimationStyle("wipe")?.animation).toBe(
      "jiange-slide-wipe 380ms cubic-bezier(0.22, 1, 0.36, 1) both",
    );

    const panelHtml = renderToStaticMarkup(
      createElement(SlideFormatPanel, {
        background: "#ffffff",
        layout: "",
        shapes: [],
        usedColors: [],
        transition: "wipe",
        canEdit: true,
        busy: false,
        applying: false,
        onChange: () => {},
        onLayoutChange: () => {},
        onMore: () => {},
        onApplyAll: () => {},
        onClose: () => {},
      }),
    );
    expect(panelHtml).toContain("切换动画");
    expect(panelHtml).toContain("预览动画");
    expect(panelHtml).toContain('data-select-value="wipe"');
    expect(panelHtml).toContain("data-slide-transition-apply-all");

    const presenterHtml = renderToStaticMarkup(
      createElement(PresenterView, {
        pages: [samplePage],
        currentId: samplePage.id,
        content: samplePage,
        contentFor: () => samplePage,
        transitions: { [samplePage.id]: "push" },
        onSelect: () => {},
        onExit: () => {},
      }),
    );
    expect(presenterHtml).toContain("@keyframes jiange-slide-push");
    expect(presenterHtml).toContain('data-slide-transition="push"');
    expect(presenterHtml).toContain("jiange-slide-push 380ms cubic-bezier(0.22, 1, 0.36, 1) both");
  });
});

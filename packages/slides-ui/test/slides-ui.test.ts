import { describe, expect, it, vi } from "vitest";
import { Presentation } from "@jiange/slides-sdk";
import { createSlidesViewComponent, mountSlidesView } from "../src/index.js";

function makeDomNode(tag: string) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    tagName: tag.toUpperCase(),
    style: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    children: [] as unknown[],
    textContent: "",
    width: 0,
    height: 0,
    clientWidth: 960,
    clientHeight: 540,
    ownerDocument: null as unknown,
    appendChild(c: unknown) { this.children.push(c); return c; },
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    remove: vi.fn(),
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 792, height: 540 }),
    addEventListener(ev: string, fn: (e: unknown) => void) {
      let s = listeners.get(ev);
      if (!s) { s = new Set(); listeners.set(ev, s); }
      s.add(fn);
    },
    removeEventListener(ev: string, fn: (e: unknown) => void) { listeners.get(ev)?.delete(fn); },
    dispatch(ev: string, payload: Record<string, unknown> = {}) {
      for (const fn of listeners.get(ev) ?? []) fn({ preventDefault: vi.fn(), ...payload });
    },
  };
}

describe("@jiange/slides-ui (WebGPU/WebGL2 Stage + Virtual Rail)", () => {
  it("renders shapes, tables, charts, selection handles, presenter mode, navigation & React adapter", async () => {
    const deck = Presentation.create({ title: "Keynote" });
    deck.addSlide({
      title: "Architecture",
      body: "WebGPU + Virtual Lists",
      shapes: [
        { id: "r1", kind: "rounded-rectangle", x: 10, y: 20, width: 25, height: 25, color: "#3370ff" },
        { id: "e1", kind: "ellipse", x: 40, y: 20, width: 15, height: 15, color: "#00b42a" },
        { id: "l1", kind: "line-arrow", x: 10, y: 55, width: 30, height: 4, color: "#1f2329" },
        { id: "t1", kind: "table", x: 55, y: 20, width: 35, height: 25, color: "#3370ff", table: { headerRow: true, rows: [["A", "B"], ["1", "2"]] } },
        { id: "c1", kind: "chart", x: 55, y: 55, width: 35, height: 30, color: "#ff7d00", chart: { type: "column", categories: ["Q1", "Q2"], series: [{ name: "S", values: [10, 25] }] } },
      ],
    });

    const fakeDoc = { createElement: (t: string) => makeDomNode(t) };
    const container = makeDomNode("div");
    container.ownerDocument = fakeDoc;

    const onSlide = vi.fn();
    const onShape = vi.fn();
    const mounted = await mountSlidesView(container as unknown as HTMLElement, deck, {
      gpu: { prefer: "headless" },
      onSlideChange: onSlide,
      onSelectShape: onShape,
    });
    const ctrl = mounted.controller;
    expect(ctrl.getSlideIndex()).toBe(0);

    // Navigate to slide 2
    const f2 = ctrl.nextSlide();
    expect(f2.slideIndex).toBe(1);
    expect(f2.gpu.rectInstances).toBeGreaterThan(5);
    expect(f2.gpu.arcInstances).toBe(1);
    expect(f2.visibleThumbnails).toBe(2);
    expect(onSlide).toHaveBeenCalledWith(1);

    // Hit-test & move shape & delete & undo
    const stage = ctrl.getStageRect();
    const canvas = (container.children[1] as ReturnType<typeof makeDomNode>).children[0] as ReturnType<typeof makeDomNode>;
    canvas.dispatch("pointerdown", { clientX: stage.x + stage.w * 0.2, clientY: stage.y + stage.h * 0.3 });
    expect(ctrl.getSelectedShapeId()).toBe("r1");
    expect(onShape).toHaveBeenCalledWith("r1");
    expect(ctrl.moveSelectedShape(5, 5)).toBe(true);
    expect(deck.getSlide(1)?.shapes[0].x).toBe(15);

    container.dispatch("keydown", { key: "Delete" });
    expect(deck.getSlide(1)?.shapes.find((s) => s.id === "r1")).toBeUndefined();
    container.dispatch("keydown", { key: "z", ctrlKey: true });
    expect(deck.getSlide(1)?.shapes.find((s) => s.id === "r1")).toBeDefined();
    container.dispatch("keydown", { key: "z", ctrlKey: true, shiftKey: true });

    // Presenter mode + arrow nav + thumbnail scroll + resize
    ctrl.setPresenterMode(true);
    expect(ctrl.isPresenterMode()).toBe(true);
    container.dispatch("keydown", { key: "ArrowLeft" });
    expect(ctrl.getSlideIndex()).toBe(0);
    container.dispatch("keydown", { key: " " });
    expect(ctrl.getSlideIndex()).toBe(1);
    ctrl.scrollThumbnails(20);
    mounted.resize(1280, 720);
    mounted.dispose();

    // React wrapper
    const cleanups: Array<() => void> = [];
    let rc = 0;
    const fakeReact = {
      useEffect: (fn: () => void | (() => void)) => { const c = fn(); if (typeof c === "function") cleanups.push(c); },
      useRef: <V>(v: V) => ({ current: rc++ === 0 ? (container as unknown as V) : v }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const SlidesView = createSlidesViewComponent(fakeReact);
    expect((SlidesView({ presentation: deck, width: 800, height: 450, gpu: { prefer: "headless" } }) as { type: string }).type).toBe("div");
    await new Promise((r) => setTimeout(r, 10));
    cleanups.forEach((c) => c());
  });

  it("covers wide stage letterbox, omitted shape dimensions, empty charts, striped tables, untitled thumbs, key guards, and React races", async () => {
    const deck = Presentation.create({ title: "" });
    deck.addSlide({
      title: "",
      body: "",
      shapes: [
        // Omitted width & height -> default 16x20 in render, hitTestShape, and moveSelectedShape
        { id: "def1", kind: "rectangle", x: 5, y: 5, color: "#3370ff" },
        // Text shape -> transparent fill + 0 radius
        { id: "txt1", kind: "text", x: 30, y: 10, width: 20, height: 10, color: "#1f2329" },
        // 3-row table -> exercises headerRow, odd row, AND even non-header row ([1,1,1,1])
        {
          id: "tbl3",
          kind: "table",
          x: 55,
          y: 10,
          width: 35,
          height: 30,
          color: "#3370ff",
          table: { headerRow: true, rows: [["H1", "H2"], ["A1", "A2"], ["B1", "B2"]] },
        },
        // Empty-series chart -> series[0]?.values ?? [] and barW fallback 10
        {
          id: "empty-chart",
          kind: "chart",
          x: 55,
          y: 50,
          width: 35,
          height: 30,
          color: "#ff7d00",
          chart: { type: "column", categories: [], series: [] },
        },
      ],
    });

    const fakeDoc = { createElement: (t: string) => makeDomNode(t) };
    const zeroContainer = makeDomNode("div");
    zeroContainer.clientWidth = 0;
    zeroContainer.clientHeight = 0;
    zeroContainer.ownerDocument = fakeDoc;

    // Mount with zero dimensions + omitted options to test fallback 960x540
    const mounted = await mountSlidesView(zeroContainer as unknown as HTMLElement, deck);
    const ctrl = mounted.controller;

    // Wide aspect ratio triggers h > availH clamping in getStageRect()
    ctrl.resize(1600, 360);
    const wideStage = ctrl.getStageRect();
    expect(wideStage.h).toBeCloseTo(360 - 56, 5);
    expect(wideStage.w).toBeCloseTo(wideStage.h * (16 / 9), 5);

    // Navigate to slide 1 (untitled)
    const frame = ctrl.goToSlide(1);
    expect(frame.slideIndex).toBe(1);
    const rail = zeroContainer.children[0] as ReturnType<typeof makeDomNode>;
    const thumbTexts = (rail.children as ReturnType<typeof makeDomNode>[]).map((c) => c.textContent);
    expect(thumbTexts.some((t) => t.includes("Untitled"))).toBe(true);

    // Hit-test miss on empty area + moveSelectedShape guards
    expect(ctrl.moveSelectedShape(2, 2)).toBe(false);
    expect(ctrl.handlePointerDown(wideStage.x + wideStage.w * 0.99, wideStage.y + wideStage.h * 0.99)).toBeNull();
    expect(ctrl.getSelectedShapeId()).toBeNull();

    // Select a non-existent shape id -> moveSelectedShape returns false
    ctrl.selectShape("missing-id");
    expect(ctrl.moveSelectedShape(2, 2)).toBe(false);

    // Hit-test shape with default width/height & move it & delete with Backspace
    const hitDef = ctrl.handlePointerDown(wideStage.x + wideStage.w * 0.1, wideStage.y + wideStage.h * 0.12);
    expect(hitDef?.id).toBe("def1");
    expect(ctrl.moveSelectedShape(2, 3)).toBe(true);
    expect(ctrl.handleKeyDown("Backspace")).toBe(true);
    expect(deck.getSlide(1)?.shapes.find((s) => s.id === "def1")).toBeUndefined();

    // Unhandled key & Delete with nothing selected & space when not in presenter mode
    expect(ctrl.handleKeyDown("Delete")).toBe(false);
    expect(ctrl.handleKeyDown(" ")).toBe(false);
    expect(ctrl.handleKeyDown("x")).toBe(false);
    zeroContainer.dispatch("keydown", { key: "x" });

    // PageDown / PageUp / ArrowRight / metaKey undo
    expect(ctrl.handleKeyDown("PageUp")).toBe(true);
    expect(ctrl.getSlideIndex()).toBe(0);
    expect(ctrl.handleKeyDown("PageDown")).toBe(true);
    expect(ctrl.getSlideIndex()).toBe(1);
    expect(ctrl.handleKeyDown("z", { metaKey: true })).toBe(true);

    // Delete current slide externally so deck.getSlide(this.slideIndex) is undefined -> hitTestShape returns null
    deck.deleteSlide(1);
    expect(ctrl.hitTestShape(100, 100)).toBeNull();

    mounted.dispose();

    // React wrapper: missing width/height ("100%"), null hostRef early return, and unmount race before mount resolves
    const nullCleanups: Array<() => void> = [];
    const nullReact = {
      useEffect: (fn: () => void | (() => void)) => {
        const c = fn();
        if (typeof c === "function") nullCleanups.push(c);
      },
      useRef: <V>(v: V) => ({ current: v }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const NullSlidesView = createSlidesViewComponent(nullReact);
    const fullNode = NullSlidesView({ presentation: deck }) as { props: { style: { width: string; height: string } } };
    expect(fullNode.props.style).toEqual({ width: "100%", height: "100%" });
    expect(nullCleanups).toHaveLength(0);

    const raceContainer = makeDomNode("div");
    raceContainer.ownerDocument = fakeDoc;
    const raceCleanups: Array<() => void> = [];
    let raceRef = 0;
    const raceReact = {
      useEffect: (fn: () => void | (() => void)) => {
        const c = fn();
        if (typeof c === "function") raceCleanups.push(c);
      },
      useRef: <V>(v: V) => ({ current: raceRef++ === 0 ? (raceContainer as unknown as V) : v }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const RaceSlidesView = createSlidesViewComponent(raceReact);
    RaceSlidesView({ presentation: deck, gpu: { prefer: "headless" } });
    // Invoke cleanup BEFORE async mountSlidesView resolves -> hits `if (!alive) v.dispose()`
    raceCleanups.forEach((c) => c());
    await new Promise((r) => setTimeout(r, 10));
    expect((raceContainer.children[0] as ReturnType<typeof makeDomNode>).remove).toHaveBeenCalled();
  });
});

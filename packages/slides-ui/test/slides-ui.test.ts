import { describe, expect, it, vi } from "vitest";
import { GpuSurface } from "@zseven-w/render-gpu";
import { Presentation } from "@zseven-w/slides-sdk";
import {
  SlidesViewController,
  createSlidesViewComponent,
  defineSlidesElement,
  mountSlidesView,
  type JiangeSlidesElement,
} from "../src/index.js";
import { createSlidesViewComponent as createSlidesViewFromReactSubpath } from "../src/react.js";

function makeDomNode(tag: string) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    tagName: tag.toUpperCase(),
    type: "",
    value: "",
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
    focus: vi.fn(),
    select: vi.fn(),
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
      for (const fn of listeners.get(ev) ?? []) fn({ preventDefault: vi.fn(), stopPropagation: vi.fn(), ...payload });
    },
  };
}

describe("@zseven-w/slides-ui (WebGPU/WebGL2 Stage + Virtual Rail)", () => {
  it("renders shapes, tables, charts, selection handles, presenter mode, navigation & React adapter", async () => {
    const deck = Presentation.create({ title: "Keynote" });
    deck.addSlide({
      title: "Architecture",
      body: "WebGPU + Virtual Lists",
      shapes: [
        { id: "r1", kind: "rounded-rectangle", x: 10, y: 20, width: 25, height: 25, color: "#3370ff" },
        { id: "e1", kind: "ellipse", x: 40, y: 20, width: 15, height: 15, color: "#00b42a" },
        { id: "l1", kind: "line-arrow", x: 10, y: 55, width: 30, height: 4, color: "#1f2329" },
        { id: "l2", kind: "line-double-arrow", x: 10, y: 62, width: 20, height: 4, color: "#3370ff" },
        { id: "l3", kind: "line", x: 10, y: 68, width: 20, height: 4, color: "#64748b" },
        { id: "t1", kind: "table", x: 55, y: 20, width: 35, height: 25, color: "#3370ff", table: { headerRow: true, rows: [["A", "B"], ["1"]] } },
        { id: "c1", kind: "chart", x: 55, y: 55, width: 35, height: 30, color: "#ff7d00", chart: { type: "column", title: "Revenue", categories: ["Q1", "Q2"], series: [{ name: "S", values: [10, 25] }] } },
        { id: "tx-l", kind: "text", x: 10, y: 74, width: 25, height: 8, text: "Left", color: "#1f2329", fontSize: 18, bold: true },
        { id: "tx-c", kind: "text", x: 36, y: 74, width: 18, height: 8, text: "Center", color: "#3370ff", align: "center" },
        { id: "tx-r", kind: "text", x: 36, y: 84, width: 18, height: 8, text: "Right", color: "", align: "right" },
      ],
    });
    deck.addSlide({ title: "Blank", layout: "blank", shapes: [] });

    const fakeDoc = { createElement: (t: string) => makeDomNode(t) };
    const container = makeDomNode("div");
    container.ownerDocument = fakeDoc;

    const onSlide = vi.fn();
    const onShape = vi.fn();
    const onShapeChange = vi.fn();
    const mounted = await mountSlidesView(container as unknown as HTMLElement, deck, {
      gpu: { prefer: "headless" },
      onSlideChange: onSlide,
      onSelectShape: onShape,
      onShapeChange,
    });
    const ctrl = mounted.controller;
    expect(ctrl.getSlideIndex()).toBe(0);

    // Navigate to slide 2
    const f2 = ctrl.nextSlide();
    expect(f2.slideIndex).toBe(1);
    expect(f2.gpu.rectInstances).toBeGreaterThan(5);
    expect(f2.gpu.arcInstances).toBe(1);
    expect(f2.visibleThumbnails).toBe(3);
    expect(onSlide).toHaveBeenCalledWith(1);
    // Blank slide skips auto-title/body & direct controller without textFactory uses thumbFactory fallback
    ctrl.goToSlide(2);
    ctrl.goToSlide(1);
    const directSurface = await GpuSurface.create(null);
    const directCtrl = new SlidesViewController(deck, directSurface, () => makeDomNode("div") as unknown as HTMLElement);
    directCtrl.render();
    directCtrl.dispose();

    // Hit-test, interactive drag-move, 4-corner resize handles, & delete & undo
    const stage = ctrl.getStageRect();
    const canvas = (container.children[1] as ReturnType<typeof makeDomNode>).children[0] as ReturnType<typeof makeDomNode>;
    // Hover & click empty canvas first
    canvas.dispatch("pointermove", { clientX: stage.x + 5, clientY: stage.y + 5 });
    expect(canvas.style.cursor).toBe("default");
    canvas.dispatch("pointerdown", { clientX: stage.x + 5, clientY: stage.y + 5 });
    canvas.dispatch("pointerup", {});
    canvas.dispatch("pointerdown", { clientX: stage.x + stage.w * 0.2, clientY: stage.y + stage.h * 0.3 });
    expect(ctrl.getSelectedShapeId()).toBe("r1");
    expect(onShape).toHaveBeenCalledWith("r1");
    // Interactive drag move
    canvas.dispatch("pointermove", { clientX: stage.x + stage.w * 0.25, clientY: stage.y + stage.h * 0.35 });
    canvas.dispatch("pointerup", {});
    expect(deck.getSlide(1)?.shapes[0].x).toBeGreaterThan(10);
    // Hover + drag SE & NW & NE & SW resize handles
    const sNow = deck.getSlide(1)!.shapes[0];
    const nwX = stage.x + (sNow.x / 100) * stage.w;
    const nwY = stage.y + (sNow.y / 100) * stage.h;
    const seX = nwX + ((sNow.width ?? 16) / 100) * stage.w;
    const seY = nwY + ((sNow.height ?? 20) / 100) * stage.h;
    canvas.dispatch("pointermove", { clientX: seX, clientY: seY });
    expect(canvas.style.cursor).toBe("nwse-resize");
    canvas.dispatch("pointermove", { clientX: seX, clientY: nwY });
    expect(canvas.style.cursor).toBe("nesw-resize");
    canvas.dispatch("pointerdown", { clientX: seX, clientY: seY });
    canvas.dispatch("pointermove", { clientX: seX + 20, clientY: seY + 15 });
    canvas.dispatch("pointerup", {});
    expect(deck.getSlide(1)!.shapes[0].width).toBeGreaterThan(25);
    expect(ctrl.resizeSelectedShape("nw", 1, 1)).toBe(true);
    expect(ctrl.resizeSelectedShape("ne", 1, 1)).toBe(true);
    expect(ctrl.resizeSelectedShape("sw", 1, 1)).toBe(true);
    expect(ctrl.moveSelectedShape(2, 2)).toBe(true);

    // Inline text editing on Slides stage (double-click, Enter/F2, blur/Escape, undoable)
    const stageHost = container.children[1] as ReturnType<typeof makeDomNode>;
    const editor = stageHost.children[2] as ReturnType<typeof makeDomNode>;
    expect(editor.tagName).toBe("INPUT");
    editor.dispatch("blur", {}); // no-op when closed
    // Double-click empty stage -> no-op
    canvas.dispatch("dblclick", { clientX: stage.x + 2, clientY: stage.y + 2 });
    expect(editor.style.display).toBe("none");
    // Double-click non-text shape ("r1") -> selects but does not open text editor
    const r1Now = deck.getSlide(1)!.shapes.find((s) => s.id === "r1")!;
    canvas.dispatch("dblclick", {
      clientX: stage.x + ((r1Now.x + 2) / 100) * stage.w,
      clientY: stage.y + ((r1Now.y + 2) / 100) * stage.h,
    });
    expect(editor.style.display).toBe("none");
    // Enter on non-text selected shape does not open editor
    container.dispatch("keydown", { key: "Enter" });
    expect(editor.style.display).toBe("none");
    // Double-click text shape ("tx-l") -> opens editor, ignores container keydown while open, commits on Enter
    canvas.dispatch("dblclick", {
      clientX: stage.x + (15 / 100) * stage.w,
      clientY: stage.y + (76 / 100) * stage.h,
    });
    expect(editor.style.display).toBe("block");
    expect(editor.value).toBe("Left");
    container.dispatch("keydown", { key: "Delete" }); // guarded while editing
    editor.dispatch("keydown", { key: "a" }); // non-Enter/Escape key inside editor
    editor.value = "Left Edited";
    editor.dispatch("keydown", { key: "Enter" });
    expect(editor.style.display).toBe("none");
    expect(deck.getSlide(1)?.shapes.find((s) => s.id === "tx-l")?.text).toBe("Left Edited");
    expect(deck.undo()).toBe(true);
    expect(deck.getSlide(1)?.shapes.find((s) => s.id === "tx-l")?.text).toBe("Left");
    // Open via F2 on non-bold text shape ("tx-c"), cancel with Escape
    ctrl.selectShape("tx-c");
    container.dispatch("keydown", { key: "F2" });
    expect(editor.style.display).toBe("block");
    editor.value = "Cancelled";
    editor.dispatch("keydown", { key: "Escape" });
    expect(editor.style.display).toBe("none");
    expect(deck.getSlide(1)?.shapes.find((s) => s.id === "tx-c")?.text).toBe("Center");
    // Open via Enter, commit via blur, and commit via canvas pointerdown
    container.dispatch("keydown", { key: "Enter" });
    editor.value = "Center Blurred";
    editor.dispatch("blur", {});
    expect(deck.getSlide(1)?.shapes.find((s) => s.id === "tx-c")?.text).toBe("Center Blurred");
    container.dispatch("keydown", { key: "Enter" });
    editor.value = "Center ClickedAway";
    canvas.dispatch("pointerdown", { clientX: stage.x + 2, clientY: stage.y + 2 });
    expect(deck.getSlide(1)?.shapes.find((s) => s.id === "tx-c")?.text).toBe("Center ClickedAway");
    // Reselect r1 for subsequent delete/undo assertions
    ctrl.selectShape("r1");

    container.dispatch("keydown", { key: "Delete" });
    expect(deck.getSlide(1)?.shapes.find((s) => s.id === "r1")).toBeUndefined();
    container.dispatch("keydown", { key: "z", ctrlKey: true });
    expect(deck.getSlide(1)?.shapes.find((s) => s.id === "r1")).toBeDefined();
    container.dispatch("keydown", { key: "z", ctrlKey: true, shiftKey: true });

    // Presenter mode blocks editor open + arrow nav + thumbnail scroll + resize
    ctrl.setPresenterMode(true);
    expect(ctrl.isPresenterMode()).toBe(true);
    canvas.dispatch("dblclick", {
      clientX: stage.x + (15 / 100) * stage.w,
      clientY: stage.y + (76 / 100) * stage.h,
    });
    expect(editor.style.display).toBe("none");
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

    // Hit-test miss on empty area + moveSelectedShape / resizeSelectedShape guards
    expect(ctrl.moveSelectedShape(2, 2)).toBe(false);
    expect(ctrl.resizeSelectedShape("se", 2, 2)).toBe(false);
    expect(ctrl.hitTestResizeHandle(0, 0)).toBeNull();
    expect(ctrl.handlePointerDown(wideStage.x + wideStage.w * 0.99, wideStage.y + wideStage.h * 0.99)).toBeNull();
    expect(ctrl.getSelectedShapeId()).toBeNull();

    // Select a non-existent shape id -> moveSelectedShape / resizeSelectedShape / hitTestResizeHandle / getShapeScreenRect / updateShapeText return falsy
    ctrl.selectShape("missing-id");
    expect(ctrl.moveSelectedShape(2, 2)).toBe(false);
    expect(ctrl.resizeSelectedShape("se", 2, 2)).toBe(false);
    expect(ctrl.hitTestResizeHandle(0, 0)).toBeNull();
    expect(ctrl.getShapeScreenRect("missing-id")).toBeNull();
    expect(ctrl.updateShapeText("missing-id", "x")).toBe(false);
    expect(ctrl.updateShapeText("def1", "x")).toBe(false);
    // Omitted width/height in getShapeScreenRect + omitted text/fontSize/bold/align in openEditor
    expect(ctrl.getShapeScreenRect("def1")?.w).toBeGreaterThan(0);
    ctrl.selectShape("txt1");
    zeroContainer.dispatch("keydown", { key: "Enter" });
    const zeroEditor = (zeroContainer.children[1] as ReturnType<typeof makeDomNode>).children[2] as ReturnType<typeof makeDomNode>;
    expect(zeroEditor.value).toBe("");
    zeroEditor.dispatch("keydown", { key: "Escape" });

    // Hit-test shape with default width/height & move BEFORE resize so omitted width/height defaults run in both
    const hitDef = ctrl.handlePointerDown(wideStage.x + wideStage.w * 0.1, wideStage.y + wideStage.h * 0.12);
    expect(hitDef?.id).toBe("def1");
    expect(ctrl.hitTestResizeHandle(wideStage.x + wideStage.w * 0.1, wideStage.y + wideStage.h * 0.12)).toBeNull();
    expect(ctrl.moveSelectedShape(2, 3)).toBe(true);
    expect(ctrl.resizeSelectedShape("se", 2, 2)).toBe(true);
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

  it("defineSlidesElement is SSR-safe and registers <jiange-slides> lifecycle cleanly", async () => {
    expect(createSlidesViewFromReactSubpath).toBe(createSlidesViewComponent);
    expect(defineSlidesElement()).toBe(false);

    const origCustomElements = Object.getOwnPropertyDescriptor(globalThis, "customElements");
    const origHtmlElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const registry = new Map<string, CustomElementConstructor>();
    const fakeCustomElements = {
      define: vi.fn((name: string, ctor: CustomElementConstructor) => { registry.set(name, ctor); }),
      get: (name: string) => registry.get(name),
    };
    const fakeDoc = { createElement: (t: string) => makeDomNode(t) };

    class FakeHTMLElement {
      isConnected = false;
      style: Record<string, string> = {};
      children: unknown[] = [];
      clientWidth = 960;
      clientHeight = 540;
      ownerDocument = fakeDoc;
      private listeners = new Map<string, Set<(e: unknown) => void>>();
      appendChild(c: unknown) { this.children.push(c); return c; }
      addEventListener(ev: string, fn: (e: unknown) => void) {
        let s = this.listeners.get(ev);
        if (!s) { s = new Set(); this.listeners.set(ev, s); }
        s.add(fn);
      }
      removeEventListener(ev: string, fn: (e: unknown) => void) { this.listeners.get(ev)?.delete(fn); }
    }

    try {
      Object.defineProperty(globalThis, "customElements", { value: fakeCustomElements, configurable: true, writable: true });
      expect(defineSlidesElement()).toBe(false);

      Object.defineProperty(globalThis, "HTMLElement", { value: FakeHTMLElement, configurable: true, writable: true });
      expect(defineSlidesElement()).toBe(true);
      expect(defineSlidesElement()).toBe(true);
      expect(fakeCustomElements.define).toHaveBeenCalledTimes(1);
      expect(registry.has("jiange-slides")).toBe(true);

      const Ctor = registry.get("jiange-slides")!;
      const el = new Ctor() as unknown as JiangeSlidesElement & {
        isConnected: boolean;
        connectedCallback(): void;
        disconnectedCallback(): void;
      };
      const deck = Presentation.create({ title: "WC Deck" });

      el.isConnected = true;
      el.connectedCallback();
      expect(el.presentation).toBeNull();
      expect(el.mounted).toBeNull();

      el.isConnected = false;
      el.presentation = deck;
      expect(el.presentation).toBe(deck);
      expect(el.mounted).toBeNull();

      el.isConnected = true;
      el.connectedCallback();
      await new Promise((r) => setTimeout(r, 10));
      expect(el.mounted).not.toBeNull();

      el.options = { gpu: { prefer: "headless" } };
      expect(el.options).toEqual({ gpu: { prefer: "headless" } });
      await new Promise((r) => setTimeout(r, 10));
      expect(el.mounted).not.toBeNull();

      el.isConnected = false;
      el.disconnectedCallback();
      expect(el.mounted).toBeNull();
      el.disconnectedCallback();

      // Async mount race: disconnect before mountSlidesView resolves
      el.isConnected = true;
      el.connectedCallback();
      el.isConnected = false;
      el.disconnectedCallback();
      await new Promise((r) => setTimeout(r, 10));
      expect(el.mounted).toBeNull();
    } finally {
      if (origCustomElements) Object.defineProperty(globalThis, "customElements", origCustomElements);
      else delete (globalThis as Record<string, unknown>).customElements;
      if (origHtmlElement) Object.defineProperty(globalThis, "HTMLElement", origHtmlElement);
      else delete (globalThis as Record<string, unknown>).HTMLElement;
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { Board } from "@jiange/whiteboard-sdk";
import {
  createWhiteboardViewComponent,
  defineWhiteboardElement,
  mountWhiteboardView,
  type JiangeWhiteboardElement,
} from "../src/index.js";
import { createWhiteboardViewComponent as createWhiteboardViewFromReactSubpath } from "../src/react.js";

function makeDomNode(tag: string) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    tagName: tag.toUpperCase(),
    style: {} as Record<string, string>,
    children: [] as unknown[],
    textContent: "",
    width: 0,
    height: 0,
    clientWidth: 960,
    clientHeight: 600,
    ownerDocument: null as unknown,
    appendChild(c: unknown) { this.children.push(c); return c; },
    remove: vi.fn(),
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 600 }),
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

describe("@jiange/whiteboard-ui (WebGPU/WebGL2 + SpatialIndex Infinite Canvas)", () => {
  it("culls large graphs, renders nodes/edges/mindmaps/strokes, handles pan/zoom/drag/delete/undo", async () => {
    const board = Board.create({ theme: "feishu" });
    board.apply([
      { op: "addNode", node: { id: "n1", shape: "terminator", text: "Start", x: 50, y: 50, w: 140, h: 60 } },
      { op: "addNode", node: { id: "n2", shape: "ellipse", text: "Check", x: 260, y: 50, w: 120, h: 70 } },
      { op: "addNode", node: { id: "far", shape: "rect", text: "Offscreen", x: 8000, y: 8000, w: 140, h: 60 } },
      { op: "addEdge", edge: { id: "e1", from: "n1", to: "n2", dashed: true } },
      { op: "addMindTopic", topic: { id: "r1", parent: null, text: "Root", x: 50, y: 200 } },
      { op: "addMindTopic", topic: { id: "c1", parent: "r1", text: "Child" } },
      { op: "addStroke", stroke: { id: "s1", points: [{ x: 10, y: 10 }, { x: 60, y: 40 }], color: "#ff7d00", width: 3 } },
    ]);

    const fakeDoc = { createElement: (t: string) => makeDomNode(t) };
    const container = makeDomNode("div");
    container.ownerDocument = fakeDoc;

    const onSel = vi.fn();
    const mounted = await mountWhiteboardView(container as unknown as HTMLElement, board, {
      gpu: { prefer: "headless" },
      onSelectionChange: onSel,
    });
    const ctrl = mounted.controller;

    // Reset camera near (0,0) so "far" node is frustum-culled!
    ctrl.camera.x = 0;
    ctrl.camera.y = 0;
    ctrl.camera.zoom = 1;
    const frame = ctrl.render();
    expect(frame.totalNodes).toBe(3);
    expect(frame.visibleNodes).toBe(2); // "far" culled by SpatialIndex!
    expect(frame.visibleMindTopics).toBe(2);
    expect(frame.gpu.arcInstances).toBe(2);
    expect(frame.gpu.lineInstances).toBeGreaterThanOrEqual(3);

    // Hit-test, select, interactive pointer drag, shift-select, pan, delete, undo/redo
    container.dispatch("pointermove", { clientX: 50, clientY: 50 }); // idle no-op
    container.dispatch("pointerdown", { clientX: 80, clientY: 80, shiftKey: false });
    expect(ctrl.getSelectedIds()).toEqual(["n1"]);
    expect(onSel).toHaveBeenCalledWith(["n1"]);
    container.dispatch("pointermove", { clientX: 90, clientY: 85 });
    container.dispatch("pointerup", {});
    expect(board.toGraph().nodes.find((n) => n.id === "n1")?.x).toBe(60);
    expect(ctrl.dragSelected(10, 5)).toBe(true);
    expect(board.toGraph().nodes.find((n) => n.id === "n1")?.x).toBe(70);

    container.dispatch("pointerdown", { clientX: 310, clientY: 80, shiftKey: true });
    expect(ctrl.getSelectedIds()).toHaveLength(2);
    // Toggle off via shift-click, then drag empty canvas to pan
    container.dispatch("pointerdown", { clientX: 310, clientY: 80, shiftKey: true });
    expect(ctrl.getSelectedIds()).toHaveLength(1);
    container.dispatch("pointerdown", { clientX: 700, clientY: 500, shiftKey: false });
    container.dispatch("pointermove", { clientX: 715, clientY: 510 });
    container.dispatch("pointerup", {});
    expect(ctrl.getSelectedIds()).toEqual([]);
    expect(ctrl.dragSelected(5, 5)).toBe(false);
    // Select both again and delete
    ctrl.selectNodes(["n1", "n2"]);
    container.dispatch("keydown", { key: "Delete" });
    expect(board.toGraph().nodes).toHaveLength(1);
    container.dispatch("keydown", { key: "z", ctrlKey: true });
    expect(board.toGraph().nodes).toHaveLength(3);
    container.dispatch("keydown", { key: "z", ctrlKey: true, shiftKey: true });

    // Empty board fitToScreen branch
    const emptyBoard = Board.create();
    const emptyMount = await mountWhiteboardView(makeDomNode("div") as unknown as HTMLElement & { ownerDocument: unknown }, emptyBoard, { gpu: { prefer: "headless" } }).catch(() => null);
    void emptyMount;
    const emptyContainer = makeDomNode("div");
    emptyContainer.ownerDocument = fakeDoc;
    const mEmpty = await mountWhiteboardView(emptyContainer as unknown as HTMLElement, emptyBoard, { gpu: { prefer: "headless" } });
    mEmpty.controller.fitToScreen();
    mEmpty.dispose();

    // Pan & Zoom via wheel + resize
    container.dispatch("wheel", { deltaX: 20, deltaY: 30 });
    container.dispatch("wheel", { deltaY: -10, ctrlKey: true, clientX: 400, clientY: 300 });
    mounted.resize(1200, 800);
    mounted.dispose();

    // React wrapper
    const cleanups: Array<() => void> = [];
    let rc = 0;
    const fakeReact = {
      useEffect: (fn: () => void | (() => void)) => { const c = fn(); if (typeof c === "function") cleanups.push(c); },
      useRef: <V>(v: V) => ({ current: rc++ === 0 ? (container as unknown as V) : v }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const WhiteboardView = createWhiteboardViewComponent(fakeReact);
    expect((WhiteboardView({ board, width: 800, height: 600, gpu: { prefer: "headless" } }) as { type: string }).type).toBe("div");
    await new Promise((r) => setTimeout(r, 10));
    cleanups.forEach((c) => c());
  });

  it("covers round/rect/text shapes, colored/dangling edges, marker strokes, zoom out, stale selections, Backspace/unhandled keys, and React races", async () => {
    // Use Board.fromGraph to include dangling edges alongside valid visible & offscreen shapes
    const board = Board.fromGraph({
      theme: "feishu",
      nodes: [
        { id: "r1", shape: "round", text: "Rounded", x: 40, y: 40, w: 120, h: 60, fill: "#eef2ff", stroke: "#3370ff", rot: 15 },
        { id: "t1", shape: "text", text: "Note", x: 220, y: 40, w: 100, h: 40 },
        { id: "b1", shape: "rect", text: "", x: 360, y: 40, w: 100, h: 60 },
        { id: "far1", shape: "rect", text: "Far1", x: 6000, y: 6000, w: 100, h: 50 },
        { id: "far2", shape: "rect", text: "Far2", x: 6300, y: 6000, w: 100, h: 50 },
      ],
      edges: [
        // Solid edge with custom color
        { id: "e-solid", from: "r1", to: "t1", color: "#ff3366" },
        // Self-loop exercises edgeAnchor(scale <= 1) fallback cleanly
        { id: "e-self", from: "r1", to: "r1" },
        // Dangling edges (missing target & missing source)
        { id: "e-dangle-to", from: "r1", to: "missing-b" },
        { id: "e-dangle-from", from: "missing-a", to: "r1" },
        // Offscreen edge (both endpoints culled)
        { id: "e-far", from: "far1", to: "far2" },
      ],
      mind: [
        { id: "m-far", parent: null, text: "OffscreenMind", x: 9000, y: 9000 },
      ],
      strokes: [
        { id: "mk1", points: [{ x: 10, y: 10 }, { x: 80, y: 40 }], color: "#ffeb3b", width: 12, marker: true },
      ],
    });

    const fakeDoc = { createElement: (t: string) => makeDomNode(t) };
    const zeroContainer = makeDomNode("div");
    zeroContainer.clientWidth = 0;
    zeroContainer.clientHeight = 0;
    zeroContainer.ownerDocument = fakeDoc;

    // Mount with zero dimensions + default omitted options -> fallback 960x600
    const mounted = await mountWhiteboardView(zeroContainer as unknown as HTMLElement, board);
    const ctrl = mounted.controller;

    // Reset camera to (0, 0, 1) so r1/t1/b1 are visible while far1/far2/m-far are culled
    ctrl.camera.x = 0;
    ctrl.camera.y = 0;
    ctrl.camera.zoom = 1;
    const frame = ctrl.render();
    expect(frame.visibleNodes).toBe(3);
    expect(frame.visibleMindTopics).toBe(0);

    // Shift-clicking empty background preserves selection
    ctrl.selectNodes(["r1"]);
    zeroContainer.dispatch("pointerdown", { clientX: 800, clientY: 500, shiftKey: true });
    expect(ctrl.getSelectedIds()).toEqual(["r1"]);

    // Selected ID not present in board -> dragSelected returns false
    ctrl.selectNodes(["ghost-node"]);
    expect(ctrl.dragSelected(10, 10)).toBe(false);

    // Backspace deletes selected node; unhandled keys & Delete with empty selection return false
    ctrl.selectNodes(["b1"]);
    expect(ctrl.handleKeyDown("Backspace")).toBe(true);
    expect(board.toGraph().nodes.find((n) => n.id === "b1")).toBeUndefined();
    expect(ctrl.handleKeyDown("Delete")).toBe(false);
    expect(ctrl.handleKeyDown("x")).toBe(false);
    zeroContainer.dispatch("keydown", { key: "x" });
    expect(ctrl.handleKeyDown("z", { metaKey: true })).toBe(true);

    // Wheel zoom out (deltaY > 0 -> factor 0.9) and zoom in with metaKey
    const zoomBefore = ctrl.camera.zoom;
    zeroContainer.dispatch("wheel", { deltaY: 20, ctrlKey: true, clientX: 200, clientY: 200 });
    expect(ctrl.camera.zoom).toBeLessThan(zoomBefore);
    zeroContainer.dispatch("wheel", { deltaY: -20, metaKey: true, clientX: 200, clientY: 200 });

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
    const NullWhiteboardView = createWhiteboardViewComponent(nullReact);
    const fullNode = NullWhiteboardView({ board }) as { props: { style: { width: string; height: string } } };
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
    const RaceWhiteboardView = createWhiteboardViewComponent(raceReact);
    RaceWhiteboardView({ board, gpu: { prefer: "headless" } });
    // Invoke cleanup BEFORE async mountWhiteboardView resolves -> hits `if (!alive) v.dispose()`
    raceCleanups.forEach((c) => c());
    await new Promise((r) => setTimeout(r, 10));
    expect((raceContainer.children[0] as ReturnType<typeof makeDomNode>).remove).toHaveBeenCalled();
  });

  it("defineWhiteboardElement is SSR-safe and registers <jiange-whiteboard> lifecycle cleanly", async () => {
    expect(createWhiteboardViewFromReactSubpath).toBe(createWhiteboardViewComponent);
    expect(defineWhiteboardElement()).toBe(false);

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
      clientHeight = 600;
      ownerDocument = fakeDoc;
      private listeners = new Map<string, Set<(e: unknown) => void>>();
      appendChild(c: unknown) { this.children.push(c); return c; }
      getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 600 }; }
      addEventListener(ev: string, fn: (e: unknown) => void) {
        let s = this.listeners.get(ev);
        if (!s) { s = new Set(); this.listeners.set(ev, s); }
        s.add(fn);
      }
      removeEventListener(ev: string, fn: (e: unknown) => void) { this.listeners.get(ev)?.delete(fn); }
    }

    try {
      Object.defineProperty(globalThis, "customElements", { value: fakeCustomElements, configurable: true, writable: true });
      expect(defineWhiteboardElement()).toBe(false);

      Object.defineProperty(globalThis, "HTMLElement", { value: FakeHTMLElement, configurable: true, writable: true });
      expect(defineWhiteboardElement()).toBe(true);
      expect(defineWhiteboardElement()).toBe(true);
      expect(fakeCustomElements.define).toHaveBeenCalledTimes(1);
      expect(registry.has("jiange-whiteboard")).toBe(true);

      const Ctor = registry.get("jiange-whiteboard")!;
      const el = new Ctor() as unknown as JiangeWhiteboardElement & {
        isConnected: boolean;
        connectedCallback(): void;
        disconnectedCallback(): void;
      };
      const board = Board.create({ theme: "feishu" });

      el.isConnected = true;
      el.connectedCallback();
      expect(el.board).toBeNull();
      expect(el.mounted).toBeNull();

      el.isConnected = false;
      el.board = board;
      expect(el.board).toBe(board);
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

      // Async mount race: disconnect before mountWhiteboardView resolves
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

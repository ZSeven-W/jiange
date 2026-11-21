import { describe, expect, it, vi } from "vitest";
import { GpuSurface, type PoolableElement } from "@jiange/render-gpu";
import { Workbook } from "@jiange/sheet-sdk";
import {
  SheetGpuRenderer,
  SheetViewController,
  createSheetViewComponent,
  defineSheetElement,
  mountSheetView,
  type JiangeSheetElement,
} from "../src/index.js";
import { createSheetViewComponent as createSheetViewFromReactSubpath } from "../src/react.js";

function makeFakeCell(): PoolableElement {
  return { style: { transform: "", width: "", height: "", display: "" }, textContent: "" };
}

describe("@jiange/sheet-ui (WebGPU/WebGL2 + Pooled Virtual Grid)", () => {
  it("renders frozen panes, formulas, conditional formats, collaborator cursors, and GPU charts with zero Canvas 2D", async () => {
    const wb = Workbook.create({ sheets: [{ name: "Budget", rows: 500, cols: 30 }] });
    const sh = wb.sheet(0);
    sh.setRange("A1", [
      ["Item", "Q1", "Q2", "Total"],
      ["Cloud", 100, 150, "=SUM(B2:C2)"],
      ["GPU", 200, 260, "=SUM(B3:C3)"],
    ]);
    sh.setFreeze(1, 1);
    sh.setRowHeight(0, 34);
    sh.setColWidth(0, 140);
    wb.apply([
      {
        op: "addConditionalFormat",
        sheet: "Budget",
        range: "D2:D3",
        ruleOp: "gt",
        value1: "300",
        bg: "#dcfce7",
      },
      { op: "addChart", sheet: "Budget", title: "Spend", chartType: "column", range: "A1:C3", headerRow: true },
      { op: "addChart", sheet: "Budget", title: "Share", chartType: "pie", range: "A1:B3", headerRow: true },
      { op: "addChart", sheet: "Budget", title: "Trend", chartType: "line", range: "A1:C3", headerRow: true },
    ]);

    const surface = await GpuSurface.create(null);
    const renderer = new SheetGpuRenderer(surface, makeFakeCell);
    renderer.resize(800, 480, 1);

    const onSel = vi.fn();
    const onCommit = vi.fn();
    const ctrl = new SheetViewController(wb, renderer, {
      onSelectionChange: onSel,
      onEditCommit: onCommit,
    });
    ctrl.setCollaborators([{ id: "u2", name: "Alice", color: "#00b42a", row: 1, col: 1 }]);

    const frame = ctrl.render();
    expect(frame.gpu.backend).toBe("headless");
    expect(frame.gpu.rectInstances).toBeGreaterThan(5);
    expect(frame.gpu.lineInstances).toBeGreaterThan(20);
    expect(frame.gpu.arcInstances).toBeGreaterThanOrEqual(2);
    expect(frame.mountedTextCells).toBeGreaterThanOrEqual(12);

    // Hit-testing & selection
    const sel = ctrl.handlePointerDown(100, 65, false);
    expect(sel).not.toBeNull();
    expect(onSel).toHaveBeenCalled();

    // Inline editing + keyboard navigation + undo/redo + delete
    ctrl.selectCell(1, 1);
    const ed = ctrl.beginEdit();
    expect(ed.active).toBe(true);
    expect(ed.value).toBe("100");
    ctrl.updateEditValue("125");
    expect(ctrl.handleKeyDown("Enter")).toBe(true);
    expect(onCommit).toHaveBeenCalledWith("B2", "125");
    expect(wb.sheet(0).getValue("D2")).toBe(275);

    // Arrows, Tab, Escape, Delete, Undo/Redo, Scroll, Resize
    expect(ctrl.handleKeyDown("ArrowUp")).toBe(true);
    expect(ctrl.handleKeyDown("ArrowDown")).toBe(true);
    expect(ctrl.handleKeyDown("ArrowLeft")).toBe(true);
    expect(ctrl.handleKeyDown("ArrowRight", { shiftKey: true })).toBe(true);
    expect(ctrl.handleKeyDown("Tab")).toBe(true);
    expect(ctrl.handleKeyDown("F2")).toBe(true);
    expect(ctrl.handleKeyDown("Escape")).toBe(true);
    expect(ctrl.handleKeyDown("Delete")).toBe(true);
    expect(ctrl.handleKeyDown("z", { ctrlKey: true })).toBe(true);
    expect(ctrl.handleKeyDown("z", { ctrlKey: true, shiftKey: true })).toBe(true);

    ctrl.resizeRow(2, 42);
    ctrl.resizeCol(2, 140);
    // Live row filtering hides non-matching rows in O(log N) Fenwick tree
    sh.setFilter({ enabled: true, headerRow: 0, rules: { "0": { values: ["GPU"] } } });
    ctrl.render();
    expect(renderer.grid.rows.getSize(1)).toBe(0);
    expect(renderer.grid.rows.getSize(2)).toBeGreaterThan(0);
    sh.clearFilter();
    ctrl.render();
    const scrolled = ctrl.scrollBy(120, 300);
    expect(scrolled.grid.rowStart).toBeGreaterThan(5);

    wb.addSheet("Summary");
    ctrl.setActiveSheet("Summary");
    expect(ctrl.getActiveSheet()).toBe("Summary");

    // React adapter sanity
    const fakeReact = {
      useEffect: vi.fn(),
      useRef: <V>(v: V) => ({ current: v }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const SheetView = createSheetViewComponent(fakeReact);
    const node = SheetView({ workbook: wb, width: 800, height: 600 }) as { type: string };
    expect(node.type).toBe("div");

    ctrl.dispose();
  });

  it("mounts via mountSheetView and exercises DOM events, resize, inline editor, React effects, and dispose", async () => {
    const makeDomNode = (tag: string) => {
      const listeners = new Map<string, Set<(e: unknown) => void>>();
      const el = {
        tagName: tag.toUpperCase(),
        style: {} as Record<string, string>,
        children: [] as unknown[],
        textContent: "",
        value: "",
        type: "",
        width: 0,
        height: 0,
        clientWidth: 640,
        clientHeight: 400,
        ownerDocument: null as unknown,
        appendChild(c: unknown) { this.children.push(c); return c; },
        remove: vi.fn(),
        focus: vi.fn(),
        getContext: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 400 }),
        addEventListener(ev: string, fn: (e: unknown) => void) {
          let set = listeners.get(ev);
          if (!set) { set = new Set(); listeners.set(ev, set); }
          set.add(fn);
        },
        removeEventListener(ev: string, fn: (e: unknown) => void) {
          listeners.get(ev)?.delete(fn);
        },
        dispatch(ev: string, payload: Record<string, unknown> = {}) {
          for (const fn of listeners.get(ev) ?? []) fn({ preventDefault: vi.fn(), ...payload });
        },
      };
      return el;
    };
    const fakeDoc = { createElement: (tag: string) => makeDomNode(tag) };
    const container = makeDomNode("div");
    container.ownerDocument = fakeDoc;

    const wb = Workbook.create({ sheets: [{ name: "Main", rows: 50, cols: 10 }] });
    wb.sheet(0).setCell("A1", "Hello");

    const mounted = await mountSheetView(container as unknown as HTMLElement, wb, { gpu: { prefer: "headless" } });
    mounted.resize(800, 500);
    container.dispatch("pointerdown", { clientX: 80, clientY: 40, shiftKey: false });
    container.dispatch("dblclick");
    const input = container.children[2] as ReturnType<typeof makeDomNode>;
    input.value = "Updated";
    input.dispatch("input");
    container.dispatch("keydown", { key: "Enter" });
    expect(wb.sheet(0).getCell("A1").raw).toBe("Updated");
    container.dispatch("wheel", { deltaX: 0, deltaY: 60 });
    mounted.dispose();

    // Exercise React useEffect callbacks
    const cleanups: Array<() => void> = [];
    let refCall = 0;
    const fakeReact = {
      useEffect: (fn: () => void | (() => void)) => {
        const c = fn();
        if (typeof c === "function") cleanups.push(c);
      },
      useRef: <V>(v: V) => ({ current: refCall++ === 0 ? (container as unknown as V) : v }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const SheetView = createSheetViewComponent(fakeReact);
    SheetView({ workbook: wb, width: 640, height: 400, gpu: { prefer: "headless" } });
    await new Promise((r) => setTimeout(r, 10));
    cleanups.forEach((c) => c());
  });

  it("covers readOnly guards, editing keys, pointer commits, hidden tracks, spill cells, styles, and chart edge cases", async () => {
    const wb = Workbook.create({ sheets: [{ name: "Data", rows: 40, cols: 12 }] });
    const sh = wb.sheet(0);
    sh.setCell("A1", "Title", { bg: "#eef2ff" });
    sh.setCell("B1", 10);
    sh.setCell("C1", 20);
    sh.setCell("A2", "Row");
    sh.setCell("B2", 0);
    sh.setCell("C2", -5);
    // Dynamic array spill formula populates B4, A5, B5 without rawCell records
    sh.setCell("A4", "=SEQUENCE(2,2)");
    sh.setFreeze(2, 1);

    wb.apply([
      { op: "addChart", sheet: "Data", title: "ZeroPie", chartType: "pie", range: "A2:B2", headerRow: false },
      { op: "addChart", sheet: "Data", title: "Area", chartType: "area", range: "A1:C2", headerRow: true },
    ]);

    const surface = await GpuSurface.create(null);
    const renderer = new SheetGpuRenderer(surface, makeFakeCell);
    renderer.resize(800, 480, 1);

    // Read-only controller guards
    const roCtrl = new SheetViewController(wb, renderer, { readOnly: true });
    expect(roCtrl.beginEdit().active).toBe(false);
    expect(roCtrl.commitEdit()).toBe(false);
    roCtrl.updateEditValue("ignored");
    expect(roCtrl.getEditorState().value).toBe("");
    expect(roCtrl.handleKeyDown("Delete")).toBe(true);
    expect(sh.getCell("A1").raw).toBe("Title");

    // Editable controller full branch coverage
    const onCommit = vi.fn();
    const ctrl = new SheetViewController(wb, renderer, { onEditCommit: onCommit });
    const frame = ctrl.render();
    expect(frame.mountedTextCells).toBeGreaterThanOrEqual(8);

    // pointToCell: header misses (gx < 0 and gy < 0) + frozen row hit (gy < frozenH)
    const ws = wb._getWorksheetById(sh.id)!;
    expect(renderer.pointToCell(10, 40, ws)).toBeNull();
    expect(renderer.pointToCell(100, 10, ws)).toBeNull();
    expect(ctrl.handlePointerDown(10, 10)).toBeNull();
    const frozenHit = renderer.pointToCell(200, 35, ws);
    expect(frozenHit).toEqual({ row: 0, col: 1 });

    // beginEdit with override + editing Tab / Shift+Tab / ignored key + commit on pointerdown
    ctrl.selectCell(0, 1);
    const ed = ctrl.beginEdit("999");
    expect(ed.active).toBe(true);
    expect(ed.value).toBe("999");
    expect(ctrl.handleKeyDown("a")).toBe(false);
    expect(ctrl.handleKeyDown("Tab")).toBe(true);
    expect(onCommit).toHaveBeenCalledWith("B1", "999");
    expect(ctrl.getSelection().anchorCol).toBe(2);

    ctrl.beginEdit("777");
    expect(ctrl.handleKeyDown("Tab", { shiftKey: true })).toBe(true);
    expect(ctrl.getSelection().anchorCol).toBe(1);

    // Active editor commits when clicking another cell
    ctrl.beginEdit("555");
    const clicked = ctrl.handlePointerDown(200, 35, false);
    expect(clicked).not.toBeNull();
    expect(sh.getCell("B1").raw).toBe("555");

    // Navigation & editing keys when not active
    expect(ctrl.handleKeyDown("Tab", { shiftKey: true })).toBe(true);
    expect(ctrl.handleKeyDown("Enter")).toBe(true);
    expect(ctrl.getEditorState().active).toBe(true);
    ctrl.cancelEdit();
    expect(ctrl.handleKeyDown("Backspace")).toBe(true);
    expect(ctrl.handleKeyDown("z", { metaKey: true })).toBe(true);
    expect(ctrl.handleKeyDown("x")).toBe(false);

    // Hidden rows & columns (size === 0) via snapshot + empty-column pie chart (series[0] undefined)
    const hiddenWb = Workbook.fromSnapshot([
      {
        id: 1,
        title: "Hidden",
        position: 0,
        revision: 1,
        rows: [
          { id: 1, pos: 0, size: 0 },
          { id: 2, pos: 1, size: 30 },
        ],
        columns: [
          { id: 1, pos: 0, size: 0 },
          { id: 2, pos: 1, size: 120 },
        ],
        cells: [],
        merges: [],
        frozenRows: 0,
        frozenCols: 0,
      },
      {
        id: 2,
        title: "EmptyPie",
        position: 1,
        revision: 1,
        rows: [],
        columns: [],
        cells: [],
        merges: [],
        frozenRows: 0,
        frozenCols: 0,
        charts: [{ id: "pie-empty", title: "None", type: "pie", top: 0, left: 0, bottom: 0, right: 0, headerRow: false }],
      },
    ]);
    const hiddenSurf = await GpuSurface.create(null);
    const hiddenRenderer = new SheetGpuRenderer(hiddenSurf, makeFakeCell);
    hiddenRenderer.resize(640, 400, 1);
    hiddenRenderer.render(hiddenWb, "Hidden", null);
    expect(hiddenRenderer.grid.rows.getSize(0)).toBe(0);
    expect(hiddenRenderer.grid.cols.getSize(0)).toBe(0);
    const emptyPieFrame = hiddenRenderer.render(hiddenWb, "EmptyPie", null);
    expect(emptyPieFrame.gpu.arcInstances).toBe(0);

    hiddenRenderer.dispose();
    ctrl.dispose();
  });

  it("handles mountSheetView fallback dimensions, unhandled keys, and React unmount/resize edge cases", async () => {
    const makeZeroDomNode = (tag: string) => {
      const listeners = new Map<string, Set<(e: unknown) => void>>();
      return {
        tagName: tag.toUpperCase(),
        style: {} as Record<string, string>,
        children: [] as unknown[],
        textContent: "",
        value: "",
        type: "",
        width: 0,
        height: 0,
        clientWidth: 0,
        clientHeight: 0,
        ownerDocument: null as unknown,
        appendChild(c: unknown) { this.children.push(c); return c; },
        remove: vi.fn(),
        focus: vi.fn(),
        getContext: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        addEventListener(ev: string, fn: (e: unknown) => void) {
          let set = listeners.get(ev);
          if (!set) { set = new Set(); listeners.set(ev, set); }
          set.add(fn);
        },
        removeEventListener(ev: string, fn: (e: unknown) => void) {
          listeners.get(ev)?.delete(fn);
        },
        dispatch(ev: string, payload: Record<string, unknown> = {}) {
          const preventDefault = vi.fn();
          for (const fn of listeners.get(ev) ?? []) fn({ preventDefault, ...payload });
          return preventDefault;
        },
      };
    };
    const fakeDoc = { createElement: (tag: string) => makeZeroDomNode(tag) };
    const zeroContainer = makeZeroDomNode("div");
    zeroContainer.ownerDocument = fakeDoc;

    const wb = Workbook.create({ sheets: [{ name: "S1", rows: 10, cols: 5 }] });
    // Default options omitted + zero clientWidth/clientHeight fallbacks
    const mounted = await mountSheetView(zeroContainer as unknown as HTMLElement, wb);
    const prevent = zeroContainer.dispatch("keydown", { key: "x" });
    expect(prevent).not.toHaveBeenCalled();
    mounted.dispose();

    // React adapter: null hostRef + missing width/height ("100%")
    const nullCleanups: Array<() => void> = [];
    const nullReact = {
      useEffect: (fn: () => void | (() => void)) => {
        const c = fn();
        if (typeof c === "function") nullCleanups.push(c);
      },
      useRef: <V>(v: V) => ({ current: v }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const NullSheetView = createSheetViewComponent(nullReact);
    const fullSizeNode = NullSheetView({ workbook: wb }) as { props: { style: { width: string; height: string } } };
    expect(fullSizeNode.props.style).toEqual({ width: "100%", height: "100%" });
    expect(nullCleanups).toHaveLength(0);

    // React adapter: unmount BEFORE async mountSheetView resolves (alive === false race)
    const raceContainer = makeZeroDomNode("div");
    raceContainer.ownerDocument = fakeDoc;
    const raceCleanups: Array<() => void> = [];
    let raceRefIdx = 0;
    const raceReact = {
      useEffect: (fn: () => void | (() => void)) => {
        const c = fn();
        if (typeof c === "function") raceCleanups.push(c);
      },
      useRef: <V>(v: V) => ({ current: raceRefIdx++ === 0 ? (raceContainer as unknown as V) : v }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const RaceSheetView = createSheetViewComponent(raceReact);
    RaceSheetView({ workbook: wb, gpu: { prefer: "headless" } });
    // Immediately invoke cleanup before promise resolves
    raceCleanups.forEach((c) => c());
    await new Promise((r) => setTimeout(r, 10));
    expect(raceContainer.children).toHaveLength(3);
    expect((raceContainer.children[0] as ReturnType<typeof makeZeroDomNode>).remove).toHaveBeenCalled();

    // React adapter: persistent refs across renders so resize effect runs after mount resolves
    const resizeContainer = makeZeroDomNode("div");
    resizeContainer.ownerDocument = fakeDoc;
    const refs: Array<{ current: unknown }> = [];
    let renderRefCursor = 0;
    const resizeCleanups: Array<() => void> = [];
    let mountEffectRun = false;
    const statefulReact = {
      useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
        const isMount = deps && deps[0] === wb;
        if (isMount) {
          if (mountEffectRun) return;
          mountEffectRun = true;
        }
        const c = fn();
        if (typeof c === "function") resizeCleanups.push(c);
      },
      useRef: <V>(v: V) => {
        const idx = renderRefCursor++;
        if (!refs[idx]) {
          refs[idx] = { current: idx === 0 ? resizeContainer : v };
        }
        return refs[idx] as { current: V };
      },
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const StatefulSheetView = createSheetViewComponent(statefulReact);
    renderRefCursor = 0;
    StatefulSheetView({ workbook: wb, width: 500, height: 300, gpu: { prefer: "headless" } });
    await new Promise((r) => setTimeout(r, 10));
    const mountedView = refs[1].current as { resize: (w: number, h: number) => void; dispose: () => void };
    const resizeSpy = vi.spyOn(mountedView, "resize");

    // Re-render with width + height -> calls resize
    renderRefCursor = 0;
    StatefulSheetView({ workbook: wb, width: 900, height: 600 });
    expect(resizeSpy).toHaveBeenCalledWith(900, 600);

    // Re-render with width only (height missing) -> skips resize
    resizeSpy.mockClear();
    renderRefCursor = 0;
    StatefulSheetView({ workbook: wb, width: 900 });
    expect(resizeSpy).not.toHaveBeenCalled();

    // Re-render with neither width nor height -> skips resize
    renderRefCursor = 0;
    StatefulSheetView({ workbook: wb });
    expect(resizeSpy).not.toHaveBeenCalled();

    resizeCleanups.forEach((c) => c());
  });

  it("defineSheetElement is SSR-safe and registers <jiange-sheet> lifecycle cleanly", async () => {
    expect(createSheetViewFromReactSubpath).toBe(createSheetViewComponent);
    // In Node/SSR without customElements / HTMLElement, safely returns false
    expect(defineSheetElement()).toBe(false);

    const origCustomElements = Object.getOwnPropertyDescriptor(globalThis, "customElements");
    const origHtmlElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");

    const registry = new Map<string, CustomElementConstructor>();
    const fakeCustomElements = {
      define: vi.fn((name: string, ctor: CustomElementConstructor) => { registry.set(name, ctor); }),
      get: (name: string) => registry.get(name),
    };

    const makeChildNode = (tag: string) => {
      const listeners = new Map<string, Set<(e: unknown) => void>>();
      return {
        tagName: tag.toUpperCase(),
        style: {} as Record<string, string>,
        children: [] as unknown[],
        textContent: "",
        value: "",
        type: "",
        width: 0,
        height: 0,
        clientWidth: 640,
        clientHeight: 400,
        appendChild(c: unknown) { this.children.push(c); return c; },
        remove: vi.fn(),
        focus: vi.fn(),
        getContext: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 400 }),
        addEventListener(ev: string, fn: (e: unknown) => void) {
          let s = listeners.get(ev);
          if (!s) { s = new Set(); listeners.set(ev, s); }
          s.add(fn);
        },
        removeEventListener(ev: string, fn: (e: unknown) => void) { listeners.get(ev)?.delete(fn); },
      };
    };
    const fakeDoc = { createElement: (tag: string) => makeChildNode(tag) };

    class FakeHTMLElement {
      isConnected = false;
      style: Record<string, string> = {};
      children: unknown[] = [];
      clientWidth = 640;
      clientHeight = 400;
      ownerDocument = fakeDoc;
      private listeners = new Map<string, Set<(e: unknown) => void>>();
      appendChild(c: unknown) { this.children.push(c); return c; }
      getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 400 }; }
      addEventListener(ev: string, fn: (e: unknown) => void) {
        let s = this.listeners.get(ev);
        if (!s) { s = new Set(); this.listeners.set(ev, s); }
        s.add(fn);
      }
      removeEventListener(ev: string, fn: (e: unknown) => void) { this.listeners.get(ev)?.delete(fn); }
    }

    try {
      // customElements defined but HTMLElement still undefined -> returns false
      Object.defineProperty(globalThis, "customElements", { value: fakeCustomElements, configurable: true, writable: true });
      expect(defineSheetElement()).toBe(false);

      // Both defined -> registers <jiange-sheet> and is idempotent
      Object.defineProperty(globalThis, "HTMLElement", { value: FakeHTMLElement, configurable: true, writable: true });
      expect(defineSheetElement()).toBe(true);
      expect(defineSheetElement()).toBe(true);
      expect(fakeCustomElements.define).toHaveBeenCalledTimes(1);
      expect(registry.has("jiange-sheet")).toBe(true);

      const Ctor = registry.get("jiange-sheet")!;
      const el = new Ctor() as unknown as JiangeSheetElement & {
        isConnected: boolean;
        connectedCallback(): void;
        disconnectedCallback(): void;
      };
      const wb = Workbook.create({ sheets: [{ name: "WC", rows: 10, cols: 5 }] });

      // Connected with null workbook -> no mount
      el.isConnected = true;
      el.connectedCallback();
      expect(el.workbook).toBeNull();
      expect(el.mounted).toBeNull();

      // Disconnected with workbook -> no mount
      el.isConnected = false;
      el.workbook = wb;
      expect(el.workbook).toBe(wb);
      expect(el.mounted).toBeNull();

      // Connected with workbook -> mounts asynchronously
      el.isConnected = true;
      el.connectedCallback();
      await new Promise((r) => setTimeout(r, 10));
      expect(el.mounted).not.toBeNull();

      // Updating options disposes previous mount and remounts
      el.options = { gpu: { prefer: "headless" } };
      expect(el.options).toEqual({ gpu: { prefer: "headless" } });
      await new Promise((r) => setTimeout(r, 10));
      expect(el.mounted).not.toBeNull();

      // Disconnect while mounted, then disconnect again while already unmounted
      el.isConnected = false;
      el.disconnectedCallback();
      expect(el.mounted).toBeNull();
      el.disconnectedCallback();

      // Race: disconnect before async mountSheetView resolves -> disposes resolved view
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

import { describe, expect, it, vi } from "vitest";
import { Base } from "@jiange/base-sdk";
import {
  createBaseViewComponent,
  defineBaseElement,
  mountBaseView,
  type JiangeBaseElement,
} from "../src/index.js";
import { createBaseViewComponent as createBaseViewFromReactSubpath } from "../src/react.js";

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
    clientHeight: 560,
    ownerDocument: null as unknown,
    appendChild(c: unknown) { this.children.push(c); return c; },
    remove: vi.fn(),
    getContext: () => null,
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

describe("@jiange/base-ui (WebGPU/WebGL2 Grid, Kanban, Gantt & Dashboard)", () => {
  it("renders grid with conditional row fills, kanban groups, gantt bars, and dashboard GPU charts", async () => {
    const base = Base.create({ name: "Roadmap" });
    const tid = base.getTables()[0].id;
    const statusF = base.addField(tid, { name: "Status", type: "select", options: ["Todo", "Done"] });
    const ptsF = base.addField(tid, { name: "Points", type: "number" });
    base.addField(tid, { name: "Done", type: "checkbox" });
    base.addField(tid, { name: "Due", type: "date" });

    const r1 = base.addRecord(tid, { Name: "WebGPU Engine", Status: "Done", Points: 8, Done: true, Due: "2026-11-21" });
    base.addRecord(tid, { Name: "Go MCP CLI", Status: "Todo", Points: 5, Done: false, Due: "2026-11-25" });

    const fakeDoc = { createElement: (t: string) => makeDomNode(t) };
    const container = makeDomNode("div");
    container.ownerDocument = fakeDoc;

    const mounted = await mountBaseView(container as unknown as HTMLElement, base, {
      gpu: { prefer: "headless" },
      fills: [{ f: statusF.id, op: "eq", v: "Done", color: 1 }],
    });
    const ctrl = mounted.controller;
    expect(ctrl.getMode()).toBe("grid");

    // Grid mode with fill rule, cell update, query, wheel scroll
    const gridFrame = ctrl.updateCell(r1.id, "Points", 13);
    expect(gridFrame.recordCount).toBe(2);
    expect(gridFrame.gpu.rectInstances).toBeGreaterThanOrEqual(2);
    ctrl.setFills([{ f: ptsF.id, op: "gte", v: 10, color: 2 }]);
    ctrl.setQuery({ sorts: [{ f: ptsF.id, asc: false }] });
    container.dispatch("wheel", { deltaX: 10, deltaY: 20 });

    // Kanban mode
    const kanban = ctrl.setMode("kanban");
    expect(kanban.mode).toBe("kanban");
    expect(kanban.mountedElements).toBe(2);

    // Gantt mode (header + frozen label pane backdrops + 2 bars, plus vertical scroll clipTop)
    const gantt = ctrl.setMode("gantt");
    expect(gantt.mode).toBe("gantt");
    expect(gantt.gpu.rectInstances).toBe(4);
    ctrl.scrollBy(24, 14);

    // Dashboard GPU mode (metric cards, bar chart, pie arcs, trend)
    const dash = ctrl.setMode("dashboard");
    expect(dash.mode).toBe("dashboard");
    expect(dash.gpu.arcInstances).toBeGreaterThanOrEqual(2);
    expect(dash.gpu.rectInstances).toBeGreaterThan(5);

    ctrl.setTable(tid);
    mounted.resize(1200, 720);
    mounted.dispose();

    // React adapter
    const cleanups: Array<() => void> = [];
    let rc = 0;
    const fakeReact = {
      useEffect: (fn: () => void | (() => void)) => { const c = fn(); if (typeof c === "function") cleanups.push(c); },
      useRef: <V>(v: V) => ({ current: rc++ === 0 ? (container as unknown as V) : v }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const BaseView = createBaseViewComponent(fakeReact);
    expect((BaseView({ base, width: 800, height: 500, gpu: { prefer: "headless" } }) as { type: string }).type).toBe("div");
    expect((BaseView({ base, gpu: { prefer: "headless" } }) as { type: string }).type).toBe("div");
    await new Promise((r) => setTimeout(r, 10));
    cleanups.forEach((c) => c());

    // Cover minimal schema (no select/date field) and offscreen scrolled rows
    const simpleBase = Base.create({ name: "Simple" });
    simpleBase.addRecord(undefined, { Name: "Only Text" });
    const c2 = makeDomNode("div");
    c2.ownerDocument = fakeDoc;
    const m2 = await mountBaseView(c2 as unknown as HTMLElement, simpleBase, { gpu: { prefer: "headless" }, mode: "kanban" });
    m2.controller.scrollBy(0, 5000);
    m2.controller.setMode("gantt");
    m2.controller.scrollBy(0, 5000);
    m2.controller.setMode("dashboard");
    m2.dispose();
  });

  it("covers fallback labels, ungrouped kanban, zero-total pie, zero-sized container, and unmount-before-mount-resolves", async () => {
    const fakeDoc = { createElement: (t: string) => makeDomNode(t) };

    // 1. Table with only non-primary field (isPrimary: false) -> hits `?? fields[0]` in kanban & gantt
    const noPrimaryBase = Base.create({ name: "NoPrimary" });
    const npTid = noPrimaryBase.getTables()[0].id;
    const origPrimary = noPrimaryBase.getFields(npTid)[0];
    noPrimaryBase.addField(npTid, { name: "Notes", type: "text" });
    noPrimaryBase.apply([{ op: "deleteField", fieldId: origPrimary.id }]);
    noPrimaryBase.addRecord(npTid, { Notes: "Item A" });

    // Container with 0x0 client dimensions -> hits `clientWidth || 960` and `clientHeight || 560`
    const zeroContainer = makeDomNode("div");
    zeroContainer.clientWidth = 0;
    zeroContainer.clientHeight = 0;
    zeroContainer.ownerDocument = fakeDoc;

    const mNp = await mountBaseView(zeroContainer as unknown as HTMLElement, noPrimaryBase, {
      gpu: { prefer: "headless" },
      mode: "kanban",
    });
    expect(mNp.controller.render().mountedElements).toBe(1);
    expect(mNp.controller.setMode("gantt").mountedElements).toBe(1);

    // Zero-totalValue pie series -> hits `item.series.totalValue || 1`
    vi.spyOn(noPrimaryBase, "evaluateDashboard").mockReturnValueOnce([
      {
        widget: { id: "zero-pie", type: "pie", title: "Zero Pie", tableId: npTid, span: 1, metric: "sum" },
        series: {
          buckets: [{ key: "k", label: "Zero", count: 1, value: 0, sum: 0, avg: 0, sharePct: 0, color: "#3370ff" }],
          totalValue: 0,
          totalCount: 1,
          metric: "sum",
        },
      },
    ]);
    const zeroPieFrame = mNp.controller.setMode("dashboard");
    expect(zeroPieFrame.gpu.arcInstances).toBe(1);
    mNp.dispose();

    // 2. Table with zero fields -> hits `grouped.groups ?? [...]` and `#${rec.id}` fallbacks in kanban & gantt
    const emptySchemaBase = Base.create({ name: "ZeroFields" });
    const esTid = emptySchemaBase.getTables()[0].id;
    emptySchemaBase.addRecord(esTid, {});
    for (const f of emptySchemaBase.getFields(esTid)) {
      emptySchemaBase.apply([{ op: "deleteField", fieldId: f.id }]);
    }
    const cEmpty = makeDomNode("div");
    cEmpty.ownerDocument = fakeDoc;
    const mEmpty = await mountBaseView(cEmpty as unknown as HTMLElement, emptySchemaBase, {
      gpu: { prefer: "headless" },
      mode: "kanban",
    });
    expect(mEmpty.controller.render().mountedElements).toBe(1);
    expect(mEmpty.controller.setMode("gantt").mountedElements).toBe(1);
    mEmpty.dispose();

    // 3. React unmount before async mountBaseView resolves -> hits `if (!alive) v.dispose()`
    const cRace = makeDomNode("div");
    cRace.ownerDocument = fakeDoc;
    let raceCleanup: (() => void) | undefined;
    const raceReact = {
      useEffect: (fn: () => void | (() => void)) => {
        const c = fn();
        if (typeof c === "function") raceCleanup = c;
      },
      useRef: <V>() => ({ current: cRace as unknown as V }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const RaceBaseView = createBaseViewComponent(raceReact);
    RaceBaseView({ base: noPrimaryBase, gpu: { prefer: "headless" } });
    // Unmount synchronously BEFORE mountBaseView promise resolves
    raceCleanup?.();
    await new Promise((r) => setTimeout(r, 15));
    expect(cRace.children.length).toBeGreaterThan(0);
  });

  it("defineBaseElement is SSR-safe and registers <jiange-base> lifecycle cleanly", async () => {
    expect(createBaseViewFromReactSubpath).toBe(createBaseViewComponent);
    expect(defineBaseElement()).toBe(false);

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
      clientHeight = 560;
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
      expect(defineBaseElement()).toBe(false);

      Object.defineProperty(globalThis, "HTMLElement", { value: FakeHTMLElement, configurable: true, writable: true });
      expect(defineBaseElement()).toBe(true);
      expect(defineBaseElement()).toBe(true);
      expect(fakeCustomElements.define).toHaveBeenCalledTimes(1);
      expect(registry.has("jiange-base")).toBe(true);

      const Ctor = registry.get("jiange-base")!;
      const el = new Ctor() as unknown as JiangeBaseElement & {
        isConnected: boolean;
        connectedCallback(): void;
        disconnectedCallback(): void;
      };
      const base = Base.create({ name: "WC Base" });

      el.isConnected = true;
      el.connectedCallback();
      expect(el.base).toBeNull();
      expect(el.mounted).toBeNull();

      el.isConnected = false;
      el.base = base;
      expect(el.base).toBe(base);
      expect(el.mounted).toBeNull();

      el.isConnected = true;
      el.connectedCallback();
      await new Promise((r) => setTimeout(r, 10));
      expect(el.mounted).not.toBeNull();

      el.options = { gpu: { prefer: "headless" }, mode: "kanban" };
      expect(el.options).toEqual({ gpu: { prefer: "headless" }, mode: "kanban" });
      await new Promise((r) => setTimeout(r, 10));
      expect(el.mounted).not.toBeNull();

      el.isConnected = false;
      el.disconnectedCallback();
      expect(el.mounted).toBeNull();
      el.disconnectedCallback();

      // Async mount race: disconnect before mountBaseView resolves
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

import { describe, expect, it, vi } from "vitest";
import { Document } from "@jiange/doc-sdk";
import {
  DocViewController,
  createDocViewComponent,
  defineDocElement,
  mountDocView,
  type JiangeDocElement,
} from "../src/index.js";
import { createDocViewComponent as createDocViewFromReactSubpath } from "../src/react.js";

function makeDomNode(tag: string) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    tagName: tag.toUpperCase(),
    style: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    children: [] as unknown[],
    textContent: "",
    clientWidth: 760,
    clientHeight: 400,
    ownerDocument: null as unknown,
    appendChild(c: unknown) { this.children.push(c); return c; },
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    remove: vi.fn(),
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

describe("@jiange/doc-ui (VirtualList1D Document Editor)", () => {
  it("virtualizes large documents, tracks dynamic heights, jumps by outline, edits blocks, and mounts cleanly", () => {
    const mdLines = ["# Architecture", "## Overview", "Intro paragraph.", "```ts\nconst x = 1;\n```", "---"];
    for (let i = 0; i < 200; i++) mdLines.push(`Paragraph ${i} with sample text.`);
    mdLines.push("### Conclusion", "Final summary.");
    const doc = Document.fromMarkdown(mdLines.join("\n\n"), "RFC");

    const fakeDoc = { createElement: (t: string) => makeDomNode(t) };
    const container = makeDomNode("div");
    container.ownerDocument = fakeDoc;

    const onFocus = vi.fn();
    const mounted = mountDocView(container as unknown as HTMLElement, doc, { onActiveBlockChange: onFocus });
    const ctrl = mounted.controller;

    const initial = ctrl.render();
    expect(initial.visibleCount).toBeLessThan(30);
    expect(initial.totalHeight).toBeGreaterThan(5000);

    // Outline jump & dynamic ResizeObserver height feedback
    const jumped = ctrl.jumpToHeading("Conclusion");
    expect(jumped.start).toBeGreaterThan(150);
    expect(onFocus).toHaveBeenCalled();
    const activeId = ctrl.getActiveBlockId()!;
    ctrl.reportBlockHeight(activeId, 88);
    ctrl.reportBlockHeight("unknown-block-id", 64);

    // Edit, insert, delete, keyboard shortcuts, wheel scroll
    ctrl.updateActiveText("Updated Conclusion");
    expect(doc.getBlock(activeId)?.text).toBe("Updated Conclusion");
    const inserted = ctrl.insertBlockAfterActive("paragraph", "New note");
    expect(inserted).not.toBeNull();
    expect(ctrl.handleKeyDown("Enter")).toBe(true);
    expect(ctrl.deleteActiveBlock()).toBe(true);
    container.dispatch("wheel", { deltaY: 120 });
    container.dispatch("keydown", { key: "z", ctrlKey: true });
    container.dispatch("keydown", { key: "z", ctrlKey: true, shiftKey: true });

    mounted.resize(900, 600);
    mounted.dispose();

    // React wrapper
    const cleanups: Array<() => void> = [];
    let rc = 0;
    const fakeReact = {
      useEffect: (fn: () => void | (() => void)) => { const c = fn(); if (typeof c === "function") cleanups.push(c); },
      useRef: <V>(v: V) => ({ current: rc++ === 0 ? (container as unknown as V) : v }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const DocView = createDocViewComponent(fakeReact);
    expect((DocView({ document: doc, width: 800, height: 600 }) as { type: string }).type).toBe("div");
    cleanups.forEach((c) => c());

    // Direct controller sanity
    const roCtrl = new DocViewController(doc, () => makeDomNode("div") as unknown as HTMLElement, { readOnly: true });
    expect(roCtrl.insertBlockAfterActive()).toBeNull();
    expect(roCtrl.deleteActiveBlock()).toBe(false);
    roCtrl.dispose();
  });

  it("covers heading miss, readOnly/unfocused guards, deleting last/sole block, keydown fallthroughs, zero-sized container, and React null-ref/default-size", () => {
    const fakeDoc = { createElement: (t: string) => makeDomNode(t) };
    const doc = Document.fromMarkdown("First paragraph\n\nSecond paragraph", "TwoBlocks");

    // Container with 0x0 dimensions -> hits `clientWidth || 760` and `clientHeight || 600`
    const zeroContainer = makeDomNode("div");
    zeroContainer.clientWidth = 0;
    zeroContainer.clientHeight = 0;
    zeroContainer.ownerDocument = fakeDoc;

    const mounted = mountDocView(zeroContainer as unknown as HTMLElement, doc);
    const ctrl = mounted.controller;

    // Missing heading jump -> falls through to render()
    const missFrame = ctrl.jumpToHeading("NonExistentHeading");
    expect(missFrame.visibleCount).toBe(2);

    // updateActiveText when no active block is focused
    ctrl.focusBlock(null);
    ctrl.updateActiveText("no-op");
    expect(ctrl.handleKeyDown("Enter")).toBe(false);

    // Non-matching key and Shift+Enter -> handleKeyDown returns false (and keydown listener doesn't preventDefault)
    const blocks = doc.blocks();
    ctrl.focusBlock(blocks[1].id);
    expect(ctrl.handleKeyDown("Enter", { shiftKey: true })).toBe(false);
    expect(ctrl.handleKeyDown("a")).toBe(false);
    zeroContainer.dispatch("keydown", { key: "a" });

    // deleteActiveBlock with unknown active block id -> returns false
    ctrl.focusBlock("missing-block-id");
    expect(ctrl.deleteActiveBlock()).toBe(false);

    // Delete last block -> focuses previous block (`blocks[idx - 1]`)
    ctrl.focusBlock(blocks[1].id);
    expect(ctrl.deleteActiveBlock()).toBe(true);
    expect(ctrl.getActiveBlockId()).toBe(blocks[0].id);

    // Delete sole remaining block -> next is null -> focusBlock(null)
    expect(ctrl.deleteActiveBlock()).toBe(true);
    expect(ctrl.getActiveBlockId()).toBeNull();

    mounted.dispose();

    // readOnly updateActiveText guard
    const roCtrl = new DocViewController(doc, () => makeDomNode("div") as unknown as HTMLElement, { readOnly: true });
    roCtrl.focusBlock("some-id");
    roCtrl.updateActiveText("ignored");
    roCtrl.dispose();

    // React wrapper with null hostRef and omitted width/height props ("100%")
    const fakeReactNull = {
      useEffect: (fn: () => void | (() => void)) => { fn(); },
      useRef: <V>(v: V) => ({ current: v }),
      createElement: vi.fn((type, props) => ({ type, props })),
    };
    const DocView = createDocViewComponent(fakeReactNull);
    const el = DocView({ document: doc }) as { type: string; props: { style: { width: string; height: string } } };
    expect(el.type).toBe("div");
    expect(el.props.style).toEqual({ width: "100%", height: "100%" });
  });

  it("defineDocElement is SSR-safe and registers <jiange-doc> lifecycle cleanly", () => {
    expect(createDocViewFromReactSubpath).toBe(createDocViewComponent);
    expect(defineDocElement()).toBe(false);

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
      clientWidth = 760;
      clientHeight = 400;
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
      expect(defineDocElement()).toBe(false);

      Object.defineProperty(globalThis, "HTMLElement", { value: FakeHTMLElement, configurable: true, writable: true });
      expect(defineDocElement()).toBe(true);
      expect(defineDocElement()).toBe(true);
      expect(fakeCustomElements.define).toHaveBeenCalledTimes(1);
      expect(registry.has("jiange-doc")).toBe(true);

      const Ctor = registry.get("jiange-doc")!;
      const el = new Ctor() as unknown as JiangeDocElement & {
        isConnected: boolean;
        connectedCallback(): void;
        disconnectedCallback(): void;
      };
      const doc = Document.fromMarkdown("# Hello\n\nBody", "WC");

      el.isConnected = true;
      el.connectedCallback();
      expect(el.document).toBeNull();
      expect(el.mounted).toBeNull();

      el.isConnected = false;
      el.document = doc;
      expect(el.document).toBe(doc);
      expect(el.mounted).toBeNull();

      el.isConnected = true;
      el.connectedCallback();
      expect(el.mounted).not.toBeNull();

      el.options = { readOnly: true };
      expect(el.options).toEqual({ readOnly: true });
      expect(el.mounted).not.toBeNull();

      el.isConnected = false;
      el.disconnectedCallback();
      expect(el.mounted).toBeNull();
      el.disconnectedCallback();
    } finally {
      if (origCustomElements) Object.defineProperty(globalThis, "customElements", origCustomElements);
      else delete (globalThis as Record<string, unknown>).customElements;
      if (origHtmlElement) Object.defineProperty(globalThis, "HTMLElement", origHtmlElement);
      else delete (globalThis as Record<string, unknown>).HTMLElement;
    }
  });
});

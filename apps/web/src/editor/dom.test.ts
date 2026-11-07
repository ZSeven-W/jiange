import { afterEach, describe, expect, it, vi } from "vitest";
import { domToPos, posToDom } from "./dom";

// Minimal DOM projection. Browser selection behavior also needs UI coverage.
class FakeText {
  readonly nodeType = 3;
  parentElement: FakeElement | null = null;
  constructor(public textContent: string) {}
  contains(node: unknown) { return node === this; }
}
class FakeElement {
  readonly nodeType = 1;
  parentElement: FakeElement | null = null;
  childNodes: (FakeText | FakeElement)[] = [];
  constructor(public dataset: Record<string, string> = {}) {}
  append(...nodes: (FakeText | FakeElement)[]) { for (const node of nodes) { node.parentElement = this; this.childNodes.push(node); } return this; }
  get textContent(): string { return this.childNodes.map((n) => n.textContent).join(""); }
  contains(node: unknown): boolean { return node === this || this.childNodes.some((n) => n.contains(node)); }
  closest<T>(_selector: string): T | null { let node: FakeElement | null = this; while (node && !node.dataset.block) node = node.parentElement; return node as T | null; }
  querySelector(selector: string): FakeElement | null {
    const matches = (node: FakeElement) => selector === "[data-text]" ? "text" in node.dataset : selector === `[data-block="${node.dataset.block}"]`;
    for (const child of this.childNodes) if (child instanceof FakeElement) {
      if (matches(child)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}
const asNode = (node: FakeText | FakeElement) => node as unknown as Node;
const asRoot = (node: FakeElement) => node as unknown as HTMLElement;

function setup() {
  vi.stubGlobal("Node", { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_POSITION_FOLLOWING: 4 });
  vi.stubGlobal("document", { createRange: () => {
    let end: FakeText | null = null, offset = 0;
    return { selectNodeContents: () => {}, setEnd: (node: FakeText, at: number) => { end = node; offset = at; }, toString: () => end?.textContent.slice(0, offset) ?? "" };
  } });
  const before = new FakeText("前😀"), visual = new FakeText("x²"), after = new FakeText("后𐍈");
  const formula = new FakeElement({ modelLength: "3" }).append(new FakeElement().append(visual));
  const text = new FakeElement({ text: "" }).append(before, formula, after);
  const block = new FakeElement({ block: "1:7" }).append(text);
  const root = new FakeElement().append(block);
  return { root, text, before, formula, visual, after };
}
afterEach(() => vi.unstubAllGlobals());

describe("formula-aware DOM positions", () => {
  it("maps text and formula boundaries in Unicode code points", () => {
    const { root, text, before, after } = setup();
    const pos = (o: number) => ({ b: { client: 1, clock: 7 }, o });
    const points = [
      { model: 0, node: before, offset: 0 }, { model: 1, node: before, offset: 1 },
      { model: 2, node: before, offset: 3 }, { model: 5, node: text, offset: 2 },
      { model: 6, node: after, offset: 1 }, { model: 7, node: after, offset: 3 },
    ];
    for (const point of points) {
      expect(posToDom(asRoot(root), pos(point.model))).toEqual({ node: point.node, offset: point.offset });
      expect(domToPos(asRoot(root), asNode(point.node), point.offset)).toEqual(pos(point.model));
    }
    expect(domToPos(asRoot(root), asNode(text), 1)).toEqual(pos(2));
    expect(domToPos(asRoot(root), asNode(text), 2)).toEqual(pos(5));
  });

  it("never creates a model or DOM caret inside the formula", () => {
    const { root, text, visual } = setup();
    const pos = (o: number) => ({ b: { client: 1, clock: 7 }, o });
    expect(posToDom(asRoot(root), pos(3))).toEqual({ node: text, offset: 1 });
    expect(posToDom(asRoot(root), pos(4))).toEqual({ node: text, offset: 2 });
    expect(domToPos(asRoot(root), asNode(visual), 0)).toEqual(pos(2));
    expect(domToPos(asRoot(root), asNode(visual), 2)).toEqual(pos(5));
  });
});

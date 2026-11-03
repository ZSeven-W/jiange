import { idKey, type OpId } from "@jiange/collab";
import type { Pos } from "./model";

const cpLen = (s: string) => [...s].length;

export function blockEl(root: HTMLElement, b: OpId): HTMLElement | null {
  return root.querySelector(`[data-block="${idKey(b)}"]`);
}

function textEl(el: HTMLElement): HTMLElement | null {
  return el.querySelector("[data-text]");
}

export function parseId(k: string): OpId {
  const [c, n] = k.split(":");
  return { client: Number(c), clock: Number(n) };
}

/** DOM point → model position (code points), or null if outside the editor's text. */
export function domToPos(root: HTMLElement, node: Node, offset: number): Pos | null {
  const el = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>("[data-block]");
  if (!el || !root.contains(el)) return null;
  const b = parseId(el.dataset.block!);
  const t = textEl(el);
  if (!t) return { b, o: 0 };
  if (!t.contains(node)) {
    // point in decoration/prefix: before or after the text
    const after = t.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING;
    return { b, o: after ? cpLen(t.textContent ?? "") : 0 };
  }
  let o = 0;
  const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
  if (node.nodeType === 3) {
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n === node) return { b, o: o + cpLen((n.textContent ?? "").slice(0, offset)) };
      o += cpLen(n.textContent ?? "");
    }
    return { b, o };
  }
  // element container: count text before child[offset]
  const child = node.childNodes[offset];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (child && (child === n || child.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING || child.contains(n))) break;
    o += cpLen(n.textContent ?? "");
  }
  return { b, o };
}

/** Model position → DOM point. */
export function posToDom(root: HTMLElement, p: Pos): { node: Node; offset: number } | null {
  const el = blockEl(root, p.b);
  if (!el) return null;
  const t = textEl(el);
  if (!t) return { node: el, offset: 0 };
  let left = p.o;
  const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
  let last: Node | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.textContent ?? "";
    const l = cpLen(s);
    if (left <= l) {
      let u = 0;
      for (let i = 0; i < left; i++) u += s.codePointAt(u)! > 0xffff ? 2 : 1;
      return { node: n, offset: u };
    }
    left -= l;
    last = n;
  }
  if (last) return { node: last, offset: (last.textContent ?? "").length };
  return { node: t, offset: 0 };
}

export function caretRect(root: HTMLElement, p: Pos): DOMRect | null {
  const d = posToDom(root, p);
  if (!d) return null;
  const r = document.createRange();
  r.setStart(d.node, d.offset);
  r.collapse(true);
  const rects = r.getClientRects();
  if (rects.length) return rects[rects.length - 1];
  const el = d.node.nodeType === 1 ? (d.node as HTMLElement) : d.node.parentElement!;
  return el.getBoundingClientRect();
}

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

/** A non-editable projection can represent more (or fewer) model characters. */
function atomicLength(node: Node): number | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const raw = (node as HTMLElement).dataset.modelLength;
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

function modelLength(node: Node): number {
  const atom = atomicLength(node);
  if (atom !== null) return atom;
  if (node.nodeType === Node.TEXT_NODE) return cpLen(node.textContent ?? "");
  let total = 0;
  for (const child of node.childNodes) total += modelLength(child);
  return total;
}

/** Points inside a rendered formula snap to its nearest displayed edge. */
function atomOffset(atom: Node, target: Node, offset: number, length: number): number {
  if (target === atom) return offset <= 0 ? 0 : length;
  try {
    const range = document.createRange();
    range.selectNodeContents(atom);
    range.setEnd(target, offset);
    const before = cpLen(range.toString());
    const total = cpLen(atom.textContent ?? "");
    return total > 0 && before * 2 >= total ? length : 0;
  } catch {
    return 0;
  }
}

/** Count model characters before a DOM point without traversing atomic projections. */
function modelOffset(container: Node, target: Node, offset: number): { value: number; found: boolean } {
  const atom = atomicLength(container);
  if (atom !== null) {
    if (container === target || container.contains(target)) return { value: atomOffset(container, target, offset, atom), found: true };
    return { value: atom, found: false };
  }
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent ?? "";
    if (container === target) return { value: cpLen(text.slice(0, Math.max(0, Math.min(offset, text.length)))), found: true };
    return { value: cpLen(text), found: false };
  }
  if (container === target) {
    let value = 0;
    const limit = Math.max(0, Math.min(offset, container.childNodes.length));
    for (let i = 0; i < limit; i++) value += modelLength(container.childNodes[i]);
    return { value, found: true };
  }
  let value = 0;
  for (const child of container.childNodes) {
    const part = modelOffset(child, target, offset);
    value += part.value;
    if (part.found) return { value, found: true };
  }
  return { value, found: false };
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
    return { b, o: after ? modelLength(t) : 0 };
  }
  return { b, o: modelOffset(t, node, offset).value };
}

/** Model position → DOM point, snapped away from the inside of an atom. */
export function posToDom(root: HTMLElement, p: Pos): { node: Node; offset: number } | null {
  const el = blockEl(root, p.b);
  if (!el) return null;
  const t = textEl(el);
  if (!t) return { node: el, offset: 0 };
  let left = Math.max(0, p.o);
  let last: { node: Node; offset: number } = { node: t, offset: 0 };
  function walk(parent: Node): { node: Node; offset: number } | null {
    for (let i = 0; i < parent.childNodes.length; i++) {
      const child = parent.childNodes[i];
      const atom = atomicLength(child);
      if (atom !== null) {
        if (left <= atom) return { node: parent, offset: i + (left * 2 >= atom ? 1 : 0) };
        left -= atom;
        last = { node: parent, offset: i + 1 };
      } else if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? "", length = cpLen(text);
        if (left <= length) {
          let offset = 0;
          for (let j = 0; j < left; j++) offset += text.codePointAt(offset)! > 0xffff ? 2 : 1;
          return { node: child, offset };
        }
        left -= length;
        last = { node: child, offset: text.length };
      } else {
        const found = walk(child);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(t) ?? last;
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

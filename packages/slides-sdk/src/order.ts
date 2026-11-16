import type { SlidesPage } from "./model.js";
export type SlidePosition = { id: number; pos: number };
export function slidePositions(pages: readonly SlidesPage[]): SlidePosition[] { return pages.map(({ id, pos }) => ({ id, pos })); }
export function samePositions(a: readonly SlidePosition[], b: readonly SlidePosition[]): boolean { return a.length === b.length && a.every((item, i) => item.id === b[i].id && item.pos === b[i].pos); }
export function slideDropIndex(from: number, target: number, after: boolean): number { const insertion = target + (after ? 1 : 0); return insertion - (from < insertion ? 1 : 0); }
export function verifySlideOrder(expected: readonly SlidePosition[], id: number, to: number, raw: unknown): SlidePosition[] | null {
  if (!Array.isArray(raw) || raw.length !== expected.length || to < 0 || to >= expected.length) return null;
  const ids = expected.map((item) => item.id), from = ids.indexOf(id);
  if (from < 0 || from === to) return null;
  ids.splice(from, 1); ids.splice(to, 0, id);
  return raw.every((item, i) => item && typeof item === "object" && item.id === ids[i] && item.pos === i + 1) ? raw as SlidePosition[] : null;
}

/** Speed for a drag near the scroll viewport edge; ignore pointers outside it. */
export function slideEdgeScrollSpeed(rect: { left: number; right: number; top: number; bottom: number }, x: number, y: number): number {
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return 0;
  if (y < rect.top + 32) return -Math.ceil((rect.top + 32 - y) / 3);
  if (y > rect.bottom - 32) return Math.ceil((y - rect.bottom + 32) / 3);
  return 0;
}

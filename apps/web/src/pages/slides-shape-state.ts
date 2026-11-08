import type { SlideShape } from "@/lib/api";

/** Apply a partial change without discarding newer edits to other properties. */
export function patchSlideShape(shapes: SlideShape[], id: string, patch: Partial<SlideShape>): SlideShape[] {
  return shapes.map((item) => {
    if (item.id !== id) return item;
    const next = { ...item, ...patch };
    return { ...next, x: Math.min(next.x, 100 - (next.width ?? 16)), y: Math.min(next.y, 100 - (next.height ?? 20)) };
  });
}

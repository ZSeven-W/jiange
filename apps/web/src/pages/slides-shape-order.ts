import type { SlideShape } from "@/lib/api";

export type ShapeOrderAction = "front" | "forward" | "backward" | "back";
export type ShapeAlignment = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** Defaults must mirror the renderer in slides-shapes.tsx. */
const DEFAULT_WIDTH = 16;
const DEFAULT_HEIGHT = 20;
const round = (value: number) => Math.round(value * 10) / 10;

/** The shapes array order is the stacking order; later entries render on top. */
export function moveShapeOrder(shapes: SlideShape[], id: string, action: ShapeOrderAction): SlideShape[] {
  const index = shapes.findIndex((shape) => shape.id === id);
  if (index < 0 || shapes.length < 2) return shapes;
  const target = action === "front" ? shapes.length - 1 : action === "back" ? 0 : action === "forward" ? Math.min(index + 1, shapes.length - 1) : Math.max(index - 1, 0);
  if (target === index) return shapes;
  const next = shapes.slice();
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/** Align one shape against the slide bounds; rotation does not affect placement. */
export function alignSlideShape(shape: SlideShape, alignment: ShapeAlignment): SlideShape {
  const width = shape.width ?? DEFAULT_WIDTH;
  const height = shape.height ?? DEFAULT_HEIGHT;
  const next = alignment === "left" ? { x: 0 } : alignment === "hcenter" ? { x: round((100 - width) / 2) } : alignment === "right" ? { x: round(100 - width) } : alignment === "top" ? { y: 0 } : alignment === "vcenter" ? { y: round((100 - height) / 2) } : { y: round(100 - height) };
  const moved = { ...shape, ...next };
  return moved.x === shape.x && moved.y === shape.y ? shape : moved;
}

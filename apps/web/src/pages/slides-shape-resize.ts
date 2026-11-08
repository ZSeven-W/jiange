import type { SlideShape } from "@/lib/api";

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** Resize in slide pixels, keeping the opposite handle fixed even when rotated. */
export function resizeSlideShape(shape: SlideShape, handle: ResizeHandle, dx: number, dy: number, canvasWidth: number, canvasHeight: number): SlideShape {
  if (!(canvasWidth > 0 && canvasHeight > 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) return shape;
  const sx = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const sy = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  const angle = (shape.rotation ?? 0) * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const width = shape.width ?? 16, height = shape.height ?? 20;
  const localX = cos * dx + sin * dy;
  const localY = -sin * dx + cos * dy;
  const targetWidth = sx ? Math.max(5, Math.min(100, width + sx * localX / canvasWidth * 100)) : width;
  const targetHeight = sy ? Math.max(5, Math.min(100, height + sy * localY / canvasHeight * 100)) : height;
  const at = (t: number) => {
    const w = width + (targetWidth - width) * t;
    const h = height + (targetHeight - height) * t;
    const centerX = sx * (w - width) * canvasWidth / 200;
    const centerY = sy * (h - height) * canvasHeight / 200;
    const x = shape.x + (width - w) / 2 + (cos * centerX - sin * centerY) / canvasWidth * 100;
    const y = shape.y + (height - h) / 2 + (sin * centerX + cos * centerY) / canvasHeight * 100;
    return { x, y, width: w, height: h };
  };
  const valid = (r: ReturnType<typeof at>) => r.x >= 0 && r.y >= 0 && r.x + r.width <= 100 && r.y + r.height <= 100;
  let low = 0, high = 1;
  if (valid(at(1))) low = 1;
  else for (let i = 0; i < 30; i++) { const middle = (low + high) / 2; if (valid(at(middle))) low = middle; else high = middle; }
  const result = at(low);
  const round = (n: number) => Math.round(n * 10) / 10;
  const w = round(result.width), h = round(result.height);
  return { ...shape, x: Math.max(0, Math.min(100 - w, round(result.x))), y: Math.max(0, Math.min(100 - h, round(result.y))), width: w, height: h };
}

import type { SlideShape } from "@/lib/api";

export type LineEndpoint = "start" | "end";
type Point = { x: number; y: number };

/** Endpoints of the visible 5%-to-95% stroke in slide pixels. */
export function slideLineEndpoints(shape: SlideShape, canvasWidth: number, canvasHeight: number): Record<LineEndpoint, Point> {
  const width = (shape.width ?? 16) * canvasWidth / 100;
  const height = (shape.height ?? 20) * canvasHeight / 100;
  const center = { x: shape.x * canvasWidth / 100 + width / 2, y: shape.y * canvasHeight / 100 + height / 2 };
  const angle = (shape.rotation ?? 0) * Math.PI / 180;
  const x = Math.cos(angle) * width * 0.45, y = Math.sin(angle) * width * 0.45;
  return { start: { x: center.x - x, y: center.y - y }, end: { x: center.x + x, y: center.y + y } };
}

/** Move one end in slide pixels, holding the other fixed when the model can represent it. */
export function moveSlideLineEndpoint(shape: SlideShape, endpoint: LineEndpoint, dx: number, dy: number, canvasWidth: number, canvasHeight: number): SlideShape {
  if (!(canvasWidth > 0 && canvasHeight > 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) return shape;
  const original = slideLineEndpoints(shape, canvasWidth, canvasHeight);
  const moving = original[endpoint];
  const target = { x: Math.max(0, Math.min(canvasWidth, moving.x + dx)), y: Math.max(0, Math.min(canvasHeight, moving.y + dy)) };
  const start = endpoint === "start" ? target : original.start, end = endpoint === "end" ? target : original.end;
  const vx = end.x - start.x, vy = end.y - start.y;
  const length = Math.hypot(vx, vy), width = length / 0.9 / canvasWidth * 100, height = shape.height ?? 20;
  if (width < 5 || width > 100) return shape;
  const centerX = (start.x + end.x) / 2 / canvasWidth * 100, centerY = (start.y + end.y) / 2 / canvasHeight * 100;
  const x = centerX - width / 2, y = centerY - height / 2;
  if (x < 0 || y < 0 || x + width > 100 || y + height > 100) return shape;
  const round = (n: number) => Math.round(n * 100) / 100;
  const roundedWidth = round(width);
  return { ...shape, x: Math.min(100 - roundedWidth, round(x)), y: Math.min(100 - height, round(y)), width: roundedWidth, rotation: (Math.round(Math.atan2(vy, vx) * 180 / Math.PI) + 360) % 360 };
}

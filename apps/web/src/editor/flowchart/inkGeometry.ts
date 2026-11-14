import type { FlowStroke } from "./model";

type Point = { x: number; y: number };
export function inkPointBounds(stroke: FlowStroke) {
  const xs = stroke.points.map((p) => p.x), ys = stroke.points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Scale around the top-left point bounds, keeping geometry within canvas limits. */
export function scaleInk(stroke: FlowStroke, requested: number): FlowStroke {
  const box = inkPointBounds(stroke);
  if (!Number.isFinite(requested) || (!box.w && !box.h)) return stroke;
  const limitX = box.w ? (20000 - box.x) / box.w : 10;
  const limitY = box.h ? (20000 - box.y) / box.h : 10;
  const minimum = Math.min(1, Math.max(0.1, 1 / Math.max(box.w, box.h)));
  const scale = Math.max(minimum, Math.min(10, limitX, limitY, requested));
  return { ...stroke, points: stroke.points.map((point) => ({ x: Math.round(box.x + (point.x - box.x) * scale), y: Math.round(box.y + (point.y - box.y) * scale) })) };
}

function pointSegmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function cross(a: Point, b: Point, c: Point) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function segmentsCross(a: Point, b: Point, c: Point, d: Point) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (abC === 0 && abD === 0 && cdA === 0 && cdB === 0) return Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
  return (abC <= 0 && abD >= 0 || abC >= 0 && abD <= 0) && (cdA <= 0 && cdB >= 0 || cdA >= 0 && cdB <= 0);
}

/** Test a swept eraser segment, including sparse pointer events and dots. */
export function inkHitByEraser(stroke: FlowStroke, from: Point, to: Point, radius: number): boolean {
  const distance = Math.max(0, radius) + stroke.width / 2;
  const points = stroke.points;
  if (points.length === 1) return pointSegmentDistance(points[0], from, to) <= distance;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (segmentsCross(a, b, from, to) || Math.min(pointSegmentDistance(a, from, to), pointSegmentDistance(b, from, to), pointSegmentDistance(from, a, b), pointSegmentDistance(to, a, b)) <= distance) return true;
  }
  return false;
}

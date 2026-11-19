import type { FlowNode, FlowStroke } from "./model.js";

type Point = { x: number; y: number };
export interface SelectionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function inkPointBounds(stroke: FlowStroke) {
  const xs = stroke.points.map((p) => p.x), ys = stroke.points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Combined axis-aligned bounding box of selected nodes and strokes. */
export function selectionBounds(nodes: readonly FlowNode[], strokes: readonly FlowStroke[]): SelectionBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  for (const s of strokes) {
    for (const p of s.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Uniformly scale a multi-selection of nodes and ink strokes around `anchor`,
 * keeping aspect ratios intact and enforcing all canvas & shape limits.
 */
export function scaleSelectionProportionally(
  nodes: readonly FlowNode[],
  strokes: readonly FlowStroke[],
  anchor: Point,
  requested: number,
): { scale: number; nodes: FlowNode[]; strokes: FlowStroke[] } {
  const box = selectionBounds(nodes, strokes);
  if (!box || !Number.isFinite(requested) || requested <= 0 || (!box.w && !box.h)) {
    return { scale: 1, nodes: [...nodes], strokes: [...strokes] };
  }
  let minScale = Math.min(1, Math.max(0.1, 1 / Math.max(box.w, box.h, 1)));
  let maxScale = 10;

  const constrainDelta = (delta: number, origin: number) => {
    if (delta > 0) {
      maxScale = Math.min(maxScale, (20000 - origin) / delta);
    } else if (delta < 0) {
      maxScale = Math.min(maxScale, (-20000 - origin) / delta);
    }
  };

  for (const n of nodes) {
    minScale = Math.max(minScale, 20 / Math.max(n.w, 1), 16 / Math.max(n.h, 1));
    maxScale = Math.min(maxScale, 2000 / Math.max(n.w, 1), 2000 / Math.max(n.h, 1));
    constrainDelta(n.x - anchor.x, anchor.x);
    constrainDelta(n.y - anchor.y, anchor.y);
    constrainDelta(n.x + n.w - anchor.x, anchor.x);
    constrainDelta(n.y + n.h - anchor.y, anchor.y);
  }
  for (const s of strokes) {
    for (const p of s.points) {
      constrainDelta(p.x - anchor.x, anchor.x);
      constrainDelta(p.y - anchor.y, anchor.y);
    }
  }

  const effectiveMin = Math.min(1, minScale);
  const effectiveMax = Math.max(effectiveMin, maxScale);
  const scale = Math.max(effectiveMin, Math.min(effectiveMax, requested));

  const scaledNodes: FlowNode[] = nodes.map((n) => {
    const x = Math.max(-20000, Math.min(20000, Math.round(anchor.x + (n.x - anchor.x) * scale)));
    const y = Math.max(-20000, Math.min(20000, Math.round(anchor.y + (n.y - anchor.y) * scale)));
    const w = Math.max(20, Math.min(2000, Math.round(n.w * scale)));
    const h = Math.max(16, Math.min(2000, Math.round(n.h * scale)));
    return {
      ...n,
      x,
      y,
      w,
      h,
      ...(n.size !== undefined ? { size: Math.max(10, Math.min(48, Math.round(n.size * scale))) } : {}),
    };
  });

  const scaledStrokes: FlowStroke[] = strokes.map((s) => ({
    ...s,
    width: Math.max(1, Math.min(24, Math.round(s.width * scale))),
    points: s.points.map((p) => ({
      x: Math.max(-20000, Math.min(20000, Math.round(anchor.x + (p.x - anchor.x) * scale))),
      y: Math.max(-20000, Math.min(20000, Math.round(anchor.y + (p.y - anchor.y) * scale))),
    })),
  }));

  return { scale, nodes: scaledNodes, strokes: scaledStrokes };
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

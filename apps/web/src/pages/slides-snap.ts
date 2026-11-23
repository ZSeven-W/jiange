import type { SlideShape } from "@/lib/api";

export interface SlideSnapGuide {
  axis: "x" | "y";
  pos: number;
}

export interface SlideSnapResult {
  shape: SlideShape;
  guides: SlideSnapGuide[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clampPct = (value: number, max: number) => round1(Math.min(max, Math.max(0, value)));

/**
 * Compute Feishu-style smart alignment snapping for a dragged slide shape.
 * Snaps left/center/right to the slide center (50%) and sibling edges/centers
 * within `threshold` percentage points.
 */
export function computeSlideShapeSnap(
  candidate: SlideShape,
  siblings: readonly SlideShape[],
  threshold = 1.2,
): SlideSnapResult {
  const w = candidate.width ?? 16;
  const h = candidate.height ?? 20;
  const maxX = Math.max(0, 100 - w);
  const maxY = Math.max(0, 100 - h);

  const xTargets: number[] = [50, 6, 94];
  const yTargets: number[] = [50, 8, 92];

  for (const s of siblings) {
    if (s.id === candidate.id) continue;
    const sw = s.width ?? 16;
    const sh = s.height ?? 20;
    xTargets.push(s.x, s.x + sw / 2, s.x + sw);
    yTargets.push(s.y, s.y + sh / 2, s.y + sh);
  }

  let bestDx = threshold + 1;
  let snappedX = candidate.x;
  let guideX: number | null = null;

  const xAnchors: [number, number][] = [
    [candidate.x, 0],
    [candidate.x + w / 2, w / 2],
    [candidate.x + w, w],
  ];

  for (const target of xTargets) {
    for (const [anchor, offset] of xAnchors) {
      const dist = Math.abs(anchor - target);
      if (dist <= threshold && dist < bestDx) {
        bestDx = dist;
        snappedX = clampPct(target - offset, maxX);
        guideX = round1(target);
      }
    }
  }

  let bestDy = threshold + 1;
  let snappedY = candidate.y;
  let guideY: number | null = null;

  const yAnchors: [number, number][] = [
    [candidate.y, 0],
    [candidate.y + h / 2, h / 2],
    [candidate.y + h, h],
  ];

  for (const target of yTargets) {
    for (const [anchor, offset] of yAnchors) {
      const dist = Math.abs(anchor - target);
      if (dist <= threshold && dist < bestDy) {
        bestDy = dist;
        snappedY = clampPct(target - offset, maxY);
        guideY = round1(target);
      }
    }
  }

  const guides: SlideSnapGuide[] = [];
  if (guideX !== null) guides.push({ axis: "x", pos: guideX });
  if (guideY !== null) guides.push({ axis: "y", pos: guideY });

  return {
    shape: { ...candidate, x: clampPct(snappedX, maxX), y: clampPct(snappedY, maxY) },
    guides,
  };
}

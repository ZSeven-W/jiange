export type FlowViewport = { x: number; y: number; zoom: number };
export type FlowPoint = { x: number; y: number };

/** Preserve the visible canvas centre when panels or the viewport resize. */
export function resizeViewportCenter(view: FlowViewport, before: { w: number; h: number }, after: { w: number; h: number }): FlowViewport {
  if (!(view.zoom > 0) || before.w <= 0 || before.h <= 0 || after.w <= 0 || after.h <= 0) return view;
  return { ...view, x: view.x + (before.w - after.w) / (2 * view.zoom), y: view.y + (before.h - after.h) / (2 * view.zoom) };
}

/** Keep the initial canvas point under the moving two-finger midpoint. */
export function pinchViewport(initial: FlowViewport, start: FlowPoint, current: FlowPoint, startDistance: number, distance: number): FlowViewport {
  if (!(startDistance > 0) || !(distance > 0) || !Number.isFinite(distance)) return initial;
  const zoom = Math.max(0.2, Math.min(3, initial.zoom * distance / startDistance));
  return { x: initial.x + start.x / initial.zoom - current.x / zoom, y: initial.y + start.y / initial.zoom - current.y / zoom, zoom };
}

/** Fit a newly inserted image within the visible canvas at the current zoom. */
export function fitInsertedImage(image: { w: number; h: number }, viewport: { w: number; h: number }, zoom: number) {
  const width = Math.max(1, image.w), height = Math.max(1, image.h), scale = Math.max(0.2, zoom);
  const maxWidth = Math.max(20, (viewport.w - 48) / scale), maxHeight = Math.max(16, (viewport.h - 48) / scale);
  const factor = Math.min(1, 360 / Math.max(width, height), maxWidth / width, maxHeight / height);
  return { w: Math.max(20, Math.round(width * factor)), h: Math.max(16, Math.round(height * factor)) };
}

/** Keep a desktop selection toolbar inside the canvas and clear of the top controls. */
export function placeSelectionToolbar(anchor: { x: number; y: number; w: number; h: number }, viewport: { w: number; h: number }, toolbar: { w: number; h: number }, obstacles: { x: number; y: number; w: number; h: number }[] = []) {
  const half = Math.min(toolbar.w / 2 + 8, viewport.w / 2);
  const left = Math.min(viewport.w - half, Math.max(half, anchor.x + anchor.w / 2));
  const above = anchor.y - toolbar.h - 12;
  const below = anchor.y + anchor.h + 12;
  const maxTop = Math.max(64, viewport.h - toolbar.h - 64);
  const top = above >= 64 ? Math.min(above, maxTop) : below >= 64 && below <= maxTop ? below : Math.max(64, Math.min(above, maxTop));
  if (!obstacles.length) return { left, top };
  const clampLeft = (x: number) => Math.max(half, Math.min(viewport.w - half, x));
  const clampTop = (y: number) => Math.max(64, Math.min(maxTop, y));
  const candidates = [
    { left, top },
    { left: clampLeft(anchor.x + anchor.w + 12 + toolbar.w / 2), top: clampTop(anchor.y + (anchor.h - toolbar.h) / 2) },
    { left: clampLeft(anchor.x - 12 - toolbar.w / 2), top: clampTop(anchor.y + (anchor.h - toolbar.h) / 2) },
    { left, top: clampTop(above) },
    { left, top: clampTop(below) },
  ];
  const overlap = (candidate: { left: number; top: number }) => obstacles.reduce((total, item) => {
    const x = Math.max(0, Math.min(candidate.left + toolbar.w / 2, item.x + item.w) - Math.max(candidate.left - toolbar.w / 2, item.x));
    const y = Math.max(0, Math.min(candidate.top + toolbar.h, item.y + item.h) - Math.max(candidate.top, item.y));
    return total + x * y;
  }, 0);
  return candidates.reduce((best, candidate) => overlap(candidate) < overlap(best) ? candidate : best);
}

/** Prefer a visible menu position that does not cover nodes or their toolbar. */
export function placeMindMenu(anchor: FlowPoint, viewport: { w: number; h: number }, obstacles: { x: number; y: number; w: number; h: number }[]) {
  const margin = 8, width = Math.max(1, Math.min(192, viewport.w - 2 * margin)), availableHeight = Math.max(1, viewport.h - 2 * margin);
  const clampX = (x: number) => Math.max(margin, Math.min(viewport.w - margin - width, x));
  const left = obstacles.length ? Math.min(...obstacles.map((box) => box.x)) : anchor.x;
  const right = obstacles.length ? Math.max(...obstacles.map((box) => box.x + box.w)) : anchor.x;
  const xs = [...new Set([anchor.x, right + 12, left - width - 12, margin, viewport.w - margin - width].map(clampX))];
  const heights = [...new Set([454, 288, 224].map((height) => Math.min(height, availableHeight)))];
  let best: { left: number; top: number; maxHeight: number; overlap: number; distance: number } | null = null;
  for (const height of heights) {
    const clampY = (y: number) => Math.max(margin, Math.min(viewport.h - margin - height, y));
    const ys = [...new Set([anchor.y, margin, viewport.h - margin - height, ...obstacles.flatMap((box) => [box.y - height - 12, box.y + box.h + 12])].map(clampY))];
    for (const x of xs) for (const y of ys) {
      const overlap = obstacles.reduce((sum, box) => sum + Math.max(0, Math.min(x + width, box.x + box.w) - Math.max(x, box.x)) * Math.max(0, Math.min(y + height, box.y + box.h) - Math.max(y, box.y)), 0);
      const distance = Math.abs(x - anchor.x) + Math.abs(y - anchor.y);
      if (!best || overlap < best.overlap || (overlap === best.overlap && (height > best.maxHeight || (height === best.maxHeight && distance < best.distance)))) best = { left: x, top: y, maxHeight: height, overlap, distance };
    }
  }
  return { left: best!.left, top: best!.top, maxHeight: best!.maxHeight };
}

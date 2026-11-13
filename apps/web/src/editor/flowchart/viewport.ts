export type FlowViewport = { x: number; y: number; zoom: number };
export type FlowPoint = { x: number; y: number };

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
export function placeSelectionToolbar(anchor: { x: number; y: number; w: number; h: number }, viewport: { w: number; h: number }, toolbar: { w: number; h: number }) {
  const half = Math.min(toolbar.w / 2 + 8, viewport.w / 2);
  const left = Math.min(viewport.w - half, Math.max(half, anchor.x + anchor.w / 2));
  const above = anchor.y - toolbar.h - 12;
  const below = anchor.y + anchor.h + 12;
  const maxTop = Math.max(64, viewport.h - toolbar.h - 64);
  const top = above >= 64 ? Math.min(above, maxTop) : below >= 64 && below <= maxTop ? below : Math.max(64, Math.min(above, maxTop));
  return { left, top };
}

export const SLIDE_WIDTH = 960;
export const SLIDE_HEIGHT = 540;
export const MIN_SLIDE_ZOOM = 25;
export const MAX_SLIDE_ZOOM = 200;

export function clampSlideZoom(value: number): number {
  return Math.min(MAX_SLIDE_ZOOM, Math.max(MIN_SLIDE_ZOOM, Math.round(value)));
}

/** Fit the 16:9 slide inside the measured viewport with room around it. */
export function fitSlideZoom(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 100;
  const scale = Math.min((width - 32) / SLIDE_WIDTH, (height - 32) / SLIDE_HEIGHT);
  return Math.max(10, Math.min(150, Math.floor(scale * 100)));
}

export function parseSlideZoom(value: string): number | null {
  const raw = value.trim().replace(/%$/, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampSlideZoom(parsed) : null;
}

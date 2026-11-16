export const IMAGE_ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

export function stepImageZoom(current: number, direction: -1 | 1): number {
  if (direction > 0) return IMAGE_ZOOM_LEVELS.find((value) => value > current + 0.001) ?? IMAGE_ZOOM_LEVELS[IMAGE_ZOOM_LEVELS.length - 1];
  return [...IMAGE_ZOOM_LEVELS].reverse().find((value) => value < current - 0.001) ?? IMAGE_ZOOM_LEVELS[0];
}

/** Fit the image without enlarging it, then apply zoom relative to that fit. */
export function previewImageSize(natural: { width: number; height: number } | null, viewport: { width: number; height: number }, zoom: number, rotation = 0): { width: number; height: number } | undefined {
  if (!natural || ![natural.width, natural.height, viewport.width, viewport.height, zoom].every((value) => Number.isFinite(value) && value > 0)) return undefined;
  const sideways = Math.abs(rotation % 180) === 90;
  const width = sideways ? natural.height : natural.width, height = sideways ? natural.width : natural.height;
  const fit = Math.min(1, viewport.width / width, viewport.height / height);
  return { width: Math.max(1, Math.round(width * fit * zoom)), height: Math.max(1, Math.round(height * fit * zoom)) };
}

export function pinchImageZoom(initial: number, startDistance: number, distance: number): number {
  if (![initial, startDistance, distance].every((value) => Number.isFinite(value) && value > 0)) return initial;
  return Math.max(IMAGE_ZOOM_LEVELS[0], Math.min(IMAGE_ZOOM_LEVELS[IMAGE_ZOOM_LEVELS.length - 1], initial * distance / startDistance));
}

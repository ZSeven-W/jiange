/** Keep the page menu inside small viewports; excess items scroll within it. */
export function slidePageMenuPosition(x: number, y: number, viewportWidth: number, viewportHeight: number) {
  const margin = 8;
  const width = Math.max(1, Math.min(188, viewportWidth - margin * 2));
  const maxHeight = Math.max(1, viewportHeight - margin * 2);
  const height = Math.min(252, maxHeight);
  const top = Math.max(margin, Math.min(y, viewportHeight - height - margin));
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    top,
    width,
    maxHeight: Math.max(1, viewportHeight - top - margin),
  };
}

/** Keep a floating editor inside the visible viewport, even in a scrolled grid. */
export function popupPosition(rect: Pick<DOMRect, "left" | "top" | "bottom">, viewportWidth: number, viewportHeight: number, desiredWidth: number, desiredHeight = 430) {
  const width = Math.max(1, Math.min(desiredWidth, viewportWidth - 32));
  const left = Math.max(0, Math.min(rect.left, viewportWidth - width - 16));
  const below = viewportHeight - rect.bottom - 20;
  const above = rect.top - 20;
  const top = below >= Math.min(desiredHeight, 160) || below >= above
    ? Math.max(0, Math.min(rect.bottom + 4, viewportHeight - 32))
    : Math.max(16, rect.top - Math.min(desiredHeight, above) - 4);
  return { left, top, width, maxHeight: Math.max(1, viewportHeight - top - 16) };
}

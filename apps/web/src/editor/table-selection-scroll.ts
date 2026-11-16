/** Scroll faster as a drag approaches (or crosses) a viewport edge. */
export function tableSelectionScrollSpeed(point: number, start: number, end: number): number {
  if (![point, start, end].every(Number.isFinite) || end <= start) return 0;
  const zone = Math.min(40, (end - start) / 2);
  const distance = point < start + zone ? point - (start + zone) : point > end - zone ? point - (end - zone) : 0;
  return distance ? Math.sign(distance) * Math.min(24, Math.max(1, Math.ceil(Math.abs(distance) / 3))) : 0;
}

/** Find the editor's actual vertical scrollport, rather than scrolling the page behind it. */
export function tableVerticalScrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

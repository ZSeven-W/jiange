export interface GraphPoint { x: number; y: number }
export interface GraphRect { left: number; top: number; width: number; height: number }
export interface GraphSize { width: number; height: number }
export const GRAPH_MIN_ZOOM = 0.25;
export const GRAPH_MAX_ZOOM = 2;

export function clampGraphZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, value)) * 100) / 100;
}
export function stepGraphZoom(value: number, direction: -1 | 1): number {
  const quarter = value * 4;
  return clampGraphZoom((direction > 0 ? Math.floor(quarter + 1e-8) + 1 : Math.ceil(quarter - 1e-8) - 1) / 4);
}
export function fitGraphZoom(graph: GraphSize, viewport: GraphSize): number {
  if (![graph.width, graph.height, viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0)) return 1;
  return clampGraphZoom(Math.min((viewport.width - 32) / graph.width, (viewport.height - 32) / graph.height, GRAPH_MAX_ZOOM));
}
/** Convert screen coordinates into the SVG's unscaled viewBox coordinates. */
export function screenToGraph(point: GraphPoint, rect: GraphRect, graph: GraphSize): GraphPoint | null {
  if (![point.x, point.y, rect.left, rect.top, rect.width, rect.height, graph.width, graph.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || graph.width <= 0 || graph.height <= 0) return null;
  return { x: (point.x - rect.left) * graph.width / rect.width, y: (point.y - rect.top) * graph.height / rect.height };
}
/** Scroll correction to keep a graph point under the same screen position. */
export function graphAnchorScroll(scroll: GraphPoint, rect: GraphRect, graph: GraphSize, world: GraphPoint, screen: GraphPoint): GraphPoint | null {
  if (![scroll.x, scroll.y, rect.left, rect.top, rect.width, rect.height, graph.width, graph.height, world.x, world.y, screen.x, screen.y].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || graph.width <= 0 || graph.height <= 0) return null;
  return { x: scroll.x + rect.left + world.x * rect.width / graph.width - screen.x, y: scroll.y + rect.top + world.y * rect.height / graph.height - screen.y };
}

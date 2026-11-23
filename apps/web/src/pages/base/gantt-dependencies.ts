export interface GanttDependency {
  id: string;
  fromId: number;
  toId: number;
}

export function ganttDepsStorageKey(baseId: number): string {
  return `jiange:base:gantt-deps:${baseId}`;
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Load persisted Gantt dependency edges for a base, filtering corrupt/duplicate entries. */
export function loadGanttDependencies(baseId: number): GanttDependency[] {
  if (!validId(baseId) || typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(ganttDepsStorageKey(baseId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: GanttDependency[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (!validId(rec.fromId) || !validId(rec.toId) || rec.fromId === rec.toId) continue;
      const pairKey = `${rec.fromId}->${rec.toId}`;
      if (seen.has(pairKey)) continue;
      if (wouldCreateGanttCycle(out, rec.fromId, rec.toId)) continue;
      seen.add(pairKey);
      out.push({
        id: typeof rec.id === "string" && rec.id.trim() ? rec.id : `dep-${rec.fromId}-${rec.toId}`,
        fromId: rec.fromId,
        toId: rec.toId,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Persist Gantt dependency edges for a base into localStorage. */
export function saveGanttDependencies(baseId: number, edges: readonly GanttDependency[]): void {
  if (!validId(baseId) || typeof localStorage === "undefined") return;
  try {
    if (edges.length === 0) {
      localStorage.removeItem(ganttDepsStorageKey(baseId));
    } else {
      localStorage.setItem(ganttDepsStorageKey(baseId), JSON.stringify(edges));
    }
  } catch {
    // Ignore storage quota / privacy mode failures.
  }
}

/**
 * Returns true if adding the directed edge `fromId -> toId` would create a cycle
 * (including a direct self-loop `fromId === toId`).
 */
export function wouldCreateGanttCycle(
  edges: readonly Pick<GanttDependency, "fromId" | "toId">[],
  fromId: number,
  toId: number,
): boolean {
  if (fromId === toId) return true;
  const adj = new Map<number, number[]>();
  for (const edge of edges) {
    const list = adj.get(edge.fromId);
    if (list) list.push(edge.toId);
    else adj.set(edge.fromId, [edge.toId]);
  }
  const visited = new Set<number>([toId]);
  const stack: number[] = [toId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const neighbors = adj.get(cur);
    if (!neighbors) continue;
    for (const next of neighbors) {
      if (next === fromId) return true;
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

export type AddGanttDependencyResult =
  | { ok: true; edges: GanttDependency[]; edge: GanttDependency }
  | { ok: false; reason: "invalid" | "self" | "duplicate" | "cycle" };

/** Purely append a new dependency edge if valid, non-duplicate, and acyclic. */
export function addGanttDependency(
  edges: readonly GanttDependency[],
  fromId: number,
  toId: number,
): AddGanttDependencyResult {
  if (!validId(fromId) || !validId(toId)) return { ok: false, reason: "invalid" };
  if (fromId === toId) return { ok: false, reason: "self" };
  if (edges.some((e) => e.fromId === fromId && e.toId === toId)) {
    return { ok: false, reason: "duplicate" };
  }
  if (wouldCreateGanttCycle(edges, fromId, toId)) {
    return { ok: false, reason: "cycle" };
  }
  const edge: GanttDependency = {
    id: `dep-${fromId}-${toId}-${Date.now().toString(36)}`,
    fromId,
    toId,
  };
  return { ok: true, edges: [...edges, edge], edge };
}

/** Purely remove a dependency edge by id. */
export function removeGanttDependency(edges: readonly GanttDependency[], id: string): GanttDependency[] {
  return edges.filter((e) => e.id !== id);
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : "0";
}

/**
 * Compute a clean Feishu-style orthogonal SVG elbow path from a predecessor bar's
 * right edge `(fromX, fromY)` to a successor bar's left edge `(toX, toY)`.
 * The final segment always enters `(toX, toY)` moving horizontally rightward so
 * an `orient="auto"` SVG arrowhead marker points straight into the target bar.
 */
export function computeGanttArrowPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): string {
  const x1 = Number.isFinite(fromX) ? fromX : 0;
  const y1 = Number.isFinite(fromY) ? fromY : 0;
  const x2 = Number.isFinite(toX) ? toX : 0;
  const y2 = Number.isFinite(toY) ? toY : 0;

  const stub = 12;
  const dy = y2 - y1;

  // Same row and forward: simple horizontal connector.
  if (Math.abs(dy) < 0.5 && x2 >= x1 + 4) {
    return `M ${fmt(x1)} ${fmt(y1)} H ${fmt(x2)}`;
  }

  // Forward finish-to-start with enough horizontal room for a clean 3-segment elbow.
  if (x2 >= x1 + stub * 2) {
    const turnX = x1 + Math.min(18, (x2 - x1) / 2);
    return `M ${fmt(x1)} ${fmt(y1)} H ${fmt(turnX)} V ${fmt(y2)} H ${fmt(x2)}`;
  }

  // Overlapping or reversed dates: exit right, route orthogonally along the row gap,
  // wrap around to the left of the target bar, and enter rightward.
  const outX = x1 + stub;
  const inX = x2 - stub;
  const midY = Math.abs(dy) < 0.5 ? y1 + 18 : y1 + dy / 2;
  return `M ${fmt(x1)} ${fmt(y1)} H ${fmt(outX)} V ${fmt(midY)} H ${fmt(inX)} V ${fmt(y2)} H ${fmt(x2)}`;
}

import type { SheetOutlineGroup } from "@/lib/api";

function makeOutlineId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `og-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `og-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Determine the visible summary/header row or column index where the +/- outline
 * collapse toggle button is anchored for a group.
 * - If `start > 0`, the row/col immediately before `start` (`start - 1`) acts as the header/summary.
 * - If `start === 0`, index `0` itself stays visible as the summary/header while `1..end` collapse.
 */
export function getOutlineToggleAnchor(group: SheetOutlineGroup): number {
  return group.start > 0 ? group.start - 1 : 0;
}

/** Return the [firstHidden, lastHidden] inclusive range hidden when `group` is collapsed. */
export function getOutlineCollapsibleSpan(group: SheetOutlineGroup): { from: number; to: number } | null {
  const lo = Math.min(group.start, group.end);
  const hi = Math.max(group.start, group.end);
  if (lo > 0) return { from: lo, to: hi };
  if (hi > 0) return { from: 1, to: hi };
  return null;
}

/** Compute the set of row or column indices currently hidden by collapsed outline groups. */
export function getOutlineHiddenIndices(
  groups: readonly SheetOutlineGroup[] | undefined,
  axis: "row" | "col",
): Set<number> {
  const hidden = new Set<number>();
  if (!groups || groups.length === 0) return hidden;
  for (const g of groups) {
    if (g.axis !== axis || !g.collapsed) continue;
    const span = getOutlineCollapsibleSpan(g);
    if (!span) continue;
    for (let i = span.from; i <= span.to; i++) hidden.add(i);
  }
  return hidden;
}

/** Find all outline groups whose +/- toggle button anchors at `index` on `axis`. */
export function getOutlineGroupsAtAnchor(
  groups: readonly SheetOutlineGroup[] | undefined,
  axis: "row" | "col",
  index: number,
): SheetOutlineGroup[] {
  if (!groups || groups.length === 0) return [];
  return groups.filter((g) => g.axis === axis && getOutlineToggleAnchor(g) === index);
}

/** Check whether `index` is a detail row/col inside any expanded group (for outline bracket styling). */
export function isIndexInExpandedOutlineGroup(
  groups: readonly SheetOutlineGroup[] | undefined,
  axis: "row" | "col",
  index: number,
): boolean {
  if (!groups || groups.length === 0) return false;
  for (const g of groups) {
    if (g.axis !== axis || g.collapsed) continue;
    const span = getOutlineCollapsibleSpan(g);
    if (span && index >= span.from && index <= span.to) return true;
  }
  return false;
}

/** Check whether any outline group on `axis` overlaps the selection range `[start..end]` (or anchors inside it). */
export function hasOutlineGroupInRange(
  groups: readonly SheetOutlineGroup[] | undefined,
  axis: "row" | "col",
  start: number,
  end: number,
): boolean {
  if (!groups || groups.length === 0) return false;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return groups.some((g) => {
    if (g.axis !== axis) return false;
    const gLo = Math.min(g.start, g.end);
    const gHi = Math.max(g.start, g.end);
    const anchor = getOutlineToggleAnchor(g);
    return (gLo <= hi && gHi >= lo) || (anchor >= lo && anchor <= hi);
  });
}

/** Add a new collapsible outline group for `[start..end]` on `axis` (deduplicating identical spans). */
export function addOutlineGroup(
  groups: readonly SheetOutlineGroup[] | undefined,
  axis: "row" | "col",
  start: number,
  end: number,
): SheetOutlineGroup[] {
  const list = [...(groups ?? [])];
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const exists = list.some(
    (g) => g.axis === axis && Math.min(g.start, g.end) === lo && Math.max(g.start, g.end) === hi,
  );
  if (exists) return list;
  list.push({
    id: makeOutlineId(),
    axis,
    start: lo,
    end: hi,
    collapsed: false,
  });
  return list;
}

/** Remove all outline groups on `axis` overlapping `[start..end]` or anchored within `[start..end]`. */
export function removeOutlineGroupsInRange(
  groups: readonly SheetOutlineGroup[] | undefined,
  axis: "row" | "col",
  start: number,
  end: number,
): SheetOutlineGroup[] {
  if (!groups || groups.length === 0) return [];
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return groups.filter((g) => {
    if (g.axis !== axis) return true;
    const gLo = Math.min(g.start, g.end);
    const gHi = Math.max(g.start, g.end);
    const anchor = getOutlineToggleAnchor(g);
    const overlaps = gLo <= hi && gHi >= lo;
    const anchorHit = anchor >= lo && anchor <= hi;
    return !(overlaps || anchorHit);
  });
}

/** Toggle `collapsed` on a specific outline group by ID. */
export function toggleOutlineGroupCollapsed(
  groups: readonly SheetOutlineGroup[] | undefined,
  groupId: string,
): SheetOutlineGroup[] {
  return (groups ?? []).map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g));
}

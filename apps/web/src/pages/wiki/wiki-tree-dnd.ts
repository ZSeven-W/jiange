import type { Role, WikiNodeEntry } from "@/lib/api";

export type WikiDropZone = "before" | "inside" | "after";

export interface WikiDropPlan {
  targetParentId: number | null;
  position: number;
}

/** Return true if candidateId equals ancestorId or descends from ancestorId. */
export function isWikiDescendant(
  byId: ReadonlyMap<number, WikiNodeEntry>,
  candidateId: number | null,
  ancestorId: number,
): boolean {
  const seen = new Set<number>();
  let cur = candidateId;
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

function visibleParent(byId: ReadonlyMap<number, WikiNodeEntry>, node: WikiNodeEntry): number | null {
  return node.parentId && byId.has(node.parentId) ? node.parentId : null;
}

function canEditRole(role: Role | undefined): boolean {
  return role === "edit" || role === "manage";
}

/** Check whether dragged may be dropped onto target at the given zone. */
export function canDropWikiNode(
  byId: ReadonlyMap<number, WikiNodeEntry>,
  dragged: WikiNodeEntry,
  target: WikiNodeEntry,
  zone: WikiDropZone,
  spaceCallerRole: Role | undefined,
): boolean {
  if (dragged.id === target.id) return false;
  const currentParent = visibleParent(byId, dragged);
  const targetParent = zone === "inside" ? target.id : visibleParent(byId, target);
  if (isWikiDescendant(byId, targetParent, dragged.id)) return false;

  const sameParent = currentParent === targetParent;
  if (sameParent) {
    if (!canEditRole(dragged.role)) return false;
  } else {
    if (dragged.role !== "manage") return false;
  }

  if (targetParent !== null) {
    const parentNode = byId.get(targetParent);
    if (!parentNode) return false;
    if (!canEditRole(parentNode.role)) return false;
    if (dragged.kind === "folder" && parentNode.kind !== "folder") return false;
  } else if (!canEditRole(spaceCallerRole)) {
    return false;
  }
  return true;
}

/** Compute the exact API drop targetParentId & position, or null if a no-op/invalid drop. */
export function computeWikiDropPlan(
  childrenMap: ReadonlyMap<number | null, WikiNodeEntry[]>,
  byId: ReadonlyMap<number, WikiNodeEntry>,
  dragged: WikiNodeEntry,
  target: WikiNodeEntry,
  zone: WikiDropZone,
  spaceCallerRole: Role | undefined,
): WikiDropPlan | null {
  if (!canDropWikiNode(byId, dragged, target, zone, spaceCallerRole)) return null;
  const currentParent = visibleParent(byId, dragged);
  if (zone === "inside") {
    const kids = childrenMap.get(target.id) ?? [];
    const filtered = kids.filter((n) => n.id !== dragged.id);
    if (currentParent === target.id && kids[kids.length - 1]?.id === dragged.id) return null;
    return { targetParentId: target.id, position: filtered.length };
  }
  const targetParent = visibleParent(byId, target);
  const siblings = childrenMap.get(targetParent) ?? [];
  const filtered = siblings.filter((n) => n.id !== dragged.id);
  const targetIdxInFiltered = filtered.findIndex((n) => n.id === target.id);
  if (targetIdxInFiltered < 0) return null;
  const nextPosition = zone === "before" ? targetIdxInFiltered : targetIdxInFiltered + 1;
  if (currentParent === targetParent) {
    const oldIdx = siblings.findIndex((n) => n.id === dragged.id);
    if (oldIdx === nextPosition) return null;
  }
  return { targetParentId: targetParent, position: nextPosition };
}

/** Determine vertical drop zone inside a tree row (top 25% before, middle 50% inside, bottom 25% after). */
export function resolveRowDropZone(clientY: number, rect: { top: number; height: number }): WikiDropZone {
  if (rect.height <= 0) return "inside";
  const ratio = (clientY - rect.top) / rect.height;
  if (ratio <= 0.25) return "before";
  if (ratio >= 0.75) return "after";
  return "inside";
}

/** Compute next position for single-step Up (-1) or Down (+1) sibling reorder. */
export function computeStepReorder(siblings: readonly WikiNodeEntry[], nodeId: number, delta: -1 | 1): number | null {
  const idx = siblings.findIndex((n) => n.id === nodeId);
  if (idx < 0) return null;
  const next = idx + delta;
  if (next < 0 || next >= siblings.length) return null;
  return next;
}

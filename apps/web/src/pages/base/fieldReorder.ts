import type { Field } from "@/lib/api";

export type FieldReorderPlan = { kind: "move"; desiredIds: number[] } | { kind: "noop" | "stale" | "invalid" };

/** `slot` is a boundary in the original array, before removing the source. */
export function planFieldReorder(fields: readonly Field[], sourceId: number, slot: number, expectedIds: readonly number[]): FieldReorderPlan {
  if (expectedIds.length !== fields.length || !expectedIds.every((id, index) => fields[index]?.id === id)) return { kind: "stale" };
  const from = fields.findIndex((field) => field.id === sourceId);
  if (from < 0 || !Number.isInteger(slot) || slot < 0 || slot > fields.length || new Set(expectedIds).size !== expectedIds.length) return { kind: "invalid" };
  if (fields[from].isPrimary) return { kind: "invalid" };
  const index = slot - (from < slot ? 1 : 0);
  if (index === from) return { kind: "noop" };
  const rest = expectedIds.filter((id) => id !== sourceId);
  if (!rest.length) return { kind: "noop" };
  rest.splice(index, 0, sourceId);
  const primary = fields.find((field) => field.isPrimary);
  if (primary && rest.indexOf(primary.id) !== expectedIds.indexOf(primary.id)) return { kind: "invalid" };
  return { kind: "move", desiredIds: rest };
}

/** Reorder visible slots without changing hidden fields' slots or relative order. */
export function mergeVisibleFieldOrder(allIds: readonly number[], visibleIds: readonly number[], desiredVisibleIds: readonly number[]): number[] | null {
  const all = new Set(allIds), visible = new Set(visibleIds), desired = new Set(desiredVisibleIds);
  if (all.size !== allIds.length || visible.size !== visibleIds.length || desired.size !== desiredVisibleIds.length || visible.size !== desired.size) return null;
  if (visibleIds.some((id) => !all.has(id) || !desired.has(id))) return null;
  if (allIds.filter((id) => visible.has(id)).some((id, index) => id !== visibleIds[index])) return null;
  let index = 0;
  return allIds.map((id) => visible.has(id) ? desiredVisibleIds[index++] : id);
}

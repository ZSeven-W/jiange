import type { BaseRecord } from "@/lib/api";

/** Right-clicking a checked row targets the checked rows; another row targets only itself. */
export function recordMenuTargets(id: number, checked: ReadonlySet<number>, visible: readonly BaseRecord[]): number[] {
  if (!visible.some((record) => record.id === id)) return [];
  return checked.has(id) ? visible.filter((record) => checked.has(record.id)).map((record) => record.id) : [id];
}

export function sameRecordTargets(expected: readonly number[], actual: readonly number[]): boolean {
  const ids = new Set(expected);
  return ids.size > 0 && ids.size === expected.length && actual.length === expected.length && new Set(actual).size === actual.length && actual.every((id) => ids.has(id));
}

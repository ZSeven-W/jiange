export type TableTabIntent = { kind: "focus"; index: number; caret: "start" | "end" } | { kind: "append" | "stay" };

/** Navigate visible cells in DOM order, skipping cells hidden by merges. */
export function tableTabIntent(index: number, count: number, backwards: boolean): TableTabIntent {
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count) return { kind: "stay" };
  const next = index + (backwards ? -1 : 1);
  if (next < 0) return { kind: "stay" };
  if (next >= count) return { kind: "append" };
  return { kind: "focus", index: next, caret: backwards ? "end" : "start" };
}

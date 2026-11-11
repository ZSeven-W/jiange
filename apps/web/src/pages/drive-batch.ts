/** 云盘批量操作：逐项执行，按项记录成功与失败，失败项保留选中以便重试。 */
export interface BatchResult { done: number[]; failed: number[] }

export async function runDriveBatch<T extends { id: number }>(items: readonly T[], op: (item: T) => Promise<unknown>): Promise<BatchResult> {
  const result: BatchResult = { done: [], failed: [] };
  // Sequential on purpose: each write is guarded by its own revision check and
  // the server serializes moves within a tree; parallel requests would only
  // race each other's fences.
  for (const item of items) {
    try { await op(item); result.done.push(item.id); } catch { result.failed.push(item.id); }
  }
  return result;
}

export function batchMessage(verb: string, result: BatchResult): { notice: string; error: string } {
  if (!result.failed.length) return { notice: `已${verb} ${result.done.length} 项。`, error: "" };
  return { notice: "", error: `${result.done.length ? `已${verb} ${result.done.length} 项，` : ""}${result.failed.length} 项未完成（可能已被他人修改或没有权限），已保留选中，请刷新后重试。` };
}

export function toggleId(selected: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** 列表刷新后只保留仍然可见的选中项。 */
export function pruneSelection(selected: ReadonlySet<number>, visibleIds: readonly number[]): Set<number> {
  const visible = new Set(visibleIds);
  const next = new Set([...selected].filter((id) => visible.has(id)));
  return next.size === selected.size ? (selected as Set<number>) : next;
}

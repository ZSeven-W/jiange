import type { FlowGraph } from "./model";

export type FlowHistory = { before: FlowGraph; after: FlowGraph };

/**
 * Record only properties actually written, using the post-write graph as the
 * context. Remote changes and conflicted or already-satisfied intents must not
 * become part of a later undo/redo operation.
 */
export function appliedFlowHistory(before: FlowGraph, after: FlowGraph, keys: readonly string[]): FlowHistory | null {
  const selected = new Set(keys.filter((key) => key === "fc.theme" || key.startsWith("fc.n.") || key.startsWith("fc.e.") || key.startsWith("fc.s.") || key.startsWith("fc.m.") || key.startsWith("fc.mc.") || key.startsWith("fc.ms.")));
  if (!selected.size) return null;
  const restore = <T extends { id: string }>(current: T[], original: T[], prefix: string): T[] => {
    const old = new Map(original.map((item) => [item.id, item]));
    const result = current.flatMap((item) => selected.has(prefix + item.id) ? (old.has(item.id) ? [old.get(item.id)!] : []) : [item]);
    const present = new Set(result.map((item) => item.id));
    for (const item of original) if (selected.has(prefix + item.id) && !present.has(item.id)) result.push(item);
    return result;
  };
  const collapsed = new Set(after.mindCollapsed ?? []), oldCollapsed = new Set(before.mindCollapsed ?? []);
  const styles = { ...after.mindStyles };
  for (const key of selected) {
    const id = key.startsWith("fc.mc.") ? key.slice(6) : key.startsWith("fc.m.") ? key.slice(5) : null;
    if (id !== null) { if (oldCollapsed.has(id)) collapsed.add(id); else collapsed.delete(id); }
    const styleId = key.startsWith("fc.ms.") ? key.slice(6) : key.startsWith("fc.m.") ? key.slice(5) : null;
    if (styleId !== null) { if (before.mindStyles?.[styleId]) styles[styleId] = before.mindStyles[styleId]; else delete styles[styleId]; }
  }
  return {
    before: { nodes: restore(after.nodes, before.nodes, "fc.n."), edges: restore(after.edges, before.edges, "fc.e."), ...(after.strokes || before.strokes ? { strokes: restore(after.strokes ?? [], before.strokes ?? [], "fc.s.") } : {}), ...(after.mind || before.mind ? { mind: restore(after.mind ?? [], before.mind ?? [], "fc.m.") } : {}), ...(after.mindCollapsed || before.mindCollapsed ? { mindCollapsed: [...collapsed].sort() } : {}), ...(after.mindStyles || before.mindStyles ? { mindStyles: styles } : {}), theme: selected.has("fc.theme") ? before.theme : after.theme },
    after,
  };
}

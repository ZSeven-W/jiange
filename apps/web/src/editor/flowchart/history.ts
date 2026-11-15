import type { FlowGraph } from "./model";
import { mindDescriptionAt } from "./mindmap";

export type FlowHistory = { before: FlowGraph; after: FlowGraph };

/**
 * Record only properties actually written, using the post-write graph as the
 * context. Remote changes and conflicted or already-satisfied intents must not
 * become part of a later undo/redo operation.
 */
export function appliedFlowHistory(before: FlowGraph, after: FlowGraph, keys: readonly string[]): FlowHistory | null {
  const selected = new Set(keys.filter((key) => key === "fc.theme" || key.startsWith("fc.n.") || key.startsWith("fc.e.") || key.startsWith("fc.s.") || key.startsWith("fc.m.") || key.startsWith("fc.mc.") || key.startsWith("fc.ms.") || key.startsWith("fc.mp.") || key.startsWith("fc.mt.") || key.startsWith("fc.md.")));
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
  const paints = { ...after.mindPaints };
  const textFormats = { ...after.mindTextFormats };
  let descriptions = { ...after.mindDescriptions };
  for (const key of selected) {
    const id = key.startsWith("fc.mc.") ? key.slice(6) : key.startsWith("fc.m.") ? key.slice(5) : null;
    if (id !== null) { if (oldCollapsed.has(id)) collapsed.add(id); else collapsed.delete(id); }
    const styleId = key.startsWith("fc.ms.") ? key.slice(6) : key.startsWith("fc.m.") ? key.slice(5) : null;
    if (styleId !== null) { if (before.mindStyles?.[styleId]) styles[styleId] = before.mindStyles[styleId]; else delete styles[styleId]; }
    const paintId = key.startsWith("fc.mp.") ? key.slice(6) : key.startsWith("fc.m.") ? key.slice(5) : null;
    if (paintId !== null) { if (before.mindPaints?.[paintId]) paints[paintId] = before.mindPaints[paintId]; else delete paints[paintId]; }
    const textId = key.startsWith("fc.mt.") ? key.slice(6) : key.startsWith("fc.m.") ? key.slice(5) : null;
    if (textId !== null) { if (before.mindTextFormats?.[textId]) textFormats[textId] = before.mindTextFormats[textId]; else delete textFormats[textId]; }
    const descriptionId = key.startsWith("fc.md.") ? key.slice(6) : key.startsWith("fc.m.") ? key.slice(5) : null;
    if (descriptionId !== null) { const value = mindDescriptionAt(before.mindDescriptions, descriptionId); if (value) descriptions = { ...descriptions, [descriptionId]: value }; else delete descriptions[descriptionId]; }
  }
  return {
    before: { nodes: restore(after.nodes, before.nodes, "fc.n."), edges: restore(after.edges, before.edges, "fc.e."), ...(after.strokes || before.strokes ? { strokes: restore(after.strokes ?? [], before.strokes ?? [], "fc.s.") } : {}), ...(after.mind || before.mind ? { mind: restore(after.mind ?? [], before.mind ?? [], "fc.m.") } : {}), ...(after.mindCollapsed || before.mindCollapsed ? { mindCollapsed: [...collapsed].sort() } : {}), ...(after.mindStyles || before.mindStyles ? { mindStyles: styles } : {}), ...(after.mindPaints || before.mindPaints ? { mindPaints: paints } : {}), ...(after.mindTextFormats || before.mindTextFormats ? { mindTextFormats: textFormats } : {}), ...(after.mindDescriptions || before.mindDescriptions ? { mindDescriptions: descriptions } : {}), theme: selected.has("fc.theme") ? before.theme : after.theme },
    after,
  };
}

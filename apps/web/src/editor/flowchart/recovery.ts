import { SHAPES, themeOf, type FlowEdge, type FlowGraph, type FlowNode } from "./model";

export type UnappliedFlow = { before: FlowGraph; proposed: FlowGraph; conflicts: string[] };

/** Human-readable text for copying, while the complete graph remains available as a backup. */
export function describeUnappliedFlows(attempts: UnappliedFlow[]): string {
  return attempts.map((attempt, index) => {
    const ids = new Set(attempt.conflicts);
    if (ids.has("document") || ids.has("permission")) {
      const changed = <T extends { id: string }>(before: T[], after: T[], prefix: string) => {
        const old = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
        const next = new Map(after.map((item) => [item.id, JSON.stringify(item)]));
        for (const id of new Set([...old.keys(), ...next.keys()])) if (old.get(id) !== next.get(id)) ids.add(`${prefix}${id}`);
      };
      changed(attempt.before.nodes, attempt.proposed.nodes, "fc.n.");
      changed(attempt.before.edges, attempt.proposed.edges, "fc.e.");
      changed(attempt.before.strokes ?? [], attempt.proposed.strokes ?? [], "fc.s.");
      changed(attempt.before.mind ?? [], attempt.proposed.mind ?? [], "fc.m.");
      for (const id of new Set([...Object.keys(attempt.before.mindStyles ?? {}), ...Object.keys(attempt.proposed.mindStyles ?? {})])) if (JSON.stringify(attempt.before.mindStyles?.[id]) !== JSON.stringify(attempt.proposed.mindStyles?.[id])) ids.add(`fc.ms.${id}`);
      for (const id of new Set([...Object.keys(attempt.before.mindPaints ?? {}), ...Object.keys(attempt.proposed.mindPaints ?? {})])) if (JSON.stringify(attempt.before.mindPaints?.[id]) !== JSON.stringify(attempt.proposed.mindPaints?.[id])) ids.add(`fc.mp.${id}`);
      const oldFolded = new Set(attempt.before.mindCollapsed ?? []), newFolded = new Set(attempt.proposed.mindCollapsed ?? []);
      for (const id of new Set([...oldFolded, ...newFolded])) if (oldFolded.has(id) !== newFolded.has(id)) ids.add(`fc.mc.${id}`);
      if (attempt.before.theme !== attempt.proposed.theme) ids.add("fc.theme");
    }
    const lines = [`第 ${index + 1} 次未应用的操作`];
    for (const key of ids) {
      if (key.startsWith("fc.n.")) {
        const id = key.slice(5), previous = attempt.before.nodes.find((n) => n.id === id), next = attempt.proposed.nodes.find((n) => n.id === id), node: FlowNode | undefined = next ?? previous;
        if (!node) continue;
        const label = SHAPES.find((shape) => shape.id === node.shape)?.label ?? "图形";
        lines.push(`${next ? previous ? "修改" : "新增或恢复" : "删除"}${label}${node.text ? `：${node.text}` : ""}`);
        if (next) lines.push(`位置 ${Math.round(node.x)}, ${Math.round(node.y)}；尺寸 ${Math.round(node.w)} × ${Math.round(node.h)}`);
      } else if (key.startsWith("fc.e.")) {
        const id = key.slice(5), previous = attempt.before.edges.find((e) => e.id === id), next = attempt.proposed.edges.find((e) => e.id === id), edge: FlowEdge | undefined = next ?? previous;
        if (edge) lines.push(`${next ? previous ? "修改" : "新增或恢复" : "删除"}连线${edge.label ? `：${edge.label}` : ""}`);
      } else if (key.startsWith("fc.s.")) {
        const id = key.slice(5), previous = attempt.before.strokes?.find((stroke) => stroke.id === id), next = attempt.proposed.strokes?.find((stroke) => stroke.id === id);
        if (previous || next) lines.push(`${next ? previous ? "修改" : "新增或恢复" : "删除"}笔迹（${(next ?? previous)!.points.length} 个点）`);
      } else if (key.startsWith("fc.mp.")) {
        const id = key.slice(6), topic = attempt.proposed.mind?.find((item) => item.id === id) ?? attempt.before.mind?.find((item) => item.id === id);
        if (topic) lines.push(`修改思维导图节点配色：${topic.text || "（空）"} ${JSON.stringify(attempt.proposed.mindPaints?.[id] ?? {})}`);
      } else if (key.startsWith("fc.ms.")) {
        const id = key.slice(6), topic = attempt.proposed.mind?.find((item) => item.id === id) ?? attempt.before.mind?.find((item) => item.id === id);
        if (topic) lines.push(`修改思维导图节点样式：${topic.text || "（空）"} ${JSON.stringify(attempt.proposed.mindStyles?.[id] ?? {})}`);
      } else if (key.startsWith("fc.mc.")) {
        const id = key.slice(6), topic = attempt.proposed.mind?.find((item) => item.id === id) ?? attempt.before.mind?.find((item) => item.id === id);
        if (topic) lines.push(`${attempt.proposed.mindCollapsed?.includes(id) ? "折叠" : "展开"}思维导图节点：${topic.text || "（空）"}`);
      } else if (key.startsWith("fc.m.")) {
        const id = key.slice(5), previous = attempt.before.mind?.find((topic) => topic.id === id), next = attempt.proposed.mind?.find((topic) => topic.id === id);
        if (previous || next) lines.push(`${next ? previous ? "修改" : "新增或恢复" : "删除"}思维导图节点：${(next ?? previous)!.text || "（空）"}`);
      } else if (key === "fc.theme") lines.push(`切换风格：${themeOf(attempt.proposed.theme).label}`);
    }
    if (lines.length === 1) lines.push("文档状态或权限发生变化，操作未应用。");
    return lines.join("\n");
  }).join("\n\n");
}

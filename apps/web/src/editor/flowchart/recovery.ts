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
      } else if (key === "fc.theme") lines.push(`切换风格：${themeOf(attempt.proposed.theme).label}`);
    }
    if (lines.length === 1) lines.push("文档状态或权限发生变化，操作未应用。");
    return lines.join("\n");
  }).join("\n\n");
}

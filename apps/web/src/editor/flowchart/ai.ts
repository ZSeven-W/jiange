import type { AIMessage } from "@/lib/ai";
import { autoLayout, measureLabel, normalizeEdge, normalizeNode, SHAPES, type FlowGraph, type FlowNode, type Shape } from "./model";

/** AI 生成流程图：要求模型输出节点/连线 JSON，严格校验后自动排版。 */
export function flowchartPrompt(request: string, context = ""): AIMessage[] {
  const shapes = SHAPES.filter((s) => s.id !== "text").map((s) => `${s.id}（${s.label}）`).join("、");
  return [
    { role: "system", content: `你把用户的描述转换为流程图 JSON，只输出 JSON，不要解释。格式：{"direction":"TB"|"LR","nodes":[{"id":"n1","text":"开始","shape":"terminator"}],"edges":[{"from":"n1","to":"n2","label":"可选"}]}。shape 只能是：${shapes}。开始/结束用 terminator，判断用 diamond 并在出边写「是/否」等标签，输入输出用 parallelogram，存储用 cylinder。节点文字简洁（不超过 20 字），节点不超过 40 个。id 只用字母数字。` },
    { role: "user", content: `${request.slice(0, 1000)}${context ? `\n\n参考内容：\n${context.slice(0, 6000)}` : ""}` },
  ];
}

export function parseFlowchartAnswer(answer: string): { graph: FlowGraph; dropped: number } | null {
  const start = answer.indexOf("{"), end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try { raw = JSON.parse(answer.slice(start, end + 1)); } catch { return null; }
  const r = raw as { direction?: unknown; nodes?: unknown; edges?: unknown };
  if (!Array.isArray(r.nodes)) return null;
  let dropped = 0;
  const shapeSize = new Map(SHAPES.map((s) => [s.id, s]));
  const nodes: FlowNode[] = [];
  for (const item of r.nodes.slice(0, 60)) {
    const it = item as { id?: unknown; text?: unknown; shape?: unknown };
    const shape = (shapeSize.has(it.shape as Shape) ? it.shape : "rect") as Shape;
    const size = shapeSize.get(shape)!;
    const text = typeof it.text === "string" ? it.text : "";
    const n = normalizeNode({ id: String(it.id ?? ""), shape, text, w: measureLabel(text, size.w), h: size.h, x: 0, y: 0 });
    if (n && !nodes.some((x) => x.id === n.id)) nodes.push(n); else dropped++;
  }
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(r.edges) ? r.edges : []).slice(0, 120).flatMap((item, i) => {
    const e = normalizeEdge({ ...(item as object), id: `e${i}`, kind: "orthogonal" });
    if (!e || !ids.has(e.from) || !ids.has(e.to)) { dropped++; return []; }
    return [e];
  });
  const graph = autoLayout({ theme: "classic", nodes, edges }, { direction: r.direction === "LR" ? "LR" : "TB" });
  return { graph, dropped };
}

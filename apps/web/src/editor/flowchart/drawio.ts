import { children, parseXml, type XmlElement } from "@/lib/xml";
import { inflateRaw } from "@/lib/zip";
import { normalizeEdge, normalizeNode, type EdgeKind, type FlowEdge, type FlowGraph, type FlowNode, type Shape } from "./model";

/**
 * draw.io / diagrams.net 导入：支持 .drawio/.xml（mxfile，含压缩与未压缩的 diagram）
 * 和裸 mxGraphModel。只取第一页；分组内节点按父容器偏移换算为绝对坐标。
 */
export class DrawioError extends Error {}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_NODES = 500, MAX_EDGES = 1000;

export interface DrawioResult { graph: FlowGraph; warnings: string[] }

function styleMap(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (style ?? "").split(";")) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 0) out[part.trim()] = "1";
    else out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function shapeOf(s: Record<string, string>): Shape {
  const shape = s.shape ?? "";
  if ("text" in s || shape === "text") return "text";
  if ("rhombus" in s || shape === "rhombus") return "diamond";
  if ("ellipse" in s || shape === "ellipse") return "ellipse";
  if (shape === "parallelogram") return "parallelogram";
  if (shape === "document") return "document";
  if (shape.startsWith("cylinder") || shape === "datastore") return "cylinder";
  if (shape === "hexagon") return "hexagon";
  if (shape === "terminator" || shape === "mxgraph.flowchart.terminator") return "terminator";
  if (shape.startsWith("mxgraph.flowchart.decision")) return "diamond";
  if (shape.startsWith("mxgraph.flowchart.start")) return "terminator";
  if (shape.startsWith("mxgraph.flowchart.data")) return "parallelogram";
  if (shape.startsWith("mxgraph.flowchart.database")) return "cylinder";
  if (shape.startsWith("mxgraph.flowchart.document")) return "document";
  if (s.rounded === "1") return Number(s.arcSize ?? 0) >= 40 ? "terminator" : "round";
  return "rect";
}

const color = (v: string | undefined) => (v && /^#[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : undefined);

/** draw.io labels are often HTML: keep line breaks, drop tags, decode common entities. */
export function labelText(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/<br\s*\/?>/gi, "\n").replace(/<(div|p|li)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim().slice(0, 500);
}

async function decompress(text: string): Promise<string> {
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(text.replace(/\s+/g, "")), (c) => c.charCodeAt(0)); } catch { throw new DrawioError("draw.io 页面数据无法解码"); }
  let inflated: Uint8Array;
  try { inflated = await inflateRaw(bytes, MAX_BYTES * 4); } catch { throw new DrawioError("draw.io 页面数据解压失败"); }
  const decoded = new TextDecoder().decode(inflated);
  try { return decodeURIComponent(decoded); } catch { return decoded; }
}

async function graphModel(xml: string): Promise<{ model: XmlElement; pages: number }> {
  let doc: XmlElement;
  try { doc = parseXml(xml); } catch { throw new DrawioError("文件不是有效的 draw.io XML"); }
  const top = doc;
  if (top.name === "mxGraphModel") return { model: top, pages: 1 };
  if (top.name !== "mxfile") throw new DrawioError("不是 draw.io 文件（缺少 mxfile / mxGraphModel）");
  const diagrams = children(top, "diagram");
  if (!diagrams.length) throw new DrawioError("draw.io 文件中没有页面");
  const first = diagrams[0];
  const inner = children(first, "mxGraphModel")[0];
  if (inner) return { model: inner, pages: diagrams.length };
  const raw = first.children.filter((c): c is string => typeof c === "string").join("").trim();
  if (!raw) throw new DrawioError("draw.io 第一页为空");
  const xmlText = await decompress(raw);
  let model: XmlElement | undefined;
  try { const parsed = parseXml(xmlText); model = parsed.name === "mxGraphModel" ? parsed : children(parsed, "mxGraphModel")[0]; } catch { throw new DrawioError("draw.io 页面内容损坏"); }
  if (!model) throw new DrawioError("draw.io 页面内容损坏");
  return { model, pages: diagrams.length };
}

export async function parseDrawio(source: string): Promise<DrawioResult> {
  if (new TextEncoder().encode(source).length > MAX_BYTES) throw new DrawioError("draw.io 文件不能超过 5 MB");
  const { model, pages } = await graphModel(source);
  const warnings: string[] = [];
  if (pages > 1) warnings.push(`文件有 ${pages} 页，只导入了第一页`);
  const root = children(model, "root")[0];
  const cells = children(root, "mxCell").concat(children(root, "object").concat(children(root, "UserObject")).map((o) => {
    // <object label=".." id=".."><mxCell .../></object> wraps a cell with custom data.
    const inner = children(o, "mxCell")[0];
    return inner ? { ...inner, attrs: { ...inner.attrs, id: o.attrs.id ?? inner.attrs.id ?? "", value: o.attrs.label ?? inner.attrs.value ?? "" } } : o;
  }));
  const byId = new Map(cells.map((c) => [c.attrs.id ?? "", c]));
  const geo = (c: XmlElement) => children(c, "mxGeometry")[0]?.attrs ?? {};
  const offset = (c: XmlElement, depth = 0): { x: number; y: number } => {
    const parent = byId.get(c.attrs.parent ?? "");
    if (!parent || depth > 20 || parent.attrs.vertex !== "1") return { x: 0, y: 0 };
    const p = offset(parent, depth + 1), g = geo(parent);
    return { x: p.x + Number(g.x ?? 0), y: p.y + Number(g.y ?? 0) };
  };
  const idMap = new Map<string, string>();
  let seq = 0;
  const localId = (raw: string, prefix: "n" | "e") => { if (!idMap.has(raw)) idMap.set(raw, `${prefix}d${(seq++).toString(36)}`); return idMap.get(raw)!; };
  const nodes: FlowNode[] = [];
  const edgeLabels = new Map<string, string>();
  let skipped = 0;
  for (const c of cells) {
    if (c.attrs.vertex !== "1") continue;
    const s = styleMap(c.attrs.style);
    const parent = byId.get(c.attrs.parent ?? "");
    if (parent?.attrs.edge === "1") { const t = labelText(c.attrs.value); if (t) edgeLabels.set(parent.attrs.id ?? "", t); continue; }
    if ("edgeLabel" in s) continue;
    if (s.shape === "image" || "image" in s) { skipped++; continue; }
    if (nodes.length >= MAX_NODES) { skipped++; continue; }
    const g = geo(c), o = offset(c);
    const node = normalizeNode({
      shape: shapeOf(s), text: labelText(c.attrs.value),
      x: Math.round(o.x + Number(g.x ?? 0)), y: Math.round(o.y + Number(g.y ?? 0)),
      w: Math.round(Number(g.width ?? 120)), h: Math.round(Number(g.height ?? 60)),
      fill: color(s.fillColor), stroke: color(s.strokeColor), color: color(s.fontColor),
    }, localId(c.attrs.id ?? String(seq), "n"));
    if (node) nodes.push(node); else skipped++;
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: FlowEdge[] = [];
  let dangling = 0;
  for (const c of cells) {
    if (c.attrs.edge !== "1") continue;
    const from = idMap.get(c.attrs.source ?? ""), to = idMap.get(c.attrs.target ?? "");
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) { dangling++; continue; }
    if (edges.length >= MAX_EDGES) { skipped++; continue; }
    const s = styleMap(c.attrs.style);
    const kind: EdgeKind = s.curved === "1" ? "curve" : s.edgeStyle && s.edgeStyle !== "none" ? "orthogonal" : "straight";
    const edge = normalizeEdge({
      from, to, kind, label: labelText(c.attrs.value) || edgeLabels.get(c.attrs.id ?? "") || undefined,
      dashed: s.dashed === "1", color: color(s.strokeColor),
      arrow: s.endArrow === "none" && (!s.startArrow || s.startArrow === "none") ? "none" : s.startArrow && s.startArrow !== "none" ? "both" : undefined,
    }, localId(c.attrs.id ?? String(seq), "e"));
    if (edge) edges.push(edge);
  }
  if (!nodes.length) throw new DrawioError("draw.io 文件中没有可导入的图形");
  if (dangling) warnings.push(`${dangling} 条未连接两端图形的连线已忽略`);
  if (skipped) warnings.push(`${skipped} 个图片或超出上限的对象已忽略`);
  // Normalize to a positive origin.
  const minX = Math.min(...nodes.map((n) => n.x)), minY = Math.min(...nodes.map((n) => n.y));
  return { graph: { theme: "classic", nodes: nodes.map((n) => ({ ...n, x: n.x - minX + 40, y: n.y - minY + 40 })), edges }, warnings };
}

/** Export back to an uncompressed draw.io file (opens in diagrams.net). */
export function toDrawio(graph: FlowGraph): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
  const styleFor = (n: FlowNode) => {
    const base: Record<Shape, string> = { rect: "rounded=0;", round: "rounded=1;", terminator: "rounded=1;arcSize=50;", diamond: "rhombus;", parallelogram: "shape=parallelogram;perimeter=parallelogramPerimeter;", ellipse: "ellipse;", document: "shape=document;", cylinder: "shape=cylinder3;", hexagon: "shape=hexagon;perimeter=hexagonPerimeter2;", text: "text;" };
    return `${base[n.shape]}whiteSpace=wrap;html=0;${n.fill ? `fillColor=${n.fill};` : ""}${n.stroke ? `strokeColor=${n.stroke};` : ""}${n.color ? `fontColor=${n.color};` : ""}`;
  };
  const cells = [
    `<mxCell id="0"/>`, `<mxCell id="1" parent="0"/>`,
    ...graph.nodes.map((n) => `<mxCell id="${n.id}" value="${esc(n.text)}" style="${styleFor(n)}" vertex="1" parent="1"><mxGeometry x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" as="geometry"/></mxCell>`),
    ...graph.edges.map((e) => `<mxCell id="${e.id}" value="${esc(e.label ?? "")}" style="${e.kind === "straight" ? "" : e.kind === "curve" ? "curved=1;" : "edgeStyle=orthogonalEdgeStyle;"}${e.dashed ? "dashed=1;" : ""}${e.arrow === "none" ? "endArrow=none;" : e.arrow === "both" ? "startArrow=classic;" : ""}${e.color ? `strokeColor=${e.color};` : ""}html=0;" edge="1" parent="1" source="${e.from}" target="${e.to}"><mxGeometry relative="1" as="geometry"/></mxCell>`),
  ];
  return `<mxfile host="jiange"><diagram name="第 1 页" id="jiange"><mxGraphModel><root>${cells.join("")}</root></mxGraphModel></diagram></mxfile>`;
}

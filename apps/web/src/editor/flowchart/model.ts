/**
 * 可编辑流程图（文档中的 flowchart 块）。
 *
 * 存储：每个节点/连线是块上的一个独立属性（与表格单元格同理，协同模型逐键后写胜出），
 * 不同协作者同时编辑不同对象不会互相覆盖；删除写空串（墓碑）。
 *   fc.v = "1"   fc.theme = 主题   fc.h = 文档中的显示高度
 *   fc.n.<id> = 节点 JSON          fc.e.<id> = 连线 JSON
 */

export type Shape = "rect" | "round" | "diamond" | "ellipse" | "terminator" | "parallelogram" | "document" | "cylinder" | "hexagon" | "text"
  | "triangle" | "note" | "swimlane" | "swimlaneV" | "class" | "actor" | "lifeline" | "image";
export type TextAlign = "left" | "center" | "right";
export type Port = "top" | "right" | "bottom" | "left";
export type EdgeKind = "orthogonal" | "straight" | "curve";

export interface FlowNode { id: string; x: number; y: number; w: number; h: number; shape: Shape; text: string; fill?: string; stroke?: string; color?: string; size?: number; align?: TextAlign; rot?: number; fileId?: number; z?: number }
export interface FlowEdge { id: string; from: string; to: string; fromPort?: Port; toPort?: Port; label?: string; kind?: EdgeKind; dashed?: boolean; color?: string; arrow?: "end" | "both" | "none"; mid?: number }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[]; theme: string }

export const FC_VERSION = "fc.v";
export const FC_THEME = "fc.theme";
export const FC_HEIGHT = "fc.h";
const nodeKey = (id: string) => `fc.n.${id}`;
const edgeKey = (id: string) => `fc.e.${id}`;

export const SHAPES: { id: Shape; label: string; w: number; h: number }[] = [
  { id: "rect", label: "矩形（处理）", w: 140, h: 60 },
  { id: "round", label: "圆角矩形", w: 140, h: 60 },
  { id: "terminator", label: "开始/结束", w: 140, h: 52 },
  { id: "diamond", label: "判断", w: 140, h: 90 },
  { id: "parallelogram", label: "输入/输出", w: 150, h: 60 },
  { id: "ellipse", label: "椭圆", w: 120, h: 70 },
  { id: "document", label: "文档", w: 140, h: 70 },
  { id: "cylinder", label: "数据库", w: 110, h: 80 },
  { id: "hexagon", label: "准备", w: 150, h: 64 },
  { id: "text", label: "文本", w: 120, h: 36 },
  { id: "triangle", label: "三角形", w: 100, h: 86 },
  { id: "note", label: "便签", w: 140, h: 90 },
  { id: "swimlane", label: "横向泳道", w: 640, h: 160 },
  { id: "swimlaneV", label: "纵向泳道", w: 220, h: 480 },
  { id: "class", label: "类", w: 180, h: 120 },
  { id: "actor", label: "参与者", w: 60, h: 96 },
  { id: "lifeline", label: "生命线", w: 120, h: 320 },
  { id: "image", label: "图片", w: 240, h: 160 },
];

/** 容器类图形（泳道）：总在底层，拖动时带着内部图形一起移动。 */
export const isContainer = (shape: Shape) => shape === "swimlane" || shape === "swimlaneV";

/** 文字区域：泳道写在标题栏，类图第一行写在类名栏，参与者写在图形下方。 */
export function textArea(n: FlowNode): { x: number; y: number; w: number; h: number; vertical?: boolean } {
  switch (n.shape) {
    case "swimlane": return { x: n.x, y: n.y, w: 32, h: n.h, vertical: true };
    case "swimlaneV": return { x: n.x, y: n.y, w: n.w, h: 36 };
    case "class": return { x: n.x, y: n.y, w: n.w, h: 32 };
    case "actor": return { x: n.x - 30, y: n.y + n.h - 20, w: n.w + 60, h: 20 };
    case "lifeline": return { x: n.x, y: n.y, w: n.w, h: 44 };
    default: return { x: n.x, y: n.y, w: n.w, h: n.h };
  }
}

export interface FlowTheme { id: string; label: string; fill: string; stroke: string; text: string; edge: string; canvas: string; font: string; radius: number; strokeWidth: number; sketch?: boolean; palette?: string[]; shadow?: boolean }

/** 多种风格：节点未单独设置颜色时使用主题配色。 */
export const THEMES: FlowTheme[] = [
  // 飞书画板默认图形（2026-11-12 实测）：浅蓝填充、深色 2px 描边、8px 圆角。
  { id: "feishu", label: "飞书默认", fill: "#EEF3FE", stroke: "#1F2329", text: "#1F2329", edge: "#1F2329", canvas: "#FFFFFF", font: "PingFang SC, Microsoft YaHei, sans-serif", radius: 8, strokeWidth: 2 },
  { id: "classic", label: "经典蓝", fill: "#E1EAFF", stroke: "#3370FF", text: "#1F2329", edge: "#646A73", canvas: "#FFFFFF", font: "PingFang SC, Microsoft YaHei, sans-serif", radius: 8, strokeWidth: 1.5 },
  { id: "minimal", label: "简约黑白", fill: "#FFFFFF", stroke: "#1F2329", text: "#1F2329", edge: "#1F2329", canvas: "#FFFFFF", font: "PingFang SC, Microsoft YaHei, sans-serif", radius: 2, strokeWidth: 1.5 },
  { id: "colorful", label: "多彩", fill: "#FFF1E8", stroke: "#FF8800", text: "#1F2329", edge: "#8F959E", canvas: "#FFFFFF", font: "PingFang SC, Microsoft YaHei, sans-serif", radius: 10, strokeWidth: 1.5, palette: ["#E1EAFF/#3370FF", "#D9F5D6/#2EA121", "#FFF1E8/#FF8800", "#F1E8FF/#7B61FF", "#FFE8EF/#E63995", "#E0F7F7/#14A3A3"] },
  { id: "sketch", label: "手绘", fill: "#FFFDF5", stroke: "#2B2B2B", text: "#2B2B2B", edge: "#2B2B2B", canvas: "#FFFEFA", font: "\"Comic Sans MS\", \"Kaiti SC\", STKaiti, cursive", radius: 6, strokeWidth: 1.8, sketch: true },
  { id: "dark", label: "暗夜", fill: "#2A2F3A", stroke: "#6E9BFF", text: "#E8EAED", edge: "#9AA4B2", canvas: "#1B1E25", font: "PingFang SC, Microsoft YaHei, sans-serif", radius: 8, strokeWidth: 1.5 },
  { id: "business", label: "商务灰", fill: "#F2F3F5", stroke: "#8F959E", text: "#1F2329", edge: "#646A73", canvas: "#FFFFFF", font: "PingFang SC, Microsoft YaHei, sans-serif", radius: 4, strokeWidth: 1, shadow: true },
];
export const themeOf = (id: string | undefined) => THEMES.find((t) => t.id === id) ?? THEMES[0];

const SHAPE_IDS = new Set<string>(SHAPES.map((s) => s.id));
const PORTS = new Set<string>(["top", "right", "bottom", "left"]);
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const clampNum = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Strictly normalize an untrusted node (props, imports, AI). Null if unusable. */
export function normalizeNode(raw: unknown, id?: string): FlowNode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const nid = id ?? (typeof r.id === "string" ? r.id : "");
  if (!ID.test(nid)) return null;
  const shape = (SHAPE_IDS.has(r.shape as string) ? r.shape : "rect") as Shape;
  return {
    id: nid, shape,
    x: clampNum(r.x, -20000, 20000, 0), y: clampNum(r.y, -20000, 20000, 0),
    w: clampNum(r.w, 20, 2000, 140), h: clampNum(r.h, 16, 2000, 60),
    text: str(r.text, 500),
    ...(COLOR.test(r.fill as string) ? { fill: r.fill as string } : {}),
    ...(COLOR.test(r.stroke as string) ? { stroke: r.stroke as string } : {}),
    ...(COLOR.test(r.color as string) ? { color: r.color as string } : {}),
    ...(typeof r.size === "number" && r.size >= 10 && r.size <= 48 ? { size: Math.round(r.size) } : {}),
    ...(r.align === "left" || r.align === "right" ? { align: r.align } : {}),
    ...(shape === "image" && typeof r.fileId === "number" && Number.isSafeInteger(r.fileId) && r.fileId > 0 ? { fileId: r.fileId } : {}),
    ...(typeof r.rot === "number" && Number.isFinite(r.rot) && Math.round(((r.rot % 360) + 360) % 360) % 360 ? { rot: Math.round(((r.rot % 360) + 360) % 360) % 360 } : {}),
    ...(typeof r.z === "number" && Number.isFinite(r.z) ? { z: r.z } : {}),
  };
}

export function normalizeEdge(raw: unknown, id?: string): FlowEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const eid = id ?? (typeof r.id === "string" ? r.id : "");
  if (!ID.test(eid) || typeof r.from !== "string" || typeof r.to !== "string" || !ID.test(r.from) || !ID.test(r.to)) return null;
  return {
    id: eid, from: r.from, to: r.to,
    ...(PORTS.has(r.fromPort as string) ? { fromPort: r.fromPort as Port } : {}),
    ...(PORTS.has(r.toPort as string) ? { toPort: r.toPort as Port } : {}),
    ...(typeof r.label === "string" && r.label ? { label: r.label.slice(0, 200) } : {}),
    ...(r.kind === "straight" || r.kind === "curve" ? { kind: r.kind } : {}),
    ...(r.dashed === true ? { dashed: true } : {}),
    ...(COLOR.test(r.color as string) ? { color: r.color as string } : {}),
    ...(r.arrow === "both" || r.arrow === "none" ? { arrow: r.arrow } : {}),
    ...(typeof r.mid === "number" && Number.isFinite(r.mid) ? { mid: Math.round(Math.min(40000, Math.max(-40000, r.mid))) } : {}),
  };
}

/** Read the graph from block props; edges to missing nodes are dropped. */
export function readFlow(props: Record<string, string>): FlowGraph {
  const nodes: FlowNode[] = [], edges: FlowEdge[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (!value) continue;
    try {
      if (key.startsWith("fc.n.")) { const n = normalizeNode(JSON.parse(value), key.slice(5)); if (n) nodes.push(n); }
      else if (key.startsWith("fc.e.")) { const e = normalizeEdge(JSON.parse(value), key.slice(5)); if (e) edges.push(e); }
    } catch { /* skip corrupt entry */ }
  }
  const ids = new Set(nodes.map((n) => n.id));
  nodes.sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || a.id.localeCompare(b.id));
  return { nodes, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)).sort((a, b) => a.id.localeCompare(b.id)), theme: themeOf(props[FC_THEME]).id };
}

function canonicalNode(n: FlowNode): string | null {
  const v = normalizeNode(n, n.id);
  if (!v) return null;
  const { id: _id, ...rest } = v;
  return JSON.stringify(rest);
}
function canonicalEdge(e: FlowEdge): string | null {
  const v = normalizeEdge(e, e.id);
  if (!v) return null;
  const { id: _id, ...rest } = v;
  return JSON.stringify(rest);
}
function canonicalStored(raw: string | undefined, kind: "n" | "e", id: string): string | null {
  if (!raw) return null;
  try { const parsed = JSON.parse(raw); return kind === "n" ? canonicalNode({ ...parsed, id }) : canonicalEdge({ ...parsed, id }); } catch { return null; }
}

/** Minimal prop writes to move from `props` to `next`: only changed objects (deleted → ""). */
export function flowWrites(props: Record<string, string>, next: FlowGraph): Record<string, string> {
  const writes: Record<string, string> = {};
  if (props[FC_VERSION] !== "1") writes[FC_VERSION] = "1";
  if (props[FC_THEME] !== next.theme) writes[FC_THEME] = next.theme;
  const seenN = new Set<string>(), seenE = new Set<string>();
  // Compare canonical encodings so key order or redundant fields never cause a
  // rewrite of untouched objects (which could clobber a collaborator's edit).
  for (const n of next.nodes) { seenN.add(n.id); const v = canonicalNode(n); if (v && canonicalStored(props[nodeKey(n.id)], "n", n.id) !== v) writes[nodeKey(n.id)] = v; }
  for (const e of next.edges) { seenE.add(e.id); const v = canonicalEdge(e); if (v && canonicalStored(props[edgeKey(e.id)], "e", e.id) !== v) writes[edgeKey(e.id)] = v; }
  for (const [key, value] of Object.entries(props)) {
    if (!value) continue;
    if (key.startsWith("fc.n.") && !seenN.has(key.slice(5))) writes[key] = "";
    if (key.startsWith("fc.e.") && !seenE.has(key.slice(5))) writes[key] = "";
  }
  return writes;
}

let counter = 0;
export function newFlowId(prefix: "n" | "e"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function bounds(nodes: FlowNode[]): { x: number; y: number; w: number; h: number } {
  if (!nodes.length) return { x: 0, y: 0, w: 400, h: 240 };
  const x0 = Math.min(...nodes.map((n) => n.x)), y0 = Math.min(...nodes.map((n) => n.y));
  const x1 = Math.max(...nodes.map((n) => n.x + n.w)), y1 = Math.max(...nodes.map((n) => n.y + n.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Rotate a point around the node centre by the node's rotation. */
export function rotatePoint(n: FlowNode, p: { x: number; y: number }): { x: number; y: number } {
  if (!n.rot) return p;
  const a = (n.rot * Math.PI) / 180, cx = n.x + n.w / 2, cy = n.y + n.h / 2, dx = p.x - cx, dy = p.y - cy;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

export function portPoint(n: FlowNode, port: Port): { x: number; y: number } {
  const local = port === "top" ? { x: n.x + n.w / 2, y: n.y } : port === "bottom" ? { x: n.x + n.w / 2, y: n.y + n.h } : port === "left" ? { x: n.x, y: n.y + n.h / 2 } : { x: n.x + n.w, y: n.y + n.h / 2 };
  return rotatePoint(n, local);
}

const ORDER: Port[] = ["top", "right", "bottom", "left"];
/** World-facing side of a local port after rotation (snapped to 90°). */
export function worldSide(n: FlowNode, port: Port): Port {
  return ORDER[(ORDER.indexOf(port) + Math.round((n.rot ?? 0) / 90)) % 4];
}
/** Local port that faces the given world side. */
function localFor(n: FlowNode, side: Port): Port {
  return ORDER[(ORDER.indexOf(side) - (Math.round((n.rot ?? 0) / 90) % 4) + 4) % 4];
}

/** Pick facing ports when an edge does not pin them. */
export function autoPorts(a: FlowNode, b: FlowNode): [Port, Port] {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2), dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  return dx >= 0 ? ["right", "left"] : ["left", "right"];
}

const dir: Record<Port, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

/** SVG path for an edge plus its label anchor. */
/** Whether the orthogonal middle segment is horizontal (its `mid` is a y coordinate). */
export function midIsY(e: FlowEdge, a: FlowNode, b: FlowNode): boolean {
  const [ap] = autoPorts(a, b);
  return dir[worldSide(a, e.fromPort ?? localFor(a, ap))][1] !== 0;
}

export function edgePath(e: FlowEdge, a: FlowNode, b: FlowNode): { d: string; mid: { x: number; y: number }; start: { x: number; y: number }; end: { x: number; y: number } } {
  const [ap, bp] = autoPorts(a, b);
  const fp = e.fromPort ?? localFor(a, ap), tp = e.toPort ?? localFor(b, bp);
  const p1 = portPoint(a, fp), p2 = portPoint(b, tp);
  const d1 = dir[worldSide(a, fp)], d2 = dir[worldSide(b, tp)];
  if (e.kind === "straight") return { d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, start: p1, end: p2 };
  if (e.kind === "curve") {
    const k = Math.max(40, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3);
    return { d: `M${p1.x},${p1.y} C${p1.x + d1[0] * k},${p1.y + d1[1] * k} ${p2.x + d2[0] * k},${p2.y + d2[1] * k} ${p2.x},${p2.y}`, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, start: p1, end: p2 };
  }
  // Orthogonal: leave each port by 20px, then connect with a single elbow pair.
  const g = 20;
  const s = { x: p1.x + d1[0] * g, y: p1.y + d1[1] * g }, t = { x: p2.x + d2[0] * g, y: p2.y + d2[1] * g };
  const vertical = d1[1] !== 0;
  // `mid` pins the middle segment (dragged by the user); otherwise it sits halfway.
  const my = e.mid ?? (s.y + t.y) / 2, mx = e.mid ?? (s.x + t.x) / 2;
  const pts = vertical
    ? [p1, s, { x: s.x, y: my }, { x: t.x, y: my }, t, p2]
    : [p1, s, { x: mx, y: s.y }, { x: mx, y: t.y }, t, p2];
  const mid = { x: (pts[2].x + pts[3].x) / 2, y: (pts[2].y + pts[3].y) / 2 };
  return { d: "M" + pts.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" L"), mid, start: p1, end: p2 };
}

/**
 * Layered auto layout (top→bottom): ranks by longest path from sources
 * (cycles broken by DFS order), nodes in a rank ordered by parents' average x.
 */
export function autoLayout(graph: FlowGraph, opts: { direction?: "TB" | "LR"; gapX?: number; gapY?: number } = {}): FlowGraph {
  const { direction = "TB", gapX = 60, gapY = 70 } = opts;
  const ids = graph.nodes.map((n) => n.id);
  const out = new Map(ids.map((id) => [id, [] as string[]])), indeg = new Map(ids.map((id) => [id, 0]));
  // Drop back-edges found by DFS so the rank pass terminates on cycles.
  const state = new Map<string, number>(), forward: FlowEdge[] = [];
  const adj = new Map(ids.map((id) => [id, graph.edges.filter((e) => e.from === id)]));
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of adj.get(id) ?? []) {
      if (!out.has(e.to) || e.to === id) continue;
      if (state.get(e.to) === 1) continue;
      forward.push(e);
      if (!state.get(e.to)) visit(e.to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.get(id)) visit(id);
  for (const e of forward) { out.get(e.from)!.push(e.to); indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1); }
  const rank = new Map<string, number>();
  const queue = ids.filter((id) => !indeg.get(id));
  for (const id of queue) rank.set(id, 0);
  const remaining = new Map(indeg);
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of out.get(id)!) {
      rank.set(to, Math.max(rank.get(to) ?? 0, (rank.get(id) ?? 0) + 1));
      remaining.set(to, (remaining.get(to) ?? 1) - 1);
      if (!remaining.get(to)) queue.push(to);
    }
  }
  for (const id of ids) if (!rank.has(id)) rank.set(id, 0);
  const layers: string[][] = [];
  for (const id of ids) (layers[rank.get(id)!] ??= []).push(id);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const pos = new Map<string, number>();
  const parents = (id: string) => forward.filter((e) => e.to === id).map((e) => e.from);
  const placed = new Map<string, { x: number; y: number }>();
  let offset = 0;
  layers.forEach((layer, li) => {
    layer.sort((a, b) => avg(parents(a).map((p) => pos.get(p) ?? 0)) - avg(parents(b).map((p) => pos.get(p) ?? 0)));
    const sizes = layer.map((id) => (direction === "TB" ? byId.get(id)!.w : byId.get(id)!.h));
    const total = sizes.reduce((s, v) => s + v, 0) + gapX * (layer.length - 1);
    let cursor = -total / 2;
    const depth = Math.max(...layer.map((id) => (direction === "TB" ? byId.get(id)!.h : byId.get(id)!.w)));
    layer.forEach((id, i) => {
      pos.set(id, cursor + sizes[i] / 2);
      const n = byId.get(id)!;
      const along = offset + (depth - (direction === "TB" ? n.h : n.w)) / 2;
      placed.set(id, direction === "TB" ? { x: cursor, y: along } : { x: along, y: cursor });
      cursor += sizes[i] + gapX;
    });
    offset += depth + gapY;
    void li;
  });
  const nodes = graph.nodes.map((n) => ({ ...n, ...placed.get(n.id)! }));
  const b = bounds(nodes);
  return { ...graph, nodes: nodes.map((n) => ({ ...n, x: Math.round(n.x - b.x + 40), y: Math.round(n.y - b.y + 40) })), edges: graph.edges.map(({ fromPort: _f, toPort: _t, mid: _m, ...e }) => e) };
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

/** Fit node text roughly: grow width for long labels (CJK ≈ 14px, latin ≈ 8px per char). */
export function measureLabel(text: string, minW: number): number {
  const longest = Math.max(0, ...text.split("\n").map((line) => [...line].reduce((s, ch) => s + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 14 : 8), 0)));
  return Math.min(360, Math.max(minW, longest + 32));
}

/** Mermaid text for Markdown export (shapes mapped to the closest Mermaid node syntax). */
export function toMermaid(graph: FlowGraph): string {
  const q = (s: string) => `"${s.replace(/"/g, "'").replace(/\n/g, "<br/>")}"`;
  const wrap: Record<Shape, [string, string]> = { rect: ["[", "]"], round: ["(", ")"], terminator: ["([", "])"], diamond: ["{", "}"], parallelogram: ["[/", "/]"], ellipse: ["((", "))"], document: ["[", "]"], cylinder: ["[(", ")]"], hexagon: ["{{", "}}"], text: ["[", "]"], triangle: ["[", "]"], note: ["[", "]"], swimlane: ["[", "]"], swimlaneV: ["[", "]"], class: ["[", "]"], actor: ["((", "))"], lifeline: ["[", "]"], image: ["[", "]"] };
  const ids = new Map(graph.nodes.map((n, i) => [n.id, `N${i + 1}`]));
  const lines = ["flowchart TD"];
  for (const n of graph.nodes) { const [a, b] = wrap[n.shape]; lines.push(`  ${ids.get(n.id)}${a}${q(n.text || (n.shape === "image" ? "图片" : " "))}${b}`); }
  for (const e of graph.edges) {
    const arrow = e.arrow === "none" ? (e.dashed ? "-.-" : "---") : e.arrow === "both" ? (e.dashed ? "<-.->" : "<-->") : e.dashed ? "-.->" : "-->";
    lines.push(`  ${ids.get(e.from)} ${arrow}${e.label ? `|${q(e.label)}|` : ""} ${ids.get(e.to)}`);
  }
  return lines.join("\n");
}

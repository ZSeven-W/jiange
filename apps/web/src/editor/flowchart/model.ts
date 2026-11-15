import { canonicalMindDescription, canonicalMindDescriptionStyle, canonicalMindPaint, canonicalMindStyle, canonicalMindTextFormat, canonicalMindTopic, layoutMindTopics, mindCollapseIntent, mindCollapseKey, mindDescriptionAt, mindDescriptionIntent, mindDescriptionKey, mindDescriptionStyleAt, mindDescriptionStyleIntent, mindDescriptionStyleKey, mindIntentWrites, mindKey, mindPaintIntent, mindPaintKey, mindStyleIntent, mindStyleKey, mindTextFormatIntent, mindTextFormatKey, readMindCollapsed, readMindDescriptions, readMindDescriptionStyles, readMindPaints, readMindStyles, readMindTextFormats, readMindTopics, storedMindTopic, type MindDescriptions, type MindDescriptionStyles, type MindPaints, type MindStyles, type MindTextFormats, type MindTopic } from "./mindmap";
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
export interface FlowEdge { id: string; from: string; to: string; fromPort?: Port; toPort?: Port; label?: string; kind?: EdgeKind; dashed?: boolean; color?: string; arrow?: "end" | "both" | "none"; mid?: number; pts?: { x: number; y: number }[] }
export interface FlowStroke { id: string; points: { x: number; y: number }[]; color: string; width: number; marker?: true }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[]; strokes?: FlowStroke[]; mind?: MindTopic[]; mindCollapsed?: string[]; mindStyles?: MindStyles; mindPaints?: MindPaints; mindTextFormats?: MindTextFormats; mindDescriptions?: MindDescriptions; mindDescriptionStyles?: MindDescriptionStyles; /** Client-only guard for a complete text-style replacement. */ mindTextStyleIntent?: string[]; theme: string }
export type FlowChangeOutcome = { graph: FlowGraph; conflicts: string[]; applied: boolean; appliedKeys: string[] };

export const FC_VERSION = "fc.v";
export const FC_THEME = "fc.theme";
export const FC_HEIGHT = "fc.h";
const nodeKey = (id: string) => `fc.n.${id}`;
const edgeKey = (id: string) => `fc.e.${id}`;
const strokeKey = (id: string) => `fc.s.${id}`;
// Separate marker metadata survives old clients rewriting a known stroke.
const markerKey = (id: string) => `fc.marker.${id}`;

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
    ...(() => {
      if (!Array.isArray(r.pts)) return {};
      const pts = r.pts.slice(0, 20).filter((p): p is { x: number; y: number } => !!p && typeof p === "object" && Number.isFinite((p as { x: unknown }).x) && Number.isFinite((p as { y: unknown }).y))
        .map((p) => ({ x: Math.round(Math.min(40000, Math.max(-40000, p.x))), y: Math.round(Math.min(40000, Math.max(-40000, p.y))) }));
      return pts.length ? { pts } : {};
    })(),
  };
}

/** Ink uses independent keys so older flowchart editors preserve unknown strokes. */
export function normalizeStroke(raw: unknown, id?: string): FlowStroke | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sid = id ?? (typeof r.id === "string" ? r.id : "");
  if (!ID.test(sid) || !Array.isArray(r.points) || r.points.length < 1 || r.points.length > 400 || !COLOR.test(r.color as string) || typeof r.width !== "number" || !Number.isFinite(r.width) || r.width < 1 || r.width > 24) return null;
  const points: { x: number; y: number }[] = [];
  for (const p of r.points) {
    if (!p || typeof p !== "object" || typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 20000 || Math.abs(p.y) > 20000) return null;
    points.push({ x: Math.round(p.x), y: Math.round(p.y) });
  }
  return { id: sid, points, color: r.color as string, width: r.width, ...(r.marker === true ? { marker: true as const } : {}) };
}

/** Read the graph from block props; edges to missing nodes are dropped. */
export function readFlow(props: Record<string, string>): FlowGraph {
  const nodes: FlowNode[] = [], edges: FlowEdge[] = [], strokes: FlowStroke[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (!value) continue;
    try {
      if (key.startsWith("fc.n.")) { const n = normalizeNode(JSON.parse(value), key.slice(5)); if (n) nodes.push(n); }
      else if (key.startsWith("fc.e.")) { const e = normalizeEdge(JSON.parse(value), key.slice(5)); if (e) edges.push(e); }
      else if (key.startsWith("fc.s.")) { const s = normalizeStroke(JSON.parse(value), key.slice(5)); if (s) { const { marker: _ignored, ...legacyStroke } = s; strokes.push(props[markerKey(s.id)] === "1" ? { ...legacyStroke, marker: true } : legacyStroke); } }
    } catch { /* skip corrupt entry */ }
  }
  const ids = new Set(nodes.map((n) => n.id));
  nodes.sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || a.id.localeCompare(b.id));
  const mind = readMindTopics(props), mindCollapsed = readMindCollapsed(props, mind), mindStyles = readMindStyles(props, mind), mindPaints = readMindPaints(props, mind), mindTextFormats = readMindTextFormats(props, mind), mindDescriptions = readMindDescriptions(props, mind), mindDescriptionStyles = readMindDescriptionStyles(props, mind);
  return { nodes, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)).sort((a, b) => a.id.localeCompare(b.id)), ...(strokes.length ? { strokes: strokes.sort((a, b) => a.id.localeCompare(b.id)) } : {}), ...(mind.length ? { mind } : {}), ...(mindCollapsed.length ? { mindCollapsed } : {}), ...(Object.keys(mindStyles).length ? { mindStyles } : {}), ...(Object.keys(mindPaints).length ? { mindPaints } : {}), ...(Object.keys(mindTextFormats).length ? { mindTextFormats } : {}), ...(Object.keys(mindDescriptions).length ? { mindDescriptions } : {}), ...(Object.keys(mindDescriptionStyles).length ? { mindDescriptionStyles } : {}), theme: themeOf(props[FC_THEME]).id };
}

function canonicalStroke(stroke: FlowStroke): string | null {
  const value = normalizeStroke(stroke, stroke.id);
  if (!value) return null;
  const { id: _id, marker: _marker, ...rest } = value;
  return JSON.stringify(rest);
}
function storedStroke(raw: string | undefined, id: string): string | null {
  if (!raw) return null;
  try { return canonicalStroke({ ...JSON.parse(raw), id }); } catch { return null; }
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
  if (next.strokes) {
    const seen = new Set<string>();
    for (const stroke of next.strokes) { seen.add(stroke.id); const value = canonicalStroke(stroke); if (value && storedStroke(props[strokeKey(stroke.id)], stroke.id) !== value) writes[strokeKey(stroke.id)] = value; if (value && stroke.marker && !props[markerKey(stroke.id)]) writes[markerKey(stroke.id)] = "1"; }
    for (const [key, value] of Object.entries(props)) if (key.startsWith("fc.s.") && value && !seen.has(key.slice(5))) writes[key] = "";
  }
  if (next.mind) {
    const seen = new Set<string>();
    for (const topic of next.mind) { seen.add(topic.id); const value = canonicalMindTopic(topic), existing = storedMindTopic(props[mindKey(topic.id)], topic.id); if (value && (!existing || canonicalMindTopic(existing) !== value)) writes[mindKey(topic.id)] = value; }
    for (const [key, value] of Object.entries(props)) if (key.startsWith("fc.m.") && value && !seen.has(key.slice(5))) writes[key] = "";
  }
  if (next.mindCollapsed !== undefined) {
    const collapsed = new Set(next.mindCollapsed);
    for (const topic of next.mind ?? []) { const key = mindCollapseKey(topic.id), wanted = collapsed.has(topic.id) ? "1" : ""; if ((props[key] ?? "") !== wanted) writes[key] = wanted; }
  }
  if (next.mindStyles !== undefined) for (const topic of next.mind ?? []) { const key = mindStyleKey(topic.id), wanted = canonicalMindStyle(next.mindStyles[topic.id]); if (wanted !== null && (props[key] ?? "") !== wanted) writes[key] = wanted; }
  if (next.mindPaints !== undefined) for (const topic of next.mind ?? []) { const key = mindPaintKey(topic.id), wanted = canonicalMindPaint(next.mindPaints[topic.id]); if (wanted !== null && (props[key] ?? "") !== wanted) writes[key] = wanted; }
  if (next.mindTextFormats !== undefined) for (const topic of next.mind ?? []) { const key = mindTextFormatKey(topic.id), wanted = canonicalMindTextFormat(next.mindTextFormats[topic.id]); if (wanted !== null && (props[key] ?? "") !== wanted) writes[key] = wanted; }
  if (next.mindDescriptions !== undefined) for (const topic of next.mind ?? []) { const key = mindDescriptionKey(topic.id), wanted = canonicalMindDescription(mindDescriptionAt(next.mindDescriptions, topic.id)); if (wanted !== null && (props[key] ?? "") !== wanted) writes[key] = wanted; }
  if (next.mindDescriptionStyles !== undefined) for (const topic of next.mind ?? []) { const key = mindDescriptionStyleKey(topic.id), wanted = canonicalMindDescriptionStyle(mindDescriptionStyleAt(next.mindDescriptionStyles, topic.id)); if (wanted !== null && (props[key] ?? "") !== wanted) writes[key] = wanted; }
  for (const [key, value] of Object.entries(props)) {
    if (!value) continue;
    if (key.startsWith("fc.n.") && !seenN.has(key.slice(5))) writes[key] = "";
    if (key.startsWith("fc.e.") && !seenE.has(key.slice(5))) writes[key] = "";
  }
  return writes;
}

export type FlowIntentResult = { writes: Record<string, string>; conflicts: string[] };

/**
 * Apply only the objects changed between the editor's base and proposed graph.
 * If a touched object changed remotely, keep the remote value and report the
 * local intent instead of silently overwriting it.
 */
export function flowIntentWrites(props: Record<string, string>, base: FlowGraph, next: FlowGraph): FlowIntentResult {
  const writes: Record<string, string> = {}, conflicts = new Set<string>();
  const oldNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const newNodes = new Map(next.nodes.map((n) => [n.id, n]));
  const oldEdges = new Map(base.edges.map((e) => [e.id, e]));
  const newEdges = new Map(next.edges.map((e) => [e.id, e]));
  const nodeIDs = new Set([...oldNodes.keys(), ...newNodes.keys()]);
  const current = readFlow(props);
  const blockedNodes = new Set<string>();
  const stored = (key: string, kind: "n" | "e", id: string) => canonicalStored(props[key], kind, id);
  const malformed = (key: string, value: string | null) => !!props[key] && value === null;
  const edgesByNode = new Map<string, FlowEdge[]>();
  for (const [key, raw] of Object.entries(props)) {
    if (!key.startsWith("fc.e.") || !raw) continue;
    let edge: FlowEdge | null = null;
    try { edge = normalizeEdge(JSON.parse(raw), key.slice(5)); } catch { /* preserve unreadable objects */ }
    if (!edge) continue;
    for (const id of new Set([edge.from, edge.to])) {
      const list = edgesByNode.get(id) ?? [];
      list.push(edge); edgesByNode.set(id, list);
    }
  }

  // Detect all touched-node conflicts before applying dependent deletions.
  for (const id of nodeIDs) {
    const beforeNode = oldNodes.get(id), nextNode = newNodes.get(id), key = nodeKey(id);
    const before = beforeNode ? canonicalNode(beforeNode) : null, after = nextNode ? canonicalNode(nextNode) : null;
    if (before === after) continue;
    const now = stored(key, "n", id);
    if (malformed(key, now) || (now !== before && now !== after)) { blockedNodes.add(id); conflicts.add(key); }
  }

  for (const [id, node] of oldNodes) {
    if (newNodes.has(id) || blockedNodes.has(id)) continue;
    const key = nodeKey(id), before = canonicalNode(node), now = stored(key, "n", id);
    if (malformed(key, now) || (now !== null && now !== before)) { blockedNodes.add(id); conflicts.add(key); continue; }
    for (const edge of edgesByNode.get(id) ?? []) {
      const prior = oldEdges.get(edge.id);
      if (!prior || newEdges.has(edge.id) || canonicalEdge(prior) !== canonicalEdge(edge)) { blockedNodes.add(id); conflicts.add(key); break; }
    }
  }

  // A rejected endpoint deletion also protects the other locally deleted
  // endpoint; otherwise an unchanged connecting edge would become dangling.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of oldEdges.values()) {
      if (newEdges.has(edge.id)) continue;
      for (const [id, other] of [[edge.from, edge.to], [edge.to, edge.from]]) {
        if (blockedNodes.has(other) && oldNodes.has(id) && !newNodes.has(id) && !blockedNodes.has(id)) {
          blockedNodes.add(id); conflicts.add(nodeKey(id)); changed = true;
        }
      }
    }
  }

  for (const id of nodeIDs) {
    const beforeNode = oldNodes.get(id), nextNode = newNodes.get(id), key = nodeKey(id);
    const before = beforeNode ? canonicalNode(beforeNode) : null, after = nextNode ? canonicalNode(nextNode) : null;
    if (before === after || blockedNodes.has(id)) continue;
    const now = stored(key, "n", id);
    if (now !== after) writes[key] = after ?? "";
  }

  const effectiveNodes = new Set(current.nodes.map((n) => n.id));
  for (const [key, value] of Object.entries(writes)) if (key.startsWith("fc.n.")) { if (value) effectiveNodes.add(key.slice(5)); else effectiveNodes.delete(key.slice(5)); }
  const edgeIDs = new Set([...oldEdges.keys(), ...newEdges.keys()]);
  for (const id of edgeIDs) {
    const beforeEdge = oldEdges.get(id), nextEdge = newEdges.get(id), key = edgeKey(id);
    const before = beforeEdge ? canonicalEdge(beforeEdge) : null, after = nextEdge ? canonicalEdge(nextEdge) : null;
    if (before === after) continue;
    if (!nextEdge && beforeEdge && (blockedNodes.has(beforeEdge.from) || blockedNodes.has(beforeEdge.to))) { conflicts.add(key); continue; }
    if (nextEdge && (!effectiveNodes.has(nextEdge.from) || !effectiveNodes.has(nextEdge.to) || blockedNodes.has(nextEdge.from) || blockedNodes.has(nextEdge.to))) { conflicts.add(key); continue; }
    const now = stored(key, "e", id);
    if (malformed(key, now) || (now !== before && now !== after)) { conflicts.add(key); continue; }
    if (now !== after) writes[key] = after ?? "";
  }

  const oldStrokes = new Map((base.strokes ?? []).map((stroke) => [stroke.id, stroke]));
  const newStrokes = new Map((next.strokes ?? []).map((stroke) => [stroke.id, stroke]));
  for (const id of new Set([...oldStrokes.keys(), ...newStrokes.keys()])) {
    const key = strokeKey(id), previous = oldStrokes.get(id), nextStroke = newStrokes.get(id);
    const before = previous ? canonicalStroke(previous) : null, after = nextStroke ? canonicalStroke(nextStroke) : null;
    const oldMarker = previous?.marker === true, nextMarker = nextStroke?.marker === true;
    if (before === after && oldMarker === nextMarker) continue;
    const now = storedStroke(props[key], id), metadata = props[markerKey(id)] || "";
    // Styles are immutable per stroke; preserve marker metadata on deletion so
    // undo and old clients cannot accidentally turn it into an opaque stroke.
    if ((previous && nextStroke && oldMarker !== nextMarker) || (metadata !== "" && metadata !== "1") ||
        (previous && oldMarker !== (metadata === "1")) || (!previous && metadata === "1" && !nextMarker) ||
        (!!props[key] && now === null) || (now !== before && now !== after)) { conflicts.add(key); continue; }
    if (nextStroke && nextMarker && metadata !== "1") writes[markerKey(id)] = "1";
    if (now !== after) writes[key] = after ?? "";
  }

  if (next.mind !== undefined) {
    const mindResult = mindIntentWrites(props, base.mind ?? [], next.mind, base.mindDescriptions ?? {}, base.mindDescriptionStyles ?? {});
    Object.assign(writes, mindResult.writes); mindResult.conflicts.forEach((key) => conflicts.add(key));
    {
      const foldResult = mindCollapseIntent(props, base.mindCollapsed ?? [], next.mindCollapsed ?? base.mindCollapsed ?? [], base.mind ?? [], next.mind, mindResult.writes);
      const styleResult = mindStyleIntent(props, base.mindStyles ?? {}, next.mindStyles ?? base.mindStyles ?? {}, base.mind ?? [], next.mind, mindResult.writes);
      const paintResult = mindPaintIntent(props, base.mindPaints ?? {}, next.mindPaints ?? base.mindPaints ?? {}, base.mind ?? [], next.mind, mindResult.writes);
      const textResult = mindTextFormatIntent(props, base.mindTextFormats ?? {}, next.mindTextFormats ?? base.mindTextFormats ?? {}, base.mind ?? [], next.mind, mindResult.writes);
      const descriptionResult = mindDescriptionIntent(props, base.mindDescriptions ?? {}, next.mindDescriptions ?? base.mindDescriptions ?? {}, base.mind ?? [], next.mind, mindResult.writes, next.mindDescriptionStyles ?? base.mindDescriptionStyles ?? {});
      const descriptionStyleResult = mindDescriptionStyleIntent(props, base.mindDescriptionStyles ?? {}, next.mindDescriptionStyles ?? base.mindDescriptionStyles ?? {}, base.mind ?? [], next.mind, mindResult.writes, next.mindDescriptions ?? base.mindDescriptions ?? {});
      Object.assign(writes, foldResult.writes); foldResult.conflicts.forEach((key) => conflicts.add(key));
      Object.assign(writes, styleResult.writes); styleResult.conflicts.forEach((key) => conflicts.add(key));
      Object.assign(writes, paintResult.writes); paintResult.conflicts.forEach((key) => conflicts.add(key));
      Object.assign(writes, textResult.writes); textResult.conflicts.forEach((key) => conflicts.add(key));
      Object.assign(writes, descriptionResult.writes); descriptionResult.conflicts.forEach((key) => conflicts.add(key));
      Object.assign(writes, descriptionStyleResult.writes); descriptionStyleResult.conflicts.forEach((key) => conflicts.add(key));
      // A single intent that changes both description and style must not be half applied.
      for (const id of new Set([...descriptionResult.conflicts.map((key) => key.slice(6)), ...descriptionStyleResult.conflicts.map((key) => key.slice(7))])) {
        const textChanged = canonicalMindDescription(mindDescriptionAt(base.mindDescriptions, id)) !== canonicalMindDescription(mindDescriptionAt(next.mindDescriptions ?? base.mindDescriptions, id));
        const styleChanged = canonicalMindDescriptionStyle(mindDescriptionStyleAt(base.mindDescriptionStyles, id)) !== canonicalMindDescriptionStyle(mindDescriptionStyleAt(next.mindDescriptionStyles ?? base.mindDescriptionStyles, id));
        if (textChanged && styleChanged) { delete writes[mindDescriptionKey(id)]; delete writes[mindDescriptionStyleKey(id)]; conflicts.add(mindDescriptionKey(id)); conflicts.add(mindDescriptionStyleKey(id)); }
      }
      // Replacing text style must also check unchanged-looking fields: a newer
      // format or an unseen remote edit must not be silently left behind.
      for (const id of next.mindTextStyleIntent ?? []) {
        if (!base.mind?.some((topic) => topic.id === id) || !next.mind.some((topic) => topic.id === id)) continue;
        const checks = [
          { key: mindStyleKey(id), before: canonicalMindStyle(base.mindStyles?.[id]), after: canonicalMindStyle(next.mindStyles?.[id]), canonical: canonicalMindStyle },
          { key: mindTextFormatKey(id), before: canonicalMindTextFormat(base.mindTextFormats?.[id]), after: canonicalMindTextFormat(next.mindTextFormats?.[id]), canonical: canonicalMindTextFormat },
        ];
        let blocked = false;
        for (const check of checks) {
          let now: string | null = ""; const raw = props[check.key];
          if (raw) { try { now = check.canonical(JSON.parse(raw)); } catch { now = null; } }
          if (check.before === null || check.after === null || now === null || (now !== check.before && now !== check.after)) { conflicts.add(check.key); blocked = true; }
        }
        if (blocked) { delete writes[mindStyleKey(id)]; delete writes[mindTextFormatKey(id)]; }
      }
      // A style copied to one topic is not half-applied when its other style key conflicts.
      for (const key of [...styleResult.conflicts, ...paintResult.conflicts, ...textResult.conflicts]) { const id = key.slice(6); delete writes[mindStyleKey(id)]; delete writes[mindPaintKey(id)]; delete writes[mindTextFormatKey(id)]; }
      const oldIds = new Set((base.mind ?? []).map((topic) => topic.id));
      const blocked = new Set([...mindResult.conflicts, ...foldResult.conflicts, ...styleResult.conflicts, ...paintResult.conflicts, ...textResult.conflicts, ...descriptionResult.conflicts, ...descriptionStyleResult.conflicts].map((key) => key.slice(key.startsWith("fc.m.") ? 5 : key.startsWith("fc.mds.") ? 7 : 6)).filter((id) => !oldIds.has(id)));
      const addedRoot = (id: string) => { let topic = next.mind!.find((item) => item.id === id); const seen = new Set<string>(); while (topic?.parent && !oldIds.has(topic.parent) && !seen.has(topic.id)) { seen.add(topic.id); topic = next.mind!.find((item) => item.id === topic!.parent); } return topic?.id; };
      const blockedRoots = new Set([...blocked].map(addedRoot).filter((id): id is string => !!id));
      for (const topic of next.mind) if (!oldIds.has(topic.id) && blockedRoots.has(addedRoot(topic.id)!)) blocked.add(topic.id);
      // Existing nodes reparented underneath a rejected new node must stay put.
      for (const topic of next.mind) { const before = base.mind?.find((item) => item.id === topic.id); if (before && topic.parent && blocked.has(topic.parent) && before.parent !== topic.parent) { delete writes[mindKey(topic.id)]; conflicts.add(mindKey(topic.id)); } }
      for (const root of blockedRoots) {
        const parent = next.mind.find((topic) => topic.id === root)?.parent; if (!parent) continue;
        delete writes[mindCollapseKey(parent)];
        for (const topic of next.mind) { const before = base.mind?.find((item) => item.id === topic.id); if (before && before.parent === parent && topic.parent === parent && before.order !== topic.order) { delete writes[mindKey(topic.id)]; conflicts.add(mindKey(topic.id)); } }
      }
      let count = -1;
      while (count !== blocked.size) { count = blocked.size; for (const topic of next.mind) if (!oldIds.has(topic.id) && topic.parent && blocked.has(topic.parent)) blocked.add(topic.id); }
      for (const id of blocked) { delete writes[mindKey(id)]; delete writes[mindCollapseKey(id)]; delete writes[mindStyleKey(id)]; delete writes[mindPaintKey(id)]; delete writes[mindTextFormatKey(id)]; delete writes[mindDescriptionKey(id)]; delete writes[mindDescriptionStyleKey(id)]; conflicts.add(mindKey(id)); }
    }
  }

  if (base.theme !== next.theme) {
    const now = themeOf(props[FC_THEME]).id;
    if (now !== base.theme && now !== next.theme) conflicts.add(FC_THEME);
    else if (now !== next.theme) writes[FC_THEME] = next.theme;
  }
  if (Object.keys(writes).length && props[FC_VERSION] !== "1") writes[FC_VERSION] = "1";
  return { writes, conflicts: [...conflicts] };
}

let counter = 0;
export function newFlowId(prefix: "n" | "e" | "s" | "m"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function flowBounds(graph: FlowGraph): { x: number; y: number; w: number; h: number } {
  const boxes = graph.nodes.map(({ x, y, w, h }) => ({ x, y, w, h }));
  for (const stroke of graph.strokes ?? []) {
    if (!stroke.points.length) continue;
    const xs = stroke.points.map((p) => p.x), ys = stroke.points.map((p) => p.y), pad = stroke.width / 2;
    const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
    boxes.push({ x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y });
  }
  for (const item of layoutMindTopics(graph.mind ?? [], new Set(graph.mindCollapsed ?? []), graph.mindStyles, graph.mindDescriptions, graph.mindDescriptionStyles)) boxes.push({ x: item.x, y: item.y, w: item.w, h: item.h });
  if (!boxes.length) return { x: 0, y: 0, w: 400, h: 240 };
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/** Keep a whole selection inside the coordinate limit without distorting ink. */
export function boundedFlowOffset(nodes: readonly Pick<FlowNode, "x" | "y">[], strokes: readonly FlowStroke[], dx: number, dy: number): { x: number; y: number } {
  let minX = -40000, maxX = 40000, minY = -40000, maxY = 40000;
  const include = (x: number, y: number) => { minX = Math.max(minX, -20000 - x); maxX = Math.min(maxX, 20000 - x); minY = Math.max(minY, -20000 - y); maxY = Math.min(maxY, 20000 - y); };
  nodes.forEach((node) => include(node.x, node.y));
  strokes.forEach((stroke) => stroke.points.forEach((point) => include(point.x, point.y)));
  return { x: Math.max(Math.ceil(minX), Math.min(Math.floor(maxX), Math.round(Number.isFinite(dx) ? dx : 0))), y: Math.max(Math.ceil(minY), Math.min(Math.floor(maxY), Math.round(Number.isFinite(dy) ? dy : 0))) };
}

export function moveFlowSelection(graph: FlowGraph, selected: ReadonlySet<string>, dx: number, dy: number): FlowGraph {
  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  const strokes = (graph.strokes ?? []).filter((stroke) => selected.has(stroke.id));
  if (!nodes.length && !strokes.length) return graph;
  const offset = boundedFlowOffset(nodes, strokes, dx, dy);
  return { ...graph, nodes: graph.nodes.map((node) => selected.has(node.id) ? { ...node, x: node.x + offset.x, y: node.y + offset.y } : node), ...(graph.strokes ? { strokes: graph.strokes.map((stroke) => selected.has(stroke.id) ? { ...stroke, points: stroke.points.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y })) } : stroke) } : {}) };
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

type Pt = { x: number; y: number };
const pointNode = (p: Pt): FlowNode => ({ id: "_", shape: "rect", text: "", x: p.x, y: p.y, w: 0, h: 0 });
/** Point at half the length of a polyline (label anchor). */
function halfway(pts: Pt[]): Pt {
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  let left = lens.reduce((s, v) => s + v, 0) / 2;
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i] || i === lens.length - 1) { const t = lens[i] ? Math.min(1, left / lens[i]) : 0; return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t }; }
    left -= lens[i];
  }
  return pts[0];
}

/** Route through user waypoints (Feishu: 拖动连线添加拐点). */
function waypointPath(e: FlowEdge, a: FlowNode, b: FlowNode, P: Pt[]) {
  const fp = e.fromPort ?? localFor(a, autoPorts(a, pointNode(P[0]))[0]);
  const tp = e.toPort ?? localFor(b, autoPorts(pointNode(P[P.length - 1]), b)[1]);
  const p1 = portPoint(a, fp), p2 = portPoint(b, tp);
  const chain = [p1, ...P, p2];
  if (e.kind === "curve") {
    // Catmull-Rom through all points, converted to cubic Béziers.
    let d = `M${chain[0].x},${chain[0].y}`;
    for (let i = 0; i < chain.length - 1; i++) {
      const p0 = chain[i - 1] ?? chain[i], c = chain[i], n = chain[i + 1], n2 = chain[i + 2] ?? n;
      d += ` C${c.x + (n.x - p0.x) / 6},${c.y + (n.y - p0.y) / 6} ${n.x - (n2.x - c.x) / 6},${n.y - (n2.y - c.y) / 6} ${n.x},${n.y}`;
    }
    return { d, mid: halfway(chain), start: p1, end: p2 };
  }
  let pts = chain;
  if (e.kind !== "straight") {
    // Orthogonal: one elbow per leg, leaving the source along its port direction.
    pts = [chain[0]];
    let vertical = dir[worldSide(a, fp)][1] !== 0;
    for (let i = 1; i < chain.length; i++) {
      const u = pts[pts.length - 1], v = chain[i];
      if (u.x !== v.x && u.y !== v.y) { pts.push(vertical ? { x: u.x, y: v.y } : { x: v.x, y: u.y }); }
      else vertical = u.x === v.x ? true : false;
      pts.push(v);
      vertical = !vertical;
    }
  }
  return { d: "M" + pts.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" L"), mid: halfway(pts), start: p1, end: p2 };
}

export function edgePath(e: FlowEdge, a: FlowNode, b: FlowNode): { d: string; mid: { x: number; y: number }; start: { x: number; y: number }; end: { x: number; y: number } } {
  if (e.pts?.length) return waypointPath(e, a, b, e.pts);
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
  return { ...graph, nodes: nodes.map((n) => ({ ...n, x: Math.round(n.x - b.x + 40), y: Math.round(n.y - b.y + 40) })), edges: graph.edges.map(({ fromPort: _f, toPort: _t, mid: _m, pts: _p, ...e }) => e) };
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
  const mindIds = new Map((graph.mind ?? []).map((topic, index) => [topic.id, `M${index + 1}`]));
  for (const topic of graph.mind ?? []) lines.push(`  ${mindIds.get(topic.id)}[${q(topic.text || " ")}]`);
  for (const topic of graph.mind ?? []) if (topic.parent && mindIds.has(topic.parent)) lines.push(`  ${mindIds.get(topic.parent)} --- ${mindIds.get(topic.id)}`);
  for (const e of graph.edges) {
    const arrow = e.arrow === "none" ? (e.dashed ? "-.-" : "---") : e.arrow === "both" ? (e.dashed ? "<-.->" : "<-->") : e.dashed ? "-.->" : "-->";
    lines.push(`  ${ids.get(e.from)} ${arrow}${e.label ? `|${q(e.label)}|` : ""} ${ids.get(e.to)}`);
  }
  return lines.join("\n");
}

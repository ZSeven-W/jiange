import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlignCenter, AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceAround, AlignLeft, AlignRight, AlignStartHorizontal, AlignStartVertical, AlignVerticalSpaceAround, ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronLeft, Copy, Diamond, Download, FileUp, Hand, LayoutTemplate, Loader2, Maximize2, MessageSquare, Minus, MoreHorizontal, RotateCcw, RotateCw, MousePointer2, Palette, Plus, Redo2, Search, Shapes, Sparkles, Spline, Square, Trash2, Type, Undo2, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { aiErrorText, openAISettings, type AIMessage } from "@/lib/ai";
import { autoLayout, bounds, isContainer, textArea, edgePath, midIsY, portPoint, measureLabel, newFlowId, normalizeEdge, normalizeNode, SHAPES, themeOf, THEMES, type EdgeKind, type FlowEdge, type FlowGraph, type FlowNode, type FlowTheme, type Port, type Shape } from "./model";
import { DrawioError, parseDrawio, toDrawio } from "./drawio";
import { flowchartPrompt, parseFlowchartAnswer } from "./ai";
import { FLOW_TEMPLATES, type FlowTemplate } from "./templates";

/* ---------------- rendering ---------------- */

function wrapLines(text: string, width: number): string[] {
  const max = Math.max(4, width - 16);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "", w = 0;
    for (const ch of [...para]) {
      const cw = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 14 : 7.5;
      if (w + cw > max && line) { out.push(line); line = ""; w = 0; }
      line += ch; w += cw;
    }
    out.push(line);
  }
  return out.slice(0, 8);
}

function nodeColors(n: FlowNode, theme: FlowTheme): { fill: string; stroke: string; text: string } {
  if (theme.palette && !n.fill && !n.stroke) {
    let h = 0;
    for (const ch of n.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const [fill, stroke] = theme.palette[h % theme.palette.length].split("/");
    return { fill, stroke, text: n.color ?? theme.text };
  }
  // An explicit fill (e.g. from draw.io) keeps readable text on any theme.
  const text = n.color ?? (n.fill && n.shape !== "text" ? readableOn(n.fill) : theme.text);
  return { fill: n.shape === "text" ? "transparent" : n.fill ?? theme.fill, stroke: n.shape === "text" ? "transparent" : n.stroke ?? theme.stroke, text };
}

function readableOn(hex: string): string {
  const v = parseInt(hex.slice(1), 16), r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1F2329" : "#FFFFFF";
}

export function ShapeOutline({ n, theme, fill, stroke }: { n: FlowNode; theme: FlowTheme; fill: string; stroke: string }) {
  const { x, y, w, h } = n;
  const common = { fill, stroke, strokeWidth: theme.strokeWidth };
  switch (n.shape) {
    case "round": return <rect x={x} y={y} width={w} height={h} rx={Math.min(16, theme.radius + 6)} {...common} />;
    case "terminator": return <rect x={x} y={y} width={w} height={h} rx={h / 2} {...common} />;
    case "ellipse": return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
    case "diamond": return <polygon points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} {...common} />;
    case "parallelogram": { const k = Math.min(24, w / 5); return <polygon points={`${x + k},${y} ${x + w},${y} ${x + w - k},${y + h} ${x},${y + h}`} {...common} />; }
    case "hexagon": { const k = Math.min(24, w / 5); return <polygon points={`${x + k},${y} ${x + w - k},${y} ${x + w},${y + h / 2} ${x + w - k},${y + h} ${x + k},${y + h} ${x},${y + h / 2}`} {...common} />; }
    case "document": { const k = h * 0.14; return <path d={`M${x},${y} H${x + w} V${y + h - k} C${x + w * 0.75},${y + h - 2.6 * k} ${x + w * 0.25},${y + h + 0.6 * k} ${x},${y + h - k} Z`} {...common} />; }
    case "cylinder": { const k = Math.min(14, h / 5); return <g><path d={`M${x},${y + k} A${w / 2},${k} 0 0 1 ${x + w},${y + k} V${y + h - k} A${w / 2},${k} 0 0 1 ${x},${y + h - k} Z`} {...common} /><path d={`M${x},${y + k} A${w / 2},${k} 0 0 0 ${x + w},${y + k}`} fill="none" stroke={stroke} strokeWidth={theme.strokeWidth} /></g>; }
    case "text": return <rect x={x} y={y} width={w} height={h} fill="transparent" stroke="none" />;
    case "triangle": return <polygon points={`${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}`} {...common} />;
    case "note": { const k = Math.min(18, w / 5, h / 3); return <g><path d={`M${x},${y} H${x + w - k} L${x + w},${y + k} V${y + h} H${x} Z`} {...common} /><path d={`M${x + w - k},${y} V${y + k} H${x + w}`} fill="none" stroke={stroke} strokeWidth={theme.strokeWidth} /></g>; }
    // 泳道主体不填充（点击穿透到画布，可在泳道内框选），只有标题栏可选中。
    case "swimlane": return <g><rect x={x} y={y} width={w} height={h} fill="none" stroke={stroke} strokeWidth={theme.strokeWidth} /><rect x={x} y={y} width={32} height={h} {...common} /></g>;
    case "swimlaneV": return <g><rect x={x} y={y} width={w} height={h} fill="none" stroke={stroke} strokeWidth={theme.strokeWidth} /><rect x={x} y={y} width={w} height={36} {...common} /></g>;
    case "class": return <g><rect x={x} y={y} width={w} height={h} rx={Math.min(4, theme.radius)} {...common} /><line x1={x} y1={y + 32} x2={x + w} y2={y + 32} stroke={stroke} strokeWidth={theme.strokeWidth} /></g>;
    case "actor": {
      const fh = h - 22, r = Math.min(w * 0.22, fh * 0.16), cx = x + w / 2, neck = y + 2 * r + 2, hip = y + fh * 0.62;
      return <g><rect x={x} y={y} width={w} height={fh} fill="transparent" stroke="none" /><circle cx={cx} cy={y + r + 1} r={r} {...common} />
        <path d={`M${cx},${neck} V${hip} M${x + w * 0.1},${neck + fh * 0.14} H${x + w * 0.9} M${cx},${hip} L${x + w * 0.15},${y + fh} M${cx},${hip} L${x + w * 0.85},${y + fh}`} fill="none" stroke={stroke} strokeWidth={theme.strokeWidth} strokeLinecap="round" /></g>;
    }
    case "lifeline": return <g><rect x={x + w / 2 - 6} y={y + 44} width={12} height={Math.max(0, h - 44)} fill="transparent" stroke="none" /><rect x={x} y={y} width={w} height={44} rx={Math.min(4, theme.radius)} {...common} /><line x1={x + w / 2} y1={y + 44} x2={x + w / 2} y2={y + h} stroke={stroke} strokeWidth={theme.strokeWidth * 0.75} strokeDasharray="6 5" /></g>;
    default: return <rect x={x} y={y} width={w} height={h} rx={theme.radius} {...common} />;
  }
}

/** Node label inside its text area (header for lanes/classes/lifelines, below the figure for actors). */
function NodeText({ n, fill }: { n: FlowNode; fill: string }) {
  if (!n.text) return null;
  const fs = n.size ?? 14, lh = Math.round(fs * 1.3), a = textArea(n);
  const anchor = n.align === "left" ? "start" : n.align === "right" ? "end" : "middle";
  const ax = (box: { x: number; w: number }) => (n.align === "left" ? box.x + 10 : n.align === "right" ? box.x + box.w - 10 : box.x + box.w / 2);
  const block = (lines: string[], box: { x: number; y: number; w: number; h: number }, extra: React.SVGProps<SVGTextElement> = {}) => {
    const x = ax(box);
    return <text x={x} y={box.y + box.h / 2 - ((lines.length - 1) * lh) / 2 + fs * 0.36} textAnchor={anchor} fontSize={fs} fill={fill} pointerEvents="none" {...extra}>
      {lines.map((l, i) => <tspan key={i} x={x} dy={i ? lh : 0}>{l}</tspan>)}
    </text>;
  };
  if (a.vertical) {
    // 竖排标题（与飞书泳道一致，字符保持正向）。
    const chars = [...n.text.replace(/\s+/g, "")].slice(0, Math.max(1, Math.floor((a.h - 16) / lh)));
    const cx = a.x + a.w / 2, top = a.y + a.h / 2 - ((chars.length - 1) * lh) / 2 + fs * 0.36;
    return <text x={cx} y={top} textAnchor="middle" fontSize={fs} fill={fill} pointerEvents="none">{chars.map((ch, i) => <tspan key={i} x={cx} dy={i ? lh : 0}>{ch}</tspan>)}</text>;
  }
  if (n.shape === "class") {
    const [head, ...rest] = n.text.split("\n");
    const bodyLines = rest.flatMap((l) => wrapLines(l, n.w * 14 / fs)).slice(0, Math.max(0, Math.floor((n.h - 40) / lh)));
    return <g>
      {block(wrapLines(head, a.w * 14 / fs).slice(0, 1), a, { fontWeight: 600 })}
      {bodyLines.length > 0 && <text x={n.x + 10} y={n.y + 32 + 8 + fs * 0.9} fontSize={fs - 1} fill={fill} pointerEvents="none">{bodyLines.map((l, i) => <tspan key={i} x={n.x + 10} dy={i ? lh : 0}>{l}</tspan>)}</text>}
    </g>;
  }
  return block(wrapLines(n.text, a.w * 14 / fs), a);
}

export function FlowSvg({ graph, width, height, viewBox, selected, editing, onNodeDown, onEdgeDown, onPortDown, onCanvasDown, onNodeDouble, onEdgeDouble, connectPreview, idPrefix = "fc", transparent, guides, marquee, rotateHandle, bendHandle, peerSel }: {
  graph: FlowGraph; width?: number | string; height?: number | string; viewBox?: string;
  selected?: Set<string>; editing?: string | null;
  onNodeDown?: (e: React.PointerEvent, n: FlowNode) => void;
  onEdgeDown?: (e: React.PointerEvent, edge: FlowEdge) => void;
  onPortDown?: (e: React.PointerEvent, n: FlowNode, port: Port) => void;
  onCanvasDown?: (e: React.PointerEvent) => void;
  onNodeDouble?: (n: FlowNode) => void;
  onEdgeDouble?: (edge: FlowEdge) => void;
  connectPreview?: { x1: number; y1: number; x2: number; y2: number } | null;
  idPrefix?: string;
  /** 编辑器内使用：背景透明，露出点阵网格。 */
  transparent?: boolean;
  guides?: { x1: number; y1: number; x2: number; y2: number }[];
  marquee?: { x: number; y: number; w: number; h: number } | null;
  /** Node id that shows a rotation handle (single selection). */
  rotateHandle?: string | null;
  /** Edge id that shows a draggable middle-segment handle. */
  bendHandle?: string | null;
  /** Collaborators' selections, outlined in their colour. */
  peerSel?: { color: string; ids: string[] }[];
}) {
  const theme = themeOf(graph.theme);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const b = bounds(graph.nodes);
  const vb = viewBox ?? `${b.x - 40} ${b.y - 40} ${Math.max(200, b.w + 80)} ${Math.max(120, b.h + 80)}`;
  const filter = theme.sketch ? `url(#${idPrefix}-sketch)` : theme.shadow ? `url(#${idPrefix}-shadow)` : undefined;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={vb} style={{ background: transparent ? "transparent" : theme.canvas, fontFamily: theme.font }} onPointerDown={onCanvasDown} data-flow-svg>
      <defs>
        <marker id={`${idPrefix}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={theme.edge} /></marker>
        <filter id={`${idPrefix}-sketch`} filterUnits="userSpaceOnUse" x="-20000" y="-20000" width="60000" height="60000"><feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="3" /><feDisplacementMap in="SourceGraphic" scale="2.2" /></filter>
        <filter id={`${idPrefix}-shadow`} x="-10%" y="-10%" width="130%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#1F2329" floodOpacity="0.12" /></filter>
      </defs>
      {graph.edges.map((e) => {
        const a = byId.get(e.from), t = byId.get(e.to);
        if (!a || !t) return null;
        const { d, mid } = edgePath(e, a, t);
        const color = e.color ?? theme.edge;
        const sel = selected?.has(e.id);
        const bend = bendHandle === e.id && (e.kind ?? "orthogonal") === "orthogonal" && onEdgeDown;
        return <g key={e.id} data-flow-edge={e.id}>
          <path d={d} fill="none" stroke="transparent" strokeWidth={12} style={{ cursor: onEdgeDown ? "pointer" : undefined }} onPointerDown={onEdgeDown ? (ev) => onEdgeDown(ev, e) : undefined} onDoubleClick={onEdgeDouble ? () => onEdgeDouble(e) : undefined} />
          <path d={d} fill="none" stroke={sel ? "#3370FF" : color} strokeWidth={sel ? 2.2 : 1.5} strokeDasharray={e.dashed ? "6 4" : undefined} filter={theme.sketch ? filter : undefined} markerEnd={e.arrow === "none" ? undefined : `url(#${idPrefix}-arrow)`} markerStart={e.arrow === "both" ? `url(#${idPrefix}-arrow)` : undefined} pointerEvents="none" />
          {e.label && <g pointerEvents="none"><rect x={mid.x - measureLabel(e.label, 0) / 2 + 10} y={mid.y - 10} width={Math.max(20, measureLabel(e.label, 0) - 20)} height={20} rx={4} fill={theme.canvas} /><text x={mid.x} y={mid.y + 4} textAnchor="middle" fontSize={12} fill={theme.text}>{e.label}</text></g>}
          {bend && <circle cx={mid.x} cy={mid.y} r={5} fill="#FFFFFF" stroke="#3370FF" strokeWidth={1.5} style={{ cursor: midIsY(e, a, t) ? "ns-resize" : "ew-resize" }} onPointerDown={(ev) => onEdgeDown(ev, e)} data-flow-bend={e.id} />}
        </g>;
      })}
      {graph.nodes.map((n) => {
        const c = nodeColors(n, theme);
        const sel = selected?.has(n.id);
        const peer = peerSel?.find((p) => p.ids.includes(n.id));
        return <g key={n.id} data-flow-node={n.id} transform={n.rot ? `rotate(${n.rot} ${n.x + n.w / 2} ${n.y + n.h / 2})` : undefined} style={{ cursor: onNodeDown ? "move" : undefined }} onPointerDown={onNodeDown ? (ev) => onNodeDown(ev, n) : undefined} onDoubleClick={onNodeDouble ? () => onNodeDouble(n) : undefined}>
          <g filter={filter}><ShapeOutline n={n} theme={theme} fill={c.fill} stroke={c.stroke} /></g>
          {editing !== n.id && <NodeText n={n} fill={c.text} />}
          {sel && <rect x={n.x - 4} y={n.y - 4} width={n.w + 8} height={n.h + 8} rx={4} fill="none" stroke="#3370FF" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />}
          {sel && onPortDown && (["top", "right", "bottom", "left"] as Port[]).map((p) => {
            const o = 16; // 飞书的连接点在图形外侧
            const pt = p === "top" ? [n.x + n.w / 2, n.y - o] : p === "bottom" ? [n.x + n.w / 2, n.y + n.h + o] : p === "left" ? [n.x - o, n.y + n.h / 2] : [n.x + n.w + o, n.y + n.h / 2];
            return <circle key={p} cx={pt[0]} cy={pt[1]} r={5} fill="#FFFFFF" stroke="#3370FF" strokeWidth={1.5} style={{ cursor: "crosshair" }} onPointerDown={(ev) => { ev.stopPropagation(); onPortDown(ev, n, p); }} data-flow-port={p} />;
          })}
          {sel && onPortDown && <rect x={n.x + n.w - 5} y={n.y + n.h - 5} width={10} height={10} fill="#3370FF" style={{ cursor: "nwse-resize" }} data-flow-resize={n.id} />}
          {rotateHandle === n.id && onPortDown && <g data-flow-rotate={n.id} style={{ cursor: "grab" }}><circle cx={n.x + n.w + 16} cy={n.y - 16} r={7} fill="#FFFFFF" stroke="#3370FF" strokeWidth={1.5} data-flow-rotate={n.id} /><path d={`M${n.x + n.w + 12.5},${n.y - 17} a3.6,3.6 0 1 1 1.4,3`} fill="none" stroke="#3370FF" strokeWidth={1.3} pointerEvents="none" /></g>}
          {peer && !sel && <rect x={n.x - 4} y={n.y - 4} width={n.w + 8} height={n.h + 8} rx={4} fill="none" stroke={peer.color} strokeWidth={2} pointerEvents="none" data-flow-peer-sel />}
        </g>;
      })}
      {guides?.map((g, i) => <line key={i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="#F54A45" strokeWidth={1} pointerEvents="none" data-flow-guide />)}
      {marquee && <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill="rgba(51,112,255,0.08)" stroke="#3370FF" strokeWidth={1} pointerEvents="none" data-flow-marquee />}
      {connectPreview && <line x1={connectPreview.x1} y1={connectPreview.y1} x2={connectPreview.x2} y2={connectPreview.y2} stroke="#3370FF" strokeWidth={1.5} strokeDasharray="5 4" markerEnd={`url(#${idPrefix}-arrow)`} pointerEvents="none" />}
    </svg>
  );
}

/* ---------------- inline block ---------------- */

/** 文档内的流程图块：预览 + 打开全屏编辑器（对应飞书在文档中打开画板）。 */
export function FlowchartBlock({ graph, height, readOnly, autoOpen, ai, onChange, peers, onPresence, onComment }: {
  graph: FlowGraph; height: number; readOnly: boolean; autoOpen?: boolean;
  ai?: (messages: AIMessage[]) => Promise<string>;
  onChange?: (next: FlowGraph) => void;
  peers?: FlowPeer[];
  onPresence?: (p: FlowPresence | null) => void;
  onComment?: (quote: string) => void;
}) {
  const [open, setOpen] = useState(!!autoOpen && !readOnly);
  return <div contentEditable={false} className="group/flow relative overflow-hidden rounded-lg border border-transparent transition-colors hover:border-[#DEE0E3] focus-within:border-[#3370FF] dark:hover:border-border" style={{ height }} data-flowchart>
    {graph.nodes.length ? <FlowSvg graph={graph} width="100%" height="100%" idPrefix="fcp" /> : <div className="grid h-full place-items-center bg-[#F8F9FA] text-[13px] text-subtle dark:bg-hover"><span className="flex items-center gap-1.5"><Workflow size={16} />空白流程图{!readOnly && "，点击「编辑」开始绘制"}</span></div>}
    <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/flow:opacity-100 [@media(hover:none)]:opacity-100">
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(true)} className="flex h-7 items-center gap-1 rounded-md border bg-surface px-2 text-[12px] shadow-sm hover:bg-hover" data-flow-open>{readOnly ? <><Maximize2 size={13} />查看</> : <><Workflow size={13} />编辑</>}</button>
    </div>
    {!!peers?.length && <div className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-surface/90 px-1.5 py-0.5 text-[12px] text-subtle shadow-sm" data-flow-peers>{peers.slice(0, 3).map((p) => <span key={p.id} className="grid size-5 place-items-center rounded-full text-[11px] text-white" style={{ background: p.color }} title={p.name}>{[...p.name][0]}</span>)}正在编辑</div>}
    {open && <FlowchartEditor initial={graph} readOnly={readOnly} ai={ai} onChange={onChange} onClose={() => { onPresence?.(null); setOpen(false); }} peers={peers} onPresence={onPresence} onComment={onComment} />}
  </div>;
}

/* ---------------- full-screen editor ---------------- */

type Drag =
  | { kind: "move"; ids: string[]; startX: number; startY: number; origin: Map<string, { x: number; y: number }> }
  | { kind: "resize"; id: string; startX: number; startY: number; w: number; h: number }
  | { kind: "pan"; startX: number; startY: number; vx: number; vy: number }
  | { kind: "connect"; from: string; port: Port; x: number; y: number }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number; base: Set<string> }
  | { kind: "rotate"; id: string; cx: number; cy: number; a0: number; rot0: number }
  | { kind: "bend"; id: string; isY: boolean };

/** A collaborator inside the same flowchart (from awareness). */
export interface FlowPeer { id: number; name: string; color: string; x?: number; y?: number; sel?: string[] }
export interface FlowPresence { x?: number; y?: number; sel?: string[] }

type FlowClip = { nodes: FlowNode[]; edges: FlowEdge[] };
const CLIP_MARK = "jiange-flowchart:";
/** In-app clipboard so copy/paste works between flowchart blocks even without clipboard permission. */
let flowClipboard: FlowClip | null = null;
type Guide = { x1: number; y1: number; x2: number; y2: number };

const PALETTE = ["#E1EAFF/#3370FF", "#D9F5D6/#2EA121", "#FFF1E8/#FF8800", "#FEF8C5/#DC9B04", "#FFE8EF/#E63995", "#F1E8FF/#7B61FF", "#F2F3F5/#8F959E", "#FFFFFF/#1F2329"];

export function FlowchartEditor({ initial, readOnly, ai, onChange, onClose, peers = [], onPresence, onComment }: {
  initial: FlowGraph; readOnly: boolean;
  ai?: (messages: AIMessage[]) => Promise<string>;
  onChange?: (next: FlowGraph) => void;
  onClose: () => void;
  peers?: FlowPeer[];
  onPresence?: (p: FlowPresence | null) => void;
  onComment?: (quote: string) => void;
}) {
  const [graph, setGraph] = useState(initial);
  const [undo, setUndo] = useState<FlowGraph[]>([]);
  const [redo, setRedo] = useState<FlowGraph[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<Shape | "select">("select");
  const [editing, setEditing] = useState<{ id: string; kind: "node" | "edge"; value: string } | null>(null);
  const [view, setView] = useState(() => { const b = bounds(initial.nodes); return { x: b.x - 80, y: b.y - 80, zoom: 1 }; });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<"theme" | "export" | "ai" | "shape" | "fill" | "stroke" | "color" | "align" | "more" | "template" | null>(null);
  const [hand, setHand] = useState(false);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [edgeKind, setEdgeKind] = useState<EdgeKind>("orthogonal");
  const space = useRef(false);
  const pasteCount = useRef(0);
  // 协作感知：广播指针位置与选中对象（节流），离开时清空。
  const presence = useRef<{ x?: number; y?: number; t: number }>({ t: 0 });
  const presenceRef = useRef(onPresence);
  presenceRef.current = onPresence;
  const selectedKey = [...selected].sort().join(",");
  useEffect(() => { presenceRef.current?.({ x: presence.current.x, y: presence.current.y, sel: selectedKey ? selectedKey.split(",").slice(0, 50) : [] }); }, [selectedKey]);
  useEffect(() => () => presenceRef.current?.(null), []);
  const trackPointer = (clientX: number, clientY: number) => {
    if (!presenceRef.current || !svgWrap.current) return;
    const now = Date.now();
    if (now - presence.current.t < 80) return;
    const p = toWorld(clientX, clientY);
    presence.current = { x: Math.round(p.x), y: Math.round(p.y), t: now };
    presenceRef.current({ x: presence.current.x, y: presence.current.y, sel: selectedKey ? selectedKey.split(",").slice(0, 50) : [] });
  };
  const [library, setLibrary] = useState(true);
  const [libQuery, setLibQuery] = useState("");
  const [aiText, setAiText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const svgWrap = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  // Remote edits arrive through `initial`; adopt them when not mid-gesture.
  const lastInitial = useRef(initial);
  useEffect(() => { if (initial !== lastInitial.current && !drag && !editing) { lastInitial.current = initial; setGraph(initial); } }, [initial, drag, editing]);
  useEffect(() => {
    const el = svgWrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const commit = (next: FlowGraph) => {
    if (readOnly) return;
    setUndo((u) => [...u.slice(-99), graph]); setRedo([]);
    setGraph(next); lastInitial.current = next; onChange?.(next);
  };
  const toWorld = (clientX: number, clientY: number) => {
    const r = svgWrap.current!.getBoundingClientRect();
    return { x: view.x + (clientX - r.left) / view.zoom, y: view.y + (clientY - r.top) / view.zoom };
  };
  const fit = (g = graph) => {
    const b = bounds(g.nodes);
    // 左侧留出竖向工具条，上下留出浮动栏。
    const padL = readOnly ? 40 : 90, padR = 40, usableW = Math.max(100, size.w - padL - padR), usableH = Math.max(100, size.h - 160);
    const zoom = Math.min(1.5, Math.max(0.2, Math.min(usableW / Math.max(1, b.w), usableH / Math.max(1, b.h))));
    setView({ zoom, x: b.x - (padL + (usableW - b.w * zoom) / 2) / zoom, y: b.y - (size.h - b.h * zoom) / 2 / zoom });
  };
  const addNode = (shape: Shape, at?: { x: number; y: number }) => {
    const spec = SHAPES.find((s) => s.id === shape)!;
    const c = at ?? { x: view.x + size.w / view.zoom / 2, y: view.y + size.h / view.zoom / 2 };
    const node: FlowNode = { id: newFlowId("n"), shape, text: shape === "text" ? "文本" : spec.label.replace(/（.*）/, ""), x: Math.round(c.x - spec.w / 2), y: Math.round(c.y - spec.h / 2), w: spec.w, h: spec.h, z: isContainer(shape) ? Math.min(0, ...graph.nodes.map((n) => n.z ?? 0)) - 1 : Math.max(0, ...graph.nodes.map((n) => n.z ?? 0)) + 1 };
    if (shape === "class") node.text = "ClassName\n+ field: type\n+ method()";
    if (shape === "actor" || shape === "lifeline") node.text = shape === "actor" ? "用户" : "对象";
    commit({ ...graph, nodes: [...graph.nodes, node] });
    setSelected(new Set([node.id])); setTool("select");
  };
  const removeSelected = () => {
    if (!selected.size) return;
    commit({ ...graph, nodes: graph.nodes.filter((n) => !selected.has(n.id)), edges: graph.edges.filter((e) => !selected.has(e.id) && !selected.has(e.from) && !selected.has(e.to)) });
    setSelected(new Set());
  };
  const clipOfSelection = (): FlowClip | null => {
    const ids = new Set(graph.nodes.filter((n) => selected.has(n.id)).map((n) => n.id));
    if (!ids.size) return null;
    return { nodes: graph.nodes.filter((n) => ids.has(n.id)), edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  };
  const pasteClip = (clip: FlowClip, offset: number) => {
    const map = new Map(clip.nodes.map((n) => [n.id, newFlowId("n")]));
    const top = Math.max(0, ...graph.nodes.map((n) => n.z ?? 0));
    const nodes = clip.nodes.map((n, i) => ({ ...n, id: map.get(n.id)!, x: n.x + offset, y: n.y + offset, z: isContainer(n.shape) ? n.z : top + 1 + i }));
    const edges = clip.edges.filter((e) => map.has(e.from) && map.has(e.to)).map((e) => ({ ...e, id: newFlowId("e"), from: map.get(e.from)!, to: map.get(e.to)! }));
    commit({ ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges] });
    setSelected(new Set(nodes.map((n) => n.id)));
  };
  const nudge = (dx: number, dy: number) => commit({ ...graph, nodes: graph.nodes.map((n) => (selected.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) });
  const doUndo = () => { const prev = undo.at(-1); if (!prev) return; setUndo(undo.slice(0, -1)); setRedo([...redo, graph]); setGraph(prev); lastInitial.current = prev; onChange?.(prev); };
  const doRedo = () => { const next = redo.at(-1); if (!next) return; setRedo(redo.slice(0, -1)); setUndo([...undo, graph]); setGraph(next); lastInitial.current = next; onChange?.(next); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) return;
      if (e.key === "Escape") { if (selected.size) setSelected(new Set()); else onClose(); }
      if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) { e.preventDefault(); removeSelected(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !readOnly) { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(new Set(graph.nodes.map((n) => n.id))); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && !readOnly) { e.preventDefault(); const c = clipOfSelection(); if (c) pasteClip(c, 20); }
      if (e.key.startsWith("Arrow") && selected.size && !readOnly) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        nudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
      }
      if (e.key === " ") space.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === " ") space.current = false; };
    const inField = (t: EventTarget | null) => editing || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    const onCopy = (e: ClipboardEvent) => {
      if (inField(e.target)) return;
      const c = clipOfSelection();
      if (!c) return;
      flowClipboard = c;
      e.clipboardData?.setData("text/plain", CLIP_MARK + JSON.stringify(c));
      e.preventDefault(); e.stopPropagation();
      if (e.type === "cut" && !readOnly) removeSelected();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (inField(e.target) || readOnly) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      e.preventDefault(); e.stopPropagation();
      pasteCount.current += 1;
      if (text.startsWith(CLIP_MARK) || (!text && flowClipboard)) {
        let clip = flowClipboard;
        try { if (text) { const raw = JSON.parse(text.slice(CLIP_MARK.length)) as { nodes?: unknown[]; edges?: unknown[] }; clip = { nodes: (raw.nodes ?? []).map((n) => normalizeNode(n)).filter((n): n is FlowNode => !!n), edges: (raw.edges ?? []).map((x) => normalizeEdge(x)).filter((x): x is FlowEdge => !!x) }; } } catch { /* fall back to the in-app clipboard */ }
        if (clip?.nodes.length) pasteClip(clip, 24 * pasteCount.current);
        return;
      }
      if (/<mxfile|<mxGraphModel/.test(text)) { void importDrawioText(text); return; }
      if (text.trim()) {
        const c = { x: view.x + size.w / view.zoom / 2, y: view.y + size.h / view.zoom / 2 };
        const value = text.trim().slice(0, 500), w = measureLabel(value, 80);
        const node: FlowNode = { id: newFlowId("n"), shape: "text", text: value, x: Math.round(c.x - w / 2), y: Math.round(c.y - 18), w, h: Math.max(36, Math.min(8, value.split("\n").length) * 20), z: Math.max(0, ...graph.nodes.map((n) => n.z ?? 0)) + 1 };
        commit({ ...graph, nodes: [...graph.nodes, node] }); setSelected(new Set([node.id]));
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("cut", onCopy, true);
    document.addEventListener("paste", onPaste, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("cut", onCopy, true);
      document.removeEventListener("paste", onPaste, true);
    };
  });
  useEffect(() => { if (initial.nodes.length) requestAnimationFrame(() => fit(initial)); /* fit once */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerMove = (e: React.PointerEvent) => {
    trackPointer(e.clientX, e.clientY);
    if (!drag) return;
    if (drag.kind === "pan") { setView((v) => ({ ...v, x: drag.vx - (e.clientX - drag.startX) / v.zoom, y: drag.vy - (e.clientY - drag.startY) / v.zoom })); return; }
    const p = toWorld(e.clientX, e.clientY);
    if (drag.kind === "connect") { setDrag({ ...drag, x: p.x, y: p.y }); return; }
    if (drag.kind === "marquee") { setDrag({ ...drag, x1: p.x, y1: p.y }); return; }
    if (drag.kind === "rotate") {
      // 自由旋转；接近 0/90/180/270° 时吸附，按住 Shift 以 15° 为步进。
      let rot = drag.rot0 + (Math.atan2(p.y - drag.cy, p.x - drag.cx) * 180) / Math.PI - drag.a0;
      rot = e.shiftKey ? Math.round(rot / 15) * 15 : Math.abs(rot - Math.round(rot / 90) * 90) < 4 ? Math.round(rot / 90) * 90 : Math.round(rot);
      rot = ((rot % 360) + 360) % 360;
      setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === drag.id ? { ...n, rot: rot || undefined } : n)) }));
      return;
    }
    if (drag.kind === "bend") { setGraph((g) => ({ ...g, edges: g.edges.map((x) => (x.id === drag.id ? { ...x, mid: Math.round(drag.isY ? p.y : p.x) } : x)) })); return; }
    let dx = (e.clientX - drag.startX) / view.zoom, dy = (e.clientY - drag.startY) / view.zoom;
    if (drag.kind === "move") {
      // 对齐吸附：移动对象的左/中/右、上/中/下与其他图形对齐时吸附并显示参考线（按住 Alt 关闭）。
      const lines: Guide[] = [];
      if (!e.altKey) {
        const moving = graph.nodes.filter((n) => drag.origin.has(n.id)).map((n) => ({ ...n, x: drag.origin.get(n.id)!.x + dx, y: drag.origin.get(n.id)!.y + dy }));
        const mb = bounds(moving), th = 6 / view.zoom;
        const others = graph.nodes.filter((n) => !drag.origin.has(n.id));
        let bx: { d: number; v: number; o: FlowNode } | null = null, by: { d: number; v: number; o: FlowNode } | null = null;
        for (const o of others) {
          for (const v of [o.x, o.x + o.w / 2, o.x + o.w]) for (const m of [mb.x, mb.x + mb.w / 2, mb.x + mb.w]) { const d = v - m; if (Math.abs(d) <= th && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, v, o }; }
          for (const v of [o.y, o.y + o.h / 2, o.y + o.h]) for (const m of [mb.y, mb.y + mb.h / 2, mb.y + mb.h]) { const d = v - m; if (Math.abs(d) <= th && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, v, o }; }
        }
        if (bx) dx += bx.d;
        if (by) dy += by.d;
        const ny = mb.y + (by?.d ?? 0), nx = mb.x + (bx?.d ?? 0);
        if (bx) lines.push({ x1: bx.v, x2: bx.v, y1: Math.min(bx.o.y, ny) - 8, y2: Math.max(bx.o.y + bx.o.h, ny + mb.h) + 8 });
        if (by) lines.push({ y1: by.v, y2: by.v, x1: Math.min(by.o.x, nx) - 8, x2: Math.max(by.o.x + by.o.w, nx + mb.w) + 8 });
      }
      setGuides(lines);
      setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => { const o = drag.origin.get(n.id); return o ? { ...n, x: Math.round(o.x + dx), y: Math.round(o.y + dy) } : n; }) }));
    }
    if (drag.kind === "resize") setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => {
      if (n.id !== drag.id) return n;
      // Resize along the shape's own axes when it is rotated.
      const a = (-(n.rot ?? 0) * Math.PI) / 180, lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      return { ...n, w: Math.max(20, Math.round(drag.w + lx)), h: Math.max(16, Math.round(drag.h + ly)) };
    }) }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null); setGuides([]);
    if (d.kind === "marquee") {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if (x1 - x0 < 3 && y1 - y0 < 3) return;
      const inside = graph.nodes.filter((n) => n.x >= x0 && n.y >= y0 && n.x + n.w <= x1 && n.y + n.h <= y1).map((n) => n.id);
      setSelected(new Set([...d.base, ...inside]));
      return;
    }
    if (d.kind === "connect") {
      const p = toWorld(e.clientX, e.clientY);
      const target = [...graph.nodes].reverse().find((n) => p.x >= n.x - 8 && p.x <= n.x + n.w + 8 && p.y >= n.y - 8 && p.y <= n.y + n.h + 8);
      if (target && target.id !== d.from) {
        const edge: FlowEdge = { id: newFlowId("e"), from: d.from, to: target.id, fromPort: d.port, kind: edgeKind };
        commit({ ...graph, edges: [...graph.edges, edge] }); setSelected(new Set([edge.id]));
      }
      return;
    }
    if (d.kind === "bend") {
      const base = lastInitial.current;
      if (JSON.stringify(base.edges) !== JSON.stringify(graph.edges)) { setUndo((u) => [...u.slice(-99), base]); setRedo([]); lastInitial.current = graph; onChange?.(graph); }
      return;
    }
    if (d.kind === "move" || d.kind === "resize" || d.kind === "rotate") {
      const before = undo.length ? null : null; void before;
      // Commit the gesture result relative to the pre-drag graph.
      const base = lastInitial.current;
      if (JSON.stringify(base.nodes) !== JSON.stringify(graph.nodes)) { setUndo((u) => [...u.slice(-99), base]); setRedo([]); lastInitial.current = graph; onChange?.(graph); }
    }
  };

  const selectedNodes = graph.nodes.filter((n) => selected.has(n.id));
  const selectedEdges = graph.edges.filter((e) => selected.has(e.id));
  const patchNodes = (patch: Partial<FlowNode>) => commit({ ...graph, nodes: graph.nodes.map((n) => (selected.has(n.id) ? { ...n, ...patch } : n)) });
  const patchEdges = (patch: Partial<FlowEdge>) => commit({ ...graph, edges: graph.edges.map((e) => (selected.has(e.id) ? { ...e, ...patch } : e)) });
  const editNode = editing?.kind === "node" ? graph.nodes.find((n) => n.id === editing.id) : null;
  const editEdge = editing?.kind === "edge" ? graph.edges.find((x) => x.id === editing.id) : null;
  const finishEdit = () => {
    if (!editing) return;
    if (editing.kind === "node" && editNode && editNode.text !== editing.value) commit({ ...graph, nodes: graph.nodes.map((n) => (n.id === editing.id ? { ...n, text: editing.value.slice(0, 500), w: Math.max(n.w, n.shape === "text" ? measureLabel(editing.value, n.w) : n.w) } : n)) });
    if (editing.kind === "edge" && editEdge && (editEdge.label ?? "") !== editing.value) commit({ ...graph, edges: graph.edges.map((x) => (x.id === editing.id ? { ...x, label: editing.value.slice(0, 200) || undefined } : x)) });
    setEditing(null);
  };

  const importDrawio = async (file: File) => importDrawioText(await file.text());
  const importDrawioText = async (text: string) => {
    setBusy(true); setNotice(null);
    try {
      const { graph: g, warnings } = await parseDrawio(text);
      const merged = graph.nodes.length ? appendGraph(graph, g) : { ...g, theme: graph.theme };
      commit(merged); requestAnimationFrame(() => fit(merged));
      setNotice({ ok: true, text: `已导入 ${g.nodes.length} 个图形、${g.edges.length} 条连线${warnings.length ? `；${warnings.join("；")}` : ""}` });
    } catch (err) { setNotice({ ok: false, text: err instanceof DrawioError ? err.message : "导入失败，请确认文件来自 draw.io / diagrams.net" }); }
    finally { setBusy(false); }
  };
  const runAI = async () => {
    if (!ai || !aiText.trim()) return;
    setBusy(true); setNotice(null);
    try {
      const parsed = parseFlowchartAnswer(await ai(flowchartPrompt(aiText)));
      if (!parsed) { setNotice({ ok: false, text: "AI 没有返回可用的流程图，请换种描述再试" }); return; }
      const next = graph.nodes.length ? appendGraph(graph, parsed.graph) : { ...parsed.graph, theme: graph.theme };
      commit(next); requestAnimationFrame(() => fit(next)); setMenu(null);
      setNotice({ ok: true, text: `AI 生成了 ${parsed.graph.nodes.length} 个节点${parsed.dropped ? `，${parsed.dropped} 项无效内容已忽略` : ""}，请核对` });
    } catch (err) { setNotice({ ok: false, text: aiErrorText(err) }); }
    finally { setBusy(false); }
  };
  const download = (name: string, blob: Blob) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 0); };
  const exportAs = async (kind: "svg" | "png" | "drawio") => {
    setMenu(null);
    if (kind === "drawio") return download("流程图.drawio", new Blob([toDrawio(graph)], { type: "application/xml" }));
    const svg = svgMarkup(graph);
    if (kind === "svg") return download("流程图.svg", new Blob([svg], { type: "image/svg+xml" }));
    const b = bounds(graph.nodes), scale = 2, w = (b.w + 80) * scale, h = (b.h + 80) * scale;
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode().catch(() => {});
    const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.drawImage(img, 0, 0, w, h);
    canvas.toBlob((blob) => blob && download("流程图.png", blob), "image/png");
  };

  const alignNodes = (k: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") => {
    const b = bounds(selectedNodes);
    commit({ ...graph, nodes: graph.nodes.map((n) => {
      if (!selected.has(n.id)) return n;
      switch (k) {
        case "left": return { ...n, x: b.x };
        case "hcenter": return { ...n, x: Math.round(b.x + b.w / 2 - n.w / 2) };
        case "right": return { ...n, x: b.x + b.w - n.w };
        case "top": return { ...n, y: b.y };
        case "vcenter": return { ...n, y: Math.round(b.y + b.h / 2 - n.h / 2) };
        default: return { ...n, y: b.y + b.h - n.h };
      }
    }) });
  };
  const distribute = (axis: "x" | "y") => {
    const list = [...selectedNodes].sort((a, b) => (axis === "x" ? a.x - b.x : a.y - b.y));
    const b = bounds(list), total = list.reduce((s, n) => s + (axis === "x" ? n.w : n.h), 0);
    const gap = ((axis === "x" ? b.w : b.h) - total) / (list.length - 1);
    let cursor = axis === "x" ? b.x : b.y;
    const pos = new Map<string, number>();
    for (const n of list) { pos.set(n.id, Math.round(cursor)); cursor += (axis === "x" ? n.w : n.h) + gap; }
    commit({ ...graph, nodes: graph.nodes.map((n) => (pos.has(n.id) ? { ...n, [axis]: pos.get(n.id)! } : n)) });
  };
  const layer = (where: "front" | "back") => {
    const zs = graph.nodes.map((n) => n.z ?? 0);
    let z = where === "front" ? Math.max(0, ...zs) : Math.min(0, ...zs);
    commit({ ...graph, nodes: graph.nodes.map((n) => (selected.has(n.id) ? { ...n, z: where === "front" ? ++z : --z } : n)) });
  };
  const applyTemplate = (t: FlowTemplate) => {
    const g = t.build(graph.theme);
    const next = graph.nodes.length ? appendGraph(graph, g) : g;
    commit(next); setMenu(null); requestAnimationFrame(() => fit(next));
  };

  const theme = themeOf(graph.theme);
  const viewBox = `${view.x} ${view.y} ${size.w / view.zoom} ${size.h / view.zoom}`;
  const tb = "grid size-8 place-items-center rounded-md text-[#1F2329] hover:bg-hover disabled:opacity-30 dark:text-foreground";
  const pop = "absolute top-10 z-20 rounded-lg border border-[#DEE0E3] bg-surface p-1 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border";

  const floatBar = "flex items-center gap-0.5 rounded-lg border border-[#DEE0E3] bg-surface p-1 shadow-[0_4px_16px_rgba(31,35,41,0.08)] dark:border-border";
  const barBtn = "flex h-8 items-center gap-1 rounded-md px-2 text-[13px] text-[#1F2329] hover:bg-hover disabled:opacity-30 dark:text-foreground";
  const menuItem = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover";
  const railBtn = "grid size-9 place-items-center rounded-md text-[#1F2329] hover:bg-hover dark:text-foreground";
  const libraryGroups: { title: string; shapes: Shape[] }[] = [
    { title: "基础", shapes: ["round", "rect", "ellipse", "diamond", "triangle", "hexagon", "parallelogram", "note", "text"] },
    { title: "泳道", shapes: ["swimlane", "swimlaneV"] },
    { title: "流程图", shapes: ["terminator", "rect", "diamond", "parallelogram", "document", "cylinder", "hexagon"] },
    { title: "类图", shapes: ["class", "note"] },
    { title: "时序图", shapes: ["actor", "lifeline", "note"] },
  ];
  const ICON_BOX: Partial<Record<Shape, [number, number, number, number]>> = { actor: [33, 6, 30, 106], lifeline: [18, 8, 60, 82], swimlane: [6, 16, 84, 64], swimlaneV: [14, 6, 68, 84], class: [14, 12, 68, 72], triangle: [14, 14, 68, 68], note: [16, 12, 64, 72] };
  const shapeIcon = (id: Shape) => { const [x, y, w, h] = ICON_BOX[id] ?? [10, 22, 76, 52]; return <svg viewBox="0 0 96 96" className="size-6" fill="none"><ShapeOutline n={{ id: "i", x, y, w, h, shape: id, text: "" }} theme={{ ...THEMES[0], radius: 4, strokeWidth: 6 }} fill="none" stroke="currentColor" />{id === "text" && <text x="48" y="66" textAnchor="middle" fontSize="52" fill="currentColor">T</text>}</svg>; };
  const filteredGroups = libraryGroups.map((g) => ({ ...g, shapes: g.shapes.filter((id) => !libQuery.trim() || SHAPES.find((x) => x.id === id)!.label.includes(libQuery.trim())) })).filter((g) => g.shapes.length);
  // Floating style toolbar anchored above the selection (Feishu: shape ▾ / 填充 ▾ / 边框 ▾ / 字色 ▾ / 字号 ▾ / 更多).
  const anchorBox = selectedNodes.length ? bounds(selectedNodes) : selectedEdges.length ? (() => { const e = selectedEdges[0]; const a = graph.nodes.find((n) => n.id === e.from), t = graph.nodes.find((n) => n.id === e.to); if (!a || !t) return null; const m = edgePath(e, a, t).mid; return { x: m.x, y: m.y, w: 0, h: 0 }; })() : null;
  const barPos = anchorBox ? { left: (anchorBox.x + anchorBox.w / 2 - view.x) * view.zoom, top: Math.max(8, (anchorBox.y - view.y) * view.zoom - 16 * view.zoom - 58) } : null;

  return createPortal(<div className="fixed inset-0 z-[80] select-none bg-surface" data-flow-editor onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
    {/* 画布 */}
    <div ref={svgWrap} className="absolute inset-0 overflow-hidden" style={{ left: !readOnly && library ? 260 : 0, background: theme.canvas, backgroundImage: `radial-gradient(${theme.id === "dark" ? "#3A404D" : "#D0D3D6"} 1px, transparent 1px)`, backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`, backgroundPosition: `${-view.x * view.zoom}px ${-view.y * view.zoom}px`, cursor: tool !== "select" ? "crosshair" : drag?.kind === "pan" ? "grabbing" : hand ? "grab" : "default" }}
      onWheel={(e) => { if (e.ctrlKey || e.metaKey) { const p = toWorld(e.clientX, e.clientY); const zoom = Math.min(3, Math.max(0.2, view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); setView({ zoom, x: p.x - (p.x - view.x) * (view.zoom / zoom), y: p.y - (p.y - view.y) * (view.zoom / zoom) }); } else setView((v) => ({ ...v, x: v.x + e.deltaX / v.zoom, y: v.y + e.deltaY / v.zoom })); }}>
      <FlowSvg graph={graph} width="100%" height="100%" viewBox={viewBox} selected={selected} editing={editing?.kind === "node" ? editing.id : null} idPrefix="fce" transparent
        onCanvasDown={(e) => {
          if (e.target !== e.currentTarget && !(e.target instanceof SVGSVGElement)) return;
          setMenu(null);
          if (tool !== "select" && !readOnly) { addNode(tool, toWorld(e.clientX, e.clientY)); return; }
          finishEdit();
          if (hand || space.current || e.button === 1 || readOnly) { setDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y }); return; }
          // 空白处拖动 = 框选（飞书画板行为）；平移用抓手、空格或中键。
          const p = toWorld(e.clientX, e.clientY);
          const base = e.shiftKey ? new Set(selected) : new Set<string>();
          setSelected(base);
          setDrag({ kind: "marquee", x0: p.x, y0: p.y, x1: p.x, y1: p.y, base });
        }}
        onNodeDown={(e, n) => {
          e.stopPropagation(); setMenu(null);
          if (hand || space.current || e.button === 1) { setDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y }); return; }
          if ((e.target as Element).getAttribute("data-flow-rotate")) {
            if (readOnly) return;
            const p = toWorld(e.clientX, e.clientY), cx = n.x + n.w / 2, cy = n.y + n.h / 2;
            setDrag({ kind: "rotate", id: n.id, cx, cy, a0: (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI, rot0: n.rot ?? 0 });
            return;
          }
          if ((e.target as Element).getAttribute("data-flow-resize")) { if (!readOnly) setDrag({ kind: "resize", id: n.id, startX: e.clientX, startY: e.clientY, w: n.w, h: n.h }); return; }
          const next = e.shiftKey ? new Set(selected).add(n.id) : selected.has(n.id) ? selected : new Set([n.id]);
          setSelected(next);
          // 拖动泳道时带上完全位于泳道内的图形。
          const moving = new Set(next);
          for (const c of graph.nodes) if (next.has(c.id) && isContainer(c.shape)) for (const x of graph.nodes) if (!isContainer(x.shape) && x.x >= c.x && x.y >= c.y && x.x + x.w <= c.x + c.w && x.y + x.h <= c.y + c.h) moving.add(x.id);
          if (!readOnly) setDrag({ kind: "move", ids: [...moving], startX: e.clientX, startY: e.clientY, origin: new Map(graph.nodes.filter((x) => moving.has(x.id)).map((x) => [x.id, { x: x.x, y: x.y }])) });
        }}
        onEdgeDown={(e, edge) => {
          e.stopPropagation(); setMenu(null);
          if ((e.target as Element).getAttribute("data-flow-bend") && !readOnly) {
            const a = graph.nodes.find((n) => n.id === edge.from), t = graph.nodes.find((n) => n.id === edge.to);
            if (a && t) setDrag({ kind: "bend", id: edge.id, isY: midIsY(edge, a, t) });
            return;
          }
          setSelected(e.shiftKey ? new Set(selected).add(edge.id) : new Set([edge.id]));
        }}
        onPortDown={readOnly ? undefined : (e, n, port) => { const p = toWorld(e.clientX, e.clientY); setDrag({ kind: "connect", from: n.id, port, x: p.x, y: p.y }); }}
        onNodeDouble={readOnly ? undefined : (n) => setEditing({ id: n.id, kind: "node", value: n.text })}
        onEdgeDouble={readOnly ? undefined : (edge) => setEditing({ id: edge.id, kind: "edge", value: edge.label ?? "" })}
        guides={guides}
        rotateHandle={!readOnly && selectedNodes.length === 1 && !isContainer(selectedNodes[0].shape) ? selectedNodes[0].id : null}
        bendHandle={!readOnly && selectedEdges.length === 1 && !selectedNodes.length ? selectedEdges[0].id : null}
        peerSel={peers.filter((p) => p.sel?.length).map((p) => ({ color: p.color, ids: p.sel! }))}
        marquee={drag?.kind === "marquee" ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) } : null}
        connectPreview={drag?.kind === "connect" ? (() => { const n = graph.nodes.find((x) => x.id === drag.from)!; const pt = portPoint(n, drag.port); return { x1: pt.x, y1: pt.y, x2: drag.x, y2: drag.y }; })() : null}
      />
      {editing && (editNode || editEdge) && (() => {
        const anchor = editNode ? { x: editNode.x, y: editNode.y, w: editNode.w, h: editNode.h } : (() => { const e = editEdge!; const a = graph.nodes.find((n) => n.id === e.from)!, t = graph.nodes.find((n) => n.id === e.to)!; const m = edgePath(e, a, t).mid; return { x: m.x - 70, y: m.y - 16, w: 140, h: 32 }; })();
        return <textarea autoFocus value={editing.value} placeholder="输入文本" onChange={(e) => setEditing({ ...editing, value: e.target.value })} onBlur={finishEdit} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); finishEdit(); } if (e.key === "Escape") setEditing(null); }}
          className="absolute select-text resize-none rounded border-2 border-primary bg-surface p-1 text-center text-[14px] outline-none" style={{ left: (anchor.x - view.x) * view.zoom, top: (anchor.y - view.y) * view.zoom, width: anchor.w * view.zoom, height: Math.max(32, anchor.h * view.zoom) }} data-flow-text-editor />;
      })()}
      {!graph.nodes.length && !readOnly && <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="pointer-events-auto w-[560px] rounded-xl border border-[#DEE0E3] bg-surface p-4 shadow-[0_4px_16px_rgba(31,35,41,0.08)] dark:border-border" onPointerDown={(e) => e.stopPropagation()} data-flow-template-picker>
          <div className="mb-3 text-[14px] font-medium">从模板创建</div>
          <div className="grid grid-cols-5 gap-2">{FLOW_TEMPLATES.map((t) => <button key={t.id} type="button" onClick={() => applyTemplate(t)} className="rounded-lg border border-[#DEE0E3] p-2 text-left hover:border-primary dark:border-border" data-flow-template={t.id}><div className="text-[13px] font-medium">{t.label}</div><div className="mt-1 text-[11px] leading-4 text-subtle">{t.desc}</div></button>)}</div>
          <div className="mt-3 text-[12px] text-subtle">也可以从左侧图形库选择图形后点击画布放置，或在右上角使用「AI 生成」「导入 draw.io」，支持直接粘贴 draw.io 内容。</div>
        </div>
      </div>}
      {/* 协作者指针 */}
      {peers.filter((p) => typeof p.x === "number" && typeof p.y === "number").map((p) => <div key={p.id} className="pointer-events-none absolute z-10 transition-[left,top] duration-100" style={{ left: (p.x! - view.x) * view.zoom, top: (p.y! - view.y) * view.zoom }} data-flow-peer-cursor={p.name}>
        <svg width="16" height="18" viewBox="0 0 16 18"><path d="M1,1 L15,8 L8,10 L5,17 Z" fill={p.color} stroke="#FFFFFF" strokeWidth="1.2" /></svg>
        <span className="ml-3 block whitespace-nowrap rounded px-1.5 py-0.5 text-[12px] text-white" style={{ background: p.color }}>{p.name}</span>
      </div>)}
      {/* 选中对象的浮动样式栏 */}
      {!readOnly && barPos && !drag && !editing && <div className={cn(floatBar, "absolute z-20 -translate-x-1/2")} style={barPos} onPointerDown={(e) => e.stopPropagation()} data-flow-style-bar>
        {selectedNodes.length > 0 && <>
          <div className="relative"><button type="button" className={barBtn} title="图形" onClick={() => setMenu(menu === "shape" ? null : "shape")}>{shapeIcon(selectedNodes[0].shape)}<ChevronDown size={12} /></button>
            {menu === "shape" && <div className={cn(pop, "left-0 grid w-[208px] grid-cols-5 gap-1 p-2")}>{SHAPES.map((s) => <button key={s.id} type="button" title={s.label} onClick={() => { patchNodes({ shape: s.id }); setMenu(null); }} className={cn("grid size-9 place-items-center rounded-md hover:bg-hover", selectedNodes[0].shape === s.id && "bg-[#E1EAFF] text-primary")}>{shapeIcon(s.id)}</button>)}</div>}
          </div>
          <div className="relative"><button type="button" className={barBtn} title="填充" onClick={() => setMenu(menu === "fill" ? null : "fill")}><span className="size-4 rounded-full border border-[#BBBFC4]" style={{ background: selectedNodes[0].fill ?? theme.fill }} /><ChevronDown size={12} /></button>
            {menu === "fill" && <div className={cn(pop, "left-0 w-[188px] p-2")}><div className="mb-1 text-[12px] text-subtle">填充</div><div className="grid grid-cols-8 gap-1">{PALETTE.map((p) => { const [fill] = p.split("/"); return <button key={p} type="button" onClick={() => { patchNodes({ fill }); setMenu(null); }} className="size-[18px] rounded-full border border-[#BBBFC4]" style={{ background: fill }} title={fill} />; })}</div><button type="button" onClick={() => { patchNodes({ fill: undefined }); setMenu(null); }} className="mt-2 h-7 w-full rounded-md border text-[12px] hover:bg-hover">跟随风格</button></div>}
          </div>
          <div className="relative"><button type="button" className={barBtn} title="边框" onClick={() => setMenu(menu === "stroke" ? null : "stroke")}><span className="size-4 rounded-full border-[3px]" style={{ borderColor: selectedNodes[0].stroke ?? theme.stroke }} /><ChevronDown size={12} /></button>
            {menu === "stroke" && <div className={cn(pop, "left-0 w-[188px] p-2")}><div className="mb-1 text-[12px] text-subtle">边框</div><div className="grid grid-cols-8 gap-1">{PALETTE.map((p) => { const stroke = p.split("/")[1]; return <button key={p} type="button" onClick={() => { patchNodes({ stroke }); setMenu(null); }} className="size-[18px] rounded-full border-[3px] bg-white" style={{ borderColor: stroke }} title={stroke} />; })}</div><button type="button" onClick={() => { patchNodes({ stroke: undefined }); setMenu(null); }} className="mt-2 h-7 w-full rounded-md border text-[12px] hover:bg-hover">跟随风格</button></div>}
          </div>
          <span className="mx-0.5 h-5 w-px bg-[#DEE0E3]" />
          <div className="relative"><button type="button" className={barBtn} title="文字颜色" onClick={() => setMenu(menu === "color" ? null : "color")}><span className="grid size-[18px] place-items-center rounded-[3px] bg-[#FFE928] text-[12px] font-medium" style={{ color: selectedNodes[0].color ?? theme.text }}>A</span><ChevronDown size={12} /></button>
            {menu === "color" && <div className={cn(pop, "left-0 w-[188px] p-2")}><div className="grid grid-cols-8 gap-1">{["#1F2329", "#8F959E", "#D83931", "#DE7802", "#DC9B04", "#2EA121", "#245BDB", "#6425D0"].map((c) => <button key={c} type="button" onClick={() => { patchNodes({ color: c }); setMenu(null); }} className="grid size-[18px] place-items-center rounded border text-[11px] font-medium" style={{ color: c }}>A</button>)}</div></div>}
          </div>
          <select value={selectedNodes[0].size ?? 14} onChange={(e) => patchNodes({ size: Number(e.target.value) })} className="h-8 rounded-md border bg-surface px-1 text-[13px]" title="字号">{[12, 14, 16, 18, 20, 24, 28, 32].map((v) => <option key={v} value={v}>{v}</option>)}</select>
          <div className="relative"><button type="button" className={barBtn} title="对齐" onClick={() => setMenu(menu === "align" ? null : "align")} data-flow-align-btn>{selectedNodes.length > 1 ? <AlignStartVertical size={15} /> : selectedNodes[0].align === "left" ? <AlignLeft size={15} /> : selectedNodes[0].align === "right" ? <AlignRight size={15} /> : <AlignCenter size={15} />}<ChevronDown size={12} /></button>
            {menu === "align" && <div className={cn(pop, "left-0 w-[208px] p-2")} data-flow-align-menu>
              <div className="mb-1 text-[12px] text-subtle">文字对齐</div>
              <div className="flex gap-1">{([["left", AlignLeft, "左对齐"], ["center", AlignCenter, "居中"], ["right", AlignRight, "右对齐"]] as const).map(([k, Icon, l]) => <button key={k} type="button" title={l} onClick={() => patchNodes({ align: k === "center" ? undefined : k })} className={cn(tb, (selectedNodes[0].align ?? "center") === k && "bg-[#E1EAFF] text-primary")}><Icon size={15} /></button>)}</div>
              {selectedNodes.length > 1 && <>
                <div className="mb-1 mt-2 text-[12px] text-subtle">图形对齐</div>
                <div className="grid grid-cols-6 gap-1">{([["left", AlignStartVertical, "左对齐"], ["hcenter", AlignCenterVertical, "水平居中"], ["right", AlignEndVertical, "右对齐"], ["top", AlignStartHorizontal, "顶端对齐"], ["vcenter", AlignCenterHorizontal, "垂直居中"], ["bottom", AlignEndHorizontal, "底端对齐"]] as const).map(([k, Icon, l]) => <button key={k} type="button" title={l} onClick={() => alignNodes(k)} className={tb} data-flow-align={k}><Icon size={15} /></button>)}</div>
                <div className="mt-1 flex gap-1"><button type="button" title="水平等距分布" disabled={selectedNodes.length < 3} onClick={() => distribute("x")} className={tb} data-flow-distribute="x"><AlignHorizontalSpaceAround size={15} /></button><button type="button" title="垂直等距分布" disabled={selectedNodes.length < 3} onClick={() => distribute("y")} className={tb} data-flow-distribute="y"><AlignVerticalSpaceAround size={15} /></button></div>
              </>}
            </div>}
          </div>
        </>}
        {selectedEdges.length > 0 && <>
          {([["orthogonal", "折线"], ["straight", "直线"], ["curve", "曲线"]] as [EdgeKind, string][]).map(([k, l]) => <button key={k} type="button" onClick={() => patchEdges({ kind: k, fromPort: undefined, toPort: undefined, mid: undefined })} className={cn(barBtn, (selectedEdges[0].kind ?? "orthogonal") === k && "bg-[#E1EAFF] text-primary")}>{l}</button>)}
          <button type="button" onClick={() => patchEdges({ dashed: !selectedEdges[0].dashed })} className={cn(barBtn, selectedEdges[0].dashed && "bg-[#E1EAFF] text-primary")}>虚线</button>
          <button type="button" onClick={() => patchEdges({ arrow: selectedEdges[0].arrow === "none" ? undefined : selectedEdges[0].arrow === "both" ? "none" : "both" })} className={barBtn}>箭头：{selectedEdges[0].arrow === "none" ? "无" : selectedEdges[0].arrow === "both" ? "双向" : "单向"}</button>
          <button type="button" onClick={() => setEditing({ id: selectedEdges[0].id, kind: "edge", value: selectedEdges[0].label ?? "" })} className={barBtn}>文字</button>
        </>}
        <span className="mx-0.5 h-5 w-px bg-[#DEE0E3]" />
        {onComment && selectedNodes.length > 0 && <button type="button" className={tb} title="评论" onClick={() => { const n = selectedNodes[0]; finishEdit(); onComment(n.text.split("\n")[0] || SHAPES.find((x) => x.id === n.shape)?.label || "图形"); onClose(); }} data-flow-comment><MessageSquare size={15} /></button>}
        <div className="relative"><button type="button" className={tb} title="更多" onClick={() => setMenu(menu === "more" ? null : "more")} data-flow-more-btn><MoreHorizontal size={16} /></button>
          {menu === "more" && <div className={cn(pop, "right-0 w-44")} data-flow-more-menu>
            {selectedNodes.length > 0 && <>
              <button type="button" className={menuItem} onClick={() => { const c = clipOfSelection(); if (c) pasteClip(c, 20); setMenu(null); }}><Copy size={14} />创建副本<span className="ml-auto text-[12px] text-subtle">⌘D</span></button>
              <button type="button" className={menuItem} onClick={() => { layer("front"); setMenu(null); }}><ArrowUpToLine size={14} />置于顶层</button>
              <button type="button" className={menuItem} onClick={() => { layer("back"); setMenu(null); }}><ArrowDownToLine size={14} />置于底层</button>
              <button type="button" className={menuItem} onClick={() => { commit({ ...graph, nodes: graph.nodes.map((n) => (selected.has(n.id) ? { ...n, rot: ((n.rot ?? 0) + 90) % 360 || undefined } : n)) }); setMenu(null); }} data-flow-rotate90><RotateCw size={14} />旋转 90°</button>
              {selectedNodes.some((n) => n.rot) && <button type="button" className={menuItem} onClick={() => { commit({ ...graph, nodes: graph.nodes.map((n) => (selected.has(n.id) ? { ...n, rot: undefined } : n)) }); setMenu(null); }}><RotateCcw size={14} />取消旋转</button>}
              <span className="my-1 block h-px bg-[#DEE0E3]" />
            </>}
            <button type="button" className={cn(menuItem, "text-destructive")} onClick={() => { removeSelected(); setMenu(null); }}><Trash2 size={14} />删除<span className="ml-auto text-[12px] text-subtle">Del</span></button>
          </div>}
        </div>
      </div>}
    </div>

    {/* 左侧：图形库面板 + 竖向工具条（飞书画板布局） */}
    {!readOnly && library && <aside className="absolute bottom-0 left-0 top-0 z-10 flex w-[260px] flex-col border-r border-[#DEE0E3] bg-surface dark:border-border" aria-label="图形库" data-flow-library>
      <div className="flex h-12 shrink-0 items-center gap-2 px-4"><span className="text-[14px] font-medium">图形库</span><button type="button" title="收起" onClick={() => setLibrary(false)} className="ml-auto grid size-7 place-items-center rounded text-subtle hover:bg-hover"><ChevronLeft size={16} /></button></div>
      <label className="mx-4 flex h-8 items-center gap-2 rounded-md border px-2 text-subtle focus-within:border-primary"><Search size={14} /><input value={libQuery} onChange={(e) => setLibQuery(e.target.value)} placeholder="搜索" className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none" /></label>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {filteredGroups.map((g) => <section key={g.title} className="mt-4"><div className="mb-2 flex items-center gap-1 text-[13px] text-[#646A73]"><ChevronDown size={12} />{g.title}</div><div className="grid grid-cols-5 gap-1">{g.shapes.map((id, i) => { const spec = SHAPES.find((s) => s.id === id)!; return <button key={`${id}${i}`} type="button" title={`${spec.label}（点击后在画布上放置，双击直接添加）`} onClick={() => setTool(id)} onDoubleClick={() => addNode(id)} className={cn("grid size-10 place-items-center rounded-md text-[#1F2329] hover:bg-hover dark:text-foreground", tool === id && "bg-[#E1EAFF] text-primary")} data-flow-shape={id}>{shapeIcon(id)}</button>; })}</div></section>)}
        {!libQuery.trim() && <section className="mt-4"><div className="mb-2 flex items-center gap-1 text-[13px] text-[#646A73]"><ChevronDown size={12} />直线</div>
          <div className="grid grid-cols-5 gap-1">{([["orthogonal", "折线", "M10,78 H48 V18 H86"], ["straight", "直线", "M10,86 L86,10"], ["curve", "曲线", "M10,80 C40,80 56,16 86,16"]] as const).map(([k, l, d]) => <button key={k} type="button" title={`新连线默认使用${l}`} onClick={() => setEdgeKind(k)} className={cn("grid size-10 place-items-center rounded-md text-[#1F2329] hover:bg-hover dark:text-foreground", edgeKind === k && "bg-[#E1EAFF] text-primary")} data-flow-edge-kind={k}><svg viewBox="0 0 96 96" className="size-6" fill="none" stroke="currentColor" strokeWidth={6}><path d={d} /></svg></button>)}</div>
          <p className="mt-1 text-[12px] leading-5 text-subtle">选中图形后，从四周的蓝色圆点拖到另一个图形即可连线。</p>
        </section>}
      </div>
    </aside>}
    {!readOnly && <aside className="absolute top-1/2 z-10 flex -translate-y-1/2 flex-col gap-0.5 rounded-xl border border-[#DEE0E3] bg-surface p-1.5 shadow-[0_4px_16px_rgba(31,35,41,0.08)] dark:border-border" style={{ left: library ? 272 : 12 }} aria-label="工具">
      <button type="button" className={cn(railBtn, library && "bg-[#E1EAFF]")} title="图形库" onClick={() => setLibrary(!library)} data-flow-library-toggle><Shapes size={18} className="text-[#3370FF]" /></button>
      <span className="mx-1 my-0.5 h-px bg-[#DEE0E3]" />
      <button type="button" className={cn(railBtn, tool === "select" && !hand && "bg-[#E1EAFF] text-primary")} title="选择" onClick={() => { setTool("select"); setHand(false); }} data-flow-select-tool><MousePointer2 size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "round" && "bg-[#E1EAFF] text-primary")} title="图形（点击画布放置）" onClick={() => setTool("round")}><Square size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "text" && "bg-[#E1EAFF] text-primary")} title="文本" onClick={() => setTool("text")}><Type size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "diamond" && "bg-[#E1EAFF] text-primary")} title="判断" onClick={() => setTool("diamond")}><Diamond size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "note" && "bg-[#E1EAFF] text-primary")} title="便签" onClick={() => setTool("note")}><svg viewBox="0 0 96 96" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={7}><path d="M14,12 H66 L82,28 V84 H14 Z M66,12 V28 H82" /></svg></button>
    </aside>}

    {/* 左上：返回 */}
    <button type="button" onClick={() => { finishEdit(); onClose(); }} className={cn(floatBar, "absolute top-3 z-20 h-10 px-3 text-[14px]")} style={{ left: !readOnly && library ? 272 : 12 }} data-flow-done><ChevronLeft size={16} />流程图</button>

    {/* 右上：风格 / 自动排版 / AI 生成 / 导入 / 导出 */}
    <div className={cn(floatBar, "absolute right-3 top-3 z-20")}>
      {!readOnly && <>
        <div className="relative"><button type="button" className={barBtn} onClick={() => setMenu(menu === "template" ? null : "template")} data-flow-template-btn><LayoutTemplate size={15} />模板</button>
          {menu === "template" && <div className={cn(pop, "right-0 w-60")}>{FLOW_TEMPLATES.map((t) => <button key={t.id} type="button" className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-hover" onClick={() => applyTemplate(t)}><span>{t.label}</span><span className="text-[12px] text-subtle">{t.desc}{graph.nodes.length ? "（追加到右侧）" : ""}</span></button>)}</div>}
        </div>
        <div className="relative"><button type="button" className={barBtn} onClick={() => setMenu(menu === "theme" ? null : "theme")} data-flow-theme-btn><Palette size={15} />风格</button>
          {menu === "theme" && <div className={cn(pop, "right-0 grid w-[300px] grid-cols-3 gap-1.5 p-2")}>{THEMES.map((t) => <button key={t.id} type="button" onClick={() => { commit({ ...graph, theme: t.id }); setMenu(null); }} className={cn("rounded-md border p-1.5 text-center text-[12px] hover:border-primary", graph.theme === t.id && "border-primary text-primary")} data-flow-theme={t.id}><span className="mb-1 block h-8 rounded" style={{ background: t.canvas, border: `1px solid #DEE0E3` }}><span className="mx-auto mt-2 block h-4 w-10" style={{ background: t.palette ? t.palette[0].split("/")[0] : t.fill, border: `${t.strokeWidth}px solid ${t.palette ? t.palette[0].split("/")[1] : t.stroke}`, borderRadius: t.radius / 2 }} /></span>{t.label}</button>)}</div>}
        </div>
        <button type="button" className={barBtn} onClick={() => { const next = autoLayout(graph); commit(next); requestAnimationFrame(() => fit(next)); }} title="按连线关系自动排版"><Spline size={15} />自动排版</button>
        <div className="relative"><button type="button" className={cn(barBtn, !ai && "opacity-60")} onClick={() => (ai ? setMenu(menu === "ai" ? null : "ai") : openAISettings())} title={ai ? "用 AI 生成流程图" : "请先在 AI 设置中配置 API Key"} data-flow-ai-btn><Sparkles size={15} className="text-primary" />AI 生成</button>
          {menu === "ai" && ai && <div className={cn(pop, "right-0 w-[360px] p-3")}>
            <textarea autoFocus value={aiText} onChange={(e) => setAiText(e.target.value)} rows={4} maxLength={1000} placeholder="描述流程，例如：用户注册流程，包含填写信息、校验手机号、校验失败重试、创建账号、发送欢迎邮件" className="w-full select-text resize-none rounded-md border p-2 text-[13px] outline-none focus:border-primary" data-flow-ai-input />
            <div className="mt-2 flex items-center gap-2"><span className="text-[12px] text-subtle">{graph.nodes.length ? "结果将追加到画布右侧" : "结果会自动排版"}</span><button type="button" disabled={busy || !aiText.trim()} onClick={() => void runAI()} className="ml-auto flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[12px] text-white disabled:opacity-40">{busy && <Loader2 size={12} className="animate-spin" />}生成</button></div>
          </div>}
        </div>
        <button type="button" className={barBtn} onClick={() => fileRef.current?.click()} data-flow-import><FileUp size={15} />导入 draw.io</button>
        <input ref={fileRef} type="file" accept=".drawio,.xml,.dio,application/xml,text/xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importDrawio(f); }} data-flow-import-input />
      </>}
      <div className="relative"><button type="button" className={barBtn} onClick={() => setMenu(menu === "export" ? null : "export")}><Download size={15} />导出</button>
        {menu === "export" && <div className={cn(pop, "right-0 w-40")}>{([["png", "图片（PNG）"], ["svg", "矢量图（SVG）"], ["drawio", "draw.io 文件"]] as const).map(([k, l]) => <button key={k} type="button" className="flex h-8 w-full items-center rounded-md px-2 hover:bg-hover" onClick={() => void exportAs(k)}>{l}</button>)}</div>}
      </div>
    </div>
    {notice && <div role={notice.ok ? "status" : "alert"} className={cn("absolute left-1/2 top-16 z-20 max-w-[520px] -translate-x-1/2 rounded-md border bg-surface px-3 py-1.5 text-[12px] shadow", notice.ok ? "text-[#1F2329]" : "text-destructive")}>{notice.text}<button type="button" className="ml-2 text-subtle" onClick={() => setNotice(null)}>×</button></div>}

    {/* 右下：撤销重做、缩放 */}
    <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2">
      {!readOnly && <div className={floatBar}><button type="button" className={railBtn} title="撤销" disabled={!undo.length} onClick={doUndo}><Undo2 size={16} /></button><button type="button" className={railBtn} title="重做" disabled={!redo.length} onClick={doRedo}><Redo2 size={16} /></button></div>}
      <div className={floatBar}>
        <button type="button" className={cn(railBtn, hand && "bg-[#E1EAFF] text-primary")} title="抓手（拖动画布，也可按住空格）" onClick={() => setHand(!hand)} data-flow-hand><Hand size={16} /></button>
        <span className="mx-0.5 h-5 w-px bg-[#DEE0E3]" />
        <button type="button" className={railBtn} title="缩小" onClick={() => setView((v) => ({ ...v, zoom: Math.max(0.2, v.zoom / 1.2) }))}><Minus size={16} /></button>
        <button type="button" className="h-8 w-12 rounded-md text-center text-[13px] hover:bg-hover" title="适应画布" onClick={() => fit()} data-flow-fit>{Math.round(view.zoom * 100)}%</button>
        <button type="button" className={railBtn} title="放大" onClick={() => setView((v) => ({ ...v, zoom: Math.min(3, v.zoom * 1.2) }))}><Plus size={16} /></button>
      </div>
    </div>
  </div>, document.body);
}

/** Place an imported/AI graph to the right of the existing one with fresh IDs. */
export function appendGraph(base: FlowGraph, add: FlowGraph): FlowGraph {
  const b = bounds(base.nodes), a = bounds(add.nodes);
  const map = new Map(add.nodes.map((n) => [n.id, newFlowId("n")]));
  const dx = b.x + b.w + 120 - a.x, dy = b.y - a.y;
  return {
    ...base,
    nodes: [...base.nodes, ...add.nodes.map((n) => ({ ...n, id: map.get(n.id)!, x: n.x + dx, y: n.y + dy }))],
    edges: [...base.edges, ...add.edges.map((e) => ({ ...e, id: newFlowId("e"), from: map.get(e.from)!, to: map.get(e.to)! }))],
  };
}

/** Standalone SVG markup for export (theme colours inlined). */
export function svgMarkup(graph: FlowGraph): string {
  const holder = document.createElement("div");
  // Render synchronously via React DOM server is unavailable here; serialize the live preview instead.
  const live = document.querySelector<SVGSVGElement>("[data-flow-editor] [data-flow-svg]");
  if (!live) return "";
  const clone = live.cloneNode(true) as SVGSVGElement;
  const b = bounds(graph.nodes);
  clone.setAttribute("viewBox", `${b.x - 40} ${b.y - 40} ${b.w + 80} ${b.h + 80}`);
  clone.setAttribute("width", String(b.w + 80));
  clone.setAttribute("height", String(b.h + 80));
  clone.querySelectorAll("[data-flow-port],[data-flow-resize]").forEach((el) => el.remove());
  clone.querySelectorAll("rect[stroke-dasharray='4 3']").forEach((el) => el.remove());
  holder.appendChild(clone);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${holder.innerHTML}`;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlignCenter, AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceAround, AlignLeft, AlignRight, AlignStartHorizontal, AlignStartVertical, AlignVerticalSpaceAround, ArrowDownToLine, ArrowUpToLine, Brush, ChevronDown, ChevronLeft, Copy, Diamond, Download, Eraser, FileUp, Hand, ImageIcon, LayoutTemplate, ListTree, Loader2, Maximize2, MessageSquare, Minus, MoreHorizontal, Pencil, RotateCcw, RotateCw, MousePointer2, Palette, Plus, Redo2, Search, Shapes, Sparkles, Spline, Square, Trash2, Type, Undo2, Workflow, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { aiErrorText, openAISettings, type AIMessage } from "@/lib/ai";
import { autoLayout, boundedFlowOffset, bounds, flowBounds, flowIntentWrites, flowWrites, isContainer, moveFlowSelection, textArea, edgePath, midIsY, portPoint, measureLabel, newFlowId, normalizeEdge, normalizeNode, normalizeStroke, SHAPES, themeOf, THEMES, type EdgeKind, type FlowChangeOutcome, type FlowEdge, type FlowGraph, type FlowNode, type FlowStroke, type FlowTheme, type Port, type Shape } from "./model";
import { DrawioError, parseDrawio, toDrawio } from "./drawio";
import { flowchartPrompt, parseFlowchartAnswer } from "./ai";
import { FLOW_TEMPLATES, type FlowTemplate } from "./templates";
import { fitInsertedImage, pinchViewport, placeSelectionToolbar, resizeViewportCenter, type FlowPoint, type FlowViewport } from "./viewport";
import { describeUnappliedFlows, type UnappliedFlow } from "./recovery";
import { appliedFlowHistory, type FlowHistory } from "./history";
import { MindMapSvg } from "./mind-map-svg";
import { layoutMindTopics, type MindTopic } from "./mindmap";
import { inkHitByEraser, inkPointBounds, scaleInk } from "./inkGeometry";
import { copyClipboardAssetsWithRetry, planClipboardAssets } from "../clipboardAssets";
import type { ClipBlock } from "../model";

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

export function ShapeOutline({ n, theme, fill, stroke, fileUrl }: { n: FlowNode; theme: FlowTheme; fill: string; stroke: string; fileUrl?: (id: number) => string }) {
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
    case "image": return n.fileId && fileUrl
      ? <g><rect x={x} y={y} width={w} height={h} fill="transparent" stroke="none" /><image href={fileUrl(n.fileId)} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid meet" data-flow-image={n.fileId} /></g>
      : <g><rect x={x} y={y} width={w} height={h} rx={4} fill="#F5F6F7" stroke="#BBBFC4" strokeDasharray="5 4" /><path d={`M${x + w / 2 - 14},${y + h / 2 + 10} l9,-12 l7,8 l5,-5 l7,9 z`} fill="#BBBFC4" /></g>;
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
  if (!n.text || n.shape === "image") return null;
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

export function FlowSvg({ graph, width, height, viewBox, selected, editing, onNodeDown, onEdgeDown, onStrokeDown, onStrokeResize, resizeStroke, erasing, draftStroke, mindSelected, mindEditing, mindCollapsed, onMindFold, onMindAddChild, onMindSelect, onMindEdit, onMindDraft, onMindFinish, onMindCancel, onPortDown, onCanvasDown, onNodeDouble, onEdgeDouble, connectPreview, idPrefix = "fc", transparent, guides, marquee, rotateHandle, bendHandle, peerSel, onWaypointRemove, touchZoom, fileUrl = (id: number) => `/api/files/${id}` }: {
  graph: FlowGraph; width?: number | string; height?: number | string; viewBox?: string;
  selected?: Set<string>; editing?: string | null;
  onNodeDown?: (e: React.PointerEvent, n: FlowNode) => void;
  onEdgeDown?: (e: React.PointerEvent, edge: FlowEdge) => void;
  onStrokeDown?: (e: React.PointerEvent, stroke: FlowStroke) => void;
  onStrokeResize?: (e: React.PointerEvent, stroke: FlowStroke) => void;
  resizeStroke?: string | null;
  erasing?: ReadonlySet<string> | null;
  draftStroke?: FlowStroke | null;
  mindSelected?: string | null;
  mindCollapsed?: ReadonlySet<string>;
  onMindFold?: (id: string) => void;
  onMindAddChild?: (id: string) => void;
  mindEditing?: { id: string; value: string } | null;
  onMindSelect?: (topic: MindTopic) => void;
  onMindEdit?: (topic: MindTopic) => void;
  onMindDraft?: (value: string) => void;
  onMindFinish?: () => void;
  onMindCancel?: () => void;
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
  /** Double-click on a waypoint handle removes it. */
  onWaypointRemove?: (edge: FlowEdge, index: number) => void;
  /** When touch editing, enlarge hit targets in screen pixels without changing their appearance. */
  touchZoom?: number;
  /** URL for image nodes (public share pages use a token path). */
  fileUrl?: (id: number) => string;
}) {
  const theme = themeOf(graph.theme);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const b = flowBounds(graph);
  const vb = viewBox ?? `${b.x - 40} ${b.y - 40} ${Math.max(200, b.w + 80)} ${Math.max(120, b.h + 80)}`;
  const filter = theme.sketch ? `url(#${idPrefix}-sketch)` : theme.shadow ? `url(#${idPrefix}-shadow)` : undefined;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={vb} style={{ background: transparent ? "transparent" : theme.canvas, fontFamily: theme.font }} onPointerDown={onCanvasDown} data-flow-svg>
      <defs>
        <marker id={`${idPrefix}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={theme.edge} /></marker>
        <filter id={`${idPrefix}-sketch`} filterUnits="userSpaceOnUse" x="-20000" y="-20000" width="60000" height="60000"><feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="3" /><feDisplacementMap in="SourceGraphic" scale="2.2" /></filter>
        <filter id={`${idPrefix}-shadow`} x="-10%" y="-10%" width="130%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#1F2329" floodOpacity="0.12" /></filter>
      </defs>
      {[...(graph.strokes ?? []), ...(draftStroke ? [draftStroke] : [])].map((stroke) => {
        const d = stroke.points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ") + (stroke.points.length === 1 ? " l0.01,0.01" : "");
        return <g key={stroke.id} data-flow-stroke={stroke.id} opacity={erasing?.has(stroke.id) ? 0.2 : undefined}>
          <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(touchZoom ? 28 / touchZoom : 16, stroke.width + 12)} strokeLinecap="round" strokeLinejoin="round" onPointerDown={onStrokeDown && stroke !== draftStroke ? (event) => onStrokeDown(event, stroke) : undefined}/>
          {selected?.has(stroke.id) && <path d={d} fill="none" stroke="#3370FF" strokeOpacity={0.35} strokeWidth={stroke.width + 5} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" data-ink-selection/>}
          <path d={d} fill="none" stroke={stroke.color} strokeOpacity={stroke.marker ? 0.35 : undefined} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>
        </g>;
      })}
      {!!graph.mind?.length && <MindMapSvg topics={graph.mind} collapsed={mindCollapsed ?? new Set(graph.mindCollapsed ?? [])} onFold={onMindFold} onAddChild={onMindAddChild} selected={mindSelected} editing={mindEditing} onSelect={onMindSelect} onEdit={onMindEdit} onDraft={onMindDraft} onFinish={onMindFinish} onCancel={onMindCancel}/>}
      {graph.edges.map((e) => {
        const a = byId.get(e.from), t = byId.get(e.to);
        if (!a || !t) return null;
        const { d, mid } = edgePath(e, a, t);
        const color = e.color ?? theme.edge;
        const sel = selected?.has(e.id);
        return <g key={e.id} data-flow-edge={e.id}>
          <path d={d} fill="none" stroke="transparent" strokeWidth={touchZoom ? Math.max(12, 28 / touchZoom) : 12} style={{ cursor: onEdgeDown ? "pointer" : undefined }} onPointerDown={onEdgeDown ? (ev) => onEdgeDown(ev, e) : undefined} onDoubleClick={onEdgeDouble ? () => onEdgeDouble(e) : undefined} />
          <path d={d} fill="none" stroke={sel ? "#3370FF" : color} strokeWidth={sel ? 2.2 : 1.5} strokeDasharray={e.dashed ? "6 4" : undefined} filter={theme.sketch ? filter : undefined} markerEnd={e.arrow === "none" ? undefined : `url(#${idPrefix}-arrow)`} markerStart={e.arrow === "both" ? `url(#${idPrefix}-arrow)` : undefined} pointerEvents="none" />
          {e.label && <g pointerEvents="none"><rect x={mid.x - measureLabel(e.label, 0) / 2 + 10} y={mid.y - 10} width={Math.max(20, measureLabel(e.label, 0) - 20)} height={20} rx={4} fill={theme.canvas} /><text x={mid.x} y={mid.y + 4} textAnchor="middle" fontSize={12} fill={theme.text}>{e.label}</text></g>}
        </g>;
      })}
      {graph.nodes.map((n) => {
        const c = nodeColors(n, theme);
        const sel = selected?.has(n.id);
        const peer = peerSel?.find((p) => p.ids.includes(n.id));
        return <g key={n.id} data-flow-node={n.id} transform={n.rot ? `rotate(${n.rot} ${n.x + n.w / 2} ${n.y + n.h / 2})` : undefined} style={{ cursor: onNodeDown ? "move" : undefined }} onPointerDown={onNodeDown ? (ev) => onNodeDown(ev, n) : undefined} onDoubleClick={onNodeDouble ? () => onNodeDouble(n) : undefined}>
          <g filter={n.shape === "image" ? undefined : filter}><ShapeOutline n={n} theme={theme} fill={c.fill} stroke={c.stroke} fileUrl={fileUrl} /></g>
          {editing !== n.id && <NodeText n={n} fill={c.text} />}
          {sel && <rect x={n.x - 4} y={n.y - 4} width={n.w + 8} height={n.h + 8} rx={4} fill="none" stroke="#3370FF" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />}
          {sel && onPortDown && (["top", "right", "bottom", "left"] as Port[]).map((p) => {
            const o = 16; // 飞书的连接点在图形外侧
            const pt = p === "top" ? [n.x + n.w / 2, n.y - o] : p === "bottom" ? [n.x + n.w / 2, n.y + n.h + o] : p === "left" ? [n.x - o, n.y + n.h / 2] : [n.x + n.w + o, n.y + n.h / 2];
            return <g key={p} style={{ cursor: "crosshair" }} onPointerDown={(ev) => { ev.stopPropagation(); onPortDown(ev, n, p); }} data-flow-port={p}><circle cx={pt[0]} cy={pt[1]} r={touchZoom ? Math.max(5, 14 / touchZoom) : 5} fill="transparent"/><circle cx={pt[0]} cy={pt[1]} r={5} fill="#FFFFFF" stroke="#3370FF" strokeWidth={1.5} pointerEvents="none"/></g>;
          })}
          {sel && onPortDown && <g data-flow-resize={n.id}><rect x={n.x + n.w - (touchZoom ? 14 / touchZoom : 5)} y={n.y + n.h - (touchZoom ? 14 / touchZoom : 5)} width={touchZoom ? 28 / touchZoom : 10} height={touchZoom ? 28 / touchZoom : 10} fill="transparent" style={{ cursor: "nwse-resize" }} data-flow-resize={n.id}/><rect x={n.x + n.w - 5} y={n.y + n.h - 5} width={10} height={10} fill="#3370FF" pointerEvents="none"/></g>}
          {rotateHandle === n.id && onPortDown && <g data-flow-rotate={n.id} style={{ cursor: "grab" }}><circle cx={n.x + n.w + 16} cy={n.y - 16} r={7} fill="#FFFFFF" stroke="#3370FF" strokeWidth={1.5} data-flow-rotate={n.id} /><path d={`M${n.x + n.w + 12.5},${n.y - 17} a3.6,3.6 0 1 1 1.4,3`} fill="none" stroke="#3370FF" strokeWidth={1.3} pointerEvents="none" /></g>}
          {peer && !sel && <rect x={n.x - 4} y={n.y - 4} width={n.w + 8} height={n.h + 8} rx={4} fill="none" stroke={peer.color} strokeWidth={2} pointerEvents="none" data-flow-peer-sel />}
        </g>;
      })}
      {resizeStroke && onStrokeResize && (() => {
        const stroke = graph.strokes?.find((item) => item.id === resizeStroke);
        if (!stroke) return null;
        const box = inkPointBounds(stroke); if (!box.w && !box.h) return null;
        const pad = 6 / (touchZoom ?? 1), cx = box.x + box.w + pad, cy = box.y + box.h + pad, hit = (touchZoom ? 26 / touchZoom : 14);
        return <g data-ink-resize={stroke.id} onPointerDown={(event) => { event.stopPropagation(); onStrokeResize(event, stroke); }} style={{ cursor: "nwse-resize" }}>
          <rect x={box.x - pad} y={box.y - pad} width={box.w + pad * 2} height={box.h + pad * 2} fill="none" stroke="#3370FF" strokeWidth={1.5 / (touchZoom ?? 1)} strokeDasharray="4 3" pointerEvents="none"/>
          <rect x={cx - hit / 2} y={cy - hit / 2} width={hit} height={hit} fill="transparent"/>
          <rect x={cx - 4 / (touchZoom ?? 1)} y={cy - 4 / (touchZoom ?? 1)} width={8 / (touchZoom ?? 1)} height={8 / (touchZoom ?? 1)} fill="#3370FF" stroke="#fff" strokeWidth={1 / (touchZoom ?? 1)} pointerEvents="none"/>
        </g>;
      })()}
      {/* 选中连线的端点与中段手柄画在图形之上，避免被图形遮挡 */}
      {bendHandle && onEdgeDown && (() => {
        const e = graph.edges.find((x) => x.id === bendHandle), a = e && byId.get(e.from), t = e && byId.get(e.to);
        if (!e || !a || !t) return null;
        const { mid, start, end } = edgePath(e, a, t);
        return <g data-flow-edge-handles>
          {([["from", start], ["to", end]] as const).map(([k, p]) => <circle key={k} cx={p.x} cy={p.y} r={5} fill="#3370FF" stroke="#FFFFFF" strokeWidth={1.5} style={{ cursor: "move" }} onPointerDown={(ev) => onEdgeDown(ev, e)} data-flow-end={k} />)}
          {(() => {
            // 拐点：实心为已有拐点（拖动移动、双击删除），空心为可拖出新拐点的位置。
            const chain = [start, ...(e.pts ?? []), end];
            const adds = e.pts?.length || (e.kind ?? "orthogonal") !== "orthogonal"
              ? chain.slice(1).map((p, i) => ({ i, x: (chain[i].x + p.x) / 2, y: (chain[i].y + p.y) / 2 }))
              : [{ i: 0, x: (start.x + mid.x) / 2, y: (start.y + mid.y) / 2 }, { i: 0, x: (mid.x + end.x) / 2, y: (mid.y + end.y) / 2, after: true }];
            return <>
              {adds.map((p, k) => <circle key={`a${k}`} cx={p.x} cy={p.y} r={4} fill="#FFFFFF" fillOpacity={0.9} stroke="#3370FF" strokeWidth={1} strokeDasharray="2 1.5" style={{ cursor: "copy" }} onPointerDown={(ev) => onEdgeDown(ev, e)} data-flow-wpadd={p.i} data-flow-wpafter={"after" in p ? "1" : undefined} />)}
              {e.pts?.map((p, i) => <circle key={`w${i}`} cx={p.x} cy={p.y} r={5} fill="#3370FF" stroke="#FFFFFF" strokeWidth={1.5} style={{ cursor: "move" }} onPointerDown={(ev) => onEdgeDown(ev, e)} onDoubleClick={() => onWaypointRemove?.(e, i)} data-flow-wp={i} />)}
              {!e.pts?.length && (e.kind ?? "orthogonal") === "orthogonal" && <circle cx={mid.x} cy={mid.y} r={5} fill="#FFFFFF" stroke="#3370FF" strokeWidth={1.5} style={{ cursor: midIsY(e, a, t) ? "ns-resize" : "ew-resize" }} onPointerDown={(ev) => onEdgeDown(ev, e)} data-flow-bend={e.id} />}
            </>;
          })()}
        </g>;
      })()}
      {guides?.map((g, i) => <line key={i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="#F54A45" strokeWidth={1} pointerEvents="none" data-flow-guide />)}
      {marquee && <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill="rgba(51,112,255,0.08)" stroke="#3370FF" strokeWidth={1} pointerEvents="none" data-flow-marquee />}
      {connectPreview && <line x1={connectPreview.x1} y1={connectPreview.y1} x2={connectPreview.x2} y2={connectPreview.y2} stroke="#3370FF" strokeWidth={1.5} strokeDasharray="5 4" markerEnd={`url(#${idPrefix}-arrow)`} pointerEvents="none" />}
    </svg>
  );
}

/* ---------------- inline block ---------------- */

/** 文档内的流程图块：预览 + 打开全屏编辑器（对应飞书在文档中打开画板）。 */
export type FlowUpload = (f: File) => Promise<{ id: number; name: string; mime: string }>;
export type FlowAssets = { docId: number; copy?: (sourceDocId: number, fileIds: number[], requestId: string, signal: AbortSignal) => Promise<{ mapping: Record<string, number> }> };

export function FlowchartBlock({ graph, height, readOnly, autoOpen, ai, onChange, peers, onPresence, onComment, upload, assets, canCopy = true }: {
  graph: FlowGraph; height: number; readOnly: boolean; autoOpen?: boolean;
  ai?: (messages: AIMessage[]) => Promise<string>;
  onChange?: (next: FlowGraph, base: FlowGraph) => FlowChangeOutcome;
  peers?: FlowPeer[];
  onPresence?: (p: FlowPresence | null) => void;
  onComment?: (quote: string) => void;
  upload?: FlowUpload;
  assets?: FlowAssets;
  canCopy?: boolean;
}) {
  const [open, setOpen] = useState(!!autoOpen && !readOnly);
  return <div contentEditable={false} className="group/flow relative overflow-hidden rounded-lg border border-transparent transition-colors hover:border-[#DEE0E3] focus-within:border-[#3370FF] dark:hover:border-border" style={{ height }} data-flowchart>
    {graph.nodes.length || graph.strokes?.length || graph.mind?.length ? <FlowSvg graph={graph} width="100%" height="100%" idPrefix="fcp" /> : <div className="grid h-full place-items-center bg-[#F8F9FA] text-[13px] text-subtle dark:bg-hover"><span className="flex items-center gap-1.5"><Workflow size={16} />空白流程图{!readOnly && "，点击「编辑」开始绘制"}</span></div>}
    <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/flow:opacity-100 [@media(hover:none)]:opacity-100">
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(true)} className="flex h-7 items-center gap-1 rounded-md border bg-surface px-2 text-[12px] shadow-sm hover:bg-hover" data-flow-open>{readOnly ? <><Maximize2 size={13} />查看</> : <><Workflow size={13} />编辑</>}</button>
    </div>
    {!!peers?.length && <div className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-surface/90 px-1.5 py-0.5 text-[12px] text-subtle shadow-sm" data-flow-peers>{peers.slice(0, 3).map((p) => <span key={p.id} className="grid size-5 place-items-center rounded-full text-[11px] text-white" style={{ background: p.color }} title={p.name}>{[...p.name][0]}</span>)}正在编辑</div>}
    {open && <FlowchartEditor initial={graph} readOnly={readOnly} ai={ai} onChange={onChange} onClose={() => { onPresence?.(null); setOpen(false); }} peers={peers} onPresence={onPresence} onComment={onComment} upload={upload} assets={assets} canCopy={canCopy} />}
  </div>;
}

/* ---------------- full-screen editor ---------------- */

type Drag =
  | { kind: "move"; ids: string[]; startX: number; startY: number; origin: Map<string, { x: number; y: number }>; strokeOrigin: Map<string, FlowStroke> }
  | { kind: "resize"; id: string; startX: number; startY: number; w: number; h: number }
  | { kind: "ink-resize"; id: string; startX: number; startY: number; stroke: FlowStroke }
  | { kind: "pan"; startX: number; startY: number; vx: number; vy: number }
  | { kind: "connect"; from: string; port: Port; x: number; y: number }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number; base: Set<string> }
  | { kind: "rotate"; id: string; cx: number; cy: number; a0: number; rot0: number }
  | { kind: "bend"; id: string; isY: boolean }
  | { kind: "reconnect"; id: string; end: "from" | "to"; x: number; y: number }
  | { kind: "waypoint"; id: string; index: number };

/** A collaborator inside the same flowchart (from awareness). */
export interface FlowPeer { id: number; name: string; color: string; x?: number; y?: number; sel?: string[] }
export interface FlowPresence { x?: number; y?: number; sel?: string[] }

type FlowClip = { nodes: FlowNode[]; edges: FlowEdge[]; strokes?: FlowStroke[]; source?: { origin: string; docId: number } };
const CLIP_MARK = "jiange-flowchart:";
/** In-app clipboard so copy/paste works between flowchart blocks even without clipboard permission. */
let flowClipboard: FlowClip | null = null;
type Guide = { x1: number; y1: number; x2: number; y2: number };

const PALETTE = ["#E1EAFF/#3370FF", "#D9F5D6/#2EA121", "#FFF1E8/#FF8800", "#FEF8C5/#DC9B04", "#FFE8EF/#E63995", "#F1E8FF/#7B61FF", "#F2F3F5/#8F959E", "#FFFFFF/#1F2329"];
const INK_COLORS = [["#1F2329", "黑色"], ["#D83931", "红色"], ["#DE7802", "橙色"], ["#DC9B04", "黄色"], ["#2EA121", "绿色"], ["#3370FF", "蓝色"], ["#6425D0", "紫色"], ["#8F959E", "灰色"]] as const;
const INK_WIDTHS = [2, 3, 5, 8, 12] as const;
const MARKER_WIDTHS = [8, 12, 16, 20, 24] as const;

export function FlowchartEditor({ initial, readOnly, ai, onChange, onClose, peers = [], onPresence, onComment, upload, assets, canCopy = true }: {
  initial: FlowGraph; readOnly: boolean;
  ai?: (messages: AIMessage[]) => Promise<string>;
  onChange?: (next: FlowGraph, base: FlowGraph) => FlowChangeOutcome;
  onClose: () => void;
  peers?: FlowPeer[];
  onPresence?: (p: FlowPresence | null) => void;
  onComment?: (quote: string) => void;
  upload?: FlowUpload;
  assets?: FlowAssets;
  canCopy?: boolean;
}) {
  const [graph, setGraph] = useState(initial);
  const mindBoard = useRef(!!initial.mind?.length && !initial.nodes.length && !initial.strokes?.length).current;
  const [undo, setUndo] = useState<FlowHistory[]>([]);
  const [redo, setRedo] = useState<FlowHistory[]>([]);
  const [recovery, setRecovery] = useState<UnappliedFlow[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const recoveryRef = useRef<UnappliedFlow[]>([]);
  const recoveryBannerRef = useRef<HTMLDivElement>(null);
  const recoveryDialogRef = useRef<HTMLDivElement>(null);
  const [recoveryBannerHeight, setRecoveryBannerHeight] = useState(0);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (recoveryRef.current.length) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    if (!recoveryOpen || !recoveryDialogRef.current) return;
    const dialog = recoveryDialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setRecoveryOpen(false); return; }
      if (event.key !== "Tab") return;
      const items = [...dialog.querySelectorAll<HTMLElement>("textarea,button:not([disabled])")];
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
        event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus();
      }
    };
    document.addEventListener("keydown", trap, true);
    return () => { document.removeEventListener("keydown", trap, true); if (previous?.isConnected) previous.focus(); };
  }, [recoveryOpen]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mindSelected, setMindSelected] = useState<string | null>(null);
  const [viewFoldOverrides, setViewFoldOverrides] = useState<Record<string, boolean>>({});
  const effectiveCollapsed = new Set(graph.mindCollapsed ?? []);
  if (readOnly) for (const [id, folded] of Object.entries(viewFoldOverrides)) { if (folded) effectiveCollapsed.add(id); else effectiveCollapsed.delete(id); }
  const [mindEditing, setMindEditing] = useState<{ id: string; value: string; base: FlowGraph } | null>(null);
  const mindEditingRef = useRef<typeof mindEditing>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [tool, setTool] = useState<Shape | "select" | "pen" | "eraser">("select");
  const ink = useRef<{ pointerId: number; stroke: FlowStroke } | null>(null);
  const [inkPreview, setInkPreview] = useState<FlowStroke | null>(null);
  const erase = useRef<{ pointerId: number; base: FlowGraph; last: FlowPoint; ids: Set<string>; bounds: Map<string, ReturnType<typeof inkPointBounds>> } | null>(null);
  const [erasePreview, setErasePreview] = useState<Set<string> | null>(null);
  const [penColor, setPenColor] = useState("#1F2329"), [penWidth, setPenWidth] = useState(3);
  const [penKind, setPenKind] = useState<"pen" | "marker">("pen");
  const [markerColor, setMarkerColor] = useState("#FFEE24"), [markerWidth, setMarkerWidth] = useState(20);
  const [editing, setEditing] = useState<{ id: string; kind: "node" | "edge"; value: string } | null>(null);
  const [view, setView] = useState(() => { const b = flowBounds(initial); return { x: b.x - 80, y: b.y - 80, zoom: 1 }; });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<"theme" | "export" | "ai" | "shape" | "fill" | "stroke" | "color" | "align" | "more" | "template" | "pen" | "ink-color" | null>(null);
  useEffect(() => { if (tool !== "pen" && menu === "pen") setMenu(null); if (tool !== "select") setMindSelected(null); }, [tool, menu]);
  useEffect(() => { if (mindSelected && !mindEditing && !layoutMindTopics(graph.mind ?? [], effectiveCollapsed).some((item) => item.topic.id === mindSelected)) setMindSelected(null); }, [graph.mind, graph.mindCollapsed, mindSelected, mindEditing, readOnly, viewFoldOverrides]);
  const [hand, setHand] = useState(false);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [edgeKind, setEdgeKind] = useState<EdgeKind>("orthogonal");
  const space = useRef(false);
  const pasteCount = useRef(0);
  const assetPaste = useRef<AbortController | null>(null);
  const assetRetry = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => () => { assetPaste.current?.abort(); }, []);
  // 协作感知：广播指针位置与选中对象（节流），离开时清空。
  const presence = useRef<{ x?: number; y?: number; t: number }>({ t: 0 });
  const presenceRef = useRef(onPresence);
  presenceRef.current = onPresence;
  const selectedKey = [...selected].sort().join(",");
  const selectedKeyRef = useRef(selectedKey); selectedKeyRef.current = selectedKey;
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
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.innerWidth < 768);
  const [library, setLibrary] = useState(() => !mindBoard && (typeof window === "undefined" || window.innerWidth >= 768));
  const [libQuery, setLibQuery] = useState("");
  const [showStarter, setShowStarter] = useState(true);
  const [aiText, setAiText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const svgWrap = useRef<HTMLDivElement>(null);
  const styleBarRef = useRef<HTMLDivElement>(null);
  const [styleBarSize, setStyleBarSize] = useState({ w: 320, h: 44 });
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const measuredSize = useRef<{ w: number; h: number } | null>(null);
  const gestureActive = useRef(false); gestureActive.current = !!drag || !!inkPreview || !!erasePreview || !!mindEditing;
  const autoFit = useRef(true);
  const pinch = useRef<{ view: FlowViewport; center: FlowPoint; distance: number } | null>(null);
  const suppressTouch = useRef(false);
  const touchPlacement = useRef<{ shape: Shape; pointerId: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const change = () => { setCompact(media.matches); if (media.matches) setLibrary(false); };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  // Remote edits arrive through `initial`; adopt them when not mid-gesture.
  const lastInitial = useRef(initial);
  useEffect(() => { if (initial !== lastInitial.current && !drag && !editing && !inkPreview && !erasePreview && !mindEditing) { lastInitial.current = initial; setGraph(initial); } }, [initial, drag, editing, inkPreview, erasePreview, mindEditing]);
  useEffect(() => {
    const el = svgWrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const next = { w: el.clientWidth, h: el.clientHeight }, before = measuredSize.current;
      if (!next.w || !next.h || before?.w === next.w && before.h === next.h) return;
      measuredSize.current = next;
      if (before && !autoFit.current && !gestureActive.current) setView((current) => resizeViewportCenter(current, before, next));
      setSize(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const submit = (base: FlowGraph, next: FlowGraph): FlowChangeOutcome => {
    const keys = onChange || readOnly ? [] : Object.keys(flowIntentWrites(flowWrites({}, base), base, next).writes);
    const result = readOnly ? { graph, conflicts: ["permission"], applied: false, appliedKeys: [] } : onChange?.(next, base) ?? { graph: next, conflicts: [], applied: keys.length > 0, appliedKeys: keys };
    if (result.conflicts.length) {
      const nextRecovery = [...recoveryRef.current, { before: base, proposed: next, conflicts: result.conflicts }];
      recoveryRef.current = nextRecovery;
      setRecovery(nextRecovery);
    }
    setGraph(result.graph); lastInitial.current = result.graph;
    return result;
  };
  const commit = (next: FlowGraph) => {
    if (readOnly) return;
    const result = submit(graph, next);
    const step = appliedFlowHistory(graph, result.graph, result.appliedKeys);
    if (result.applied && step) { setUndo((u) => [...u.slice(-99), step]); setRedo([]); }
  };
  const commitMind = (base: FlowGraph, next: FlowGraph) => {
    const result = submit(base, next), step = appliedFlowHistory(base, result.graph, result.appliedKeys);
    if (result.applied && step) { setUndo((history) => [...history.slice(-99), step]); setRedo([]); }
    return result;
  };
  const toggleMindFold = (id: string) => {
    const folded = effectiveCollapsed.has(id);
    if (readOnly) { setViewFoldOverrides((current) => ({ ...current, [id]: !folded })); return; }
    const next = new Set(graph.mindCollapsed ?? []); if (folded) next.delete(id); else next.add(id);
    commitMind(graph, { ...graph, mindCollapsed: [...next] });
    setMindSelected(id); setSelected(new Set());
  };
  const startMindEdit = (topic: MindTopic) => {
    if (readOnly) return;
    const edit = { id: topic.id, value: topic.text, base: graph };
    mindEditingRef.current = edit; setMindEditing(edit); setMindSelected(topic.id); setSelected(new Set());
  };
  const finishMindEdit = () => {
    const edit = mindEditingRef.current; if (!edit) return;
    mindEditingRef.current = null; setMindEditing(null);
    const previous = edit.base.mind?.find((topic) => topic.id === edit.id);
    if (!previous || previous.text === edit.value) return;
    commitMind(edit.base, { ...edit.base, mind: edit.base.mind!.map((topic) => topic.id === edit.id ? { ...topic, text: edit.value } : topic) });
  };
  const cancelMindEdit = () => { mindEditingRef.current = null; setMindEditing(null); };
  const addMindMap = () => {
    if (readOnly || (graph.mind?.length ?? 0) + 4 > 500) { setNotice({ ok: false, text: "思维导图节点已达上限。" }); return; }
    const root = newFlowId("m"), x = Math.round(Math.max(-20000, Math.min(20000, view.x + size.w / view.zoom / 2 - 120))), y = Math.round(Math.max(-20000, Math.min(20000, view.y + size.h / view.zoom / 2 - 24)));
    const topics: MindTopic[] = [{ id: root, parent: null, order: 0, text: "", x, y }, ...[0, 1, 2].map((order) => ({ id: newFlowId("m"), parent: root, order, text: "" }))];
    const result = commitMind(graph, { ...graph, mind: [...(graph.mind ?? []), ...topics] });
    if (result.applied && result.graph.mind?.some((topic) => topic.id === root)) { setMindSelected(root); setSelected(new Set()); setTool("select"); setHand(false); setShowStarter(false); }
  };
  const addMindTopic = (sibling: boolean, selectedId = mindSelected) => {
    const parentTopic = graph.mind?.find((topic) => topic.id === selectedId);
    const parent = sibling ? parentTopic?.parent : parentTopic?.id;
    if (readOnly || !parentTopic || !parent) return;
    if ((graph.mind?.length ?? 0) >= 500) { setNotice({ ok: false, text: "思维导图节点已达上限。" }); return; }
    let ancestor = graph.mind?.find((topic) => topic.id === parent), depth = 0;
    while (ancestor?.parent && depth < 33) { depth++; ancestor = graph.mind?.find((topic) => topic.id === ancestor!.parent); }
    if (!ancestor || depth >= 32) { setNotice({ ok: false, text: "思维导图层级已达上限。" }); return; }
    const siblings = graph.mind!.filter((topic) => topic.parent === parent).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const index = siblings.findIndex((topic) => topic.id === parentTopic.id), next = sibling && index >= 0 ? siblings[index + 1] : undefined;
    const order = sibling && next ? (parentTopic.order + next.order) / 2 : Math.max(-1, ...siblings.map((topic) => topic.order)) + 1;
    if (order > 1000000 || (next && (order <= parentTopic.order || order >= next.order))) { setNotice({ ok: false, text: "节点顺序空间不足，请在末尾添加。" }); return; }
    const topic: MindTopic = { id: newFlowId("m"), parent, order, text: "" };
    const result = commitMind(graph, { ...graph, mind: [...graph.mind!, topic], mindCollapsed: (graph.mindCollapsed ?? []).filter((id) => id !== parent) });
    if (result.applied && result.graph.mind?.some((item) => item.id === topic.id)) {
      setMindSelected(topic.id); setSelected(new Set());
      const edit = { id: topic.id, value: topic.text, base: result.graph };
      mindEditingRef.current = edit; setMindEditing(edit);
    }
  };
  const removeMindTopic = () => {
    if (readOnly || !mindSelected || !graph.mind) return;
    const ids = new Set([mindSelected]); let previous = 0;
    while (ids.size !== previous) { previous = ids.size; for (const topic of graph.mind) if (topic.parent && ids.has(topic.parent)) ids.add(topic.id); }
    const result = commitMind(graph, { ...graph, mind: graph.mind.filter((topic) => !ids.has(topic.id)) });
    if (!result.graph.mind?.some((topic) => topic.id === mindSelected)) setMindSelected(null);
  };
  // Latest graph/commit for async work (image upload) that finishes after re-renders.
  const graphRef = useRef(graph); graphRef.current = graph;
  const commitRef = useRef(commit); commitRef.current = commit;
  const editableRef = useRef(!readOnly); editableRef.current = !readOnly;
  const toWorld = (clientX: number, clientY: number) => {
    const r = svgWrap.current!.getBoundingClientRect();
    return { x: view.x + (clientX - r.left) / view.zoom, y: view.y + (clientY - r.top) / view.zoom };
  };
  const startInk = (event: React.PointerEvent) => {
    if (readOnly || event.button !== 0 || (event.pointerType === "touch" && (!event.isPrimary || suppressTouch.current))) return;
    const p = toWorld(event.clientX, event.clientY);
    const point = { x: Math.round(Math.max(-20000, Math.min(20000, p.x))), y: Math.round(Math.max(-20000, Math.min(20000, p.y))) };
    const stroke: FlowStroke = { id: newFlowId("s"), points: [point], color: penKind === "marker" ? markerColor : penColor, width: penKind === "marker" ? markerWidth : penWidth, ...(penKind === "marker" ? { marker: true as const } : {}) };
    ink.current = { pointerId: event.pointerId, stroke }; setInkPreview(stroke); setSelected(new Set()); setShowStarter(false); autoFit.current = false;
    svgWrap.current?.setPointerCapture(event.pointerId);
  };
  const markErased = (state: NonNullable<typeof erase.current>, point: FlowPoint) => {
    const count = state.ids.size;
    for (const stroke of state.base.strokes ?? []) {
      if (state.ids.has(stroke.id)) continue;
      const box = state.bounds.get(stroke.id)!, padding = 12 / view.zoom + stroke.width / 2;
      if (Math.max(state.last.x, point.x) < box.x - padding || Math.min(state.last.x, point.x) > box.x + box.w + padding || Math.max(state.last.y, point.y) < box.y - padding || Math.min(state.last.y, point.y) > box.y + box.h + padding) continue;
      if (inkHitByEraser(stroke, state.last, point, 12 / view.zoom)) state.ids.add(stroke.id);
    }
    state.last = point; if (state.ids.size !== count) setErasePreview(new Set(state.ids));
  };
  const startErase = (event: React.PointerEvent) => {
    if (readOnly || event.button !== 0 || (event.pointerType === "touch" && (!event.isPrimary || suppressTouch.current))) return;
    const point = toWorld(event.clientX, event.clientY);
    const state = { pointerId: event.pointerId, base: graph, last: point, ids: new Set<string>(), bounds: new Map((graph.strokes ?? []).map((stroke) => [stroke.id, inkPointBounds(stroke)])) };
    erase.current = state; setErasePreview(new Set()); setSelected(new Set()); setMenu(null); setShowStarter(false); markErased(state, point);
    svgWrap.current?.setPointerCapture(event.pointerId);
  };
  const fit = (g = graph, viewport = size) => {
    autoFit.current = true;
    const b = flowBounds(readOnly && g === graph ? { ...g, mindCollapsed: [...effectiveCollapsed] } : g);
    // 左侧留出竖向工具条，上下留出浮动栏。
    const padL = compact ? 24 : readOnly ? 40 : 90, padR = compact ? 24 : 40, usableW = Math.max(100, viewport.w - padL - padR), usableH = Math.max(100, viewport.h - (compact ? 56 : 160));
    const zoom = Math.min(mindBoard ? 1 : 1.5, Math.max(0.2, Math.min(usableW / Math.max(1, b.w), usableH / Math.max(1, b.h))));
    const offsetY = compact ? 28 + (usableH - b.h * zoom) / 2 : (viewport.h - b.h * zoom) / 2;
    setView({ zoom, x: b.x - (padL + (usableW - b.w * zoom) / 2) / zoom, y: b.y - offsetY / zoom });
  };
  const addNode = (shape: Shape, at?: { x: number; y: number }) => {
    const spec = SHAPES.find((s) => s.id === shape)!;
    const c = at ?? { x: view.x + size.w / view.zoom / 2, y: view.y + size.h / view.zoom / 2 };
    const node: FlowNode = { id: newFlowId("n"), shape, text: shape === "text" ? "文本" : spec.label.replace(/（.*）/, ""), x: Math.round(c.x - spec.w / 2), y: Math.round(c.y - spec.h / 2), w: spec.w, h: spec.h, z: isContainer(shape) ? Math.min(0, ...graph.nodes.map((n) => n.z ?? 0)) - 1 : Math.max(0, ...graph.nodes.map((n) => n.z ?? 0)) + 1 };
    if (shape === "class") node.text = "ClassName\n+ field: type\n+ method()";
    if (shape === "actor" || shape === "lifeline") node.text = shape === "actor" ? "用户" : "对象";
    commit({ ...graph, nodes: [...graph.nodes, node] });
    setSelected(new Set([node.id])); setTool("select"); setShowStarter(false);
  };
  const removeSelected = () => {
    if (!selected.size) return;
    commit({ ...graph, nodes: graph.nodes.filter((n) => !selected.has(n.id)), edges: graph.edges.filter((e) => !selected.has(e.id) && !selected.has(e.from) && !selected.has(e.to)), ...(graph.strokes ? { strokes: graph.strokes.filter((stroke) => !selected.has(stroke.id)) } : {}) });
    setSelected(new Set());
  };
  const clipOfSelection = (): FlowClip | null => {
    const ids = new Set(graph.nodes.filter((n) => selected.has(n.id)).map((n) => n.id));
    const strokes = (graph.strokes ?? []).filter((stroke) => selected.has(stroke.id));
    if (!ids.size && !strokes.length) return null;
    return { nodes: graph.nodes.filter((n) => ids.has(n.id)), edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)), ...(strokes.length ? { strokes } : {}), ...(assets ? { source: { origin: location.origin, docId: assets.docId } } : {}) };
  };
  const pasteClip = (clip: FlowClip, offset: number) => {
    const map = new Map(clip.nodes.map((n) => [n.id, newFlowId("n")]));
    const delta = boundedFlowOffset(clip.nodes, clip.strokes ?? [], offset, offset);
    const top = Math.max(0, ...graph.nodes.map((n) => n.z ?? 0));
    const nodes = clip.nodes.map((n, i) => ({ ...n, id: map.get(n.id)!, x: n.x + delta.x, y: n.y + delta.y, z: isContainer(n.shape) ? n.z : top + 1 + i }));
    const edges = clip.edges.filter((e) => map.has(e.from) && map.has(e.to)).map((e) => {
      const a = clip.nodes.find((node) => node.id === e.from)!, b = clip.nodes.find((node) => node.id === e.to)!;
      return { ...e, id: newFlowId("e"), from: map.get(e.from)!, to: map.get(e.to)!, ...(e.pts ? { pts: e.pts.map((q) => ({ x: q.x + delta.x, y: q.y + delta.y })) } : {}), ...(e.mid !== undefined ? { mid: e.mid + (midIsY(e, a, b) ? delta.y : delta.x) } : {}) };
    });
    const strokes = (clip.strokes ?? []).map((stroke) => ({ ...stroke, id: newFlowId("s"), points: stroke.points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y })) }));
    commit({ ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges], ...(strokes.length ? { strokes: [...(graph.strokes ?? []), ...strokes] } : {}) });
    setSelected(new Set([...nodes.map((n) => n.id), ...strokes.map((stroke) => stroke.id)]));
  };
  /** Upload an image and place it (Feishu: 插入图片 / 粘贴 / 拖入画板). Max 360px on the long side. */
  const insertImage = async (file: File, at?: { x: number; y: number }) => {
    if (!upload || readOnly) return;
    if (!/^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(file.type)) { setNotice({ ok: false, text: "仅支持 PNG、JPG、GIF、WebP、SVG 图片" }); return; }
    if (file.size > 20 * 1024 * 1024) { setNotice({ ok: false, text: "图片不能超过 20 MB" }); return; }
    setBusy(true); setNotice({ ok: true, text: "正在上传图片…" });
    try {
      const url = URL.createObjectURL(file);
      const imageSize = await new Promise<{ w: number; h: number }>((resolve) => { const img = new Image(); img.onload = () => resolve({ w: img.naturalWidth || 240, h: img.naturalHeight || 160 }); img.onerror = () => resolve({ w: 240, h: 160 }); img.src = url; });
      URL.revokeObjectURL(url);
      const { w, h } = fitInsertedImage(imageSize, size, view.zoom);
      const asset = await upload(file);
      if (!editableRef.current) { setNotice({ ok: false, text: "编辑权限已变化，图片未插入画板。" }); return; }
      const c = at ?? { x: view.x + size.w / view.zoom / 2, y: view.y + size.h / view.zoom / 2 };
      const node: FlowNode = { id: newFlowId("n"), shape: "image", text: "", fileId: asset.id, x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2), w, h, z: Math.max(0, ...graphRef.current.nodes.map((n) => n.z ?? 0)) + 1 };
      const next = { ...graphRef.current, nodes: [...graphRef.current.nodes, node] };
      commitRef.current(next); setSelected(new Set([node.id])); setNotice(null);
    } catch { setNotice({ ok: false, text: "图片上传失败，请重试" }); }
    finally { setBusy(false); }
  };
  const nudge = (dx: number, dy: number) => commit(moveFlowSelection(graph, selected, dx, dy));
  const doUndo = () => {
    const step = undo.at(-1); if (!step) return;
    const result = submit(step.after, step.before);
    const applied = appliedFlowHistory(step.after, result.graph, result.appliedKeys);
    if (result.applied && applied) { setUndo(undo.slice(0, -1)); setRedo([...redo, { before: applied.after, after: applied.before }]); }
    else if (!result.conflicts.length) setUndo(undo.slice(0, -1));
  };
  const doRedo = () => {
    const step = redo.at(-1); if (!step) return;
    const result = submit(step.before, step.after);
    const applied = appliedFlowHistory(step.before, result.graph, result.appliedKeys);
    if (result.applied && applied) { setRedo(redo.slice(0, -1)); setUndo([...undo, applied]); }
    else if (!result.conflicts.length) setRedo(redo.slice(0, -1));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (recoveryOpen || editing || mindEditing || (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) return;
      if (e.key === "Escape") { e.preventDefault(); if (menu) setMenu(null); else if (mindSelected) setMindSelected(null); else if (selected.size) setSelected(new Set()); else requestClose(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) { e.preventDefault(); if (mindSelected) removeMindTopic(); else removeSelected(); }
      const onButton = e.target instanceof HTMLElement && !!e.target.closest("button");
      if (mindSelected && !readOnly && !onButton && e.key === "Tab") { e.preventDefault(); addMindTopic(false); }
      if (mindSelected && !readOnly && !onButton && e.key === "Enter") { e.preventDefault(); addMindTopic(true); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !readOnly) { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(new Set([...graph.nodes.map((n) => n.id), ...(graph.strokes ?? []).map((stroke) => stroke.id)])); }
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
      if (!canCopy) { e.preventDefault(); e.stopPropagation(); setNotice({ ok: false, text: "当前文档不允许复制。" }); return; }
      flowClipboard = c;
      e.clipboardData?.setData("text/plain", CLIP_MARK + JSON.stringify(c));
      e.preventDefault(); e.stopPropagation();
      if (e.type === "cut" && !readOnly) removeSelected();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (inField(e.target) || readOnly) return;
      const pastedImage = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (pastedImage && upload) { e.preventDefault(); e.stopPropagation(); void insertImage(pastedImage); return; }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      e.preventDefault(); e.stopPropagation();
      pasteCount.current += 1;
      if (text.startsWith(CLIP_MARK) || (!text && flowClipboard)) {
        let clip = flowClipboard;
        try {
          if (text) {
            const raw = JSON.parse(text.slice(CLIP_MARK.length)) as FlowClip;
            if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new Error("invalid clip");
            if (raw.strokes !== undefined && (!Array.isArray(raw.strokes) || raw.strokes.length > 1000)) throw new Error("invalid strokes");
            const strokes = (raw.strokes ?? []).map((stroke) => normalizeStroke(stroke));
            if (strokes.some((stroke) => !stroke)) throw new Error("invalid stroke");
            clip = { nodes: raw.nodes.map((n) => normalizeNode(n)).filter((n): n is FlowNode => !!n), edges: raw.edges.map((x) => normalizeEdge(x)).filter((x): x is FlowEdge => !!x), strokes: strokes as FlowStroke[], source: raw.source };
          }
        } catch { setNotice({ ok: false, text: "剪贴板内容无效，未粘贴。" }); return; }
        if (!clip || (!clip.nodes.length && !clip.strokes?.length)) return;
        const block: ClipBlock = { type: "flowchart", props: Object.fromEntries(clip.nodes.map((n) => [`fc.n.${n.id}`, JSON.stringify(n)])), chars: [], source: clip.source };
        const plan = planClipboardAssets([block], location.origin);
        if (!plan.ok) { setNotice({ ok: false, text: plan.message }); return; }
        if (!plan.assets) { pasteClip(clip, 24 * pasteCount.current); return; }
        if (!assets?.copy || assetPaste.current) { setNotice({ ok: false, text: "当前无法安全复制图片，请确认编辑权限并稍后重试。" }); return; }
        const copy = assets.copy, source = clip, offset = 24 * pasteCount.current, snapshot = JSON.stringify(graphRef.current), selection = selectedKeyRef.current;
        const key = JSON.stringify([plan.assets.sourceDocId, plan.assets.fileIds]);
        let requestId = assetRetry.current?.key === key ? assetRetry.current.id : "";
        if (!requestId) {
          try { requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) => v.toString(16).padStart(2, "0")).join(""); }
          catch { setNotice({ ok: false, text: "无法创建安全的粘贴请求。" }); return; }
          assetRetry.current = { key, id: requestId };
        }
        const controller = new AbortController(); assetPaste.current = controller;
        const stillCurrent = () => !controller.signal.aborted && editableRef.current && selectedKeyRef.current === selection && JSON.stringify(graphRef.current) === snapshot;
        setNotice({ ok: true, text: "正在复制图片…" });
        void (async () => {
          try {
            const [mapped] = await copyClipboardAssetsWithRetry(copy, [block], plan.assets!, requestId, assets.docId, controller.signal, stillCurrent);
            if (!stillCurrent()) return;
            const nodes = source.nodes.map((node) => normalizeNode(JSON.parse(mapped.props[`fc.n.${node.id}`]))).filter((node): node is FlowNode => !!node);
            if (nodes.length !== source.nodes.length) throw new Error("invalid nodes");
            pasteClip({ ...source, nodes }, offset); assetRetry.current = null; setNotice(null);
          } catch {
            if (!controller.signal.aborted) setNotice({ ok: false, text: stillCurrent() ? "无法确认图片复制结果，可再次粘贴重试。" : "画板已变化，未粘贴；请重新选择后再试。" });
          } finally { if (assetPaste.current === controller) assetPaste.current = null; }
        })();
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
  useEffect(() => {
    if (!autoFit.current || (!graph.nodes.length && !graph.strokes?.length && !graph.mind?.length) || drag) return;
    const id = requestAnimationFrame(() => { const el = svgWrap.current; if (el && el.clientWidth && el.clientHeight) fit(graph, { w: el.clientWidth, h: el.clientHeight }); });
    return () => cancelAnimationFrame(id);
  }, [size.w, size.h, compact, !!drag]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerMove = (e: React.PointerEvent) => {
    if (suppressTouch.current && e.pointerType === "touch") return;
    trackPointer(e.clientX, e.clientY);
    if (ink.current?.pointerId === e.pointerId) {
      const current = ink.current.stroke, p = toWorld(e.clientX, e.clientY);
      const point = { x: Math.round(Math.max(-20000, Math.min(20000, p.x))), y: Math.round(Math.max(-20000, Math.min(20000, p.y))) };
      const last = current.points.at(-1)!;
      if (current.points.length < 400 && Math.hypot(point.x - last.x, point.y - last.y) >= 2 / view.zoom) {
        const stroke = { ...current, points: [...current.points, point] }; ink.current.stroke = stroke; setInkPreview(stroke);
      }
      return;
    }
    if (erase.current?.pointerId === e.pointerId) { markErased(erase.current, toWorld(e.clientX, e.clientY)); return; }
    if (!drag) return;
    if (drag.kind === "pan") { autoFit.current = false; setView((v) => ({ ...v, x: drag.vx - (e.clientX - drag.startX) / v.zoom, y: drag.vy - (e.clientY - drag.startY) / v.zoom })); return; }
    const p = toWorld(e.clientX, e.clientY);
    if (drag.kind === "connect") { setDrag({ ...drag, x: p.x, y: p.y }); return; }
    if (drag.kind === "marquee") { setDrag({ ...drag, x1: p.x, y1: p.y }); return; }
    if (drag.kind === "rotate") {
      autoFit.current = false;
      // 自由旋转；接近 0/90/180/270° 时吸附，按住 Shift 以 15° 为步进。
      let rot = drag.rot0 + (Math.atan2(p.y - drag.cy, p.x - drag.cx) * 180) / Math.PI - drag.a0;
      rot = e.shiftKey ? Math.round(rot / 15) * 15 : Math.abs(rot - Math.round(rot / 90) * 90) < 4 ? Math.round(rot / 90) * 90 : Math.round(rot);
      rot = ((rot % 360) + 360) % 360;
      setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === drag.id ? { ...n, rot: rot || undefined } : n)) }));
      return;
    }
    if (drag.kind === "reconnect") { setDrag({ ...drag, x: p.x, y: p.y }); return; }
    if (drag.kind === "waypoint") { setGraph((g) => ({ ...g, edges: g.edges.map((x) => (x.id === drag.id && x.pts ? { ...x, pts: x.pts.map((q, i) => (i === drag.index ? { x: Math.round(p.x), y: Math.round(p.y) } : q)) } : x)) })); return; }
    if (drag.kind === "bend") { setGraph((g) => ({ ...g, edges: g.edges.map((x) => (x.id === drag.id ? { ...x, mid: Math.round(drag.isY ? p.y : p.x) } : x)) })); return; }
    if (drag.kind === "ink-resize") {
      const box = inkPointBounds(drag.stroke), dx = (e.clientX - drag.startX) / view.zoom, dy = (e.clientY - drag.startY) / view.zoom;
      const length = box.w * box.w + box.h * box.h;
      const scaled = scaleInk(drag.stroke, length ? 1 + (dx * box.w + dy * box.h) / length : 1);
      autoFit.current = false;
      setGraph((g) => ({ ...g, strokes: (g.strokes ?? []).map((stroke) => stroke.id === drag.id ? scaled : stroke) }));
      return;
    }
    let dx = (e.clientX - drag.startX) / view.zoom, dy = (e.clientY - drag.startY) / view.zoom;
    if ((drag.kind === "move" || drag.kind === "resize") && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) autoFit.current = false;
    if (drag.kind === "move") {
      // 对齐吸附：移动对象的左/中/右、上/中/下与其他图形对齐时吸附并显示参考线（按住 Alt 关闭）。
      const lines: Guide[] = [];
      if (!e.altKey && drag.origin.size) {
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
      const delta = boundedFlowOffset([...drag.origin.values()], [...drag.strokeOrigin.values()], dx, dy);
      dx = delta.x; dy = delta.y;
      setGuides(lines);
      setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => { const o = drag.origin.get(n.id); return o ? { ...n, x: o.x + dx, y: o.y + dy } : n; }), ...(g.strokes ? { strokes: g.strokes.map((stroke) => { const original = drag.strokeOrigin.get(stroke.id); return original ? { ...stroke, points: original.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) } : stroke; }) } : {}) }));
    }
    if (drag.kind === "resize") setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => {
      if (n.id !== drag.id) return n;
      // Resize along the shape's own axes when it is rotated.
      const a = (-(n.rot ?? 0) * Math.PI) / 180, lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      return { ...n, w: Math.max(20, Math.round(drag.w + lx)), h: Math.max(16, Math.round(drag.h + ly)) };
    }) }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (suppressTouch.current && e.pointerType === "touch") return;
    if (ink.current?.pointerId === e.pointerId) {
      const stroke = ink.current.stroke; ink.current = null; setInkPreview(null);
      commit({ ...graph, strokes: [...(graph.strokes ?? []), stroke] });
      return;
    }
    if (erase.current?.pointerId === e.pointerId) {
      const state = erase.current; markErased(state, toWorld(e.clientX, e.clientY)); erase.current = null; setErasePreview(null);
      if (state.ids.size) {
        const next = { ...state.base, strokes: (state.base.strokes ?? []).filter((stroke) => !state.ids.has(stroke.id)) };
        const result = submit(state.base, next), step = appliedFlowHistory(state.base, result.graph, result.appliedKeys);
        if (result.applied && step) { setUndo((u) => [...u.slice(-99), step]); setRedo([]); }
      }
      return;
    }
    const placement = touchPlacement.current;
    if (placement && e.pointerType === "touch" && placement.pointerId === e.pointerId) {
      touchPlacement.current = null;
      if (Math.hypot(e.clientX - placement.x, e.clientY - placement.y) <= 12) addNode(placement.shape, toWorld(e.clientX, e.clientY));
      return;
    }
    if (!drag) return;
    const d = drag;
    setDrag(null); setGuides([]);
    if (d.kind === "marquee") {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if (x1 - x0 < 3 && y1 - y0 < 3) return;
      const inside = graph.nodes.filter((n) => n.x >= x0 && n.y >= y0 && n.x + n.w <= x1 && n.y + n.h <= y1).map((n) => n.id);
      for (const stroke of graph.strokes ?? []) if (stroke.points.every((point) => point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1)) inside.push(stroke.id);
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
    if (d.kind === "reconnect") {
      // 拖动连线端点到另一个图形上即可改接（飞书画板行为）。
      const p = toWorld(e.clientX, e.clientY);
      const edge = graph.edges.find((x) => x.id === d.id);
      const target = [...graph.nodes].reverse().find((n) => p.x >= n.x - 8 && p.x <= n.x + n.w + 8 && p.y >= n.y - 8 && p.y <= n.y + n.h + 8);
      if (!edge || !target) return;
      const other = d.end === "from" ? edge.to : edge.from;
      if (target.id === other || target.id === (d.end === "from" ? edge.from : edge.to)) return;
      commit({ ...graph, edges: graph.edges.map((x) => (x.id === d.id ? (d.end === "from" ? { ...x, from: target.id, fromPort: undefined, mid: undefined, pts: undefined } : { ...x, to: target.id, toPort: undefined, mid: undefined, pts: undefined }) : x)) });
      return;
    }
    if (d.kind === "bend" || d.kind === "waypoint") {
      const base = lastInitial.current;
      if (JSON.stringify(base.edges) !== JSON.stringify(graph.edges)) { const result = submit(base, graph); const step = appliedFlowHistory(base, result.graph, result.appliedKeys); if (result.applied && step) { setUndo((u) => [...u.slice(-99), step]); setRedo([]); } }
      return;
    }
    if (d.kind === "move" || d.kind === "resize" || d.kind === "rotate" || d.kind === "ink-resize") {
      // Commit the gesture result relative to the pre-drag graph.
      const base = lastInitial.current;
      if (JSON.stringify(base.nodes) !== JSON.stringify(graph.nodes) || JSON.stringify(base.strokes ?? []) !== JSON.stringify(graph.strokes ?? [])) { const result = submit(base, graph); const step = appliedFlowHistory(base, result.graph, result.appliedKeys); if (result.applied && step) { setUndo((u) => [...u.slice(-99), step]); setRedo([]); } }
    }
  };

  const selectedNodes = graph.nodes.filter((n) => selected.has(n.id));
  const selectedEdges = graph.edges.filter((e) => selected.has(e.id));
  const selectedStrokes = (graph.strokes ?? []).filter((stroke) => selected.has(stroke.id));
  useEffect(() => {
    const node = recoveryBannerRef.current;
    if (!node) return;
    const measure = () => setRecoveryBannerHeight(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [recovery.length, compact]);
  useEffect(() => {
    const node = styleBarRef.current;
    if (!node) return;
    const measure = () => setStyleBarSize((last) => last.w === node.offsetWidth && last.h === node.offsetHeight ? last : { w: node.offsetWidth, h: node.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [selectedKey, compact, !!drag, !!editing, selectedNodes.length, selectedEdges.length]);
  const patchNodes = (patch: Partial<FlowNode>) => commit({ ...graph, nodes: graph.nodes.map((n) => (selected.has(n.id) ? { ...n, ...patch } : n)) });
  const patchEdges = (patch: Partial<FlowEdge>) => commit({ ...graph, edges: graph.edges.map((e) => (selected.has(e.id) ? { ...e, ...patch } : e)) });
  const patchStrokes = (patch: Partial<Pick<FlowStroke, "color" | "width">>) => commit({ ...graph, strokes: (graph.strokes ?? []).map((stroke) => selected.has(stroke.id) ? { ...stroke, ...patch } : stroke) });
  const editNode = editing?.kind === "node" ? graph.nodes.find((n) => n.id === editing.id) : null;
  const editEdge = editing?.kind === "edge" ? graph.edges.find((x) => x.id === editing.id) : null;
  const finishEdit = () => {
    if (!editing) return;
    const save = (next: FlowGraph) => { if (readOnly) submit(graph, next); else commit(next); };
    if (editing.kind === "node" && editNode && editNode.text !== editing.value) save({ ...graph, nodes: graph.nodes.map((n) => (n.id === editing.id ? { ...n, text: editing.value.slice(0, 500), w: Math.max(n.w, n.shape === "text" ? measureLabel(editing.value, n.w) : n.w) } : n)) });
    if (editing.kind === "edge" && editEdge && (editEdge.label ?? "") !== editing.value) save({ ...graph, edges: graph.edges.map((x) => (x.id === editing.id ? { ...x, label: editing.value.slice(0, 200) || undefined } : x)) });
    setEditing(null);
  };
  const requestClose = () => { finishEdit(); if (recoveryRef.current.length) setRecoveryOpen(true); else onClose(); };

  const importDrawio = async (file: File) => importDrawioText(await file.text());
  const importDrawioText = async (text: string) => {
    setBusy(true); setNotice(null);
    try {
      const { graph: g, warnings } = await parseDrawio(text);
      const merged = graph.nodes.length || graph.strokes?.length || graph.mind?.length ? appendGraph(graph, g) : { ...g, theme: graph.theme };
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
      const next = graph.nodes.length || graph.strokes?.length || graph.mind?.length ? appendGraph(graph, parsed.graph) : { ...parsed.graph, theme: graph.theme };
      commit(next); requestAnimationFrame(() => fit(next)); setMenu(null);
      setNotice({ ok: true, text: `AI 生成了 ${parsed.graph.nodes.length} 个节点${parsed.dropped ? `，${parsed.dropped} 项无效内容已忽略` : ""}，请核对` });
    } catch (err) { setNotice({ ok: false, text: aiErrorText(err) }); }
    finally { setBusy(false); }
  };
  const download = (name: string, blob: Blob) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 0); };
  const exportAs = async (kind: "svg" | "png" | "drawio") => {
    if (mindEditingRef.current) { setNotice({ ok: false, text: "请先完成节点文字编辑。" }); return; }
    setMenu(null);
    if (kind === "drawio" && graph.mind?.length) { setNotice({ ok: false, text: "draw.io 导出暂不支持思维导图，请使用 PNG 或 SVG。" }); return; }
    if (kind === "drawio" && graph.strokes?.length) { setNotice({ ok: false, text: "draw.io 导出暂不支持笔迹，请使用 PNG 或 SVG。" }); return; }
    if (kind === "drawio") return download("流程图.drawio", new Blob([toDrawio(graph)], { type: "application/xml" }));
    const svg = await inlineImages(svgMarkup(readOnly ? { ...graph, mindCollapsed: [...effectiveCollapsed] } : graph));
    if (kind === "svg") return download(mindBoard ? "思维导图.svg" : "流程图.svg", new Blob([svg], { type: "image/svg+xml" }));
    const b = flowBounds(graph), scale = 2, w = (b.w + 80) * scale, h = (b.h + 80) * scale;
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode().catch(() => {});
    const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.drawImage(img, 0, 0, w, h);
    canvas.toBlob((blob) => blob && download(mindBoard ? "思维导图.png" : "流程图.png", blob), "image/png");
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
    const next = graph.nodes.length || graph.strokes?.length || graph.mind?.length ? appendGraph(graph, g) : g;
    commit(next); setMenu(null); setShowStarter(false); requestAnimationFrame(() => fit(next));
  };

  const theme = themeOf(graph.theme);
  const viewBox = `${view.x} ${view.y} ${size.w / view.zoom} ${size.h / view.zoom}`;
  const tb = "grid size-8 place-items-center rounded-md text-[#1F2329] hover:bg-hover disabled:opacity-30 dark:text-foreground";
  const pop = cn("absolute top-10 z-20 rounded-lg border border-[#DEE0E3] bg-surface p-1 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border", compact && "!fixed !left-auto !right-3 !top-16 max-h-[calc(100vh-130px)] max-w-[calc(100vw-24px)] overflow-y-auto");

  const floatBar = "flex items-center gap-0.5 rounded-lg border border-[#DEE0E3] bg-surface p-1 shadow-[0_4px_16px_rgba(31,35,41,0.08)] dark:border-border";
  const barBtn = "flex h-8 items-center gap-1 rounded-md px-2 text-[13px] text-[#1F2329] hover:bg-hover disabled:opacity-30 dark:text-foreground";
  const menuItem = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover";
  const railBtn = cn("grid size-9 place-items-center rounded-md text-[#1F2329] hover:bg-hover dark:text-foreground", compact && "size-9 shrink-0 max-[359px]:size-8");
  const activeInkColor = penKind === "marker" ? markerColor : penColor;
  const inkColors = penKind === "marker" ? [["#FFEE24", "黄色"], ["#FFB3CC", "粉色"], ["#98E7A5", "绿色"], ["#8DCBFF", "蓝色"], ["#D1B3FF", "紫色"]] as const : INK_COLORS;
  const penSettings = <div className="absolute bottom-[52px] right-0 z-[90] w-[208px] rounded-lg border border-[#DEE0E3] bg-surface p-3 text-[13px] shadow-lg" role="group" aria-label="画笔颜色" onPointerDown={(event) => event.stopPropagation()}>
    <div className="mb-2 text-subtle">画笔颜色</div><div className="flex flex-wrap gap-2">{inkColors.map(([color, label]) => <button key={color} type="button" aria-label={`画笔颜色 ${label}`} title={label} aria-pressed={activeInkColor === color} onClick={() => { penKind === "marker" ? setMarkerColor(color) : setPenColor(color); setMenu(null); }} className={cn("size-5 rounded-full border border-[#bbbfc4]", activeInkColor === color && "ring-2 ring-primary ring-offset-2")} style={{ background: color }}/>)}</div>
  </div>;
  const libraryGroups: { title: string; shapes: Shape[] }[] = [
    { title: "基础", shapes: ["round", "rect", "ellipse", "diamond", "triangle", "hexagon", "parallelogram", "note", "text", ...(upload ? ["image" as const] : [])] },
    { title: "泳道", shapes: ["swimlane", "swimlaneV"] },
    { title: "流程图", shapes: ["terminator", "rect", "diamond", "parallelogram", "document", "cylinder", "hexagon"] },
    { title: "类图", shapes: ["class", "note"] },
    { title: "时序图", shapes: ["actor", "lifeline", "note"] },
  ];
  const ICON_BOX: Partial<Record<Shape, [number, number, number, number]>> = { actor: [33, 6, 30, 106], lifeline: [18, 8, 60, 82], swimlane: [6, 16, 84, 64], swimlaneV: [14, 6, 68, 84], class: [14, 12, 68, 72], triangle: [14, 14, 68, 68], note: [16, 12, 64, 72] };
  const shapeIcon = (id: Shape) => { const [x, y, w, h] = ICON_BOX[id] ?? [10, 22, 76, 52]; return <svg viewBox="0 0 96 96" className="size-6" fill="none"><ShapeOutline n={{ id: "i", x, y, w, h, shape: id, text: "" }} theme={{ ...THEMES[0], radius: 4, strokeWidth: 6 }} fill="none" stroke="currentColor" />{id === "text" && <text x="48" y="66" textAnchor="middle" fontSize="52" fill="currentColor">T</text>}</svg>; };
  const filteredGroups = libraryGroups.map((g) => ({ ...g, shapes: g.shapes.filter((id) => !libQuery.trim() || SHAPES.find((x) => x.id === id)!.label.includes(libQuery.trim())) })).filter((g) => g.shapes.length);
  // Floating style toolbar anchored above the selection (Feishu: shape ▾ / 填充 ▾ / 边框 ▾ / 字色 ▾ / 字号 ▾ / 更多).
  const anchorBox = selectedNodes.length ? bounds(selectedNodes) : selectedEdges.length ? (() => { const e = selectedEdges[0]; const a = graph.nodes.find((n) => n.id === e.from), t = graph.nodes.find((n) => n.id === e.to); if (!a || !t) return null; const m = edgePath(e, a, t).mid; return { x: m.x, y: m.y, w: 0, h: 0 }; })() : selectedStrokes.length ? flowBounds({ nodes: [], edges: [], strokes: selectedStrokes, theme: graph.theme }) : null;
  const obstaclePadding = Math.max(12, 20 * view.zoom);
  const obstacles = [...graph.nodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h })), ...(graph.strokes ?? []).map((stroke) => flowBounds({ nodes: [], edges: [], strokes: [stroke], theme: graph.theme }))].map((box) => ({ x: (box.x - view.x) * view.zoom - obstaclePadding, y: (box.y - view.y) * view.zoom - obstaclePadding, w: box.w * view.zoom + 2 * obstaclePadding, h: box.h * view.zoom + 2 * obstaclePadding }));
  const barPos = anchorBox ? placeSelectionToolbar({ x: (anchorBox.x - view.x - 16) * view.zoom, y: (anchorBox.y - view.y - 16) * view.zoom, w: (anchorBox.w + 32) * view.zoom, h: (anchorBox.h + 32) * view.zoom }, size, styleBarSize, obstacles) : null;
  const reserveStyleBar = compact && !readOnly && (selectedNodes.length > 0 || selectedEdges.length > 0 || selectedStrokes.length > 0);
  const mindPositions = layoutMindTopics(graph.mind ?? [], effectiveCollapsed), mindAnchor = mindSelected ? mindPositions.find((item) => item.topic.id === mindSelected) : null;
  const mindViewport = svgWrap.current?.getBoundingClientRect();
  const mindRoot = (id: string) => { let topic = graph.mind?.find((item) => item.id === id), depth = 0; while (topic?.parent && depth++ < 32) topic = graph.mind?.find((item) => item.id === topic!.parent); return topic?.id; };
  const sameTree = mindAnchor ? mindPositions.filter((item) => mindRoot(item.topic.id) === mindRoot(mindAnchor.topic.id)) : [];
  const treeTop = mindViewport && sameTree.length ? mindViewport.top + (Math.min(...sameTree.map((item) => item.y)) - view.y) * view.zoom : 0;
  const treeBottom = mindViewport && sameTree.length ? mindViewport.top + (Math.max(...sameTree.map((item) => item.y + item.h)) - view.y) * view.zoom : 0;
  const windowHeight = typeof window === "undefined" ? 720 : window.innerHeight;
  const toolbarTop = treeTop - 50 >= 64 ? treeTop - 50 : treeBottom + 8 <= windowHeight - 52 ? treeBottom + 8 : 64;
  const mindToolbarStyle = !compact && mindAnchor && mindViewport ? { left: Math.max(165, Math.min(window.innerWidth - 165, mindViewport.left + (mindAnchor.x + mindAnchor.w / 2 - view.x) * view.zoom)), top: toolbarTop } : undefined;

  return createPortal(<div className="fixed inset-0 z-[80] select-none bg-surface" data-flow-editor onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { ink.current = null; setInkPreview(null); erase.current = null; setErasePreview(null); touchPlacement.current = null; if (drag && !["pan", "marquee", "connect", "reconnect"].includes(drag.kind)) setGraph(lastInitial.current); setDrag(null); setGuides([]); }}>
    {/* 画布 */}
    <div ref={svgWrap} className="absolute inset-0 overflow-hidden" style={{ left: !readOnly && library && !compact ? 260 : 0, top: recovery.length ? 72 + Math.max(48, recoveryBannerHeight) : compact ? 64 : 0, bottom: compact ? (reserveStyleBar ? 76 + Math.max(52, styleBarSize.h) : 128) : 0, touchAction: "none", background: theme.canvas, backgroundImage: mindBoard ? "none" : `radial-gradient(${theme.id === "dark" ? "#3A404D" : "#D0D3D6"} 1px, transparent 1px)`, backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`, backgroundPosition: `${-view.x * view.zoom}px ${-view.y * view.zoom}px`, cursor: tool !== "select" ? "crosshair" : drag?.kind === "pan" ? "grabbing" : hand ? "grab" : "default" }}
      onTouchStart={(e) => {
        if (e.touches.length !== 2) return;
        if (e.target instanceof Element && e.target.closest("[data-flow-style-bar],[data-flow-template-picker],textarea")) return;
        const rect = e.currentTarget.getBoundingClientRect(), a = e.touches[0], b = e.touches[1];
        const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (!distance) return;
        autoFit.current = false;
        suppressTouch.current = true;
        ink.current = null; setInkPreview(null); erase.current = null; setErasePreview(null);
        touchPlacement.current = null;
        pinch.current = { view, center: { x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top }, distance };
        if (drag && !["pan", "marquee", "connect", "reconnect"].includes(drag.kind)) setGraph(lastInitial.current);
        setDrag(null); setGuides([]);
      }}
      onTouchMove={(e) => {
        const start = pinch.current;
        if (!start || e.touches.length < 2) return;
        const rect = e.currentTarget.getBoundingClientRect(), a = e.touches[0], b = e.touches[1];
        const center = { x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top };
        setView(pinchViewport(start.view, start.center, center, start.distance, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)));
      }}
      onTouchEnd={(e) => { if (e.touches.length < 2) pinch.current = null; if (!e.touches.length) suppressTouch.current = false; }}
      onTouchCancel={() => { pinch.current = null; touchPlacement.current = null; suppressTouch.current = false; erase.current = null; setErasePreview(null); }}
      onDragOver={(e) => { if (upload && !readOnly && [...e.dataTransfer.items].some((i) => i.kind === "file")) e.preventDefault(); }}
      onDrop={(e) => { const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/")); if (!f || !upload || readOnly) return; e.preventDefault(); void insertImage(f, toWorld(e.clientX, e.clientY)); }}
      onWheel={(e) => { autoFit.current = false; if (e.ctrlKey || e.metaKey) { const p = toWorld(e.clientX, e.clientY); const zoom = Math.min(3, Math.max(0.2, view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); setView({ zoom, x: p.x - (p.x - view.x) * (view.zoom / zoom), y: p.y - (p.y - view.y) * (view.zoom / zoom) }); } else setView((v) => ({ ...v, x: v.x + e.deltaX / v.zoom, y: v.y + e.deltaY / v.zoom })); }}>
      <FlowSvg graph={graph} width="100%" height="100%" viewBox={viewBox} selected={selected} draftStroke={inkPreview} erasing={erasePreview} mindSelected={mindSelected} mindEditing={mindEditing} mindCollapsed={effectiveCollapsed} onMindFold={!mindEditing && (readOnly || tool === "select") ? toggleMindFold : undefined} onMindAddChild={!readOnly && tool === "select" && !mindEditing ? (id) => addMindTopic(false, id) : undefined} onMindSelect={readOnly || tool === "pen" || tool === "eraser" ? undefined : (topic) => { if (mindEditing) finishMindEdit(); setMindSelected(topic.id); setSelected(new Set()); setTool("select"); setHand(false); }} onMindEdit={readOnly || tool === "pen" || tool === "eraser" ? undefined : startMindEdit} onMindDraft={(value) => { const edit = mindEditingRef.current; if (edit) { const next = { ...edit, value }; mindEditingRef.current = next; setMindEditing(next); } }} onMindFinish={finishMindEdit} onMindCancel={cancelMindEdit} resizeStroke={!readOnly && tool === "select" && selectedStrokes.length === 1 && !selectedNodes.length && !selectedEdges.length ? selectedStrokes[0].id : null} editing={editing?.kind === "node" ? editing.id : null} idPrefix="fce" transparent touchZoom={compact ? view.zoom : undefined}
        onCanvasDown={(e) => {
          if (e.pointerType === "touch" && (!e.isPrimary || suppressTouch.current)) return;
          if (e.target !== e.currentTarget && !(e.target instanceof SVGSVGElement)) return;
          setMenu(null); setMindSelected(null);
          if (tool === "pen") { startInk(e); return; }
          if (tool === "eraser") { startErase(e); return; }
          if (tool !== "select" && !readOnly) {
            if (e.pointerType === "touch") touchPlacement.current = { shape: tool, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
            else addNode(tool, toWorld(e.clientX, e.clientY));
            return;
          }
          finishEdit();
          if (e.pointerType === "touch" && !hand) setSelected(new Set());
          if (hand || space.current || e.button === 1 || readOnly || e.pointerType === "touch") { setDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y }); return; }
          // 空白处拖动 = 框选（飞书画板行为）；平移用抓手、空格或中键。
          const p = toWorld(e.clientX, e.clientY);
          const base = e.shiftKey ? new Set(selected) : new Set<string>();
          setSelected(base);
          setDrag({ kind: "marquee", x0: p.x, y0: p.y, x1: p.x, y1: p.y, base });
        }}
        onNodeDown={(e, n) => { setMindSelected(null);
          e.stopPropagation(); setMenu(null);
          if (e.pointerType === "touch" && (!e.isPrimary || suppressTouch.current)) return;
          if (tool === "pen") { startInk(e); return; }
          if (tool === "eraser") { startErase(e); return; }
          if (connectFrom && !readOnly) {
            if (n.id !== connectFrom && graph.nodes.some((node) => node.id === connectFrom)) {
              const edge: FlowEdge = { id: newFlowId("e"), from: connectFrom, to: n.id, kind: edgeKind };
              commit({ ...graph, edges: [...graph.edges, edge] }); setSelected(new Set([edge.id]));
            }
            setConnectFrom(null);
            return;
          }
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
          if (!readOnly) setDrag({ kind: "move", ids: [...moving], startX: e.clientX, startY: e.clientY, origin: new Map(graph.nodes.filter((x) => moving.has(x.id)).map((x) => [x.id, { x: x.x, y: x.y }])), strokeOrigin: new Map((graph.strokes ?? []).filter((stroke) => moving.has(stroke.id)).map((stroke) => [stroke.id, stroke])) });
        }}
        onEdgeDown={(e, edge) => { setMindSelected(null);
          e.stopPropagation(); setMenu(null);
          if (e.pointerType === "touch" && (!e.isPrimary || suppressTouch.current)) return;
          if (tool === "pen") { startInk(e); return; }
          if (tool === "eraser") { startErase(e); return; }
          const el = e.target as Element;
          const wp = el.getAttribute("data-flow-wp"), wpAdd = el.getAttribute("data-flow-wpadd");
          if (wp !== null && !readOnly) { setDrag({ kind: "waypoint", id: edge.id, index: Number(wp) }); return; }
          if (wpAdd !== null && !readOnly) {
            // Drag from a hollow handle to insert a waypoint (the orthogonal "mid" segment becomes explicit points).
            const p = toWorld(e.clientX, e.clientY), pt = { x: Math.round(p.x), y: Math.round(p.y) };
            const a = graph.nodes.find((n) => n.id === edge.from), t = graph.nodes.find((n) => n.id === edge.to);
            if (!a || !t) return;
            let pts = edge.pts ? [...edge.pts] : [];
            let index = Number(wpAdd);
            if (!edge.pts?.length && (edge.kind ?? "orthogonal") === "orthogonal") {
              const m = edgePath(edge, a, t).mid;
              pts = el.getAttribute("data-flow-wpafter") ? [{ x: Math.round(m.x), y: Math.round(m.y) }, pt] : [pt, { x: Math.round(m.x), y: Math.round(m.y) }];
              index = el.getAttribute("data-flow-wpafter") ? 1 : 0;
            } else pts.splice(index, 0, pt);
            setGraph((g) => ({ ...g, edges: g.edges.map((x) => (x.id === edge.id ? { ...x, pts, mid: undefined } : x)) }));
            setDrag({ kind: "waypoint", id: edge.id, index });
            return;
          }
          const endAttr = el.getAttribute("data-flow-end");
          if ((endAttr === "from" || endAttr === "to") && !readOnly) { const p = toWorld(e.clientX, e.clientY); setDrag({ kind: "reconnect", id: edge.id, end: endAttr, x: p.x, y: p.y }); return; }
          if ((e.target as Element).getAttribute("data-flow-bend") && !readOnly) {
            const a = graph.nodes.find((n) => n.id === edge.from), t = graph.nodes.find((n) => n.id === edge.to);
            if (a && t) setDrag({ kind: "bend", id: edge.id, isY: midIsY(edge, a, t) });
            return;
          }
          setSelected(e.shiftKey ? new Set(selected).add(edge.id) : new Set([edge.id]));
        }}
        onStrokeDown={(e, stroke) => { setMindSelected(null);
          e.stopPropagation(); setMenu(null);
          if (e.pointerType === "touch" && (!e.isPrimary || suppressTouch.current)) return;
          if (tool === "pen") { startInk(e); return; }
          if (tool === "eraser") { startErase(e); return; }
          if (hand || space.current || e.button === 1) { setDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y }); return; }
          const next = e.shiftKey ? new Set(selected).add(stroke.id) : selected.has(stroke.id) ? selected : new Set([stroke.id]);
          setSelected(next);
          if (!readOnly) {
            setDrag({ kind: "move", ids: [...next], startX: e.clientX, startY: e.clientY, origin: new Map(graph.nodes.filter((node) => next.has(node.id)).map((node) => [node.id, { x: node.x, y: node.y }])), strokeOrigin: new Map((graph.strokes ?? []).filter((item) => next.has(item.id)).map((item) => [item.id, item])) });
            svgWrap.current?.setPointerCapture(e.pointerId);
          }
        }}
        onStrokeResize={readOnly ? undefined : (event, stroke) => {
          if (event.pointerType === "touch" && (!event.isPrimary || suppressTouch.current)) return;
          setDrag({ kind: "ink-resize", id: stroke.id, startX: event.clientX, startY: event.clientY, stroke });
          svgWrap.current?.setPointerCapture(event.pointerId);
        }}
        onPortDown={readOnly ? undefined : (e, n, port) => { if (e.pointerType === "touch" && (!e.isPrimary || suppressTouch.current)) return; const p = toWorld(e.clientX, e.clientY); setDrag({ kind: "connect", from: n.id, port, x: p.x, y: p.y }); }}
        onNodeDouble={readOnly || tool === "pen" || tool === "eraser" ? undefined : (n) => setEditing({ id: n.id, kind: "node", value: n.text })}
        onEdgeDouble={readOnly || tool === "pen" || tool === "eraser" ? undefined : (edge) => setEditing({ id: edge.id, kind: "edge", value: edge.label ?? "" })}
        guides={guides}
        rotateHandle={!readOnly && selectedNodes.length === 1 && !isContainer(selectedNodes[0].shape) ? selectedNodes[0].id : null}
        bendHandle={!readOnly && selectedEdges.length === 1 && !selectedNodes.length ? selectedEdges[0].id : null}
        onWaypointRemove={readOnly ? undefined : (edge, i) => commit({ ...graph, edges: graph.edges.map((x) => (x.id === edge.id ? { ...x, pts: (x.pts ?? []).filter((_, k) => k !== i) } : x)) })}
        peerSel={peers.filter((p) => p.sel?.length).map((p) => ({ color: p.color, ids: p.sel! }))}
        marquee={drag?.kind === "marquee" ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) } : null}
        connectPreview={drag?.kind === "reconnect" ? (() => { const edge = graph.edges.find((x) => x.id === drag.id); const a = edge && graph.nodes.find((n) => n.id === edge.from), t = edge && graph.nodes.find((n) => n.id === edge.to); if (!edge || !a || !t) return null; const r = edgePath(edge, a, t); const fixed = drag.end === "from" ? r.end : r.start; return { x1: fixed.x, y1: fixed.y, x2: drag.x, y2: drag.y }; })() : drag?.kind === "connect" ? (() => { const n = graph.nodes.find((x) => x.id === drag.from)!; const pt = portPoint(n, drag.port); return { x1: pt.x, y1: pt.y, x2: drag.x, y2: drag.y }; })() : null}
      />
      {editing && (editNode || editEdge) && (() => {
        const anchor = editNode ? { x: editNode.x, y: editNode.y, w: editNode.w, h: editNode.h } : (() => { const e = editEdge!; const a = graph.nodes.find((n) => n.id === e.from)!, t = graph.nodes.find((n) => n.id === e.to)!; const m = edgePath(e, a, t).mid; return { x: m.x - 70, y: m.y - 16, w: 140, h: 32 }; })();
        return <textarea autoFocus value={editing.value} placeholder="输入文本" onChange={(e) => setEditing({ ...editing, value: e.target.value })} onBlur={finishEdit} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); finishEdit(); } if (e.key === "Escape") setEditing(null); }}
          className={cn("absolute select-text resize-none rounded border-2 border-primary bg-surface p-1 text-center outline-none", compact ? "text-[16px]" : "text-[14px]")} style={{ left: (anchor.x - view.x) * view.zoom, top: (anchor.y - view.y) * view.zoom, width: anchor.w * view.zoom, height: Math.max(32, anchor.h * view.zoom) }} data-flow-text-editor />;
      })()}
      {!graph.nodes.length && !graph.strokes?.length && !graph.mind?.length && !readOnly && showStarter && <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className={cn("pointer-events-auto w-[min(560px,calc(100%-32px))] overflow-y-auto rounded-xl border border-[#DEE0E3] bg-surface p-4 shadow-[0_4px_16px_rgba(31,35,41,0.08)] dark:border-border", compact ? "max-h-[calc(100%-24px)]" : "max-h-[calc(100%-190px)]")} style={{ touchAction: "pan-y" }} onPointerDown={(e) => e.stopPropagation()} data-flow-template-picker>
          <div className="mb-3 flex items-center text-[14px] font-medium">从模板创建<button type="button" aria-label="关闭模板" onClick={() => setShowStarter(false)} className="ml-auto grid size-8 place-items-center rounded-md text-subtle hover:bg-hover"><X size={16}/></button></div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">{FLOW_TEMPLATES.map((t) => <button key={t.id} type="button" onClick={() => applyTemplate(t)} className="rounded-lg border border-[#DEE0E3] p-2 text-left hover:border-primary dark:border-border" data-flow-template={t.id}><div className="text-[13px] font-medium">{t.label}</div><div className="mt-1 text-[11px] leading-4 text-subtle">{t.desc}</div></button>)}</div>
          <div className="mt-3 text-[12px] text-subtle">也可以从{compact ? "下方" : "左侧"}图形库选择图形后点击画布放置，或在右上角使用「AI 生成」「导入 draw.io」，支持直接粘贴 draw.io 内容。</div>
        </div>
      </div>}
      {/* 协作者指针 */}
      {peers.filter((p) => typeof p.x === "number" && typeof p.y === "number").map((p) => <div key={p.id} className="pointer-events-none absolute z-10 transition-[left,top] duration-100" style={{ left: (p.x! - view.x) * view.zoom, top: (p.y! - view.y) * view.zoom }} data-flow-peer-cursor={p.name}>
        <svg width="16" height="18" viewBox="0 0 16 18"><path d="M1,1 L15,8 L8,10 L5,17 Z" fill={p.color} stroke="#FFFFFF" strokeWidth="1.2" /></svg>
        <span className="ml-3 block whitespace-nowrap rounded px-1.5 py-0.5 text-[12px] text-white" style={{ background: p.color }}>{p.name}</span>
      </div>)}
      {/* 选中对象的浮动样式栏 */}
      {!readOnly && barPos && !drag && !editing && !recoveryOpen && svgWrap.current && createPortal(<div ref={styleBarRef} className={cn(floatBar, compact ? "fixed bottom-[68px] left-3 right-3 z-[90] flex-wrap [&>*]:shrink-0" : "absolute z-20 -translate-x-1/2")} style={compact ? undefined : barPos} onPointerDown={(e) => e.stopPropagation()} data-flow-style-bar>
        {selectedStrokes.length > 0 && <>
          <div className="relative"><button type="button" aria-label="笔迹颜色" title="笔迹颜色" className={barBtn} onClick={() => setMenu(menu === "ink-color" ? null : "ink-color")}><span className="size-4 rounded-full border border-[#bbbfc4]" style={{ background: selectedStrokes[0].color }}/><ChevronDown size={12}/></button>
            {menu === "ink-color" && <div className={cn(pop, "left-0 w-[208px] p-2")} role="group" aria-label="笔迹颜色">{INK_COLORS.map(([color, label]) => <button key={color} type="button" aria-label={`笔迹颜色 ${label}`} title={label} onClick={() => { patchStrokes({ color }); setMenu(null); }} className="m-1 size-5 rounded-full border border-[#bbbfc4]" style={{ background: color }}/>)}</div>}
          </div>
          <select aria-label="笔迹粗细" title="笔迹粗细" value={selectedStrokes[0].width} onChange={(e) => patchStrokes({ width: Number(e.target.value) })} className="h-8 rounded-md border bg-surface px-1 text-[13px]">{INK_WIDTHS.includes(selectedStrokes[0].width as typeof INK_WIDTHS[number]) ? null : <option value={selectedStrokes[0].width}>{selectedStrokes[0].width}</option>}{INK_WIDTHS.map((width) => <option key={width} value={width}>{width}</option>)}</select>
          <button type="button" className={barBtn} onClick={() => { const clip = clipOfSelection(); if (clip) pasteClip(clip, 20); }} title="创建副本" aria-label="创建笔迹副本"><Copy size={15}/></button>
          <button type="button" className={barBtn} onClick={removeSelected} data-flow-delete-ink><Trash2 size={15}/>删除笔迹</button>
        </>}
        {compact && <button type="button" className={tb} aria-label="完成选择" onClick={() => { setSelected(new Set()); setMenu(null); }}><X size={16}/></button>}
        {compact && selectedNodes.length === 1 && selectedNodes[0].shape !== "image" && <button type="button" className={barBtn} onClick={() => setEditing({ id: selectedNodes[0].id, kind: "node", value: selectedNodes[0].text })} data-flow-edit-text>编辑文字</button>}
        {compact && selectedNodes.length === 1 && <button type="button" className={barBtn} onClick={() => { setConnectFrom(selectedNodes[0].id); setSelected(new Set()); setMenu(null); }} data-flow-connect-tap>连接图形</button>}
        {selectedNodes.length > 0 && !selectedNodes.every((n) => n.shape === "image") && <>
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
          {selectedEdges.some((x) => x.pts?.length || x.mid !== undefined) && <button type="button" onClick={() => patchEdges({ pts: undefined, mid: undefined })} className={barBtn} title="恢复自动走线" data-flow-clear-points>清除拐点</button>}
        </>}
        <span className="mx-0.5 h-5 w-px bg-[#DEE0E3]" />
        {onComment && selectedNodes.length > 0 && <button type="button" className={tb} title="评论" onClick={() => { const n = selectedNodes[0]; finishEdit(); if (recoveryRef.current.length) { setRecoveryOpen(true); return; } onComment(n.text.split("\n")[0] || SHAPES.find((x) => x.id === n.shape)?.label || "图形"); onClose(); }} data-flow-comment><MessageSquare size={15} /></button>}
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
      </div>, compact ? document.body : svgWrap.current)}
    </div>
    {compact && connectFrom && <div className="absolute bottom-[68px] left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-lg border bg-surface px-3 py-2 text-[13px] shadow-md" role="status">请选择要连接的图形<button type="button" className="text-primary" onClick={() => setConnectFrom(null)}>取消</button></div>}

    {/* 左侧：图形库面板 + 竖向工具条（飞书画板布局） */}
    {!readOnly && compact && library && <button type="button" aria-label="关闭图形库" className="absolute inset-0 z-30 bg-black/20" onClick={() => setLibrary(false)} />}
    {!readOnly && library && <aside className={cn("absolute bottom-0 left-0 top-0 flex w-[260px] flex-col border-r border-[#DEE0E3] bg-surface dark:border-border", compact ? "z-40 max-w-[calc(100%-48px)] shadow-xl" : "z-10")} aria-label="图形库" data-flow-library>
      <div className="flex h-12 shrink-0 items-center gap-2 px-4"><span className="text-[14px] font-medium">图形库</span><button type="button" title="收起" onClick={() => setLibrary(false)} className="ml-auto grid size-7 place-items-center rounded text-subtle hover:bg-hover"><ChevronLeft size={16} /></button></div>
      <label className="mx-4 flex h-8 items-center gap-2 rounded-md border px-2 text-subtle focus-within:border-primary"><Search size={14} /><input value={libQuery} onChange={(e) => setLibQuery(e.target.value)} placeholder="搜索" className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none" /></label>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {filteredGroups.map((g) => <section key={g.title} className="mt-4"><div className="mb-2 flex items-center gap-1 text-[13px] text-[#646A73]"><ChevronDown size={12} />{g.title}</div><div className="grid grid-cols-5 gap-1">{g.shapes.map((id, i) => { const spec = SHAPES.find((s) => s.id === id)!; return <button key={`${id}${i}`} type="button" title={`${spec.label}（点击后在画布上放置，双击直接添加）`} onClick={() => { if (id === "image") imageRef.current?.click(); else { setTool(id); setHand(false); setShowStarter(false); } if (compact) setLibrary(false); }} onDoubleClick={() => id !== "image" && addNode(id)} className={cn("grid size-10 place-items-center rounded-md text-[#1F2329] hover:bg-hover dark:text-foreground", tool === id && "bg-[#E1EAFF] text-primary")} data-flow-shape={id}>{shapeIcon(id)}</button>; })}</div></section>)}
        {!libQuery.trim() && <section className="mt-4"><div className="mb-2 flex items-center gap-1 text-[13px] text-[#646A73]"><ChevronDown size={12} />直线</div>
          <div className="grid grid-cols-5 gap-1">{([["orthogonal", "折线", "M10,78 H48 V18 H86"], ["straight", "直线", "M10,86 L86,10"], ["curve", "曲线", "M10,80 C40,80 56,16 86,16"]] as const).map(([k, l, d]) => <button key={k} type="button" title={`新连线默认使用${l}`} onClick={() => setEdgeKind(k)} className={cn("grid size-10 place-items-center rounded-md text-[#1F2329] hover:bg-hover dark:text-foreground", edgeKind === k && "bg-[#E1EAFF] text-primary")} data-flow-edge-kind={k}><svg viewBox="0 0 96 96" className="size-6" fill="none" stroke="currentColor" strokeWidth={6}><path d={d} /></svg></button>)}</div>
          <p className="mt-1 text-[12px] leading-5 text-subtle">选中图形后，从四周的蓝色圆点拖到另一个图形即可连线。</p>
        </section>}
      </div>
    </aside>}
    {!readOnly && !(compact && (connectFrom || (barPos && !drag && !editing))) && <aside className={cn("absolute z-10 flex gap-0.5 rounded-xl border border-[#DEE0E3] bg-surface p-1.5 shadow-[0_4px_16px_rgba(31,35,41,0.08)] dark:border-border", compact ? "bottom-[68px] left-1/2 max-w-[calc(100%-24px)] -translate-x-1/2 flex-row overflow-x-auto" : "top-1/2 -translate-y-1/2 flex-col")} style={compact ? undefined : { left: library ? 272 : 12 }} aria-label="工具">
      <button type="button" className={cn(railBtn, library && "bg-[#E1EAFF]")} title="图形库" onClick={() => setLibrary(!library)} data-flow-library-toggle><Shapes size={18} className="text-[#3370FF]" /></button>
      <span className={cn("bg-[#DEE0E3]", compact ? "mx-0.5 my-1 h-8 w-px shrink-0" : "mx-1 my-0.5 h-px")} />
      <button type="button" className={cn(railBtn, tool === "select" && !hand && "bg-[#E1EAFF] text-primary")} title="选择" onClick={() => { setTool("select"); setHand(false); }} data-flow-select-tool><MousePointer2 size={18} /></button>
      <button type="button" className={cn(railBtn, (tool === "pen" || tool === "eraser") && "bg-[#E1EAFF] text-primary")} title="画笔" aria-label="画笔" aria-pressed={tool === "pen" || tool === "eraser"} onClick={() => { setTool("pen"); setHand(false); setSelected(new Set()); setMenu(null); setShowStarter(false); }} data-flow-pen-tool><Pencil size={18} /></button>
      <button type="button" className={railBtn} aria-label="插入思维导图" title="插入思维导图" onClick={addMindMap} data-flow-mindmap-tool><ListTree size={18}/></button>
      <button type="button" className={cn(railBtn, tool === "round" && "bg-[#E1EAFF] text-primary")} title="图形（点击画布放置）" onClick={() => { setTool("round"); setHand(false); setShowStarter(false); }}><Square size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "text" && "bg-[#E1EAFF] text-primary")} title="文本" onClick={() => { setTool("text"); setHand(false); setShowStarter(false); }}><Type size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "diamond" && "bg-[#E1EAFF] text-primary")} title="判断" onClick={() => { setTool("diamond"); setHand(false); setShowStarter(false); }}><Diamond size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "note" && "bg-[#E1EAFF] text-primary")} title="便签" onClick={() => { setTool("note"); setHand(false); setShowStarter(false); }}><svg viewBox="0 0 96 96" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={7}><path d="M14,12 H66 L82,28 V84 H14 Z M66,12 V28 H82" /></svg></button>
      {upload && <button type="button" className={railBtn} title="插入图片（也可粘贴或拖入画板）" onClick={() => imageRef.current?.click()} data-flow-image-btn><ImageIcon size={18} /></button>}
      <input ref={imageRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void insertImage(f); }} data-flow-image-input />
    </aside>}

    {!readOnly && mindSelected && !mindEditing && <div role="toolbar" aria-label="思维导图节点操作" data-mind-toolbar className={cn("z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-lg border border-[#DEE0E3] bg-surface p-1 shadow-lg [&>button]:shrink-0 [&>button]:whitespace-nowrap", compact ? "absolute bottom-[120px] left-1/2" : "fixed")} style={mindToolbarStyle} onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" className={barBtn} onClick={() => { const topic = graph.mind?.find((item) => item.id === mindSelected); if (topic) startMindEdit(topic); }}>编辑文字</button>
      <button type="button" className={barBtn} onClick={() => addMindTopic(false)}><Plus size={14}/>子节点</button>
      <button type="button" className={barBtn} disabled={!graph.mind?.find((topic) => topic.id === mindSelected)?.parent} onClick={() => addMindTopic(true)}>同级节点</button>
      <button type="button" className={barBtn} onClick={removeMindTopic}><Trash2 size={14}/>删除</button>
    </div>}

    {!readOnly && (tool === "pen" || tool === "eraser") && <div role="toolbar" aria-label="画笔工具" data-flow-pen-toolbar onPointerDown={(event) => event.stopPropagation()} className={cn("absolute left-1/2 z-20 flex h-12 max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1 rounded-full border border-[#DEE0E3] bg-surface px-2 shadow-[0_4px_16px_rgba(31,35,41,0.12)]", compact ? "bottom-[120px]" : "bottom-5")}>
      <button type="button" aria-label="画笔模式" aria-pressed={tool === "pen" && penKind === "pen"} title="画笔" className={cn(tb, tool === "pen" && penKind === "pen" && "bg-[#E1EAFF] text-primary")} onClick={() => { setTool("pen"); setPenKind("pen"); setMenu(null); }}><Pencil size={17}/></button>
      <button type="button" aria-label="荧光笔" aria-pressed={tool === "pen" && penKind === "marker"} title="荧光笔" className={cn(tb, tool === "pen" && penKind === "marker" && "bg-[#E1EAFF] text-primary")} onClick={() => { setTool("pen"); setPenKind("marker"); setMenu(null); }}><Brush size={17}/></button>
      <button type="button" aria-label="橡皮擦" aria-pressed={tool === "eraser"} title="橡皮擦（擦除整条笔迹）" data-flow-eraser-tool className={cn(tb, tool === "eraser" && "bg-[#E1EAFF] text-primary")} onClick={() => { setTool("eraser"); setMenu(null); }}><Eraser size={17}/></button>
      <span className="mx-1 h-6 w-px shrink-0 bg-[#DEE0E3]"/>
      <select aria-label="画笔粗细" title="画笔粗细" disabled={tool !== "pen"} value={penKind === "marker" ? markerWidth : penWidth} onChange={(event) => penKind === "marker" ? setMarkerWidth(Number(event.target.value)) : setPenWidth(Number(event.target.value))} className="h-8 max-w-[58px] rounded-md bg-surface px-1 text-[12px] text-[#646A73] disabled:opacity-30">{(penKind === "marker" ? MARKER_WIDTHS : INK_WIDTHS).map((width) => <option key={width} value={width}>{width}</option>)}</select>
      <div className="relative"><button type="button" aria-label="画笔颜色" aria-expanded={menu === "pen"} title="画笔颜色" disabled={tool !== "pen"} className={tb} onClick={() => setMenu(menu === "pen" ? null : "pen")}><span className="size-4 rounded-full border border-[#bbbfc4]" style={{ background: activeInkColor }}/></button>{menu === "pen" && penSettings}</div>
      <button type="button" aria-label="关闭画笔工具" title="关闭画笔工具" className={tb} onClick={() => { setTool("select"); setMenu(null); }}><X size={16}/></button>
    </div>}

    {/* 左上：返回 */}
    <button type="button" onClick={requestClose} className={cn(floatBar, "absolute top-3 z-20 h-10 px-3 text-[14px]")} style={{ left: !readOnly && library && !compact ? 272 : 12 }} data-flow-done><ChevronLeft size={16} />{mindBoard ? "思维导图" : "流程图"}</button>

    {/* 右上：风格 / 自动排版 / AI 生成 / 导入 / 导出 */}
    <div className={cn(floatBar, "absolute right-3 top-3 z-20")}>
      {!readOnly && <>
        <div className="relative"><button type="button" aria-label="模板" title="模板" className={barBtn} onClick={() => setMenu(menu === "template" ? null : "template")} data-flow-template-btn><LayoutTemplate size={15} /><span className="hidden md:inline">模板</span></button>
          {menu === "template" && <div className={cn(pop, "right-0 w-60")}>{FLOW_TEMPLATES.map((t) => <button key={t.id} type="button" className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-hover" onClick={() => applyTemplate(t)}><span>{t.label}</span><span className="text-[12px] text-subtle">{t.desc}{graph.nodes.length ? "（追加到右侧）" : ""}</span></button>)}</div>}
        </div>
        <div className="relative"><button type="button" aria-label="风格" title="风格" className={barBtn} onClick={() => setMenu(menu === "theme" ? null : "theme")} data-flow-theme-btn><Palette size={15} /><span className="hidden md:inline">风格</span></button>
          {menu === "theme" && <div className={cn(pop, "right-0 grid w-[300px] grid-cols-3 gap-1.5 p-2")}>{THEMES.map((t) => <button key={t.id} type="button" onClick={() => { commit({ ...graph, theme: t.id }); setMenu(null); }} className={cn("rounded-md border p-1.5 text-center text-[12px] hover:border-primary", graph.theme === t.id && "border-primary text-primary")} data-flow-theme={t.id}><span className="mb-1 block h-8 rounded" style={{ background: t.canvas, border: `1px solid #DEE0E3` }}><span className="mx-auto mt-2 block h-4 w-10" style={{ background: t.palette ? t.palette[0].split("/")[0] : t.fill, border: `${t.strokeWidth}px solid ${t.palette ? t.palette[0].split("/")[1] : t.stroke}`, borderRadius: t.radius / 2 }} /></span>{t.label}</button>)}</div>}
        </div>
        <button type="button" aria-label="自动排版" disabled={!graph.nodes.length} className={barBtn} onClick={() => { const next = autoLayout(graph); commit(next); requestAnimationFrame(() => fit(next)); }} title={graph.nodes.length ? "按连线关系自动排版流程图" : "暂无流程图图形可排版"}><Spline size={15} /><span className="hidden md:inline">自动排版</span></button>
        <div className="relative"><button type="button" aria-label={mindBoard ? "AI 生成流程图" : "AI 生成"} className={cn(barBtn, !ai && "opacity-60")} onClick={() => (ai ? setMenu(menu === "ai" ? null : "ai") : openAISettings())} title={ai ? "用 AI 生成流程图" : "请先在 AI 设置中配置 API Key"} data-flow-ai-btn><Sparkles size={15} className="text-primary" /><span className="hidden md:inline">{mindBoard ? "AI 生成流程图" : "AI 生成"}</span></button>
          {menu === "ai" && ai && <div className={cn(pop, "right-0 w-[360px] p-3")}>
            <textarea autoFocus value={aiText} onChange={(e) => setAiText(e.target.value)} rows={4} maxLength={1000} placeholder="描述流程，例如：用户注册流程，包含填写信息、校验手机号、校验失败重试、创建账号、发送欢迎邮件" className="w-full select-text resize-none rounded-md border p-2 text-[13px] outline-none focus:border-primary" data-flow-ai-input />
            <div className="mt-2 flex items-center gap-2"><span className="text-[12px] text-subtle">{graph.nodes.length ? "结果将追加到画布右侧" : "结果会自动排版"}</span><button type="button" disabled={busy || !aiText.trim()} onClick={() => void runAI()} className="ml-auto flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[12px] text-white disabled:opacity-40">{busy && <Loader2 size={12} className="animate-spin" />}生成</button></div>
          </div>}
        </div>
        <button type="button" aria-label="导入 draw.io" title="导入 draw.io" className={barBtn} onClick={() => fileRef.current?.click()} data-flow-import><FileUp size={15} /><span className="hidden md:inline">导入 draw.io</span></button>
        <input ref={fileRef} type="file" accept=".drawio,.xml,.dio,application/xml,text/xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importDrawio(f); }} data-flow-import-input />
      </>}
      <div className="relative"><button type="button" aria-label="导出" title="导出" className={barBtn} onClick={() => setMenu(menu === "export" ? null : "export")}><Download size={15} /><span className="hidden md:inline">导出</span></button>
        {menu === "export" && <div className={cn(pop, "right-0 w-40")}>{([["png", "图片（PNG）"], ["svg", "矢量图（SVG）"], ["drawio", "draw.io 文件"]] as const).map(([k, l]) => <button key={k} type="button" className="flex h-8 w-full items-center rounded-md px-2 hover:bg-hover" onClick={() => void exportAs(k)}>{l}</button>)}</div>}
      </div>
    </div>
    {notice && <div role={notice.ok ? "status" : "alert"} className={cn("absolute left-1/2 top-16 z-20 max-w-[520px] -translate-x-1/2 rounded-md border bg-surface px-3 py-1.5 text-[12px] shadow", notice.ok ? "text-[#1F2329]" : "text-destructive")}>{notice.text}<button type="button" className="ml-2 text-subtle" onClick={() => setNotice(null)}>×</button></div>}

    {recovery.length > 0 && <div className="pointer-events-none absolute right-0 top-16 z-[95] flex justify-center px-3" style={{ left: !readOnly && library && !compact ? 260 : 0 }}><div ref={recoveryBannerRef} role="alert" className="pointer-events-auto flex w-full max-w-[480px] items-center gap-2 rounded-lg border border-[#ffd591] bg-[#fff7e6] px-3 py-2 text-[12px] text-[#7a4b00] shadow-md"><span>{recovery.some((item) => item.conflicts.includes("permission") || item.conflicts.includes("document")) ? "文档状态或编辑权限已变化" : "协作者修改了同一对象"}，部分操作未应用；原输入已暂存。</span><button type="button" className="ml-auto shrink-0 underline" onClick={() => setRecoveryOpen(true)}>查看未应用内容</button></div></div>}
    {recoveryOpen && <div className="fixed inset-0 z-[100] grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label={mindBoard ? "未应用的思维导图内容" : "未应用的流程图内容"}><div ref={recoveryDialogRef} className="max-h-[calc(100dvh-32px)] w-full max-w-[560px] overflow-y-auto rounded-xl border bg-surface p-4 shadow-xl"><h2 className="text-[16px] font-semibold">{mindBoard ? "未应用的思维导图内容" : "未应用的流程图内容"}</h2><p className="mt-2 text-[13px] text-subtle">请复制保留文字，或下载完整备份，再根据最新画布重新操作。关闭编辑器会丢失这些暂存内容。</p><textarea aria-label="未应用内容" readOnly value={describeUnappliedFlows(recovery)} className="mt-3 h-40 w-full select-text rounded-md border bg-surface p-3 text-[13px] outline-none"/><div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" className="rounded-md border px-3 py-1.5 text-[13px]" onClick={() => download(mindBoard ? "思维导图未应用内容.json" : "流程图未应用内容.json", new Blob([JSON.stringify({ version: 1, attempts: recovery }, null, 2)], { type: "application/json" }))}>下载完整备份</button><button type="button" className="rounded-md border px-3 py-1.5 text-[13px]" onClick={() => setRecoveryOpen(false)}>继续编辑</button><button type="button" className="rounded-md border px-3 py-1.5 text-[13px]" onClick={() => { recoveryRef.current = []; setRecovery([]); setRecoveryOpen(false); }}>已保留，清除暂存</button><button type="button" className="rounded-md bg-[#d83931] px-3 py-1.5 text-[13px] text-white" onClick={() => { recoveryRef.current = []; setRecovery([]); setRecoveryOpen(false); onClose(); }}>丢弃并退出</button></div></div></div>}

    {/* 右下：撤销重做、缩放 */}
    <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2">
      {!readOnly && <div className={floatBar}><button type="button" className={railBtn} title="撤销" disabled={!undo.length} onClick={doUndo}><Undo2 size={16} /></button><button type="button" className={railBtn} title="重做" disabled={!redo.length} onClick={doRedo}><Redo2 size={16} /></button></div>}
      <div className={floatBar}>
        <button type="button" className={cn(railBtn, hand && "bg-[#E1EAFF] text-primary")} title="抓手（拖动画布，也可按住空格）" onClick={() => setHand(!hand)} data-flow-hand><Hand size={16} /></button>
        <span className="mx-0.5 h-5 w-px bg-[#DEE0E3]" />
        <button type="button" className={railBtn} title="缩小" onClick={() => { autoFit.current = false; setView((v) => ({ ...v, zoom: Math.max(0.2, v.zoom / 1.2) })); }}><Minus size={16} /></button>
        <button type="button" className="h-8 w-12 rounded-md text-center text-[13px] hover:bg-hover" title="适应画布" onClick={() => fit()} data-flow-fit>{Math.round(view.zoom * 100)}%</button>
        <button type="button" className={railBtn} title="放大" onClick={() => { autoFit.current = false; setView((v) => ({ ...v, zoom: Math.min(3, v.zoom * 1.2) })); }}><Plus size={16} /></button>
      </div>
    </div>
  </div>, document.body);
}

/** Place an imported/AI graph to the right of the existing one with fresh IDs. */
export function appendGraph(base: FlowGraph, add: FlowGraph): FlowGraph {
  const b = flowBounds(base), a = flowBounds(add);
  const map = new Map(add.nodes.map((n) => [n.id, newFlowId("n")]));
  const dx = b.x + b.w + 120 - a.x, dy = b.y - a.y;
  return {
    ...base,
    nodes: [...base.nodes, ...add.nodes.map((n) => ({ ...n, id: map.get(n.id)!, x: n.x + dx, y: n.y + dy }))],
    edges: [...base.edges, ...add.edges.map((e) => ({ ...e, id: newFlowId("e"), from: map.get(e.from)!, to: map.get(e.to)!, ...(e.pts ? { pts: e.pts.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : {}), ...(e.mid !== undefined ? { mid: undefined } : {}) }))],
  };
}

/** Embed image nodes as data URLs so exported SVG/PNG files are self-contained. */
async function inlineImages(svg: string): Promise<string> {
  const hrefs = [...new Set([...svg.matchAll(/<image [^>]*href="([^"]+)"/g)].map((m) => m[1]))];
  let out = svg;
  for (const href of hrefs) {
    try {
      const blob = await (await fetch(href, { credentials: "same-origin" })).blob();
      const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(blob); });
      out = out.split(`href="${href}"`).join(`href="${data}"`);
    } catch { /* leave the reference; the image will be missing in the export */ }
  }
  return out;
}

/** Standalone SVG markup for export (theme colours inlined). */
export function svgMarkup(graph: FlowGraph): string {
  const holder = document.createElement("div");
  // Render synchronously via React DOM server is unavailable here; serialize the live preview instead.
  const live = document.querySelector<SVGSVGElement>("[data-flow-editor] [data-flow-svg]");
  if (!live) return "";
  const clone = live.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll("[data-mind-placeholder]").forEach((element) => element.remove());
  clone.querySelectorAll("[data-mind-fold-expanded]").forEach((element) => element.remove());
  clone.querySelectorAll("[data-mind-add]").forEach((element) => element.remove());
  clone.querySelectorAll("[data-mind-outline]").forEach((element) => element.setAttribute("stroke", "transparent"));
  const b = flowBounds(graph);
  clone.setAttribute("viewBox", `${b.x - 40} ${b.y - 40} ${b.w + 80} ${b.h + 80}`);
  clone.setAttribute("width", String(b.w + 80));
  clone.setAttribute("height", String(b.h + 80));
  clone.querySelectorAll("[data-flow-port],[data-flow-resize]").forEach((el) => el.remove());
  clone.querySelectorAll("[data-ink-selection]").forEach((el) => el.remove());
  clone.querySelectorAll("[data-ink-resize]").forEach((el) => el.remove());
  clone.querySelectorAll("rect[stroke-dasharray='4 3']").forEach((el) => el.remove());
  for (const stroke of graph.strokes ?? []) clone.querySelector(`[data-flow-stroke="${stroke.id}"] path:last-child`)?.setAttribute("stroke", stroke.color);
  holder.appendChild(clone);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${holder.innerHTML}`;
}

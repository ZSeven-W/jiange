import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QueryClientContext } from "@tanstack/react-query";
import { AlignCenter, AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceAround, AlignLeft, AlignRight, AlignStartHorizontal, AlignStartVertical, AlignVerticalSpaceAround, ArrowDownToLine, ArrowUpToLine, Bold, BoxSelect, Braces, Brush, ChevronDown, ChevronLeft, Circle, Copy, Diamond, Download, Eraser, FileUp, Frame, Hand, Highlighter, ImageIcon, Italic, LayoutTemplate, Link2, List, ListTree, Loader2, Map as MapIcon, Maximize2, MessageSquare, Minus, MoreHorizontal, Network, Pencil, RotateCcw, RotateCw, MousePointer2, Palette, Plus, Redo2, Search, Shapes, Sparkles, Spline, Square, StickyNote, Strikethrough, Tag, ThumbsUp, Timer, Trash2, Type, Underline, Undo2, Workflow, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { FeishuSelect } from "@/components/feishu-select";
import { useI18n } from "@/lib/i18n";
import { aiErrorText, openAISettings, type AIMessage } from "@/lib/ai";
import { autoLayout, boundedFlowOffset, bounds, flowBounds, flowIntentWrites, flowWrites, isContainer, moveFlowSelection, textArea, edgePath, midIsY, portPoint, measureLabel, newFlowId, normalizeEdge, normalizeNode, normalizeStroke, SHAPES, themeOf, THEMES, type EdgeKind, type FlowChangeOutcome, type FlowEdge, type FlowGraph, type FlowNode, type FlowStroke, type FlowTheme, type Port, type Shape } from "./model";
import { DrawioError, parseDrawio, toDrawio } from "./drawio";
import { flowchartPrompt, parseFlowchartAnswer } from "./ai";
import { FLOW_TEMPLATES, type FlowTemplate } from "./templates";
import { fitInsertedImage, pinchViewport, placeMindMenu, placeSelectionToolbar, resizeViewportCenter, type FlowPoint, type FlowViewport } from "./viewport";
import { describeUnappliedFlows, type UnappliedFlow } from "./recovery";
import { appliedFlowHistory, type FlowHistory } from "./history";
import { MindMapSvg } from "./mind-map-svg";
import { MindMapOutlineView } from "./mindmap-outline";
import { GPU_NATIVE_BOARD_SHAPES, WhiteboardGpuLayer } from "./whiteboard-gpu-layer";
import { WhiteboardMinimap, WhiteboardTimer } from "./whiteboard-minimap";
import { computeBoundaryBox, computeSummaryBrace, createStickyNode, EMPTY_WHITEBOARD_EXTRAS, MIND_BOUNDARY_COLORS, MIND_PRIORITIES, MIND_PROGRESS_STEPS, MIND_SUMMARY_COLORS, priorityBadgeMeta, readWhiteboardExtrasFromProps, STICKY_PRESETS, stickyPresetForFill, toggleNodeVote, topVotedNodes, whiteboardExtrasPropWrites, type BoardVotes, type MindBadge, type MindBadges, type MindBoundaries, type MindPriority, type MindProgress, type MindSummaries, type StickyPreset, type WhiteboardExtras } from "./whiteboard-extras";
import { mindNodeImageBounds, mindNodeImageSvg, rasterizeMindNode } from "./mind-node-image";
import { canonicalMindDescription, mindDefaultTextColor, mindDescriptionAt, mindDescriptionLines, mindDescriptionStyleAt, type MindDescriptionStyle, type MindPaint, type MindStyle, type MindTextFormat, type MindTopic } from "./mindmap";
import { layoutMindTopicsWithStructure, MIND_LAYOUT_OPTIONS, mindLayoutPropWrites, mindRelationCurvePath, mindRelationLabelPoint, readMindLayoutFromProps, type MindLayoutKind, type MindRelation } from "./mindmap-layouts";
import { boardFramePropWrites, createBoardFrame, exportFrameToSvg, moveFrameWithContents, readBoardFramesFromProps, type BoardFrame } from "./board-frames";
import { applyMindTextStyle, captureMindTextStyle, getMindTextStyleSession, getMindTextStyleSessionRevision, mindTextStyleFromHtml, mindTextStyleHtml, mindTextStyleShortcut, setMindTextStyleSession } from "./mindmap-text-style";
import { insertMindParent, mindDropAt, moveMindTopic, type MindDrop } from "./mindmap-move";
import { copyMindBranch, MIND_CLIP_MIME, mindClipFromHtml, mindClipHtml, mindClipText, parseMindClip, pasteMindBranch, type MindClip } from "./mindmap-clipboard";
import { inkHitByEraser, inkPointBounds, scaleInk, scaleSelectionProportionally, selectionBounds, type SelectionBox } from "./ink-geometry";
import { exportMindMapToXmind, parseXmindToMindMap, XmindError } from "@jiange/whiteboard-sdk/xmind";
import type { FlowCommentAnchor } from "@jiange/whiteboard-sdk/comment-anchor";
import { BoardCommentComposer, BoardCommentPinsSvg, BoardCommentThreadPopover, resolveBoardCommentPins, type BoardCommentActions, type ResolvedBoardPin } from "./board-comments";
import type { Comment, Me } from "@/lib/api";
import { copyClipboardAssetsWithRetry, planClipboardAssets } from "../clipboard-assets";
import { subscribeAuthChanges, subscribeLocalAuthChanges } from "@/lib/session-cache";
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
  if (n.shape === "sticky") {
    const preset = stickyPresetForFill(n.fill);
    const fill = n.fill ?? preset.fill;
    return { fill, stroke: n.stroke ?? preset.stroke, text: n.color ?? readableOn(fill) };
  }
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
    case "sticky": {
      const k = Math.min(22, Math.max(10, Math.min(w, h) * 0.16));
      const r = Math.min(4, w / 10, h / 10);
      const preset = stickyPresetForFill(fill !== "none" ? fill : n.fill);
      const isIcon = fill === "none";
      const bodyPath = `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - k} L${x + w - k},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
      const foldPath = `M${x + w - k},${y + h} V${y + h - k + 2} Q${x + w - k},${y + h - k} ${x + w - k + 2},${y + h - k} H${x + w} Z`;
      return (
        <g data-sticky-shape={isIcon ? undefined : n.id}>
          <path d={bodyPath} fill={fill} stroke={stroke} strokeWidth={isIcon ? theme.strokeWidth : 1} />
          {!isIcon && <rect x={x + 1} y={y + 1} width={Math.max(0, w - 2)} height={Math.min(8, h * 0.1)} rx={2} fill="#FFFFFF" fillOpacity={0.28} pointerEvents="none" />}
          <path d={foldPath} fill={isIcon ? "none" : preset.fold} stroke={stroke} strokeWidth={isIcon ? theme.strokeWidth * 0.8 : 0.9} strokeLinejoin="round" />
        </g>
      );
    }
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

const SVG_PAIR_RE = /(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?),(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi;

function svgPathBounds(d: string, pad = 0): { x: number; y: number; w: number; h: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  SVG_PAIR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SVG_PAIR_RE.exec(d)) !== null) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    x: minX - pad,
    y: minY - pad,
    w: Math.max(0, maxX - minX) + pad * 2,
    h: Math.max(0, maxY - minY) + pad * 2,
  };
}

function rotatedNodeBox(n: FlowNode): { x: number; y: number; w: number; h: number } {
  if (!n.rot) return { x: n.x, y: n.y, w: n.w, h: n.h };
  const rad = (n.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  const corners = [
    [n.x, n.y],
    [n.x + n.w, n.y],
    [n.x + n.w, n.y + n.h],
    [n.x, n.y + n.h],
  ].map(([px, py]) => {
    const dx = px - cx;
    const dy = py - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos] as const;
  });
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

export function boardContentBounds(
  graph: FlowGraph,
  mindStructure: MindLayoutKind = "logic",
  frames: readonly BoardFrame[] = [],
  mindCollapsed?: ReadonlySet<string>,
  mindRelations?: readonly MindRelation[],
  mindBoundaries?: MindBoundaries,
  mindSummaries?: MindSummaries,
  mindBadges?: MindBadges,
): { x: number; y: number; w: number; h: number } {
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (graph.nodes.length || graph.strokes?.length || (graph.mind?.length && mindStructure === "logic")) {
    boxes.push(flowBounds(graph));
  }
  for (const n of graph.nodes) {
    if (n.rot) boxes.push(rotatedNodeBox(n));
  }
  if (graph.edges.length && graph.nodes.length) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const e of graph.edges) {
      const a = byId.get(e.from);
      const t = byId.get(e.to);
      if (!a || !t) continue;
      const routed = edgePath(e, a, t);
      const pathBox = svgPathBounds(routed.d, 10);
      if (pathBox) boxes.push(pathBox);
      if (e.pts?.length) {
        for (const pt of e.pts) boxes.push({ x: pt.x - 10, y: pt.y - 10, w: 20, h: 20 });
      }
      if (e.label) {
        const halfW = Math.max(18, measureLabel(e.label, 0) / 2);
        const halfH = 14;
        boxes.push({ x: routed.mid.x - halfW, y: routed.mid.y - halfH, w: halfW * 2, h: halfH * 2 });
      }
    }
  }
  const hasMindExtras =
    !!(mindBoundaries && Object.keys(mindBoundaries).length) ||
    !!(mindSummaries && Object.keys(mindSummaries).length) ||
    !!(mindBadges && Object.keys(mindBadges).length);
  let placedMind: ReturnType<typeof layoutMindTopicsWithStructure> | null = null;
  if (graph.mind?.length && (mindStructure !== "logic" || mindRelations?.length || hasMindExtras)) {
    const collapsed = mindCollapsed ?? new Set(graph.mindCollapsed ?? []);
    placedMind = layoutMindTopicsWithStructure(
      graph.mind,
      mindStructure,
      collapsed,
      graph.mindStyles,
      graph.mindDescriptions,
      graph.mindDescriptionStyles,
    );
    if (mindStructure !== "logic") {
      for (const p of placedMind) boxes.push({ x: p.x, y: p.y, w: p.w, h: p.h });
    }
  }
  if (placedMind && mindRelations?.length) {
    const byTopic = new Map(placedMind.map((p) => [p.topic.id, p]));
    for (const rel of mindRelations) {
      const fromPos = byTopic.get(rel.fromId);
      const toPos = byTopic.get(rel.toId);
      if (!fromPos || !toPos) continue;
      const relBox = svgPathBounds(mindRelationCurvePath(fromPos, toPos), 10);
      if (relBox) boxes.push(relBox);
      if (rel.label) {
        const pt = mindRelationLabelPoint(fromPos, toPos);
        const halfW = Math.max(18, measureLabel(rel.label, 0) / 2);
        boxes.push({ x: pt.x - halfW, y: pt.y - 14, w: halfW * 2, h: 28 });
      }
    }
  }
  if (placedMind && graph.mind?.length) {
    if (mindBoundaries) {
      for (const nodeId of Object.keys(mindBoundaries)) {
        const bBox = computeBoundaryBox(nodeId, graph.mind, placedMind);
        if (bBox) boxes.push({ x: bBox.x, y: bBox.y - 12, w: bBox.w, h: bBox.h + 12 });
      }
    }
    if (mindSummaries) {
      for (const [parentId, summary] of Object.entries(mindSummaries)) {
        const brace = computeSummaryBrace(parentId, graph.mind, placedMind, mindStructure, summary.label);
        if (brace) boxes.push(brace.box);
      }
    }
    if (mindBadges) {
      for (const p of placedMind) {
        if (mindBadges[p.topic.id]) {
          boxes.push({ x: p.x, y: p.y - 22, w: Math.max(p.w, 120), h: p.h + 22 });
        }
      }
    }
  }
  for (const f of frames) {
    const pillW = Math.max(74, Math.min(220, measureLabel(f.title || "Frame", 64)));
    boxes.push({ x: f.x, y: f.y - 32, w: Math.max(f.w, pillW), h: f.h + 32 });
  }
  if (!boxes.length) return flowBounds(graph);
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

export function FlowSvg({ graph, width, height, viewBox, preserveAspectRatio = "xMidYMid meet", selected, editing, frames, selectedFrameId, editingFrameId, onFrameHeaderDown, onFrameResizeDown, onFrameTitleDoubleClick, onFrameExport, onFrameDelete, votes, currentUserId, votingMode, onToggleVote, onNodeDown, onEdgeDown, onStrokeDown, onStrokeResize, resizeStroke, groupBox, groupScalePct, onGroupScale, commentPins, activePinId, pinZoom, onPinSelect, erasing, draftStroke, mindSelected, mindEditing, mindDescriptionEditing, mindCollapsed, mindDragPreview, mindStructure = "logic", mindRelations, mindRelationFrom, onRemoveMindRelation, mindBoundaries, mindSummaries, mindBadges, onEditMindBoundary, onEditMindSummary, onMindFold, onMindAddChild, onMindSelect, onMindContextMenu, onMindEdit, onMindDraft, onMindFinish, onMindCancel, onMindEditDescription, onMindDescriptionDraft, onMindDescriptionFinish, onMindDescriptionCancel, onPortDown, onCanvasDown, onNodeDouble, onEdgeDouble, connectPreview, idPrefix = "fc", transparent, gpuBacked = false, guides, marquee, rotateHandle, bendHandle, peerSel, onWaypointRemove, touchZoom, fileUrl = (id: number) => `/api/files/${id}` }: {
  graph: FlowGraph; width?: number | string; height?: number | string; viewBox?: string; preserveAspectRatio?: string;
  selected?: Set<string>; editing?: string | null;
  frames?: readonly BoardFrame[];
  selectedFrameId?: string | null;
  editingFrameId?: string | null;
  onFrameHeaderDown?: (e: React.PointerEvent, frame: BoardFrame) => void;
  onFrameResizeDown?: (e: React.PointerEvent, frame: BoardFrame) => void;
  onFrameTitleDoubleClick?: (frame: BoardFrame) => void;
  onFrameExport?: (frame: BoardFrame) => void;
  onFrameDelete?: (frame: BoardFrame) => void;
  votes?: BoardVotes;
  currentUserId?: string;
  votingMode?: boolean;
  onToggleVote?: (nodeId: string) => void;
  onNodeDown?: (e: React.PointerEvent, n: FlowNode) => void;
  onEdgeDown?: (e: React.PointerEvent, edge: FlowEdge) => void;
  onStrokeDown?: (e: React.PointerEvent, stroke: FlowStroke) => void;
  onStrokeResize?: (e: React.PointerEvent, stroke: FlowStroke) => void;
  resizeStroke?: string | null;
  groupBox?: SelectionBox | null;
  groupScalePct?: number | null;
  onGroupScale?: (e: React.PointerEvent) => void;
  commentPins?: readonly ResolvedBoardPin[];
  activePinId?: number | null;
  pinZoom?: number;
  onPinSelect?: (pin: ResolvedBoardPin, event: React.PointerEvent<SVGGElement>) => void;
  erasing?: ReadonlySet<string> | null;
  draftStroke?: FlowStroke | null;
  mindSelected?: string | null;
  mindCollapsed?: ReadonlySet<string>;
  mindDragPreview?: { id: string; x: number; y: number; drop: MindDrop | null } | null;
  mindStructure?: MindLayoutKind;
  mindRelations?: readonly MindRelation[];
  mindRelationFrom?: string | null;
  onRemoveMindRelation?: (id: string) => void;
  mindBoundaries?: MindBoundaries;
  mindSummaries?: MindSummaries;
  mindBadges?: MindBadges;
  onEditMindBoundary?: (nodeId: string) => void;
  onEditMindSummary?: (parentId: string) => void;
  onMindFold?: (id: string) => void;
  onMindAddChild?: (id: string) => void;
  mindEditing?: { id: string; value: string } | null;
  mindDescriptionEditing?: { id: string; value: string } | null;
  onMindSelect?: (topic: MindTopic, event: React.PointerEvent<SVGGElement>) => void;
  onMindContextMenu?: (topic: MindTopic, event: React.MouseEvent<SVGGElement>) => void;
  onMindEdit?: (topic: MindTopic) => void;
  onMindDraft?: (value: string) => void;
  onMindFinish?: () => void;
  onMindCancel?: () => void;
  onMindEditDescription?: (topic: MindTopic) => void;
  onMindDescriptionDraft?: (value: string) => void;
  onMindDescriptionFinish?: () => void;
  onMindDescriptionCancel?: () => void;
  onPortDown?: (e: React.PointerEvent, n: FlowNode, port: Port) => void;
  onCanvasDown?: (e: React.PointerEvent) => void;
  onNodeDouble?: (n: FlowNode) => void;
  onEdgeDouble?: (edge: FlowEdge) => void;
  connectPreview?: { x1: number; y1: number; x2: number; y2: number } | null;
  idPrefix?: string;
  /** 编辑器内使用：背景透明，露出点阵网格。 */
  transparent?: boolean;
  /** When backed by WebGPU / WebGL2 SDF canvas, keep hit targets/text/exotic shapes while hiding GPU-drawn geometry. */
  gpuBacked?: boolean;
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
  const { t } = useI18n();
  const theme = themeOf(graph.theme);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const b = boardContentBounds(graph, mindStructure, frames, mindCollapsed, mindRelations, mindBoundaries, mindSummaries, mindBadges);
  const vb = viewBox ?? `${b.x - 40} ${b.y - 40} ${Math.max(200, b.w + 80)} ${Math.max(120, b.h + 80)}`;
  const filter = theme.sketch ? `url(#${idPrefix}-sketch)` : theme.shadow ? `url(#${idPrefix}-shadow)` : undefined;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={vb} preserveAspectRatio={preserveAspectRatio} className={cn("block max-w-full", gpuBacked && "relative z-[1]")} style={{ background: transparent ? "transparent" : theme.canvas, fontFamily: theme.font }} onPointerDown={onCanvasDown} data-flow-svg>
      <defs>
        <marker id={`${idPrefix}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={theme.edge} /></marker>
        <filter id={`${idPrefix}-sketch`} filterUnits="userSpaceOnUse" x="-20000" y="-20000" width="60000" height="60000"><feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="3" /><feDisplacementMap in="SourceGraphic" scale="2.2" /></filter>
        <filter id={`${idPrefix}-shadow`} x="-10%" y="-10%" width="130%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#1F2329" floodOpacity="0.12" /></filter>
        <filter id={`${idPrefix}-sticky-shadow`} x="-14%" y="-12%" width="134%" height="142%"><feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#1F2329" floodOpacity="0.14" /></filter>
      </defs>
      {frames?.map((frame) => {
        const isSel = selectedFrameId === frame.id;
        const isEditingTitle = editingFrameId === frame.id;
        const pillW = Math.max(74, Math.min(220, measureLabel(frame.title || "Frame", 64)));
        const headerY = frame.y - 30;
        return (
          <g key={frame.id} data-board-frame={frame.id}>
            <rect
              x={frame.x}
              y={frame.y}
              width={frame.w}
              height={frame.h}
              rx={10}
              fill={frame.bg ?? "#F8FAFF"}
              fillOpacity={0.62}
              stroke={isSel ? "#3370FF" : "#9AA5B8"}
              strokeWidth={isSel ? 2 : 1.5}
              strokeDasharray={isSel ? undefined : "6 4"}
              pointerEvents="none"
            />
            <g
              data-board-frame-header={frame.id}
              style={{ cursor: onFrameHeaderDown ? "move" : undefined }}
              onPointerDown={onFrameHeaderDown ? (e) => { e.stopPropagation(); onFrameHeaderDown(e, frame); } : undefined}
              onDoubleClick={onFrameTitleDoubleClick ? (e) => { e.stopPropagation(); onFrameTitleDoubleClick(frame); } : undefined}
            >
              <rect
                x={frame.x}
                y={headerY}
                width={pillW}
                height={24}
                rx={6}
                fill={isSel ? "#3370FF" : "#EEF2FF"}
                stroke={isSel ? "#3370FF" : "#C9D7FF"}
                strokeWidth={1}
              />
              {!isEditingTitle && (
                <text
                  x={frame.x + 10}
                  y={headerY + 12}
                  dominantBaseline="central"
                  fontSize={12}
                  fontWeight={500}
                  fill={isSel ? "#FFFFFF" : "#1F2329"}
                  pointerEvents="none"
                >
                  {frame.title || "Frame"}
                </text>
              )}
            </g>
            {onFrameExport && (
              <g
                data-board-frame-export={frame.id}
                role="button"
                aria-label={t("导出分区 {title}", { title: frame.title })}
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onFrameExport(frame); }}
              >
                <rect
                  x={frame.x + pillW + 6}
                  y={headerY}
                  width={62}
                  height={24}
                  rx={6}
                  fill="#FFFFFF"
                  stroke="#DEE0E3"
                  strokeWidth={1}
                />
                <text
                  x={frame.x + pillW + 37}
                  y={headerY + 12}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={11}
                  fill="#1F2329"
                  pointerEvents="none"
                >
                  {t("导出分区")}
                </text>
              </g>
            )}
            {onFrameDelete && (
              <g
                data-board-frame-delete={frame.id}
                role="button"
                aria-label={t("删除分区 {title}", { title: frame.title })}
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onFrameDelete(frame); }}
              >
                <rect
                  x={frame.x + pillW + 72}
                  y={headerY}
                  width={22}
                  height={24}
                  rx={6}
                  fill="#FFFFFF"
                  stroke="#DEE0E3"
                  strokeWidth={1}
                />
                <text
                  x={frame.x + pillW + 83}
                  y={headerY + 12}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={13}
                  fill="#646A73"
                  pointerEvents="none"
                >
                  ×
                </text>
              </g>
            )}
            {isSel && onFrameResizeDown && (
              <g
                data-board-frame-resize={frame.id}
                style={{ cursor: "nwse-resize" }}
                onPointerDown={(e) => { e.stopPropagation(); onFrameResizeDown(e, frame); }}
              >
                <rect x={frame.x + frame.w - 10} y={frame.y + frame.h - 10} width={16} height={16} fill="transparent" />
                <rect x={frame.x + frame.w - 5} y={frame.y + frame.h - 5} width={10} height={10} rx={2} fill="#3370FF" stroke="#FFFFFF" strokeWidth={1.5} pointerEvents="none" />
              </g>
            )}
          </g>
        );
      })}
      {[...(graph.strokes ?? []), ...(draftStroke ? [draftStroke] : [])].map((stroke) => {
        const d = stroke.points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ") + (stroke.points.length === 1 ? " l0.01,0.01" : "");
        return <g key={stroke.id} data-flow-stroke={stroke.id} opacity={erasing?.has(stroke.id) ? 0.2 : undefined}>
          <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(touchZoom ? 28 / touchZoom : 16, stroke.width + 12)} strokeLinecap="round" strokeLinejoin="round" onPointerDown={onStrokeDown && stroke !== draftStroke ? (event) => onStrokeDown(event, stroke) : undefined}/>
          {!gpuBacked && selected?.has(stroke.id) && <path d={d} fill="none" stroke="#3370FF" strokeOpacity={0.35} strokeWidth={stroke.width + 5} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" data-ink-selection/>}
          {!gpuBacked && <path d={d} fill="none" stroke={stroke.color} strokeOpacity={stroke.marker ? 0.35 : undefined} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"/>}
        </g>;
      })}
      {!!graph.mind?.length && <MindMapSvg topics={graph.mind} structure={mindStructure} relations={mindRelations} relationFromId={mindRelationFrom} onRemoveRelation={onRemoveMindRelation} boundaries={mindBoundaries} summaries={mindSummaries} badges={mindBadges} onEditBoundary={onEditMindBoundary} onEditSummary={onEditMindSummary} styles={graph.mindStyles} paints={graph.mindPaints} textFormats={graph.mindTextFormats} descriptions={graph.mindDescriptions} descriptionStyles={graph.mindDescriptionStyles} collapsed={mindCollapsed ?? new Set(graph.mindCollapsed ?? [])} dragPreview={mindDragPreview} gpuBacked={gpuBacked && mindStructure === "logic"} onFold={onMindFold} onAddChild={onMindAddChild} selected={mindSelected} editing={mindEditing} descriptionEditing={mindDescriptionEditing} onSelect={onMindSelect} onContextMenu={onMindContextMenu} onEdit={onMindEdit} onDraft={onMindDraft} onFinish={onMindFinish} onCancel={onMindCancel} onEditDescription={onMindEditDescription} onDescriptionDraft={onMindDescriptionDraft} onDescriptionFinish={onMindDescriptionFinish} onDescriptionCancel={onMindDescriptionCancel}/>}
      {graph.edges.map((e) => {
        const a = byId.get(e.from), t = byId.get(e.to);
        if (!a || !t) return null;
        const { d, mid } = edgePath(e, a, t);
        const color = e.color ?? theme.edge;
        const sel = selected?.has(e.id);
        const gpuEdge = gpuBacked && (e.kind ?? "orthogonal") !== "curve";
        return <g key={e.id} data-flow-edge={e.id}>
          <path d={d} fill="none" stroke="transparent" strokeWidth={touchZoom ? Math.max(12, 28 / touchZoom) : 12} style={{ cursor: onEdgeDown ? "pointer" : undefined }} onPointerDown={onEdgeDown ? (ev) => onEdgeDown(ev, e) : undefined} onDoubleClick={onEdgeDouble ? () => onEdgeDouble(e) : undefined} />
          {!gpuEdge && <path d={d} fill="none" stroke={sel ? "#3370FF" : color} strokeWidth={sel ? 2.2 : 1.5} strokeDasharray={e.dashed ? "6 4" : undefined} filter={theme.sketch ? filter : undefined} markerEnd={e.arrow === "none" ? undefined : `url(#${idPrefix}-arrow)`} markerStart={e.arrow === "both" ? `url(#${idPrefix}-arrow)` : undefined} pointerEvents="none" />}
          {e.label && <g pointerEvents="none"><rect x={mid.x - measureLabel(e.label, 0) / 2 + 10} y={mid.y - 10} width={Math.max(20, measureLabel(e.label, 0) - 20)} height={20} rx={4} fill={theme.canvas} /><text x={mid.x} y={mid.y + 4} textAnchor="middle" fontSize={12} fill={theme.text}>{e.label}</text></g>}
        </g>;
      })}
      {graph.nodes.map((n) => {
        const c = nodeColors(n, theme);
        const sel = selected?.has(n.id);
        const peer = peerSel?.find((p) => p.ids.includes(n.id));
        const gpuNode = gpuBacked && GPU_NATIVE_BOARD_SHAPES.has(n.shape);
        const nodeFilter = n.shape === "sticky" ? `url(#${idPrefix}-sticky-shadow)` : n.shape === "image" || gpuNode ? undefined : filter;
        const voters = votes?.[n.id] ?? [];
        const voteCount = voters.length;
        const votedByMe = !!currentUserId && voters.includes(currentUserId);
        const voteLabel = `👍 ${voteCount}`;
        const votePillW = Math.max(38, voteLabel.length * 8 + 12);
        return <g key={n.id} data-flow-node={n.id} transform={n.rot ? `rotate(${n.rot} ${n.x + n.w / 2} ${n.y + n.h / 2})` : undefined} style={{ cursor: votingMode ? "pointer" : onNodeDown ? "move" : undefined }} onPointerDown={onNodeDown ? (ev) => onNodeDown(ev, n) : undefined} onDoubleClick={onNodeDouble ? () => onNodeDouble(n) : undefined}>
          <g filter={nodeFilter}><ShapeOutline n={n} theme={theme} fill={gpuNode ? "transparent" : c.fill} stroke={gpuNode ? "transparent" : c.stroke} fileUrl={fileUrl} /></g>
          {editing !== n.id && <NodeText n={n} fill={c.text} />}
          {voteCount > 0 && (
            <g
              data-board-vote-badge={n.id}
              data-board-vote-count={voteCount}
              style={{ cursor: onToggleVote ? "pointer" : undefined }}
              onPointerDown={onToggleVote ? (ev) => { ev.stopPropagation(); onToggleVote(n.id); } : undefined}
            >
              <rect
                x={n.x + n.w - votePillW + 6}
                y={n.y - 12}
                width={votePillW}
                height={22}
                rx={11}
                fill={votedByMe ? "#3370FF" : "#FFF3D6"}
                stroke={votedByMe ? "#245BDB" : "#F0B400"}
                strokeWidth={1.2}
              />
              <text
                x={n.x + n.w - votePillW / 2 + 6}
                y={n.y - 1}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fontWeight={600}
                fill={votedByMe ? "#FFFFFF" : "#9A5B00"}
                pointerEvents="none"
              >
                {voteLabel}
              </text>
            </g>
          )}
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
      {groupBox && onGroupScale && (() => {
        const pad = 8 / (touchZoom ?? 1), cx = groupBox.x + groupBox.w + pad, cy = groupBox.y + groupBox.h + pad, hit = (touchZoom ? 28 / touchZoom : 16);
        return <g data-flow-group-box>
          <rect x={groupBox.x - pad} y={groupBox.y - pad} width={groupBox.w + pad * 2} height={groupBox.h + pad * 2} rx={4 / (touchZoom ?? 1)} fill="none" stroke="#3370FF" strokeWidth={1.6 / (touchZoom ?? 1)} strokeDasharray="5 3" pointerEvents="none"/>
          <g data-flow-group-resize onPointerDown={(event) => { event.stopPropagation(); onGroupScale(event); }} style={{ cursor: "nwse-resize" }}>
            <rect x={cx - hit / 2} y={cy - hit / 2} width={hit} height={hit} fill="transparent"/>
            <rect x={cx - 5 / (touchZoom ?? 1)} y={cy - 5 / (touchZoom ?? 1)} width={10 / (touchZoom ?? 1)} height={10 / (touchZoom ?? 1)} rx={2 / (touchZoom ?? 1)} fill="#3370FF" stroke="#fff" strokeWidth={1.5 / (touchZoom ?? 1)} pointerEvents="none"/>
          </g>
          {typeof groupScalePct === "number" && <g transform={`translate(${cx + 8 / (touchZoom ?? 1)} ${cy + 4 / (touchZoom ?? 1)})`} pointerEvents="none">
            <rect x={0} y={-12 / (touchZoom ?? 1)} width={44 / (touchZoom ?? 1)} height={18 / (touchZoom ?? 1)} rx={4 / (touchZoom ?? 1)} fill="#3370FF"/>
            <text x={22 / (touchZoom ?? 1)} y={1 / (touchZoom ?? 1)} textAnchor="middle" fontSize={11 / (touchZoom ?? 1)} fill="#FFFFFF" fontWeight={600}>{groupScalePct}%</text>
          </g>}
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
      {!!commentPins?.length && <BoardCommentPinsSvg pins={commentPins} activeId={activePinId} zoom={pinZoom} onSelect={onPinSelect} />}
    </svg>
  );
}

/* ---------------- inline block ---------------- */

/** 文档内的流程图块：预览 + 打开全屏编辑器（对应飞书在文档中打开画板）。 */
export type FlowUpload = (f: File) => Promise<{ id: number; name: string; mime: string }>;
export type FlowAssets = { docId: number; copy?: (sourceDocId: number, fileIds: number[], requestId: string, signal: AbortSignal) => Promise<{ mapping: Record<string, number> }> };

export function FlowchartBlock({ graph, blockProps, height, readOnly, autoOpen, ai, onChange, onProps, peers, onPresence, onComment, comments, activeThread, commentActions, upload, assets, canCopy = true, currentUserId }: {
  graph: FlowGraph; blockProps?: Record<string, string>; height: number; readOnly: boolean; autoOpen?: boolean;
  ai?: (messages: AIMessage[]) => Promise<string>;
  onChange?: (next: FlowGraph, base: FlowGraph, extraProps?: Record<string, string>) => FlowChangeOutcome;
  onProps?: (patch: Record<string, string>) => void;
  peers?: FlowPeer[];
  onPresence?: (p: FlowPresence | null) => void;
  onComment?: (quote: string) => void;
  comments?: Comment[];
  activeThread?: number | null;
  commentActions?: BoardCommentActions;
  upload?: FlowUpload;
  assets?: FlowAssets;
  canCopy?: boolean;
  currentUserId?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(!!autoOpen && !readOnly);
  const previewFrames = useMemo(() => (blockProps ? readBoardFramesFromProps(blockProps) : []), [blockProps]);
  const previewMindCfg = useMemo(
    () => (blockProps ? readMindLayoutFromProps(blockProps) : { structure: "logic" as MindLayoutKind, relations: [] as MindRelation[] }),
    [blockProps],
  );
  const previewExtras = useMemo(
    () => (blockProps ? readWhiteboardExtrasFromProps(blockProps) : EMPTY_WHITEBOARD_EXTRAS),
    [blockProps],
  );
  const previewPins = useMemo(() => resolveBoardCommentPins(comments, graph), [comments, graph]);
  return <div contentEditable={false} className="group/flow relative w-full max-w-full overflow-hidden rounded-lg border border-transparent transition-colors hover:border-[#DEE0E3] focus-within:border-[#3370FF] dark:hover:border-border" style={{ height }} data-flowchart>
    {graph.nodes.length || graph.strokes?.length || graph.mind?.length || previewFrames.length ? <FlowSvg graph={graph} frames={previewFrames} votes={previewExtras.votes} currentUserId={currentUserId} mindStructure={previewMindCfg.structure} mindRelations={previewMindCfg.relations} mindBoundaries={previewExtras.mindBoundaries} mindSummaries={previewExtras.mindSummaries} mindBadges={previewExtras.mindBadges} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" idPrefix="fcp" commentPins={previewPins} activePinId={activeThread} /> : <div className="grid h-full place-items-center bg-[#F8F9FA] text-[13px] text-subtle dark:bg-hover"><span className="flex items-center gap-1.5"><Workflow size={16} />{readOnly ? t("空白流程图") : t("空白流程图，点击「编辑」开始绘制")}</span></div>}
    <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/flow:opacity-100 [@media(hover:none)]:opacity-100">
      {previewPins.length > 0 && <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(true)} className="flex h-7 items-center gap-1 rounded-md border border-[#FFD591] bg-[#FFF7E6] px-2 text-[12px] font-medium text-[#B25900] shadow-sm hover:bg-[#FFECCC]" data-flow-preview-pins><MessageSquare size={12} />{previewPins.length}</button>}
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(true)} className="flex h-7 items-center gap-1 rounded-md border bg-surface px-2 text-[12px] shadow-sm hover:bg-hover" data-flow-open>{readOnly ? <><Maximize2 size={13} />{t("查看")}</> : <><Workflow size={13} />{t("编辑")}</>}</button>
    </div>
    {!!peers?.length && <div className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-surface/90 px-1.5 py-0.5 text-[12px] text-subtle shadow-sm" data-flow-peers>{peers.slice(0, 3).map((p) => <span key={p.id} className="grid size-5 place-items-center rounded-full text-[11px] text-white" style={{ background: p.color }} title={p.name}>{[...p.name][0]}</span>)}{t("正在编辑")}</div>}
    {open && <FlowchartEditor initial={graph} blockProps={blockProps} readOnly={readOnly} ai={ai} onChange={onChange} onProps={onProps} onClose={() => { onPresence?.(null); setOpen(false); }} peers={peers} onPresence={onPresence} onComment={onComment} comments={comments} activeThread={activeThread} commentActions={commentActions} upload={upload} assets={assets} canCopy={canCopy} currentUserId={currentUserId} />}
  </div>;
}

/* ---------------- full-screen editor ---------------- */

type Drag =
  | { kind: "mind"; id: string; pointerId: number; startX: number; startY: number; currentX: number; currentY: number; base: FlowGraph }
  | { kind: "move"; ids: string[]; startX: number; startY: number; origin: Map<string, { x: number; y: number }>; strokeOrigin: Map<string, FlowStroke> }
  | { kind: "frame-move"; frameId: string; startX: number; startY: number; frameOrigin: BoardFrame; baseGraph: FlowGraph; framesOrigin: BoardFrame[] }
  | { kind: "frame-resize"; frameId: string; startX: number; startY: number; frameOrigin: BoardFrame; framesOrigin: BoardFrame[] }
  | { kind: "resize"; id: string; startX: number; startY: number; w: number; h: number }
  | { kind: "ink-resize"; id: string; startX: number; startY: number; stroke: FlowStroke }
  | { kind: "group-scale"; startX: number; startY: number; box: SelectionBox; nodes: FlowNode[]; strokes: FlowStroke[]; scale: number }
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
const INK_WIDTHS = [2, 3, 5, 8, 12] as const;
const MARKER_WIDTHS = [8, 12, 16, 20, 24] as const;

type EditorHistory = FlowHistory & {
  beforeProps?: Record<string, string>;
  afterProps?: Record<string, string>;
};

export function FlowchartEditor({ initial, blockProps, readOnly, ai, onChange, onProps, onClose, peers = [], onPresence, onComment, comments, activeThread, commentActions, upload, assets, canCopy = true, currentUserId }: {
  initial: FlowGraph; blockProps?: Record<string, string>; readOnly: boolean;
  ai?: (messages: AIMessage[]) => Promise<string>;
  onChange?: (next: FlowGraph, base: FlowGraph, extraProps?: Record<string, string>) => FlowChangeOutcome;
  onProps?: (patch: Record<string, string>) => void;
  onClose: () => void;
  peers?: FlowPeer[];
  onPresence?: (p: FlowPresence | null) => void;
  onComment?: (quote: string) => void;
  comments?: Comment[];
  activeThread?: number | null;
  commentActions?: BoardCommentActions;
  upload?: FlowUpload;
  assets?: FlowAssets;
  canCopy?: boolean;
  currentUserId?: string;
}) {
  const { t } = useI18n();
  const qc = useContext(QueryClientContext);
  const resolvedUserId = useMemo(() => {
    if (currentUserId) return currentUserId;
    const me = qc?.getQueryData<Me>(["me"]);
    return me?.user?.id ? `u${me.user.id}` : "self";
  }, [currentUserId, qc]);
  const [graph, setGraph] = useState(initial);
  const mindBoard = useRef(!!initial.mind?.length && !initial.nodes.length && !initial.strokes?.length).current;
  const [undo, setUndo] = useState<EditorHistory[]>([]);
  const [redo, setRedo] = useState<EditorHistory[]>([]);
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
  const [gpuActive, setGpuActive] = useState(false);
  const hasCrdtProps = blockProps !== undefined;
  const crdtFrames = useMemo(() => (blockProps ? readBoardFramesFromProps(blockProps) : []), [blockProps]);
  const crdtMindCfg = useMemo(
    () => (blockProps ? readMindLayoutFromProps(blockProps) : { structure: "logic" as MindLayoutKind, relations: [] as MindRelation[] }),
    [blockProps],
  );
  const crdtExtras = useMemo(
    () => (blockProps ? readWhiteboardExtrasFromProps(blockProps) : EMPTY_WHITEBOARD_EXTRAS),
    [blockProps],
  );
  const [localFrames, setLocalFrames] = useState<BoardFrame[]>([]);
  const [dragFrames, setDragFrames] = useState<BoardFrame[] | null>(null);
  const [localMindStructure, setLocalMindStructure] = useState<MindLayoutKind>("logic");
  const [localMindRelations, setLocalMindRelations] = useState<MindRelation[]>([]);
  const [localExtras, setLocalExtras] = useState<WhiteboardExtras>(EMPTY_WHITEBOARD_EXTRAS);
  const frames = dragFrames ?? (hasCrdtProps ? crdtFrames : localFrames);
  const mindStructure = hasCrdtProps ? crdtMindCfg.structure : localMindStructure;
  const mindRelations = hasCrdtProps ? crdtMindCfg.relations : localMindRelations;
  const extras = hasCrdtProps ? crdtExtras : localExtras;
  const framesRef = useRef(frames); framesRef.current = frames;
  const mindStructureRef = useRef(mindStructure); mindStructureRef.current = mindStructure;
  const mindRelationsRef = useRef(mindRelations); mindRelationsRef.current = mindRelations;
  const extrasRef = useRef(extras); extrasRef.current = extras;
  const [votingMode, setVotingMode] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);
  const [minimapOpen, setMinimapOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 768);
  const [mindViewMode, setMindViewMode] = useState<"canvas" | "outline">("canvas");
  const [boundaryLabelDraft, setBoundaryLabelDraft] = useState("");
  const [summaryLabelDraft, setSummaryLabelDraft] = useState("");
  const [badgeTagDraft, setBadgeTagDraft] = useState("");
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);
  const [editingFrame, setEditingFrame] = useState<{ id: string; value: string } | null>(null);
  const [mindRelationFrom, setMindRelationFrom] = useState<string | null>(null);
  const [mindSelected, setMindSelected] = useState<string | null>(null);
  // Scoped to this editor instance; do not retain a copied document across sessions.
  const recentMindClipboard = useRef<MindClip | null>(null);
  const [mindClipboardFallback, setMindClipboardFallback] = useState(false);
  useEffect(() => { const clear = () => { recentMindClipboard.current = null; setMindClipboardFallback(false); }; const local = subscribeLocalAuthChanges(clear), remote = subscribeAuthChanges(clear); return () => { local(); remote(); }; }, []);
  const mindSelectedRef = useRef(mindSelected); mindSelectedRef.current = mindSelected;
  const canCopyRef = useRef(canCopy); canCopyRef.current = canCopy;
  const imageCopyMounted = useRef(true);
  useEffect(() => { imageCopyMounted.current = true; return () => { imageCopyMounted.current = false; }; }, []);
  const [mindMenu, setMindMenu] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [mindOffer, setMindOffer] = useState<string | null>(null);
  const [mindPaintMenu, setMindPaintMenu] = useState<{ kind: "fill" | "line" | "shape" | "textColor" | "textFormat" | "description" | "boundary" | "summary" | "badge"; left: number; top: number } | null>(null);
  useEffect(() => { setMindOffer(null); setMindPaintMenu(null); }, [mindSelected]);
  useEffect(() => {
    if (!mindMenu) return;
    const outside = (event: PointerEvent) => { if (!(event.target as Element)?.closest?.("[data-mind-context],[data-mind-menu-trigger]")) setMindMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMindMenu(null); } };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [mindMenu]);
  useEffect(() => {
    if (!mindPaintMenu) return;
    const outside = (event: PointerEvent) => { if (!(event.target as Element)?.closest?.("[data-mind-paint-menu],[data-mind-paint-trigger]")) setMindPaintMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMindPaintMenu(null); } };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [mindPaintMenu]);
  const [viewFoldOverrides, setViewFoldOverrides] = useState<Record<string, boolean>>({});
  const effectiveCollapsed = new Set(graph.mindCollapsed ?? []);
  if (readOnly) for (const [id, folded] of Object.entries(viewFoldOverrides)) { if (folded) effectiveCollapsed.add(id); else effectiveCollapsed.delete(id); }
  const [mindEditing, setMindEditing] = useState<{ id: string; value: string; base: FlowGraph } | null>(null);
  const mindEditingRef = useRef<typeof mindEditing>(null);
  const [mindDescriptionEditing, setMindDescriptionEditing] = useState<{ id: string; value: string; base: FlowGraph } | null>(null);
  const mindDescriptionEditingRef = useRef<typeof mindDescriptionEditing>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [tool, setTool] = useState<Shape | "select" | "pen" | "eraser" | "comment">("select");
  const [commentDraft, setCommentDraft] = useState<{ anchor: FlowCommentAnchor; quote: string; screenX: number; screenY: number } | null>(null);
  const [openPinId, setOpenPinId] = useState<number | null>(() => (activeThread && comments?.some((c) => c.id === activeThread && !c.resolved) ? activeThread : null));
  const [pinPopoverPos, setPinPopoverPos] = useState<{ x: number; y: number } | null>(null);
  const ink = useRef<{ pointerId: number; stroke: FlowStroke } | null>(null);
  const [inkPreview, setInkPreview] = useState<FlowStroke | null>(null);
  const erase = useRef<{ pointerId: number; base: FlowGraph; last: FlowPoint; ids: Set<string>; bounds: Map<string, ReturnType<typeof inkPointBounds>> } | null>(null);
  const [erasePreview, setErasePreview] = useState<Set<string> | null>(null);
  const [penColor, setPenColor] = useState("#1F2329"), [penWidth, setPenWidth] = useState(3);
  const [penKind, setPenKind] = useState<"pen" | "marker">("pen");
  const [markerColor, setMarkerColor] = useState("#FFEE24"), [markerWidth, setMarkerWidth] = useState(20);
  const [editing, setEditing] = useState<{ id: string; kind: "node" | "edge"; value: string } | null>(null);
  const [view, setView] = useState(() => { const b = boardContentBounds(initial, crdtMindCfg.structure, crdtFrames); return { x: b.x - 80, y: b.y - 80, zoom: 1 }; });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<"theme" | "import" | "export" | "ai" | "shape" | "fill" | "stroke" | "color" | "align" | "more" | "template" | "pen" | "ink-color" | "sticky" | null>(null);
  useEffect(() => { if (tool !== "pen" && menu === "pen") setMenu(null); if (tool !== "select") { setMindSelected(null); setMindRelationFrom(null); } }, [tool, menu]);
  useEffect(() => { if (mindSelected && !mindEditing && !layoutMindTopicsWithStructure(graph.mind ?? [], mindStructure, effectiveCollapsed, graph.mindStyles, graph.mindDescriptions, graph.mindDescriptionStyles).some((item) => item.topic.id === mindSelected)) setMindSelected(null); }, [graph.mind, graph.mindCollapsed, graph.mindStyles, graph.mindDescriptions, graph.mindDescriptionStyles, mindStructure, mindSelected, mindEditing, readOnly, viewFoldOverrides]);
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
  const gestureActive = useRef(false); gestureActive.current = !!drag || !!inkPreview || !!erasePreview || !!mindEditing || !!mindDescriptionEditing;
  const autoFit = useRef(true);
  const pinch = useRef<{ view: FlowViewport; center: FlowPoint; distance: number } | null>(null);
  const suppressTouch = useRef(false);
  const touchPlacement = useRef<{ shape: Shape; pointerId: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const change = () => { setCompact(media.matches); setMindPaintMenu(null); setMindMenu(null); if (media.matches) setLibrary(false); };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  // Remote edits arrive through `initial`; adopt them when not mid-gesture.
  const lastInitial = useRef(initial);
  useEffect(() => { if (initial !== lastInitial.current && !drag && !editing && !inkPreview && !erasePreview && !mindEditing && !mindDescriptionEditing) { lastInitial.current = initial; setGraph(initial); } }, [initial, drag, editing, inkPreview, erasePreview, mindEditing, mindDescriptionEditing]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { const edit = mindDescriptionEditingRef.current; if (edit && edit.value !== (mindDescriptionAt(edit.base.mindDescriptions, edit.id) ?? "")) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, []);
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
  const submit = (base: FlowGraph, next: FlowGraph, extraProps?: Record<string, string>): FlowChangeOutcome => {
    const extraKeys = extraProps ? Object.keys(extraProps) : [];
    const graphKeys = onChange || readOnly ? [] : Object.keys(flowIntentWrites(flowWrites({}, base), base, next).writes);
    const localKeys = [...graphKeys, ...extraKeys];
    const result = readOnly
      ? { graph, conflicts: ["permission"], applied: false, appliedKeys: [] }
      : onChange?.(next, base, extraKeys.length ? extraProps : undefined) ?? { graph: next, conflicts: [], applied: localKeys.length > 0, appliedKeys: localKeys };
    if (result.conflicts.length) {
      const nextRecovery = [...recoveryRef.current, { before: base, proposed: next, conflicts: result.conflicts }];
      recoveryRef.current = nextRecovery;
      setRecovery(nextRecovery);
    }
    const { mindTextStyleIntent: _transient, ...cleanGraph } = result.graph;
    const cleanResult = { ...result, graph: cleanGraph };
    setGraph(cleanGraph); lastInitial.current = cleanGraph;
    return cleanResult;
  };
  const applyLocalExtraProps = (patch: Record<string, string>) => {
    if (hasCrdtProps || !Object.keys(patch).length) return;
    const synthetic: Record<string, string> = {
      ...boardFramePropWrites([], framesRef.current),
      ...mindLayoutPropWrites(
        { structure: "logic", relations: [] },
        { structure: mindStructureRef.current, relations: mindRelationsRef.current },
      ),
      ...whiteboardExtrasPropWrites(EMPTY_WHITEBOARD_EXTRAS, extrasRef.current),
      ...patch,
    };
    const nextFrames = readBoardFramesFromProps(synthetic);
    const nextMind = readMindLayoutFromProps(synthetic);
    const nextExtras = readWhiteboardExtrasFromProps(synthetic);
    setLocalFrames(nextFrames);
    framesRef.current = nextFrames;
    setLocalMindStructure(nextMind.structure);
    mindStructureRef.current = nextMind.structure;
    setLocalMindRelations(nextMind.relations);
    mindRelationsRef.current = nextMind.relations;
    setLocalExtras(nextExtras);
    extrasRef.current = nextExtras;
  };
  const commitExtraProps = (base: FlowGraph, next: FlowGraph, extraProps: Record<string, string>): FlowChangeOutcome => {
    const extraKeys = Object.keys(extraProps);
    if (readOnly) return { graph, conflicts: ["permission"], applied: false, appliedKeys: [] };
    if (onChange) {
      const result = submit(base, next, extraKeys.length ? extraProps : undefined);
      if (extraKeys.length && onProps && !extraKeys.some((k) => result.appliedKeys.includes(k))) {
        onProps(extraProps);
        return { ...result, applied: true, appliedKeys: [...result.appliedKeys, ...extraKeys] };
      }
      return result;
    }
    if (extraKeys.length && onProps) {
      onProps(extraProps);
      return { graph: next, conflicts: [], applied: true, appliedKeys: extraKeys };
    }
    const result = submit(base, next, extraKeys.length ? extraProps : undefined);
    applyLocalExtraProps(extraProps);
    return result;
  };
  const updateFrames = (next: BoardFrame[]) => {
    if (readOnly) return;
    const before = framesRef.current;
    const forwardWrites = boardFramePropWrites(before, next);
    const reverseWrites = boardFramePropWrites(next, before);
    if (!hasCrdtProps) setLocalFrames(next);
    framesRef.current = next;
    if (!Object.keys(forwardWrites).length) return;
    const result = commitExtraProps(graph, graph, forwardWrites);
    if (result.applied) {
      setUndo((u) => [...u.slice(-99), { before: result.graph, after: result.graph, beforeProps: reverseWrites, afterProps: forwardWrites }]);
      setRedo([]);
    }
  };
  const persistMindLayout = (nextStructure: MindLayoutKind, nextRelations: MindRelation[]) => {
    if (readOnly) return;
    const before = { structure: mindStructureRef.current, relations: mindRelationsRef.current };
    const after = { structure: nextStructure, relations: nextRelations };
    const forwardWrites = mindLayoutPropWrites(before, after);
    const reverseWrites = mindLayoutPropWrites(after, before);
    if (!hasCrdtProps) {
      setLocalMindStructure(nextStructure);
      setLocalMindRelations(nextRelations);
    }
    mindStructureRef.current = nextStructure;
    mindRelationsRef.current = nextRelations;
    if (!Object.keys(forwardWrites).length) return;
    const result = commitExtraProps(graph, graph, forwardWrites);
    if (result.applied) {
      setUndo((u) => [...u.slice(-99), { before: result.graph, after: result.graph, beforeProps: reverseWrites, afterProps: forwardWrites }]);
      setRedo([]);
    }
  };
  const persistExtras = (nextExtras: WhiteboardExtras) => {
    if (readOnly) return;
    const before = extrasRef.current;
    const forwardWrites = whiteboardExtrasPropWrites(before, nextExtras);
    const reverseWrites = whiteboardExtrasPropWrites(nextExtras, before);
    if (!hasCrdtProps) setLocalExtras(nextExtras);
    extrasRef.current = nextExtras;
    if (!Object.keys(forwardWrites).length) return;
    const result = commitExtraProps(graph, graph, forwardWrites);
    if (result.applied) {
      setUndo((u) => [...u.slice(-99), { before: result.graph, after: result.graph, beforeProps: reverseWrites, afterProps: forwardWrites }]);
      setRedo([]);
    }
  };
  const toggleVoteOnNode = (nodeId: string) => {
    if (readOnly) return;
    const nextVotes = toggleNodeVote(extrasRef.current.votes, nodeId, resolvedUserId);
    persistExtras({ ...extrasRef.current, votes: nextVotes });
  };
  const insertStickyNote = (preset: StickyPreset) => {
    if (readOnly) return;
    const center = { x: view.x + size.w / view.zoom / 2, y: view.y + size.h / view.zoom / 2 };
    const sticky = createStickyNode(center, graph.nodes, preset);
    commit({ ...graph, nodes: [...graph.nodes, sticky] });
    setSelected(new Set([sticky.id]));
    setMindSelected(null);
    setSelectedFrameId(null);
    setTool("select");
    setHand(false);
    setVotingMode(false);
    setMenu(null);
    setShowStarter(false);
    setEditing({ id: sticky.id, kind: "node", value: "" });
  };
  const summaryTargetFor = (topicId: string | null): string | null => {
    if (!topicId || !graph.mind?.length) return null;
    if (graph.mind.some((item) => item.parent === topicId)) return topicId;
    const found = graph.mind.find((item) => item.id === topicId);
    return found?.parent ?? topicId;
  };
  const setMindBoundaryFor = (nodeId: string, boundary: { label?: string; color: string } | null) => {
    const nextBoundaries = { ...extrasRef.current.mindBoundaries };
    if (boundary) nextBoundaries[nodeId] = boundary;
    else delete nextBoundaries[nodeId];
    persistExtras({ ...extrasRef.current, mindBoundaries: nextBoundaries });
  };
  const setMindSummaryFor = (parentId: string, summary: { label: string; color: string } | null) => {
    const nextSummaries = { ...extrasRef.current.mindSummaries };
    if (summary) nextSummaries[parentId] = summary;
    else delete nextSummaries[parentId];
    persistExtras({ ...extrasRef.current, mindSummaries: nextSummaries });
  };
  const patchMindBadgeFor = (nodeId: string, patch: Partial<MindBadge> | null) => {
    const nextBadges = { ...extrasRef.current.mindBadges };
    if (patch === null) {
      delete nextBadges[nodeId];
    } else {
      const merged: MindBadge = { ...nextBadges[nodeId], ...patch };
      if (merged.priority === undefined) delete merged.priority;
      if (merged.progress === undefined) delete merged.progress;
      if (!merged.tag?.trim()) delete merged.tag;
      else merged.tag = merged.tag.trim().slice(0, 16);
      if (merged.priority === undefined && merged.progress === undefined && !merged.tag) {
        delete nextBadges[nodeId];
      } else {
        nextBadges[nodeId] = merged;
      }
    }
    persistExtras({ ...extrasRef.current, mindBadges: nextBadges });
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
  const updateMindStyle = (change: Partial<MindStyle>) => {
    if (readOnly || !mindSelected || !graph.mind?.some((topic) => topic.id === mindSelected)) return;
    const mindStyles = { ...graph.mindStyles, [mindSelected]: { ...graph.mindStyles?.[mindSelected], ...change } };
    if (commitMind(graph, { ...graph, mindStyles }).applied) setMindOffer(mindSelected);
  };
  const updateMindPaint = (change: Partial<MindPaint>) => {
    if (readOnly || !mindSelected || !graph.mind?.some((topic) => topic.id === mindSelected)) return;
    const mindPaints = { ...graph.mindPaints, [mindSelected]: { ...graph.mindPaints?.[mindSelected], ...change } };
    if (commitMind(graph, { ...graph, mindPaints }).applied) setMindOffer(mindSelected);
  };
  const updateMindTextFormat = (change: Partial<MindTextFormat>) => {
    if (readOnly || !mindSelected || !graph.mind?.some((topic) => topic.id === mindSelected)) return;
    const mindTextFormats = { ...graph.mindTextFormats, [mindSelected]: { ...graph.mindTextFormats?.[mindSelected], ...change } };
    if (commitMind(graph, { ...graph, mindTextFormats }).applied) setMindOffer(mindSelected);
  };
  const fitMindNodeIfClipped = (value: FlowGraph, id: string) => {
    if (!compact) return null;
    const node = layoutMindTopicsWithStructure(value.mind ?? [], mindStructure, new Set(value.mindCollapsed ?? []), value.mindStyles, value.mindDescriptions, value.mindDescriptionStyles).find((item) => item.topic.id === id);
    return node && ((node.x - view.x) * view.zoom < 12 || (node.x + node.w + 50 - view.x) * view.zoom > size.w - 12) ? requestAnimationFrame(() => fit(value, size, 40)) : null;
  };
  const updateMindDescriptionStyle = (change: Partial<MindDescriptionStyle>) => {
    if (readOnly || !mindSelected || !graph.mind?.some((topic) => topic.id === mindSelected)) return;
    const style = { ...mindDescriptionStyleAt(graph.mindDescriptionStyles, mindSelected), ...change };
    const description = mindDescriptionAt(graph.mindDescriptions, mindSelected) ?? "";
    if (description && mindDescriptionLines(description, style.size ?? 12).length > 128) { setNotice({ ok: false, text: t("此字号会使描述超过 128 行，请缩短描述或选择较小字号。") }); return; }
    const mindDescriptionStyles = { ...graph.mindDescriptionStyles, [mindSelected]: style };
    commitMind(graph, { ...graph, mindDescriptionStyles });
  };
  const applyMindStyleToSiblings = () => {
    const topic = graph.mind?.find((item) => item.id === mindSelected);
    if (!topic?.parent) return;
    const styles = { ...graph.mindStyles }, paints = { ...graph.mindPaints }, textFormats = { ...graph.mindTextFormats };
    for (const sibling of graph.mind ?? []) if (sibling.parent === topic.parent && sibling.id !== topic.id) {
      if (graph.mindStyles?.[topic.id]) styles[sibling.id] = { ...graph.mindStyles[topic.id] }; else delete styles[sibling.id];
      if (graph.mindPaints?.[topic.id]) paints[sibling.id] = { ...graph.mindPaints[topic.id] }; else delete paints[sibling.id];
      if (graph.mindTextFormats?.[topic.id]) textFormats[sibling.id] = { ...graph.mindTextFormats[topic.id] }; else delete textFormats[sibling.id];
    }
    commitMind(graph, { ...graph, mindStyles: styles, mindPaints: paints, mindTextFormats: textFormats }); setMindOffer(null);
  };
  const openMindPaintMenu = (kind: "fill" | "line" | "shape" | "textColor" | "textFormat" | "description" | "boundary" | "summary" | "badge", target: HTMLElement) => {
    if (mindPaintMenu?.kind === kind) { setMindPaintMenu(null); return; }
    if (kind === "boundary" && mindSelected) {
      setBoundaryLabelDraft(extrasRef.current.mindBoundaries[mindSelected]?.label ?? "");
    } else if (kind === "summary" && mindSelected) {
      const targetParent = summaryTargetFor(mindSelected);
      setSummaryLabelDraft((targetParent && extrasRef.current.mindSummaries[targetParent]?.label) || t("核心结论"));
    } else if (kind === "badge" && mindSelected) {
      setBadgeTagDraft(extrasRef.current.mindBadges[mindSelected]?.tag ?? "");
    }
    const rect = target.getBoundingClientRect(), h = kind === "line" ? 264 : kind === "textColor" ? 250 : kind === "description" ? 250 : kind === "badge" ? 240 : kind === "boundary" || kind === "summary" ? 188 : kind === "textFormat" ? 112 : kind === "shape" ? 86 : 180, w = kind === "shape" ? 144 : kind === "textFormat" ? 200 : kind === "badge" ? 264 : 244;
    let left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left));
    let top = rect.top >= h + 8 ? rect.top - h - 8 : Math.min(window.innerHeight - h - 8, rect.bottom + 8);
    // Keep the popup away from the visible tree when space permits.
    if (window.innerWidth < 768 && treeTop >= 56 + h) top = 56;
    else if (window.innerWidth >= 768 && rect.top < h + 64) left = Math.min(window.innerWidth - w - 8, rect.right + 160);
    setMindPaintMenu({ kind, left, top: Math.max(8, top) });
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
  const startMindDescription = (topic: MindTopic) => {
    if (readOnly) return;
    const edit = { id: topic.id, value: mindDescriptionAt(graph.mindDescriptions, topic.id) ?? "", base: graph };
    mindDescriptionEditingRef.current = edit; setMindDescriptionEditing(edit); setMindSelected(topic.id); setSelected(new Set()); setMindMenu(null);
  };
  const finishMindDescription = () => {
    const edit = mindDescriptionEditingRef.current; if (!edit) return;
    if (canonicalMindDescription(edit.value) === null || mindDescriptionLines(edit.value, mindDescriptionStyleAt(edit.base.mindDescriptionStyles, edit.id)?.size ?? 12).length > 128) { setNotice({ ok: false, text: t("描述最多 2000 个字符，换行后不超过 128 行。") }); return; }
    mindDescriptionEditingRef.current = null; setMindDescriptionEditing(null);
    if ((mindDescriptionAt(edit.base.mindDescriptions, edit.id) ?? "") === edit.value) return;
    const mindDescriptions = { ...edit.base.mindDescriptions, ...(edit.value ? { [edit.id]: edit.value } : {}) };
    if (!edit.value) delete mindDescriptions[edit.id];
    commitMind(edit.base, { ...edit.base, mindDescriptions });
  };
  const cancelMindDescription = () => { mindDescriptionEditingRef.current = null; setMindDescriptionEditing(null); };
  const addMindMap = () => {
    if (readOnly || (graph.mind?.length ?? 0) + 4 > 500) { setNotice({ ok: false, text: t("思维导图节点已达上限。") }); return; }
    const hasContent = graph.nodes.length > 0 || (graph.mind?.length ?? 0) > 0 || (graph.strokes?.length ?? 0) > 0;
    const existing = hasContent ? flowBounds(graph) : null;
    const rawX = existing ? existing.x + existing.w + 90 : view.x + size.w / view.zoom / 2 - 120;
    const rawY = existing ? existing.y + existing.h / 2 - 24 : view.y + size.h / view.zoom / 2 - 24;
    const root = newFlowId("m"), x = Math.round(Math.max(-20000, Math.min(20000, rawX))), y = Math.round(Math.max(-20000, Math.min(20000, rawY)));
    const topics: MindTopic[] = [{ id: root, parent: null, order: 0, text: "", x, y }, ...[0, 1, 2].map((order) => ({ id: newFlowId("m"), parent: root, order, text: "" }))];
    const result = commitMind(graph, { ...graph, mind: [...(graph.mind ?? []), ...topics] });
    if (result.applied && result.graph.mind?.some((topic) => topic.id === root)) { setMindSelected(root); setSelected(new Set()); setTool("select"); setHand(false); setShowStarter(false); }
  };
  const addMindTopic = (sibling: boolean, selectedId = mindSelected, openInlineEdit = true): string | undefined => {
    const parentTopic = graph.mind?.find((topic) => topic.id === selectedId);
    const parent = sibling ? parentTopic?.parent : parentTopic?.id;
    if (readOnly || !parentTopic || !parent) return undefined;
    if ((graph.mind?.length ?? 0) >= 500) { setNotice({ ok: false, text: t("思维导图节点已达上限。") }); return undefined; }
    let ancestor = graph.mind?.find((topic) => topic.id === parent), depth = 0;
    while (ancestor?.parent && depth < 33) { depth++; ancestor = graph.mind?.find((topic) => topic.id === ancestor!.parent); }
    if (!ancestor || depth >= 32) { setNotice({ ok: false, text: t("思维导图层级已达上限。") }); return undefined; }
    const siblings = graph.mind!.filter((topic) => topic.parent === parent).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const index = siblings.findIndex((topic) => topic.id === parentTopic.id), next = sibling && index >= 0 ? siblings[index + 1] : undefined;
    const order = sibling && next ? (parentTopic.order + next.order) / 2 : Math.max(-1, ...siblings.map((topic) => topic.order)) + 1;
    if (order > 1000000 || (next && (order <= parentTopic.order || order >= next.order))) { setNotice({ ok: false, text: t("节点顺序空间不足，请在末尾添加。") }); return undefined; }
    const topic: MindTopic = { id: newFlowId("m"), parent, order, text: "" };
    const result = commitMind(graph, { ...graph, mind: [...graph.mind!, topic], mindCollapsed: (graph.mindCollapsed ?? []).filter((id) => id !== parent) });
    if (result.applied && result.graph.mind?.some((item) => item.id === topic.id)) {
      setMindSelected(topic.id); setSelected(new Set());
      if (openInlineEdit) {
        const edit = { id: topic.id, value: topic.text, base: result.graph };
        mindEditingRef.current = edit; setMindEditing(edit);
      }
      return topic.id;
    }
    return undefined;
  };
  const updateMindTitleDirect = (id: string, text: string) => {
    if (readOnly || !graph.mind) return;
    const prev = graph.mind.find((item) => item.id === id);
    const trimmed = text.slice(0, 500);
    if (!prev || prev.text === trimmed) return;
    commitMind(graph, { ...graph, mind: graph.mind.map((item) => (item.id === id ? { ...item, text: trimmed } : item)) });
  };
  const removeMindTopicById = (targetId: string) => {
    if (readOnly || !targetId || !graph.mind) return;
    const ids = new Set([targetId]); let previous = 0;
    while (ids.size !== previous) { previous = ids.size; for (const topic of graph.mind) if (topic.parent && ids.has(topic.parent)) ids.add(topic.id); }
    const result = commitMind(graph, { ...graph, mind: graph.mind.filter((topic) => !ids.has(topic.id)) });
    if (mindSelected && !result.graph.mind?.some((topic) => topic.id === mindSelected)) setMindSelected(null);
  };
  const addMindParent = () => {
    if (readOnly || !mindSelected || !graph.mind) return;
    const id = newFlowId("m"), mind = insertMindParent(graph.mind, mindSelected, id);
    if (!mind) { setNotice({ ok: false, text: t("无法添加父节点：根节点、节点数量或层级超出限制。") }); return; }
    const result = commitMind(graph, { ...graph, mind });
    if (result.applied && result.graph.mind?.some((topic) => topic.id === id) && result.graph.mind.some((topic) => topic.id === mindSelected && topic.parent === id)) {
      setMindSelected(id); setSelected(new Set());
      const edit = { id, value: "", base: result.graph }; mindEditingRef.current = edit; setMindEditing(edit);
    }
  };
  const removeMindTopic = () => {
    if (readOnly || !mindSelected || !graph.mind) return;
    const ids = new Set([mindSelected]); let previous = 0;
    while (ids.size !== previous) { previous = ids.size; for (const topic of graph.mind) if (topic.parent && ids.has(topic.parent)) ids.add(topic.id); }
    const result = commitMind(graph, { ...graph, mind: graph.mind.filter((topic) => !ids.has(topic.id)) });
    if (!result.graph.mind?.some((topic) => topic.id === mindSelected)) setMindSelected(null);
  };
  const insertMindClip = (clip: MindClip, duplicate = false) => {
    if (readOnly) return;
    const selectedTopic = graph.mind?.find((topic) => topic.id === mindSelected);
    if (duplicate && (!selectedTopic || !canCopy)) { if (!canCopy) setNotice({ ok: false, text: t("当前文档不允许复制。") }); return; }
    const parent = duplicate ? selectedTopic!.parent : selectedTopic?.id ?? null;
    const at = duplicate && selectedTopic?.parent === null ? { x: selectedTopic.x! + 48, y: selectedTopic.y! + 48 } : { x: view.x + size.w / view.zoom / 2 - 52, y: view.y + size.h / view.zoom / 2 - 24 };
    const inserted = pasteMindBranch(graph, clip, parent, duplicate && parent ? selectedTopic!.id : null, at, () => newFlowId("m"));
    if (!inserted) { setNotice({ ok: false, text: t("无法粘贴：节点数量、层级或剪贴板内容超出限制。") }); return; }
    const result = commitMind(graph, inserted.graph);
    if (result.graph.mind?.some((topic) => topic.id === inserted.root)) { setNotice(null); setMindSelected(inserted.root); setSelected(new Set()); setTool("select"); setHand(false); }
  };
  const duplicateMind = () => { if (!mindSelected) return; const clip = copyMindBranch(graph, mindSelected); if (clip) insertMindClip(clip, true); };
  const copyMindTextStyle = async () => {
    if (!mindSelected || !canCopy) { if (!canCopy) setNotice({ ok: false, text: t("当前文档不允许复制。") }); return; }
    const clip = captureMindTextStyle(graph, mindSelected); if (!clip) return;
    setMindTextStyleSession(clip);
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") { setNotice({ ok: true, text: t("已复制文字样式（当前登录会话）") }); return; }
    try { await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([t("Jiange 文字样式")], { type: "text/plain" }), "text/html": new Blob([mindTextStyleHtml(clip)], { type: "text/html" }) })]); setNotice({ ok: true, text: t("已复制文字样式") }); }
    catch { setNotice({ ok: true, text: t("已复制文字样式（当前登录会话）") }); }
  };
  const pasteMindTextStyle = async () => {
    if (readOnly || !mindSelected) return;
    const target = mindSelected, base = graph, snapshot = JSON.stringify(graph), sessionRevision = getMindTextStyleSessionRevision();
    let clip = getMindTextStyleSession();
    if (!clip) {
      if (!navigator.clipboard?.read) { setNotice({ ok: false, text: t("请先复制节点文字样式。") }); return; }
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const items = await Promise.race([navigator.clipboard.read(), new Promise<ClipboardItems>((_, reject) => { timer = setTimeout(() => reject(new Error("clipboard timeout")), 2500); })]).finally(() => { if (timer) clearTimeout(timer); });
        for (const item of items) if (item.types.includes("text/html")) { clip = mindTextStyleFromHtml(await (await item.getType("text/html")).text()); if (clip) break; }
      } catch { setNotice({ ok: false, text: t("无法读取文字样式，请先在本标签页复制。") }); return; }
    }
    if (!clip) { setNotice({ ok: false, text: t("剪贴板中没有可用的节点文字样式。") }); return; }
    if (getMindTextStyleSessionRevision() !== sessionRevision || !editableRef.current || mindSelectedRef.current !== target || JSON.stringify(graphRef.current) !== snapshot) { setNotice({ ok: false, text: t("画布或登录状态已变化，未粘贴样式；请重新选择节点。") }); return; }
    const next = applyMindTextStyle(base, target, clip); if (!next) return;
    const result = commitMind(base, next); if (result.applied) setNotice({ ok: true, text: t("已粘贴文字样式") });
  };
  const insertMindPlainText = (text: string) => {
    if (!text.trim()) return;
    if (text.length > 500 || /[\r\n]/.test(text)) { setNotice({ ok: false, text: t("暂不支持将多行或超过 500 字的文本粘贴为节点。") }); return; }
    const clip: MindClip = { version: 1, root: "plain", topics: [{ id: "plain", parent: null, order: 0, text, x: 0, y: 0 }], styles: {}, paints: {}, collapsed: [] };
    insertMindClip(clip);
  };
  const copyMindToClipboard = async (cut: boolean) => {
    const id = mindSelected, base = graph, clip = id ? copyMindBranch(base, id) : null;
    if (!clip || !id || !canCopy) { if (!canCopy) setNotice({ ok: false, text: t("当前文档不允许复制。") }); return; }
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") { setNotice({ ok: false, text: t("当前浏览器无法完整复制分支，请使用键盘快捷键。") }); return; }
    const snapshot = JSON.stringify(base), sessionRevision = getMindTextStyleSessionRevision();
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([mindClipText(clip)], { type: "text/plain" }), "text/html": new Blob([mindClipHtml(clip)], { type: "text/html" }) })]);
      if (getMindTextStyleSessionRevision() !== sessionRevision || !canCopyRef.current) { setNotice({ ok: false, text: t("登录状态或权限已变化，未保留本页副本，也未剪切。") }); return; }
      recentMindClipboard.current = parseMindClip(JSON.stringify(clip));
      if (!cut) { setNotice({ ok: true, text: t("已复制分支") }); return; }
      if (getMindTextStyleSessionRevision() !== sessionRevision || !editableRef.current || !canCopyRef.current || mindSelectedRef.current !== id || JSON.stringify(graphRef.current) !== snapshot) { setNotice({ ok: false, text: t("画布或权限已变化，分支已复制但未剪切。") }); return; }
      const ids = new Set(clip.topics.map((topic) => topic.id)), result = commitMind(base, { ...base, mind: base.mind!.filter((topic) => !ids.has(topic.id)) });
      if (!result.graph.mind?.some((topic) => topic.id === id)) setMindSelected(null);
    } catch { setNotice({ ok: false, text: t("无法访问剪贴板，未剪切节点。") }); }
  };
  const pasteMindFromClipboard = async () => {
    if (readOnly || !navigator.clipboard?.read) { setNotice({ ok: false, text: t("当前浏览器无法读取剪贴板，请使用键盘快捷键。") }); return; }
    const snapshot = JSON.stringify(graph), selected = mindSelected, sessionRevision = getMindTextStyleSessionRevision();
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const items = await Promise.race([navigator.clipboard.read(), new Promise<ClipboardItems>((_, reject) => { timer = setTimeout(() => reject(new Error("clipboard timeout")), 2500); })]).finally(() => { if (timer) clearTimeout(timer); }); let structured = "", html = "", text = "";
      for (const item of items) { if (!structured && item.types.includes(MIND_CLIP_MIME)) structured = await (await item.getType(MIND_CLIP_MIME)).text(); if (!html && item.types.includes("text/html")) html = await (await item.getType("text/html")).text(); if (!text && item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text(); }
      if (getMindTextStyleSessionRevision() !== sessionRevision || !editableRef.current || mindSelectedRef.current !== selected || JSON.stringify(graphRef.current) !== snapshot) { setNotice({ ok: false, text: t("画布或登录状态已变化，未粘贴；请重新选择节点。") }); return; }
      const clip = structured ? parseMindClip(structured) : mindClipFromHtml(html);
      if ((structured || html.includes("data-jiange-mindmap")) && !clip) { setNotice({ ok: false, text: t("剪贴板内容无效，未粘贴。") }); return; }
      setMindClipboardFallback(false);
      if (clip) insertMindClip(clip); else insertMindPlainText(text);
    } catch { if (recentMindClipboard.current) setMindClipboardFallback(true); setNotice({ ok: false, text: recentMindClipboard.current ? t("无法读取系统剪贴板，可在菜单中粘贴本页最近复制的分支。") : t("无法读取剪贴板，请使用键盘快捷键。") }); }
  };
  const openMindMenu = (x: number, y: number) => {
    const rect = svgWrap.current?.getBoundingClientRect();
    const obstacles = rect ? layoutMindTopicsWithStructure(graph.mind ?? [], mindStructure, effectiveCollapsed, graph.mindStyles, graph.mindDescriptions, graph.mindDescriptionStyles).map((node) => ({ x: rect.left + (node.x - view.x) * view.zoom, y: rect.top + (node.y - view.y) * view.zoom, w: node.w * view.zoom, h: node.h * view.zoom })).filter((box) => box.x + box.w > 0 && box.y + box.h > 0 && box.x < window.innerWidth && box.y < window.innerHeight) : [];
    const toolbar = svgWrap.current?.closest<HTMLElement>("[data-flow-editor]")?.querySelector<HTMLElement>("[data-mind-toolbar]")?.getBoundingClientRect();
    if (toolbar) obstacles.push({ x: toolbar.left, y: toolbar.top, w: toolbar.width, h: toolbar.height });
    const globalTools = svgWrap.current?.closest<HTMLElement>("[data-flow-editor]")?.querySelector<HTMLElement>("[data-flow-global-tools]")?.getBoundingClientRect();
    if (globalTools) obstacles.push({ x: globalTools.left, y: globalTools.top, w: globalTools.width, h: globalTools.height });
    const done = svgWrap.current?.closest<HTMLElement>("[data-flow-editor]")?.querySelector<HTMLElement>("[data-flow-done]")?.getBoundingClientRect();
    if (done) obstacles.push({ x: done.left, y: done.top, w: done.width, h: done.height });
    setMindMenu(placeMindMenu({ x, y }, { w: window.innerWidth, h: window.innerHeight }, obstacles));
  };
  // Latest graph/commit for async work (image upload) that finishes after re-renders.
  const graphRef = useRef(graph); graphRef.current = graph;
  const commitRef = useRef(commit); commitRef.current = commit;
  const editableRef = useRef(!readOnly); editableRef.current = !readOnly;
  const copyMindNodeImage = async () => {
    const id = mindSelected, svg = svgWrap.current?.querySelector<SVGSVGElement>("[data-flow-svg]");
    if (!id || !canCopy || !svg || mindEditingRef.current || mindDescriptionEditingRef.current) { if (!canCopy) setNotice({ ok: false, text: t("当前文档不允许复制。") }); return; }
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") { setNotice({ ok: false, text: t("当前浏览器不支持复制图片。") }); return; }
    const bounds = mindNodeImageBounds(graph.mind ?? [], effectiveCollapsed, graph.mindStyles ?? {}, id, graph.mindDescriptions, graph.mindDescriptionStyles);
    const markup = bounds && mindNodeImageSvg(svg, id, bounds);
    if (!bounds || !markup) { setNotice({ ok: false, text: t("节点已变化，请重新选择后复制。") }); return; }
    const snapshot = JSON.stringify(graph), sessionRevision = getMindTextStyleSessionRevision();
    const png = rasterizeMindNode(markup, bounds.pixels).then((blob) => {
      if (!imageCopyMounted.current || !canCopyRef.current || getMindTextStyleSessionRevision() !== sessionRevision || mindSelectedRef.current !== id || JSON.stringify(graphRef.current) !== snapshot) throw new Error("copy context changed");
      return blob;
    });
    // ClipboardItem accepts a promise, allowing the write to start within the
    // user's gesture while rendering and permission checks complete.
    void png.catch(() => {});
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]); if (imageCopyMounted.current) setNotice({ ok: true, text: t("已复制图片到剪贴板") }); }
    catch { if (imageCopyMounted.current) setNotice({ ok: false, text: t("无法复制图片，请检查剪贴板权限并重试。") }); }
  };
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
  const fit = (g = graph, viewport = size, extraRight = 0, structureOverride?: MindLayoutKind) => {
    autoFit.current = true;
    const b = boardContentBounds(
      readOnly && g === graph ? { ...g, mindCollapsed: [...effectiveCollapsed] } : g,
      structureOverride ?? mindStructure,
      framesRef.current,
      readOnly && g === graph ? effectiveCollapsed : undefined,
      mindRelationsRef.current,
      extrasRef.current.mindBoundaries,
      extrasRef.current.mindSummaries,
      extrasRef.current.mindBadges,
    );
    // 左侧留出竖向工具条，上下留出浮动栏。
    const padL = compact ? 24 : readOnly ? 40 : 90, padR = (compact ? 24 : 40) + extraRight, usableW = Math.max(100, viewport.w - padL - padR), usableH = Math.max(100, viewport.h - (compact ? 56 : 160));
    const zoom = Math.min(mindBoard ? 1 : 1.5, Math.max(0.2, Math.min(usableW / Math.max(1, b.w), usableH / Math.max(1, b.h))));
    const offsetY = compact ? 28 + (usableH - b.h * zoom) / 2 : (viewport.h - b.h * zoom) / 2;
    setView({ zoom, x: b.x - (padL + (usableW - b.w * zoom) / 2) / zoom, y: b.y - offsetY / zoom });
  };
  const addBoardFrame = () => {
    if (readOnly) return;
    const center = { x: view.x + size.w / view.zoom / 2, y: view.y + size.h / view.zoom / 2 };
    const created = createBoardFrame(framesRef.current, center);
    updateFrames([...framesRef.current, created]);
    setSelectedFrameId(created.id);
    setSelected(new Set());
    setMindSelected(null);
    setTool("select");
    setHand(false);
    setShowStarter(false);
    setNotice({ ok: true, text: t("已插入分区画框「{title}」，拖动标题栏可联动移动内部图形", { title: created.title }) });
  };
  const finishFrameTitleEdit = () => {
    if (!editingFrame) return;
    const edit = editingFrame;
    setEditingFrame(null);
    if (readOnly) return;
    const current = framesRef.current.find((f) => f.id === edit.id);
    if (!current) return;
    const trimmed = edit.value.trim().slice(0, 120) || "Frame";
    if (trimmed === current.title) return;
    updateFrames(framesRef.current.map((f) => (f.id === edit.id ? { ...f, title: trimmed } : f)));
  };
  const deleteBoardFrame = (frame: BoardFrame) => {
    if (readOnly) return;
    updateFrames(framesRef.current.filter((f) => f.id !== frame.id));
    if (selectedFrameId === frame.id) setSelectedFrameId(null);
    if (editingFrame?.id === frame.id) setEditingFrame(null);
  };
  const exportSingleFrame = (frame: BoardFrame) => {
    if (!canCopy) { setNotice({ ok: false, text: t("当前文档权限不允许导出。") }); return; }
    const svg = exportFrameToSvg(frame, graph.nodes, graph.edges, themeOf(graph.theme));
    const safeName = (frame.title || "Frame").replace(/[\\/:*?"<>|]+/g, "_");
    download(`${safeName}.svg`, new Blob([svg], { type: "image/svg+xml" }));
    setNotice({ ok: true, text: t("已导出分区「{title}」为 SVG", { title: frame.title }) });
  };
  useEffect(() => {
    if (!compact || !mindSelected || drag || mindEditing || mindDescriptionEditing) return;
    const frame = fitMindNodeIfClipped(graph, mindSelected);
    return () => { if (frame !== null) cancelAnimationFrame(frame); };
  }, [compact, mindSelected, graph, drag, mindEditing, mindDescriptionEditing]); // preserve manual panning until the selection or graph changes
  const addNode = (shape: Shape, at?: { x: number; y: number }) => {
    const spec = SHAPES.find((s) => s.id === shape)!;
    const c = at ?? { x: view.x + size.w / view.zoom / 2, y: view.y + size.h / view.zoom / 2 };
    const node: FlowNode = { id: newFlowId("n"), shape, text: shape === "text" ? t("文本") : t(spec.label).replace(/（.*）|\(.*\)/, "").trim(), x: Math.round(c.x - spec.w / 2), y: Math.round(c.y - spec.h / 2), w: spec.w, h: spec.h, z: isContainer(shape) ? Math.min(0, ...graph.nodes.map((n) => n.z ?? 0)) - 1 : Math.max(0, ...graph.nodes.map((n) => n.z ?? 0)) + 1 };
    if (shape === "class") node.text = "ClassName\n+ field: type\n+ method()";
    if (shape === "actor" || shape === "lifeline") node.text = shape === "actor" ? t("用户") : t("对象");
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
    if (!/^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(file.type)) { setNotice({ ok: false, text: t("仅支持 PNG、JPG、GIF、WebP、SVG 图片") }); return; }
    if (file.size > 20 * 1024 * 1024) { setNotice({ ok: false, text: t("图片不能超过 20 MB") }); return; }
    setBusy(true); setNotice({ ok: true, text: t("正在上传图片…") });
    try {
      const url = URL.createObjectURL(file);
      const imageSize = await new Promise<{ w: number; h: number }>((resolve) => { const img = new Image(); img.onload = () => resolve({ w: img.naturalWidth || 240, h: img.naturalHeight || 160 }); img.onerror = () => resolve({ w: 240, h: 160 }); img.src = url; });
      URL.revokeObjectURL(url);
      const { w, h } = fitInsertedImage(imageSize, size, view.zoom);
      const asset = await upload(file);
      if (!editableRef.current) { setNotice({ ok: false, text: t("编辑权限已变化，图片未插入画板。") }); return; }
      const c = at ?? { x: view.x + size.w / view.zoom / 2, y: view.y + size.h / view.zoom / 2 };
      const node: FlowNode = { id: newFlowId("n"), shape: "image", text: "", fileId: asset.id, x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2), w, h, z: Math.max(0, ...graphRef.current.nodes.map((n) => n.z ?? 0)) + 1 };
      const next = { ...graphRef.current, nodes: [...graphRef.current.nodes, node] };
      commitRef.current(next); setSelected(new Set([node.id])); setNotice(null);
    } catch { setNotice({ ok: false, text: t("图片上传失败，请重试") }); }
    finally { setBusy(false); }
  };
  const nudge = (dx: number, dy: number) => commit(moveFlowSelection(graph, selected, dx, dy));
  const doUndo = () => {
    const step = undo.at(-1); if (!step) return;
    const extra = step.beforeProps ?? {};
    const hasExtra = Object.keys(extra).length > 0;
    const result = hasExtra ? commitExtraProps(step.after, step.before, extra) : submit(step.after, step.before);
    const applied = appliedFlowHistory(step.after, result.graph, result.appliedKeys);
    if (result.applied && (applied || hasExtra)) {
      if (hasExtra) applyLocalExtraProps(extra);
      setUndo(undo.slice(0, -1));
      setRedo([...redo, {
        before: applied?.after ?? result.graph,
        after: applied?.before ?? result.graph,
        ...(hasExtra ? { beforeProps: step.beforeProps, afterProps: step.afterProps } : {}),
      }]);
    }
    else if (!result.conflicts.length) setUndo(undo.slice(0, -1));
  };
  const doRedo = () => {
    const step = redo.at(-1); if (!step) return;
    const extra = step.afterProps ?? {};
    const hasExtra = Object.keys(extra).length > 0;
    const result = hasExtra ? commitExtraProps(step.before, step.after, extra) : submit(step.before, step.after);
    const applied = appliedFlowHistory(step.before, result.graph, result.appliedKeys);
    if (result.applied && (applied || hasExtra)) {
      if (hasExtra) applyLocalExtraProps(extra);
      setRedo(redo.slice(0, -1));
      setUndo([...undo, {
        before: applied?.before ?? result.graph,
        after: applied?.after ?? result.graph,
        ...(hasExtra ? { beforeProps: step.beforeProps, afterProps: step.afterProps } : {}),
      }]);
    }
    else if (!result.conflicts.length) setRedo(redo.slice(0, -1));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (recoveryOpen || editing || editingFrame || mindEditing || mindDescriptionEditing || (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) return;
      if (e.key === "Escape") { e.preventDefault(); if (drag?.kind === "mind") setDrag(null); else if (mindRelationFrom) setMindRelationFrom(null); else if (votingMode) setVotingMode(false); else if (commentDraft) setCommentDraft(null); else if (openPinId !== null) setOpenPinId(null); else if (tool === "comment") setTool("select"); else if (menu) setMenu(null); else if (mindViewMode === "outline") setMindViewMode("canvas"); else if (mindSelected) setMindSelected(null); else if (selectedFrameId) setSelectedFrameId(null); else if (selected.size) setSelected(new Set()); else requestClose(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) { e.preventDefault(); if (mindSelected) removeMindTopic(); else removeSelected(); }
      const onButton = e.target instanceof HTMLElement && !!e.target.closest("button");
      if (mindSelected && !readOnly && !onButton && e.key === "Tab") { if (e.shiftKey && !graph.mind?.find((topic) => topic.id === mindSelected)?.parent) return; e.preventDefault(); if (e.shiftKey) addMindParent(); else addMindTopic(false); }
      if (mindSelected && !readOnly && !onButton && e.key === "Enter" && e.shiftKey) { e.preventDefault(); const topic = graph.mind?.find((item) => item.id === mindSelected); if (topic) startMindDescription(topic); return; }
      if (mindSelected && !readOnly && !onButton && e.key === "Enter") { e.preventDefault(); addMindTopic(true); }
      if (mindSelected && (e.metaKey || e.ctrlKey) && e.key === "." && graph.mind?.some((topic) => topic.parent === mindSelected)) { e.preventDefault(); toggleMindFold(mindSelected); }
      if (mindSelected && !onButton && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.code === "KeyC" || e.key.toLowerCase() === "c")) { e.preventDefault(); e.stopPropagation(); void copyMindNodeImage(); return; }
      const textStyleShortcut = mindTextStyleShortcut(e);
      if (mindSelected && !readOnly && !onButton && textStyleShortcut) { e.preventDefault(); e.stopPropagation(); if (textStyleShortcut === "copy") void copyMindTextStyle(); else void pasteMindTextStyle(); return; }
      if (mindSelected && !readOnly && !onButton && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && ["b", "i", "u"].includes(e.key.toLowerCase())) { e.preventDefault(); const key = ({ b: "bold", i: "italic", u: "underline" } as const)[e.key.toLowerCase() as "b" | "i" | "u"]; updateMindTextFormat({ [key]: graph.mindTextFormats?.[mindSelected]?.[key] ? undefined : true }); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !readOnly) { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(new Set([...graph.nodes.map((n) => n.id), ...(graph.strokes ?? []).map((stroke) => stroke.id)])); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && !readOnly) { e.preventDefault(); if (mindSelected) duplicateMind(); else { const c = clipOfSelection(); if (c) pasteClip(c, 20); } }
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
      if (mindSelected) {
        e.preventDefault(); e.stopPropagation();
        if (!canCopy) { setNotice({ ok: false, text: t("当前文档不允许复制。") }); return; }
        const clip = copyMindBranch(graph, mindSelected); if (!clip || !e.clipboardData) { setNotice({ ok: false, text: t("无法访问剪贴板，未剪切节点。") }); return; }
        const json = JSON.stringify(clip), plain = mindClipText(clip);
        try {
          e.clipboardData.setData("text/plain", plain);
          try { e.clipboardData.setData(MIND_CLIP_MIME, json); } catch { /* HTML is a second structured representation. */ }
          try { e.clipboardData.setData("text/html", mindClipHtml(clip)); } catch { /* Plain text is still available. */ }
        } catch { setNotice({ ok: false, text: t("复制失败，未剪切节点。") }); return; }
        recentMindClipboard.current = parseMindClip(json);
        if (e.type === "cut" && !readOnly) removeMindTopic();
        return;
      }
      const c = clipOfSelection();
      if (!c) return;
      if (!canCopy) { e.preventDefault(); e.stopPropagation(); setNotice({ ok: false, text: t("当前文档不允许复制。") }); return; }
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
      const mindData = e.clipboardData?.getData(MIND_CLIP_MIME) ?? "", html = e.clipboardData?.getData("text/html") ?? "";
      if (html.includes("data-jiange-mind-text-style")) { e.preventDefault(); e.stopPropagation(); setNotice({ ok: false, text: t("请使用「粘贴样式」应用文字样式。") }); return; }
      if (mindData || html.includes("data-jiange-mindmap")) { e.preventDefault(); e.stopPropagation(); const clip = mindData ? parseMindClip(mindData) : mindClipFromHtml(html); if (!clip) { setNotice({ ok: false, text: t("剪贴板内容无效，未粘贴。") }); return; } insertMindClip(clip); return; }
      if (mindSelected && text.trim() && !text.startsWith(CLIP_MARK)) {
        e.preventDefault(); e.stopPropagation();
        insertMindPlainText(text); return;
      }
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
        } catch { setNotice({ ok: false, text: t("剪贴板内容无效，未粘贴。") }); return; }
        if (!clip || (!clip.nodes.length && !clip.strokes?.length)) return;
        const block: ClipBlock = { type: "flowchart", props: Object.fromEntries(clip.nodes.map((n) => [`fc.n.${n.id}`, JSON.stringify(n)])), chars: [], source: clip.source };
        const plan = planClipboardAssets([block], location.origin);
        if (!plan.ok) { setNotice({ ok: false, text: plan.message }); return; }
        if (!plan.assets) { pasteClip(clip, 24 * pasteCount.current); return; }
        if (!assets?.copy || assetPaste.current) { setNotice({ ok: false, text: t("当前无法安全复制图片，请确认编辑权限并稍后重试。") }); return; }
        const copy = assets.copy, source = clip, offset = 24 * pasteCount.current, snapshot = JSON.stringify(graphRef.current), selection = selectedKeyRef.current;
        const key = JSON.stringify([plan.assets.sourceDocId, plan.assets.fileIds]);
        let requestId = assetRetry.current?.key === key ? assetRetry.current.id : "";
        if (!requestId) {
          try { requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) => v.toString(16).padStart(2, "0")).join(""); }
          catch { setNotice({ ok: false, text: t("无法创建安全的粘贴请求。") }); return; }
          assetRetry.current = { key, id: requestId };
        }
        const controller = new AbortController(); assetPaste.current = controller;
        const stillCurrent = () => !controller.signal.aborted && editableRef.current && selectedKeyRef.current === selection && JSON.stringify(graphRef.current) === snapshot;
        setNotice({ ok: true, text: t("正在复制图片…") });
        void (async () => {
          try {
            const [mapped] = await copyClipboardAssetsWithRetry(copy, [block], plan.assets!, requestId, assets.docId, controller.signal, stillCurrent);
            if (!stillCurrent()) return;
            const nodes = source.nodes.map((node) => normalizeNode(JSON.parse(mapped.props[`fc.n.${node.id}`]))).filter((node): node is FlowNode => !!node);
            if (nodes.length !== source.nodes.length) throw new Error("invalid nodes");
            pasteClip({ ...source, nodes }, offset); assetRetry.current = null; setNotice(null);
          } catch {
            if (!controller.signal.aborted) setNotice({ ok: false, text: stillCurrent() ? t("无法确认图片复制结果，可再次粘贴重试。") : t("画板已变化，未粘贴；请重新选择后再试。") });
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
    if (!autoFit.current || (!graph.nodes.length && !graph.strokes?.length && !graph.mind?.length && !frames.length) || drag) return;
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
    if (drag.kind === "mind") {
      if (drag.pointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 6) autoFit.current = false;
      setDrag({ ...drag, currentX: e.clientX, currentY: e.clientY }); return;
    }
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
    if (drag.kind === "group-scale") {
      const dx = (e.clientX - drag.startX) / view.zoom, dy = (e.clientY - drag.startY) / view.zoom;
      const length = drag.box.w * drag.box.w + drag.box.h * drag.box.h;
      const req = length > 0 ? 1 + (dx * drag.box.w + dy * drag.box.h) / length : 1;
      const scaled = scaleSelectionProportionally(drag.nodes, drag.strokes, { x: drag.box.x, y: drag.box.y }, req);
      const nodeMap = new Map(scaled.nodes.map((n) => [n.id, n]));
      const strokeMap = new Map(scaled.strokes.map((s) => [s.id, s]));
      autoFit.current = false;
      setDrag((prev) => prev && prev.kind === "group-scale" ? { ...prev, scale: scaled.scale } : prev);
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) => nodeMap.get(n.id) ?? n),
        ...(g.strokes ? { strokes: g.strokes.map((s) => strokeMap.get(s.id) ?? s) } : {}),
      }));
      return;
    }
    let dx = (e.clientX - drag.startX) / view.zoom, dy = (e.clientY - drag.startY) / view.zoom;
    if ((drag.kind === "move" || drag.kind === "resize" || drag.kind === "frame-move" || drag.kind === "frame-resize") && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) autoFit.current = false;
    if (drag.kind === "frame-move") {
      const moved = moveFrameWithContents(drag.frameOrigin, drag.baseGraph.nodes, dx, dy);
      const nextFrames = drag.framesOrigin.map((f) => (f.id === drag.frameId ? moved.frame : f));
      setDragFrames(nextFrames);
      framesRef.current = nextFrames;
      if (moved.movedNodeIds.length > 0) {
        setGraph((g) => ({ ...g, nodes: moved.nodes }));
      }
      return;
    }
    if (drag.kind === "frame-resize") {
      const nextW = Math.min(8_000, Math.max(160, Math.round(drag.frameOrigin.w + dx)));
      const nextH = Math.min(8_000, Math.max(120, Math.round(drag.frameOrigin.h + dy)));
      const nextFrames = drag.framesOrigin.map((f) => (f.id === drag.frameId ? { ...f, w: nextW, h: nextH } : f));
      setDragFrames(nextFrames);
      framesRef.current = nextFrames;
      return;
    }
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
    if (drag.kind === "mind" && drag.pointerId !== e.pointerId) return;
    const d = drag;
    setDrag(null); setGuides([]);
    if (d.kind === "mind") {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) <= 6) return;
      const topic = d.base.mind?.find((item) => item.id === d.id); if (!topic || !d.base.mind) return;
      if (topic.parent === null) {
        const x = Math.round(Math.max(-20000, Math.min(20000, topic.x! + (e.clientX - d.startX) / view.zoom)));
        const y = Math.round(Math.max(-20000, Math.min(20000, topic.y! + (e.clientY - d.startY) / view.zoom)));
        commitMind(d.base, { ...d.base, mind: d.base.mind.map((item) => item.id === d.id ? { ...item, x, y } : item) });
        return;
      }
      const drop = mindDropAt(d.base.mind, layoutMindTopicsWithStructure(d.base.mind, mindStructure, new Set(d.base.mindCollapsed ?? []), d.base.mindStyles, d.base.mindDescriptions, d.base.mindDescriptionStyles), d.id, toWorld(e.clientX, e.clientY));
      const moved = drop && moveMindTopic(d.base.mind, d.id, drop); if (!moved || !drop) return;
      commitMind(d.base, { ...d.base, mind: moved, ...(drop.kind === "child" ? { mindCollapsed: (d.base.mindCollapsed ?? []).filter((id) => id !== drop.target) } : {}) });
      return;
    }
    if (d.kind === "frame-move") {
      const nextFrames = framesRef.current;
      const forwardWrites = boardFramePropWrites(d.framesOrigin, nextFrames);
      const reverseWrites = boardFramePropWrites(nextFrames, d.framesOrigin);
      const nodesChanged = JSON.stringify(d.baseGraph.nodes) !== JSON.stringify(graph.nodes);
      setDragFrames(null);
      if (!hasCrdtProps) setLocalFrames(nextFrames);
      if (Object.keys(forwardWrites).length || nodesChanged) {
        const result = commitExtraProps(d.baseGraph, graph, forwardWrites);
        const step = appliedFlowHistory(d.baseGraph, result.graph, result.appliedKeys);
        if (result.applied && (step || Object.keys(forwardWrites).length)) {
          setUndo((u) => [
            ...u.slice(-99),
            {
              before: step?.before ?? result.graph,
              after: step?.after ?? result.graph,
              ...(Object.keys(forwardWrites).length ? { beforeProps: reverseWrites, afterProps: forwardWrites } : {}),
            },
          ]);
          setRedo([]);
        }
      }
      return;
    }
    if (d.kind === "frame-resize") {
      const nextFrames = framesRef.current;
      const forwardWrites = boardFramePropWrites(d.framesOrigin, nextFrames);
      const reverseWrites = boardFramePropWrites(nextFrames, d.framesOrigin);
      setDragFrames(null);
      if (!hasCrdtProps) setLocalFrames(nextFrames);
      if (Object.keys(forwardWrites).length) {
        const result = commitExtraProps(graph, graph, forwardWrites);
        if (result.applied) {
          setUndo((u) => [...u.slice(-99), { before: result.graph, after: result.graph, beforeProps: reverseWrites, afterProps: forwardWrites }]);
          setRedo([]);
        }
      }
      return;
    }
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
    if (d.kind === "move" || d.kind === "resize" || d.kind === "rotate" || d.kind === "ink-resize" || d.kind === "group-scale") {
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
  const requestClose = () => { finishEdit(); finishFrameTitleEdit(); finishMindEdit(); finishMindDescription(); if (mindDescriptionEditingRef.current) return; if (recoveryRef.current.length) setRecoveryOpen(true); else onClose(); };

  const importDrawio = async (file: File) => importDrawioText(await file.text());
  const importXmind = async (file: File) => {
    setBusy(true); setNotice(null);
    try {
      const hasExisting = graph.nodes.length || graph.strokes?.length || graph.mind?.length;
      const existingBox = hasExisting ? flowBounds(graph) : null;
      const parsed = await parseXmindToMindMap(new Uint8Array(await file.arrayBuffer()), {
        startX: existingBox ? Math.round(existingBox.x + existingBox.w + 140) : 160,
        startY: existingBox ? Math.round(existingBox.y + 40) : 220,
        existingCount: graph.mind?.length ?? 0,
      });
      const merged: FlowGraph = {
        ...graph,
        mind: [...(graph.mind ?? []), ...parsed.mind],
        mindCollapsed: [...(graph.mindCollapsed ?? []), ...parsed.mindCollapsed],
        mindStyles: { ...(graph.mindStyles ?? {}), ...parsed.mindStyles },
        mindPaints: { ...(graph.mindPaints ?? {}), ...parsed.mindPaints },
        mindTextFormats: { ...(graph.mindTextFormats ?? {}), ...parsed.mindTextFormats },
        mindDescriptions: { ...(graph.mindDescriptions ?? {}), ...parsed.mindDescriptions },
      };
      commit(merged);
      setShowStarter(false);
      requestAnimationFrame(() => fit(merged));
      const xmindSummary = parsed.sheetCount > 1
        ? t("已导入 XMind：{topics} 个主题（{sheets} 张画布）", { topics: parsed.topicCount, sheets: parsed.sheetCount })
        : t("已导入 XMind：{topics} 个主题", { topics: parsed.topicCount });
      setNotice({
        ok: true,
        text: parsed.warnings.length ? t("{summary}；{warnings}", { summary: xmindSummary, warnings: parsed.warnings.join("; ") }) : xmindSummary,
      });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof XmindError ? err.message : t("导入 XMind 失败，请确认文件为标准 .xmind 格式") });
    } finally {
      setBusy(false);
    }
  };
  const importFile = async (file: File) => {
    if (file.name.toLowerCase().endsWith(".xmind")) return importXmind(file);
    return importDrawio(file);
  };
  const importDrawioText = async (text: string) => {
    setBusy(true); setNotice(null);
    try {
      const { graph: g, warnings } = await parseDrawio(text);
      const merged = graph.nodes.length || graph.strokes?.length || graph.mind?.length ? appendGraph(graph, g) : { ...g, theme: graph.theme };
      commit(merged); requestAnimationFrame(() => fit(merged));
      const drawioSummary = t("已导入 {nodes} 个图形、{edges} 条连线", { nodes: g.nodes.length, edges: g.edges.length });
      setNotice({ ok: true, text: warnings.length ? t("{summary}；{warnings}", { summary: drawioSummary, warnings: warnings.join("; ") }) : drawioSummary });
    } catch (err) { setNotice({ ok: false, text: err instanceof DrawioError ? err.message : t("导入失败，请确认文件来自 draw.io / diagrams.net") }); }
    finally { setBusy(false); }
  };
  const runAI = async () => {
    if (!ai || !aiText.trim()) return;
    setBusy(true); setNotice(null);
    try {
      const parsed = parseFlowchartAnswer(await ai(flowchartPrompt(aiText)));
      if (!parsed) { setNotice({ ok: false, text: t("AI 没有返回可用的流程图，请换种描述再试") }); return; }
      const next = graph.nodes.length || graph.strokes?.length || graph.mind?.length ? appendGraph(graph, parsed.graph) : { ...parsed.graph, theme: graph.theme };
      commit(next); requestAnimationFrame(() => fit(next)); setMenu(null);
      setNotice({
        ok: true,
        text: parsed.dropped
          ? t("AI 生成了 {count} 个节点，{dropped} 项无效内容已忽略，请核对", { count: parsed.graph.nodes.length, dropped: parsed.dropped })
          : t("AI 生成了 {count} 个节点，请核对", { count: parsed.graph.nodes.length }),
      });
    } catch (err) { setNotice({ ok: false, text: aiErrorText(err) }); }
    finally { setBusy(false); }
  };
  const download = (name: string, blob: Blob) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 0); };
  const exportAs = async (kind: "svg" | "png" | "drawio" | "xmind") => {
    if (mindEditingRef.current || mindDescriptionEditingRef.current) { setNotice({ ok: false, text: t("请先完成节点文字编辑。") }); return; }
    setMenu(null);
    if (kind === "xmind") {
      if (!canCopy) { setNotice({ ok: false, text: t("当前文档权限不允许导出。") }); return; }
      if (!graph.mind?.length) { setNotice({ ok: false, text: t("画布中没有思维导图，请先插入思维导图后再导出 .xmind。") }); return; }
      try {
        const bytes = exportMindMapToXmind(graph);
        return download(t("思维导图.xmind"), new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "application/vnd.xmind.workbook" }));
      } catch (err) {
        setNotice({ ok: false, text: err instanceof XmindError ? err.message : t("导出 XMind 失败") });
        return;
      }
    }
    if (kind === "drawio" && graph.mind?.length) { setNotice({ ok: false, text: t("draw.io 导出暂不支持思维导图，请使用 PNG、SVG 或 XMind。") }); return; }
    if (kind === "drawio" && graph.strokes?.length) { setNotice({ ok: false, text: t("draw.io 导出暂不支持笔迹，请使用 PNG 或 SVG。") }); return; }
    if (kind === "drawio") return download(t("流程图.drawio"), new Blob([toDrawio(graph)], { type: "application/xml" }));
    const svg = await inlineImages(svgMarkup(readOnly ? { ...graph, mindCollapsed: [...effectiveCollapsed] } : graph));
    if (kind === "svg") return download(mindBoard ? t("思维导图.svg") : t("流程图.svg"), new Blob([svg], { type: "image/svg+xml" }));
    const b = flowBounds(graph), scale = 2, w = (b.w + 80) * scale, h = (b.h + 80) * scale;
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode().catch(() => {});
    const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.drawImage(img, 0, 0, w, h);
    canvas.toBlob((blob) => blob && download(mindBoard ? t("思维导图.png") : t("流程图.png"), blob), "image/png");
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
  const inkPalette = [
    ["#1F2329", t("黑色")], ["#D83931", t("红色")], ["#DE7802", t("橙色")], ["#DC9B04", t("黄色")],
    ["#2EA121", t("绿色")], ["#3370FF", t("蓝色")], ["#6425D0", t("紫色")], ["#8F959E", t("灰色")],
  ] as const;
  const mindPalette = [
    ["#1f2329", t("黑")], ["#646a73", t("深灰")], ["#bbbfc4", t("灰")], ["#ffffff", t("白")],
    ["#8f5fe8", t("紫")], ["#5b7ff1", t("蓝")], ["#79c968", t("绿")], ["#f8dd4e", t("黄")],
    ["#f4a340", t("橙")], ["#e86d68", t("红")], ["#e7defb", t("浅紫")], ["#e1e9ff", t("浅蓝")],
    ["#dff2dd", t("浅绿")], ["#fff5c7", t("浅黄")], ["#ffe8d1", t("浅橙")], ["#fce4e4", t("浅红")],
  ] as const;
  const activeInkColor = penKind === "marker" ? markerColor : penColor;
  const inkColors = penKind === "marker" ? [["#FFEE24", t("黄色")], ["#FFB3CC", t("粉色")], ["#98E7A5", t("绿色")], ["#8DCBFF", t("蓝色")], ["#D1B3FF", t("紫色")]] as const : inkPalette;
  const penSettings = <div className="absolute bottom-[52px] right-0 z-[90] w-[208px] rounded-lg border border-[#DEE0E3] bg-surface p-3 text-[13px] shadow-lg" role="group" aria-label={t("画笔颜色")} onPointerDown={(event) => event.stopPropagation()}>
    <div className="mb-2 text-subtle">{t("画笔颜色")}</div><div className="flex flex-wrap gap-2">{inkColors.map(([color, label]) => <button key={color} type="button" aria-label={t("画笔颜色 {color}", { color: label })} title={label} aria-pressed={activeInkColor === color} onClick={() => { penKind === "marker" ? setMarkerColor(color) : setPenColor(color); setMenu(null); }} className={cn("size-5 rounded-full border border-[#bbbfc4]", activeInkColor === color && "ring-2 ring-primary ring-offset-2")} style={{ background: color }}/>)}</div>
  </div>;
  const libraryGroups: { title: string; shapes: Shape[] }[] = [
    { title: t("基础"), shapes: ["round", "rect", "ellipse", "diamond", "triangle", "hexagon", "parallelogram", "sticky", "note", "text", ...(upload ? ["image" as const] : [])] },
    { title: t("泳道"), shapes: ["swimlane", "swimlaneV"] },
    { title: t("流程图"), shapes: ["terminator", "rect", "diamond", "parallelogram", "document", "cylinder", "hexagon"] },
    { title: t("类图"), shapes: ["class", "note"] },
    { title: t("时序图"), shapes: ["actor", "lifeline", "note"] },
  ];
  const ICON_BOX: Partial<Record<Shape, [number, number, number, number]>> = { actor: [33, 6, 30, 106], lifeline: [18, 8, 60, 82], swimlane: [6, 16, 84, 64], swimlaneV: [14, 6, 68, 84], class: [14, 12, 68, 72], triangle: [14, 14, 68, 68], note: [16, 12, 64, 72], sticky: [14, 14, 68, 68] };
  const shapeIcon = (id: Shape) => { const [x, y, w, h] = ICON_BOX[id] ?? [10, 22, 76, 52]; return <svg viewBox="0 0 96 96" className="size-6" fill="none"><ShapeOutline n={{ id: "i", x, y, w, h, shape: id, text: "" }} theme={{ ...THEMES[0], radius: 4, strokeWidth: 6 }} fill="none" stroke="currentColor" />{id === "text" && <text x="48" y="66" textAnchor="middle" fontSize="52" fill="currentColor">T</text>}</svg>; };
  const filteredGroups = libraryGroups.map((g) => ({ ...g, shapes: g.shapes.filter((id) => { const q = libQuery.trim().toLowerCase(); if (!q) return true; const raw = SHAPES.find((x) => x.id === id)!.label; return raw.toLowerCase().includes(q) || t(raw).toLowerCase().includes(q); }) })).filter((g) => g.shapes.length);
  // Floating style toolbar anchored above the selection (Feishu: shape ▾ / 填充 ▾ / 边框 ▾ / 字色 ▾ / 字号 ▾ / 更多).
  const anchorBox = selectedNodes.length ? bounds(selectedNodes) : selectedEdges.length ? (() => { const e = selectedEdges[0]; const a = graph.nodes.find((n) => n.id === e.from), t = graph.nodes.find((n) => n.id === e.to); if (!a || !t) return null; const m = edgePath(e, a, t).mid; return { x: m.x, y: m.y, w: 0, h: 0 }; })() : selectedStrokes.length ? flowBounds({ nodes: [], edges: [], strokes: selectedStrokes, theme: graph.theme }) : null;
  const obstaclePadding = Math.max(12, 20 * view.zoom);
  const obstacles = [...graph.nodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h })), ...(graph.strokes ?? []).map((stroke) => flowBounds({ nodes: [], edges: [], strokes: [stroke], theme: graph.theme }))].map((box) => ({ x: (box.x - view.x) * view.zoom - obstaclePadding, y: (box.y - view.y) * view.zoom - obstaclePadding, w: box.w * view.zoom + 2 * obstaclePadding, h: box.h * view.zoom + 2 * obstaclePadding }));
  const barPos = anchorBox ? placeSelectionToolbar({ x: (anchorBox.x - view.x - 16) * view.zoom, y: (anchorBox.y - view.y - 16) * view.zoom, w: (anchorBox.w + 32) * view.zoom, h: (anchorBox.h + 32) * view.zoom }, size, styleBarSize, obstacles) : null;
  const reserveStyleBar = compact && !readOnly && (selectedNodes.length > 0 || selectedEdges.length > 0 || selectedStrokes.length > 0);
  const mindPositions = layoutMindTopicsWithStructure(graph.mind ?? [], mindStructure, effectiveCollapsed, graph.mindStyles, graph.mindDescriptions, graph.mindDescriptionStyles), mindAnchor = mindSelected ? mindPositions.find((item) => item.topic.id === mindSelected) : null;
  const mindDefaultColor = mindDefaultTextColor(mindAnchor?.topic.parent === null, graph.mindStyles?.[mindSelected!]?.shape ?? "rect", graph.mindPaints?.[mindSelected!]);
  const currentPaint = graph.mindPaints?.[mindSelected!] ?? {};
  const currentTextFormat = graph.mindTextFormats?.[mindSelected!] ?? {};
  const currentDescriptionStyle = mindDescriptionStyleAt(graph.mindDescriptionStyles, mindSelected!) ?? {};
  const selectedShape = graph.mindStyles?.[mindSelected!]?.shape ?? (mindAnchor?.topic.parent === null ? "rect" : "text");
  const hasMindSiblings = !!mindAnchor?.topic.parent && (graph.mind ?? []).filter((topic) => topic.parent === mindAnchor.topic.parent).length > 1;
  const mindViewport = svgWrap.current?.getBoundingClientRect();
  const mindRoot = (id: string) => { let topic = graph.mind?.find((item) => item.id === id), depth = 0; while (topic?.parent && depth++ < 32) topic = graph.mind?.find((item) => item.id === topic!.parent); return topic?.id; };
  const sameTree = mindAnchor ? mindPositions.filter((item) => mindRoot(item.topic.id) === mindRoot(mindAnchor.topic.id)) : [];
  const treeTop = mindViewport && sameTree.length ? mindViewport.top + (Math.min(...sameTree.map((item) => item.y)) - view.y) * view.zoom : 0;
  const treeBottom = mindViewport && sameTree.length ? mindViewport.top + (Math.max(...sameTree.map((item) => item.y + item.h)) - view.y) * view.zoom : 0;
  const windowHeight = typeof window === "undefined" ? 720 : window.innerHeight;
  const toolbarTop = treeTop - 50 >= 64 ? treeTop - 50 : treeBottom + 8 <= windowHeight - 52 ? treeBottom + 8 : 64;
  const mindToolbarHalf = typeof window === "undefined" ? 280 : Math.min(280, Math.max(0, window.innerWidth / 2 - 12));
  const mindToolbarStyle = !compact && mindAnchor && mindViewport ? { left: Math.max(mindToolbarHalf, Math.min(window.innerWidth - mindToolbarHalf, mindViewport.left + (mindAnchor.x + mindAnchor.w / 2 - view.x) * view.zoom)), top: toolbarTop } : undefined;
  const movingMind = drag?.kind === "mind" && Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY) > 6 ? drag : null;
  const movingTopic = movingMind?.base.mind?.find((topic) => topic.id === movingMind.id);
  const rootPreview = movingMind && movingTopic?.parent === null ? { x: Math.round(Math.max(-20000, Math.min(20000, movingTopic.x! + (movingMind.currentX - movingMind.startX) / view.zoom))), y: Math.round(Math.max(-20000, Math.min(20000, movingTopic.y! + (movingMind.currentY - movingMind.startY) / view.zoom))) } : null;
  const renderedGraph = rootPreview && movingMind ? { ...graph, mind: graph.mind?.map((topic) => topic.id === movingMind.id ? { ...topic, ...rootPreview } : topic) } : graph;
  const dragPoint = movingMind && !rootPreview && svgWrap.current ? toWorld(movingMind.currentX, movingMind.currentY) : null;
  const mindDragPreview = dragPoint && movingMind?.base.mind ? { id: movingMind.id, ...dragPoint, drop: mindDropAt(movingMind.base.mind, layoutMindTopicsWithStructure(movingMind.base.mind, mindStructure, new Set(movingMind.base.mindCollapsed ?? []), movingMind.base.mindStyles, movingMind.base.mindDescriptions, movingMind.base.mindDescriptionStyles), movingMind.id, dragPoint) } : null;
  const groupBox = !readOnly && tool === "select" && selectedNodes.length + selectedStrokes.length >= 2 && !selectedEdges.length ? selectionBounds(selectedNodes, selectedStrokes) : null;
  const boardPins = resolveBoardCommentPins(comments, renderedGraph, effectiveCollapsed);
  const openPin = openPinId !== null ? boardPins.find((p) => p.root.id === openPinId) ?? null : null;
  const rankedVotes = useMemo(() => topVotedNodes(extras.votes, graph.nodes, 3), [extras.votes, graph.nodes]);
  const totalVotes = useMemo(
    () => Object.values(extras.votes).reduce((acc, list) => acc + list.length, 0),
    [extras.votes],
  );
  const hasMindTopics = !!(graph.mind && graph.mind.length > 0);
  const summaryTargetId = summaryTargetFor(mindSelected);
  const activeBoundary = mindSelected ? extras.mindBoundaries[mindSelected] : undefined;
  const activeSummary = summaryTargetId ? extras.mindSummaries[summaryTargetId] : undefined;
  const activeBadge = mindSelected ? extras.mindBadges[mindSelected] : undefined;
  const worldToScreen = (wx: number, wy: number) => {
    const r = svgWrap.current?.getBoundingClientRect();
    if (!r) return { x: 240, y: 180 };
    return { x: r.left + (wx - view.x) * view.zoom, y: r.top + (wy - view.y) * view.zoom };
  };
  const openCommentComposer = (anchor: FlowCommentAnchor, quote: string, clientX?: number, clientY?: number) => {
    setOpenPinId(null);
    setMenu(null);
    setMindMenu(null);
    const screen = clientX !== undefined && clientY !== undefined ? { x: clientX, y: clientY } : worldToScreen(anchor.x, anchor.y);
    setCommentDraft({ anchor, quote, screenX: screen.x, screenY: screen.y });
  };
  const focusPin = (pin: ResolvedBoardPin, screenX?: number, screenY?: number) => {
    setCommentDraft(null);
    setOpenPinId(pin.root.id);
    if (screenX !== undefined && screenY !== undefined) {
      setPinPopoverPos({ x: screenX, y: screenY });
    } else {
      const scr = worldToScreen(pin.x, pin.y);
      setPinPopoverPos(scr);
    }
  };

  return createPortal(<div className="fixed inset-0 z-[80] select-none bg-surface" data-flow-editor onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { ink.current = null; setInkPreview(null); erase.current = null; setErasePreview(null); touchPlacement.current = null; if (drag?.kind === "frame-move" || drag?.kind === "frame-resize") { setDragFrames(null); framesRef.current = drag.framesOrigin; } if (drag && !["mind", "pan", "marquee", "connect", "reconnect", "frame-resize"].includes(drag.kind)) setGraph(lastInitial.current); setDrag(null); setGuides([]); }}>
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
        if (drag?.kind === "frame-move" || drag?.kind === "frame-resize") { setDragFrames(null); framesRef.current = drag.framesOrigin; }
        if (drag && !["mind", "pan", "marquee", "connect", "reconnect", "frame-resize"].includes(drag.kind)) setGraph(lastInitial.current);
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
      {mindViewMode === "outline" && hasMindTopics ? (
        <div className="absolute inset-0 z-10 pt-14">
          <MindMapOutlineView
            topics={graph.mind ?? []}
            collapsed={effectiveCollapsed}
            paints={graph.mindPaints}
            badges={extras.mindBadges}
            boundaries={extras.mindBoundaries}
            summaries={extras.mindSummaries}
            selectedId={mindSelected}
            readOnly={readOnly}
            onSelect={(id) => { setMindSelected(id); setSelected(new Set()); }}
            onToggleFold={toggleMindFold}
            onUpdateTitle={updateMindTitleDirect}
            onAddChild={(parentId) => addMindTopic(false, parentId, false)}
            onAddSibling={(topicId) => addMindTopic(true, topicId, false)}
            onDelete={removeMindTopicById}
            onSwitchToCanvas={() => setMindViewMode("canvas")}
          />
        </div>
      ) : <>
      <WhiteboardGpuLayer graph={mindStructure === "logic" ? renderedGraph : { ...renderedGraph, mind: undefined }} view={view} selected={selected} draftStroke={inkPreview} erasing={erasePreview} mindCollapsed={effectiveCollapsed} mindSelected={mindSelected} mindDescriptionEditing={mindDescriptionEditing} mindBoard={mindBoard} onBackendReady={(backend) => { if (backend === "webgpu" || backend === "webgl2") setGpuActive(true); }} />
      <FlowSvg graph={renderedGraph} width="100%" height="100%" viewBox={viewBox} selected={selected} gpuBacked={gpuActive} draftStroke={inkPreview} erasing={erasePreview} frames={frames} selectedFrameId={selectedFrameId} editingFrameId={editingFrame?.id ?? null}
        votes={extras.votes} currentUserId={resolvedUserId} votingMode={votingMode} onToggleVote={readOnly ? undefined : toggleVoteOnNode}
        onFrameHeaderDown={readOnly ? undefined : (e, frame) => {
          if (e.pointerType === "touch" && (!e.isPrimary || suppressTouch.current)) return;
          finishEdit(); finishFrameTitleEdit();
          setSelectedFrameId(frame.id); setSelected(new Set()); setMindSelected(null); setMenu(null);
          lastInitial.current = graph;
          setDrag({ kind: "frame-move", frameId: frame.id, startX: e.clientX, startY: e.clientY, frameOrigin: frame, baseGraph: graph, framesOrigin: framesRef.current });
          svgWrap.current?.setPointerCapture(e.pointerId);
        }}
        onFrameResizeDown={readOnly ? undefined : (e, frame) => {
          if (e.pointerType === "touch" && (!e.isPrimary || suppressTouch.current)) return;
          setSelectedFrameId(frame.id);
          setDrag({ kind: "frame-resize", frameId: frame.id, startX: e.clientX, startY: e.clientY, frameOrigin: frame, framesOrigin: framesRef.current });
          svgWrap.current?.setPointerCapture(e.pointerId);
        }}
        onFrameTitleDoubleClick={readOnly ? undefined : (frame) => { setSelectedFrameId(frame.id); setEditingFrame({ id: frame.id, value: frame.title }); }}
        onFrameExport={exportSingleFrame}
        onFrameDelete={readOnly ? undefined : deleteBoardFrame}
        mindStructure={mindStructure} mindRelations={mindRelations} mindRelationFrom={mindRelationFrom}
        onRemoveMindRelation={readOnly ? undefined : (relId) => { persistMindLayout(mindStructure, mindRelations.filter((r) => r.id !== relId)); setNotice({ ok: true, text: t("已删除跨分支关联线") }); }}
        mindBoundaries={extras.mindBoundaries} mindSummaries={extras.mindSummaries} mindBadges={extras.mindBadges}
        onEditMindBoundary={readOnly ? undefined : (nodeId) => { setMindSelected(nodeId); setSelected(new Set()); setBoundaryLabelDraft(extrasRef.current.mindBoundaries[nodeId]?.label ?? ""); const pos = mindPositions.find((m) => m.topic.id === nodeId); const scr = pos ? worldToScreen(pos.x, pos.y) : { x: 240, y: 160 }; setMindPaintMenu({ kind: "boundary", left: Math.max(8, Math.min(window.innerWidth - 260, scr.x)), top: Math.max(56, Math.min(window.innerHeight - 210, scr.y)) }); }}
        onEditMindSummary={readOnly ? undefined : (parentId) => { setMindSelected(parentId); setSelected(new Set()); setSummaryLabelDraft(extrasRef.current.mindSummaries[parentId]?.label ?? t("核心结论")); const pos = mindPositions.find((m) => m.topic.id === parentId); const scr = pos ? worldToScreen(pos.x + pos.w, pos.y) : { x: 240, y: 160 }; setMindPaintMenu({ kind: "summary", left: Math.max(8, Math.min(window.innerWidth - 260, scr.x)), top: Math.max(56, Math.min(window.innerHeight - 210, scr.y)) }); }}
        mindSelected={mindSelected} mindEditing={mindEditing} mindDescriptionEditing={mindDescriptionEditing} mindCollapsed={effectiveCollapsed} mindDragPreview={mindDragPreview} onMindFold={!movingMind && !mindEditing && !mindDescriptionEditing && (readOnly || tool === "select") ? toggleMindFold : undefined} onMindAddChild={!movingMind && !readOnly && tool === "select" && !mindEditing && !mindDescriptionEditing ? (id) => addMindTopic(false, id) : undefined} onMindSelect={tool === "pen" || tool === "eraser" ? undefined : (topic, event) => {
        if (event.pointerType === "touch" && (!event.isPrimary || suppressTouch.current)) return;
        if (tool === "comment" && commentActions) {
          event.stopPropagation();
          const pos = mindPositions.find((m) => m.topic.id === topic.id);
          const wx = pos ? Math.round(pos.x + pos.w) : Math.round(toWorld(event.clientX, event.clientY).x);
          const wy = pos ? Math.round(pos.y) : Math.round(toWorld(event.clientX, event.clientY).y);
          openCommentComposer({ kind: "mind", targetId: topic.id, x: wx, y: wy }, topic.text || t("导图主题"), event.clientX, event.clientY);
          return;
        }
        if (readOnly) return;
        if (mindRelationFrom) {
          if (topic.id === mindRelationFrom) {
            setMindRelationFrom(null);
            return;
          }
          const exists = mindRelations.some((r) => r.fromId === mindRelationFrom && r.toId === topic.id);
          if (!exists) {
            const relId = `mr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
            persistMindLayout(mindStructure, [...mindRelations, { id: relId, fromId: mindRelationFrom, toId: topic.id, label: t("关联") }]);
          }
          setMindRelationFrom(null);
          setMindSelected(topic.id);
          setSelected(new Set());
          setNotice({ ok: true, text: exists ? t("这两个主题之间已存在关联线") : t("已创建跨分支关联线（双击关联线可删除）") });
          return;
        }
        if (hand || space.current || event.button === 1) { setDrag({ kind: "pan", startX: event.clientX, startY: event.clientY, vx: view.x, vy: view.y }); return; }
        if (event.button !== 0) return;
        const wasEditing = !!mindEditing || !!mindDescriptionEditing; if (mindEditing) finishMindEdit(); if (mindDescriptionEditing) finishMindDescription(); if (mindDescriptionEditingRef.current) return; setMindMenu(null);
        setMindSelected(topic.id); setSelected(new Set()); setSelectedFrameId(null); setTool("select"); setHand(false);
        if (!wasEditing) { try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer may have ended */ } setDrag({ kind: "mind", id: topic.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, currentX: event.clientX, currentY: event.clientY, base: graph }); }
      }} onMindContextMenu={readOnly || tool === "pen" || tool === "eraser" || tool === "comment" ? undefined : (topic, event) => { if (mindEditing) finishMindEdit(); if (mindDescriptionEditing) finishMindDescription(); if (mindDescriptionEditingRef.current) return; setMindSelected(topic.id); setSelected(new Set()); setDrag(null); setMindPaintMenu(null); openMindMenu(event.clientX, event.clientY); }} onMindEdit={readOnly || tool === "pen" || tool === "eraser" || tool === "comment" ? undefined : (topic) => { if (mindDescriptionEditingRef.current) return; setMindMenu(null); setDrag(null); startMindEdit(topic); }} onMindDraft={(value) => { const edit = mindEditingRef.current; if (edit) { const next = { ...edit, value }; mindEditingRef.current = next; setMindEditing(next); } }} onMindFinish={finishMindEdit} onMindCancel={cancelMindEdit} onMindEditDescription={readOnly ? undefined : startMindDescription} onMindDescriptionDraft={(value) => { const edit = mindDescriptionEditingRef.current; if (edit) { const next = { ...edit, value }; mindDescriptionEditingRef.current = next; setMindDescriptionEditing(next); } }} onMindDescriptionFinish={finishMindDescription} onMindDescriptionCancel={cancelMindDescription} resizeStroke={!readOnly && tool === "select" && selectedStrokes.length === 1 && !selectedNodes.length && !selectedEdges.length ? selectedStrokes[0].id : null} groupBox={groupBox} groupScalePct={drag?.kind === "group-scale" ? Math.round(drag.scale * 100) : null} onGroupScale={readOnly || !groupBox ? undefined : (event) => {
        if (event.pointerType === "touch" && (!event.isPrimary || suppressTouch.current)) return;
        lastInitial.current = graph;
        setDrag({ kind: "group-scale", startX: event.clientX, startY: event.clientY, box: groupBox, nodes: selectedNodes, strokes: selectedStrokes, scale: 1 });
        svgWrap.current?.setPointerCapture(event.pointerId);
      }} commentPins={boardPins} activePinId={openPinId} pinZoom={view.zoom} onPinSelect={(pin, event) => focusPin(pin, event.clientX, event.clientY)} editing={editing?.kind === "node" ? editing.id : null} idPrefix="fce" transparent touchZoom={compact ? view.zoom : undefined}
        onCanvasDown={(e) => {
          if (e.pointerType === "touch" && (!e.isPrimary || suppressTouch.current)) return;
          if (e.target !== e.currentTarget && !(e.target instanceof SVGSVGElement)) return;
          if (mindDescriptionEditingRef.current) { finishMindDescription(); if (mindDescriptionEditingRef.current) return; }
          finishFrameTitleEdit();
          setMenu(null); setMindMenu(null); setMindSelected(null); setMindRelationFrom(null); setSelectedFrameId(null); setOpenPinId(null);
          if (tool === "comment" && commentActions) {
            const p = toWorld(e.clientX, e.clientY);
            const wx = Math.round(Math.max(-20000, Math.min(20000, p.x)));
            const wy = Math.round(Math.max(-20000, Math.min(20000, p.y)));
            openCommentComposer({ kind: "point", x: wx, y: wy }, t("画布 ({x}, {y})", { x: wx, y: wy }), e.clientX, e.clientY);
            return;
          }
          setCommentDraft(null);
          if (tool === "pen") { startInk(e); return; }
          if (tool === "eraser") { startErase(e); return; }
          if (tool !== "select" && tool !== "comment" && !readOnly) {
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
        onNodeDown={(e, n) => { setMindSelected(null); setMindRelationFrom(null); setSelectedFrameId(null);
          e.stopPropagation(); setMenu(null); setOpenPinId(null);
          if (e.pointerType === "touch" && (!e.isPrimary || suppressTouch.current)) return;
          if (votingMode && !readOnly) {
            toggleVoteOnNode(n.id);
            return;
          }
          if (tool === "comment" && commentActions) {
            const shapeSpec = SHAPES.find((x) => x.id === n.shape);
            const label = n.text.split("\n")[0] || (shapeSpec ? t(shapeSpec.label) : t("图形"));
            openCommentComposer({ kind: "node", targetId: n.id, x: Math.round(n.x + n.w), y: Math.round(n.y) }, label, e.clientX, e.clientY);
            return;
          }
          setCommentDraft(null);
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
        return <textarea autoFocus value={editing.value} placeholder={t("输入文本")} onChange={(e) => setEditing({ ...editing, value: e.target.value })} onBlur={finishEdit} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); finishEdit(); } if (e.key === "Escape") setEditing(null); }}
          className={cn("absolute select-text resize-none rounded border-2 border-primary bg-surface p-1 text-center outline-none", compact ? "text-[16px]" : "text-[14px]")} style={{ left: (anchor.x - view.x) * view.zoom, top: (anchor.y - view.y) * view.zoom, width: anchor.w * view.zoom, height: Math.max(32, anchor.h * view.zoom) }} data-flow-text-editor />;
      })()}
      {editingFrame && (() => {
        const frame = frames.find((f) => f.id === editingFrame.id);
        if (!frame) return null;
        return (
          <input
            autoFocus
            data-board-frame-title-input
            aria-label={t("编辑分区标题")}
            maxLength={120}
            value={editingFrame.value}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setEditingFrame({ ...editingFrame, value: e.target.value })}
            onBlur={finishFrameTitleEdit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") { e.preventDefault(); finishFrameTitleEdit(); }
              if (e.key === "Escape") { e.preventDefault(); setEditingFrame(null); }
            }}
            style={{
              left: (frame.x - view.x) * view.zoom,
              top: (frame.y - 30 - view.y) * view.zoom,
              width: Math.max(110, 140 * view.zoom),
              height: Math.max(24, 24 * view.zoom),
            }}
            className="absolute z-30 select-text rounded border-2 border-[#3370FF] bg-surface px-2 text-[12px] font-medium text-foreground outline-none"
          />
        );
      })()}
      {!graph.nodes.length && !graph.strokes?.length && !graph.mind?.length && !frames.length && !readOnly && showStarter && <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
        <div className={cn("pointer-events-auto w-[min(560px,calc(100%-32px))] overflow-y-auto rounded-xl border border-[#DEE0E3] bg-surface p-4 shadow-[0_4px_16px_rgba(31,35,41,0.08)] dark:border-border", compact ? "max-h-[calc(100%-24px)]" : "max-h-[calc(100%-190px)]")} style={{ touchAction: "pan-y" }} onPointerDown={(e) => e.stopPropagation()} data-flow-template-picker>
          <div className="mb-3 flex items-center text-[14px] font-medium">{t("从模板创建")}<button type="button" aria-label={t("关闭模板")} onClick={() => setShowStarter(false)} className="ml-auto grid size-8 place-items-center rounded-md text-subtle hover:bg-hover"><X size={16}/></button></div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">{FLOW_TEMPLATES.map((tpl) => <button key={tpl.id} type="button" onClick={() => applyTemplate(tpl)} className="rounded-lg border border-[#DEE0E3] p-2 text-left hover:border-primary dark:border-border" data-flow-template={tpl.id}><div className="text-[13px] font-medium">{t(tpl.label)}</div><div className="mt-1 text-[11px] leading-4 text-subtle">{t(tpl.desc)}</div></button>)}</div>
          <div className="mt-3 text-[12px] text-subtle">{compact ? t("也可以从下方图形库选择图形后点击画布放置，或在右上角使用「AI 生成」「导入 draw.io」，支持直接粘贴 draw.io 内容。") : t("也可以从左侧图形库选择图形后点击画布放置，或在右上角使用「AI 生成」「导入 draw.io」，支持直接粘贴 draw.io 内容。")}</div>
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
          <div className="relative"><button type="button" aria-label={t("笔迹颜色")} title={t("笔迹颜色")} className={barBtn} onClick={() => setMenu(menu === "ink-color" ? null : "ink-color")}><span className="size-4 rounded-full border border-[#bbbfc4]" style={{ background: selectedStrokes[0].color }}/><ChevronDown size={12}/></button>
            {menu === "ink-color" && <div className={cn(pop, "left-0 w-[208px] p-2")} role="group" aria-label={t("笔迹颜色")}>{inkPalette.map(([color, label]) => <button key={color} type="button" aria-label={t("笔迹颜色 {color}", { color: label })} title={label} onClick={() => { patchStrokes({ color }); setMenu(null); }} className="m-1 size-5 rounded-full border border-[#bbbfc4]" style={{ background: color }}/>)}</div>}
          </div>
          <FeishuSelect
            ariaLabel={t("笔迹粗细")}
            title={t("笔迹粗细")}
            value={String(selectedStrokes[0].width)}
            options={[...(INK_WIDTHS.includes(selectedStrokes[0].width as typeof INK_WIDTHS[number]) ? [] : [selectedStrokes[0].width]), ...INK_WIDTHS].map((width) => ({ value: String(width), label: String(width) }))}
            onChange={(val) => patchStrokes({ width: Number(val) })}
            className="min-w-[52px] border text-[13px]"
            chevronSize={11}
            menuMinWidth={64}
          />
          <button type="button" className={barBtn} onClick={() => { const clip = clipOfSelection(); if (clip) pasteClip(clip, 20); }} title={t("创建副本")} aria-label={t("创建笔迹副本")}><Copy size={15}/></button>
          <button type="button" className={barBtn} onClick={removeSelected} data-flow-delete-ink><Trash2 size={15}/>{t("删除笔迹")}</button>
        </>}
        {compact && <button type="button" className={tb} aria-label={t("完成选择")} onClick={() => { setSelected(new Set()); setMenu(null); }}><X size={16}/></button>}
        {compact && selectedNodes.length === 1 && selectedNodes[0].shape !== "image" && <button type="button" className={barBtn} onClick={() => setEditing({ id: selectedNodes[0].id, kind: "node", value: selectedNodes[0].text })} data-flow-edit-text>{t("编辑文字")}</button>}
        {compact && selectedNodes.length === 1 && <button type="button" className={barBtn} onClick={() => { setConnectFrom(selectedNodes[0].id); setSelected(new Set()); setMenu(null); }} data-flow-connect-tap>{t("连接图形")}</button>}
        {selectedNodes.length > 0 && !selectedNodes.every((n) => n.shape === "image") && <>
          <div className="relative"><button type="button" className={barBtn} title={t("图形")} onClick={() => setMenu(menu === "shape" ? null : "shape")}>{shapeIcon(selectedNodes[0].shape)}<ChevronDown size={12} /></button>
            {menu === "shape" && <div className={cn(pop, "left-0 grid w-[208px] grid-cols-5 gap-1 p-2")}>{SHAPES.map((s) => <button key={s.id} type="button" title={t(s.label)} onClick={() => { patchNodes({ shape: s.id }); setMenu(null); }} className={cn("grid size-9 place-items-center rounded-md hover:bg-hover", selectedNodes[0].shape === s.id && "bg-[#E1EAFF] text-primary")}>{shapeIcon(s.id)}</button>)}</div>}
          </div>
          <div className="relative"><button type="button" className={barBtn} title={t("填充")} onClick={() => setMenu(menu === "fill" ? null : "fill")}><span className="size-4 rounded-full border border-[#BBBFC4]" style={{ background: selectedNodes[0].fill ?? theme.fill }} /><ChevronDown size={12} /></button>
            {menu === "fill" && <div className={cn(pop, "left-0 w-[188px] p-2")}><div className="mb-1 text-[12px] text-subtle">{t("填充")}</div><div className="grid grid-cols-8 gap-1">{PALETTE.map((p) => { const [fill] = p.split("/"); return <button key={p} type="button" onClick={() => { patchNodes({ fill }); setMenu(null); }} className="size-[18px] rounded-full border border-[#BBBFC4]" style={{ background: fill }} title={fill} />; })}</div><button type="button" onClick={() => { patchNodes({ fill: undefined }); setMenu(null); }} className="mt-2 h-7 w-full rounded-md border text-[12px] hover:bg-hover">{t("跟随风格")}</button></div>}
          </div>
          <div className="relative"><button type="button" className={barBtn} title={t("边框")} onClick={() => setMenu(menu === "stroke" ? null : "stroke")}><span className="size-4 rounded-full border-[3px]" style={{ borderColor: selectedNodes[0].stroke ?? theme.stroke }} /><ChevronDown size={12} /></button>
            {menu === "stroke" && <div className={cn(pop, "left-0 w-[188px] p-2")}><div className="mb-1 text-[12px] text-subtle">{t("边框")}</div><div className="grid grid-cols-8 gap-1">{PALETTE.map((p) => { const stroke = p.split("/")[1]; return <button key={p} type="button" onClick={() => { patchNodes({ stroke }); setMenu(null); }} className="size-[18px] rounded-full border-[3px] bg-white" style={{ borderColor: stroke }} title={stroke} />; })}</div><button type="button" onClick={() => { patchNodes({ stroke: undefined }); setMenu(null); }} className="mt-2 h-7 w-full rounded-md border text-[12px] hover:bg-hover">{t("跟随风格")}</button></div>}
          </div>
          <span className="mx-0.5 h-5 w-px bg-[#DEE0E3]" />
          <div className="relative"><button type="button" className={barBtn} title={t("文字颜色")} onClick={() => setMenu(menu === "color" ? null : "color")}><span className="grid size-[18px] place-items-center rounded-[3px] bg-[#FFE928] text-[12px] font-medium" style={{ color: selectedNodes[0].color ?? theme.text }}>A</span><ChevronDown size={12} /></button>
            {menu === "color" && <div className={cn(pop, "left-0 w-[188px] p-2")}><div className="grid grid-cols-8 gap-1">{["#1F2329", "#8F959E", "#D83931", "#DE7802", "#DC9B04", "#2EA121", "#245BDB", "#6425D0"].map((c) => <button key={c} type="button" onClick={() => { patchNodes({ color: c }); setMenu(null); }} className="grid size-[18px] place-items-center rounded border text-[11px] font-medium" style={{ color: c }}>A</button>)}</div></div>}
          </div>
          <FeishuSelect
            ariaLabel={t("字号")}
            title={t("字号")}
            value={String(selectedNodes[0].size ?? 14)}
            options={[12, 14, 16, 18, 20, 24, 28, 32].map((v) => ({ value: String(v), label: String(v) }))}
            onChange={(val) => patchNodes({ size: Number(val) })}
            className="min-w-[52px] border text-[13px]"
            chevronSize={11}
            menuMinWidth={68}
          />
          <div className="relative"><button type="button" className={barBtn} title={t("对齐")} onClick={() => setMenu(menu === "align" ? null : "align")} data-flow-align-btn>{selectedNodes.length > 1 ? <AlignStartVertical size={15} /> : selectedNodes[0].align === "left" ? <AlignLeft size={15} /> : selectedNodes[0].align === "right" ? <AlignRight size={15} /> : <AlignCenter size={15} />}<ChevronDown size={12} /></button>
            {menu === "align" && <div className={cn(pop, "left-0 w-[208px] p-2")} data-flow-align-menu>
              <div className="mb-1 text-[12px] text-subtle">{t("文字对齐")}</div>
              <div className="flex gap-1">{([["left", AlignLeft, t("左对齐")], ["center", AlignCenter, t("居中")], ["right", AlignRight, t("右对齐")]] as const).map(([k, Icon, l]) => <button key={k} type="button" title={l} onClick={() => patchNodes({ align: k === "center" ? undefined : k })} className={cn(tb, (selectedNodes[0].align ?? "center") === k && "bg-[#E1EAFF] text-primary")}><Icon size={15} /></button>)}</div>
              {selectedNodes.length > 1 && <>
                <div className="mb-1 mt-2 text-[12px] text-subtle">{t("图形对齐")}</div>
                <div className="grid grid-cols-6 gap-1">{([["left", AlignStartVertical, t("左对齐")], ["hcenter", AlignCenterVertical, t("水平居中")], ["right", AlignEndVertical, t("右对齐")], ["top", AlignStartHorizontal, t("顶端对齐")], ["vcenter", AlignCenterHorizontal, t("垂直居中")], ["bottom", AlignEndHorizontal, t("底端对齐")]] as const).map(([k, Icon, l]) => <button key={k} type="button" title={l} onClick={() => alignNodes(k)} className={tb} data-flow-align={k}><Icon size={15} /></button>)}</div>
                <div className="mt-1 flex gap-1"><button type="button" title={t("水平等距分布")} disabled={selectedNodes.length < 3} onClick={() => distribute("x")} className={tb} data-flow-distribute="x"><AlignHorizontalSpaceAround size={15} /></button><button type="button" title={t("垂直等距分布")} disabled={selectedNodes.length < 3} onClick={() => distribute("y")} className={tb} data-flow-distribute="y"><AlignVerticalSpaceAround size={15} /></button></div>
              </>}
            </div>}
          </div>
        </>}
        {selectedEdges.length > 0 && <>
          {([["orthogonal", t("折线")], ["straight", t("直线")], ["curve", t("曲线")]] as [EdgeKind, string][]).map(([k, l]) => <button key={k} type="button" onClick={() => patchEdges({ kind: k, fromPort: undefined, toPort: undefined, mid: undefined })} className={cn(barBtn, (selectedEdges[0].kind ?? "orthogonal") === k && "bg-[#E1EAFF] text-primary")}>{l}</button>)}
          <button type="button" onClick={() => patchEdges({ dashed: !selectedEdges[0].dashed })} className={cn(barBtn, selectedEdges[0].dashed && "bg-[#E1EAFF] text-primary")}>{t("虚线")}</button>
          <button type="button" onClick={() => patchEdges({ arrow: selectedEdges[0].arrow === "none" ? undefined : selectedEdges[0].arrow === "both" ? "none" : "both" })} className={barBtn}>{t("箭头：{kind}", { kind: selectedEdges[0].arrow === "none" ? t("无") : selectedEdges[0].arrow === "both" ? t("双向") : t("单向") })}</button>
          <button type="button" onClick={() => setEditing({ id: selectedEdges[0].id, kind: "edge", value: selectedEdges[0].label ?? "" })} className={barBtn}>{t("文字")}</button>
          {selectedEdges.some((x) => x.pts?.length || x.mid !== undefined) && <button type="button" onClick={() => patchEdges({ pts: undefined, mid: undefined })} className={barBtn} title={t("恢复自动走线")} data-flow-clear-points>{t("清除拐点")}</button>}
        </>}
        <span className="mx-0.5 h-5 w-px bg-[#DEE0E3]" />
        {(commentActions || onComment) && selectedNodes.length > 0 && <button type="button" className={tb} title={t("评论此图形")} onClick={() => { const n = selectedNodes[0]; finishEdit(); const shapeSpec = SHAPES.find((x) => x.id === n.shape); const label = n.text.split("\n")[0] || (shapeSpec ? t(shapeSpec.label) : t("图形")); if (commentActions) { openCommentComposer({ kind: "node", targetId: n.id, x: Math.round(n.x + n.w), y: Math.round(n.y) }, label); return; } if (recoveryRef.current.length) { setRecoveryOpen(true); return; } onComment?.(label); onClose(); }} data-flow-comment><MessageSquare size={15} /></button>}
        <div className="relative"><button type="button" className={tb} title={t("更多")} onClick={() => setMenu(menu === "more" ? null : "more")} data-flow-more-btn><MoreHorizontal size={16} /></button>
          {menu === "more" && <div className={cn(pop, "right-0 w-44")} data-flow-more-menu>
            {selectedNodes.length > 0 && <>
              <button type="button" className={menuItem} onClick={() => { const c = clipOfSelection(); if (c) pasteClip(c, 20); setMenu(null); }}><Copy size={14} />{t("创建副本")}<span className="ml-auto text-[12px] text-subtle">⌘D</span></button>
              <button type="button" className={menuItem} onClick={() => { layer("front"); setMenu(null); }}><ArrowUpToLine size={14} />{t("置于顶层")}</button>
              <button type="button" className={menuItem} onClick={() => { layer("back"); setMenu(null); }}><ArrowDownToLine size={14} />{t("置于底层")}</button>
              <button type="button" className={menuItem} onClick={() => { commit({ ...graph, nodes: graph.nodes.map((n) => (selected.has(n.id) ? { ...n, rot: ((n.rot ?? 0) + 90) % 360 || undefined } : n)) }); setMenu(null); }} data-flow-rotate90><RotateCw size={14} />{t("旋转 90°")}</button>
              {selectedNodes.some((n) => n.rot) && <button type="button" className={menuItem} onClick={() => { commit({ ...graph, nodes: graph.nodes.map((n) => (selected.has(n.id) ? { ...n, rot: undefined } : n)) }); setMenu(null); }}><RotateCcw size={14} />{t("取消旋转")}</button>}
              <span className="my-1 block h-px bg-[#DEE0E3]" />
            </>}
            <button type="button" className={cn(menuItem, "text-destructive")} onClick={() => { removeSelected(); setMenu(null); }}><Trash2 size={14} />{t("删除")}<span className="ml-auto text-[12px] text-subtle">Del</span></button>
          </div>}
        </div>
      </div>, compact ? document.body : svgWrap.current)}
      </>}
    </div>
    {compact && connectFrom && <div className="absolute bottom-[68px] left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-lg border bg-surface px-3 py-2 text-[13px] shadow-md" role="status">{t("请选择要连接的图形")}<button type="button" className="text-primary" onClick={() => setConnectFrom(null)}>{t("取消")}</button></div>}

    {/* 左侧：图形库面板 + 竖向工具条（飞书画板布局） */}
    {!readOnly && compact && library && <button type="button" aria-label={t("关闭图形库")} className="absolute inset-0 z-30 bg-black/20" onClick={() => setLibrary(false)} />}
    {!readOnly && library && <aside className={cn("absolute bottom-0 left-0 top-0 flex w-[260px] flex-col border-r border-[#DEE0E3] bg-surface dark:border-border", compact ? "z-40 max-w-[calc(100%-48px)] shadow-xl" : "z-10")} aria-label={t("图形库")} data-flow-library>
      <div className="flex h-12 shrink-0 items-center gap-2 px-4"><span className="text-[14px] font-medium">{t("图形库")}</span><button type="button" title={t("收起")} onClick={() => setLibrary(false)} className="ml-auto grid size-7 place-items-center rounded text-subtle hover:bg-hover"><ChevronLeft size={16} /></button></div>
      <label className="mx-4 flex h-8 items-center gap-2 rounded-md border px-2 text-subtle focus-within:border-primary"><Search size={14} /><input value={libQuery} onChange={(e) => setLibQuery(e.target.value)} placeholder={t("搜索")} className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none" /></label>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {filteredGroups.map((g) => <section key={g.title} className="mt-4"><div className="mb-2 flex items-center gap-1 text-[13px] text-[#646A73]"><ChevronDown size={12} />{g.title}</div><div className="grid grid-cols-5 gap-1">{g.shapes.map((id, i) => { const spec = SHAPES.find((s) => s.id === id)!; return <button key={`${id}${i}`} type="button" title={t("{label}（点击后在画布上放置，双击直接添加）", { label: t(spec.label) })} onClick={() => { if (id === "image") imageRef.current?.click(); else { setTool(id); setHand(false); setShowStarter(false); } if (compact) setLibrary(false); }} onDoubleClick={() => id !== "image" && addNode(id)} className={cn("grid size-10 place-items-center rounded-md text-[#1F2329] hover:bg-hover dark:text-foreground", tool === id && "bg-[#E1EAFF] text-primary")} data-flow-shape={id}>{shapeIcon(id)}</button>; })}</div></section>)}
        {!libQuery.trim() && <section className="mt-4"><div className="mb-2 flex items-center gap-1 text-[13px] text-[#646A73]"><ChevronDown size={12} />{t("连线样式")}</div>
          <div className="grid grid-cols-5 gap-1">{([["orthogonal", t("折线"), "M10,78 H48 V18 H86"], ["straight", t("直线"), "M10,86 L86,10"], ["curve", t("曲线"), "M10,80 C40,80 56,16 86,16"]] as const).map(([k, l, d]) => <button key={k} type="button" title={t("新连线默认使用{kind}", { kind: l })} onClick={() => setEdgeKind(k)} className={cn("grid size-10 place-items-center rounded-md text-[#1F2329] hover:bg-hover dark:text-foreground", edgeKind === k && "bg-[#E1EAFF] text-primary")} data-flow-edge-kind={k}><svg viewBox="0 0 96 96" className="size-6" fill="none" stroke="currentColor" strokeWidth={6}><path d={d} /></svg></button>)}</div>
          <p className="mt-1 text-[12px] leading-5 text-subtle">{t("选中图形后，从四周的蓝色圆点拖到另一个图形即可连线。")}</p>
        </section>}
      </div>
    </aside>}
    {!readOnly && !(compact && (connectFrom || (barPos && !drag && !editing))) && <aside className={cn("absolute z-10 flex gap-0.5 rounded-xl border border-[#DEE0E3] bg-surface p-1.5 shadow-[0_4px_16px_rgba(31,35,41,0.08)] dark:border-border", compact ? "bottom-[68px] left-1/2 max-w-[calc(100%-24px)] -translate-x-1/2 flex-row overflow-x-auto" : "top-1/2 -translate-y-1/2 flex-col")} style={compact ? undefined : { left: library ? 272 : 12 }} aria-label={t("工具")}>
      <button type="button" className={cn(railBtn, library && "bg-[#E1EAFF]")} title={t("图形库")} onClick={() => setLibrary(!library)} data-flow-library-toggle><Shapes size={18} className="text-[#3370FF]" /></button>
      <span className={cn("bg-[#DEE0E3]", compact ? "mx-0.5 my-1 h-8 w-px shrink-0" : "mx-1 my-0.5 h-px")} />
      <button type="button" className={cn(railBtn, tool === "select" && !hand && !votingMode && "bg-[#E1EAFF] text-primary")} title={t("选择")} onClick={() => { setTool("select"); setHand(false); setVotingMode(false); }} data-flow-select-tool><MousePointer2 size={18} /></button>
      <button type="button" className={cn(railBtn, ((tool === "pen" && penKind === "pen") || tool === "eraser") && "bg-[#E1EAFF] text-primary")} title={t("画笔")} aria-label={t("画笔")} aria-pressed={(tool === "pen" && penKind === "pen") || tool === "eraser"} onClick={() => { setTool("pen"); setPenKind("pen"); setHand(false); setVotingMode(false); setSelected(new Set()); setMenu(null); setShowStarter(false); }} data-flow-pen-tool><Pencil size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "pen" && penKind === "marker" && "bg-[#FFF5C7] text-[#B25900]")} title={t("荧光笔")} aria-label={t("荧光笔")} aria-pressed={tool === "pen" && penKind === "marker"} onClick={() => { setTool("pen"); setPenKind("marker"); setHand(false); setVotingMode(false); setSelected(new Set()); setMenu(null); setShowStarter(false); }} data-board-tool="highlighter"><Highlighter size={18} /></button>
      <button type="button" className={cn(railBtn, menu === "sticky" && "bg-[#FFF3B0] text-[#9A5B00]")} title={t("便利贴")} aria-label={t("便利贴")} aria-expanded={menu === "sticky"} onClick={() => { setMenu(menu === "sticky" ? null : "sticky"); setVotingMode(false); }} data-board-add-sticky><StickyNote size={18} /></button>
      <button type="button" className={railBtn} aria-label={t("插入思维导图")} title={t("插入思维导图")} onClick={addMindMap} data-flow-mindmap-tool><ListTree size={18}/></button>
      <button type="button" className={railBtn} aria-label={t("分区画框")} title={t("分区画框 (Frame)")} onClick={addBoardFrame} data-board-frame-tool><Frame size={18}/></button>
      <button type="button" className={cn(railBtn, tool === "round" && "bg-[#E1EAFF] text-primary")} title={t("图形（点击画布放置）")} onClick={() => { setTool("round"); setHand(false); setVotingMode(false); setShowStarter(false); }}><Square size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "text" && "bg-[#E1EAFF] text-primary")} title={t("文本")} onClick={() => { setTool("text"); setHand(false); setVotingMode(false); setShowStarter(false); }}><Type size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "diamond" && "bg-[#E1EAFF] text-primary")} title={t("判断")} onClick={() => { setTool("diamond"); setHand(false); setVotingMode(false); setShowStarter(false); }}><Diamond size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "note" && "bg-[#E1EAFF] text-primary")} title={t("便签")} onClick={() => { setTool("note"); setHand(false); setVotingMode(false); setShowStarter(false); }}><svg viewBox="0 0 96 96" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={7}><path d="M14,12 H66 L82,28 V84 H14 Z M66,12 V28 H82" /></svg></button>
      {commentActions && <button type="button" className={cn(railBtn, tool === "comment" && "bg-[#FFF1E8] text-[#FF8800]")} title={t("评论图钉（点击画布或对象添加锚点评论）")} aria-label={t("评论图钉")} aria-pressed={tool === "comment"} onClick={() => { setTool((cur) => cur === "comment" ? "select" : "comment"); setSelected(new Set()); setHand(false); setVotingMode(false); setShowStarter(false); setMenu(null); }} data-flow-comment-tool><MessageSquare size={18} /></button>}
      {upload && <button type="button" className={railBtn} title={t("插入图片（也可粘贴或拖入画板）")} onClick={() => imageRef.current?.click()} data-flow-image-btn><ImageIcon size={18} /></button>}
      <input ref={imageRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void insertImage(f); }} data-flow-image-input />
    </aside>}
    {!readOnly && menu === "sticky" && (
      <div
        role="dialog"
        aria-label={t("选择便利贴颜色")}
        data-board-sticky-popover
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(
          "absolute z-30 w-[212px] rounded-xl border border-[#DEE0E3] bg-surface p-3 shadow-[0_8px_24px_rgba(31,35,41,0.14)] dark:border-border",
          compact ? "bottom-[124px] left-1/2 -translate-x-1/2" : "top-1/2 -translate-y-1/2",
        )}
        style={compact ? undefined : { left: library ? 328 : 68 }}
      >
        <div className="mb-2 flex items-center justify-between text-[12px] font-medium text-subtle">
          <span>{t("插入便利贴")}</span>
          <button type="button" aria-label={t("关闭")} onClick={() => setMenu(null)} className="grid size-5 place-items-center rounded hover:bg-hover"><X size={12} /></button>
        </div>
        <div className="grid grid-cols-5 gap-2">
          {STICKY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-board-sticky-color={preset.id}
              title={t(preset.label)}
              aria-label={t(preset.label)}
              onClick={() => insertStickyNote(preset)}
              className="group relative flex h-8 w-8 items-center justify-center rounded-md border shadow-sm transition-transform hover:scale-105"
              style={{ background: preset.fill, borderColor: preset.stroke }}
            >
              <span
                className="absolute bottom-0 right-0 size-2.5 rounded-tl-[2px]"
                style={{ background: preset.fold }}
                aria-hidden
              />
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-subtle">{t("点击颜色立即插入并输入文字")}</p>
      </div>
    )}
    {readOnly && commentActions && <div className={cn(floatBar, "absolute left-3 top-16 z-20")}>
      <button type="button" className={cn(barBtn, tool === "comment" && "bg-[#FFF1E8] text-[#FF8800]")} aria-label={t("评论图钉")} aria-pressed={tool === "comment"} onClick={() => setTool((cur) => cur === "comment" ? "select" : "comment")} data-flow-comment-tool><MessageSquare size={15} /><span>{tool === "comment" ? t("点击画布落钉") : t("评论")}</span></button>
    </div>}

    {!readOnly && mindViewMode === "canvas" && mindSelected && !mindEditing && !mindDescriptionEditing && !movingMind && <div role="toolbar" aria-label={t("思维导图节点操作")} data-mind-toolbar className={cn("z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-lg border border-[#DEE0E3] bg-surface p-1 shadow-lg [&>button]:shrink-0 [&>button]:whitespace-nowrap", compact ? "absolute bottom-[120px] left-1/2" : "fixed")} style={mindToolbarStyle} onPointerDown={(event) => event.stopPropagation()}>
      <FeishuSelect
        ariaLabel={t("导图结构")}
        title={t("切换思维导图结构")}
        value={mindStructure}
        options={MIND_LAYOUT_OPTIONS.map((opt) => ({ ...opt, label: t(opt.label) }))}
        onChange={(val) => {
          const next = val as MindLayoutKind;
          persistMindLayout(next, mindRelations);
          requestAnimationFrame(() => fit(graph, size, 0, next));
        }}
        className="h-8 min-w-[82px] border border-[#DEE0E3] px-2 text-[12px]"
        chevronSize={11}
        menuMinWidth={104}
        dataAttr={{ "data-mind-structure-select": "true" }}
      />
      <button
        type="button"
        data-mind-relation-btn
        aria-label={t("跨分支关联线")}
        aria-pressed={mindRelationFrom === mindSelected}
        title={t("点击目标主题创建跨分支虚线关联")}
        className={cn(barBtn, mindRelationFrom === mindSelected && "bg-[#F3EEFF] text-[#7B56D9]")}
        onClick={() => {
          if (mindRelationFrom === mindSelected) {
            setMindRelationFrom(null);
          } else {
            setMindRelationFrom(mindSelected);
            setNotice({ ok: true, text: t("请点击目标主题以创建跨分支关联线（Esc 取消）") });
          }
        }}
      >
        <Link2 size={14} />
        <span>{t("关联线")}</span>
      </button>
      <button
        type="button"
        data-mind-boundary-btn
        data-mind-paint-trigger
        aria-label={t("外框")}
        aria-expanded={mindPaintMenu?.kind === "boundary"}
        title={t("为当前分支添加或编辑外框")}
        className={cn(barBtn, (activeBoundary || mindPaintMenu?.kind === "boundary") && "bg-[#E1EAFF] text-[#3370FF]")}
        onClick={(event) => openMindPaintMenu("boundary", event.currentTarget)}
      >
        <BoxSelect size={14} />
        <span>{t("外框")}</span>
      </button>
      <button
        type="button"
        data-mind-summary-btn
        data-mind-paint-trigger
        aria-label={t("概要")}
        aria-expanded={mindPaintMenu?.kind === "summary"}
        title={t("为子分支添加花括号概要")}
        className={cn(barBtn, (activeSummary || mindPaintMenu?.kind === "summary") && "bg-[#F3EEFF] text-[#722ED1]")}
        onClick={(event) => openMindPaintMenu("summary", event.currentTarget)}
      >
        <Braces size={14} />
        <span>{t("概要")}</span>
      </button>
      <button
        type="button"
        data-mind-badge-btn
        data-mind-paint-trigger
        aria-label={t("徽章")}
        aria-expanded={mindPaintMenu?.kind === "badge"}
        title={t("设置优先级、进度或标签徽章")}
        className={cn(barBtn, (activeBadge || mindPaintMenu?.kind === "badge") && "bg-[#FFF1E0] text-[#DE7802]")}
        onClick={(event) => openMindPaintMenu("badge", event.currentTarget)}
      >
        <Tag size={14} />
        <span>{t("徽章")}</span>
      </button>
      <span className="mx-0.5 h-5 w-px shrink-0 bg-[#DEE0E3]"/>
      <button type="button" data-mind-paint-trigger aria-label={t("节点形状")} aria-expanded={mindPaintMenu?.kind === "shape"} title={t("更改图形")} className={barBtn} onClick={(event) => openMindPaintMenu("shape", event.currentTarget)}>{selectedShape === "text" ? <Type size={17}/> : selectedShape === "oval" ? <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5"><ellipse cx="9" cy="9" rx="7" ry="5"/></svg> : <Square size={17}/>}<ChevronDown size={11}/></button>
      {selectedShape !== "text" && <button type="button" data-mind-paint-trigger aria-label={t("节点填充")} aria-expanded={mindPaintMenu?.kind === "fill"} title={t("节点填充")} className={barBtn} onClick={(event) => openMindPaintMenu("fill", event.currentTarget)}><span className="size-4 rounded-full border border-[#bbbfc4]" style={{ background: currentPaint.fill === "none" ? "linear-gradient(135deg, transparent 46%, #c7cbd1 48%, #c7cbd1 52%, transparent 54%)" : currentPaint.fill ?? (mindAnchor?.topic.parent === null ? "#5b7ff1" : "#fff") }}/><ChevronDown size={11}/></button>}
      <button type="button" data-mind-paint-trigger aria-label={t("节点连线样式")} aria-expanded={mindPaintMenu?.kind === "line"} title={t("节点连线样式")} className={barBtn} onClick={(event) => openMindPaintMenu("line", event.currentTarget)}><span className="size-4 rounded-full border-[3px]" style={{ borderColor: currentPaint.stroke ?? "#5b7ff1" }}/><ChevronDown size={11}/></button>
      <button type="button" data-mind-paint-trigger aria-label={t("文字颜色和背景")} aria-expanded={mindPaintMenu?.kind === "textColor"} title={t("文字颜色和背景")} className={barBtn} onClick={(event) => openMindPaintMenu("textColor", event.currentTarget)}><span className="border-b-2 px-0.5 text-[15px]" style={{ borderColor: graph.mindStyles?.[mindSelected]?.color ?? mindDefaultColor, background: currentTextFormat.highlight ?? "transparent" }}>A</span><ChevronDown size={11}/></button>
      <FeishuSelect
        ariaLabel={t("文字大小")}
        title={t("文字大小")}
        value={String(graph.mindStyles?.[mindSelected]?.size ?? (mindAnchor?.topic.parent === null ? 16 : 14))}
        options={[12, 14, 16, 18, 24, 36, 48, 72, 96].map((size) => ({ value: String(size), label: String(size) }))}
        onChange={(val) => updateMindStyle({ size: Number(val) })}
        className="w-[52px] text-[13px]"
        chevronSize={11}
        menuMinWidth={68}
      />
      <button type="button" data-mind-paint-trigger aria-label={t("文字格式")} aria-expanded={mindPaintMenu?.kind === "textFormat"} title={t("文字格式")} className={barBtn} onClick={(event) => openMindPaintMenu("textFormat", event.currentTarget)}><span className="text-[15px]">A</span><AlignLeft size={12}/><ChevronDown size={11}/></button>
      <button type="button" aria-label={mindDescriptionAt(graph.mindDescriptions, mindSelected) ? t("编辑描述") : t("添加描述")} title={t("添加或编辑描述 (Shift + Enter)")} className={barBtn} onClick={() => { const topic = graph.mind?.find((item) => item.id === mindSelected); if (topic) startMindDescription(topic); }}><Plus size={15}/></button>
      {mindDescriptionAt(graph.mindDescriptions, mindSelected) && <button type="button" data-mind-paint-trigger aria-label={t("描述样式")} aria-expanded={mindPaintMenu?.kind === "description"} title={t("描述字号和颜色")} className={barBtn} onClick={(event) => openMindPaintMenu("description", event.currentTarget)}><span className="text-[13px]">Aa</span><ChevronDown size={11}/></button>}
      {commentActions && mindAnchor && <button type="button" aria-label={t("评论此主题")} title={t("评论此主题")} data-mind-comment className={barBtn} onClick={() => openCommentComposer({ kind: "mind", targetId: mindAnchor.topic.id, x: Math.round(mindAnchor.x + mindAnchor.w), y: Math.round(mindAnchor.y) }, mindAnchor.topic.text || t("导图主题"))}><MessageSquare size={15}/></button>}
      <span className="mx-1 h-5 w-px shrink-0 bg-[#DEE0E3]"/>
      <button type="button" data-mind-menu-trigger className={cn(barBtn, !compact && "order-last")} aria-label={t("更多节点操作")} aria-expanded={!!mindMenu} title={t("更多")} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); if (mindMenu) setMindMenu(null); else openMindMenu(rect.left, compact ? 8 : rect.top - 288); }}><MoreHorizontal size={16}/></button>
      {compact && <><button type="button" className={barBtn} aria-label={t("编辑文字")} title={t("编辑文字")} onClick={() => { const topic = graph.mind?.find((item) => item.id === mindSelected); if (topic) startMindEdit(topic); }}><Pencil size={15}/></button><button type="button" className={barBtn} aria-label={t("添加子节点")} title={t("添加子节点")} onClick={() => addMindTopic(false)}><Plus size={15}/></button><button type="button" className={barBtn} aria-label={t("添加同级节点")} title={t("添加同级节点")} disabled={!graph.mind?.find((topic) => topic.id === mindSelected)?.parent} onClick={() => addMindTopic(true)}><ListTree size={15}/></button><button type="button" className={barBtn} aria-label={t("删除节点")} title={t("删除节点")} onClick={removeMindTopic}><Trash2 size={15}/></button></>}
    </div>}

    {mindMenu && mindSelected && !readOnly && !mindEditing && !mindDescriptionEditing && <div role="menu" aria-label={t("节点操作")} data-mind-context className="fixed z-[96] overflow-y-auto rounded-lg border border-[#DEE0E3] bg-surface py-1 text-[13px] shadow-[0_5px_18px_rgba(31,35,41,0.16)]" style={{ left: mindMenu.left, top: mindMenu.top, width: Math.max(1, Math.min(192, window.innerWidth - 16)), maxHeight: mindMenu.maxHeight }} onPointerDown={(event) => event.stopPropagation()}>
      {!!mindAnchor?.topic.parent && <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover" onClick={() => { setMindMenu(null); addMindTopic(true); }}>{t("添加同级节点")} <span className="text-[#8f959e]">Enter</span></button>}
      <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover" onClick={() => { setMindMenu(null); addMindTopic(false); }}>{t("添加子节点")} <span className="text-[#8f959e]">Tab</span></button>
      {!!mindAnchor?.topic.parent && <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover" onClick={() => { setMindMenu(null); addMindParent(); }}>{t("添加父节点")} <span className="text-[#8f959e]">Shift + Tab</span></button>}
      {!!graph.mind?.some((topic) => topic.parent === mindSelected) && <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover" onClick={() => { setMindMenu(null); toggleMindFold(mindSelected); }}>{effectiveCollapsed.has(mindSelected) ? t("展开子节点") : t("收起子节点")}<span className="text-[#8f959e]">⌘ .</span></button>}
      <div className="my-1 border-t border-[#e5e6eb]"/>
      <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover" onClick={() => { const topic = graph.mind?.find((item) => item.id === mindSelected); if (topic) startMindDescription(topic); }}>{mindDescriptionAt(graph.mindDescriptions, mindSelected) ? t("编辑描述") : t("添加描述")}<span className="text-[#8f959e]">Shift + Enter</span></button>
      <div className="my-1 border-t border-[#e5e6eb]"/>
      <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover disabled:opacity-40" disabled={!canCopy} onClick={() => { setMindMenu(null); void copyMindToClipboard(false); }}>{t("复制")} <span className="text-[#8f959e]">⌘ C</span></button>
      <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover disabled:opacity-40" disabled={!canCopy} onClick={() => { setMindMenu(null); void copyMindNodeImage(); }}>{t("复制为图片")} <span className="text-[#8f959e]">⌘ ⇧ C</span></button>
      <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover disabled:opacity-40" disabled={!canCopy} onClick={() => { setMindMenu(null); void copyMindToClipboard(true); }}>{t("剪切")} <span className="text-[#8f959e]">⌘ X</span></button>
      <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover" onClick={() => { setMindMenu(null); void pasteMindFromClipboard(); }}>{t("粘贴")} <span className="text-[#8f959e]">⌘ V</span></button>
      {mindClipboardFallback && recentMindClipboard.current && <button type="button" role="menuitem" className="flex h-8 w-full items-center px-3 text-left hover:bg-hover" onClick={() => { const clip = recentMindClipboard.current; setMindMenu(null); if (clip) insertMindClip(clip); }}>{t("粘贴本页最近复制的分支")}</button>}
      <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover disabled:opacity-40" disabled={!canCopy} onClick={() => { setMindMenu(null); duplicateMind(); }}>{t("创建副本")} <span className="text-[#8f959e]">⌘ D</span></button>
      <div className="my-1 border-t border-[#e5e6eb]"/>
      <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover disabled:opacity-40" disabled={!canCopy} onClick={() => { setMindMenu(null); void copyMindTextStyle(); }}>{t("复制样式")} <span className="text-[#8f959e]">⌘ ⌥ C</span></button>
      <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover" onClick={() => { setMindMenu(null); void pasteMindTextStyle(); }}>{t("粘贴样式")} <span className="text-[#8f959e]">⌘ ⌥ V</span></button>
      <div className="my-1 border-t border-[#e5e6eb]"/>
      <button type="button" role="menuitem" className="flex h-8 w-full items-center justify-between px-3 text-left hover:bg-hover" onClick={() => { setMindMenu(null); removeMindTopic(); }}>{t("删除")} <span className="text-[#8f959e]">⌫</span></button>
    </div>}

    {mindPaintMenu && mindSelected && !readOnly && !mindEditing && !mindDescriptionEditing && <div role="dialog" aria-label={{ fill: t("节点填充"), line: t("节点连线样式"), shape: t("更改图形"), textColor: t("文字颜色和背景"), textFormat: t("文字格式"), description: t("描述样式"), boundary: t("分支外框"), summary: t("分支概要"), badge: t("节点徽章") }[mindPaintMenu.kind]} data-mind-paint-menu className="fixed z-[95] max-h-[calc(100dvh-16px)] overflow-y-auto rounded-lg border border-[#DEE0E3] bg-surface p-3 text-[12px] shadow-[0_5px_18px_rgba(31,35,41,0.16)]" style={{ left: mindPaintMenu.left, top: mindPaintMenu.top, width: mindPaintMenu.kind === "shape" ? 144 : mindPaintMenu.kind === "textFormat" ? 200 : mindPaintMenu.kind === "badge" ? 264 : 244 }} onPointerDown={(event) => event.stopPropagation()}>
      {mindPaintMenu.kind !== "textFormat" && <div className="mb-2 text-[#646A73]">{{ fill: t("填充颜色"), line: t("连线样式"), shape: t("更改图形"), textColor: t("文字颜色"), description: t("描述样式"), boundary: t("分支外框"), summary: t("分支概要"), badge: t("优先级与进度徽章") }[mindPaintMenu.kind]}</div>}
      {mindPaintMenu.kind === "boundary" && (
        <div className="space-y-2.5" data-mind-boundary-popover>
          <input
            type="text"
            maxLength={40}
            value={boundaryLabelDraft}
            onChange={(e) => setBoundaryLabelDraft(e.target.value)}
            placeholder={t("外框标签（如：阶段一）")}
            data-mind-boundary-input
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                setMindBoundaryFor(mindSelected, {
                  ...(boundaryLabelDraft.trim() ? { label: boundaryLabelDraft.trim() } : {}),
                  color: activeBoundary?.color ?? "#3370ff",
                });
                setMindPaintMenu(null);
              }
            }}
            className="h-8 w-full select-text rounded-md border border-[#DEE0E3] bg-background px-2 text-[12px] text-foreground outline-none focus:border-primary"
          />
          <div className="flex items-center gap-1.5">
            {MIND_BOUNDARY_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                onClick={() =>
                  setMindBoundaryFor(mindSelected, {
                    ...(boundaryLabelDraft.trim() ? { label: boundaryLabelDraft.trim() } : {}),
                    color,
                  })
                }
                className={cn(
                  "size-6 rounded-full border border-[#d4d7dc]",
                  (activeBoundary?.color ?? "#3370ff") === color && "ring-2 ring-[#3370ff] ring-offset-1",
                )}
                style={{ background: color }}
              />
            ))}
          </div>
          <div className="flex items-center justify-end gap-1.5 pt-1">
            {activeBoundary && (
              <button
                type="button"
                data-mind-boundary-remove
                onClick={() => { setMindBoundaryFor(mindSelected, null); setMindPaintMenu(null); }}
                className="h-7 rounded-md border border-[#f5b5b2] px-2.5 text-[12px] text-[#d83931] hover:bg-[#fde8e8]"
              >
                {t("移除外框")}
              </button>
            )}
            <button
              type="button"
              data-mind-boundary-save
              onClick={() => {
                setMindBoundaryFor(mindSelected, {
                  ...(boundaryLabelDraft.trim() ? { label: boundaryLabelDraft.trim() } : {}),
                  color: activeBoundary?.color ?? "#3370ff",
                });
                setMindPaintMenu(null);
              }}
              className="h-7 rounded-md bg-primary px-3 text-[12px] font-medium text-white hover:bg-primary/90"
            >
              {t("应用")}
            </button>
          </div>
        </div>
      )}
      {mindPaintMenu.kind === "summary" && summaryTargetId && (
        <div className="space-y-2.5" data-mind-summary-popover>
          <input
            type="text"
            maxLength={80}
            value={summaryLabelDraft}
            onChange={(e) => setSummaryLabelDraft(e.target.value)}
            placeholder={t("概要内容（如：核心结论）")}
            data-mind-summary-input
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                setMindSummaryFor(summaryTargetId, {
                  label: summaryLabelDraft.trim() || t("概要"),
                  color: activeSummary?.color ?? "#722ed1",
                });
                setMindPaintMenu(null);
              }
            }}
            className="h-8 w-full select-text rounded-md border border-[#DEE0E3] bg-background px-2 text-[12px] text-foreground outline-none focus:border-primary"
          />
          <div className="flex items-center gap-1.5">
            {MIND_SUMMARY_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                onClick={() =>
                  setMindSummaryFor(summaryTargetId, {
                    label: summaryLabelDraft.trim() || t("概要"),
                    color,
                  })
                }
                className={cn(
                  "size-6 rounded-full border border-[#d4d7dc]",
                  (activeSummary?.color ?? "#722ed1") === color && "ring-2 ring-[#722ed1] ring-offset-1",
                )}
                style={{ background: color }}
              />
            ))}
          </div>
          <div className="flex items-center justify-end gap-1.5 pt-1">
            {activeSummary && (
              <button
                type="button"
                data-mind-summary-remove
                onClick={() => { setMindSummaryFor(summaryTargetId, null); setMindPaintMenu(null); }}
                className="h-7 rounded-md border border-[#f5b5b2] px-2.5 text-[12px] text-[#d83931] hover:bg-[#fde8e8]"
              >
                {t("移除概要")}
              </button>
            )}
            <button
              type="button"
              data-mind-summary-save
              onClick={() => {
                setMindSummaryFor(summaryTargetId, {
                  label: summaryLabelDraft.trim() || t("概要"),
                  color: activeSummary?.color ?? "#722ed1",
                });
                setMindPaintMenu(null);
              }}
              className="h-7 rounded-md bg-[#722ed1] px-3 text-[12px] font-medium text-white hover:bg-[#5b21b6]"
            >
              {t("应用")}
            </button>
          </div>
        </div>
      )}
      {mindPaintMenu.kind === "badge" && (
        <div className="space-y-3" data-mind-badge-popover>
          <div>
            <div className="mb-1 text-[11px] text-subtle">{t("优先级")}</div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => patchMindBadgeFor(mindSelected, { priority: undefined })}
                className={cn(
                  "h-7 flex-1 rounded-md border text-[11px] font-medium",
                  activeBadge?.priority === undefined ? "border-primary bg-[#e1eaff] text-primary" : "border-[#dee0e3] hover:bg-hover",
                )}
              >
                {t("无")}
              </button>
              {MIND_PRIORITIES.map((p: MindPriority) => {
                const meta = priorityBadgeMeta(p);
                const selectedP = activeBadge?.priority === p;
                return (
                  <button
                    key={p}
                    type="button"
                    data-mind-badge-pick-priority={p}
                    onClick={() => patchMindBadgeFor(mindSelected, { priority: selectedP ? undefined : p })}
                    className={cn("h-7 flex-1 rounded-md border text-[11px] font-semibold transition-all", selectedP && "ring-2 ring-primary/40")}
                    style={{
                      background: selectedP ? meta.bg : undefined,
                      color: meta.fg,
                      borderColor: selectedP ? meta.fg : meta.border,
                    }}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] text-subtle">{t("完成进度")}</div>
            <div className="grid grid-cols-6 gap-1">
              <button
                type="button"
                onClick={() => patchMindBadgeFor(mindSelected, { progress: undefined })}
                className={cn(
                  "h-7 rounded-md border text-[11px]",
                  activeBadge?.progress === undefined ? "border-primary bg-[#e1eaff] font-medium text-primary" : "border-[#dee0e3] hover:bg-hover",
                )}
              >
                {t("无")}
              </button>
              {MIND_PROGRESS_STEPS.map((prog: MindProgress) => {
                const selectedProg = activeBadge?.progress === prog;
                return (
                  <button
                    key={prog}
                    type="button"
                    data-mind-badge-pick-progress={prog}
                    onClick={() => patchMindBadgeFor(mindSelected, { progress: selectedProg ? undefined : prog })}
                    className={cn(
                      "h-7 rounded-md border text-[11px] tabular-nums",
                      selectedProg ? "border-primary bg-[#e1eaff] font-semibold text-primary" : "border-[#dee0e3] hover:bg-hover",
                    )}
                  >
                    {prog}%
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] text-subtle">{t("标签")}</div>
            <div className="flex items-center gap-1">
              <input
                type="text"
                maxLength={16}
                value={badgeTagDraft}
                onChange={(e) => setBadgeTagDraft(e.target.value)}
                placeholder={t("输入简短标签")}
                data-mind-badge-tag-input
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    patchMindBadgeFor(mindSelected, { tag: badgeTagDraft.trim() || undefined });
                  }
                }}
                className="h-7 min-w-0 flex-1 select-text rounded-md border border-[#DEE0E3] bg-background px-2 text-[12px] text-foreground outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => patchMindBadgeFor(mindSelected, { tag: badgeTagDraft.trim() || undefined })}
                className="h-7 shrink-0 rounded-md bg-primary px-2.5 text-[11px] font-medium text-white hover:bg-primary/90"
              >
                {t("应用")}
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {[t("核心"), t("待确认"), t("阻塞"), t("已完成")].map((presetTag) => (
                <button
                  key={presetTag}
                  type="button"
                  onClick={() => { setBadgeTagDraft(presetTag); patchMindBadgeFor(mindSelected, { tag: presetTag }); }}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px]",
                    activeBadge?.tag === presetTag
                      ? "border-[#722ed1] bg-[#f0ebff] font-medium text-[#6425d0]"
                      : "border-[#dee0e3] text-subtle hover:bg-hover",
                  )}
                >
                  {presetTag}
                </button>
              ))}
            </div>
          </div>
          {activeBadge && (
            <div className="flex justify-end border-t border-[#eff0f1] pt-2">
              <button
                type="button"
                data-mind-badge-clear
                onClick={() => { setBadgeTagDraft(""); patchMindBadgeFor(mindSelected, null); setMindPaintMenu(null); }}
                className="text-[11px] text-[#d83931] hover:underline"
              >
                {t("清除全部徽章")}
              </button>
            </div>
          )}
        </div>
      )}
      {mindPaintMenu.kind === "shape" && <div className="flex gap-1">{(["text", "oval", "rect"] as const).map((shape) => <button key={shape} type="button" aria-label={{ text: t("文字形状"), oval: t("椭圆形状"), rect: t("矩形形状") }[shape]} aria-pressed={selectedShape === shape} className={cn("grid size-8 place-items-center rounded hover:bg-hover", selectedShape === shape && "bg-[#e1eaff] text-[#3370ff]")} onClick={() => { updateMindStyle({ shape }); setMindPaintMenu(null); }}>{shape === "text" ? <Type size={17}/> : shape === "oval" ? <Circle size={17} className="scale-y-75"/> : <Square size={17}/>}</button>)}</div>}
      {mindPaintMenu.kind === "textFormat" && <><div className="flex gap-1 border-b border-[#e5e6eb] pb-2">{([ ["bold", t("加粗"), Bold], ["strike", t("删除线"), Strikethrough], ["underline", t("下划线"), Underline], ["italic", t("斜体"), Italic] ] as const).map(([key, label, Icon]) => <button key={key} type="button" aria-label={label} aria-pressed={!!currentTextFormat[key]} className={cn("grid size-8 place-items-center rounded hover:bg-hover", currentTextFormat[key] && "bg-[#e1eaff] text-[#3370ff]")} onClick={() => updateMindTextFormat({ [key]: currentTextFormat[key] ? undefined : true })}><Icon size={16}/></button>)}</div><div className="mt-2 flex gap-1">{([ ["left", t("左对齐"), AlignLeft], ["center", t("居中对齐"), AlignCenter], ["right", t("右对齐"), AlignRight] ] as const).map(([align, label, Icon]) => <button key={align} type="button" aria-label={label} aria-pressed={(currentTextFormat.align ?? (mindAnchor?.topic.parent === null || selectedShape !== "text" ? "center" : "left")) === align} className={cn("grid h-8 flex-1 place-items-center rounded hover:bg-hover", (currentTextFormat.align ?? (mindAnchor?.topic.parent === null || selectedShape !== "text" ? "center" : "left")) === align && "bg-[#e1eaff] text-[#3370ff]")} onClick={() => updateMindTextFormat({ align })}><Icon size={16}/></button>)}</div></>}
      {mindPaintMenu.kind === "textColor" && <><div className="grid grid-cols-8 gap-1.5"><button type="button" aria-label={t("自动文字颜色")} className="size-6 rounded border border-[#d4d7dc] text-[#3370ff]" onClick={() => updateMindStyle({ color: undefined })}>A</button>{mindPalette.slice(0, 7).map(([color, name]) => <button key={color} type="button" aria-label={t("{color}文字", { color: name })} aria-pressed={graph.mindStyles?.[mindSelected]?.color === color} className="size-6 rounded border border-[#d4d7dc] font-semibold" style={{ color }} onClick={() => updateMindStyle({ color })}>A</button>)}</div><div className="mb-2 mt-3 text-[#646A73]">{t("背景颜色")}</div><div className="grid grid-cols-8 gap-1.5"><button type="button" aria-label={t("无文字背景")} className="size-6 rounded border border-[#d4d7dc]" style={{ background: "linear-gradient(135deg, #fff 47%, #c7cbd1 49%, #c7cbd1 52%, #fff 54%)" }} onClick={() => updateMindTextFormat({ highlight: undefined })}/>{mindPalette.slice(4, 11).map(([color, name]) => <button key={color} type="button" aria-label={t("{color}文字背景", { color: name })} aria-pressed={currentTextFormat.highlight === color} className="size-6 rounded border border-[#d4d7dc]" style={{ background: color }} onClick={() => updateMindTextFormat({ highlight: color })}/>)}</div><div className="mt-2 flex gap-3"><label className="relative cursor-pointer text-[#646A73]">{t("自定义文字色")}<input aria-label={t("自定义文字颜色")} type="color" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={graph.mindStyles?.[mindSelected]?.color ?? mindDefaultColor} onChange={(event) => updateMindStyle({ color: event.target.value })}/></label><label className="relative cursor-pointer text-[#646A73]">{t("自定义背景色")}<input aria-label={t("自定义文字背景")} type="color" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={currentTextFormat.highlight ?? "#fff5c7"} onChange={(event) => updateMindTextFormat({ highlight: event.target.value })}/></label></div></>}
      {mindPaintMenu.kind === "description" && <><div className="mb-3 flex items-center justify-between text-[#646a73]"><span>{t("字号")}</span><FeishuSelect ariaLabel={t("描述字号")} value={String(currentDescriptionStyle.size ?? 12)} options={[12, 14, 16, 18, 24, 36, 48, 72, 96].map((size) => ({ value: String(size), label: String(size) }))} onChange={(val) => updateMindDescriptionStyle({ size: Number(val) })} className="h-7 w-20 border border-[#dee0e3] bg-surface px-2 text-[#1f2329]" chevronSize={11} menuMinWidth={76} /></div><div className="mb-2 text-[#646a73]">{t("文字颜色")}</div><div className="grid grid-cols-8 gap-1.5"><button type="button" aria-label={t("默认描述颜色")} className="size-6 rounded border border-[#d4d7dc] text-[#8f959e]" onClick={() => updateMindDescriptionStyle({ color: undefined })}>A</button>{[0, 1, 4, 5, 6, 8, 9].map((index) => mindPalette[index]).map(([color, name]) => <button key={color} type="button" aria-label={t("{color}描述文字", { color: name })} aria-pressed={currentDescriptionStyle.color === color} className="size-6 rounded border border-[#d4d7dc] font-semibold" style={{ color }} onClick={() => updateMindDescriptionStyle({ color })}>A</button>)}</div><div className="mb-2 mt-3 text-[#646a73]">{t("文字背景")}</div><div className="grid grid-cols-8 gap-1.5"><button type="button" aria-label={t("无描述背景")} className="size-6 rounded border border-[#d4d7dc]" style={{ background: "linear-gradient(135deg, #fff 47%, #c7cbd1 49%, #c7cbd1 52%, #fff 54%)" }} onClick={() => updateMindDescriptionStyle({ highlight: undefined })}/>{mindPalette.slice(9, 16).map(([color, name]) => <button key={color} type="button" aria-label={t("{color}描述背景", { color: name })} aria-pressed={currentDescriptionStyle.highlight === color} className="size-6 rounded border border-[#d4d7dc]" style={{ background: color }} onClick={() => updateMindDescriptionStyle({ highlight: color })}/>)}</div><div className="mt-3 flex gap-3"><label className="relative cursor-pointer text-[#646a73]">{t("自定义文字色")}<input aria-label={t("自定义描述文字颜色")} type="color" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={currentDescriptionStyle.color ?? "#8f959e"} onChange={(event) => updateMindDescriptionStyle({ color: event.target.value })}/></label><label className="relative cursor-pointer text-[#646a73]">{t("自定义背景色")}<input aria-label={t("自定义描述背景颜色")} type="color" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={currentDescriptionStyle.highlight ?? "#fff5c7"} onChange={(event) => updateMindDescriptionStyle({ highlight: event.target.value })}/></label></div></>}
      {(mindPaintMenu.kind === "line" || mindPaintMenu.kind === "fill") && <>
      {mindPaintMenu.kind === "line" && <><div className="mb-2 flex gap-1">{(["solid", "dashed", "dotted"] as const).map((line) => <button key={line} type="button" aria-label={{ solid: t("实线"), dashed: t("虚线"), dotted: t("点线") }[line]} aria-pressed={(currentPaint.line ?? "solid") === line} className={cn("h-7 flex-1 rounded text-[16px] hover:bg-hover", (currentPaint.line ?? "solid") === line && "bg-[#e1eaff] text-[#3370ff]")} onClick={() => updateMindPaint({ line })}>{line === "solid" ? "—" : line === "dashed" ? "---" : "····"}</button>)}</div><div className="mb-2 flex gap-1">{[1, 2, 3, 4].map((width) => <button key={width} type="button" aria-label={t("线宽 {width}", { width })} aria-pressed={(currentPaint.width ?? 2) === width} className={cn("grid h-7 flex-1 place-items-center rounded hover:bg-hover", (currentPaint.width ?? 2) === width && "bg-[#e1eaff]")} onClick={() => updateMindPaint({ width })}><span className="rounded-full bg-[#1f2329]" style={{ width: 3 + width * 2, height: 3 + width * 2 }}/></button>)}</div></>}
      <div className="grid grid-cols-8 gap-1.5">{mindPaintMenu.kind === "fill" && <button type="button" aria-label={t("无填充")} title={t("无填充")} className="size-6 rounded-full border border-[#d4d7dc]" style={{ background: "linear-gradient(135deg, #fff 47%, #c7cbd1 49%, #c7cbd1 52%, #fff 54%)" }} onClick={() => updateMindPaint({ fill: "none" })}/>} {mindPaintMenu.kind === "line" && <button type="button" aria-label={t("自动线条颜色")} title={t("自动线条颜色")} className="size-6 rounded-full border border-[#d4d7dc] text-[#3370ff]" onClick={() => updateMindPaint({ stroke: undefined })}>✦</button>}{mindPalette.map(([color, name]) => <button key={color} type="button" aria-label={mindPaintMenu.kind === "fill" ? t("{color}填充", { color: name }) : t("{color}线条", { color: name })} title={name} aria-pressed={(mindPaintMenu.kind === "fill" ? currentPaint.fill : currentPaint.stroke) === color} className={cn("size-6 rounded-full border border-[#d4d7dc]", (mindPaintMenu.kind === "fill" ? currentPaint.fill : currentPaint.stroke) === color && "ring-2 ring-[#3370ff] ring-offset-1")} style={{ background: color }} onClick={() => updateMindPaint(mindPaintMenu.kind === "fill" ? { fill: color } : { stroke: color })}/>)}</div>
      <label className="mt-3 block text-[#646A73]">{t("不透明度")} <span className="float-right">{mindPaintMenu.kind === "fill" ? currentPaint.fillOpacity ?? 100 : currentPaint.opacity ?? 100}%</span><input aria-label={mindPaintMenu.kind === "fill" ? t("填充不透明度") : t("线条不透明度")} type="range" min={0} max={100} className="mt-1 block w-full accent-[#3370ff]" value={mindPaintMenu.kind === "fill" ? currentPaint.fillOpacity ?? 100 : currentPaint.opacity ?? 100} onChange={(event) => updateMindPaint(mindPaintMenu.kind === "fill" ? { fillOpacity: Number(event.target.value) } : { opacity: Number(event.target.value) })}/></label>
      </>}
    </div>}
    {mindOffer === mindSelected && hasMindSiblings && !mindEditing && !mindDescriptionEditing && !mindPaintMenu && <div className="fixed z-[90] flex items-center gap-2 rounded-lg border border-[#DEE0E3] bg-surface px-3 py-2 text-[12px] shadow-md" style={compact ? { left: 12, bottom: 170, maxWidth: "calc(100% - 24px)" } : { left: mindToolbarStyle?.left ?? 170, top: treeTop - 50 >= 64 ? Math.max(8, toolbarTop - 44) : Math.min(windowHeight - 44, toolbarTop + 48), transform: "translateX(-50%)" }} onPointerDown={(event) => event.stopPropagation()}><span>{t("应用样式到所有同级节点")}</span><button type="button" aria-label={t("应用到同级节点")} className="text-[#2ea121]" onClick={applyMindStyleToSiblings}>✓</button><button type="button" aria-label={t("关闭同级样式提示")} className="text-[#d83931]" onClick={() => setMindOffer(null)}>×</button></div>}

    {!readOnly && (tool === "pen" || tool === "eraser") && <div role="toolbar" aria-label={t("画笔工具")} data-flow-pen-toolbar onPointerDown={(event) => event.stopPropagation()} className={cn("absolute left-1/2 z-20 flex h-12 max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1 rounded-full border border-[#DEE0E3] bg-surface px-2 shadow-[0_4px_16px_rgba(31,35,41,0.12)]", compact ? "bottom-[120px]" : "bottom-5")}>
      <button type="button" aria-label={t("画笔模式")} aria-pressed={tool === "pen" && penKind === "pen"} title={t("画笔")} className={cn(tb, tool === "pen" && penKind === "pen" && "bg-[#E1EAFF] text-primary")} onClick={() => { setTool("pen"); setPenKind("pen"); setMenu(null); }}><Pencil size={17}/></button>
      <button type="button" aria-label={t("荧光笔")} aria-pressed={tool === "pen" && penKind === "marker"} title={t("荧光笔")} className={cn(tb, tool === "pen" && penKind === "marker" && "bg-[#E1EAFF] text-primary")} onClick={() => { setTool("pen"); setPenKind("marker"); setMenu(null); }}><Brush size={17}/></button>
      <button type="button" aria-label={t("橡皮擦")} aria-pressed={tool === "eraser"} title={t("橡皮擦（擦除整条笔迹）")} data-flow-eraser-tool className={cn(tb, tool === "eraser" && "bg-[#E1EAFF] text-primary")} onClick={() => { setTool("eraser"); setMenu(null); }}><Eraser size={17}/></button>
      <span className="mx-1 h-6 w-px shrink-0 bg-[#DEE0E3]"/>
      <FeishuSelect
        ariaLabel={t("画笔粗细")}
        title={t("画笔粗细")}
        disabled={tool !== "pen"}
        value={String(penKind === "marker" ? markerWidth : penWidth)}
        options={(penKind === "marker" ? MARKER_WIDTHS : INK_WIDTHS).map((width) => ({ value: String(width), label: String(width) }))}
        onChange={(val) => penKind === "marker" ? setMarkerWidth(Number(val)) : setPenWidth(Number(val))}
        className="min-w-[50px] text-[12px] text-[#646A73]"
        chevronSize={11}
        menuMinWidth={64}
      />
      <div className="relative"><button type="button" aria-label={t("画笔颜色")} aria-expanded={menu === "pen"} title={t("画笔颜色")} disabled={tool !== "pen"} className={tb} onClick={() => setMenu(menu === "pen" ? null : "pen")}><span className="size-4 rounded-full border border-[#bbbfc4]" style={{ background: activeInkColor }}/></button>{menu === "pen" && penSettings}</div>
      <button type="button" aria-label={t("关闭画笔工具")} title={t("关闭画笔工具")} className={tb} onClick={() => { setTool("select"); setMenu(null); }}><X size={16}/></button>
    </div>}

    {/* 左上：返回 */}
    <button type="button" onClick={requestClose} className={cn(floatBar, "absolute top-3 z-20 h-10 px-3 text-[14px]")} style={{ left: !readOnly && library && !compact ? 272 : 12 }} data-flow-done><ChevronLeft size={16} />{mindBoard ? t("思维导图") : t("流程图")}</button>

    {/* 右上：大纲切换 / 投票 / 计时 / 评论徽标 / 风格 / 自动排版 / AI 生成 / 导入 / 导出 */}
    <div className={cn(floatBar, "absolute right-3 top-3 z-20")} data-flow-global-tools>
      {(hasMindTopics || mindBoard) && (
        <button
          type="button"
          data-mind-view-toggle
          aria-pressed={mindViewMode === "outline"}
          aria-label={mindViewMode === "outline" ? t("导图视图") : t("大纲视图")}
          title={mindViewMode === "outline" ? t("切换回导图视图") : t("切换到大纲视图")}
          className={cn(barBtn, mindViewMode === "outline" && "bg-[#E1EAFF] text-primary")}
          onClick={() => setMindViewMode((m) => (m === "outline" ? "canvas" : "outline"))}
        >
          {mindViewMode === "outline" ? <Network size={15} /> : <List size={15} />}
          <span className="hidden md:inline">{mindViewMode === "outline" ? t("导图视图") : t("大纲视图")}</span>
        </button>
      )}
      {!readOnly && (
        <button
          type="button"
          data-board-voting-toggle
          aria-pressed={votingMode}
          aria-label={t("团队投票")}
          title={votingMode ? t("点击任意便利贴或图形投票/取消投票") : t("开启团队投票模式")}
          className={cn(barBtn, votingMode && "bg-[#E1EAFF] font-medium text-[#3370FF]")}
          onClick={() => {
            setVotingMode((v) => {
              const next = !v;
              if (next) {
                setTool("select");
                setHand(false);
                setMenu(null);
              }
              return next;
            });
          }}
        >
          <ThumbsUp size={15} />
          <span className="hidden md:inline">{t("投票")}</span>
          {totalVotes > 0 && (
            <span className="rounded-full bg-[#3370FF] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
              {totalVotes}
            </span>
          )}
        </button>
      )}
      <button
        type="button"
        data-board-timer-toggle-btn
        aria-pressed={timerOpen}
        aria-label={t("倒计时器")}
        title={t("头脑风暴倒计时")}
        className={cn(barBtn, timerOpen && "bg-[#E1EAFF] text-[#3370FF]")}
        onClick={() => setTimerOpen((open) => !open)}
      >
        <Timer size={15} />
        <span className="hidden md:inline">{t("计时")}</span>
      </button>
      {boardPins.length > 0 && (
        <button
          type="button"
          aria-label={t("画板评论 {count} 条", { count: boardPins.length })}
          title={t("查看画板评论图钉")}
          data-flow-comments-count
          className={cn(barBtn, "text-[#B25900] hover:bg-[#FFF7E6]")}
          onClick={() => {
            const idx = openPinId === null ? 0 : (boardPins.findIndex((p) => p.root.id === openPinId) + 1) % boardPins.length;
            const target = boardPins[idx];
            if (target) {
              setView((v) => ({ ...v, x: target.x - size.w / (2 * v.zoom), y: target.y - size.h / (2 * v.zoom) }));
              focusPin(target);
            }
          }}
        >
          <MessageSquare size={15} className="text-[#FF8800]" />
          <span>{boardPins.length}</span>
        </button>
      )}
      {!readOnly && <>
        <div className="relative"><button type="button" aria-label={t("模板")} title={t("模板")} className={barBtn} onClick={() => setMenu(menu === "template" ? null : "template")} data-flow-template-btn><LayoutTemplate size={15} /><span className="hidden md:inline">{t("模板")}</span></button>
          {menu === "template" && <div className={cn(pop, "right-0 w-60")}>{FLOW_TEMPLATES.map((tpl) => <button key={tpl.id} type="button" className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-hover" onClick={() => applyTemplate(tpl)}><span>{t(tpl.label)}</span><span className="text-[12px] text-subtle">{graph.nodes.length ? t("{desc}（追加到右侧）", { desc: t(tpl.desc) }) : t(tpl.desc)}</span></button>)}</div>}
        </div>
        <div className="relative"><button type="button" aria-label={t("风格")} title={t("风格")} className={barBtn} onClick={() => setMenu(menu === "theme" ? null : "theme")} data-flow-theme-btn><Palette size={15} /><span className="hidden md:inline">{t("风格")}</span></button>
          {menu === "theme" && <div className={cn(pop, "right-0 grid w-[300px] grid-cols-3 gap-1.5 p-2")}>{THEMES.map((th) => <button key={th.id} type="button" onClick={() => { commit({ ...graph, theme: th.id }); setMenu(null); }} className={cn("rounded-md border p-1.5 text-center text-[12px] hover:border-primary", graph.theme === th.id && "border-primary text-primary")} data-flow-theme={th.id}><span className="mb-1 block h-8 rounded" style={{ background: th.canvas, border: `1px solid #DEE0E3` }}><span className="mx-auto mt-2 block h-4 w-10" style={{ background: th.palette ? th.palette[0].split("/")[0] : th.fill, border: `${th.strokeWidth}px solid ${th.palette ? th.palette[0].split("/")[1] : th.stroke}`, borderRadius: th.radius / 2 }} /></span>{t(th.label)}</button>)}</div>}
        </div>
        <button type="button" aria-label={t("自动排版")} disabled={!graph.nodes.length} className={barBtn} onClick={() => { const next = autoLayout(graph); commit(next); requestAnimationFrame(() => fit(next)); }} title={graph.nodes.length ? t("按连线关系自动排版流程图") : t("暂无流程图图形可排版")}><Spline size={15} /><span className="hidden md:inline">{t("自动排版")}</span></button>
        <div className="relative"><button type="button" aria-label={mindBoard ? t("AI 生成流程图") : t("AI 生成")} className={cn(barBtn, !ai && "opacity-60")} onClick={() => (ai ? setMenu(menu === "ai" ? null : "ai") : openAISettings())} title={ai ? t("用 AI 生成流程图") : t("请先在 AI 设置中配置 API Key")} data-flow-ai-btn><Sparkles size={15} className="text-primary" /><span className="hidden md:inline">{mindBoard ? t("AI 生成流程图") : t("AI 生成")}</span></button>
          {menu === "ai" && ai && <div className={cn(pop, "right-0 w-[360px] p-3")}>
            <textarea autoFocus value={aiText} onChange={(e) => setAiText(e.target.value)} rows={4} maxLength={1000} placeholder={t("描述流程，例如：用户注册流程，包含填写信息、校验手机号、校验失败重试、创建账号、发送欢迎邮件")} className="w-full select-text resize-none rounded-md border p-2 text-[13px] outline-none focus:border-primary" data-flow-ai-input />
            <div className="mt-2 flex items-center gap-2"><span className="text-[12px] text-subtle">{graph.nodes.length ? t("结果将追加到画布右侧") : t("结果会自动排版")}</span><button type="button" disabled={busy || !aiText.trim()} onClick={() => void runAI()} className="ml-auto flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[12px] text-white disabled:opacity-40">{busy && <Loader2 size={12} className="animate-spin" />}{t("生成")}</button></div>
          </div>}
        </div>
        <div className="relative">
          <button type="button" aria-label={t("导入 draw.io 或 XMind")} title={t("导入 draw.io / XMind")} className={barBtn} onClick={() => setMenu(menu === "import" ? null : "import")} data-flow-import><FileUp size={15} /><span className="hidden md:inline">{t("导入")}</span></button>
          {menu === "import" && (
            <div className={cn(pop, "right-0 w-44")}>
              <button type="button" className="flex h-8 w-full items-center rounded-md px-2 text-left hover:bg-hover" onClick={() => { setMenu(null); if (fileRef.current) { fileRef.current.accept = ".drawio,.xml,.dio,application/xml,text/xml"; fileRef.current.click(); } }} data-flow-import-drawio>{t("导入 draw.io 文件")}</button>
              <button type="button" className="flex h-8 w-full items-center rounded-md px-2 text-left hover:bg-hover" onClick={() => { setMenu(null); if (fileRef.current) { fileRef.current.accept = ".xmind,application/zip,application/vnd.xmind.workbook"; fileRef.current.click(); } }} data-flow-import-xmind>{t("导入 XMind（.xmind）")}</button>
            </div>
          )}
          <input ref={fileRef} type="file" accept=".drawio,.xml,.dio,.xmind,application/xml,text/xml,application/zip" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importFile(f); }} data-flow-import-input />
        </div>
      </>}
      <div className="relative"><button type="button" aria-label={t("导出")} title={t("导出")} className={barBtn} onClick={() => setMenu(menu === "export" ? null : "export")} data-flow-export-btn><Download size={15} /><span className="hidden md:inline">{t("导出")}</span></button>
        {menu === "export" && <div className={cn(pop, "right-0 w-44")}>{([["png", t("图片（PNG）")], ["svg", t("矢量图（SVG）")], ["drawio", t("draw.io 文件")], ["xmind", t("XMind 文件（.xmind）")]] as const).map(([k, l]) => <button key={k} type="button" data-flow-export={k} className="flex h-8 w-full items-center rounded-md px-2 text-left hover:bg-hover" onClick={() => void exportAs(k)}>{l}</button>)}</div>}
      </div>
    </div>
    {commentDraft && commentActions && (
      <BoardCommentComposer
        anchor={commentDraft.anchor}
        quote={commentDraft.quote}
        screenX={commentDraft.screenX}
        screenY={commentDraft.screenY}
        onCancel={() => { setCommentDraft(null); if (tool === "comment") setTool("select"); }}
        onSubmit={async (body) => {
          const created = await commentActions.create({
            anchor: commentDraft.anchor,
            quote: commentDraft.quote,
            body,
          });
          setCommentDraft(null);
          if (tool === "comment") setTool("select");
          if (created) {
            setOpenPinId(created.id);
            setPinPopoverPos({ x: commentDraft.screenX, y: commentDraft.screenY });
          }
          setNotice({ ok: true, text: t("已添加画板锚点评论") });
        }}
      />
    )}
    {openPin && (
      <BoardCommentThreadPopover
        pin={openPin}
        screenX={pinPopoverPos?.x ?? worldToScreen(openPin.x, openPin.y).x}
        screenY={pinPopoverPos?.y ?? worldToScreen(openPin.x, openPin.y).y}
        canSubmit={!!commentActions}
        onReply={commentActions ? async (parentId, body) => { await commentActions.reply(parentId, body); } : undefined}
        onResolve={commentActions ? async (cid) => { await commentActions.resolve(cid); setNotice({ ok: true, text: t("已解决该画板评论") }); } : undefined}
        onClose={() => setOpenPinId(null)}
      />
    )}
    {timerOpen && (
      <div className="absolute right-3 top-16 z-20">
        <WhiteboardTimer onClose={() => setTimerOpen(false)} />
      </div>
    )}
    {rankedVotes.length > 0 && mindViewMode === "canvas" && (
      <div
        data-board-vote-leaderboard
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-14 z-20 flex max-w-[min(560px,calc(100%-32px))] -translate-x-1/2 items-center gap-1.5 overflow-x-auto rounded-full border border-[#FFD591] bg-[#FFFDF5]/95 px-3 py-1 text-[12px] shadow-sm backdrop-blur-md dark:border-border dark:bg-surface/95"
      >
        <ThumbsUp size={13} className="shrink-0 text-[#3370FF]" />
        <span className="shrink-0 font-medium text-subtle">{t("热门投票")}</span>
        {rankedVotes.map((item, idx) => (
          <button
            key={item.nodeId}
            type="button"
            data-board-vote-rank={idx + 1}
            onClick={() => {
              const target = graph.nodes.find((n) => n.id === item.nodeId);
              if (target) {
                autoFit.current = false;
                setView((v) => ({ ...v, x: target.x + target.w / 2 - size.w / (2 * v.zoom), y: target.y + target.h / 2 - size.h / (2 * v.zoom) }));
                setSelected(new Set([target.id]));
              }
            }}
            className="flex shrink-0 items-center gap-1 rounded-full bg-[#EEF3FE] px-2 py-0.5 text-[11px] font-medium text-[#1F2329] hover:bg-[#DCEBFF] dark:bg-hover dark:text-foreground"
          >
            <span className="max-w-[96px] truncate">{item.label}</span>
            <span className="font-semibold text-[#3370FF] tabular-nums">{item.count}</span>
          </button>
        ))}
      </div>
    )}
    {notice && <div role={notice.ok ? "status" : "alert"} className={cn("absolute left-1/2 top-16 z-20 max-w-[520px] -translate-x-1/2 rounded-md border bg-surface px-3 py-1.5 text-[12px] shadow", notice.ok ? "text-[#1F2329]" : "text-destructive")}>{notice.text}<button type="button" className="ml-2 text-subtle" onClick={() => setNotice(null)}>×</button></div>}

    {recovery.length > 0 && <div className="pointer-events-none absolute right-0 top-16 z-[95] flex justify-center px-3" style={{ left: !readOnly && library && !compact ? 260 : 0 }}><div ref={recoveryBannerRef} role="alert" className="pointer-events-auto flex w-full max-w-[480px] items-center gap-2 rounded-lg border border-[#ffd591] bg-[#fff7e6] px-3 py-2 text-[12px] text-[#7a4b00] shadow-md"><span>{recovery.some((item) => item.conflicts.includes("permission") || item.conflicts.includes("document")) ? t("文档状态或编辑权限已变化，部分操作未应用；原输入已暂存。") : t("协作者修改了同一对象，部分操作未应用；原输入已暂存。")}</span><button type="button" className="ml-auto shrink-0 underline" onClick={() => setRecoveryOpen(true)}>{t("查看未应用内容")}</button></div></div>}
    {recoveryOpen && <div className="fixed inset-0 z-[100] grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label={mindBoard ? t("未应用的思维导图内容") : t("未应用的流程图内容")}><div ref={recoveryDialogRef} className="max-h-[calc(100dvh-32px)] w-full max-w-[560px] overflow-y-auto rounded-xl border bg-surface p-4 shadow-xl"><h2 className="text-[16px] font-semibold">{mindBoard ? t("未应用的思维导图内容") : t("未应用的流程图内容")}</h2><p className="mt-2 text-[13px] text-subtle">{t("请复制保留文字，或下载完整备份，再根据最新画布重新操作。关闭编辑器会丢失这些暂存内容。")}</p><textarea aria-label={t("未应用内容")} readOnly value={describeUnappliedFlows(recovery)} className="mt-3 h-40 w-full select-text rounded-md border bg-surface p-3 text-[13px] outline-none"/><div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" className="rounded-md border px-3 py-1.5 text-[13px]" onClick={() => download(mindBoard ? t("思维导图未应用内容.json") : t("流程图未应用内容.json"), new Blob([JSON.stringify({ version: 1, attempts: recovery }, null, 2)], { type: "application/json" }))}>{t("下载完整备份")}</button><button type="button" className="rounded-md border px-3 py-1.5 text-[13px]" onClick={() => setRecoveryOpen(false)}>{t("继续编辑")}</button><button type="button" className="rounded-md border px-3 py-1.5 text-[13px]" onClick={() => { recoveryRef.current = []; setRecovery([]); setRecoveryOpen(false); }}>{t("已保留，清除暂存")}</button><button type="button" className="rounded-md bg-[#d83931] px-3 py-1.5 text-[13px] text-white" onClick={() => { recoveryRef.current = []; setRecovery([]); setRecoveryOpen(false); onClose(); }}>{t("丢弃并退出")}</button></div></div></div>}

    {/* 右下：缩略图导航 + 撤销重做、缩放 */}
    {minimapOpen && mindViewMode === "canvas" && (
      <div className="absolute bottom-16 right-4 z-20">
        <WhiteboardMinimap
          graph={renderedGraph}
          frames={frames}
          mindStructure={mindStructure}
          mindCollapsed={effectiveCollapsed}
          view={view}
          viewportSize={size}
          onPanTo={(wx, wy) => {
            autoFit.current = false;
            setView((v) => ({
              ...v,
              x: wx - size.w / (2 * v.zoom),
              y: wy - size.h / (2 * v.zoom),
            }));
          }}
          onClose={() => setMinimapOpen(false)}
        />
      </div>
    )}
    <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2">
      {!readOnly && <div className={floatBar}><button type="button" className={railBtn} title={t("撤销")} disabled={!undo.length} onClick={doUndo}><Undo2 size={16} /></button><button type="button" className={railBtn} title={t("重做")} disabled={!redo.length} onClick={doRedo}><Redo2 size={16} /></button></div>}
      <div className={floatBar}>
        {mindViewMode === "canvas" && (
          <button type="button" className={cn(railBtn, minimapOpen && "bg-[#E1EAFF] text-primary")} title={t("缩略图导航")} aria-label={t("缩略图导航")} aria-pressed={minimapOpen} onClick={() => setMinimapOpen((v) => !v)} data-board-minimap-toggle><MapIcon size={16} /></button>
        )}
        <button type="button" className={cn(railBtn, hand && "bg-[#E1EAFF] text-primary")} title={t("抓手（拖动画布，也可按住空格）")} onClick={() => setHand(!hand)} data-flow-hand><Hand size={16} /></button>
        <span className="mx-0.5 h-5 w-px bg-[#DEE0E3]" />
        <button type="button" className={railBtn} title={t("缩小")} onClick={() => { autoFit.current = false; setView((v) => ({ ...v, zoom: Math.max(0.2, v.zoom / 1.2) })); }}><Minus size={16} /></button>
        <button type="button" className="h-8 w-12 rounded-md text-center text-[13px] hover:bg-hover" title={t("适应画布")} onClick={() => fit()} data-flow-fit>{Math.round(view.zoom * 100)}%</button>
        <button type="button" className={railBtn} title={t("放大")} onClick={() => { autoFit.current = false; setView((v) => ({ ...v, zoom: Math.min(3, v.zoom * 1.2) })); }}><Plus size={16} /></button>
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
  clone.querySelectorAll("[data-mind-drag-preview]").forEach((element) => element.remove());
  clone.querySelectorAll("[data-mind-outline]").forEach((element) => element.setAttribute("stroke", "transparent"));
  const b = flowBounds(graph);
  clone.setAttribute("viewBox", `${b.x - 40} ${b.y - 40} ${b.w + 80} ${b.h + 80}`);
  clone.setAttribute("width", String(b.w + 80));
  clone.setAttribute("height", String(b.h + 80));
  clone.querySelectorAll("[data-flow-port],[data-flow-resize]").forEach((el) => el.remove());
  clone.querySelectorAll("[data-board-frame-export],[data-board-frame-delete],[data-board-frame-resize]").forEach((el) => el.remove());
  clone.querySelectorAll("[data-ink-selection]").forEach((el) => el.remove());
  clone.querySelectorAll("[data-ink-resize]").forEach((el) => el.remove());
  clone.querySelectorAll("rect[stroke-dasharray='4 3']").forEach((el) => el.remove());
  for (const stroke of graph.strokes ?? []) clone.querySelector(`[data-flow-stroke="${stroke.id}"] path:last-child`)?.setAttribute("stroke", stroke.color);
  holder.appendChild(clone);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${holder.innerHTML}`;
}

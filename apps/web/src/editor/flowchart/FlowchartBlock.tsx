import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, CornerRightDown, Diamond, Download, FileUp, Hand, Loader2, Maximize2, Minus, MousePointer2, Palette, Plus, Redo2, Search, Shapes, Sparkles, Spline, Square, Trash2, Type, Undo2, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { aiErrorText, openAISettings, type AIMessage } from "@/lib/ai";
import { autoLayout, bounds, edgePath, measureLabel, newFlowId, SHAPES, themeOf, THEMES, type EdgeKind, type FlowEdge, type FlowGraph, type FlowNode, type FlowTheme, type Port, type Shape } from "./model";
import { DrawioError, parseDrawio, toDrawio } from "./drawio";
import { flowchartPrompt, parseFlowchartAnswer } from "./ai";

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
    default: return <rect x={x} y={y} width={w} height={h} rx={theme.radius} {...common} />;
  }
}

export function FlowSvg({ graph, width, height, viewBox, selected, editing, onNodeDown, onEdgeDown, onPortDown, onCanvasDown, onNodeDouble, onEdgeDouble, connectPreview, idPrefix = "fc", transparent }: {
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
        return <g key={e.id} data-flow-edge={e.id}>
          <path d={d} fill="none" stroke="transparent" strokeWidth={12} style={{ cursor: onEdgeDown ? "pointer" : undefined }} onPointerDown={onEdgeDown ? (ev) => onEdgeDown(ev, e) : undefined} onDoubleClick={onEdgeDouble ? () => onEdgeDouble(e) : undefined} />
          <path d={d} fill="none" stroke={sel ? "#3370FF" : color} strokeWidth={sel ? 2.2 : 1.5} strokeDasharray={e.dashed ? "6 4" : undefined} filter={theme.sketch ? filter : undefined} markerEnd={e.arrow === "none" ? undefined : `url(#${idPrefix}-arrow)`} markerStart={e.arrow === "both" ? `url(#${idPrefix}-arrow)` : undefined} pointerEvents="none" />
          {e.label && <g pointerEvents="none"><rect x={mid.x - measureLabel(e.label, 0) / 2 + 10} y={mid.y - 10} width={Math.max(20, measureLabel(e.label, 0) - 20)} height={20} rx={4} fill={theme.canvas} /><text x={mid.x} y={mid.y + 4} textAnchor="middle" fontSize={12} fill={theme.text}>{e.label}</text></g>}
        </g>;
      })}
      {graph.nodes.map((n) => {
        const c = nodeColors(n, theme);
        const fs = n.size ?? 14, lh = Math.round(fs * 1.3);
        const lines = wrapLines(n.text, n.w * 14 / fs);
        const sel = selected?.has(n.id);
        return <g key={n.id} data-flow-node={n.id} style={{ cursor: onNodeDown ? "move" : undefined }} onPointerDown={onNodeDown ? (ev) => onNodeDown(ev, n) : undefined} onDoubleClick={onNodeDouble ? () => onNodeDouble(n) : undefined}>
          <g filter={filter}><ShapeOutline n={n} theme={theme} fill={c.fill} stroke={c.stroke} /></g>
          {editing !== n.id && <text x={n.x + n.w / 2} y={n.y + n.h / 2 - ((lines.length - 1) * lh) / 2 + fs * 0.36} textAnchor="middle" fontSize={fs} fill={c.text} pointerEvents="none">
            {lines.map((l, i) => <tspan key={i} x={n.x + n.w / 2} dy={i ? lh : 0}>{l}</tspan>)}
          </text>}
          {sel && <rect x={n.x - 4} y={n.y - 4} width={n.w + 8} height={n.h + 8} rx={4} fill="none" stroke="#3370FF" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />}
          {sel && onPortDown && (["top", "right", "bottom", "left"] as Port[]).map((p) => {
            const o = 16; // 飞书的连接点在图形外侧
            const pt = p === "top" ? [n.x + n.w / 2, n.y - o] : p === "bottom" ? [n.x + n.w / 2, n.y + n.h + o] : p === "left" ? [n.x - o, n.y + n.h / 2] : [n.x + n.w + o, n.y + n.h / 2];
            return <circle key={p} cx={pt[0]} cy={pt[1]} r={5} fill="#FFFFFF" stroke="#3370FF" strokeWidth={1.5} style={{ cursor: "crosshair" }} onPointerDown={(ev) => { ev.stopPropagation(); onPortDown(ev, n, p); }} data-flow-port={p} />;
          })}
          {sel && onPortDown && <rect x={n.x + n.w - 5} y={n.y + n.h - 5} width={10} height={10} fill="#3370FF" style={{ cursor: "nwse-resize" }} data-flow-resize={n.id} />}
        </g>;
      })}
      {connectPreview && <line x1={connectPreview.x1} y1={connectPreview.y1} x2={connectPreview.x2} y2={connectPreview.y2} stroke="#3370FF" strokeWidth={1.5} strokeDasharray="5 4" markerEnd={`url(#${idPrefix}-arrow)`} pointerEvents="none" />}
    </svg>
  );
}

/* ---------------- inline block ---------------- */

/** 文档内的流程图块：预览 + 打开全屏编辑器（对应飞书在文档中打开画板）。 */
export function FlowchartBlock({ graph, height, readOnly, autoOpen, ai, onChange }: {
  graph: FlowGraph; height: number; readOnly: boolean; autoOpen?: boolean;
  ai?: (messages: AIMessage[]) => Promise<string>;
  onChange?: (next: FlowGraph) => void;
}) {
  const [open, setOpen] = useState(!!autoOpen && !readOnly);
  return <div contentEditable={false} className="group/flow relative overflow-hidden rounded-lg border border-transparent transition-colors hover:border-[#DEE0E3] focus-within:border-[#3370FF] dark:hover:border-border" style={{ height }} data-flowchart>
    {graph.nodes.length ? <FlowSvg graph={graph} width="100%" height="100%" idPrefix="fcp" /> : <div className="grid h-full place-items-center bg-[#F8F9FA] text-[13px] text-subtle dark:bg-hover"><span className="flex items-center gap-1.5"><Workflow size={16} />空白流程图{!readOnly && "，点击「编辑」开始绘制"}</span></div>}
    <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/flow:opacity-100 [@media(hover:none)]:opacity-100">
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(true)} className="flex h-7 items-center gap-1 rounded-md border bg-surface px-2 text-[12px] shadow-sm hover:bg-hover" data-flow-open>{readOnly ? <><Maximize2 size={13} />查看</> : <><Workflow size={13} />编辑</>}</button>
    </div>
    {open && <FlowchartEditor initial={graph} readOnly={readOnly} ai={ai} onChange={onChange} onClose={() => setOpen(false)} />}
  </div>;
}

/* ---------------- full-screen editor ---------------- */

type Drag =
  | { kind: "move"; ids: string[]; startX: number; startY: number; origin: Map<string, { x: number; y: number }> }
  | { kind: "resize"; id: string; startX: number; startY: number; w: number; h: number }
  | { kind: "pan"; startX: number; startY: number; vx: number; vy: number }
  | { kind: "connect"; from: string; port: Port; x: number; y: number };

const PALETTE = ["#E1EAFF/#3370FF", "#D9F5D6/#2EA121", "#FFF1E8/#FF8800", "#FEF8C5/#DC9B04", "#FFE8EF/#E63995", "#F1E8FF/#7B61FF", "#F2F3F5/#8F959E", "#FFFFFF/#1F2329"];

export function FlowchartEditor({ initial, readOnly, ai, onChange, onClose }: {
  initial: FlowGraph; readOnly: boolean;
  ai?: (messages: AIMessage[]) => Promise<string>;
  onChange?: (next: FlowGraph) => void;
  onClose: () => void;
}) {
  const [graph, setGraph] = useState(initial);
  const [undo, setUndo] = useState<FlowGraph[]>([]);
  const [redo, setRedo] = useState<FlowGraph[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<Shape | "select">("select");
  const [editing, setEditing] = useState<{ id: string; kind: "node" | "edge"; value: string } | null>(null);
  const [view, setView] = useState(() => { const b = bounds(initial.nodes); return { x: b.x - 80, y: b.y - 80, zoom: 1 }; });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<"theme" | "export" | "ai" | "shape" | "fill" | "stroke" | "color" | null>(null);
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
    const zoom = Math.min(1.5, Math.max(0.2, Math.min((size.w - 80) / Math.max(1, b.w), (size.h - 80) / Math.max(1, b.h))));
    setView({ zoom, x: b.x - (size.w / zoom - b.w) / 2, y: b.y - (size.h / zoom - b.h) / 2 });
  };
  const addNode = (shape: Shape, at?: { x: number; y: number }) => {
    const spec = SHAPES.find((s) => s.id === shape)!;
    const c = at ?? { x: view.x + size.w / view.zoom / 2, y: view.y + size.h / view.zoom / 2 };
    const node: FlowNode = { id: newFlowId("n"), shape, text: shape === "text" ? "文本" : spec.label.replace(/（.*）/, ""), x: Math.round(c.x - spec.w / 2), y: Math.round(c.y - spec.h / 2), w: spec.w, h: spec.h, z: Math.max(0, ...graph.nodes.map((n) => n.z ?? 0)) + 1 };
    commit({ ...graph, nodes: [...graph.nodes, node] });
    setSelected(new Set([node.id])); setTool("select");
  };
  const removeSelected = () => {
    if (!selected.size) return;
    commit({ ...graph, nodes: graph.nodes.filter((n) => !selected.has(n.id)), edges: graph.edges.filter((e) => !selected.has(e.id) && !selected.has(e.from) && !selected.has(e.to)) });
    setSelected(new Set());
  };
  const doUndo = () => { const prev = undo.at(-1); if (!prev) return; setUndo(undo.slice(0, -1)); setRedo([...redo, graph]); setGraph(prev); lastInitial.current = prev; onChange?.(prev); };
  const doRedo = () => { const next = redo.at(-1); if (!next) return; setRedo(redo.slice(0, -1)); setUndo([...undo, graph]); setGraph(next); lastInitial.current = next; onChange?.(next); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) return;
      if (e.key === "Escape") { if (selected.size) setSelected(new Set()); else onClose(); }
      if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) { e.preventDefault(); removeSelected(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !readOnly) { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(new Set(graph.nodes.map((n) => n.id))); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  useEffect(() => { if (initial.nodes.length) requestAnimationFrame(() => fit(initial)); /* fit once */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === "pan") { setView((v) => ({ ...v, x: drag.vx - (e.clientX - drag.startX) / v.zoom, y: drag.vy - (e.clientY - drag.startY) / v.zoom })); return; }
    const p = toWorld(e.clientX, e.clientY);
    if (drag.kind === "connect") { setDrag({ ...drag, x: p.x, y: p.y }); return; }
    const dx = (e.clientX - drag.startX) / view.zoom, dy = (e.clientY - drag.startY) / view.zoom;
    if (drag.kind === "move") setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => { const o = drag.origin.get(n.id); return o ? { ...n, x: Math.round(o.x + dx), y: Math.round(o.y + dy) } : n; }) }));
    if (drag.kind === "resize") setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === drag.id ? { ...n, w: Math.max(40, Math.round(drag.w + dx)), h: Math.max(24, Math.round(drag.h + dy)) } : n)) }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === "connect") {
      const p = toWorld(e.clientX, e.clientY);
      const target = [...graph.nodes].reverse().find((n) => p.x >= n.x - 8 && p.x <= n.x + n.w + 8 && p.y >= n.y - 8 && p.y <= n.y + n.h + 8);
      if (target && target.id !== d.from) {
        const edge: FlowEdge = { id: newFlowId("e"), from: d.from, to: target.id, fromPort: d.port, kind: "orthogonal" };
        commit({ ...graph, edges: [...graph.edges, edge] }); setSelected(new Set([edge.id]));
      }
      return;
    }
    if (d.kind === "move" || d.kind === "resize") {
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

  const importDrawio = async (file: File) => {
    setBusy(true); setNotice(null);
    try {
      const { graph: g, warnings } = await parseDrawio(await file.text());
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

  const theme = themeOf(graph.theme);
  const viewBox = `${view.x} ${view.y} ${size.w / view.zoom} ${size.h / view.zoom}`;
  const tb = "grid size-8 place-items-center rounded-md text-[#1F2329] hover:bg-hover disabled:opacity-30 dark:text-foreground";
  const pop = "absolute top-10 z-20 rounded-lg border border-[#DEE0E3] bg-surface p-1 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border";

  const floatBar = "flex items-center gap-0.5 rounded-lg border border-[#DEE0E3] bg-surface p-1 shadow-[0_4px_16px_rgba(31,35,41,0.08)] dark:border-border";
  const barBtn = "flex h-8 items-center gap-1 rounded-md px-2 text-[13px] text-[#1F2329] hover:bg-hover disabled:opacity-30 dark:text-foreground";
  const railBtn = "grid size-9 place-items-center rounded-md text-[#1F2329] hover:bg-hover dark:text-foreground";
  const libraryGroups: { title: string; shapes: Shape[] }[] = [
    { title: "基础", shapes: ["round", "rect", "ellipse", "diamond", "hexagon", "parallelogram", "text"] },
    { title: "流程图", shapes: ["terminator", "rect", "diamond", "parallelogram", "document", "cylinder", "hexagon"] },
  ];
  const shapeIcon = (id: Shape) => <svg viewBox="0 0 48 48" className="size-6" fill="none"><ShapeOutline n={{ id: "i", x: 5, y: 11, w: 38, h: 26, shape: id, text: "" }} theme={{ ...THEMES[0], radius: 2, strokeWidth: 3 }} fill="none" stroke="currentColor" />{id === "text" && <text x="24" y="33" textAnchor="middle" fontSize="26" fill="currentColor">T</text>}</svg>;
  const filteredGroups = libraryGroups.map((g) => ({ ...g, shapes: g.shapes.filter((id) => !libQuery.trim() || SHAPES.find((x) => x.id === id)!.label.includes(libQuery.trim())) })).filter((g) => g.shapes.length);
  // Floating style toolbar anchored above the selection (Feishu: shape ▾ / 填充 ▾ / 边框 ▾ / 字色 ▾ / 字号 ▾ / 更多).
  const anchorBox = selectedNodes.length ? bounds(selectedNodes) : selectedEdges.length ? (() => { const e = selectedEdges[0]; const a = graph.nodes.find((n) => n.id === e.from), t = graph.nodes.find((n) => n.id === e.to); if (!a || !t) return null; const m = edgePath(e, a, t).mid; return { x: m.x, y: m.y, w: 0, h: 0 }; })() : null;
  const barPos = anchorBox ? { left: (anchorBox.x + anchorBox.w / 2 - view.x) * view.zoom, top: Math.max(8, (anchorBox.y - view.y) * view.zoom - 16 * view.zoom - 58) } : null;

  return createPortal(<div className="fixed inset-0 z-[80] bg-surface" data-flow-editor onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
    {/* 画布 */}
    <div ref={svgWrap} className="absolute inset-0 overflow-hidden" style={{ left: !readOnly && library ? 260 : 0, background: theme.canvas, backgroundImage: `radial-gradient(${theme.id === "dark" ? "#3A404D" : "#D0D3D6"} 1px, transparent 1px)`, backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`, backgroundPosition: `${-view.x * view.zoom}px ${-view.y * view.zoom}px`, cursor: tool !== "select" ? "crosshair" : drag?.kind === "pan" ? "grabbing" : "default" }}
      onWheel={(e) => { if (e.ctrlKey || e.metaKey) { const p = toWorld(e.clientX, e.clientY); const zoom = Math.min(3, Math.max(0.2, view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); setView({ zoom, x: p.x - (p.x - view.x) * (view.zoom / zoom), y: p.y - (p.y - view.y) * (view.zoom / zoom) }); } else setView((v) => ({ ...v, x: v.x + e.deltaX / v.zoom, y: v.y + e.deltaY / v.zoom })); }}>
      <FlowSvg graph={graph} width="100%" height="100%" viewBox={viewBox} selected={selected} editing={editing?.kind === "node" ? editing.id : null} idPrefix="fce" transparent
        onCanvasDown={(e) => {
          if (e.target !== e.currentTarget && !(e.target instanceof SVGSVGElement)) return;
          setMenu(null);
          if (tool !== "select" && !readOnly) { addNode(tool, toWorld(e.clientX, e.clientY)); return; }
          setSelected(new Set()); finishEdit();
          setDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y });
        }}
        onNodeDown={(e, n) => {
          e.stopPropagation(); setMenu(null);
          if ((e.target as Element).getAttribute("data-flow-resize")) { if (!readOnly) setDrag({ kind: "resize", id: n.id, startX: e.clientX, startY: e.clientY, w: n.w, h: n.h }); return; }
          const next = e.shiftKey ? new Set(selected).add(n.id) : selected.has(n.id) ? selected : new Set([n.id]);
          setSelected(next);
          if (!readOnly) setDrag({ kind: "move", ids: [...next], startX: e.clientX, startY: e.clientY, origin: new Map(graph.nodes.filter((x) => next.has(x.id)).map((x) => [x.id, { x: x.x, y: x.y }])) });
        }}
        onEdgeDown={(e, edge) => { e.stopPropagation(); setMenu(null); setSelected(e.shiftKey ? new Set(selected).add(edge.id) : new Set([edge.id])); }}
        onPortDown={readOnly ? undefined : (e, n, port) => { const p = toWorld(e.clientX, e.clientY); setDrag({ kind: "connect", from: n.id, port, x: p.x, y: p.y }); }}
        onNodeDouble={readOnly ? undefined : (n) => setEditing({ id: n.id, kind: "node", value: n.text })}
        onEdgeDouble={readOnly ? undefined : (edge) => setEditing({ id: edge.id, kind: "edge", value: edge.label ?? "" })}
        connectPreview={drag?.kind === "connect" ? (() => { const n = graph.nodes.find((x) => x.id === drag.from)!; const pt = drag.port === "top" ? [n.x + n.w / 2, n.y] : drag.port === "bottom" ? [n.x + n.w / 2, n.y + n.h] : drag.port === "left" ? [n.x, n.y + n.h / 2] : [n.x + n.w, n.y + n.h / 2]; return { x1: pt[0], y1: pt[1], x2: drag.x, y2: drag.y }; })() : null}
      />
      {editing && (editNode || editEdge) && (() => {
        const anchor = editNode ? { x: editNode.x, y: editNode.y, w: editNode.w, h: editNode.h } : (() => { const e = editEdge!; const a = graph.nodes.find((n) => n.id === e.from)!, t = graph.nodes.find((n) => n.id === e.to)!; const m = edgePath(e, a, t).mid; return { x: m.x - 70, y: m.y - 16, w: 140, h: 32 }; })();
        return <textarea autoFocus value={editing.value} placeholder="输入文本" onChange={(e) => setEditing({ ...editing, value: e.target.value })} onBlur={finishEdit} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); finishEdit(); } if (e.key === "Escape") setEditing(null); }}
          className="absolute resize-none rounded border-2 border-primary bg-surface p-1 text-center text-[14px] outline-none" style={{ left: (anchor.x - view.x) * view.zoom, top: (anchor.y - view.y) * view.zoom, width: anchor.w * view.zoom, height: Math.max(32, anchor.h * view.zoom) }} data-flow-text-editor />;
      })()}
      {!graph.nodes.length && !readOnly && <div className="pointer-events-none absolute inset-0 grid place-items-center text-[13px] text-subtle">从左侧图形库选择图形后点击画布放置，或在右上角使用「AI 生成」「导入 draw.io」</div>}
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
        </>}
        {selectedEdges.length > 0 && <>
          {([["orthogonal", "折线"], ["straight", "直线"], ["curve", "曲线"]] as [EdgeKind, string][]).map(([k, l]) => <button key={k} type="button" onClick={() => patchEdges({ kind: k, fromPort: undefined, toPort: undefined })} className={cn(barBtn, (selectedEdges[0].kind ?? "orthogonal") === k && "bg-[#E1EAFF] text-primary")}>{l}</button>)}
          <button type="button" onClick={() => patchEdges({ dashed: !selectedEdges[0].dashed })} className={cn(barBtn, selectedEdges[0].dashed && "bg-[#E1EAFF] text-primary")}>虚线</button>
          <button type="button" onClick={() => patchEdges({ arrow: selectedEdges[0].arrow === "none" ? undefined : selectedEdges[0].arrow === "both" ? "none" : "both" })} className={barBtn}>箭头：{selectedEdges[0].arrow === "none" ? "无" : selectedEdges[0].arrow === "both" ? "双向" : "单向"}</button>
          <button type="button" onClick={() => setEditing({ id: selectedEdges[0].id, kind: "edge", value: selectedEdges[0].label ?? "" })} className={barBtn}>文字</button>
        </>}
        <span className="mx-0.5 h-5 w-px bg-[#DEE0E3]" />
        <button type="button" title="删除" onClick={removeSelected} className="grid size-8 place-items-center rounded-md text-destructive hover:bg-[#fff2f0]"><Trash2 size={15} /></button>
      </div>}
    </div>

    {/* 左侧：图形库面板 + 竖向工具条（飞书画板布局） */}
    {!readOnly && library && <aside className="absolute bottom-0 left-0 top-0 z-10 flex w-[260px] flex-col border-r border-[#DEE0E3] bg-surface dark:border-border" aria-label="图形库" data-flow-library>
      <div className="flex h-12 shrink-0 items-center gap-2 px-4"><span className="text-[14px] font-medium">图形库</span><button type="button" title="收起" onClick={() => setLibrary(false)} className="ml-auto grid size-7 place-items-center rounded text-subtle hover:bg-hover"><ChevronLeft size={16} /></button></div>
      <label className="mx-4 flex h-8 items-center gap-2 rounded-md border px-2 text-subtle focus-within:border-primary"><Search size={14} /><input value={libQuery} onChange={(e) => setLibQuery(e.target.value)} placeholder="搜索" className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none" /></label>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {filteredGroups.map((g) => <section key={g.title} className="mt-4"><div className="mb-2 flex items-center gap-1 text-[13px] text-[#646A73]"><ChevronDown size={12} />{g.title}</div><div className="grid grid-cols-5 gap-1">{g.shapes.map((id, i) => { const spec = SHAPES.find((s) => s.id === id)!; return <button key={`${id}${i}`} type="button" title={`${spec.label}（点击后在画布上放置，双击直接添加）`} onClick={() => setTool(id)} onDoubleClick={() => addNode(id)} className={cn("grid size-10 place-items-center rounded-md text-[#1F2329] hover:bg-hover dark:text-foreground", tool === id && "bg-[#E1EAFF] text-primary")} data-flow-shape={id}>{shapeIcon(id)}</button>; })}</div></section>)}
        <section className="mt-4"><div className="mb-2 flex items-center gap-1 text-[13px] text-[#646A73]"><ChevronDown size={12} />连线</div><p className="text-[12px] leading-5 text-subtle">选中图形后，从四周的蓝色圆点拖到另一个图形即可连线；选中连线可切换折线/直线/曲线、虚线与箭头。</p></section>
      </div>
    </aside>}
    {!readOnly && <aside className="absolute top-1/2 z-10 flex -translate-y-1/2 flex-col gap-0.5 rounded-xl border border-[#DEE0E3] bg-surface p-1.5 shadow-[0_4px_16px_rgba(31,35,41,0.08)] dark:border-border" style={{ left: library ? 272 : 12 }} aria-label="工具">
      <button type="button" className={cn(railBtn, library && "bg-[#E1EAFF]")} title="图形库" onClick={() => setLibrary(!library)} data-flow-library-toggle><Shapes size={18} className="text-[#3370FF]" /></button>
      <span className="mx-1 my-0.5 h-px bg-[#DEE0E3]" />
      <button type="button" className={cn(railBtn, tool === "select" && "bg-[#E1EAFF] text-primary")} title="选择" onClick={() => setTool("select")}><MousePointer2 size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "round" && "bg-[#E1EAFF] text-primary")} title="图形（点击画布放置）" onClick={() => setTool("round")}><Square size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "text" && "bg-[#E1EAFF] text-primary")} title="文本" onClick={() => setTool("text")}><Type size={18} /></button>
      <button type="button" className={cn(railBtn, tool === "diamond" && "bg-[#E1EAFF] text-primary")} title="判断" onClick={() => setTool("diamond")}><Diamond size={18} /></button>
      <button type="button" className={railBtn} title="连线：选中图形后拖动四周圆点" onClick={() => setNotice({ ok: true, text: "选中图形后，从四周的蓝色圆点拖到另一个图形即可连线" })}><CornerRightDown size={18} /></button>
    </aside>}

    {/* 左上：返回 */}
    <button type="button" onClick={() => { finishEdit(); onClose(); }} className={cn(floatBar, "absolute top-3 z-20 h-10 px-3 text-[14px]")} style={{ left: !readOnly && library ? 272 : 12 }} data-flow-done><ChevronLeft size={16} />流程图</button>

    {/* 右上：风格 / 自动排版 / AI 生成 / 导入 / 导出 */}
    <div className={cn(floatBar, "absolute right-3 top-3 z-20")}>
      {!readOnly && <>
        <div className="relative"><button type="button" className={barBtn} onClick={() => setMenu(menu === "theme" ? null : "theme")} data-flow-theme-btn><Palette size={15} />风格</button>
          {menu === "theme" && <div className={cn(pop, "right-0 grid w-[300px] grid-cols-3 gap-1.5 p-2")}>{THEMES.map((t) => <button key={t.id} type="button" onClick={() => { commit({ ...graph, theme: t.id }); setMenu(null); }} className={cn("rounded-md border p-1.5 text-center text-[12px] hover:border-primary", graph.theme === t.id && "border-primary text-primary")} data-flow-theme={t.id}><span className="mb-1 block h-8 rounded" style={{ background: t.canvas, border: `1px solid #DEE0E3` }}><span className="mx-auto mt-2 block h-4 w-10" style={{ background: t.palette ? t.palette[0].split("/")[0] : t.fill, border: `${t.strokeWidth}px solid ${t.palette ? t.palette[0].split("/")[1] : t.stroke}`, borderRadius: t.radius / 2 }} /></span>{t.label}</button>)}</div>}
        </div>
        <button type="button" className={barBtn} onClick={() => { const next = autoLayout(graph); commit(next); requestAnimationFrame(() => fit(next)); }} title="按连线关系自动排版"><Spline size={15} />自动排版</button>
        <div className="relative"><button type="button" className={cn(barBtn, !ai && "opacity-60")} onClick={() => (ai ? setMenu(menu === "ai" ? null : "ai") : openAISettings())} title={ai ? "用 AI 生成流程图" : "请先在 AI 设置中配置 API Key"} data-flow-ai-btn><Sparkles size={15} className="text-primary" />AI 生成</button>
          {menu === "ai" && ai && <div className={cn(pop, "right-0 w-[360px] p-3")}>
            <textarea autoFocus value={aiText} onChange={(e) => setAiText(e.target.value)} rows={4} maxLength={1000} placeholder="描述流程，例如：用户注册流程，包含填写信息、校验手机号、校验失败重试、创建账号、发送欢迎邮件" className="w-full resize-none rounded-md border p-2 text-[13px] outline-none focus:border-primary" data-flow-ai-input />
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
        <button type="button" className={railBtn} title="适应画布" onClick={() => fit()}><Hand size={16} /></button>
        <span className="mx-0.5 h-5 w-px bg-[#DEE0E3]" />
        <button type="button" className={railBtn} title="缩小" onClick={() => setView((v) => ({ ...v, zoom: Math.max(0.2, v.zoom / 1.2) }))}><Minus size={16} /></button>
        <span className="w-12 text-center text-[13px]">{Math.round(view.zoom * 100)}%</span>
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

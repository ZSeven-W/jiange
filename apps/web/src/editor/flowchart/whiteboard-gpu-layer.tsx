import { useCallback, useRef } from "react";
import {
  InstanceBatch,
  SpatialIndex,
  type GpuBackendKind,
  type GpuSurface,
  type RgbaTuple as RGBA,
} from "@jiange/render-gpu";
import { cssColorToRGBA, GpuLayer } from "@/components/gpu-canvas";
import { layoutMindTopics, type MindTopic } from "./mindmap";
import {
  edgePath,
  themeOf,
  type FlowGraph,
  type FlowNode,
  type FlowStroke,
  type FlowTheme,
  type Shape,
} from "./model";
import type { FlowViewport } from "./viewport";

export const GPU_NATIVE_BOARD_SHAPES = new Set<Shape>([
  "rect",
  "round",
  "terminator",
  "ellipse",
  "swimlane",
  "swimlaneV",
  "class",
]);

function resolveNodeColors(n: FlowNode, theme: FlowTheme): { fill: string; stroke: string } {
  if (theme.palette && !n.fill && !n.stroke) {
    let h = 0;
    for (const ch of n.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const [fill, stroke] = theme.palette[h % theme.palette.length].split("/");
    return { fill, stroke };
  }
  return {
    fill: n.shape === "text" ? "transparent" : n.fill ?? theme.fill,
    stroke: n.shape === "text" ? "transparent" : n.stroke ?? theme.stroke,
  };
}

function parseSvgPolyline(d: string): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  const re = /([MLHV])\s*([-\d.]+)(?:[\s,]+([-\d.]+))?/gi;
  let m: RegExpExecArray | null;
  let cx = 0;
  let cy = 0;
  while ((m = re.exec(d))) {
    const cmd = m[1].toUpperCase();
    const a = Number(m[2]);
    const b = m[3] !== undefined ? Number(m[3]) : 0;
    if (cmd === "M" || cmd === "L") {
      cx = a;
      cy = b;
      pts.push({ x: cx, y: cy });
    } else if (cmd === "H") {
      cx = a;
      pts.push({ x: cx, y: cy });
    } else if (cmd === "V") {
      cy = a;
      pts.push({ x: cx, y: cy });
    }
  }
  return pts;
}

export interface WhiteboardGpuLayerProps {
  graph: FlowGraph;
  view: FlowViewport;
  selected: ReadonlySet<string>;
  draftStroke?: FlowStroke | null;
  erasing?: ReadonlySet<string> | null;
  mindCollapsed?: ReadonlySet<string>;
  mindSelected?: string | null;
  mindDescriptionEditing?: { id: string; value: string } | null;
  mindBoard?: boolean;
  onBackendReady?: (backend: GpuBackendKind) => void;
}

/**
 * Hardware-accelerated WebGPU / WebGL2 SDF Whiteboard & MindMap Layer
 * powered by `@jiange/render-gpu` (`GpuSurface` + `SpatialIndex` + 2-pass `InstanceBatch`).
 */
export function WhiteboardGpuLayer({
  graph,
  view,
  selected,
  draftStroke,
  erasing,
  mindCollapsed,
  mindSelected,
  mindDescriptionEditing,
  mindBoard,
  onBackendReady,
}: WhiteboardGpuLayerProps) {
  const edgeBatchRef = useRef<InstanceBatch | null>(null);
  const nodeBatchRef = useRef<InstanceBatch | null>(null);
  const spatialRef = useRef<SpatialIndex<string> | null>(null);

  const onRender = useCallback(
    (surface: GpuSurface, width: number, height: number) => {
      const edgeBatch = (edgeBatchRef.current ??= new InstanceBatch(64, 4096, 64));
      const nodeBatch = (nodeBatchRef.current ??= new InstanceBatch(2048, 2048, 512));
      const spatial = (spatialRef.current ??= new SpatialIndex<string>(256));

      edgeBatch.reset();
      nodeBatch.reset();
      edgeBatch.camera.x = view.x;
      edgeBatch.camera.y = view.y;
      edgeBatch.camera.zoom = view.zoom;
      nodeBatch.camera.x = view.x;
      nodeBatch.camera.y = view.y;
      nodeBatch.camera.zoom = view.zoom;

      const theme = themeOf(graph.theme);
      const canvasBg = cssColorToRGBA(theme.canvas);
      // Keep clear color transparent when CSS dot-grid background shows behind canvas
      surface.setClearColor(mindBoard ? canvasBg : [0, 0, 0, 0]);

      // Build spatial index for O(1) frustum culling
      spatial.clear();
      const byId = new Map<string, FlowNode>();
      for (const n of graph.nodes) {
        byId.set(n.id, n);
        spatial.insert(n.id, { minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + n.h });
      }

      const worldLeft = view.x - 60 / Math.max(0.1, view.zoom);
      const worldTop = view.y - 60 / Math.max(0.1, view.zoom);
      const worldRight = view.x + (width + 60) / Math.max(0.1, view.zoom);
      const worldBottom = view.y + (height + 60) / Math.max(0.1, view.zoom);
      const visibleIds = new Set(
        spatial.queryRect({ minX: worldLeft, minY: worldTop, maxX: worldRight, maxY: worldBottom }),
      );

      // 1. Freehand ink strokes (behind or alongside nodes)
      const allStrokes = [...(graph.strokes ?? []), ...(draftStroke ? [draftStroke] : [])];
      for (const st of allStrokes) {
        const alpha = (erasing?.has(st.id) ? 0.2 : 1) * (st.marker ? 0.35 : 1);
        const col = cssColorToRGBA(st.color, alpha);
        if (selected.has(st.id)) {
          const halo: RGBA = [0.2, 0.439, 1, 0.35];
          for (let i = 0; i + 1 < st.points.length; i++) {
            edgeBatch.pushLine({
              x1: st.points[i].x,
              y1: st.points[i].y,
              x2: st.points[i + 1].x,
              y2: st.points[i + 1].y,
              thickness: st.width + 5,
              color: halo,
            });
          }
        }
        for (let i = 0; i + 1 < st.points.length; i++) {
          edgeBatch.pushLine({
            x1: st.points[i].x,
            y1: st.points[i].y,
            x2: st.points[i + 1].x,
            y2: st.points[i + 1].y,
            thickness: st.width,
            color: col,
          });
        }
      }

      // 2. Visible straight/orthogonal edges (curved Bezier edges remain in SVG overlay)
      const defaultEdgeColor = cssColorToRGBA(theme.edge);
      for (const e of graph.edges) {
        if ((e.kind ?? "orthogonal") === "curve") continue;
        if (!visibleIds.has(e.from) && !visibleIds.has(e.to)) continue;
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) continue;
        const { d } = edgePath(e, a, b);
        const pts = parseSvgPolyline(d);
        if (pts.length < 2) continue;
        const isSel = selected.has(e.id);
        const col = isSel ? cssColorToRGBA("#3370FF") : e.color ? cssColorToRGBA(e.color) : defaultEdgeColor;
        const thickness = isSel ? 2.2 : 1.5;
        for (let i = 0; i + 1 < pts.length; i++) {
          edgeBatch.pushLine({
            x1: pts[i].x,
            y1: pts[i].y,
            x2: pts[i + 1].x,
            y2: pts[i + 1].y,
            thickness,
            color: col,
            dashLen: e.dashed ? 6 : 0,
            gapLen: e.dashed ? 4 : 0,
          });
        }
        // Arrowhead on end segment (and start segment when arrow === "both")
        if (e.arrow !== "none") {
          const p0 = pts[pts.length - 2];
          const p1 = pts[pts.length - 1];
          const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
          const ah = 8;
          edgeBatch.pushLine({
            x1: p1.x - ah * Math.cos(ang - 0.45),
            y1: p1.y - ah * Math.sin(ang - 0.45),
            x2: p1.x,
            y2: p1.y,
            thickness,
            color: col,
          });
          edgeBatch.pushLine({
            x1: p1.x - ah * Math.cos(ang + 0.45),
            y1: p1.y - ah * Math.sin(ang + 0.45),
            x2: p1.x,
            y2: p1.y,
            thickness,
            color: col,
          });
          if (e.arrow === "both") {
            const s0 = pts[1];
            const s1 = pts[0];
            const sAng = Math.atan2(s1.y - s0.y, s1.x - s0.x);
            edgeBatch.pushLine({
              x1: s1.x - ah * Math.cos(sAng - 0.45),
              y1: s1.y - ah * Math.sin(sAng - 0.45),
              x2: s1.x,
              y2: s1.y,
              thickness,
              color: col,
            });
            edgeBatch.pushLine({
              x1: s1.x - ah * Math.cos(sAng + 0.45),
              y1: s1.y - ah * Math.sin(sAng + 0.45),
              x2: s1.x,
              y2: s1.y,
              thickness,
              color: col,
            });
          }
        }
      }

      // 3. Visible GPU-native SDF Flowchart nodes
      for (const n of graph.nodes) {
        if (!visibleIds.has(n.id)) continue;
        if (!GPU_NATIVE_BOARD_SHAPES.has(n.shape)) continue;
        const colors = resolveNodeColors(n, theme);
        const fill = cssColorToRGBA(colors.fill);
        const stroke = cssColorToRGBA(colors.stroke);
        const rotRad = ((n.rot ?? 0) * Math.PI) / 180;

        if (n.shape === "ellipse") {
          const cx = n.x + n.w / 2;
          const cy = n.y + n.h / 2;
          const sw = theme.strokeWidth;
          nodeBatch.pushArc({ cx, cy, rx: n.w / 2, ry: n.h / 2, color: stroke });
          nodeBatch.pushArc({ cx, cy, rx: Math.max(1, n.w / 2 - sw), ry: Math.max(1, n.h / 2 - sw), color: fill });
        } else if (n.shape === "swimlane") {
          nodeBatch.pushRect({ x: n.x, y: n.y, w: n.w, h: n.h, fill: [0, 0, 0, 0], borderWidth: theme.strokeWidth, borderColor: stroke });
          nodeBatch.pushRect({ x: n.x, y: n.y, w: 32, h: n.h, fill, borderWidth: theme.strokeWidth, borderColor: stroke });
        } else if (n.shape === "swimlaneV") {
          nodeBatch.pushRect({ x: n.x, y: n.y, w: n.w, h: n.h, fill: [0, 0, 0, 0], borderWidth: theme.strokeWidth, borderColor: stroke });
          nodeBatch.pushRect({ x: n.x, y: n.y, w: n.w, h: 36, fill, borderWidth: theme.strokeWidth, borderColor: stroke });
        } else {
          const radius =
            n.shape === "terminator"
              ? n.h / 2
              : n.shape === "round"
                ? Math.min(16, theme.radius + 6)
                : n.shape === "class"
                  ? Math.min(4, theme.radius)
                  : theme.radius;
          nodeBatch.pushRect({
            x: n.x,
            y: n.y,
            w: n.w,
            h: n.h,
            fill,
            radius,
            borderWidth: theme.strokeWidth,
            borderColor: stroke,
            rotationRad: rotRad,
          });
          if (n.shape === "class") {
            nodeBatch.pushLine({
              x1: n.x,
              y1: n.y + 32,
              x2: n.x + n.w,
              y2: n.y + 32,
              thickness: theme.strokeWidth,
              color: stroke,
            });
          }
        }
      }

      // 4. MindMap nodes & edges rendered via WebGPU SDF (1:1 aligned with MindMapSvg)
      if (graph.mind && graph.mind.length > 0) {
        const collapsed = mindCollapsed ?? new Set(graph.mindCollapsed ?? []);
        const displayDescriptions = mindDescriptionEditing
          ? { ...(graph.mindDescriptions ?? {}), [mindDescriptionEditing.id]: mindDescriptionEditing.value || " " }
          : graph.mindDescriptions;
        const positioned = layoutMindTopics(
          graph.mind as MindTopic[],
          collapsed,
          graph.mindStyles,
          displayDescriptions,
          graph.mindDescriptionStyles,
        );
        const posById = new Map(positioned.map((p) => [p.topic.id, p]));
        for (const item of positioned) {
          if (item.topic.parent) {
            const parentPos = posById.get(item.topic.parent);
            if (parentPos) {
              const pPaint = graph.mindPaints?.[parentPos.topic.id];
              const cPaint = graph.mindPaints?.[item.topic.id];
              const pCol = cssColorToRGBA(pPaint?.stroke ?? "#5b7ff1", (pPaint?.opacity ?? 100) / 100);
              const cCol = cssColorToRGBA(cPaint?.stroke ?? "#5b7ff1", (cPaint?.opacity ?? 100) / 100);
              const pDash = pPaint?.line === "dashed" ? 6 : pPaint?.line === "dotted" ? 2 : 0;
              const pGap = pPaint?.line === "dashed" ? 4 : pPaint?.line === "dotted" ? 3 : 0;
              const cDash = cPaint?.line === "dashed" ? 6 : cPaint?.line === "dotted" ? 2 : 0;
              const cGap = cPaint?.line === "dashed" ? 4 : cPaint?.line === "dotted" ? 3 : 0;
              const startX = parentPos.x + parentPos.w;
              const startY = parentPos.y + parentPos.h / 2;
              const endY = item.y + item.h / 2;
              const midX = startX + 30;
              edgeBatch.pushLine({ x1: startX, y1: startY, x2: midX, y2: startY, thickness: pPaint?.width ?? 2, color: pCol, dashLen: pDash, gapLen: pGap });
              edgeBatch.pushLine({ x1: midX, y1: startY, x2: midX, y2: endY, thickness: pPaint?.width ?? 2, color: pCol, dashLen: pDash, gapLen: pGap });
              edgeBatch.pushLine({ x1: midX, y1: endY, x2: item.x, y2: endY, thickness: cPaint?.width ?? 2, color: cCol, dashLen: cDash, gapLen: cGap });
            }
          }
          if (item.x + item.w < worldLeft || item.x > worldRight || item.y + item.h < worldTop || item.y > worldBottom) continue;
          const isRoot = item.topic.parent === null;
          const style = graph.mindStyles?.[item.topic.id];
          const paint = graph.mindPaints?.[item.topic.id];
          const shape = style?.shape ?? (isRoot ? "rect" : "text");
          if (shape !== "text") {
            const fillHex = paint?.fill === "none" ? "transparent" : (paint?.fill ?? (isRoot ? "#5b7ff1" : "transparent"));
            const strokeHex = !isRoot || paint?.stroke ? (paint?.stroke ?? "#5b7ff1") : "transparent";
            const fillAlpha = fillHex === "transparent" ? 0 : (paint?.fillOpacity ?? 100) / 100;
            const strokeAlpha = strokeHex === "transparent" ? 0 : (paint?.opacity ?? 100) / 100;
            nodeBatch.pushRect({
              x: item.x,
              y: item.y,
              w: item.w,
              h: item.h,
              fill: fillAlpha > 0 ? cssColorToRGBA(fillHex, fillAlpha) : [0, 0, 0, 0],
              radius: shape === "oval" ? item.h / 2 : 6,
              borderWidth: strokeAlpha > 0 ? (paint?.width ?? 2) : 0,
              borderColor: strokeAlpha > 0 ? cssColorToRGBA(strokeHex, strokeAlpha) : [0, 0, 0, 0],
            });
          }
          if (mindSelected === item.topic.id) {
            nodeBatch.pushRect({
              x: item.x,
              y: item.y,
              w: item.w,
              h: item.h,
              fill: [0, 0, 0, 0],
              radius: 2,
              borderWidth: 2,
              borderColor: cssColorToRGBA("#3370ff"),
            });
          }
        }
      }

      return surface.render([edgeBatch, nodeBatch]);
    },
    [graph, view.x, view.y, view.zoom, selected, draftStroke, erasing, mindCollapsed, mindSelected, mindDescriptionEditing, mindBoard],
  );

  return (
    <GpuLayer
      surfaceKind="whiteboard"
      onRender={onRender}
      renderDeps={[graph, view.x, view.y, view.zoom, selected, draftStroke, erasing, mindCollapsed, mindSelected, mindDescriptionEditing, mindBoard]}
      onBackendReady={onBackendReady}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
    />
  );
}

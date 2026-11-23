import { useCallback, useRef } from "react";
import {
  InstanceBatch,
  type GpuBackendKind,
  type GpuSurface,
} from "@jiange/render-gpu";
import type { SlideShape } from "@/lib/api";
import { cssColorToRGBA, GpuLayer } from "@/components/gpu-canvas";

export const GPU_NATIVE_SLIDE_SHAPES = new Set<SlideShape["kind"]>([
  "rectangle",
  "rounded-rectangle",
  "ellipse",
  "line",
  "line-arrow",
  "line-arrow-filled",
  "line-dot",
  "line-double-arrow",
  "chart",
]);

export function isGpuNativeSlideShape(shape: Pick<SlideShape, "kind" | "rotation">): boolean {
  if (!GPU_NATIVE_SLIDE_SHAPES.has(shape.kind)) return false;
  if (shape.kind === "ellipse" && (shape.rotation ?? 0) !== 0) return false;
  return true;
}

function rotatePoint(px: number, py: number, cx: number, cy: number, rad: number): [number, number] {
  if (!rad) return [px, py];
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

function isLineKind(kind: SlideShape["kind"]): boolean {
  return (
    kind === "line" ||
    kind === "line-arrow" ||
    kind === "line-arrow-filled" ||
    kind === "line-dot" ||
    kind === "line-double-arrow"
  );
}

export interface SlidesGpuLayerProps {
  background?: string;
  shapes: readonly SlideShape[];
  selectedId?: string | null;
  onBackendReady?: (backend: GpuBackendKind) => void;
}

/**
 * Hardware-accelerated WebGPU / WebGL2 SDF Presentation Stage Layer
 * powered by `@jiange/render-gpu`. Renders slide backdrop, SDF rectangles,
 * rounded rectangles, ellipses, lines/arrowheads, and chart bars directly on GPU.
 */
export function SlidesGpuLayer({
  background = "#ffffff",
  shapes,
  selectedId,
  onBackendReady,
}: SlidesGpuLayerProps) {
  const batchRef = useRef<InstanceBatch | null>(null);

  const onRender = useCallback(
    (surface: GpuSurface, width: number, height: number) => {
      const batch = (batchRef.current ??= new InstanceBatch(512, 512, 128));
      batch.reset();
      const bg = cssColorToRGBA(background || "#ffffff");
      surface.setClearColor(bg);
      batch.pushRect({ x: 0, y: 0, w: width, h: height, fill: bg });

      const scale = width / 960;
      for (const s of shapes) {
        if (!isGpuNativeSlideShape(s)) continue;
        const x = (s.x / 100) * width;
        const y = (s.y / 100) * height;
        const w = ((s.width ?? 16) / 100) * width;
        const h = ((s.height ?? 20) / 100) * height;
        const col = cssColorToRGBA(s.color || "#3370ff", s.opacity);
        const rotRad = ((s.rotation ?? 0) * Math.PI) / 180;

        if (isLineKind(s.kind)) {
          const cx = x + w / 2;
          const cy = y + h / 2;
          const thickness = Math.max(1.5, (s.strokeWidth ?? 3) * scale);
          const [sx, sy] = rotatePoint(x + w * 0.05, cy, cx, cy, rotRad);
          const [ex, ey] = rotatePoint(x + w * 0.95, cy, cx, cy, rotRad);
          batch.pushLine({ x1: sx, y1: sy, x2: ex, y2: ey, thickness, color: col });
          const ang = Math.atan2(ey - sy, ex - sx);
          if (s.kind !== "line" && s.kind !== "line-dot") {
            const ah = Math.max(5, 9 * scale);
            batch.pushLine({ x1: ex - ah * Math.cos(ang - 0.5), y1: ey - ah * Math.sin(ang - 0.5), x2: ex, y2: ey, thickness, color: col });
            batch.pushLine({ x1: ex - ah * Math.cos(ang + 0.5), y1: ey - ah * Math.sin(ang + 0.5), x2: ex, y2: ey, thickness, color: col });
            if (s.kind === "line-double-arrow") {
              const sAng = ang + Math.PI;
              batch.pushLine({ x1: sx - ah * Math.cos(sAng - 0.5), y1: sy - ah * Math.sin(sAng - 0.5), x2: sx, y2: sy, thickness, color: col });
              batch.pushLine({ x1: sx - ah * Math.cos(sAng + 0.5), y1: sy - ah * Math.sin(sAng + 0.5), x2: sx, y2: sy, thickness, color: col });
            }
          } else if (s.kind === "line-dot") {
            const dr = Math.max(3, 5 * scale);
            batch.pushArc({ cx: ex, cy: ey, rx: dr, ry: dr, color: col });
          }
        } else if (s.kind === "ellipse") {
          batch.pushArc({ cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, color: col });
        } else if (s.kind === "chart") {
          batch.pushRect({
            x,
            y,
            w,
            h,
            fill: [0.97, 0.98, 1, 1],
            radius: 6 * scale,
            borderWidth: 1,
            borderColor: [0.82, 0.84, 0.87, 1],
          });
          const vals = s.chart?.series[0]?.values ?? [];
          const maxV = Math.max(1, ...vals.map((v) => Math.abs(v)));
          const barW = vals.length ? (w - 24 * scale) / vals.length : 10;
          const plotH = Math.max(8, h - 34 * scale);
          vals.forEach((v, i) => {
            const bh = (Math.max(0, v) / maxV) * plotH;
            batch.pushRect({
              x: x + 12 * scale + i * barW + 2,
              y: y + h - 10 * scale - bh,
              w: Math.max(3, barW - 4),
              h: Math.max(2, bh),
              fill: col,
              radius: 2,
            });
          });
        } else {
          batch.pushRect({
            x,
            y,
            w,
            h,
            fill: col,
            radius: s.kind === "rounded-rectangle" ? Math.min(w, h) * 0.16 : 0,
            rotationRad: rotRad,
          });
        }
      }

      void selectedId;
      return surface.render([batch]);
    },
    [background, shapes, selectedId],
  );

  return (
    <GpuLayer
      surfaceKind="slides-stage"
      onRender={onRender}
      renderDeps={[background, shapes, selectedId]}
      onBackendReady={onBackendReady}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
    />
  );
}

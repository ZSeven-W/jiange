import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  GpuSurface,
  packColorRGBA,
  type GpuBackendKind,
  type GpuFrameStats,
  type RgbaTuple,
} from "@zseven-w/render-gpu";

export type RGBA = RgbaTuple;

export interface GpuLayerHandle {
  requestRender: () => void;
}

export interface GpuSurfaceTelemetry {
  kind: string;
  backend: GpuBackendKind;
  drawCalls: number;
  instances: number;
  frameTimeMs: number;
  width: number;
  height: number;
  updatedAt: number;
}

declare global {
  interface Window {
    __JIANGE_GPU_STATUS__?: Record<string, GpuSurfaceTelemetry>;
  }
}

function recordGpuStatus(id: string, entry: GpuSurfaceTelemetry | null): void {
  if (typeof window === "undefined") return;
  const store = (window.__JIANGE_GPU_STATUS__ ??= {});
  if (entry) store[id] = entry;
  else delete store[id];
}

/**
 * Convert common CSS hex/rgb/rgba colors into normalized GPU RGBA tuples.
 * Transparent or empty strings resolve to `[0, 0, 0, 0]`.
 */
export function cssColorToRGBA(color: string | undefined | null, alphaOverride?: number): RGBA {
  if (!color || color === "transparent" || color === "none") return [0, 0, 0, 0];
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) {
    const clean = trimmed.slice(1);
    if (clean.length === 8) {
      const rgb = packColorRGBA(`#${clean.slice(0, 6)}`);
      const a = Number.parseInt(clean.slice(6, 8), 16) / 255;
      return [rgb[0], rgb[1], rgb[2], alphaOverride ?? a];
    }
    return packColorRGBA(trimmed, alphaOverride);
  }
  const rgbaMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(trimmed);
  if (rgbaMatch) {
    return [
      Math.max(0, Math.min(1, Number(rgbaMatch[1]) / 255)),
      Math.max(0, Math.min(1, Number(rgbaMatch[2]) / 255)),
      Math.max(0, Math.min(1, Number(rgbaMatch[3]) / 255)),
      alphaOverride ?? (rgbaMatch[4] !== undefined ? Math.max(0, Math.min(1, Number(rgbaMatch[4]))) : 1),
    ];
  }
  return packColorRGBA(trimmed, alphaOverride);
}

export interface GpuLayerProps {
  /** Logical surface role exposed as `data-jiange-gpu` and registered in `window.__JIANGE_GPU_STATUS__`. */
  surfaceKind: string;
  /** Render callback executed whenever the canvas resizes or `renderKey` / dependencies update. */
  onRender: (surface: GpuSurface, width: number, height: number) => GpuFrameStats | null;
  /** Arbitrary dependency trigger that schedules a GPU repaint on change. */
  renderDeps?: readonly unknown[];
  /** Explicit width/height override (otherwise automatically observed via ResizeObserver). */
  width?: number;
  height?: number;
  /** Clear color applied before each render. Defaults to transparent `[0, 0, 0, 0]`. */
  clearColor?: RGBA;
  /** Optional callback fired when a real GPU backend (`webgpu` or `webgl2`) is initialized. */
  onBackendReady?: (backend: GpuBackendKind) => void;
  className?: string;
  style?: React.CSSProperties;
}

let gpuInstanceCounter = 0;

/**
 * Reusable WebGPU-primary (WebGL2 SDF fallback, zero Canvas 2D) React canvas layer
 * powered by `@zseven-w/render-gpu`. Safe under SSR (`renderToStaticMarkup`).
 */
export const GpuLayer = forwardRef<GpuLayerHandle, GpuLayerProps>(function GpuLayer(
  {
    surfaceKind,
    onRender,
    renderDeps = [],
    width,
    height,
    clearColor = [0, 0, 0, 0],
    onBackendReady,
    className = "pointer-events-none absolute inset-0 h-full w-full",
    style,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<GpuSurface | null>(null);
  const onRenderRef = useRef(onRender);
  onRenderRef.current = onRender;
  const clearColorRef = useRef(clearColor);
  clearColorRef.current = clearColor;
  const onBackendReadyRef = useRef(onBackendReady);
  onBackendReadyRef.current = onBackendReady;
  const instanceIdRef = useRef(`${surfaceKind}:${++gpuInstanceCounter}`);

  const [backend, setBackend] = useState<GpuBackendKind | "init">("init");
  const [size, setSize] = useState<{ w: number; h: number }>({
    w: width ?? 0,
    h: height ?? 0,
  });
  const [stats, setStats] = useState<{ draws: number; instances: number }>({ draws: 0, instances: 0 });

  // Track container dimensions (either explicit props or ResizeObserver)
  useEffect(() => {
    if (typeof width === "number" && typeof height === "number") {
      setSize({ w: Math.max(0, Math.floor(width)), h: Math.max(0, Math.floor(height)) });
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const target = canvas.parentElement ?? canvas;
      const rect = target.getBoundingClientRect();
      const nw = Math.max(0, Math.floor(rect.width || target.clientWidth));
      const nh = Math.max(0, Math.floor(rect.height || target.clientHeight));
      setSize((cur) => (cur.w === nw && cur.h === nh ? cur : { w: nw, h: nh }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(canvas.parentElement ?? canvas);
    return () => ro.disconnect();
  }, [width, height]);

  // Initialize WebGPU / WebGL2 GpuSurface once per canvas mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    const id = instanceIdRef.current;

    void GpuSurface.create(canvas, { prefer: "webgpu" }).then((surface) => {
      if (!alive) {
        surface.dispose();
        return;
      }
      surfaceRef.current = surface;
      setBackend(surface.backendKind);
      onBackendReadyRef.current?.(surface.backendKind);
    });

    return () => {
      alive = false;
      recordGpuStatus(id, null);
      if (surfaceRef.current) {
        surfaceRef.current.dispose();
        surfaceRef.current = null;
      }
    };
  }, []);

  const sizeRef = useRef(size);
  sizeRef.current = size;
  const rafRef = useRef<number | null>(null);

  const paintFrame = useCallback(() => {
    const surface = surfaceRef.current;
    const curSize = sizeRef.current;
    if (!surface || curSize.w <= 0 || curSize.h <= 0) return;
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    surface.resize(curSize.w, curSize.h, dpr);
    surface.setClearColor(clearColorRef.current);
    const frame = onRenderRef.current(surface, curSize.w, curSize.h);
    if (frame) {
      const instances = frame.rectInstances + frame.lineInstances + frame.arcInstances + frame.glyphInstances;
      setStats((cur) => (cur.draws === frame.drawCalls && cur.instances === instances ? cur : { draws: frame.drawCalls, instances }));
      recordGpuStatus(instanceIdRef.current, {
        kind: surfaceKind,
        backend: frame.backend,
        drawCalls: frame.drawCalls,
        instances,
        frameTimeMs: Number(frame.frameTimeMs.toFixed(3)),
        width: curSize.w,
        height: curSize.h,
        updatedAt: Date.now(),
      });
    }
  }, [surfaceKind]);

  useImperativeHandle(
    ref,
    () => ({
      requestRender: () => {
        if (typeof requestAnimationFrame === "undefined") {
          paintFrame();
          return;
        }
        if (rafRef.current !== null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          paintFrame();
        });
      },
    }),
    [paintFrame],
  );

  useEffect(() => () => {
    if (rafRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Paint frame whenever surface is ready, size changes, or renderDeps change
  useEffect(() => {
    paintFrame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, size.w, size.h, paintFrame, ...renderDeps]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-jiange-gpu={surfaceKind}
      data-gpu-backend={backend}
      data-gpu-draws={stats.draws}
      data-gpu-instances={stats.instances}
      className={className}
      style={style}
    />
  );
});

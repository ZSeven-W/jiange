import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Eraser, MousePointer2, Pause, PenTool, Play, Radio, RotateCcw, X } from "lucide-react";
import type { SlidesPage } from "@/lib/api";
import type { SlideContent } from "./slides-draft";
import { SlideShapes } from "./slides-shapes";
import { hasLargeSlideTitle } from "./slides-layout";
import { SlidesGpuLayer } from "./slides-gpu-layer";
import type { SlidePageTextStyles, SlideTextStyleMap } from "./slides-text-style";
import {
  buildAnimationSteps,
  getPageShapeAnimations,
  SLIDE_ANIMATION_KEYFRAMES_CSS,
  type SlideDeckShapeAnimations,
  type SlidePageShapeAnimations,
} from "./slides-animations";
import {
  getSlideTransition,
  SLIDE_TRANSITION_KEYFRAMES_CSS,
  slideTransitionAnimationStyle,
  type SlideTransitionMap,
} from "./slides-transitions";

type VisibleSlide = Pick<SlideContent, "title" | "body" | "background" | "layout" | "shapes">;

export type PresenterTool = "pointer" | "laser" | "ink";

export interface PresenterPoint {
  x: number;
  y: number;
}

export interface PresenterInkStroke {
  id: string;
  color: string;
  width: number;
  points: PresenterPoint[];
}

export const PRESENTER_INK_COLORS = [
  "#ff3b30",
  "#3370ff",
  "#00b42a",
  "#ff9500",
  "#ffffff",
] as const;

export const PRESENTER_LASER_TRAIL_MAX = 8;

const clampPct = (v: number) => Math.round(Math.min(100, Math.max(0, v)) * 100) / 100;

export function pushLaserTrailPoint(
  trail: readonly PresenterPoint[],
  point: PresenterPoint,
): PresenterPoint[] {
  const clamped = { x: clampPct(point.x), y: clampPct(point.y) };
  const next = [...trail, clamped];
  return next.length > PRESENTER_LASER_TRAIL_MAX
    ? next.slice(next.length - PRESENTER_LASER_TRAIL_MAX)
    : next;
}

export function startInkStroke(
  inkByPage: Record<number, PresenterInkStroke[]>,
  pageId: number,
  point: PresenterPoint,
  color: string,
  id = `ink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
): Record<number, PresenterInkStroke[]> {
  const prev = inkByPage[pageId] ?? [];
  const stroke: PresenterInkStroke = {
    id,
    color,
    width: 0.48,
    points: [{ x: clampPct(point.x), y: clampPct(point.y) }],
  };
  return { ...inkByPage, [pageId]: [...prev, stroke] };
}

export function appendInkPoint(
  inkByPage: Record<number, PresenterInkStroke[]>,
  pageId: number,
  point: PresenterPoint,
): Record<number, PresenterInkStroke[]> {
  const prev = inkByPage[pageId];
  if (!prev?.length) return inkByPage;
  const last = prev[prev.length - 1];
  const pt = { x: clampPct(point.x), y: clampPct(point.y) };
  const lastPt = last.points[last.points.length - 1];
  if (lastPt && Math.hypot(pt.x - lastPt.x, pt.y - lastPt.y) < 0.25) return inkByPage;
  const updated: PresenterInkStroke = { ...last, points: [...last.points, pt] };
  return {
    ...inkByPage,
    [pageId]: [...prev.slice(0, -1), updated],
  };
}

export function clearSlideInk(
  inkByPage: Record<number, PresenterInkStroke[]>,
  pageId: number,
): Record<number, PresenterInkStroke[]> {
  if (!(pageId in inkByPage)) return inkByPage;
  const next = { ...inkByPage };
  delete next[pageId];
  return next;
}

export function stepPresentationForward(
  pages: readonly Pick<SlidesPage, "id">[],
  currentId: number,
  animStep: number,
  animations?: SlideDeckShapeAnimations,
): { pageId: number; animStep: number } | null {
  const totalSteps = buildAnimationSteps(getPageShapeAnimations(animations, currentId)).length;
  if (animStep < totalSteps) {
    return { pageId: currentId, animStep: animStep + 1 };
  }
  const index = pages.findIndex((page) => page.id === currentId);
  if (index >= 0 && index < pages.length - 1) {
    return { pageId: pages[index + 1].id, animStep: 0 };
  }
  return null;
}

export function stepPresentationBackward(
  pages: readonly Pick<SlidesPage, "id">[],
  currentId: number,
  animStep: number,
  animations?: SlideDeckShapeAnimations,
): { pageId: number; animStep: number } | null {
  if (animStep > 0) {
    return { pageId: currentId, animStep: animStep - 1 };
  }
  const index = pages.findIndex((page) => page.id === currentId);
  if (index > 0) {
    const prevPage = pages[index - 1];
    const prevSteps = buildAnimationSteps(getPageShapeAnimations(animations, prevPage.id)).length;
    return { pageId: prevPage.id, animStep: prevSteps };
  }
  return null;
}

export function isDarkSlideBackground(bg: string | undefined): boolean {
  if (!bg) return false;
  const hex = bg.trim().replace(/^#/, "");
  const full = /^[0-9a-fA-F]{6}$/.test(hex)
    ? hex
    : /^[0-9a-fA-F]{3}$/.test(hex)
      ? hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
      : null;
  if (!full) return false;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 135;
}

/** Audience rendering deliberately has no access to the speaker's notes. */
export function SlideSurface({
  content,
  textStyle,
  animations,
  animationStep,
  inkStrokes,
  laserTrail,
  showPlaceholder = false,
  gpu = false,
}: {
  content: VisibleSlide;
  textStyle?: SlidePageTextStyles;
  animations?: SlidePageShapeAnimations;
  animationStep?: number;
  inkStrokes?: readonly PresenterInkStroke[];
  laserTrail?: readonly PresenterPoint[];
  showPlaceholder?: boolean;
  gpu?: boolean;
}) {
  const [gpuActive, setGpuActive] = useState(false);
  const dark = isDarkSlideBackground(content.background);
  const titleTone = dark ? "text-white" : "text-[#1f2329]";
  const bodyTone = dark ? "text-[#e5e7eb]" : "text-[#1f2329]";
  const emptyGuide = showPlaceholder && !content.title && !content.body && content.shapes.length === 0 && content.layout !== "blank";
  const largeTitle = hasLargeSlideTitle(content.layout);
  const titleField = textStyle?.title;
  const bodyField = textStyle?.body;
  const titleInlineStyle: CSSProperties = {
    fontSize: titleField?.fontSize !== undefined ? `${titleField.fontSize / 9.6}cqw` : largeTitle ? "5.625cqw" : "3.75cqw",
    minHeight: largeTitle ? undefined : "5.729cqw",
    padding: "0.4167cqw 0.8333cqw",
    ...(titleField?.bold !== undefined ? { fontWeight: titleField.bold ? 700 : 400 } : {}),
    ...(titleField?.italic ? { fontStyle: "italic" } : {}),
    ...(titleField?.color ? { color: titleField.color } : {}),
    ...(titleField?.align ? { textAlign: titleField.align } : {}),
  };
  const bodyInlineStyle: CSSProperties = {
    fontSize: bodyField?.fontSize !== undefined ? `${bodyField.fontSize / 9.6}cqw` : "2.1875cqw",
    padding: "0.4167cqw 0.8333cqw",
    ...(bodyField?.bold !== undefined ? { fontWeight: bodyField.bold ? 700 : 400 } : {}),
    ...(bodyField?.italic ? { fontStyle: "italic" } : {}),
    ...(bodyField?.color ? { color: bodyField.color } : {}),
    ...(bodyField?.align ? { textAlign: bodyField.align } : {}),
  };
  // Exclude charts and step-animated shapes from the GPU backdrop so DOM animations & crisp SVG charts render cleanly.
  const gpuShapes = content.shapes.filter(
    (s) => s.kind !== "chart" && !(animationStep !== undefined && animations?.[s.id]),
  );
  const hasInk = (inkStrokes?.length ?? 0) > 0;
  const hasLaser = (laserTrail?.length ?? 0) > 0;
  return <div className="relative aspect-video w-full overflow-hidden bg-white px-[6%] py-[5%]" style={{ backgroundColor: gpu && gpuActive ? "transparent" : content.background || "#fff", containerType: "inline-size" }}>
    {gpu && <SlidesGpuLayer background={content.background} shapes={gpuShapes} onBackendReady={(backend) => { if (backend === "webgpu" || backend === "webgl2") setGpuActive(true); }} />}
    {emptyGuide && (
      <div aria-hidden="true" className="pointer-events-none absolute inset-[10%] z-[1] flex flex-col justify-center gap-[8%]">
        <div className={largeTitle ? "mx-auto h-[22%] w-[78%] rounded-[2px] border border-dashed border-[#d0d3d6]" : "h-[18%] w-[62%] rounded-[2px] border border-dashed border-[#d0d3d6]"} />
        <div className={largeTitle ? "mx-auto h-[14%] w-[56%] rounded-[2px] border border-dashed border-[#e5e6eb]" : "h-[46%] w-[88%] rounded-[2px] border border-dashed border-[#e5e6eb]"} />
      </div>
    )}
    <h1 aria-hidden={!content.title} className={largeTitle ? `absolute left-[9.5%] top-[41.3%] z-[1] w-[81%] overflow-hidden text-ellipsis whitespace-nowrap ${content.layout === "title" ? "text-center" : "text-left"} font-semibold leading-tight ${titleTone}` : `relative z-[1] overflow-hidden text-ellipsis whitespace-nowrap font-semibold leading-tight ${titleTone}`} style={titleInlineStyle}>{content.title}</h1>
    <div className={largeTitle ? `absolute left-[9.5%] top-[60%] z-[1] h-[27%] w-[81%] overflow-hidden whitespace-pre-wrap break-words leading-relaxed ${bodyTone}` : `relative z-[1] mt-[4%] whitespace-pre-wrap break-words leading-relaxed ${bodyTone}`} style={bodyInlineStyle}>{content.body}</div>
    <div className="pointer-events-none absolute inset-0 z-[1]">
      <SlideShapes
        shapes={content.shapes}
        editable={false}
        selected={null}
        animations={animations}
        animationStep={animationStep}
        gpuBacked={gpu && gpuActive}
      />
    </div>
    {(hasInk || hasLaser) && (
      <svg
        viewBox="0 0 100 56.25"
        preserveAspectRatio="none"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[5] h-full w-full"
      >
        {hasInk && (
          <g data-presenter-ink-layer>
            {inkStrokes!.map((stroke) => {
              if (!stroke.points.length) return null;
              if (stroke.points.length === 1) {
                const p = stroke.points[0];
                return (
                  <circle
                    key={stroke.id}
                    cx={p.x}
                    cy={(p.y * 56.25) / 100}
                    r={stroke.width * 0.7}
                    fill={stroke.color}
                  />
                );
              }
              const pts = stroke.points
                .map((p) => `${p.x.toFixed(2)},${((p.y * 56.25) / 100).toFixed(2)}`)
                .join(" ");
              return (
                <polyline
                  key={stroke.id}
                  data-presenter-ink-stroke={stroke.id}
                  points={pts}
                  fill="none"
                  stroke={stroke.color}
                  strokeWidth={stroke.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              );
            })}
          </g>
        )}
        {hasLaser && (() => {
          const pts = laserTrail!;
          const head = pts[pts.length - 1];
          const headY = (head.y * 56.25) / 100;
          return (
            <g data-presenter-laser-trail>
              {pts.slice(0, -1).map((pt, idx) => {
                const ratio = (idx + 1) / pts.length;
                const cy = (pt.y * 56.25) / 100;
                return (
                  <circle
                    key={idx}
                    cx={pt.x}
                    cy={cy}
                    r={0.3 + ratio * 0.45}
                    fill="#ff3b30"
                    opacity={0.12 + ratio * 0.52}
                  />
                );
              })}
              <g data-presenter-laser-dot>
                <circle cx={head.x} cy={headY} r="2.0" fill="#ff3b30" opacity="0.22" />
                <circle cx={head.x} cy={headY} r="1.15" fill="#ff3b30" opacity="0.52" />
                <circle cx={head.x} cy={headY} r="0.58" fill="#ff3b30" />
                <circle cx={head.x} cy={headY} r="0.24" fill="#ffffff" />
              </g>
            </g>
          );
        })()}
      </svg>
    )}
  </div>;
}

export function formatPresentationTime(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

/**
 * Interactive stage wrapper that captures pointer movement for Laser Pointer comet trails
 * and pointer dragging for freehand Ink Annotations on top of the current slide.
 */
export function PresenterStageInteractive({
  tool,
  inkColor,
  pageId,
  onLaserMove,
  onLaserLeave,
  onInkStart,
  onInkMove,
  children,
}: {
  tool: PresenterTool;
  inkColor: string;
  pageId: number;
  onLaserMove: (pt: PresenterPoint) => void;
  onLaserLeave: () => void;
  onInkStart: (pageId: number, pt: PresenterPoint, color: string) => void;
  onInkMove: (pageId: number, pt: PresenterPoint) => void;
  children: ReactNode;
}) {
  const drawing = useRef(false);

  const toSlidePoint = (event: ReactPointerEvent<HTMLDivElement>): PresenterPoint | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: clampPct(((event.clientX - rect.left) / rect.width) * 100),
      y: clampPct(((event.clientY - rect.top) / rect.height) * 100),
    };
  };

  return (
    <div
      data-presenter-stage
      data-presenter-active-tool={tool}
      className={
        tool === "laser"
          ? "relative touch-none select-none cursor-none"
          : tool === "ink"
            ? "relative touch-none select-none cursor-crosshair"
            : "relative"
      }
      onPointerDown={(event) => {
        if (tool !== "ink" || event.button !== 0) return;
        const pt = toSlidePoint(event);
        if (!pt) return;
        drawing.current = true;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* synthetic pointer events may not support capture */
        }
        onInkStart(pageId, pt, inkColor);
      }}
      onPointerMove={(event) => {
        if (tool === "laser") {
          const pt = toSlidePoint(event);
          if (pt) onLaserMove(pt);
          return;
        }
        if (tool === "ink" && drawing.current) {
          const pt = toSlidePoint(event);
          if (pt) onInkMove(pageId, pt);
        }
      }}
      onPointerUp={() => {
        drawing.current = false;
      }}
      onPointerCancel={() => {
        drawing.current = false;
      }}
      onPointerLeave={() => {
        if (tool === "laser") onLaserLeave();
      }}
    >
      {children}
    </div>
  );
}

/**
 * Sleek Feishu Presenter Bottom Dock with Pointer, Laser Pointer, Live Ink Brush + Colors, and Clear Ink.
 */
export function PresenterToolDock({
  tool,
  inkColor,
  hasInk,
  onToolChange,
  onInkColorChange,
  onClearInk,
}: {
  tool: PresenterTool;
  inkColor: string;
  hasInk: boolean;
  onToolChange: (tool: PresenterTool) => void;
  onInkColorChange: (color: string) => void;
  onClearInk: () => void;
}) {
  return (
    <div
      data-presenter-tools
      role="toolbar"
      aria-label="演示标注工具"
      className="flex flex-wrap items-center gap-1 rounded-xl border border-white/12 bg-[#252629]/95 px-2 py-1.5 text-[12px] text-[#e5e7eb] shadow-[0_8px_24px_rgba(0,0,0,0.45)] backdrop-blur-md"
    >
      <button
        type="button"
        data-presenter-tool="pointer"
        aria-label="指针模式"
        aria-pressed={tool === "pointer"}
        title="指针模式"
        onClick={() => onToolChange("pointer")}
        className={`flex h-7 items-center gap-1 rounded-lg px-2 transition-colors ${
          tool === "pointer" ? "bg-[#3370ff] font-medium text-white" : "hover:bg-white/10"
        }`}
      >
        <MousePointer2 size={13} />
        <span>指针</span>
      </button>
      <button
        type="button"
        data-presenter-tool="laser"
        aria-label="激光笔模式"
        aria-pressed={tool === "laser"}
        title="激光笔模式"
        onClick={() => onToolChange("laser")}
        className={`flex h-7 items-center gap-1 rounded-lg px-2 transition-colors ${
          tool === "laser" ? "bg-[#ff3b30] font-medium text-white" : "hover:bg-white/10"
        }`}
      >
        <Radio size={13} />
        <span>激光笔</span>
      </button>
      <button
        type="button"
        data-presenter-tool="ink"
        aria-label="画笔标注模式"
        aria-pressed={tool === "ink"}
        title="画笔标注模式"
        onClick={() => onToolChange("ink")}
        className={`flex h-7 items-center gap-1 rounded-lg px-2 transition-colors ${
          tool === "ink" ? "bg-[#3370ff] font-medium text-white" : "hover:bg-white/10"
        }`}
      >
        <PenTool size={13} />
        <span>画笔</span>
      </button>

      {tool === "ink" && (
        <>
          <span className="mx-0.5 h-4 w-px bg-white/15" aria-hidden="true" />
          <div className="flex items-center gap-1 px-0.5" role="group" aria-label="画笔颜色">
            {PRESENTER_INK_COLORS.map((color) => {
              const selected = inkColor.toLowerCase() === color.toLowerCase();
              return (
                <button
                  key={color}
                  type="button"
                  data-presenter-ink-color={color}
                  aria-label={`画笔颜色 ${color}`}
                  aria-pressed={selected}
                  onClick={() => onInkColorChange(color)}
                  className={`size-5 rounded-full border transition-transform ${
                    selected ? "scale-110 border-white ring-2 ring-[#3370ff]" : "border-white/30 hover:scale-105"
                  }`}
                  style={{ backgroundColor: color }}
                />
              );
            })}
          </div>
        </>
      )}

      <span className="mx-0.5 h-4 w-px bg-white/15" aria-hidden="true" />
      <button
        type="button"
        data-presenter-clear-ink
        aria-label="清除标注"
        title="清除当前页画笔标注"
        disabled={!hasInk}
        onClick={onClearInk}
        className="flex h-7 items-center gap-1 rounded-lg px-2 text-[#e5e7eb] transition-colors hover:bg-white/10 disabled:opacity-35"
      >
        <Eraser size={13} />
        <span>清除标注</span>
      </button>
    </div>
  );
}

export function PresenterView({
  pages,
  currentId,
  content,
  contentFor,
  textStyles,
  transitions,
  animations,
  animStep: controlledAnimStep,
  onAnimStepChange,
  tool: controlledTool,
  onToolChange,
  inkColor: controlledInkColor,
  onInkColorChange,
  laserTrail: controlledLaserTrail,
  onLaserTrailChange,
  inkByPage: controlledInkByPage,
  onInkByPageChange,
  externalKeyNav = false,
  onSelect,
  onExit,
}: {
  pages: readonly SlidesPage[];
  currentId: number;
  content: SlideContent;
  contentFor: (page: SlidesPage) => SlideContent;
  textStyles?: SlideTextStyleMap;
  transitions?: SlideTransitionMap;
  animations?: SlideDeckShapeAnimations;
  animStep?: number;
  onAnimStepChange?: (step: number) => void;
  tool?: PresenterTool;
  onToolChange?: (tool: PresenterTool) => void;
  inkColor?: string;
  onInkColorChange?: (color: string) => void;
  laserTrail?: readonly PresenterPoint[];
  onLaserTrailChange?: (trail: PresenterPoint[]) => void;
  inkByPage?: Record<number, PresenterInkStroke[]>;
  onInkByPageChange?: (next: Record<number, PresenterInkStroke[]>) => void;
  externalKeyNav?: boolean;
  onSelect: (id: number) => void;
  onExit: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(true);
  const [timerEpoch, setTimerEpoch] = useState(0);

  const [internalTool, setInternalTool] = useState<PresenterTool>("pointer");
  const [internalInkColor, setInternalInkColor] = useState<string>(PRESENTER_INK_COLORS[0]);
  const [internalLaserTrail, setInternalLaserTrail] = useState<PresenterPoint[]>([]);
  const [internalInkByPage, setInternalInkByPage] = useState<Record<number, PresenterInkStroke[]>>({});
  const [internalAnimStep, setInternalAnimStep] = useState(0);

  const tool = controlledTool ?? internalTool;
  const setTool = (next: PresenterTool) => {
    if (onToolChange) onToolChange(next);
    else setInternalTool(next);
    if (next !== "laser") {
      if (onLaserTrailChange) onLaserTrailChange([]);
      else setInternalLaserTrail([]);
    }
  };
  const inkColor = controlledInkColor ?? internalInkColor;
  const setInkColor = (next: string) => {
    if (onInkColorChange) onInkColorChange(next);
    else setInternalInkColor(next);
  };
  const laserTrail = controlledLaserTrail ?? internalLaserTrail;
  const setLaserTrail = (updater: (prev: readonly PresenterPoint[]) => PresenterPoint[]) => {
    const next = updater(laserTrail);
    if (onLaserTrailChange) onLaserTrailChange(next);
    else setInternalLaserTrail(next);
  };
  const inkByPage = controlledInkByPage ?? internalInkByPage;
  const setInkByPage = (updater: (prev: Record<number, PresenterInkStroke[]>) => Record<number, PresenterInkStroke[]>) => {
    const next = updater(inkByPage);
    if (onInkByPageChange) onInkByPageChange(next);
    else setInternalInkByPage(next);
  };
  const animStep = controlledAnimStep ?? internalAnimStep;
  const setAnimStep = (next: number) => {
    if (onAnimStepChange) onAnimStepChange(next);
    else setInternalAnimStep(next);
  };

  useEffect(() => {
    if (!running) return;
    const base = seconds, started = Date.now();
    const timer = window.setInterval(() => setSeconds(base + Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(timer);
    // Capture elapsed time only when resuming or resetting the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, timerEpoch]);

  // Reset internal animStep when switching pages externally
  useEffect(() => {
    if (controlledAnimStep === undefined) {
      setInternalAnimStep(0);
    }
  }, [currentId, controlledAnimStep]);

  const index = pages.findIndex((page) => page.id === currentId);
  const activeTransition = getSlideTransition(transitions, currentId);
  const currentPageAnims = getPageShapeAnimations(animations, currentId);
  const totalAnimSteps = buildAnimationSteps(currentPageAnims).length;
  const currentInkStrokes = inkByPage[currentId] ?? [];

  const handleNext = () => {
    const step = stepPresentationForward(pages, currentId, animStep, animations);
    if (!step) return;
    if (step.pageId !== currentId) {
      onSelect(step.pageId);
    }
    setAnimStep(step.animStep);
  };

  const handlePrev = () => {
    const step = stepPresentationBackward(pages, currentId, animStep, animations);
    if (!step) return;
    if (step.pageId !== currentId) {
      onSelect(step.pageId);
    }
    setAnimStep(step.animStep);
  };

  useEffect(() => {
    if (externalKeyNav) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      if ((event.key === " " || event.key === "Enter") && event.target instanceof HTMLElement && event.target.closest("button")) return;
      if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "PageDown" || event.key === " " || event.key === "Enter") {
        const next = stepPresentationForward(pages, currentId, animStep, animations);
        if (next) {
          event.preventDefault();
          if (next.pageId !== currentId) onSelect(next.pageId);
          setAnimStep(next.animStep);
        }
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "PageUp") {
        const prev = stepPresentationBackward(pages, currentId, animStep, animations);
        if (prev) {
          event.preventDefault();
          if (prev.pageId !== currentId) onSelect(prev.pageId);
          setAnimStep(prev.animStep);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const canGoPrev = animStep > 0 || index > 0;
  const canGoNext = animStep < totalAnimSteps || (index >= 0 && index < pages.length - 1);

  return <div className="flex h-full min-h-0 w-full flex-col bg-[#111214] text-white" data-presenter-view>
    <style>{`${SLIDE_TRANSITION_KEYFRAMES_CSS}\n${SLIDE_ANIMATION_KEYFRAMES_CSS}`}</style>
    <header className="flex h-16 shrink-0 items-center gap-3 px-4">
      <button type="button" onClick={onExit} aria-label="退出演示者视图" className="grid size-9 place-items-center rounded-lg bg-[#2b2d30] hover:bg-[#3b3d42]"><X size={18}/></button>
      <div className="ml-auto flex h-9 items-center gap-2 rounded-lg bg-[#292a2d] px-3 text-[13px] tabular-nums" aria-label="演示计时"><span>{formatPresentationTime(seconds)}</span><button type="button" aria-label={running ? "暂停计时" : "继续计时"} onClick={() => setRunning((value) => !value)}>{running ? <Pause size={15}/> : <Play size={15}/>}</button><button type="button" aria-label="重置计时" onClick={() => { setSeconds(0); setTimerEpoch((epoch) => epoch + 1); }}><RotateCcw size={15}/></button></div>
    </header>
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4 md:flex-row">
      <div className="flex min-h-0 min-w-0 flex-[3] flex-col gap-3">
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="w-full max-w-[900px] overflow-hidden">
            <PresenterStageInteractive
              tool={tool}
              inkColor={inkColor}
              pageId={currentId}
              onLaserMove={(pt) => setLaserTrail((prev) => pushLaserTrailPoint(prev, pt))}
              onLaserLeave={() => setLaserTrail(() => [])}
              onInkStart={(pid, pt, color) => setInkByPage((prev) => startInkStroke(prev, pid, pt, color))}
              onInkMove={(pid, pt) => setInkByPage((prev) => appendInkPoint(prev, pid, pt))}
            >
              <div key={currentId} data-slide-transition={activeTransition} style={slideTransitionAnimationStyle(activeTransition)}>
                <SlideSurface
                  content={content}
                  textStyle={textStyles?.[currentId]}
                  animations={currentPageAnims}
                  animationStep={totalAnimSteps > 0 ? animStep : undefined}
                  inkStrokes={currentInkStrokes}
                  laserTrail={tool === "laser" ? laserTrail : undefined}
                  gpu
                />
              </div>
            </PresenterStageInteractive>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-3 text-[13px]">
          <div className="flex items-center gap-3">
            <button type="button" aria-label="上一页" disabled={!canGoPrev} onClick={handlePrev} className="rounded p-1 hover:bg-white/10 disabled:opacity-30"><ChevronLeft size={18}/></button>
            <span className="tabular-nums">{index + 1} / {pages.length}</span>
            {totalAnimSteps > 0 && (
              <span
                data-presenter-anim-step
                className="rounded-md bg-[#3370ff]/20 px-2 py-0.5 text-[11px] font-medium tabular-nums text-[#94bfff]"
              >
                动画 {animStep}/{totalAnimSteps}
              </span>
            )}
            <button type="button" aria-label="下一页" disabled={!canGoNext} onClick={handleNext} className="rounded p-1 hover:bg-white/10 disabled:opacity-30"><ChevronRight size={18}/></button>
          </div>
          <PresenterToolDock
            tool={tool}
            inkColor={inkColor}
            hasInk={currentInkStrokes.length > 0}
            onToolChange={setTool}
            onInkColorChange={setInkColor}
            onClearInk={() => setInkByPage((prev) => clearSlideInk(prev, currentId))}
          />
        </div>
        <div className="flex max-h-24 shrink-0 justify-center gap-2 overflow-x-auto pb-1" aria-label="放映页面">{pages.map((page, i) => <button key={page.id} type="button" aria-label={`跳转到第 ${i + 1} 张`} aria-current={page.id === currentId ? "true" : undefined} onClick={() => { onSelect(page.id); setAnimStep(0); }} className={`w-28 shrink-0 overflow-hidden rounded border-2 ${page.id === currentId ? "border-[#3370ff]" : "border-transparent"}`}><SlideSurface content={contentFor(page)} textStyle={textStyles?.[page.id]}/></button>)}</div>
      </div>
      <aside className="min-h-32 min-w-0 flex-[2] overflow-auto rounded-xl bg-[#252629] p-4 text-[14px] text-[#dee0e3]" aria-label="演示者备注"><div className="border-b border-white/10 pb-3 font-medium">演示者备注</div><p className="mt-4 whitespace-pre-wrap break-words">{content.notes || "暂无备注"}</p></aside>
    </div>
  </div>;
}

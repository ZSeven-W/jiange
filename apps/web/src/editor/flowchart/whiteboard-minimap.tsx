import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Timer, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { BoardFrame } from "./board-frames";
import { layoutMindTopicsWithStructure, type MindLayoutKind } from "./mindmap-layouts";
import type { FlowGraph } from "./model";
import type { FlowViewport } from "./viewport";

/* ---------------- Interactive Bird's-Eye Minimap ---------------- */

const MINIMAP_W = 172;
const MINIMAP_H = 112;
const MINIMAP_PAD = 8;

export interface WhiteboardMinimapProps {
  graph: FlowGraph;
  frames?: readonly BoardFrame[];
  mindStructure?: MindLayoutKind;
  mindCollapsed?: ReadonlySet<string>;
  view: FlowViewport;
  viewportSize: { w: number; h: number };
  onPanTo: (worldCenterX: number, worldCenterY: number) => void;
  onClose?: () => void;
}

export function WhiteboardMinimap({
  graph,
  frames = [],
  mindStructure = "logic",
  mindCollapsed,
  view,
  viewportSize,
  onPanTo,
  onClose,
}: WhiteboardMinimapProps) {
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef(false);

  const mindTopics = useMemo(
    () =>
      graph.mind?.length
        ? layoutMindTopicsWithStructure(
            graph.mind,
            mindStructure,
            mindCollapsed ?? new Set(graph.mindCollapsed ?? []),
            graph.mindStyles,
            graph.mindDescriptions,
            graph.mindDescriptionStyles,
          )
        : [],
    [graph.mind, graph.mindCollapsed, graph.mindStyles, graph.mindDescriptions, graph.mindDescriptionStyles, mindStructure, mindCollapsed],
  );

  const vpW = Math.max(40, viewportSize.w / Math.max(0.1, view.zoom));
  const vpH = Math.max(40, viewportSize.h / Math.max(0.1, view.zoom));

  const world = useMemo(() => {
    let minX = view.x;
    let minY = view.y;
    let maxX = view.x + vpW;
    let maxY = view.y + vpH;
    const include = (x: number, y: number, w = 0, h = 0) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    };
    for (const n of graph.nodes) include(n.x, n.y, n.w, n.h);
    for (const f of frames) include(f.x, f.y, f.w, f.h);
    for (const m of mindTopics) include(m.x, m.y, m.w, m.h);
    for (const st of graph.strokes ?? []) {
      for (const p of st.points) include(p.x, p.y);
    }
    const padX = Math.max(80, (maxX - minX) * 0.08);
    const padY = Math.max(60, (maxY - minY) * 0.08);
    const x = minX - padX;
    const y = minY - padY;
    const w = Math.max(200, maxX - minX + padX * 2);
    const h = Math.max(140, maxY - minY + padY * 2);
    const innerW = MINIMAP_W - MINIMAP_PAD * 2;
    const innerH = MINIMAP_H - MINIMAP_PAD * 2;
    const scale = Math.min(innerW / w, innerH / h);
    const offsetX = MINIMAP_PAD + (innerW - w * scale) / 2;
    const offsetY = MINIMAP_PAD + (innerH - h * scale) / 2;
    return { x, y, w, h, scale, offsetX, offsetY };
  }, [graph.nodes, graph.strokes, frames, mindTopics, view.x, view.y, vpW, vpH]);

  const toMiniX = (wx: number) => world.offsetX + (wx - world.x) * world.scale;
  const toMiniY = (wy: number) => world.offsetY + (wy - world.y) * world.scale;

  const panFromClient = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    const mx = ((clientX - rect.left) / rect.width) * MINIMAP_W;
    const my = ((clientY - rect.top) / rect.height) * MINIMAP_H;
    const wx = world.x + (mx - world.offsetX) / world.scale;
    const wy = world.y + (my - world.offsetY) / world.scale;
    onPanTo(wx, wy);
  };

  const vpRectX = toMiniX(view.x);
  const vpRectY = toMiniY(view.y);
  const vpRectW = Math.max(10, vpW * world.scale);
  const vpRectH = Math.max(8, vpH * world.scale);

  return (
    <div
      data-board-minimap
      onPointerDown={(e) => e.stopPropagation()}
      className="group relative overflow-hidden rounded-xl border border-[#DEE0E3] bg-surface/92 shadow-[0_6px_20px_rgba(31,35,41,0.12)] backdrop-blur-md dark:border-border"
      style={{ width: MINIMAP_W, height: MINIMAP_H }}
      role="region"
      aria-label={t("缩略图导航")}
    >
      <svg
        ref={svgRef}
        width={MINIMAP_W}
        height={MINIMAP_H}
        viewBox={`0 0 ${MINIMAP_W} ${MINIMAP_H}`}
        className="block h-full w-full cursor-crosshair select-none"
        onPointerDown={(e) => {
          e.stopPropagation();
          draggingRef.current = true;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
          panFromClient(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          e.stopPropagation();
          panFromClient(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
      >
        {/* Frames */}
        {frames.map((frame) => (
          <rect
            key={frame.id}
            data-minimap-frame={frame.id}
            x={toMiniX(frame.x)}
            y={toMiniY(frame.y)}
            width={Math.max(4, frame.w * world.scale)}
            height={Math.max(3, frame.h * world.scale)}
            rx={2}
            fill={frame.bg ?? "#eef3fe"}
            fillOpacity={0.7}
            stroke="#94a3b8"
            strokeWidth={0.8}
            strokeDasharray="2 1.5"
          />
        ))}
        {/* Strokes */}
        {(graph.strokes ?? []).map((stroke) => {
          if (!stroke.points.length) return null;
          const pts = stroke.points.map((p) => `${toMiniX(p.x).toFixed(1)},${toMiniY(p.y).toFixed(1)}`).join(" ");
          return (
            <polyline
              key={stroke.id}
              points={pts}
              fill="none"
              stroke={stroke.color}
              strokeOpacity={stroke.marker ? 0.45 : 0.85}
              strokeWidth={Math.max(1, stroke.width * world.scale)}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
        {/* MindMap nodes */}
        {mindTopics.map((item) => (
          <rect
            key={item.topic.id}
            data-minimap-mind={item.topic.id}
            x={toMiniX(item.x)}
            y={toMiniY(item.y)}
            width={Math.max(4, item.w * world.scale)}
            height={Math.max(2.5, item.h * world.scale)}
            rx={1.5}
            fill={item.topic.parent === null ? "#3370ff" : "#8fa8f8"}
          />
        ))}
        {/* Nodes & Sticky Notes */}
        {graph.nodes.map((n) => {
          const isSticky = n.shape === "sticky";
          return (
            <rect
              key={n.id}
              data-minimap-node={n.id}
              x={toMiniX(n.x)}
              y={toMiniY(n.y)}
              width={Math.max(4, n.w * world.scale)}
              height={Math.max(3, n.h * world.scale)}
              rx={isSticky ? 1.5 : 1}
              fill={isSticky ? (n.fill ?? "#fff3b0") : (n.fill ?? "#dce6ff")}
              stroke={isSticky ? (n.stroke ?? "#d4b44a") : (n.stroke ?? "#64748b")}
              strokeWidth={0.75}
            />
          );
        })}
        {/* Current viewport rectangle */}
        <rect
          data-board-minimap-viewport
          x={vpRectX}
          y={vpRectY}
          width={vpRectW}
          height={vpRectH}
          rx={2}
          fill="#3370ff"
          fillOpacity={0.12}
          stroke="#3370ff"
          strokeWidth={1.5}
        />
      </svg>
      {onClose && (
        <button
          type="button"
          aria-label={t("隐藏缩略图")}
          title={t("隐藏缩略图")}
          onClick={onClose}
          className="absolute right-1 top-1 grid size-5 place-items-center rounded-md bg-surface/85 text-subtle opacity-0 transition-opacity hover:bg-hover hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/* ---------------- Brainstorm Countdown Timer ---------------- */

const TIMER_PRESETS = [
  { seconds: 60, labelKey: "1分" },
  { seconds: 180, labelKey: "3分" },
  { seconds: 300, labelKey: "5分" },
  { seconds: 600, labelKey: "10分" },
] as const;

export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export interface WhiteboardTimerProps {
  initialSeconds?: number;
  onClose?: () => void;
}

export function WhiteboardTimer({ initialSeconds = 300, onClose }: WhiteboardTimerProps) {
  const { t } = useI18n();
  const [duration, setDuration] = useState(initialSeconds);
  const [remaining, setRemaining] = useState(initialSeconds);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          setRunning(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const expired = remaining === 0;
  const pct = duration > 0 ? Math.max(0, Math.min(100, (remaining / duration) * 100)) : 0;

  const selectPreset = (secs: number) => {
    setRunning(false);
    setDuration(secs);
    setRemaining(secs);
  };

  const toggleRun = () => {
    if (remaining === 0) {
      setRemaining(duration);
      setRunning(true);
    } else {
      setRunning((r) => !r);
    }
  };

  const reset = () => {
    setRunning(false);
    setRemaining(duration);
  };

  return (
    <div
      data-board-timer
      data-board-timer-expired={expired ? "true" : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      role="timer"
      aria-label={t("头脑风暴倒计时")}
      className={cn(
        "w-[224px] rounded-xl border bg-surface/95 p-2.5 shadow-[0_6px_22px_rgba(31,35,41,0.14)] backdrop-blur-md transition-colors",
        expired
          ? "animate-pulse border-[#d83931] bg-[#fff1f0] text-[#d83931]"
          : "border-[#DEE0E3] text-foreground dark:border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Timer size={14} className={expired ? "text-[#d83931]" : "text-[#3370ff]"} />
          <span className="text-[12px] font-medium">
            {expired ? t("时间到") : t("计时器")}
          </span>
        </div>
        <span
          data-board-timer-display
          className={cn(
            "font-mono text-[18px] font-semibold tracking-tight tabular-nums",
            expired ? "text-[#d83931]" : "text-foreground",
          )}
        >
          {formatCountdown(remaining)}
        </span>
        {onClose && (
          <button
            type="button"
            data-board-timer-close
            aria-label={t("关闭计时器")}
            onClick={onClose}
            className="grid size-6 place-items-center rounded-md text-subtle hover:bg-hover hover:text-foreground"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[#eff0f1] dark:bg-hover">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            expired ? "bg-[#d83931]" : remaining <= 30 ? "bg-[#ff8800]" : "bg-[#3370ff]",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-2 flex items-center gap-1">
        {TIMER_PRESETS.map((preset) => {
          const active = duration === preset.seconds;
          return (
            <button
              key={preset.seconds}
              type="button"
              data-board-timer-preset={preset.seconds}
              onClick={() => selectPreset(preset.seconds)}
              className={cn(
                "h-6 flex-1 rounded-md text-[11px] font-medium transition-colors",
                active
                  ? "bg-[#e1eaff] text-[#3370ff]"
                  : "bg-[#f5f6f7] text-[#646a73] hover:bg-hover dark:bg-hover",
              )}
            >
              {t(preset.labelKey)}
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          data-board-timer-toggle
          onClick={toggleRun}
          className={cn(
            "flex h-7 flex-1 items-center justify-center gap-1 rounded-md text-[12px] font-medium text-white transition-colors",
            running ? "bg-[#ff8800] hover:bg-[#e07600]" : "bg-[#3370ff] hover:bg-[#245bdb]",
          )}
        >
          {running ? <Pause size={12} /> : <Play size={12} />}
          <span>{running ? t("暂停") : expired ? t("重新开始") : t("开始")}</span>
        </button>
        <button
          type="button"
          data-board-timer-reset
          title={t("重置计时器")}
          aria-label={t("重置计时器")}
          onClick={reset}
          className="grid size-7 place-items-center rounded-md border border-[#DEE0E3] bg-surface text-[#646a73] hover:bg-hover dark:border-border"
        >
          <RotateCcw size={13} />
        </button>
      </div>
    </div>
  );
}

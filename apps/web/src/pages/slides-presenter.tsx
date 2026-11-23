import { useEffect, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, X } from "lucide-react";
import type { SlidesPage } from "@/lib/api";
import type { SlideContent } from "./slides-draft";
import { SlideShapes } from "./slides-shapes";
import { hasLargeSlideTitle } from "./slides-layout";
import { SlidesGpuLayer } from "./slides-gpu-layer";
import type { SlidePageTextStyles, SlideTextStyleMap } from "./slides-text-style";
import {
  getSlideTransition,
  SLIDE_TRANSITION_KEYFRAMES_CSS,
  slideTransitionAnimationStyle,
  type SlideTransitionMap,
} from "./slides-transitions";

type VisibleSlide = Pick<SlideContent, "title" | "body" | "background" | "layout" | "shapes">;

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
  showPlaceholder = false,
  gpu = false,
}: {
  content: VisibleSlide;
  textStyle?: SlidePageTextStyles;
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
  return <div className="relative aspect-video w-full overflow-hidden bg-white px-[6%] py-[5%]" style={{ backgroundColor: gpu && gpuActive ? "transparent" : content.background || "#fff", containerType: "inline-size" }}>
    {gpu && <SlidesGpuLayer background={content.background} shapes={content.shapes} onBackendReady={(backend) => { if (backend === "webgpu" || backend === "webgl2") setGpuActive(true); }} />}
    {emptyGuide && (
      <div aria-hidden="true" className="pointer-events-none absolute inset-[10%] z-[1] flex flex-col justify-center gap-[8%]">
        <div className={largeTitle ? "mx-auto h-[22%] w-[78%] rounded-[2px] border border-dashed border-[#d0d3d6]" : "h-[18%] w-[62%] rounded-[2px] border border-dashed border-[#d0d3d6]"} />
        <div className={largeTitle ? "mx-auto h-[14%] w-[56%] rounded-[2px] border border-dashed border-[#e5e6eb]" : "h-[46%] w-[88%] rounded-[2px] border border-dashed border-[#e5e6eb]"} />
      </div>
    )}
    <h1 aria-hidden={!content.title} className={largeTitle ? `absolute left-[9.5%] top-[41.3%] z-[1] w-[81%] overflow-hidden text-ellipsis whitespace-nowrap ${content.layout === "title" ? "text-center" : "text-left"} font-semibold leading-tight ${titleTone}` : `relative z-[1] overflow-hidden text-ellipsis whitespace-nowrap font-semibold leading-tight ${titleTone}`} style={titleInlineStyle}>{content.title}</h1>
    <div className={largeTitle ? `absolute left-[9.5%] top-[60%] z-[1] h-[27%] w-[81%] overflow-hidden whitespace-pre-wrap break-words leading-relaxed ${bodyTone}` : `relative z-[1] mt-[4%] whitespace-pre-wrap break-words leading-relaxed ${bodyTone}`} style={bodyInlineStyle}>{content.body}</div>
    <div className="pointer-events-none absolute inset-0 z-[1]"><SlideShapes shapes={content.shapes} editable={false} selected={null} gpuBacked={gpu && gpuActive}/></div>
  </div>;
}

export function formatPresentationTime(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

export function PresenterView({
  pages,
  currentId,
  content,
  contentFor,
  textStyles,
  transitions,
  onSelect,
  onExit,
}: {
  pages: readonly SlidesPage[];
  currentId: number;
  content: SlideContent;
  contentFor: (page: SlidesPage) => SlideContent;
  textStyles?: SlideTextStyleMap;
  transitions?: SlideTransitionMap;
  onSelect: (id: number) => void;
  onExit: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(true);
  const [timerEpoch, setTimerEpoch] = useState(0);
  useEffect(() => {
    if (!running) return;
    const base = seconds, started = Date.now();
    const timer = window.setInterval(() => setSeconds(base + Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(timer);
    // Capture elapsed time only when resuming or resetting the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, timerEpoch]);
  const index = pages.findIndex((page) => page.id === currentId);
  const activeTransition = getSlideTransition(transitions, currentId);
  return <div className="flex h-full min-h-0 w-full flex-col bg-[#111214] text-white" data-presenter-view>
    <style>{SLIDE_TRANSITION_KEYFRAMES_CSS}</style>
    <header className="flex h-16 shrink-0 items-center gap-3 px-4">
      <button type="button" onClick={onExit} aria-label="退出演示者视图" className="grid size-9 place-items-center rounded-lg bg-[#2b2d30] hover:bg-[#3b3d42]"><X size={18}/></button>
      <div className="ml-auto flex h-9 items-center gap-2 rounded-lg bg-[#292a2d] px-3 text-[13px] tabular-nums" aria-label="演示计时"><span>{formatPresentationTime(seconds)}</span><button type="button" aria-label={running ? "暂停计时" : "继续计时"} onClick={() => setRunning((value) => !value)}>{running ? <Pause size={15}/> : <Play size={15}/>}</button><button type="button" aria-label="重置计时" onClick={() => { setSeconds(0); setTimerEpoch((epoch) => epoch + 1); }}><RotateCcw size={15}/></button></div>
    </header>
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4 md:flex-row">
      <div className="flex min-h-0 min-w-0 flex-[3] flex-col gap-4">
        <div className="flex min-h-0 flex-1 items-center justify-center"><div className="w-full max-w-[900px] overflow-hidden"><div key={currentId} data-slide-transition={activeTransition} style={slideTransitionAnimationStyle(activeTransition)}><SlideSurface content={content} textStyle={textStyles?.[currentId]} gpu/></div></div></div>
        <div className="flex shrink-0 items-center justify-center gap-4 text-[13px]"><button type="button" aria-label="上一页" disabled={index <= 0} onClick={() => onSelect(pages[index - 1].id)} className="rounded p-1 disabled:opacity-30"><ChevronLeft size={18}/></button><span>{index + 1} / {pages.length}</span><button type="button" aria-label="下一页" disabled={index < 0 || index >= pages.length - 1} onClick={() => onSelect(pages[index + 1].id)} className="rounded p-1 disabled:opacity-30"><ChevronRight size={18}/></button></div>
        <div className="flex max-h-24 shrink-0 justify-center gap-2 overflow-x-auto pb-1" aria-label="放映页面">{pages.map((page, i) => <button key={page.id} type="button" aria-label={`跳转到第 ${i + 1} 张`} aria-current={page.id === currentId ? "true" : undefined} onClick={() => onSelect(page.id)} className={`w-28 shrink-0 overflow-hidden rounded border-2 ${page.id === currentId ? "border-[#3370ff]" : "border-transparent"}`}><SlideSurface content={contentFor(page)} textStyle={textStyles?.[page.id]}/></button>)}</div>
      </div>
      <aside className="min-h-32 min-w-0 flex-[2] overflow-auto rounded-xl bg-[#252629] p-4 text-[14px] text-[#dee0e3]" aria-label="演示者备注"><div className="border-b border-white/10 pb-3 font-medium">演示者备注</div><p className="mt-4 whitespace-pre-wrap break-words">{content.notes || "暂无备注"}</p></aside>
    </div>
  </div>;
}

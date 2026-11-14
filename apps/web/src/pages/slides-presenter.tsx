import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, X } from "lucide-react";
import type { SlidesPage } from "@/lib/api";
import type { SlideContent } from "./slidesDraft";
import { SlideShapes } from "./slides-shapes";
import { hasLargeSlideTitle } from "./slides-layout";

type VisibleSlide = Pick<SlideContent, "title" | "body" | "background" | "layout" | "shapes">;

/** Audience rendering deliberately has no access to the speaker's notes. */
export function SlideSurface({ content }: { content: VisibleSlide }) {
  return <div className="relative aspect-video w-full overflow-hidden bg-white px-[6%] py-[5%]" style={{ backgroundColor: content.background || "#fff", containerType: "inline-size" }}>
    <h1 aria-hidden={!content.title} className={hasLargeSlideTitle(content.layout) ? `absolute left-[9.5%] top-[41.3%] w-[81%] overflow-hidden text-ellipsis whitespace-nowrap ${content.layout === "title" ? "text-center" : "text-left"} font-semibold leading-tight text-[#1f2329]` : "overflow-hidden text-ellipsis whitespace-nowrap font-semibold leading-tight text-[#1f2329]"} style={{ fontSize: hasLargeSlideTitle(content.layout) ? "5.625cqw" : "3.75cqw", minHeight: hasLargeSlideTitle(content.layout) ? undefined : "5.729cqw", padding: "0.4167cqw 0.8333cqw" }}>{content.title}</h1>
    <div className={hasLargeSlideTitle(content.layout) ? "absolute left-[9.5%] top-[60%] h-[27%] w-[81%] overflow-hidden whitespace-pre-wrap break-words leading-relaxed text-[#1f2329]" : "mt-[4%] whitespace-pre-wrap break-words leading-relaxed text-[#1f2329]"} style={{ fontSize: "2.1875cqw", padding: "0.4167cqw 0.8333cqw" }}>{content.body}</div>
    <SlideShapes shapes={content.shapes} editable={false} selected={null}/>
  </div>;
}

export function formatPresentationTime(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

export function PresenterView({ pages, currentId, content, contentFor, onSelect, onExit }: {
  pages: readonly SlidesPage[];
  currentId: number;
  content: SlideContent;
  contentFor: (page: SlidesPage) => SlideContent;
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
  return <div className="flex h-full min-h-0 w-full flex-col bg-[#111214] text-white" data-presenter-view>
    <header className="flex h-16 shrink-0 items-center gap-3 px-4">
      <button type="button" onClick={onExit} aria-label="退出演示者视图" className="grid size-9 place-items-center rounded-lg bg-[#2b2d30] hover:bg-[#3b3d42]"><X size={18}/></button>
      <div className="ml-auto flex h-9 items-center gap-2 rounded-lg bg-[#292a2d] px-3 text-[13px] tabular-nums" aria-label="演示计时"><span>{formatPresentationTime(seconds)}</span><button type="button" aria-label={running ? "暂停计时" : "继续计时"} onClick={() => setRunning((value) => !value)}>{running ? <Pause size={15}/> : <Play size={15}/>}</button><button type="button" aria-label="重置计时" onClick={() => { setSeconds(0); setTimerEpoch((epoch) => epoch + 1); }}><RotateCcw size={15}/></button></div>
    </header>
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4 md:flex-row">
      <div className="flex min-h-0 min-w-0 flex-[3] flex-col gap-4">
        <div className="flex min-h-0 flex-1 items-center justify-center"><div className="w-full max-w-[900px]"><SlideSurface content={content}/></div></div>
        <div className="flex shrink-0 items-center justify-center gap-4 text-[13px]"><button type="button" aria-label="上一页" disabled={index <= 0} onClick={() => onSelect(pages[index - 1].id)} className="rounded p-1 disabled:opacity-30"><ChevronLeft size={18}/></button><span>{index + 1} / {pages.length}</span><button type="button" aria-label="下一页" disabled={index < 0 || index >= pages.length - 1} onClick={() => onSelect(pages[index + 1].id)} className="rounded p-1 disabled:opacity-30"><ChevronRight size={18}/></button></div>
        <div className="flex max-h-24 shrink-0 justify-center gap-2 overflow-x-auto pb-1" aria-label="放映页面">{pages.map((page, i) => <button key={page.id} type="button" aria-label={`跳转到第 ${i + 1} 张`} aria-current={page.id === currentId ? "true" : undefined} onClick={() => onSelect(page.id)} className={`w-28 shrink-0 overflow-hidden rounded border-2 ${page.id === currentId ? "border-[#3370ff]" : "border-transparent"}`}><SlideSurface content={contentFor(page)}/></button>)}</div>
      </div>
      <aside className="min-h-32 min-w-0 flex-[2] overflow-auto rounded-xl bg-[#252629] p-4 text-[14px] text-[#dee0e3]" aria-label="演示者备注"><div className="border-b border-white/10 pb-3 font-medium">演示者备注</div><p className="mt-4 whitespace-pre-wrap break-words">{content.notes || "暂无备注"}</p></aside>
    </div>
  </div>;
}

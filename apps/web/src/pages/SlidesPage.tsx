import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { docsApi, slidesApi, type SlidesPage as Page, type SlideShape } from "@/lib/api";
import { ShareDialog } from "@/components/ShareDialog";
import { ask } from "@/components/ui/ask";
import { cn } from "@/lib/utils";
import { SlidesDraftQueue } from "./slidesDraft";
import { SlideShapes } from "./slides-shapes";
import { SlideShapeControls } from "./slides-shape-controls";
import { patchSlideShape } from "./slides-shape-state";
import { clampSlideZoom, fitSlideZoom, parseSlideZoom, SLIDE_HEIGHT, SLIDE_WIDTH } from "./slides-zoom";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronsLeft, ChevronsRight, Copy, FilePlus2, ImageIcon, Maximize2, Minus, Palette, Play, Plus, Presentation, Trash2, Type, Shapes } from "lucide-react";

/** Presentation editor. Drafts are kept locally while page writes are serialised. */
export function SlidesDeck({ deckId }: { deckId: number }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shapeMenu, setShapeMenu] = useState(false);
  const [selectedShape, setSelectedShape] = useState<string | null>(null);
  const [showSlideList, setShowSlideList] = useState(true);
  const [fitZoom, setFitZoom] = useState(100);
  const [manualZoom, setManualZoom] = useState<number | null>(null);
  const [zoomText, setZoomText] = useState("100");
  const zoomEditing = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [, setDraftVersion] = useState(0);
  const shareRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const backgroundRef = useRef<HTMLInputElement>(null);
  const meta = useQuery({ queryKey: ["slides-meta", deckId], queryFn: () => docsApi.get(deckId), refetchInterval: 15000, refetchIntervalInBackground: false });
  const canEdit = !meta.isError && !meta.isFetching && (meta.data?.role === "edit" || meta.data?.role === "manage");
  const pages = useQuery({ queryKey: ["slides", deckId], queryFn: () => slidesApi.pages(deckId), enabled: !!meta.data && !meta.isError });
  const queue = useMemo(() => new SlidesDraftQueue(
    (page, content) => slidesApi.update(page.id, content.title, content.body, content.background, page.revision, content.notes, content.shapes),
    (saved) => qc.setQueryData<Page[]>(["slides", deckId], (old) => old?.map((item) => item.id === saved.id && item.revision <= saved.revision ? saved : item)),
    () => setDraftVersion((version) => version + 1),
  ), [deckId, qc]);
  useEffect(() => () => queue.dispose(), [queue]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (queue.hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue]);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["slides", deckId] });
  const create = useMutation({ mutationFn: () => slidesApi.create(deckId, ""), onSuccess: (page) => { setCurrent(page.id); void invalidate(); } });
  const remove = useMutation({ mutationFn: (pid: number) => slidesApi.remove(pid), onSuccess: () => { setCurrent(null); void invalidate(); } });
  const [operationError, setOperationError] = useState("");
  const list = pages.data ?? [];
  const active = list.find((page) => page.id === current) ?? list[0] ?? null;
  const draft = active ? queue.get(active) : null;
  const chosenShape = draft?.content.shapes.find((shape) => shape.id === selectedShape);
  const zoom = manualZoom ?? fitZoom;
  useEffect(() => { if (!zoomEditing.current) setZoomText(String(zoom)); }, [zoom]);
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const measure = () => setFitZoom(fitSlideZoom(node.clientWidth, node.clientHeight));
    measure();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [meta.isPending, meta.isError, pages.isError, playing]);
  const updateShape = (id: string, patch: Partial<SlideShape>) => {
    if (!active) return;
    const current = queue.get(active);
    const shapes = patchSlideShape(current.content.shapes, id, patch);
    queue.edit(active, { shapes });
  };
  const addShape = (kind: SlideShape["kind"]) => { if (!active || !draft || !canEdit || draft.content.shapes.length >= 100) return; const shape: SlideShape = { id: `shape-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, kind, x: 68, y: 54, color: "#3370ff" }; queue.edit(active, { shapes: [...draft.content.shapes, shape] }); setSelectedShape(shape.id); setShapeMenu(false); };

  useEffect(() => {
    if (!playing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlaying(false);
      if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const index = active ? list.findIndex((page) => page.id === active.id) : -1;
      if ((event.key === "ArrowRight" || event.key === "ArrowDown") && index >= 0 && index < list.length - 1) setCurrent(list[index + 1].id);
      if ((event.key === "ArrowLeft" || event.key === "ArrowUp") && index > 0) setCurrent(list[index - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, active, list]);

  if (meta.isPending) return <div className="grid flex-1 place-items-center text-[13px] text-subtle">正在打开演示文稿…</div>;
  if (meta.isError || !meta.data || pages.isError) return <div className="grid flex-1 place-items-center text-[13px] text-subtle">无法访问该演示文稿，请确认权限后重试。</div>;

  if (playing && active && draft) return (
    <div className="fixed inset-0 z-[80] flex flex-col items-center justify-center bg-[#1f2329] p-4 sm:p-10" data-slides-playing>
      <div className="relative aspect-video w-full max-w-[1280px] shrink-0 overflow-hidden bg-white px-[6%] py-[5%]" style={{ width: "min(100%, calc((100dvh - 6rem) * 16 / 9))", backgroundColor: draft.content.background || "#fff" }}>
        <h1 className="px-2 py-1 text-[clamp(18px,3vw,44px)] font-semibold leading-tight text-[#1f2329]">{draft.content.title}</h1>
        <div className="mt-[4%] whitespace-pre-wrap px-2 py-1 text-[clamp(13px,1.8vw,26px)] leading-relaxed text-[#1f2329]">{draft.content.body}</div>
        <SlideShapes shapes={draft.content.shapes} editable={false} selected={null}/>
      </div>
      <div className="absolute bottom-3 flex items-center gap-3 rounded-lg bg-black/60 px-3 py-2 text-[13px] text-white"><button type="button" disabled={list.findIndex((page) => page.id === active.id) <= 0} onClick={() => { const i = list.findIndex((page) => page.id === active.id); if (i > 0) setCurrent(list[i - 1].id); }} className="disabled:opacity-40">上一页</button><span>{list.findIndex((page) => page.id === active.id) + 1} / {list.length}</span><button type="button" disabled={list.findIndex((page) => page.id === active.id) >= list.length - 1} onClick={() => { const i = list.findIndex((page) => page.id === active.id); if (i < list.length - 1) setCurrent(list[i + 1].id); }} className="disabled:opacity-40">下一页</button><button type="button" onClick={() => setPlaying(false)}>退出放映</button></div>
    </div>
  );

  const doMove = (page: Page, pos: number) => { setOperationError(""); void slidesApi.move(page.id, pos).then(invalidate).catch(() => setOperationError("页面顺序未能确认，请刷新后重试。")); };
  const doCopy = (page: Page) => {
    const source = queue.get(page);
    if (source.state !== "saved") return;
    setOperationError("");
    void slidesApi.create(deckId, source.content.title).then((copy) => slidesApi.update(copy.id, source.content.title, source.content.body, source.content.background, copy.revision, source.content.notes, source.content.shapes)).then((copy) => { setCurrent(copy.id); return invalidate(); }).catch(() => { setOperationError("复制结果未能确认，请刷新后检查页面列表。"); void invalidate(); });
  };
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#f5f6f7]" data-slides-editor>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-white pl-14 pr-3 md:px-5">
        <button type="button" onClick={() => { location.hash = "#/drive/mine"; }} aria-label="返回云盘" className="grid size-8 shrink-0 place-items-center rounded-md text-[#646a73] hover:bg-[#f2f3f5]"><ChevronLeft size={17}/></button>
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-[#ff8800] text-white"><Presentation size={15}/></span>
        <div className="min-w-0"><div className="truncate text-[14px] font-semibold text-[#1f2329]">{meta.data.title || "未命名幻灯片"}</div><div className="text-[11px] text-[#8f959e]">{draft?.state === "saving" ? "正在保存…" : draft?.state === "saved" ? "已保存" : draft ? "有未保存内容" : "演示文稿"}</div></div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button ref={shareRef} type="button" onClick={() => setSharing(true)} className="h-8 rounded-md bg-[#3370ff] px-2 text-[13px] font-medium text-white hover:bg-[#245bdb] sm:px-3">分享</button>
          <button type="button" disabled={!active} onClick={() => setPlaying(true)} className="flex h-8 items-center gap-1 rounded-md border border-[#3370ff] bg-white px-3 text-[13px] text-[#3370ff] hover:bg-[#f5f6f7] disabled:opacity-40"><Play size={13}/>演示</button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {showSlideList ? <aside className="flex w-[104px] shrink-0 flex-col border-r border-[#dee0e3] bg-white sm:w-[196px]" data-slides-list>
          <div className="flex h-14 items-center gap-1 px-2 sm:px-3"><button type="button" disabled={!canEdit || create.isPending} onClick={() => create.mutate()} className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-[#d0d3d6] bg-white text-[12px] text-[#1f2329] hover:bg-[#f5f6f7] disabled:opacity-40"><FilePlus2 size={14}/><span className="hidden sm:inline">新建幻灯片</span><span className="sm:hidden">新建</span></button><button type="button" aria-label="收起幻灯片列表" onClick={() => setShowSlideList(false)} className="grid size-7 shrink-0 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><ChevronsLeft size={15}/></button></div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-4">
            {list.map((page, index) => {
              const item = queue.get(page);
              return <div key={page.id} className="group flex gap-1" data-slides-page={page.id}>
                <span className="w-4 pt-1 text-right text-[11px] text-[#8f959e]">{index + 1}</span>
                <button type="button" onClick={() => { setCurrent(page.id); setSelectedShape(null); }} aria-label={`第 ${index + 1} 页 ${item.content.title || "未命名"}`} className={cn("relative aspect-video min-w-0 flex-1 overflow-hidden rounded-[4px] border-2 bg-white text-left shadow-sm", active?.id === page.id ? "border-[#3370ff]" : "border-transparent hover:border-[#c8d4f4]")} style={{ backgroundColor: item.content.background || "#fff", containerType: "inline-size" }}>{item.content.title && <span className="absolute left-[7%] top-[10%] max-w-[85%] truncate font-semibold leading-tight text-[#1f2329]" style={{ fontSize: "3.75cqw" }}>{item.content.title}</span>}{item.content.body && <span className="absolute left-[7%] top-[26%] max-h-[58%] max-w-[85%] overflow-hidden whitespace-pre-wrap leading-relaxed text-[#1f2329]" style={{ fontSize: "2.2cqw" }}>{item.content.body}</span>}<SlideShapes shapes={item.content.shapes} editable={false} selected={null}/></button>
              </div>;
            })}
            {!list.length && pages.isSuccess && <p className="px-2 py-6 text-center text-[12px] text-[#8f959e]">暂无幻灯片</p>}
          </div>
        </aside> : <div className="w-9 shrink-0 border-r border-[#dee0e3] bg-white pt-3 text-center"><button type="button" aria-label="展开幻灯片列表" onClick={() => setShowSlideList(true)} className="inline-grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><ChevronsRight size={15}/></button></div>}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center gap-1 overflow-x-auto border-b border-[#e5e6eb] bg-white px-3 text-[12px] text-[#4e5969] [&>button]:shrink-0 [&>button]:whitespace-nowrap">
            <div className="flex min-w-max flex-1 items-center justify-center gap-1">
            <button type="button" disabled={!canEdit || !active} onClick={() => titleRef.current?.focus()} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Type size={16}/>文本</button>
            <div className="relative shrink-0"><button type="button" disabled={!canEdit || !active} aria-expanded={shapeMenu} onClick={() => setShapeMenu((open) => !open)} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Shapes size={16}/>图形</button></div>
            <button type="button" disabled={!canEdit || !active} onClick={() => backgroundRef.current?.click()} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Palette size={16}/>背景</button>
            <span className="mx-1 h-5 w-px bg-[#e5e6eb]" />
            <button type="button" aria-label="复制页面" disabled={!canEdit || !active || draft?.state !== "saved"} onClick={() => active && doCopy(active)} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Copy size={15}/>复制</button>
            <button type="button" disabled={!canEdit || !active || draft?.state !== "saved" || remove.isPending} onClick={async () => { if (active && await ask("删除此页？", "删除后不可恢复。")) remove.mutate(active.id); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Trash2 size={15}/>删除</button>
            <button type="button" disabled={!canEdit || !active || list.findIndex((page) => page.id === active.id) <= 0} onClick={() => { if (!active) return; const i = list.findIndex((page) => page.id === active.id); doMove(active, (list[i - 1].pos + (i > 1 ? list[i - 2].pos : 0)) / 2); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><ArrowUp size={15}/>上移</button>
            <button type="button" disabled={!canEdit || !active || list.findIndex((page) => page.id === active.id) >= list.length - 1} onClick={() => { if (!active) return; const i = list.findIndex((page) => page.id === active.id); doMove(active, (list[i + 1].pos + (i + 2 < list.length ? list[i + 2].pos : list[i + 1].pos + 1)) / 2); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><ArrowDown size={15}/>下移</button>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-3" role="group" aria-label="幻灯片缩放"><button type="button" aria-label="缩小幻灯片" onClick={() => setManualZoom(clampSlideZoom(zoom - 10))} className="grid size-7 place-items-center rounded-l border border-[#d0d3d6] hover:bg-[#f2f3f5]"><Minus size={14}/></button><label className="flex h-7 items-center border-y border-[#d0d3d6] text-[#646a73]"><input aria-label="幻灯片缩放比例" inputMode="decimal" value={zoomText} onFocus={(event) => { zoomEditing.current = true; event.currentTarget.select(); }} onChange={(event) => setZoomText(event.target.value)} onBlur={() => { if (!zoomEditing.current) return; zoomEditing.current = false; const value = parseSlideZoom(zoomText); if (value !== null) { setManualZoom(value); setZoomText(String(value)); } else setZoomText(String(zoom)); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { zoomEditing.current = false; setZoomText(String(zoom)); event.currentTarget.blur(); } }} className="w-9 bg-transparent text-right text-[12px] outline-none"/><span className="pr-1">%</span></label><button type="button" aria-label="放大幻灯片" onClick={() => setManualZoom(clampSlideZoom(zoom + 10))} className="grid size-7 place-items-center rounded-r border border-[#d0d3d6] hover:bg-[#f2f3f5]"><Plus size={14}/></button><button type="button" aria-label="适合屏幕" title="适合屏幕" onClick={() => setManualZoom(null)} className="ml-1 grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Maximize2 size={14}/></button></div>
          </div>
          {shapeMenu && <div className="flex shrink-0 items-center gap-1 border-b bg-white px-4 py-2 text-[13px]" role="group" aria-label="选择图形">{([["rectangle", "矩形"], ["ellipse", "圆形"], ["triangle", "三角形"]] as const).map(([kind, label]) => <button key={kind} type="button" onClick={() => addShape(kind)} className="rounded-md px-3 py-2 hover:bg-[#f2f3f5]">{label}</button>)}<button type="button" onClick={() => setShapeMenu(false)} className="ml-auto rounded-md px-3 py-2 hover:bg-[#f2f3f5]">关闭</button></div>}
          {chosenShape && canEdit && <SlideShapeControls shape={chosenShape} onChange={(patch) => updateShape(chosenShape.id, patch)} onDelete={() => { if (active) queue.edit(active, { shapes: queue.get(active).content.shapes.filter((shape) => shape.id !== chosenShape.id) }); setSelectedShape(null); }}/>}
          {(operationError || create.isError || remove.isError) && <p role="alert" className="bg-[#fff2f0] px-4 py-2 text-[12px] text-[#d83931]">{operationError || "操作未完成，请刷新后检查。"}</p>}
          {draft && (draft.state === "conflict" || draft.state === "unknown") && <p role="alert" className="bg-[#fff2f0] px-4 py-2 text-[12px] text-[#d83931]">{draft.state === "conflict" ? "此页已被其他人修改。" : "保存结果未确认。"}你的输入仍在页面中，请复制保留后重新打开。</p>}
          <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto">
            <div className="flex min-h-full min-w-full p-4">
              {active && draft ? <div className="group/slide relative m-auto shrink-0 bg-white shadow-[0_4px_18px_rgba(31,35,41,0.12)]" style={{ width: SLIDE_WIDTH * zoom / 100, height: SLIDE_HEIGHT * zoom / 100, backgroundColor: draft.content.background || "#fff" }} data-slides-canvas>
                <div className="absolute left-0 top-0" style={{ width: SLIDE_WIDTH, height: SLIDE_HEIGHT, padding: "48px 57.6px", transform: `scale(${zoom / 100})`, transformOrigin: "top left" }}>
                  <input ref={titleRef} aria-label="幻灯片标题" value={draft.content.title} readOnly={!canEdit} onChange={(event) => queue.edit(active, { title: event.target.value })} placeholder="点击添加标题" className="w-full border border-transparent bg-transparent px-2 py-1 text-[36px] font-semibold leading-tight text-[#1f2329] outline-none placeholder:text-transparent focus:border-[#3370ff] focus:placeholder:text-[#b8bec5] group-hover/slide:placeholder:text-[#b8bec5] [@media(hover:none)]:placeholder:text-[#b8bec5]" data-slides-title />
                  <textarea aria-label="幻灯片正文" value={draft.content.body} readOnly={!canEdit} onChange={(event) => queue.edit(active, { body: event.target.value })} placeholder="点击添加正文" className="mt-[4%] h-[55%] w-full resize-none border border-transparent bg-transparent px-2 py-1 text-[21px] leading-relaxed text-[#1f2329] outline-none placeholder:text-transparent focus:border-[#3370ff] focus:placeholder:text-[#b8bec5] group-hover/slide:placeholder:text-[#b8bec5] [@media(hover:none)]:placeholder:text-[#b8bec5]" data-slides-body />
                  <SlideShapes shapes={draft.content.shapes} editable={canEdit} selected={selectedShape} onSelect={setSelectedShape} onChange={(shape) => updateShape(shape.id, { x: shape.x, y: shape.y })}/>
                </div>
                <input ref={backgroundRef} type="color" value={/^#[0-9a-f]{6}$/i.test(draft.content.background) ? draft.content.background : "#ffffff"} disabled={!canEdit} onChange={(event) => queue.edit(active, { background: event.target.value })} className="sr-only" aria-label="幻灯片背景颜色" />
              </div> : <div className="m-auto flex flex-col items-center gap-3 text-[13px] text-[#8f959e]"><ImageIcon size={32} strokeWidth={1.2}/><span>新建一页，开始制作幻灯片</span></div>}
            </div>
          </div>
          {active && draft && <div className="border-t border-[#e5e6eb] bg-white px-4 py-2"><textarea aria-label="演示者备注" value={draft.content.notes} readOnly={!canEdit} onChange={(event) => queue.edit(active, { notes: event.target.value })} placeholder="点击添加演示者备注" className="h-14 w-full resize-y bg-transparent text-[13px] text-[#646a73] outline-none placeholder:text-[#a3aab3]" /></div>}
          <footer className="flex h-9 shrink-0 items-center justify-between border-t border-[#e5e6eb] bg-white px-4 text-[12px] text-[#8f959e]"><span>{active ? `${list.findIndex((page) => page.id === active.id) + 1} / ${list.length}` : "0 / 0"}</span><span className="hidden sm:inline">使用方向键切换放映页面</span></footer>
        </section>
      </div>
      {sharing && <ShareDialog meta={meta.data} onClose={() => setSharing(false)} anchorRef={shareRef}/>}
    </main>
  );
}

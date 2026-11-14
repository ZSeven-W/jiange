import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, docsApi, slidesApi, type SlidesPage as Page, type SlideShape } from "@/lib/api";
import { ShareDialog } from "@/components/ShareDialog";
import { ask } from "@/components/ui/ask";
import { cn } from "@/lib/utils";
import { createVisitRecorder } from "@/lib/recentVisit";
import { sameSlideContent, SlidesDraftQueue } from "./slidesDraft";
import { copyErrorMessage } from "./documentCopy";
import { SlideShapes } from "./slides-shapes";
import { SlideShapeControls } from "./slides-shape-controls";
import { patchSlideShape } from "./slides-shape-state";
import { clampSlideZoom, fitSlideZoom, parseSlideZoom, SLIDE_HEIGHT, SLIDE_WIDTH } from "./slides-zoom";
import { alignSlideShape, moveShapeOrder, type ShapeAlignment, type ShapeOrderAction } from "./slides-shape-order";
import { playableSlides, presentationStart, presentationKeyTarget } from "./slidesVisibility";
import { ResourceTypeNotice } from "./ResourceTypeNotice";
import { SlideFormatPanel } from "./SlideFormatPanel";
import { applyBackgroundChangeReceipts, applyBackgroundReceipts } from "./slides-background";
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronsLeft, ChevronsRight, Copy, EyeOff, FilePlus2, ImageIcon, Maximize2, Minus, MoreHorizontal, Palette, Play, Plus, Presentation, Redo2, Trash2, Type, Shapes, Undo2 } from "lucide-react";

type BackgroundAction = { id: number; before: Page[]; after: Page[] };
type BackgroundHistory = { undo: BackgroundAction[]; redo: BackgroundAction[] };

/** Presentation editor. Drafts are kept locally while page writes are serialised. */
export function SlidesDeck({ deckId, userId }: { deckId: number; userId: number }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [checkingPlayback, setCheckingPlayback] = useState(false);
  const [playMenu, setPlayMenu] = useState(false);
  const playMenuRef = useRef<HTMLDivElement>(null);
  const playbackRef = useRef<HTMLDivElement>(null);
  const playbackCheck = useRef(false);
  const [sharing, setSharing] = useState(false);
  const [shapeMenu, setShapeMenu] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [backgroundApplying, setBackgroundApplying] = useState(false);
  const [backgroundBatchUnknown, setBackgroundBatchUnknown] = useState(false);
  const [backgroundHistory, setBackgroundHistory] = useState<BackgroundHistory>({ undo: [], redo: [] });
  const backgroundHistoryRef = useRef(backgroundHistory);
  const backgroundBatchSequence = useRef(0);
  backgroundHistoryRef.current = backgroundHistory;
  const [uploadingImage, setUploadingImage] = useState(false);
  const [copyingDeck, setCopyingDeck] = useState(false);
  const [createdCopyId, setCreatedCopyId] = useState<number | null>(null);
  const [pageActions, setPageActions] = useState(0);
  const [pageMenu, setPageMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const [copyPageUnknown, setCopyPageUnknown] = useState(false);
  const [insertPageUnknown, setInsertPageUnknown] = useState(false);
  const [visibilityUnknown, setVisibilityUnknown] = useState(false);
  const insertingPage = useRef(false);
  const pageMenuRef = useRef<HTMLDivElement>(null);
  const pageActionCount = useRef(0);
  const copyRequest = useRef<AbortController | null>(null);
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
  const backgroundTarget = useRef<number | null>(null);
  const backgroundButtonRef = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageUpload = useRef<AbortController | null>(null);
  const activePageRef = useRef<number | null>(null);
  const canEditRef = useRef(false);
  const backgroundHistoryAction = useRef<(redo: boolean) => boolean>(() => false);
  const meta = useQuery({ queryKey: ["slides-meta", deckId, userId], queryFn: () => docsApi.get(deckId), refetchInterval: 15000, refetchIntervalInBackground: false });
  const visitRecorder = useMemo(() => createVisitRecorder(
    () => docsApi.recordVisit(deckId),
    () => { void qc.invalidateQueries({ queryKey: ["recent"] }); },
    () => { void qc.invalidateQueries({ queryKey: ["slides-meta", deckId, userId] }); },
  ), [deckId, userId, qc]);
  useEffect(() => {
    if (!meta.isSuccess || meta.isError || meta.isFetching || meta.data.kind !== "slides") return;
    visitRecorder.start();
    return () => visitRecorder.stop();
  }, [meta.isSuccess, meta.isError, meta.isFetching, meta.data?.kind, visitRecorder]);
  const canEdit = !copyingDeck && !checkingPlayback && !backgroundBatchUnknown && pageActions === 0 && !meta.isError && !meta.isFetching && meta.data?.kind === "slides" && (meta.data.role === "edit" || meta.data.role === "manage");
  const pages = useQuery({ queryKey: ["slides", deckId, userId], queryFn: () => slidesApi.pages(deckId, userId), enabled: meta.data?.kind === "slides" && !meta.isError, refetchInterval: 5000, refetchIntervalInBackground: false });
  const queue = useMemo(() => new SlidesDraftQueue(
    (page, content) => slidesApi.update(page.id, content.title, content.body, content.background, page.revision, content.notes, content.shapes),
    (saved) => qc.setQueryData<Page[]>(["slides", deckId, userId], (old) => old?.map((item) => item.id === saved.id && item.revision <= saved.revision ? saved : item)),
    () => setDraftVersion((version) => version + 1),
    () => setBackgroundHistory((history) => history.redo.length ? { ...history, redo: [] } : history),
  ), [deckId, userId, qc]);
  useEffect(() => () => queue.dispose(), [queue]);
  useEffect(() => () => { imageUpload.current?.abort(); imageUpload.current = null; }, []);
  useEffect(() => () => { copyRequest.current?.abort(); copyRequest.current = null; }, []);
  useEffect(() => {
    if (!pageMenu) return;
    pageMenuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!pageMenuRef.current?.contains(event.target as Node)) setPageMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setPageMenu(null); document.querySelector<HTMLButtonElement>(`[data-slide-options="${pageMenu.id}"]`)?.focus({ preventScroll: true }); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [pageMenu]);
  useEffect(() => {
    if (!playMenu) return;
    const outside = (event: PointerEvent) => { if (!playMenuRef.current?.contains(event.target as Node)) setPlayMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setPlayMenu(false); playMenuRef.current?.querySelector<HTMLButtonElement>("[aria-haspopup]")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [playMenu]);
  useEffect(() => { if (playing) playbackRef.current?.focus(); }, [playing]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (queue.hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue]);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["slides", deckId, userId] });
  // 整份复制只携带已保存内容；未保存草稿先行保存完成后才可点击。
  const duplicateDeck = async () => {
    if (!meta.data || backgroundBatchUnknown || copyRequest.current || queue.hasUnsaved() || uploadingImage || create.isPending || remove.isPending || pageActionCount.current > 0) return;
    const controller = new AbortController();
    copyRequest.current = controller;
    setCopyingDeck(true);
    setOperationError("");
    setCreatedCopyId(null);
    try {
      const nd = await slidesApi.duplicateDeck(deckId, userId, controller.signal);
      if (!nd || !Number.isSafeInteger(nd.id) || nd.id <= 0 || nd.kind !== "slides") throw new Error("invalid copy response");
      if (copyRequest.current !== controller) return;
      if (queue.hasUnsaved()) { setCreatedCopyId(nd.id); setOperationError("副本已创建；请先处理当前未保存内容。"); }
      else location.hash = `#/slides/${nd.id}`;
    } catch (error) {
      if (!controller.signal.aborted) setOperationError(error instanceof ApiError && error.status < 500 ? copyErrorMessage(error) : "创建结果未确认，请先检查云盘中的副本。");
    } finally {
      if (copyRequest.current === controller) { copyRequest.current = null; setCopyingDeck(false); }
    }
  };
  const create = useMutation({
    mutationFn: async (anchor: Page | null) => {
      const source = anchor ? queue.get(anchor) : null;
      if (source && source.state !== "saved") throw new ApiError(409, "conflict", "请等待当前页面保存完成。 ");
      const page = await slidesApi.insertPage(deckId, userId, anchor?.id ?? 0, source?.page.revision ?? 0);
      if (!page || !Number.isSafeInteger(page.id) || page.id <= 0 || page.id === anchor?.id || page.slidesId !== deckId || page.revision !== 1 || page.hidden !== false || page.title !== "" || page.body !== "" || page.notes !== "" || !Array.isArray(page.shapes) || page.shapes.length !== 0) throw new Error("invalid new page response");
      return { page, anchorId: anchor?.id ?? null };
    },
    onSuccess: ({ page, anchorId }) => { if (activePageRef.current === anchorId) { setCurrent(page.id); setSelectedShape(null); } void invalidate(); },
    onError: (error) => {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (!known) setInsertPageUnknown(true);
      setOperationError(known ? error.status === 409 ? "页面已变化或页面顺序空间不足，请刷新后重试。" : error.message : "新建结果未能确认，请重新打开并检查页面列表后再操作。");
      void invalidate();
    },
    onSettled: () => { insertingPage.current = false; },
  });
  const remove = useMutation({ mutationFn: (pid: number) => slidesApi.remove(pid), onSuccess: () => { setCurrent(null); void invalidate(); } });
  const [operationError, setOperationError] = useState("");
  const list = pages.data ?? [];
  const active = list.find((page) => page.id === current) ?? list[0] ?? null;
  const playable = playableSlides(list);
  const playbackPage = playing ? playable.find((page) => page.id === active?.id) ?? playable[0] ?? null : null;
  const playbackDraft = playbackPage ? queue.get(playbackPage) : null;
  activePageRef.current = active?.id ?? null;
  canEditRef.current = canEdit;
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
  const orderShape = (id: string, action: ShapeOrderAction) => {
    if (!active) return;
    const shapes = moveShapeOrder(queue.get(active).content.shapes, id, action);
    queue.edit(active, { shapes });
  };
  const alignShape = (id: string, alignment: ShapeAlignment) => {
    if (!active) return;
    const shapes = queue.get(active).content.shapes;
    const index = shapes.findIndex((shape) => shape.id === id);
    if (index < 0) return;
    const next = shapes.slice();
    next[index] = alignSlideShape(shapes[index], alignment);
    queue.edit(active, { shapes: next });
  };
  const addShape = (kind: SlideShape["kind"]) => { if (!active || !draft || !canEdit || draft.content.shapes.length >= 100) return; const shape: SlideShape = kind === "text" ? { id: `shape-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, kind, x: 12, y: 55, width: 35, height: 15, color: "#1f2329", text: "", fontSize: 24 } : { id: `shape-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, kind, x: 68, y: 54, color: "#3370ff" }; queue.edit(active, { shapes: [...draft.content.shapes, shape] }); setSelectedShape(shape.id); setShapeMenu(false); };
  const insertImage = async (file: File) => {
    if (!active || !canEdit || imageUpload.current) return;
    const page = active;
    const controller = new AbortController();
    imageUpload.current = controller;
    setUploadingImage(true);
    setOperationError("");
    try {
      const uploaded = await slidesApi.uploadImage(deckId, file, userId, controller.signal);
      if (!Number.isSafeInteger(uploaded.id) || uploaded.id <= 0 || uploaded.docId !== deckId) throw new Error("图片上传结果无效");
      if (imageUpload.current !== controller) return;
      if (!canEditRef.current || activePageRef.current !== page.id) { setOperationError("图片已上传，但页面或权限已变化，未插入图片。"); return; }
      const latest = queue.get(page);
      if (latest.content.shapes.length >= 100) { setOperationError("本页对象已达上限，图片未插入。"); return; }
      const shape: SlideShape = { id: `shape-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, kind: "image", x: 35, y: 35, width: 35, height: 35, color: "#ffffff", fileId: uploaded.id };
      queue.edit(page, { shapes: [...latest.content.shapes, shape] });
      setSelectedShape(shape.id);
    } catch (error) {
      if (!controller.signal.aborted) setOperationError(error instanceof Error ? `图片未能插入：${error.message}` : "图片未能插入，请重试。");
    } finally {
      if (imageUpload.current === controller) { imageUpload.current = null; setUploadingImage(false); }
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (playing || sharing || !canEdit || !active || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const redo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
      if (key !== "z" && !redo) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || (target !== document.body && !target.closest("[data-slides-editor]"))) return;
      if (target.matches("input, textarea, [contenteditable=true]") && !target.hasAttribute("data-slide-history")) return;
      event.preventDefault();
      if (backgroundHistoryAction.current(redo)) return;
      if (redo) queue.redo(active); else queue.undo(active);
      if (selectedShape && !queue.get(active).content.shapes.some((shape) => shape.id === selectedShape)) setSelectedShape(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, canEdit, playing, sharing, selectedShape, queue]);

  useEffect(() => {
    if (!playing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setPlaying(false); return; }
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !playbackPage) return;
      // Let focused buttons retain their native Enter/Space activation.
      if ((event.key === " " || event.key === "Enter") && event.target instanceof HTMLElement && event.target.closest("button")) return;
      const next = presentationKeyTarget(list, playbackPage.id, event.key);
      if (next) { event.preventDefault(); setCurrent(next.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, playbackPage, list]);

  if (meta.isPending) return <div className="grid flex-1 place-items-center text-[13px] text-subtle">正在打开演示文稿…</div>;
  if (meta.isError || !meta.data || pages.isError) return <div className="grid flex-1 place-items-center text-[13px] text-subtle"><div className="flex max-w-md flex-col items-center gap-3 px-4 text-center"><p>{pages.error instanceof ApiError && pages.error.status === 426 ? pages.error.message : "无法访问该演示文稿，请确认权限后重试。"}</p>{queue.hasUnsaved() && <p role="alert">当前页面有未保存内容，请勿刷新或关闭；恢复网络及权限后重试。</p>}<button type="button" onClick={() => { void meta.refetch(); void pages.refetch(); }} className="rounded-md border px-3 py-1.5 text-foreground hover:bg-hover">重试</button></div></div>;
  if (meta.data.kind !== "slides") return <ResourceTypeNotice id={deckId} kind={meta.data.kind} verified={!meta.isFetching} blockNavigation={queue.hasUnsaved()}>{queue.hasUnsaved() && <p role="alert" className="mt-3 text-[13px] text-red-600">当前演示文稿有未保存内容，请勿刷新或关闭；恢复文件类型和权限后重试。</p>}</ResourceTypeNotice>;

  if (playing && (!playbackPage || !playbackDraft)) return <div className="fixed inset-0 z-[80] grid place-items-center bg-[#1f2329] text-white"><div className="text-center"><p>没有可放映的幻灯片</p><button type="button" onClick={() => setPlaying(false)} className="mt-4 rounded border px-3 py-1">退出放映</button></div></div>;
  if (playing && playbackPage && playbackDraft) return (
    <div ref={playbackRef} tabIndex={-1} aria-label="幻灯片放映" className="fixed inset-0 z-[80] flex flex-col items-center justify-center bg-[#1f2329] p-4 outline-none sm:p-10" data-slides-playing>
      <div className="relative aspect-video w-full max-w-[1280px] shrink-0 overflow-hidden bg-white px-[6%] py-[5%]" style={{ width: "min(100%, calc((100dvh - 6rem) * 16 / 9))", backgroundColor: playbackDraft.content.background || "#fff", containerType: "inline-size" }}>
        <h1 className="font-semibold leading-tight text-[#1f2329]" style={{ fontSize: "3.75cqw", padding: "0.4167cqw 0.8333cqw" }}>{playbackDraft.content.title}</h1>
        <div className="mt-[4%] whitespace-pre-wrap break-words leading-relaxed text-[#1f2329]" style={{ fontSize: "2.1875cqw", padding: "0.4167cqw 0.8333cqw" }}>{playbackDraft.content.body}</div>
        <SlideShapes shapes={playbackDraft.content.shapes} editable={false} selected={null}/>
      </div>
      <div className="absolute bottom-3 flex items-center gap-3 rounded-lg bg-black/60 px-3 py-2 text-[13px] text-white"><button type="button" disabled={playable.findIndex((page) => page.id === playbackPage.id) <= 0} onClick={() => { const i = playable.findIndex((page) => page.id === playbackPage.id); if (i > 0) setCurrent(playable[i - 1].id); }} className="disabled:opacity-40">上一页</button><span>{playable.findIndex((page) => page.id === playbackPage.id) + 1} / {playable.length}</span><button type="button" disabled={playable.findIndex((page) => page.id === playbackPage.id) >= playable.length - 1} onClick={() => { const i = playable.findIndex((page) => page.id === playbackPage.id); if (i < playable.length - 1) setCurrent(playable[i + 1].id); }} className="disabled:opacity-40">下一页</button><button type="button" onClick={() => setPlaying(false)}>退出放映</button></div>
    </div>
  );

  const beginPageAction = () => { pageActionCount.current++; setPageActions(pageActionCount.current); };
  const endPageAction = () => { pageActionCount.current--; setPageActions(pageActionCount.current); };
  const mergeBackgroundPages = (after: Page[]) => {
    const byId = new Map(after.map((page) => [page.id, page]));
    qc.setQueryData<Page[]>(["slides", deckId, userId], (old) => old?.map((page) => { const saved = byId.get(page.id); return saved && page.revision <= saved.revision ? { ...saved, pos: page.pos, updatedAt: Date.parse(page.updatedAt) > Date.parse(saved.updatedAt) ? page.updatedAt : saved.updatedAt } : page; }));
  };
  const historyAvailable = (redo: boolean) => {
    const action = backgroundHistory[redo ? "redo" : "undo"].at(-1);
    if (!action) return false;
    return queue.canTravelBackgroundBatch(list, redo ? action.before : action.after, redo ? action.after : action.before, redo ? "redo" : "undo", action.id);
  };
  const historyBlocksPartial = (redo: boolean) => {
    const action = backgroundHistory[redo ? "redo" : "undo"].at(-1);
    if (!active || !action) return false;
    const target = (redo ? action.after : action.before).find((page) => page.id === active.id);
    const source = (redo ? action.before : action.after).find((page) => page.id === active.id);
    if (!target || !source) return false;
    const current = queue.get(active);
    // An unchanged page must not jump to an older per-page action while a
    // newer whole-deck action is still waiting to be reconciled.
    if (source.background === target.background && current.state === "saved" && current.page.hidden === source.hidden && sameSlideContent(current.content, source)) return true;
    return queue.isBackgroundHistoryTop(active, target, redo ? "redo" : "undo", action.id);
  };
  const tryBackgroundHistory = (redo: boolean): boolean => {
    const action = backgroundHistory[redo ? "redo" : "undo"].at(-1);
    if (!action) return false;
    const source = redo ? action.before : action.after;
    const target = redo ? action.after : action.before;
    const direction = redo ? "redo" : "undo";
    if (!queue.canTravelBackgroundBatch(list, source, target, direction, action.id)) {
      if (!historyBlocksPartial(redo)) return false;
      setOperationError("批量背景涉及的页面已变化，请先核对全部页面。"); return true;
    }
    if (!canEdit || !pages.isSuccess || pages.isFetching || queue.hasUnsaved() || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) {
      setOperationError("请等待页面保存和刷新完成后再操作。"); return true;
    }
    const before = list.map((page) => queue.get(page).page);
    const targetById = new Map(target.map((page) => [page.id, page.background]));
    const changes = before.map((page) => ({ id: page.id, revision: page.revision, background: targetById.get(page.id)! }));
    setOperationError(""); setBackgroundApplying(true); beginPageAction();
    void (async () => {
      try {
        const response = await slidesApi.changeBackgrounds(deckId, userId, changes);
        const after = applyBackgroundChangeReceipts(before, changes, response?.pages);
        if (!after || backgroundHistoryRef.current[direction].at(-1) !== action || !queue.acceptBackgroundTravel(before, after, source, target, direction, action.id)) { setBackgroundBatchUnknown(true); setOperationError("背景操作已提交，但页面状态发生变化；请保留内容并重新打开核对。"); void invalidate(); return; }
        mergeBackgroundPages(after);
        setBackgroundHistory((history) => {
          const from = history[direction], opposite = direction === "undo" ? "redo" : "undo";
          if (from.at(-1) !== action) return history;
          return { ...history, [direction]: from.slice(0, -1), [opposite]: [...history[opposite], action].slice(-50) };
        });
        void invalidate();
      } catch (error) {
        const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
        if (!known) setBackgroundBatchUnknown(true);
        setOperationError(known ? error.status === 409 ? "页面已变化，未修改背景，请刷新后核对。" : error.status === 404 || error.status === 405 ? "服务端不支持整份背景撤销，请升级后重试。" : error.message : "背景操作结果未确认，请重新打开并检查后再编辑。");
        void invalidate();
      } finally { setBackgroundApplying(false); endPageAction(); }
    })();
    return true;
  };
  backgroundHistoryAction.current = tryBackgroundHistory;
  const startPresentation = async (fromBeginning = false) => {
    if (playbackCheck.current || visibilityUnknown || backgroundBatchUnknown || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) return;
    playbackCheck.current = true; setCheckingPlayback(true); setOperationError("");
    try {
      const result = await pages.refetch();
      if (result.isError || !result.data) { setOperationError("无法确认最新页面状态，请联网后重试放映。"); return; }
      const start = presentationStart(result.data, fromBeginning ? null : activePageRef.current);
      if (!start) { setOperationError("没有可放映的幻灯片。"); return; }
      setCurrent(start.id); setPlaying(true);
    } finally { playbackCheck.current = false; setCheckingPlayback(false); }
  };
  const doMove = (page: Page, pos: number) => { setOperationError(""); beginPageAction(); void slidesApi.move(page.id, pos).then(invalidate).catch(() => setOperationError("页面顺序未能确认，请刷新后重试。")).finally(endPageAction); };
  const togglePageHidden = (page: Page) => {
    const source = queue.get(page);
    if (!canEdit || source.state !== "saved" || visibilityUnknown || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) return;
    const base = source.page, hidden = !base.hidden;
    setOperationError(""); beginPageAction();
    void slidesApi.setPageHidden(deckId, base.id, userId, base.revision, hidden).then((saved) => {
      if (!saved || saved.id !== base.id || saved.slidesId !== deckId || saved.revision !== base.revision + 1 || saved.hidden !== hidden || !Array.isArray(saved.shapes) || !sameSlideContent(source.content, saved)) throw new Error("invalid visibility response");
      if (!queue.acceptVisibility(base, saved)) { setVisibilityUnknown(true); setOperationError("页面状态已变化，请保留草稿并重新打开后核对。"); void invalidate(); return; }
      qc.setQueryData<Page[]>(["slides", deckId, userId], (old) => old?.map((item) => item.id === saved.id && item.revision <= saved.revision ? saved : item));
      void invalidate();
    }).catch((error) => {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (!known) setVisibilityUnknown(true);
      setOperationError(known ? error.status === 409 ? "页面已变化，请刷新后重试。" : error.message : "隐藏状态未能确认，请重新打开并检查后再放映。");
      void invalidate();
    }).finally(endPageAction);
  };
  const doInsert = (anchor: Page | null) => {
    if (!canEdit || !pages.isSuccess || pages.isError || insertPageUnknown || insertingPage.current || create.isPending || remove.isPending || pageActionCount.current || (anchor && queue.get(anchor).state !== "saved")) return;
    setOperationError("");
    if (anchor && activePageRef.current !== anchor.id) { activePageRef.current = anchor.id; setCurrent(anchor.id); setSelectedShape(null); }
    insertingPage.current = true;
    create.mutate(anchor);
  };
  const doCopy = (page: Page) => {
    const source = queue.get(page);
    if (source.state !== "saved" || !canEdit || copyPageUnknown || visibilityUnknown || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) return;
    setOperationError("");
    beginPageAction();
    void slidesApi.duplicatePage(deckId, page.id, userId, source.page.revision).then((copy) => {
      if (!copy || !Number.isSafeInteger(copy.id) || copy.id <= 0 || copy.id === page.id || copy.slidesId !== deckId || copy.revision !== 1 || copy.hidden !== source.page.hidden || !Array.isArray(copy.shapes) || !sameSlideContent(source.content, copy)) throw new Error("invalid copy response");
      if (activePageRef.current === page.id) setCurrent(copy.id);
      void invalidate();
    }).catch((error) => {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (!known) setCopyPageUnknown(true);
      setOperationError(known ? error.status === 409 ? "页面已变化或页面顺序空间不足，请刷新后重试。" : copyErrorMessage(error) : "复制结果未能确认，请重新打开并检查页面列表后再操作。");
      void invalidate();
    }).finally(endPageAction);
  };
  const applyBackgroundToAll = async () => {
    if (!canEdit || !active || !pages.isSuccess || pages.isFetching || queue.hasUnsaved() || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) return;
    const before = list.map((page) => queue.get(page).page);
    const color = queue.get(active).content.background;
    if (!before.length || before.length > 1000 || !/^(|#[0-9a-f]{6})$/i.test(color)) { setOperationError("背景颜色或页面数量不受支持。"); return; }
    setOperationError(""); setBackgroundApplying(true); beginPageAction();
    try {
      const response = await slidesApi.applyBackground(deckId, userId, color, before.map(({ id, revision }) => ({ id, revision })));
      const after = applyBackgroundReceipts(before, color, response?.pages);
      const id = ++backgroundBatchSequence.current;
      if (!after || !queue.acceptBackgroundBatch(before, after, id)) { setBackgroundBatchUnknown(true); setOperationError("背景已提交，但页面状态发生变化；请保留内容并重新打开核对。"); void invalidate(); return; }
      mergeBackgroundPages(after);
      if (before.some((page, index) => page.background !== after[index].background)) setBackgroundHistory((history) => ({ undo: [...history.undo, { id, before, after }].slice(-50), redo: [] }));
      void invalidate();
    } catch (error) {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (!known) setBackgroundBatchUnknown(true);
      setOperationError(known ? error.status === 409 ? "页面已变化，未应用背景，请刷新后重试。" : error.status === 404 || error.status === 405 ? "服务端不支持批量设置背景，请升级后重试。" : error.message : "应用结果未确认，请重新打开并检查背景后再编辑。");
      void invalidate();
    } finally { setBackgroundApplying(false); endPageAction(); }
  };
  const openPageMenu = (page: Page, x: number, y: number) => {
    activePageRef.current = page.id; setCurrent(page.id); setSelectedShape(null);
    setPageMenu({ id: page.id, x: Math.max(8, Math.min(x, window.innerWidth - 208)), y: Math.max(8, Math.min(y, window.innerHeight - 230)) });
  };
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#f5f6f7]" data-slides-editor>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-white pl-14 pr-3 md:px-5">
        <button type="button" onClick={() => { location.hash = "#/drive/mine"; }} aria-label="返回云盘" className="grid size-8 shrink-0 place-items-center rounded-md text-[#646a73] hover:bg-[#f2f3f5]"><ChevronLeft size={17}/></button>
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-[#ff8800] text-white"><Presentation size={15}/></span>
        <div className="min-w-0"><div className="truncate text-[14px] font-semibold text-[#1f2329]">{meta.data.title || "未命名幻灯片"}</div><div className="text-[11px] text-[#8f959e]">{draft?.state === "saving" ? "正在保存…" : draft?.state === "saved" ? "已保存" : draft ? "有未保存内容" : "演示文稿"}</div></div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button type="button" aria-label="创建整份幻灯片副本" title={backgroundBatchUnknown ? "请先重新打开并核对背景" : queue.hasUnsaved() ? "请先等待内容保存" : "创建副本"} disabled={backgroundBatchUnknown || copyingDeck || queue.hasUnsaved() || uploadingImage || create.isPending || remove.isPending || pageActions > 0} onClick={() => void duplicateDeck()} className="grid size-8 shrink-0 place-items-center rounded-md border border-[#d0d3d6] text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-40" data-slides-copy>{copyingDeck ? <span className="text-[11px]">…</span> : <Copy size={14}/>}</button>
          <button ref={shareRef} type="button" onClick={() => setSharing(true)} className="h-8 rounded-md bg-[#3370ff] px-2 text-[13px] font-medium text-white hover:bg-[#245bdb] sm:px-3">分享</button>
          <div ref={playMenuRef} className="relative flex h-8 rounded-md border border-[#3370ff] text-[#3370ff]">
            <button type="button" disabled={!playable.length || visibilityUnknown || backgroundBatchUnknown || checkingPlayback || pageActions > 0 || create.isPending || remove.isPending} title="从当前页开始演示" onClick={() => { setPlayMenu(false); void startPresentation(); }} className="flex items-center gap-1 rounded-l-md bg-white px-3 text-[13px] hover:bg-[#f5f6f7] disabled:opacity-40"><Play size={13}/>{checkingPlayback ? "检查中…" : "演示"}</button>
            <button type="button" aria-label="演示选项" aria-haspopup="menu" aria-expanded={playMenu} disabled={!playable.length || visibilityUnknown || backgroundBatchUnknown || checkingPlayback || pageActions > 0 || create.isPending || remove.isPending} onClick={() => setPlayMenu((open) => !open)} className="grid w-7 place-items-center rounded-r-md border-l border-[#3370ff] bg-white hover:bg-[#f5f6f7] disabled:opacity-40"><ChevronDown size={14}/></button>
            {playMenu && <div role="menu" aria-label="演示选项" className="absolute right-0 top-10 z-[70] w-40 rounded-lg border border-[#dee0e3] bg-white p-1 text-[13px] text-[#1f2329] shadow-lg"><button role="menuitem" type="button" onClick={() => { setPlayMenu(false); void startPresentation(); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5]"><Play size={14}/>从当前开始</button><button role="menuitem" type="button" onClick={() => { setPlayMenu(false); void startPresentation(true); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5]"><Presentation size={14}/>从头开始</button></div>}
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1">
        {showSlideList ? <aside className="flex w-[104px] shrink-0 flex-col border-r border-[#dee0e3] bg-white sm:w-[196px]" data-slides-list>
          <div className="flex h-14 items-center gap-1 px-2 sm:px-3"><button type="button" disabled={!canEdit || !pages.isSuccess || create.isPending || remove.isPending || pageActions > 0 || insertPageUnknown || !!active && draft?.state !== "saved"} onClick={() => doInsert(active)} className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-[#d0d3d6] bg-white text-[12px] text-[#1f2329] hover:bg-[#f5f6f7] disabled:opacity-40"><FilePlus2 size={14}/><span className="hidden sm:inline">新建幻灯片</span><span className="sm:hidden">新建</span></button><button type="button" aria-label="收起幻灯片列表" onClick={() => setShowSlideList(false)} className="grid size-7 shrink-0 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><ChevronsLeft size={15}/></button></div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-4">
            {list.map((page, index) => {
              const item = queue.get(page);
              return <div key={page.id} className="group relative flex gap-1" data-slides-page={page.id} onContextMenu={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openPageMenu(page, event.clientX || rect.left, event.clientY || rect.bottom); }}>
                <span className={cn("w-4 pt-1 text-right text-[11px] text-[#8f959e]", page.hidden && "line-through")}>{index + 1}</span>
                <button type="button" onClick={() => { activePageRef.current = page.id; setCurrent(page.id); setSelectedShape(null); }} onKeyDown={(event) => { if (!event.shiftKey && !event.altKey && event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "m") { event.preventDefault(); doInsert(page); } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "d") { event.preventDefault(); doCopy(page); } }} aria-label={`第 ${index + 1} 页 ${item.content.title || "未命名"}${page.hidden ? "，已隐藏" : ""}`} className={cn("relative aspect-video min-w-0 flex-1 overflow-hidden rounded-[4px] border-2 bg-white text-left shadow-sm", active?.id === page.id ? "border-[#3370ff]" : "border-transparent hover:border-[#c8d4f4]")} style={{ backgroundColor: item.content.background || "#fff", containerType: "inline-size" }}>{item.content.title && <span className="absolute left-[7%] top-[10%] max-w-[85%] truncate font-semibold leading-tight text-[#1f2329]" style={{ fontSize: "3.75cqw" }}>{item.content.title}</span>}{item.content.body && <span className="absolute left-[7%] top-[26%] max-h-[58%] max-w-[85%] overflow-hidden whitespace-pre-wrap leading-relaxed text-[#1f2329]" style={{ fontSize: "2.2cqw" }}>{item.content.body}</span>}<SlideShapes shapes={item.content.shapes} editable={false} selected={null}/>{page.hidden && <span className="absolute bottom-1 right-1 grid size-5 place-items-center rounded bg-[#f2f3f5] text-[#646a73]" title="已隐藏"><EyeOff size={13}/></span>}</button>
                <button type="button" aria-label={`第 ${index + 1} 页更多操作`} aria-haspopup="menu" aria-expanded={pageMenu?.id === page.id} data-slide-options={page.id} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openPageMenu(page, rect.right, rect.bottom); }} className={cn("absolute right-1 top-1 grid size-7 place-items-center rounded bg-white/90 text-[#646a73] shadow-sm hover:bg-[#f2f3f5] focus:pointer-events-auto focus:opacity-100 sm:pointer-events-auto sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100", active?.id === page.id ? "opacity-100" : "pointer-events-none opacity-0")}><MoreHorizontal size={16}/></button>
              </div>;
            })}
            {!list.length && pages.isSuccess && <p className="px-2 py-6 text-center text-[12px] text-[#8f959e]">暂无幻灯片</p>}
          </div>
        </aside> : <div className="w-9 shrink-0 border-r border-[#dee0e3] bg-white pt-3 text-center"><button type="button" aria-label="展开幻灯片列表" onClick={() => setShowSlideList(true)} className="inline-grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><ChevronsRight size={15}/></button></div>}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center gap-1 overflow-x-auto border-b border-[#e5e6eb] bg-white px-3 text-[12px] text-[#4e5969] [&>button]:shrink-0 [&>button]:whitespace-nowrap">
            <div className="flex shrink-0 items-center gap-0.5 border-r border-[#e5e6eb] pr-2">
              <button type="button" aria-label={historyAvailable(false) || historyBlocksPartial(false) ? "撤销整份背景" : "撤销本页内容"} title={historyAvailable(false) || historyBlocksPartial(false) ? "撤销整份背景 (⌘/Ctrl+Z)" : "撤销本页内容 (⌘/Ctrl+Z)"} disabled={!canEdit || !active || !(historyAvailable(false) || historyBlocksPartial(false) || queue.canUndo(active))} onClick={() => { if (active && !tryBackgroundHistory(false)) { queue.undo(active); if (selectedShape && !queue.get(active).content.shapes.some((shape) => shape.id === selectedShape)) setSelectedShape(null); } }} className="grid size-8 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-30"><Undo2 size={16}/></button>
              <button type="button" aria-label={historyAvailable(true) || historyBlocksPartial(true) ? "重做整份背景" : "重做本页内容"} title={historyAvailable(true) || historyBlocksPartial(true) ? "重做整份背景 (⌘/Ctrl+Shift+Z)" : "重做本页内容 (⌘/Ctrl+Shift+Z)"} disabled={!canEdit || !active || !(historyAvailable(true) || historyBlocksPartial(true) || queue.canRedo(active))} onClick={() => { if (active && !tryBackgroundHistory(true)) { queue.redo(active); if (selectedShape && !queue.get(active).content.shapes.some((shape) => shape.id === selectedShape)) setSelectedShape(null); } }} className="grid size-8 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-30"><Redo2 size={16}/></button>
            </div>
            <div className="flex min-w-max flex-1 items-center justify-center gap-1">
            <button type="button" disabled={!canEdit || !active || draft?.content.shapes.length === 100} onClick={() => addShape("text")} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Type size={16}/>文本</button>
            <div className="relative shrink-0"><button type="button" disabled={!canEdit || !active} aria-expanded={shapeMenu} onClick={() => setShapeMenu((open) => !open)} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Shapes size={16}/>图形</button></div>
            <button type="button" disabled={!canEdit || !active || uploadingImage || draft?.content.shapes.length === 100} onClick={() => imageInputRef.current?.click()} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><ImageIcon size={16}/>{uploadingImage ? "上传中" : "图片"}</button>
            <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" aria-label="选择幻灯片图片" className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void insertImage(file); }}/>
            <button ref={backgroundButtonRef} type="button" disabled={!active} aria-expanded={formatOpen} onClick={() => setFormatOpen((open) => !open)} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Palette size={16}/>背景</button>
            <span className="mx-1 h-5 w-px bg-[#e5e6eb]" />
            <button type="button" aria-label="复制页面" disabled={!canEdit || !active || draft?.state !== "saved" || copyPageUnknown || visibilityUnknown || pageActions > 0} onClick={() => active && doCopy(active)} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Copy size={15}/>复制</button>
            <button type="button" disabled={!canEdit || !active || draft?.state !== "saved" || remove.isPending} onClick={async () => { if (active && await ask("删除此页？", "删除后不可恢复。")) remove.mutate(active.id); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Trash2 size={15}/>删除</button>
            <button type="button" disabled={!canEdit || !active || list.findIndex((page) => page.id === active.id) <= 0} onClick={() => { if (!active) return; const i = list.findIndex((page) => page.id === active.id); doMove(active, (list[i - 1].pos + (i > 1 ? list[i - 2].pos : 0)) / 2); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><ArrowUp size={15}/>上移</button>
            <button type="button" disabled={!canEdit || !active || list.findIndex((page) => page.id === active.id) >= list.length - 1} onClick={() => { if (!active) return; const i = list.findIndex((page) => page.id === active.id); doMove(active, (list[i + 1].pos + (i + 2 < list.length ? list[i + 2].pos : list[i + 1].pos + 1)) / 2); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><ArrowDown size={15}/>下移</button>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-3" role="group" aria-label="幻灯片缩放"><button type="button" aria-label="缩小幻灯片" onClick={() => setManualZoom(clampSlideZoom(zoom - 10))} className="grid size-7 place-items-center rounded-l border border-[#d0d3d6] hover:bg-[#f2f3f5]"><Minus size={14}/></button><label className="flex h-7 items-center border-y border-[#d0d3d6] text-[#646a73]"><input aria-label="幻灯片缩放比例" inputMode="decimal" value={zoomText} onFocus={(event) => { zoomEditing.current = true; event.currentTarget.select(); }} onChange={(event) => setZoomText(event.target.value)} onBlur={() => { if (!zoomEditing.current) return; zoomEditing.current = false; const value = parseSlideZoom(zoomText); if (value !== null) { setManualZoom(value); setZoomText(String(value)); } else setZoomText(String(zoom)); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { zoomEditing.current = false; setZoomText(String(zoom)); event.currentTarget.blur(); } }} className="w-9 bg-transparent text-right text-[12px] outline-none"/><span className="pr-1">%</span></label><button type="button" aria-label="放大幻灯片" onClick={() => setManualZoom(clampSlideZoom(zoom + 10))} className="grid size-7 place-items-center rounded-r border border-[#d0d3d6] hover:bg-[#f2f3f5]"><Plus size={14}/></button><button type="button" aria-label="适合屏幕" title="适合屏幕" onClick={() => setManualZoom(null)} className="ml-1 grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Maximize2 size={14}/></button></div>
          </div>
          {shapeMenu && <div className="flex shrink-0 items-center gap-1 border-b bg-white px-4 py-2 text-[13px]" role="group" aria-label="选择图形">{([["rectangle", "矩形"], ["ellipse", "圆形"], ["triangle", "三角形"]] as const).map(([kind, label]) => <button key={kind} type="button" onClick={() => addShape(kind)} className="rounded-md px-3 py-2 hover:bg-[#f2f3f5]">{label}</button>)}<button type="button" onClick={() => setShapeMenu(false)} className="ml-auto rounded-md px-3 py-2 hover:bg-[#f2f3f5]">关闭</button></div>}
          {chosenShape && canEdit && <SlideShapeControls shape={chosenShape} onChange={(patch) => updateShape(chosenShape.id, patch)} onOrder={(action) => orderShape(chosenShape.id, action)} onAlign={(alignment) => alignShape(chosenShape.id, alignment)} onDelete={() => { if (active) queue.edit(active, { shapes: queue.get(active).content.shapes.filter((shape) => shape.id !== chosenShape.id) }); setSelectedShape(null); }}/>}
          {(operationError || visibilityUnknown || create.isError || remove.isError) && <p role="alert" className="bg-[#fff2f0] px-4 py-2 text-[12px] text-[#d83931]">{operationError || (visibilityUnknown ? "隐藏状态未能确认，请重新打开并检查后再放映。" : "操作未完成，请刷新后检查。")}{createdCopyId && <a className="ml-2 underline" href={`#/slides/${createdCopyId}`}>打开已创建的副本</a>}</p>}
          {draft && (draft.state === "conflict" || draft.state === "unknown") && <p role="alert" className="bg-[#fff2f0] px-4 py-2 text-[12px] text-[#d83931]">{draft.state === "conflict" ? "此页已被其他人修改。" : "保存结果未确认。"}你的输入仍在页面中，请复制保留后重新打开。</p>}
          <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto">
            <div className="flex min-h-full min-w-full p-4">
              {active && draft ? <div className="group/slide relative m-auto shrink-0 bg-white shadow-[0_4px_18px_rgba(31,35,41,0.12)]" style={{ width: SLIDE_WIDTH * zoom / 100, height: SLIDE_HEIGHT * zoom / 100, backgroundColor: draft.content.background || "#fff" }} data-slides-canvas onPointerDown={(event) => { if (event.target instanceof Element && !event.target.closest("[data-slide-object]")) { queue.endGroup(active.id); setSelectedShape(null); } }}>
                <div className="absolute left-0 top-0" style={{ width: SLIDE_WIDTH, height: SLIDE_HEIGHT, padding: "48px 57.6px", transform: `scale(${zoom / 100})`, transformOrigin: "top left", containerType: "inline-size" }}>
                  <input ref={titleRef} aria-label="幻灯片标题" value={draft.content.title} readOnly={!canEdit} onChange={(event) => queue.edit(active, { title: event.target.value }, "title")} onBlur={() => queue.endGroup(active.id)} placeholder="点击添加标题" className="w-full border border-transparent bg-transparent px-2 py-1 text-[36px] font-semibold leading-tight text-[#1f2329] outline-none placeholder:text-transparent focus:border-[#3370ff] focus:placeholder:text-[#b8bec5] group-hover/slide:placeholder:text-[#b8bec5] [@media(hover:none)]:placeholder:text-[#b8bec5]" data-slides-title data-slide-history />
                  <textarea aria-label="幻灯片正文" value={draft.content.body} readOnly={!canEdit} onChange={(event) => queue.edit(active, { body: event.target.value }, "body")} onBlur={() => queue.endGroup(active.id)} placeholder="点击添加正文" className="mt-[4%] h-[55%] w-full resize-none border border-transparent bg-transparent px-2 py-1 text-[21px] leading-relaxed text-[#1f2329] outline-none placeholder:text-transparent focus:border-[#3370ff] focus:placeholder:text-[#b8bec5] group-hover/slide:placeholder:text-[#b8bec5] [@media(hover:none)]:placeholder:text-[#b8bec5]" data-slides-body data-slide-history />
                  <SlideShapes shapes={draft.content.shapes} editable={canEdit} selected={selectedShape} scale={zoom / 100} onSelect={(id) => { if (id !== selectedShape) queue.endGroup(active.id); setSelectedShape(id); }} onChange={(shape) => updateShape(shape.id, { x: shape.x, y: shape.y, width: shape.width, height: shape.height })} onTextChange={(id, text) => { const shapes = patchSlideShape(queue.get(active).content.shapes, id, { text }); queue.edit(active, { shapes }, `text:${id}`); }} onTextBlur={() => queue.endGroup(active.id)}/>
                </div>
                <input ref={backgroundRef} type="color" value={/^#[0-9a-f]{6}$/i.test(draft.content.background) ? draft.content.background : "#ffffff"} disabled={!canEdit} onChange={(event) => { if (backgroundTarget.current === active.id && activePageRef.current === active.id && canEditRef.current && !pageActionCount.current) queue.edit(active, { background: event.target.value }); }} className="sr-only" aria-label="幻灯片背景颜色" />
              </div> : <div className="m-auto flex flex-col items-center gap-3 text-[13px] text-[#8f959e]"><ImageIcon size={32} strokeWidth={1.2}/><span>新建一页，开始制作幻灯片</span></div>}
            </div>
          </div>
          {active && draft && <div className="border-t border-[#e5e6eb] bg-white px-4 py-2"><textarea aria-label="演示者备注" value={draft.content.notes} readOnly={!canEdit} onChange={(event) => queue.edit(active, { notes: event.target.value }, "notes")} onBlur={() => queue.endGroup(active.id)} placeholder="点击添加演示者备注" className="h-14 w-full resize-y bg-transparent text-[13px] text-[#646a73] outline-none placeholder:text-[#a3aab3]" data-slide-history /></div>}
          <footer className="flex h-9 shrink-0 items-center justify-between border-t border-[#e5e6eb] bg-white px-4 text-[12px] text-[#8f959e]"><span>{active ? `${list.findIndex((page) => page.id === active.id) + 1} / ${list.length}` : "0 / 0"}</span><span className="hidden sm:inline">使用方向键切换放映页面</span></footer>
        </section>
      </div>
      {formatOpen && active && draft && <SlideFormatPanel key={active.id} background={draft.content.background} usedColors={list.map((page) => queue.get(page).content.background)} canEdit={canEdit} busy={pageActions > 0 || pages.isFetching || queue.hasUnsaved()} applying={backgroundApplying} onChange={(color) => { if (canEdit && !pageActionCount.current && activePageRef.current === active.id) queue.edit(active, { background: color }); }} onMore={() => { if (canEdit && activePageRef.current === active.id) { backgroundTarget.current = active.id; backgroundRef.current?.click(); } }} onApplyAll={() => void applyBackgroundToAll()} onClose={() => { setFormatOpen(false); backgroundButtonRef.current?.focus(); }}/>}
      </div>
      {pageMenu && (() => {
        const page = list.find((item) => item.id === pageMenu.id);
        if (!page) return null;
        const item = queue.get(page);
        return <div ref={pageMenuRef} role="menu" aria-label="幻灯片页面操作" onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const buttons = [...(pageMenuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
          if (!buttons.length) return;
          event.preventDefault();
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (current + 1) % buttons.length : (current + buttons.length - 1) % buttons.length;
          buttons[index].focus();
        }} className="fixed z-[70] w-[196px] rounded-lg border border-[#dee0e3] bg-white p-1 py-1.5 text-[13px] text-[#1f2329] shadow-[0_6px_24px_rgba(31,35,41,0.16)]" style={{ left: pageMenu.x, top: pageMenu.y }}>
          <button type="button" role="menuitem" disabled={!canEdit || item.state !== "saved" || insertPageUnknown || create.isPending || pageActions > 0} onClick={() => { setPageMenu(null); doInsert(page); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><FilePlus2 size={15}/>新建幻灯片 <span className="ml-auto text-[11px] text-[#8f959e]">Ctrl M</span></button>
          <button type="button" role="menuitem" disabled={!canEdit || item.state !== "saved" || copyPageUnknown || visibilityUnknown || pageActions > 0} onClick={() => { setPageMenu(null); doCopy(page); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><Copy size={15}/>复制幻灯片 <span className="ml-auto text-[11px] text-[#8f959e]">⌘/Ctrl D</span></button>
          <button type="button" role="menuitem" disabled={!canEdit || item.state !== "saved" || visibilityUnknown || pageActions > 0 || create.isPending} onClick={() => { setPageMenu(null); togglePageHidden(page); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><EyeOff size={15}/>{page.hidden ? "取消隐藏幻灯片" : "隐藏幻灯片"}</button>
          <div className="my-1 border-t border-[#e5e6eb]"/>
          <button type="button" role="menuitem" onClick={() => { setPageMenu(null); setFormatOpen(true); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5]"><Palette size={15}/>幻灯片背景</button>
          <div className="my-1 border-t border-[#e5e6eb]"/>
          <button type="button" role="menuitem" disabled={!canEdit || item.state !== "saved" || remove.isPending || pageActions > 0} onClick={async () => { setPageMenu(null); if (await ask("删除此页？", "删除后不可恢复。")) { if (canEditRef.current && queue.get(page).state === "saved") remove.mutate(page.id); } }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><Trash2 size={15}/>删除</button>
        </div>;
      })()}
      {sharing && <ShareDialog meta={meta.data} onClose={() => setSharing(false)} anchorRef={shareRef}/>}
    </main>
  );
}

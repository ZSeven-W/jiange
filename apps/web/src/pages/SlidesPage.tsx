import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, docsApi, slidesApi, type DocMeta, type SlidesPage as Page, type SlideShape } from "@/lib/api";
import { ShareDialog } from "@/components/ShareDialog";
import { ask } from "@/components/ui/ask";
import { cn } from "@/lib/utils";
import { createVisitRecorder } from "@/lib/recentVisit";
import { sameSlideContent, SlidesDraftQueue } from "./slidesDraft";
import { copyErrorMessage } from "./documentCopy";
import { SlideShapes } from "./slides-shapes";
import { PresenterView, SlideSurface } from "./slides-presenter";
import { SlideShapeControls } from "./slides-shape-controls";
import { patchSlideShape } from "./slides-shape-state";
import { clampSlideZoom, fitSlideZoom, parseSlideZoom, SLIDE_HEIGHT, SLIDE_WIDTH } from "./slides-zoom";
import { alignSlideShape, moveShapeOrder, type ShapeAlignment, type ShapeOrderAction } from "./slides-shape-order";
import { playableSlides, presentationStart, presentationKeyTarget } from "./slidesVisibility";
import { ResourceTypeNotice } from "./ResourceTypeNotice";
import { SlideFormatPanel } from "./SlideFormatPanel";
import { SlideNotesPanel } from "./SlideNotesPanel";
import { SlideDeckTitle, type SlideTitleDraft } from "./SlideDeckTitle";
import { readSlideTitleDraft, writeSlideTitleDraft } from "./slides-title-recovery";
import { SLIDE_SHAPES, SlideShapeGraphic } from "./slide-shape-catalog";
import { samePositions, slideDropIndex, slideEdgeScrollSpeed, slidePositions, verifySlideOrder, type SlidePosition } from "./slides-order";
import { applyBackgroundChangeReceipts, applyBackgroundReceipts } from "./slides-background";
import { validSlideDeleteReceipt } from "./slides-delete";
import { hasLargeSlideTitle, isBlankSlideLayout } from "./slides-layout";
import { SlideCreateLayoutPicker, slideCreatePickerPosition, type NewSlideLayout } from "./slides-create-layout";
import { planSlideLayout, slidePresetContent } from "./slides-layout-preset";
import { slidePageMenuPosition } from "./slides-page-menu";
import { encodeSlideClipboard, mayCopySlide, parseSlideClipboard, verifyCrossSlidePaste } from "./slides-clipboard";
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronsLeft, ChevronsRight, Clipboard, Copy, EyeOff, FilePlus2, GripHorizontal, ImageIcon, Maximize2, Minus, MoreHorizontal, Palette, Play, Plus, Presentation, Redo2, Trash2, Type, Shapes, Undo2 } from "lucide-react";

type BackgroundAction = { id: number; before: Page[]; after: Page[] };
type BackgroundHistory = { undo: BackgroundAction[]; redo: BackgroundAction[] };

function SlidesDraftRecovery({ queue }: { queue: SlidesDraftQueue }) {
  const drafts = queue.unsavedDrafts();
  if (!drafts.length) return null;
  return <details className="w-full max-w-2xl text-left"><summary className="cursor-pointer text-[13px] text-[#3370ff]">查看并复制未保存内容</summary>{drafts.map(({ page, content }) => <label key={page.id} className="mt-2 block text-[12px] text-[#646a73]">第 {page.pos} 页<textarea readOnly aria-label={`第 ${page.pos} 页未保存内容`} value={JSON.stringify(content, null, 2)} className="mt-1 block h-40 w-full rounded border border-[#dee0e3] bg-white p-2 font-mono text-[12px] text-[#1f2329]"/></label>)}</details>;
}

function SlideTitleRecovery({ draft }: { draft: SlideTitleDraft | null }) {
  return draft && <label className="block w-full text-left text-[12px] text-[#646a73]">未保存的名称（可复制）<input readOnly aria-label="未保存的幻灯片名称" value={draft.value} className="mt-1 block h-8 w-full rounded border border-[#dee0e3] bg-white px-2 text-[#1f2329]"/></label>;
}

/** Presentation editor. Drafts are kept locally while page writes are serialised. */
export function SlidesDeck({ deckId, userId }: { deckId: number; userId: number }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState<number | null>(null);
  const [titleDraft, setTitleDraft] = useState<SlideTitleDraft | null>(() => typeof sessionStorage === "undefined" ? null : readSlideTitleDraft(sessionStorage, userId, deckId));
  const titleSaving = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [audienceWindow, setAudienceWindow] = useState<Window | null>(null);
  const audienceRef = useRef<Window | null>(null);
  const audienceMountRef = useRef<HTMLElement | null>(null);
  const stopPresentation = () => { const popup = audienceRef.current; audienceRef.current = null; audienceMountRef.current = null; popup?.close(); setAudienceWindow(null); setPlaying(false); };
  const [checkingPlayback, setCheckingPlayback] = useState(false);
  const [playMenu, setPlayMenu] = useState(false);
  const playMenuRef = useRef<HTMLDivElement>(null);
  const playbackRef = useRef<HTMLDivElement>(null);
  const playbackCheck = useRef(false);
  const [sharing, setSharing] = useState(false);
  const [shapeMenu, setShapeMenu] = useState(false);
  const [shapeGroup, setShapeGroup] = useState<"基础" | "箭头">("基础");
  const shapeButtonRef = useRef<HTMLButtonElement>(null);
  const shapeMenuRef = useRef<HTMLDivElement>(null);
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
  const [orderUnknown, setOrderUnknown] = useState(false);
  const [dropMarker, setDropMarker] = useState<{ id: number; after: boolean } | null>(null);
  const dragPage = useRef<{ id: number; positions: SlidePosition[]; pointerId: number; x: number; y: number; currentX: number; currentY: number; moved: boolean } | null>(null);
  const slideListRef = useRef<HTMLDivElement>(null);
  const dragScrollFrame = useRef<number | null>(null);
  const suppressPageClick = useRef(false);
  const [pageMenu, setPageMenu] = useState<{ id: number; left: number; top: number; width: number; maxHeight: number } | null>(null);
  const [layoutPicker, setLayoutPicker] = useState<{ anchor: Page | null } | null>(null);
  const layoutPickerRef = useRef<HTMLDivElement>(null);
  const layoutTriggerRef = useRef<HTMLButtonElement>(null);
  const [copyPageUnknown, setCopyPageUnknown] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState("");
  const mounted = useRef(true);
  const canPasteRef = useRef(false);
  const canCopyRef = useRef(false);
  useEffect(() => { if (!clipboardNotice) return; const timer = window.setTimeout(() => setClipboardNotice(""), 3000); return () => window.clearTimeout(timer); }, [clipboardNotice]);
  const [insertPageUnknown, setInsertPageUnknown] = useState(false);
  const [visibilityUnknown, setVisibilityUnknown] = useState(false);
  const [deletePageUnknown, setDeletePageUnknown] = useState(false);
  const deletingPage = useRef(false);
  const insertingPage = useRef(false);
  const pageMenuRef = useRef<HTMLDivElement>(null);
  const pageActionCount = useRef(0);
  const copyRequest = useRef<AbortController | null>(null);
  const [selectedShape, setSelectedShape] = useState<string | null>(null);
  const [titleFocusPage, setTitleFocusPage] = useState<number | null>(null);
  const [bodyFocusPage, setBodyFocusPage] = useState<number | null>(null);
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
  useEffect(() => { if (meta.data?.kind === "slides") document.title = `${meta.data.title.trim() || "未命名幻灯片"} - Jiange`; }, [meta.data?.kind, meta.data?.title]);
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
  const canEdit = !copyingDeck && !checkingPlayback && !backgroundBatchUnknown && !deletePageUnknown && pageActions === 0 && !meta.isError && !meta.isFetching && meta.data?.kind === "slides" && (meta.data.role === "edit" || meta.data.role === "manage");
  // An already-authorized user may continue typing locally during a refresh;
  // no new writes leave the queue until the refreshed permission is known.
  const canDraft = !copyingDeck && !checkingPlayback && !backgroundBatchUnknown && !deletePageUnknown && pageActions === 0 && !meta.isError && meta.data?.kind === "slides" && (meta.data.role === "edit" || meta.data.role === "manage");
  const mayWrite = useRef(false);
  mayWrite.current = !meta.isError && !meta.isFetching && meta.data?.kind === "slides" && (meta.data.role === "edit" || meta.data.role === "manage");
  const pages = useQuery({ queryKey: ["slides", deckId, userId], queryFn: () => slidesApi.pages(deckId, userId), enabled: meta.data?.kind === "slides" && !meta.isError, refetchInterval: 5000, refetchIntervalInBackground: false });
  const queue = useMemo(() => new SlidesDraftQueue(
    (page, content) => slidesApi.update(deckId, page.id, userId, content.title, content.body, content.background, content.layout ?? "", page.revision, content.notes, content.shapes),
    (saved) => qc.setQueryData<Page[]>(["slides", deckId, userId], (old) => old?.map((item) => item.id === saved.id && item.revision <= saved.revision ? saved : item)),
    () => setDraftVersion((version) => version + 1),
    () => setBackgroundHistory((history) => history.redo.length ? { ...history, redo: [] } : history),
    () => mayWrite.current,
  ), [deckId, userId, qc]);
  useEffect(() => { if (mayWrite.current) queue.resumePending(); }, [queue, meta.isFetching, meta.isError, meta.data?.kind, meta.data?.role]);
  useEffect(() => () => queue.dispose(), [queue]);
  useEffect(() => () => { if (dragScrollFrame.current !== null) cancelAnimationFrame(dragScrollFrame.current); }, []);
  useEffect(() => () => { audienceRef.current?.close(); audienceRef.current = null; }, []);
  useEffect(() => {
    if (!audienceWindow) return;
    const lost = () => { if (audienceRef.current !== audienceWindow) return; audienceRef.current = null; audienceMountRef.current = null; setAudienceWindow(null); setPlaying(false); setOperationError("观众窗口已关闭或离开，演示已结束。"); };
    const timer = window.setInterval(() => { if (audienceWindow.closed) lost(); }, 500);
    audienceWindow.addEventListener("pagehide", lost);
    return () => { window.clearInterval(timer); audienceWindow.removeEventListener("pagehide", lost); };
  }, [audienceWindow]);
  useEffect(() => () => { imageUpload.current?.abort(); imageUpload.current = null; }, []);
  useEffect(() => () => { copyRequest.current?.abort(); copyRequest.current = null; }, []);
  useEffect(() => {
    if (!shapeMenu) return;
    const outside = (event: PointerEvent) => { if (!shapeMenuRef.current?.contains(event.target as Node) && !shapeButtonRef.current?.contains(event.target as Node)) setShapeMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setShapeMenu(false); shapeButtonRef.current?.focus(); } };
    const close = () => setShapeMenu(false);
    const scroll = (event: Event) => { if (!shapeMenuRef.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape); window.addEventListener("resize", close); window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("resize", close); window.removeEventListener("scroll", scroll, true); };
  }, [shapeMenu]);
  useEffect(() => {
    if (!pageMenu) return;
    const preferred = pageMenuRef.current?.querySelector<HTMLButtonElement>("[data-page-menu-default]:not([disabled])");
    (preferred ?? pageMenuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])"))?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!pageMenuRef.current?.contains(event.target as Node)) setPageMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setPageMenu(null); document.querySelector<HTMLButtonElement>(`[data-slide-options="${pageMenu.id}"]`)?.focus({ preventScroll: true }); } };
    const resize = () => setPageMenu(null);
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape); window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("resize", resize); };
  }, [pageMenu]);
  useEffect(() => {
    if (!pageMenu || document.activeElement !== document.body) return;
    pageMenuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus({ preventScroll: true });
  }, [pageMenu, canEdit]);
  useEffect(() => {
    if (!playMenu) return;
    const outside = (event: PointerEvent) => { if (!playMenuRef.current?.contains(event.target as Node)) setPlayMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setPlayMenu(false); playMenuRef.current?.querySelector<HTMLButtonElement>("[aria-haspopup]")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [playMenu]);
  useEffect(() => { if (playing) playbackRef.current?.focus(); }, [playing]);
  useEffect(() => {
    if (playing && (meta.isError || pages.isError || (meta.data && meta.data.kind !== "slides"))) {
      stopPresentation();
      setOperationError("无法确认演示文稿的访问状态，演示已结束。");
    }
  }, [playing, meta.isError, pages.isError, meta.data?.kind]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (queue.hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (titleDraft && (titleDraft.phase !== "editing" || titleDraft.value !== titleDraft.base.title)) { event.preventDefault(); event.returnValue = ""; } };
    if (typeof sessionStorage !== "undefined") writeSlideTitleDraft(sessionStorage, userId, deckId, titleDraft);
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [titleDraft, userId, deckId]);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["slides", deckId, userId] });
  // 整份复制只携带已保存内容；未保存草稿先行保存完成后才可点击。
  const duplicateDeck = async () => {
    if (!meta.data || backgroundBatchUnknown || deletePageUnknown || copyRequest.current || queue.hasUnsaved() || uploadingImage || create.isPending || remove.isPending || pageActionCount.current > 0) return;
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
    mutationFn: async ({ anchor, layout }: { anchor: Page | null; layout: NewSlideLayout }) => {
      const source = anchor ? queue.get(anchor) : null;
      if (source && source.state !== "saved") throw new ApiError(409, "conflict", "请等待当前页面保存完成。 ");
      const page = await slidesApi.insertPage(deckId, userId, anchor?.id ?? 0, source?.page.revision ?? 0, layout);
      if (!page || !Number.isSafeInteger(page.id) || page.id <= 0 || page.id === anchor?.id || page.slidesId !== deckId || page.revision !== 1 || page.hidden !== false || !Array.isArray(page.shapes) || !sameSlideContent(slidePresetContent(layout), page)) throw new Error("invalid new page response");
      return { page, anchorId: anchor?.id ?? null };
    },
    onSuccess: ({ page, anchorId }) => { if (activePageRef.current === anchorId) { setCurrent(page.id); setSelectedShape(null); } void invalidate(); },
    onError: (error, variables) => {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (!known) setInsertPageUnknown(true);
      setOperationError(known ? error.status === 409 ? "页面已变化或页面顺序空间不足，请刷新后重试。" : variables.layout && (error.status === 426 || (error.status === 400 && (error.code === "bad_request" || variables.layout === "two-column" && error.code === "invalid_layout"))) ? "所选布局需要新版服务，请升级后重试。" : error.message : "新建结果未能确认，请重新打开并检查页面列表后再操作。");
      void invalidate();
    },
    onSettled: () => { insertingPage.current = false; },
  });
  const remove = useMutation({
    mutationFn: async (page: Page) => {
      const receipt = await slidesApi.removeVersion(deckId, page.id, userId, page.revision);
      if (page.slidesId !== deckId || !validSlideDeleteReceipt(receipt, page)) throw new Error("invalid delete receipt");
      return page;
    },
    onSuccess: (page) => {
      const key = ["slides", deckId, userId];
      const before = qc.getQueryData<Page[]>(key) ?? [];
      const index = before.findIndex((item) => item.id === page.id);
      const next = index < 0 ? undefined : before[index + 1] ?? before[index - 1];
      qc.setQueryData<Page[]>(key, (old) => old?.filter((item) => item.id !== page.id));
      if (activePageRef.current === page.id) { activePageRef.current = next?.id ?? null; setCurrent(next?.id ?? null); setSelectedShape(null); }
      void invalidate();
    },
    onError: (error) => {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (!known) setDeletePageUnknown(true);
      setOperationError(known ? error.status === 409 ? "页面已被修改，未删除；请刷新后核对。" : error.status === 404 || error.status === 405 ? "页面不存在或服务端不支持安全删除，请刷新并确认版本。" : error.message : "删除结果未确认，请重新打开并检查页面后再编辑。");
      void invalidate();
    },
    onSettled: () => { deletingPage.current = false; endPageAction(); },
  });
  const [operationError, setOperationError] = useState("");
  const list = pages.data ?? [];
  const active = list.find((page) => page.id === current) ?? list[0] ?? null;
  const playable = playableSlides(list);
  const playbackPage = playing ? playable.find((page) => page.id === active?.id) ?? playable[0] ?? null : null;
  const playbackDraft = playbackPage ? queue.get(playbackPage) : null;
  activePageRef.current = active?.id ?? null;
  canEditRef.current = canEdit;
  const draft = active ? queue.get(active) : null;
  const canInsert = canEdit && pages.isSuccess && !create.isPending && !remove.isPending && pageActions === 0 && !insertPageUnknown && (!active || draft?.state === "saved");
  canPasteRef.current = canEdit && pages.isSuccess && !pages.isError && !copyPageUnknown && !visibilityUnknown && !insertPageUnknown && !queue.hasUnsaved() && !create.isPending && !remove.isPending && pageActions === 0;
  canCopyRef.current = !meta.isError && !meta.isFetching && mayCopySlide(meta.data) && pages.isSuccess && !pages.isError && !queue.hasUnsaved() && pageActions === 0;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!layoutPicker) return;
    const focus = requestAnimationFrame(() => { if (document.activeElement === layoutTriggerRef.current) layoutPickerRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); });
    const outside = (event: PointerEvent) => { if (!layoutPickerRef.current?.contains(event.target as Node) && !layoutTriggerRef.current?.contains(event.target as Node)) setLayoutPicker(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setLayoutPicker(null); layoutTriggerRef.current?.focus(); } };
    const close = () => setLayoutPicker(null);
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape); window.addEventListener("resize", close);
    return () => { cancelAnimationFrame(focus); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("resize", close); };
  }, [layoutPicker]);
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
      if (event.key === "Escape") { event.preventDefault(); stopPresentation(); return; }
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !playbackPage) return;
      // Let focused buttons retain their native Enter/Space activation.
      if ((event.key === " " || event.key === "Enter") && event.target instanceof HTMLElement && event.target.closest("button")) return;
      const next = presentationKeyTarget(list, playbackPage.id, event.key);
      if (next) { event.preventDefault(); setCurrent(next.id); }
    };
    window.addEventListener("keydown", onKey);
    audienceWindow?.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); audienceWindow?.removeEventListener("keydown", onKey); };
  }, [playing, playbackPage, list, audienceWindow]);

  if (meta.isPending) return <div className="grid flex-1 place-items-center text-[13px] text-subtle">正在打开演示文稿…</div>;
  if (meta.isError || !meta.data || pages.isError) return <div className="grid flex-1 place-items-center text-[13px] text-subtle"><div className="flex max-w-md flex-col items-center gap-3 px-4 text-center"><p>{pages.error instanceof ApiError && pages.error.status === 426 ? pages.error.message : "无法访问该演示文稿，请确认权限后重试。"}</p>{queue.hasUnsaved() && <p role="alert">当前页面有未保存内容，请勿刷新或关闭；恢复网络及权限后重试。</p>}<SlidesDraftRecovery queue={queue}/><SlideTitleRecovery draft={titleDraft}/><button type="button" onClick={() => { void meta.refetch(); void pages.refetch(); }} className="rounded-md border px-3 py-1.5 text-foreground hover:bg-hover">重试</button></div></div>;
  if (meta.data.kind !== "slides") return <ResourceTypeNotice id={deckId} kind={meta.data.kind} verified={!meta.isFetching} blockNavigation={queue.hasUnsaved() || !!titleDraft}>{queue.hasUnsaved() && <><p role="alert" className="mt-3 text-[13px] text-red-600">当前演示文稿有未保存内容，请勿刷新或关闭；恢复文件类型和权限后重试。</p><SlidesDraftRecovery queue={queue}/></>}<SlideTitleRecovery draft={titleDraft}/></ResourceTypeNotice>;

  if (playing && (!playbackPage || !playbackDraft)) return <div className="fixed inset-0 z-[80] grid place-items-center bg-[#1f2329] text-white"><div className="text-center"><p>没有可放映的幻灯片</p><button type="button" onClick={stopPresentation} className="mt-4 rounded border px-3 py-1">退出放映</button></div></div>;
  if (playing && playbackPage && playbackDraft) return (
    <div ref={playbackRef} tabIndex={-1} aria-label={audienceWindow ? "演示者视图" : "幻灯片放映"} className="fixed inset-0 z-[80] outline-none" data-slides-playing>
      {audienceWindow ? <>
        <PresenterView pages={playable} currentId={playbackPage.id} content={playbackDraft.content} contentFor={(page) => queue.get(page).content} onSelect={setCurrent} onExit={stopPresentation}/>
        {createPortal(<div aria-label="观众视图" className="flex h-dvh items-center justify-center bg-black"><div className="w-full" style={{ width: "min(100vw, calc(100dvh * 16 / 9))" }}><SlideSurface content={playbackDraft.content}/></div></div>, audienceMountRef.current!)}
      </> : <div className="flex h-full flex-col items-center justify-center bg-[#1f2329] p-4 sm:p-10">
        <div className="w-full max-w-[1280px] shrink-0" style={{ width: "min(100%, calc((100dvh - 6rem) * 16 / 9))" }}><SlideSurface content={playbackDraft.content}/></div>
        <div className="absolute bottom-3 flex items-center gap-3 rounded-lg bg-black/60 px-3 py-2 text-[13px] text-white"><button type="button" disabled={playable.findIndex((page) => page.id === playbackPage.id) <= 0} onClick={() => { const i = playable.findIndex((page) => page.id === playbackPage.id); if (i > 0) setCurrent(playable[i - 1].id); }} className="disabled:opacity-40">上一页</button><span>{playable.findIndex((page) => page.id === playbackPage.id) + 1} / {playable.length}</span><button type="button" disabled={playable.findIndex((page) => page.id === playbackPage.id) >= playable.length - 1} onClick={() => { const i = playable.findIndex((page) => page.id === playbackPage.id); if (i < playable.length - 1) setCurrent(playable[i + 1].id); }} className="disabled:opacity-40">下一页</button><button type="button" onClick={stopPresentation}>退出放映</button></div>
      </div>}
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
  const startPresentation = async (fromBeginning = false, presenter = false) => {
    if (playbackCheck.current || visibilityUnknown || backgroundBatchUnknown || deletePageUnknown || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) return;
    let popup: Window | null = null;
    if (presenter) {
      try { popup = window.open("", "_blank", "popup,width=1024,height=720"); } catch { popup = null; }
      if (!popup) { setOperationError("无法打开观众窗口，请允许此网站弹出窗口后重试。"); return; }
      try {
        popup.document.title = "观众视图 - Jiange";
        popup.document.documentElement.lang = document.documentElement.lang;
        for (const style of document.head.querySelectorAll('style, link[rel="stylesheet"]')) popup.document.head.append(style.cloneNode(true));
        popup.document.body.className = "m-0";
        popup.document.body.textContent = "正在准备观众视图…";
        audienceMountRef.current = popup.document.body;
        popup.opener = null;
        audienceRef.current = popup;
      } catch { popup.close(); setOperationError("无法准备观众窗口，请重试。"); return; }
    }
    playbackCheck.current = true; setCheckingPlayback(true); setOperationError("");
    let started = false;
    try {
      const result = await pages.refetch();
      if (result.isError || !result.data) { setOperationError("无法确认最新页面状态，请联网后重试放映。"); return; }
      const start = presentationStart(result.data, fromBeginning ? null : activePageRef.current);
      if (!start) { setOperationError("没有可放映的幻灯片。"); return; }
      if (popup) {
        try {
          if (popup.closed || popup.document !== audienceMountRef.current?.ownerDocument) { setOperationError("观众窗口已关闭或离开，请重新开始演示。"); return; }
          audienceMountRef.current.replaceChildren();
        } catch { setOperationError("无法访问观众窗口，请重新开始演示。"); return; }
      }
      setCurrent(start.id); setAudienceWindow(popup); setPlaying(true); started = true;
    } finally { if (!started && popup) { if (audienceRef.current === popup) { audienceRef.current = null; audienceMountRef.current = null; } popup.close(); } playbackCheck.current = false; setCheckingPlayback(false); }
  };
  const doMove = (page: Page, to: number, snapshot = slidePositions(list)) => {
    if (!canEdit || orderUnknown || !pages.isSuccess || pages.isFetching || queue.hasUnsaved() || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) return;
    const latest = qc.getQueryData<Page[]>(["slides", deckId, userId]);
    if (!latest || !samePositions(snapshot, slidePositions(latest))) { setOperationError("页面顺序已变化，请核对后重新操作。"); void invalidate(); return; }
    const from = snapshot.findIndex((item) => item.id === page.id);
    if (from < 0 || to < 0 || to >= snapshot.length || from === to) return;
    setOperationError(""); beginPageAction();
    void slidesApi.reorder(deckId, userId, snapshot, page.id, to).then((response) => {
      const result = verifySlideOrder(snapshot, page.id, to, response?.positions);
      if (!result) throw new Error("invalid order receipt");
      const positions = new Map(result.map((item) => [item.id, item.pos]));
      qc.setQueryData<Page[]>(["slides", deckId, userId], (old) => old && samePositions(snapshot, slidePositions(old)) ? [...old].map((item) => ({ ...item, pos: positions.get(item.id)! })).sort((a, b) => a.pos - b.pos) : old);
      void invalidate();
    }).catch((error) => {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (!known) setOrderUnknown(true);
      setOperationError(known ? error.status === 409 ? "页面顺序已变化，请核对后重新操作。" : error.status === 404 || error.status === 405 ? "服务端不支持安全排序，请升级后重试。" : error.message : "排序结果未确认，请重新打开并检查页面顺序。");
      void invalidate();
    }).finally(endPageAction);
  };
  const stopPageDrag = () => {
    dragPage.current = null;
    setDropMarker(null);
    if (dragScrollFrame.current !== null) cancelAnimationFrame(dragScrollFrame.current);
    dragScrollFrame.current = null;
  };
  const pageAtPointer = (x: number, y: number, positions: readonly SlidePosition[]) => {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-slides-page]");
    const id = Number(target?.dataset.slidesPage);
    if (!target || !slideListRef.current?.contains(target) || !positions.some((item) => item.id === id)) return null;
    const rect = target.getBoundingClientRect();
    return { id, after: y >= rect.top + rect.height / 2 };
  };
  const beginPageDrag = (event: React.PointerEvent<HTMLButtonElement>, page: Page, handle: boolean) => {
    if ((!handle && event.pointerType !== "mouse") || event.button !== 0 || dragPage.current || !canEdit || orderUnknown || queue.hasUnsaved()) return;
    if (handle) event.preventDefault();
    dragPage.current = { id: page.id, positions: slidePositions(list), pointerId: event.pointerId, x: event.clientX, y: event.clientY, currentX: event.clientX, currentY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePageDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragPage.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.currentX = event.clientX; drag.currentY = event.clientY;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
    drag.moved = true;
    setDropMarker(pageAtPointer(event.clientX, event.clientY, drag.positions));
    if (dragScrollFrame.current !== null) return;
    const scroll = () => {
      const activeDrag = dragPage.current, container = slideListRef.current;
      if (!activeDrag?.moved || !container) { dragScrollFrame.current = null; return; }
      const rect = container.getBoundingClientRect(), y = activeDrag.currentY;
      const speed = slideEdgeScrollSpeed(rect, activeDrag.currentX, y);
      if (speed) { container.scrollTop += speed; setDropMarker(pageAtPointer(activeDrag.currentX, y, activeDrag.positions)); }
      dragScrollFrame.current = requestAnimationFrame(scroll);
    };
    dragScrollFrame.current = requestAnimationFrame(scroll);
  };
  const endPageDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragPage.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = drag.moved ? pageAtPointer(event.clientX, event.clientY, drag.positions) : null;
    stopPageDrag();
    if (!drag.moved) return;
    suppressPageClick.current = true;
    window.setTimeout(() => { suppressPageClick.current = false; }, 0);
    const from = drag.positions.findIndex((item) => item.id === drag.id), index = drag.positions.findIndex((item) => item.id === target?.id), sourcePage = list.find((item) => item.id === drag.id);
    if (target && from >= 0 && index >= 0 && sourcePage) doMove(sourcePage, slideDropIndex(from, index, target.after), drag.positions);
  };
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
  const doInsert = (anchor: Page | null, layout: NewSlideLayout = "") => {
    if (!canEdit || !pages.isSuccess || pages.isError || insertPageUnknown || insertingPage.current || create.isPending || remove.isPending || pageActionCount.current || (anchor && queue.get(anchor).state !== "saved")) return;
    setOperationError("");
    if (anchor && activePageRef.current !== anchor.id) { activePageRef.current = anchor.id; setCurrent(anchor.id); setSelectedShape(null); }
    insertingPage.current = true;
    create.mutate({ anchor, layout });
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
  const clipboardReference = (page: Page): string | null => {
    const source = queue.get(page);
    if (!canCopyRef.current || pageActionCount.current || source.state !== "saved") return null;
    return encodeSlideClipboard({ origin: location.origin, userId, deckId, pageId: source.page.id, revision: source.page.revision });
  };
  const copyToClipboard = async (page: Page) => {
    const text = clipboardReference(page);
    if (!text || !navigator.clipboard?.writeText) { setOperationError("暂时无法复制页面，请确认权限和保存状态。"); return; }
    try { await navigator.clipboard.writeText(text); if (mounted.current) { setOperationError(""); setClipboardNotice("已复制幻灯片，可粘贴到其他演示文稿。"); } }
    catch { if (mounted.current) setOperationError("无法访问剪贴板，请选中页面后使用复制快捷键。"); }
  };
  const pasteReference = async (text: string, anchorId: number) => {
    if (!mounted.current || !canPasteRef.current || pageActionCount.current || insertingPage.current || activePageRef.current !== anchorId) return;
    const clip = parseSlideClipboard(text);
    if (!clip || clip.origin !== location.origin || clip.userId !== userId) { setOperationError("请选择本账号在当前站点复制的幻灯片。"); return; }
    const current = qc.getQueryData<Page[]>(["slides", deckId, userId]);
    const anchorPage = current?.find((page) => page.id === anchorId);
    if (!anchorPage) { setOperationError("粘贴位置已不存在，请重新选择。"); return; }
    const anchor = queue.get(anchorPage);
    if (anchor.state !== "saved") { setOperationError("粘贴位置尚未保存，请稍后重试。"); return; }
    setOperationError(""); setClipboardNotice(""); beginPageAction();
    let sent = false;
    try {
      let source: Page | undefined;
      if (clip.deckId === deckId) {
        const sourcePage = current?.find((page) => page.id === clip.pageId);
        if (sourcePage) { const sourceDraft = queue.get(sourcePage); if (sourceDraft.state === "saved") source = sourceDraft.page; }
      } else {
        source = (await slidesApi.pages(clip.deckId, userId)).find((page) => page.id === clip.pageId);
      }
      if (!source || source.slidesId !== clip.deckId || source.revision !== clip.revision) throw new ApiError(409, "conflict", "来源页面已变化，请重新复制。");
      if (!mounted.current) return;
      const latestAnchor = qc.getQueryData<Page[]>(["slides", deckId, userId])?.find((page) => page.id === anchorId);
      if (!mayWrite.current || activePageRef.current !== anchorId || !latestAnchor || queue.get(latestAnchor).state !== "saved" || queue.get(latestAnchor).page.revision !== anchor.page.revision) throw new ApiError(409, "conflict", "粘贴位置或权限已变化，请重试。");
      sent = true;
      let saved: Page | null;
      if (clip.deckId === deckId) {
        const result = await slidesApi.pastePage(deckId, userId, source.id, source.revision, anchor.page.id, anchor.page.revision);
        saved = result && Number.isSafeInteger(result.id) && result.id > 0 && result.id !== source.id && result.slidesId === deckId && result.revision === 1 && result.hidden === source.hidden && Number.isFinite(result.pos) && Array.isArray(result.shapes) && sameSlideContent(source, result) ? result : null;
      } else {
        const result = await slidesApi.pastePageFrom(deckId, userId, clip.deckId, source.id, source.revision, anchor.page.id, anchor.page.revision);
        saved = verifyCrossSlidePaste(source, deckId, result);
      }
      if (!saved) throw new Error("invalid paste response");
      if (mounted.current && activePageRef.current === anchorId) setCurrent(saved.id);
      if (mounted.current) void invalidate();
    } catch (error) {
      if (!mounted.current) return;
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (sent && !known) setCopyPageUnknown(true);
      setOperationError(known ? error.status === 409 ? error.message : error.status === 404 || error.status === 405 || error.status === 426 ? "来源页面不可用或服务端不支持跨文稿粘贴。" : error.message : sent ? "粘贴结果未确认，请重新打开并检查页面列表。" : "无法读取来源页面，未粘贴任何内容。");
      void invalidate();
    } finally { endPageAction(); }
  };
  const pasteFromClipboard = async (page: Page) => {
    if (!navigator.clipboard?.readText) { setOperationError("无法读取剪贴板，请选中页面后使用粘贴快捷键。"); return; }
    try { const text = await navigator.clipboard.readText(); void pasteReference(text, page.id); }
    catch { if (mounted.current) setOperationError("无法读取剪贴板，请选中页面后使用粘贴快捷键。"); }
  };
  const doRemove = async (page: Page) => {
    const source = queue.get(page);
    if (!canEdit || source.state !== "saved" || deletingPage.current || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) return;
    const version = source.page.revision, content = source.content;
    if (!await ask("删除此页？", "删除后不可恢复。")) return;
    const latest = qc.getQueryData<Page[]>(["slides", deckId, userId])?.find((item) => item.id === page.id);
    if (!canEditRef.current || activePageRef.current !== page.id || !latest || latest.revision !== version || deletingPage.current || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) { setOperationError("页面或编辑状态已变化，请核对后重新操作。"); return; }
    const current = queue.get(latest);
    if (current.state !== "saved" || current.page.revision !== version || !sameSlideContent(current.content, content)) { setOperationError("页面已变化，请核对后重新操作。"); return; }
    setOperationError(""); deletingPage.current = true; beginPageAction(); remove.mutate(current.page);
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
    setPageMenu({ id: page.id, ...slidePageMenuPosition(x, y, window.innerWidth, window.innerHeight) });
  };
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#f5f6f7]" data-slides-editor>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-white pl-14 pr-3 md:px-5">
        <button type="button" onClick={() => { location.hash = "#/drive/mine"; }} aria-label="返回云盘" className="grid size-8 shrink-0 place-items-center rounded-md text-[#646a73] hover:bg-[#f2f3f5]"><ChevronLeft size={17}/></button>
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-[#ff8800] text-white"><Presentation size={15}/></span>
        <div className="min-w-0"><SlideDeckTitle meta={meta.data} userId={userId} verified={!meta.isFetching && !meta.isError} draft={titleDraft} setDraft={setTitleDraft} busy={titleSaving} onSaved={(base, entry) => { qc.setQueryData<DocMeta>(["slides-meta", deckId, userId], (current) => current && current.id === entry.id && current.driveRevision === base.revision && current.title === base.title ? { ...current, title: entry.title, driveRevision: entry.revision, updatedAt: entry.updatedAt } : current); void qc.invalidateQueries({ queryKey: ["slides-meta", deckId, userId] }); void qc.invalidateQueries({ queryKey: ["docs"] }); void qc.invalidateQueries({ queryKey: ["drive"] }); void qc.invalidateQueries({ queryKey: ["recent"] }); }}/><div className="text-[11px] text-[#8f959e]">{titleDraft?.phase === "saving" || draft?.state === "saving" ? "正在保存…" : titleDraft?.phase === "unknown" ? "名称保存未确认" : titleDraft && titleDraft.value !== titleDraft.base.title ? "名称未保存" : draft?.state === "saved" ? "已保存" : draft ? "有未保存内容" : "演示文稿"}</div></div>
        <div className={cn("ml-auto flex shrink-0 items-center gap-2", titleDraft && "hidden sm:flex")}>
          <button type="button" aria-label="创建整份幻灯片副本" title={backgroundBatchUnknown || deletePageUnknown ? "请先重新打开并核对页面" : queue.hasUnsaved() ? "请先等待内容保存" : "创建副本"} disabled={backgroundBatchUnknown || deletePageUnknown || copyingDeck || queue.hasUnsaved() || uploadingImage || create.isPending || remove.isPending || pageActions > 0} onClick={() => void duplicateDeck()} className="grid size-8 shrink-0 place-items-center rounded-md border border-[#d0d3d6] text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-40" data-slides-copy>{copyingDeck ? <span className="text-[11px]">…</span> : <Copy size={14}/>}</button>
          <button ref={shareRef} type="button" onClick={() => setSharing(true)} className="h-8 rounded-md bg-[#3370ff] px-2 text-[13px] font-medium text-white hover:bg-[#245bdb] sm:px-3">分享</button>
          <div ref={playMenuRef} className="relative flex h-8 rounded-md border border-[#3370ff] text-[#3370ff]">
            <button type="button" disabled={!playable.length || visibilityUnknown || backgroundBatchUnknown || deletePageUnknown || checkingPlayback || pageActions > 0 || create.isPending || remove.isPending} title="从当前页开始演示" onClick={() => { setPlayMenu(false); void startPresentation(); }} className="flex items-center gap-1 rounded-l-md bg-white px-3 text-[13px] hover:bg-[#f5f6f7] disabled:opacity-40"><Play size={13}/>{checkingPlayback ? "检查中…" : "演示"}</button>
            <button type="button" aria-label="演示选项" aria-haspopup="menu" aria-expanded={playMenu} disabled={!playable.length || visibilityUnknown || backgroundBatchUnknown || deletePageUnknown || checkingPlayback || pageActions > 0 || create.isPending || remove.isPending} onClick={() => setPlayMenu((open) => !open)} className="grid w-7 place-items-center rounded-r-md border-l border-[#3370ff] bg-white hover:bg-[#f5f6f7] disabled:opacity-40"><ChevronDown size={14}/></button>
            {playMenu && <div role="menu" aria-label="演示选项" className="absolute right-0 top-10 z-[70] w-40 rounded-lg border border-[#dee0e3] bg-white p-1 text-[13px] text-[#1f2329] shadow-lg"><button role="menuitem" type="button" onClick={() => { setPlayMenu(false); void startPresentation(); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5]"><Play size={14}/>从当前开始</button><button role="menuitem" type="button" onClick={() => { setPlayMenu(false); void startPresentation(false, true); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5]"><Presentation size={14}/>演示者视图</button><button role="menuitem" type="button" onClick={() => { setPlayMenu(false); void startPresentation(true); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5]"><Presentation size={14}/>从头开始</button></div>}
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1">
        {showSlideList ? <aside className="flex w-[104px] shrink-0 flex-col border-r border-[#dee0e3] bg-white sm:w-[196px]" data-slides-list onCopy={(event) => { const row = (event.target as HTMLElement).closest<HTMLElement>("[data-slides-page]"); const page = list.find((item) => item.id === Number(row?.dataset.slidesPage)); const text = page && clipboardReference(page); if (!text) return; event.preventDefault(); event.clipboardData.setData("text/plain", text); setOperationError(""); setClipboardNotice("已复制幻灯片，可粘贴到其他演示文稿。"); }} onPaste={(event) => { const row = (event.target as HTMLElement).closest<HTMLElement>("[data-slides-page]"); const page = list.find((item) => item.id === Number(row?.dataset.slidesPage)); if (!page) return; const text = event.clipboardData.getData("text/plain"); if (!parseSlideClipboard(text)) return; event.preventDefault(); pasteReference(text, page.id); }}>
          <div className="flex h-14 items-center gap-1 px-2 sm:px-3"><div className="flex h-8 min-w-0 flex-1 rounded-md border border-[#d0d3d6] bg-white"><button type="button" aria-label="新建幻灯片" title="新建幻灯片" disabled={!canInsert} onClick={() => doInsert(active)} className="flex min-w-0 flex-1 items-center justify-center gap-1 rounded-l-md text-[12px] text-[#1f2329] hover:bg-[#f5f6f7] disabled:opacity-40"><FilePlus2 size={14} className="shrink-0"/><span className="hidden whitespace-nowrap sm:inline">新建幻灯片</span></button><button ref={layoutTriggerRef} type="button" disabled={!canInsert} aria-label="选择布局新建幻灯片" aria-haspopup="dialog" aria-expanded={!!layoutPicker} onClick={() => setLayoutPicker((open) => open ? null : { anchor: active })} className="grid w-7 shrink-0 place-items-center rounded-r-md border-l border-[#d0d3d6] text-[#646a73] hover:bg-[#f5f6f7] disabled:opacity-40"><ChevronDown size={14}/></button></div><button type="button" aria-label="收起幻灯片列表" onClick={() => { setLayoutPicker(null); setShowSlideList(false); }} className="grid size-7 shrink-0 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><ChevronsLeft size={15}/></button></div>
          {layoutPicker && layoutTriggerRef.current && createPortal(<div ref={layoutPickerRef} role="dialog" aria-label="选择布局新建" style={slideCreatePickerPosition(layoutTriggerRef.current.getBoundingClientRect(), window.innerWidth, window.innerHeight)} className="fixed z-[100] overflow-auto rounded-lg border border-[#dee0e3] bg-white shadow-[0_6px_24px_rgba(31,35,41,0.16)]"><SlideCreateLayoutPicker onSelect={(layout) => { const anchor = layoutPicker.anchor; setLayoutPicker(null); if (!canInsert || (anchor?.id ?? null) !== (active?.id ?? null) || (anchor && (!active || queue.get(active).page.revision !== anchor.revision))) { setOperationError("当前页面已变化，请重新选择布局。"); return; } doInsert(anchor, layout); }}/></div>, document.body)}
          <div ref={slideListRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-4">
            {list.map((page, index) => {
              const item = queue.get(page);
              return <div key={page.id} className={cn("group relative mb-6 flex gap-1 sm:mb-0 [@media(pointer:coarse)]:mb-6", dropMarker?.id === page.id && (dropMarker.after ? "after:absolute after:-bottom-1 after:left-5 after:right-0 after:h-0.5 after:bg-[#3370ff]" : "before:absolute before:-top-1 before:left-5 before:right-0 before:h-0.5 before:bg-[#3370ff]"))} data-slides-page={page.id} onContextMenu={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openPageMenu(page, event.clientX || rect.left, event.clientY || rect.bottom); }}>
                <span className={cn("w-4 pt-1 text-right text-[11px] text-[#8f959e]", page.hidden && "line-through")}>{index + 1}</span>
                <button type="button" draggable={false} onPointerDown={(event) => beginPageDrag(event, page, false)} onPointerMove={movePageDrag} onPointerUp={endPageDrag} onPointerCancel={stopPageDrag} onLostPointerCapture={() => { if (dragPage.current) stopPageDrag(); }} onClick={() => { if (suppressPageClick.current) return; activePageRef.current = page.id; setCurrent(page.id); setSelectedShape(null); }} onKeyDown={(event) => { if (!event.shiftKey && !event.altKey && event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "m") { event.preventDefault(); doInsert(page); } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "d") { event.preventDefault(); doCopy(page); } }} aria-label={`第 ${index + 1} 页 ${item.content.title || "未命名"}${page.hidden ? "，已隐藏" : ""}`} className={cn("relative aspect-video min-w-0 flex-1 overflow-hidden rounded-[4px] border-2 bg-white text-left shadow-sm", active?.id === page.id ? "border-[#3370ff]" : "border-transparent hover:border-[#c8d4f4]")} style={{ backgroundColor: item.content.background || "#fff", containerType: "inline-size" }}><SlideSurface content={item.content}/>{page.hidden && <span className="absolute bottom-1 right-1 grid size-5 place-items-center rounded bg-[#f2f3f5] text-[#646a73]" title="已隐藏"><EyeOff size={13}/></span>}</button>
                <button type="button" aria-label={`拖动第 ${index + 1} 页排序`} title="拖动排序" disabled={!canEdit || orderUnknown || queue.hasUnsaved()} onPointerDown={(event) => beginPageDrag(event, page, true)} onPointerMove={movePageDrag} onPointerUp={endPageDrag} onPointerCancel={stopPageDrag} onLostPointerCapture={() => { if (dragPage.current) stopPageDrag(); }} className="absolute -bottom-6 left-5 right-0 grid h-6 touch-none select-none place-items-center rounded text-[#8f959e] active:bg-[#e8efff] active:text-[#3370ff] disabled:opacity-40 sm:hidden [@media(pointer:coarse)]:grid"><GripHorizontal size={16}/></button>
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
            <div className="relative shrink-0"><button ref={shapeButtonRef} type="button" disabled={!canEdit || !active} aria-haspopup="dialog" aria-expanded={shapeMenu} onClick={() => setShapeMenu((open) => !open)} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Shapes size={16}/>图形</button></div>
            <button type="button" disabled={!canEdit || !active || uploadingImage || draft?.content.shapes.length === 100} onClick={() => imageInputRef.current?.click()} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><ImageIcon size={16}/>{uploadingImage ? "上传中" : "图片"}</button>
            <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" aria-label="选择幻灯片图片" className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void insertImage(file); }}/>
            <button ref={backgroundButtonRef} type="button" disabled={!active} aria-expanded={formatOpen} onClick={() => setFormatOpen((open) => !open)} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Palette size={16}/>格式</button>
            <span className="mx-1 h-5 w-px bg-[#e5e6eb]" />
            <button type="button" aria-label="复制页面" disabled={!canEdit || !active || draft?.state !== "saved" || copyPageUnknown || visibilityUnknown || pageActions > 0} onClick={() => active && doCopy(active)} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Copy size={15}/>复制</button>
            <button type="button" disabled={!canEdit || !active || draft?.state !== "saved" || remove.isPending} onClick={() => { if (active) void doRemove(active); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Trash2 size={15}/>删除</button>
            <button type="button" disabled={!canEdit || orderUnknown || queue.hasUnsaved() || !active || list.findIndex((page) => page.id === active.id) <= 0} onClick={() => { if (!active) return; const i = list.findIndex((page) => page.id === active.id); doMove(active, i - 1); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><ArrowUp size={15}/>上移</button>
            <button type="button" disabled={!canEdit || orderUnknown || queue.hasUnsaved() || !active || list.findIndex((page) => page.id === active.id) >= list.length - 1} onClick={() => { if (!active) return; const i = list.findIndex((page) => page.id === active.id); doMove(active, i + 1); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><ArrowDown size={15}/>下移</button>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-3" role="group" aria-label="幻灯片缩放"><button type="button" aria-label="缩小幻灯片" onClick={() => setManualZoom(clampSlideZoom(zoom - 10))} className="grid size-7 place-items-center rounded-l border border-[#d0d3d6] hover:bg-[#f2f3f5]"><Minus size={14}/></button><label className="flex h-7 items-center border-y border-[#d0d3d6] text-[#646a73]"><input aria-label="幻灯片缩放比例" inputMode="decimal" value={zoomText} onFocus={(event) => { zoomEditing.current = true; event.currentTarget.select(); }} onChange={(event) => setZoomText(event.target.value)} onBlur={() => { if (!zoomEditing.current) return; zoomEditing.current = false; const value = parseSlideZoom(zoomText); if (value !== null) { setManualZoom(value); setZoomText(String(value)); } else setZoomText(String(zoom)); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { zoomEditing.current = false; setZoomText(String(zoom)); event.currentTarget.blur(); } }} className="w-9 bg-transparent text-right text-[12px] outline-none"/><span className="pr-1">%</span></label><button type="button" aria-label="放大幻灯片" onClick={() => setManualZoom(clampSlideZoom(zoom + 10))} className="grid size-7 place-items-center rounded-r border border-[#d0d3d6] hover:bg-[#f2f3f5]"><Plus size={14}/></button><button type="button" aria-label="适合屏幕" title="适合屏幕" onClick={() => setManualZoom(null)} className="ml-1 grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Maximize2 size={14}/></button></div>
          </div>
          {shapeMenu && shapeButtonRef.current && createPortal(<div ref={shapeMenuRef} role="dialog" aria-label="选择图形" style={{ left: Math.max(12, Math.min(shapeButtonRef.current.getBoundingClientRect().left, window.innerWidth - Math.min(516, window.innerWidth - 24) - 12)), top: Math.min(shapeButtonRef.current.getBoundingClientRect().bottom + 4, window.innerHeight - 250), width: "min(516px, calc(100vw - 24px))" }} className="fixed z-[100] overflow-hidden rounded-lg border border-[#dee0e3] bg-white text-[13px] text-[#1f2329] shadow-[0_6px_24px_rgba(31,35,41,0.16)]"><div className="flex h-12 items-end border-b border-[#e5e6eb] px-4"><span className="flex h-12 items-center border-b-2 border-[#3370ff] px-1 font-medium text-[#3370ff]">形状</span></div><div className="flex h-[280px]"><div className="w-[112px] shrink-0 border-r border-[#e5e6eb] p-2 sm:w-[160px]">{(["基础", "箭头"] as const).map((group) => <button key={group} type="button" aria-pressed={shapeGroup === group} onClick={() => setShapeGroup(group)} className={cn("flex h-9 w-full items-center rounded px-3 text-left", shapeGroup === group ? "bg-[#e8efff] text-[#245bdb]" : "hover:bg-[#f2f3f5]")}>{group}</button>)}</div><div className="min-w-0 flex-1 overflow-y-auto p-4"><div className="mb-3 text-[12px] text-[#8f959e]">{shapeGroup}</div><div className="grid grid-cols-3 gap-2 sm:grid-cols-5">{SLIDE_SHAPES.filter((shape) => shape.group === shapeGroup).map((shape) => <button type="button" key={shape.kind} aria-label={shape.label} title={shape.label} onClick={() => addShape(shape.kind)} className="grid size-12 place-items-center rounded-md p-2 hover:bg-[#f2f3f5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#3370ff]"><SlideShapeGraphic kind={shape.kind} color="#4b5058" outline/></button>)}</div></div></div></div>, document.body)}
          {chosenShape && canEdit && <SlideShapeControls shape={chosenShape} onChange={(patch) => updateShape(chosenShape.id, patch)} onOrder={(action) => orderShape(chosenShape.id, action)} onAlign={(alignment) => alignShape(chosenShape.id, alignment)} onDelete={() => { if (active) queue.edit(active, { shapes: queue.get(active).content.shapes.filter((shape) => shape.id !== chosenShape.id) }); setSelectedShape(null); }}/>}
          {(operationError || visibilityUnknown || create.isError || remove.isError) && <p role="alert" className="bg-[#fff2f0] px-4 py-2 text-[12px] text-[#d83931]">{operationError || (visibilityUnknown ? "隐藏状态未能确认，请重新打开并检查后再放映。" : "操作未完成，请刷新后检查。")}{createdCopyId && <a className="ml-2 underline" href={`#/slides/${createdCopyId}`}>打开已创建的副本</a>}</p>}
          {clipboardNotice && <p role="status" className="bg-[#f2f6ff] px-4 py-2 text-[12px] text-[#3370ff]">{clipboardNotice}<button type="button" onClick={() => setClipboardNotice("")} className="ml-3 underline">关闭</button></p>}
          {draft && (draft.state === "conflict" || draft.state === "unknown") && <p role="alert" className="bg-[#fff2f0] px-4 py-2 text-[12px] text-[#d83931]">{draft.state === "conflict" ? "此页已被其他人修改。" : "保存结果未确认。"}你的输入仍在页面中，请复制保留后重新打开。</p>}
          {draft?.state === "pending" && !canDraft && <div role="alert" className="bg-[#fff2f0] px-4 py-2 text-[12px] text-[#d83931]">权限尚未确认，输入仍保留在本地，未发送到服务器。<SlidesDraftRecovery queue={queue}/></div>}
          <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto">
            <div className="flex min-h-full min-w-full p-4">
              {active && draft ? <div className="group/slide relative m-auto shrink-0 bg-white shadow-[0_4px_18px_rgba(31,35,41,0.12)]" style={{ width: SLIDE_WIDTH * zoom / 100, height: SLIDE_HEIGHT * zoom / 100, backgroundColor: draft.content.background || "#fff" }} data-slides-canvas onPointerDown={(event) => { if (event.target instanceof Element && !event.target.closest("[data-slide-object]")) { queue.endGroup(active.id); setSelectedShape(null); } }}>
                <div className="absolute left-0 top-0" style={{ width: SLIDE_WIDTH, height: SLIDE_HEIGHT, padding: hasLargeSlideTitle(draft.content.layout) ? 0 : "48px 57.6px", transform: `scale(${zoom / 100})`, transformOrigin: "top left", containerType: "inline-size" }}>
                  {(!isBlankSlideLayout(draft.content.layout) || draft.content.title || titleFocusPage === active.id) && <input ref={titleRef} aria-label="幻灯片标题" value={draft.content.title} readOnly={!canDraft} onFocus={() => setTitleFocusPage(active.id)} onChange={(event) => queue.edit(active, { title: event.target.value }, "title")} onBlur={() => { setTitleFocusPage(null); queue.endGroup(active.id); }} placeholder={draft.content.layout === "title" ? "点击修改大标题样式" : "点击添加标题"} className={cn("border border-transparent bg-transparent px-2 py-1 font-semibold leading-tight text-[#1f2329] outline-none focus:border-[#3370ff] focus:placeholder:text-[#b8bec5]", hasLargeSlideTitle(draft.content.layout) ? cn("absolute left-[9.5%] top-[41.3%] w-[81%] text-[54px] placeholder:text-[#1f2329]", draft.content.layout === "title" ? "text-center" : "text-left") : "w-full text-[36px] placeholder:text-transparent group-hover/slide:placeholder:text-[#b8bec5] [@media(hover:none)]:placeholder:text-[#b8bec5]")} data-slides-title data-slide-history />}
                  {draft.content.layout === "blank" && !draft.content.title && titleFocusPage !== active.id && !!draft.content.body && <div aria-hidden="true" className="h-[55px]"/>}
                  {((draft.content.layout !== "title" && !isBlankSlideLayout(draft.content.layout)) || draft.content.body || bodyFocusPage === active.id) && <textarea aria-label="幻灯片正文" value={draft.content.body} readOnly={!canDraft} onFocus={() => setBodyFocusPage(active.id)} onChange={(event) => queue.edit(active, { body: event.target.value }, "body")} onBlur={() => { setBodyFocusPage(null); queue.endGroup(active.id); }} placeholder="点击添加正文" className={cn("resize-none border border-transparent bg-transparent px-2 py-1 text-[21px] leading-relaxed text-[#1f2329] outline-none placeholder:text-transparent focus:border-[#3370ff] focus:placeholder:text-[#b8bec5] group-hover/slide:placeholder:text-[#b8bec5] [@media(hover:none)]:placeholder:text-[#b8bec5]", hasLargeSlideTitle(draft.content.layout) ? "absolute left-[9.5%] top-[60%] h-[27%] w-[81%]" : "mt-[4%] h-[55%] w-full")} data-slides-body data-slide-history />}
                  <SlideShapes shapes={draft.content.shapes} editable={canEdit} textEditable={canDraft} selected={selectedShape} scale={zoom / 100} onSelect={(id) => { if (id !== selectedShape) queue.endGroup(active.id); setSelectedShape(id); }} onChange={(shape) => updateShape(shape.id, { x: shape.x, y: shape.y, width: shape.width, height: shape.height })} onTextChange={(id, text) => { flushSync(() => { const shapes = patchSlideShape(queue.get(active).content.shapes, id, { text }); queue.edit(active, { shapes }, `text:${id}`); }); }} onTextBlur={() => queue.endGroup(active.id)}/>
                </div>
                <input ref={backgroundRef} type="color" value={/^#[0-9a-f]{6}$/i.test(draft.content.background) ? draft.content.background : "#ffffff"} disabled={!canEdit} onChange={(event) => { if (backgroundTarget.current === active.id && activePageRef.current === active.id && canEditRef.current && !pageActionCount.current) queue.edit(active, { background: event.target.value }); }} className="sr-only" aria-label="幻灯片背景颜色" />
              </div> : <div className="m-auto flex flex-col items-center gap-3 text-[13px] text-[#8f959e]"><ImageIcon size={32} strokeWidth={1.2}/><span>新建一页，开始制作幻灯片</span></div>}
            </div>
          </div>
          {active && draft && <SlideNotesPanel value={draft.content.notes} readOnly={!canDraft} onChange={(notes) => queue.edit(active, { notes }, "notes")} onBlur={() => queue.endGroup(active.id)}/>}
          <footer className="flex h-9 shrink-0 items-center justify-between border-t border-[#e5e6eb] bg-white px-4 text-[12px] text-[#8f959e]"><span>{active ? `${list.findIndex((page) => page.id === active.id) + 1} / ${list.length}` : "0 / 0"}</span><span className="hidden sm:inline">使用方向键切换放映页面</span></footer>
        </section>
      </div>
      {formatOpen && active && draft && <SlideFormatPanel key={active.id} background={draft.content.background} layout={draft.content.layout ?? ""} shapes={draft.content.shapes} usedColors={list.map((page) => queue.get(page).content.background)} canEdit={canEdit} busy={pageActions > 0 || pages.isFetching || queue.hasUnsaved()} applying={backgroundApplying} onChange={(color) => { if (canEdit && !pageActionCount.current && activePageRef.current === active.id) queue.edit(active, { background: color }); }} onLayoutChange={(layout) => { if (!canEdit || pageActionCount.current || activePageRef.current !== active.id) return; const plan = planSlideLayout(queue.get(active).content, layout); if (!plan.ok) { setOperationError(plan.message); return; } setOperationError(""); setSelectedShape(null); queue.edit(active, plan.content); }} onMore={() => { if (canEdit && activePageRef.current === active.id) { backgroundTarget.current = active.id; backgroundRef.current?.click(); } }} onApplyAll={() => void applyBackgroundToAll()} onClose={() => { setFormatOpen(false); backgroundButtonRef.current?.focus(); }}/>}
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
          const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (current + 1) % buttons.length : current < 0 ? buttons.length - 1 : (current + buttons.length - 1) % buttons.length;
          buttons[index].focus();
        }} className="fixed z-[70] overflow-y-auto rounded-lg border border-[#dee0e3] bg-white p-1 text-[13px] text-[#1f2329] shadow-[0_6px_24px_rgba(31,35,41,0.16)]" style={{ left: pageMenu.left, top: pageMenu.top, width: pageMenu.width, maxHeight: pageMenu.maxHeight }}>
          <button type="button" role="menuitem" disabled={!canCopyRef.current || item.state !== "saved"} onClick={() => { setPageMenu(null); void copyToClipboard(page); }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><Copy size={14}/>复制<span className="ml-auto text-[11px] text-[#8f959e]">⌘/Ctrl C</span></button>
          <button type="button" role="menuitem" disabled={!canPasteRef.current || item.state !== "saved"} onClick={() => { setPageMenu(null); void pasteFromClipboard(page); }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><Clipboard size={14}/>粘贴<span className="ml-auto text-[11px] text-[#8f959e]">⌘/Ctrl V</span></button>
          <div className="my-1 border-t border-[#e5e6eb]"/>
          <button type="button" role="menuitem" disabled={!canEdit || item.state !== "saved" || remove.isPending || pageActions > 0} onClick={() => { setPageMenu(null); void doRemove(page); }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><Trash2 size={14}/>删除</button>
          <div className="my-1 border-t border-[#e5e6eb]"/>
          <button type="button" role="menuitem" data-page-menu-default disabled={!canEdit || item.state !== "saved" || insertPageUnknown || create.isPending || pageActions > 0} onClick={() => { setPageMenu(null); doInsert(page); }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><FilePlus2 size={14}/>新建幻灯片 <span className="ml-auto text-[11px] text-[#8f959e]">Ctrl M</span></button>
          <button type="button" role="menuitem" disabled={!canEdit || item.state !== "saved" || copyPageUnknown || visibilityUnknown || pageActions > 0} onClick={() => { setPageMenu(null); doCopy(page); }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><Copy size={14}/>复制幻灯片 <span className="ml-auto text-[11px] text-[#8f959e]">⌘/Ctrl D</span></button>
          <button type="button" role="menuitem" disabled={!canEdit || item.state !== "saved" || visibilityUnknown || pageActions > 0 || create.isPending} onClick={() => { setPageMenu(null); togglePageHidden(page); }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><EyeOff size={14}/>{page.hidden ? "取消隐藏幻灯片" : "隐藏幻灯片"}</button>
          <button type="button" role="menuitem" disabled={!canEdit || orderUnknown || queue.hasUnsaved() || list.findIndex((entry) => entry.id === page.id) <= 0} onClick={() => { const index = list.findIndex((entry) => entry.id === page.id); setPageMenu(null); doMove(page, index - 1); }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><ArrowUp size={14}/>上移幻灯片</button>
          <button type="button" role="menuitem" disabled={!canEdit || orderUnknown || queue.hasUnsaved() || list.findIndex((entry) => entry.id === page.id) >= list.length - 1} onClick={() => { const index = list.findIndex((entry) => entry.id === page.id); setPageMenu(null); doMove(page, index + 1); }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><ArrowDown size={14}/>下移幻灯片</button>
          <div className="my-1 border-t border-[#e5e6eb]"/>
          <button type="button" role="menuitem" onClick={() => { setPageMenu(null); setFormatOpen(true); }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5]"><Palette size={14}/>幻灯片背景</button>
        </div>;
      })()}
      {sharing && <ShareDialog meta={meta.data} onClose={() => setSharing(false)} anchorRef={shareRef}/>}
    </main>
  );
}

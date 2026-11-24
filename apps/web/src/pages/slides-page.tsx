import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, docsApi, slidesApi, type DocMeta, type Me, type SlidePageMeta, type SlidesPage as Page, type SlideShape, type SlideShapeAnimation } from "@/lib/api";
import { DocumentWatermark } from "@/components/document-watermark";
import { exportSlidesToPptx, parsePptxToSlides, type PptxImportResult } from "@jiange/slides-sdk/pptx";
import { ShareDialog } from "@/components/share-dialog";
import { ask } from "@/components/ui/ask";
import { cn } from "@/lib/utils";
import { createVisitRecorder } from "@/lib/recent-visit";
import { sameSlideContent, SlidesDraftQueue } from "./slides-draft";
import { canDownloadDocument, copyErrorMessage } from "./document-copy";
import {
  commitStructureTravel,
  emptyStructureHistory,
  pushStructureAction,
  snapshotSlidePage,
  structureActionLabel,
  type SlideStructureAction,
  type SlideStructureHistory,
} from "./slides-structure-history";
import { SlideShapes } from "./slides-shapes";
import { SlidesGpuLayer } from "./slides-gpu-layer";
import {
  appendInkPoint,
  clearSlideInk,
  isDarkSlideBackground,
  PRESENTER_INK_COLORS,
  PresenterStageInteractive,
  PresenterToolDock,
  PresenterView,
  pushLaserTrailPoint,
  SlideSurface,
  startInkStroke,
  stepPresentationBackward,
  stepPresentationForward,
  type PresenterInkStroke,
  type PresenterPoint,
  type PresenterTool,
} from "./slides-presenter";
import { SlideShapeControls, SlideMultiShapeControls } from "./slides-shape-controls";
import { SlideTextControls } from "./slides-text-controls";
import { bodyHasBullets, buildSlidePageMeta, hydrateSlideTextStyles, toggleBodyBullets, type SlideFieldTextStyle, type SlidePageTextStyles, type SlideTextStyleMap } from "./slides-text-style";
import {
  buildAnimationSteps,
  getPageShapeAnimations,
  hydrateSlideAnimations,
  pruneShapeAnimations,
  sameSlideShapeAnimations,
  setShapeAnimation,
  SLIDE_ANIMATION_KEYFRAMES_CSS,
  type SlideDeckShapeAnimations,
  type SlidePageShapeAnimations,
} from "./slides-animations";
import { createDefaultSlideChart, createDefaultSlideTable } from "./slides-table-chart-editor";
import { applyThemeToPageTextStyle, applyThemeToTextStyles, type SlideThemePreset } from "./slides-themes";
import {
  applyTransitionToAllPages,
  getSlideTransition,
  hydrateSlideTransitions,
  setSlideTransition,
  SLIDE_TRANSITION_DURATION_MS,
  SLIDE_TRANSITION_KEYFRAMES_CSS,
  slideTransitionAnimationStyle,
  type SlideTransitionKind,
  type SlideTransitionMap,
} from "./slides-transitions";
import {
  alignMultipleShapes,
  distributeShapesHorizontally,
  distributeShapesVertically,
  expandSelectionWithGroups,
  groupShapes,
  hydrateSlideShapeGroups,
  isSelectionSingleGroup,
  pruneShapeGroups,
  sameSlideShapeGroups,
  shapesInMarquee,
  ungroupShapes,
  type SlideDeckShapeGroups,
  type SlideRect,
  type SlideShapeGroups,
} from "./slides-multi-select";
import { patchSlideShape } from "./slides-shape-state";
import { clampSlideZoom, fitSlideZoom, parseSlideZoom, SLIDE_HEIGHT, SLIDE_WIDTH } from "./slides-zoom";
import { alignSlideShape, moveShapeOrder, type ShapeAlignment, type ShapeOrderAction } from "./slides-shape-order";
import { playableSlides, presentationStart, presentationKeyTarget } from "./slides-visibility";
import { ResourceTypeNotice } from "./resource-type-notice";
import { ResourceReferencesButton } from "./resource-references-button";
import { SlideFormatPanel } from "./slide-format-panel";
import { SlidesExtrasPanel } from "./slides-extras-panel";
import { SlideNotesPanel } from "./slide-notes-panel";
import { SlideDeckTitle, type SlideTitleDraft } from "./slide-deck-title";
import { readSlideTitleDraft, writeSlideTitleDraft } from "./slides-title-recovery";
import { SlideShapePicker, slideShapePickerPosition } from "./slide-shape-picker";
import { isLineSlideShape, type BasicSlideShape } from "./slide-shape-catalog";
import { samePositions, slideDropIndex, slideEdgeScrollSpeed, slidePositions, verifySlideOrder, type SlidePosition } from "./slides-order";
import { applyBackgroundChangeReceipts, applyBackgroundReceipts } from "./slides-background";
import { validSlideDeleteReceipt } from "./slides-delete";
import { hasLargeSlideTitle, isBlankSlideLayout } from "./slides-layout";
import { SlideCreateLayoutPicker, slideCreatePickerPosition, type NewSlideLayout } from "./slides-create-layout";
import { planSlideLayout, slidePresetContent } from "./slides-layout-preset";
import { slidePageMenuPosition } from "./slides-page-menu";
import { encodeSlideClipboard, mayCopySlide, parseSlideClipboard, verifyCrossSlidePaste } from "./slides-clipboard";
import { ArrowDown, ArrowUp, BarChart3, ChevronDown, ChevronLeft, ChevronsLeft, ChevronsRight, Clipboard, Copy, Download, EyeOff, FileDown, FilePlus2, FileUp, GripHorizontal, History, ImageIcon, Maximize2, MessageSquare, Minus, MoreHorizontal, Palette, Play, Plus, Presentation, Printer, Redo2, Table2, Trash2, Type, Shapes, Undo2, X } from "lucide-react";

type BackgroundAction = { id: number; before: Page[]; after: Page[] };
type BackgroundHistory = { undo: BackgroundAction[]; redo: BackgroundAction[] };
type SlideCollaborator = { userId: number; name: string; pageId?: number };

const SLIDE_PEER_COLORS = ["#f54a45", "#00b42a", "#ff8800", "#722ed1", "#14c9c9", "#3370ff"];
function slidePeerColor(uid: number): string {
  return SLIDE_PEER_COLORS[Math.abs(uid) % SLIDE_PEER_COLORS.length];
}

function SlidesDraftRecovery({ queue }: { queue: SlidesDraftQueue }) {
  const drafts = queue.unsavedDrafts();
  if (!drafts.length) return null;
  return <details className="w-full max-w-2xl text-left"><summary className="cursor-pointer text-[13px] text-[#3370ff]">查看并复制未保存内容</summary>{drafts.map(({ page, content }) => <label key={page.id} className="mt-2 block text-[12px] text-[#646a73]">第 {page.pos} 页<textarea readOnly aria-label={`第 ${page.pos} 页未保存内容`} value={JSON.stringify(content, null, 2)} className="mt-1 block h-40 w-full rounded border border-[#dee0e3] bg-white p-2 font-mono text-[12px] text-[#1f2329]"/></label>)}</details>;
}

function SlideTitleRecovery({ draft }: { draft: SlideTitleDraft | null }) {
  return draft && <label className="block w-full text-left text-[12px] text-[#646a73]">未保存的名称（可复制）<input readOnly aria-label="未保存的幻灯片名称" value={draft.value} className="mt-1 block h-8 w-full rounded border border-[#dee0e3] bg-white px-2 text-[#1f2329]"/></label>;
}

/** Presentation editor. Drafts are kept locally while page writes are serialised. */
export function SlidesDeck({ deckId, userId, me }: { deckId: number; userId: number; me?: Me }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState<number | null>(null);
  const [titleDraft, setTitleDraft] = useState<SlideTitleDraft | null>(() => typeof sessionStorage === "undefined" ? null : readSlideTitleDraft(sessionStorage, userId, deckId));
  const titleSaving = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [playbackAnimStep, setPlaybackAnimStep] = useState(0);
  const [presenterTool, setPresenterTool] = useState<PresenterTool>("pointer");
  const [presenterInkColor, setPresenterInkColor] = useState<string>(PRESENTER_INK_COLORS[0]);
  const [presenterLaserTrail, setPresenterLaserTrail] = useState<PresenterPoint[]>([]);
  const [presenterInkByPage, setPresenterInkByPage] = useState<Record<number, PresenterInkStroke[]>>({});
  const [audienceWindow, setAudienceWindow] = useState<Window | null>(null);
  const audienceRef = useRef<Window | null>(null);
  const audienceMountRef = useRef<HTMLElement | null>(null);
  const resetPresenterState = () => {
    setPlaybackAnimStep(0);
    setPresenterTool("pointer");
    setPresenterInkColor(PRESENTER_INK_COLORS[0]);
    setPresenterLaserTrail([]);
    setPresenterInkByPage({});
  };
  const stopPresentation = () => { const popup = audienceRef.current; audienceRef.current = null; audienceMountRef.current = null; popup?.close(); setAudienceWindow(null); setPlaying(false); resetPresenterState(); };
  const [checkingPlayback, setCheckingPlayback] = useState(false);
  const [playMenu, setPlayMenu] = useState(false);
  const playMenuRef = useRef<HTMLDivElement>(null);
  const playbackRef = useRef<HTMLDivElement>(null);
  const playbackCheck = useRef(false);
  const [sharing, setSharing] = useState(false);
  const [shapeMenu, setShapeMenu] = useState(false);
  const [gpuActive, setGpuActive] = useState(false);
  const [previewShapes, setPreviewShapes] = useState<ReadonlyMap<string, SlideShape> | null>(null);
  const shapeButtonRef = useRef<HTMLButtonElement>(null);
  const shapeMenuRef = useRef<HTMLDivElement>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  const [extrasPanel, setExtrasPanel] = useState<"comments" | "versions" | null>(null);
  const [backgroundApplying, setBackgroundApplying] = useState(false);
  const [backgroundBatchUnknown, setBackgroundBatchUnknown] = useState(false);
  const [backgroundHistory, setBackgroundHistory] = useState<BackgroundHistory>({ undo: [], redo: [] });
  const backgroundHistoryRef = useRef(backgroundHistory);
  const backgroundBatchSequence = useRef(0);
  backgroundHistoryRef.current = backgroundHistory;
  const [structureHistory, setStructureHistory] = useState<SlideStructureHistory>(emptyStructureHistory);
  const structureHistoryRef = useRef(structureHistory);
  structureHistoryRef.current = structureHistory;
  const historyClock = useRef(0);
  const pageEditClock = useRef(new Map<number, number>());
  const [collaborators, setCollaborators] = useState<SlideCollaborator[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const [fileMenu, setFileMenu] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const pptxInputRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<{ fileName: string; parsed: PptxImportResult } | null>(null);
  const [importingPptx, setImportingPptx] = useState(false);
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
  const [selectedShapes, setSelectedShapes] = useState<string[]>([]);
  const selectedShape = selectedShapes.length === 1 ? selectedShapes[0] : null;
  const setSelectedShape = (id: string | null) => setSelectedShapes(id ? [id] : []);
  const [shapeGroups, setShapeGroups] = useState<SlideDeckShapeGroups>({});
  const shapeGroupsRef = useRef<SlideDeckShapeGroups>(shapeGroups);
  shapeGroupsRef.current = shapeGroups;
  const [shapeAnimations, setShapeAnimations] = useState<SlideDeckShapeAnimations>({});
  const shapeAnimationsRef = useRef<SlideDeckShapeAnimations>(shapeAnimations);
  shapeAnimationsRef.current = shapeAnimations;
  const [shapeAnimPreview, setShapeAnimPreview] = useState<{ shapeId: string; nonce: number } | null>(null);
  const shapeAnimPreviewTimer = useRef<number | null>(null);
  useEffect(() => () => { if (shapeAnimPreviewTimer.current !== null) window.clearTimeout(shapeAnimPreviewTimer.current); }, []);
  const [transitions, setTransitions] = useState<SlideTransitionMap>({});
  const transitionsRef = useRef<SlideTransitionMap>(transitions);
  transitionsRef.current = transitions;
  const [textStyles, setTextStyles] = useState<SlideTextStyleMap>({});
  const textStylesRef = useRef<SlideTextStyleMap>(textStyles);
  textStylesRef.current = textStyles;
  const metaInFlightRef = useRef<Map<number, number>>(new Map());
  const metaQueuedRef = useRef<Map<number, SlidePageMeta>>(new Map());
  const metaFlushPromisesRef = useRef<Map<number, Promise<void>>>(new Map());
  const metaBatchInFlightRef = useRef(0);
  const metaDeckKeyRef = useRef(`${deckId}:${userId}`);
  useEffect(() => {
    metaDeckKeyRef.current = `${deckId}:${userId}`;
    metaInFlightRef.current.clear();
    metaQueuedRef.current.clear();
    metaFlushPromisesRef.current.clear();
    metaBatchInFlightRef.current = 0;
    shapeGroupsRef.current = {};
    shapeAnimationsRef.current = {};
    transitionsRef.current = {};
    textStylesRef.current = {};
    setShapeGroups({});
    setShapeAnimations({});
    setTransitions({});
    setTextStyles({});
  }, [deckId, userId]);
  const applyPageMetaToCache = (pageId: number, metaValue: SlidePageMeta | undefined) => {
    const clean = metaValue && Object.keys(metaValue).length > 0 ? metaValue : undefined;
    qc.setQueryData<Page[]>(["slides", deckId, userId], (old) =>
      old?.map((item) => (item.id === pageId ? { ...item, meta: clean } : item)),
    );
  };
  const flushPageMeta = async (pageId: number, deckKey: string) => {
    while (metaDeckKeyRef.current === deckKey) {
      const next = metaQueuedRef.current.get(pageId);
      if (!next) {
        metaInFlightRef.current.delete(pageId);
        metaFlushPromisesRef.current.delete(pageId);
        return;
      }
      metaQueuedRef.current.delete(pageId);
      try {
        const saved = await slidesApi.patchPageMeta(deckId, pageId, userId, next);
        if (metaDeckKeyRef.current !== deckKey) return;
        if (!metaQueuedRef.current.has(pageId)) {
          metaInFlightRef.current.delete(pageId);
          metaFlushPromisesRef.current.delete(pageId);
          applyPageMetaToCache(pageId, saved.meta);
          return;
        }
      } catch (error) {
        if (metaDeckKeyRef.current !== deckKey) return;
        metaQueuedRef.current.delete(pageId);
        metaInFlightRef.current.delete(pageId);
        metaFlushPromisesRef.current.delete(pageId);
        setOperationError(
          error instanceof ApiError && error.message
            ? error.message
            : "保存页面样式或动画失败，请重试。",
        );
        void qc.invalidateQueries({ queryKey: ["slides", deckId, userId] });
        return;
      }
    }
  };
  const schedulePageMetaSave = (
    pageId: number,
    styles: SlidePageTextStyles | undefined,
    transition: SlideTransitionKind | undefined,
    groups: SlideShapeGroups | undefined,
    animations: SlidePageShapeAnimations | undefined = shapeAnimationsRef.current[pageId],
  ) => {
    if (!mayWrite.current) return;
    const deckKey = `${deckId}:${userId}`;
    const nextMeta = buildSlidePageMeta(styles, transition, groups, animations);
    metaQueuedRef.current.set(pageId, nextMeta);
    const alreadyRunning = metaInFlightRef.current.has(pageId);
    if (!alreadyRunning) metaInFlightRef.current.set(pageId, 1);
    applyPageMetaToCache(pageId, nextMeta);
    if (!alreadyRunning) {
      const p = flushPageMeta(pageId, deckKey);
      metaFlushPromisesRef.current.set(pageId, p);
      void p;
    }
  };
  const persistBatchPagesMeta = async (
    patch: Partial<Pick<SlidePageMeta, "titleStyle" | "bodyStyle" | "transition">>,
  ) => {
    if (!mayWrite.current) return;
    const deckKey = `${deckId}:${userId}`;
    metaBatchInFlightRef.current += 1;
    let decremented = false;
    const finishBatch = () => {
      if (!decremented && metaDeckKeyRef.current === deckKey) {
        decremented = true;
        metaBatchInFlightRef.current = Math.max(0, metaBatchInFlightRef.current - 1);
      }
    };
    qc.setQueryData<Page[]>(["slides", deckId, userId], (old) =>
      old?.map((item) => {
        const cur: SlidePageMeta = { ...(item.meta ?? {}) };
        if (patch.titleStyle) cur.titleStyle = { ...cur.titleStyle, ...patch.titleStyle };
        if (patch.bodyStyle) cur.bodyStyle = { ...cur.bodyStyle, ...patch.bodyStyle };
        if (patch.transition !== undefined) {
          if (patch.transition === "none") delete cur.transition;
          else cur.transition = patch.transition;
        }
        return { ...item, meta: Object.keys(cur).length > 0 ? cur : undefined };
      }),
    );
    try {
      if (metaFlushPromisesRef.current.size > 0) {
        await Promise.allSettled([...metaFlushPromisesRef.current.values()]);
      }
      if (metaDeckKeyRef.current !== deckKey) return;
      const { pages: updatedPages } = await slidesApi.batchPagesMeta(deckId, userId, patch);
      if (metaDeckKeyRef.current !== deckKey) return;
      const byId = new Map(updatedPages.map((p) => [p.id, p.meta]));
      finishBatch();
      qc.setQueryData<Page[]>(["slides", deckId, userId], (old) =>
        old?.map((item) =>
          byId.has(item.id) && !metaInFlightRef.current.has(item.id)
            ? { ...item, meta: byId.get(item.id) }
            : item,
        ),
      );
    } catch (error) {
      if (metaDeckKeyRef.current !== deckKey) return;
      finishBatch();
      setOperationError(
        error instanceof ApiError && error.message
          ? error.message
          : "批量保存页面样式或动画失败，请重试。",
      );
      void qc.invalidateQueries({ queryKey: ["slides", deckId, userId] });
    } finally {
      finishBatch();
    }
  };
  const updatePageGroups = (pageId: number, updater: (prev: SlideDeckShapeGroups[number] | undefined) => SlideDeckShapeGroups[number]) => {
    const prevAll = shapeGroupsRef.current;
    const prevPage = prevAll[pageId];
    const nextPage = updater(prevPage);
    const normalizedNext = Object.keys(nextPage).length > 0 ? nextPage : undefined;
    if (sameSlideShapeGroups(prevPage, normalizedNext)) return;
    const next: SlideDeckShapeGroups = { ...prevAll };
    if (normalizedNext) next[pageId] = normalizedNext;
    else delete next[pageId];
    shapeGroupsRef.current = next;
    setShapeGroups(next);
    schedulePageMetaSave(pageId, textStylesRef.current[pageId], transitionsRef.current[pageId], normalizedNext, shapeAnimationsRef.current[pageId]);
  };
  const updatePageAnimations = (
    pageId: number,
    updater: (prev: SlidePageShapeAnimations | undefined) => SlidePageShapeAnimations,
  ) => {
    const prevAll = shapeAnimationsRef.current;
    const prevPage = prevAll[pageId];
    const nextPage = updater(prevPage);
    const normalizedNext = Object.keys(nextPage).length > 0 ? nextPage : undefined;
    if (sameSlideShapeAnimations(prevPage, normalizedNext)) return;
    const next: SlideDeckShapeAnimations = { ...prevAll };
    if (normalizedNext) next[pageId] = normalizedNext;
    else delete next[pageId];
    shapeAnimationsRef.current = next;
    setShapeAnimations(next);
    schedulePageMetaSave(pageId, textStylesRef.current[pageId], transitionsRef.current[pageId], shapeGroupsRef.current[pageId], normalizedNext);
  };
  const triggerShapeAnimPreview = (shapeId: string, anim: SlideShapeAnimation) => {
    if (shapeAnimPreviewTimer.current !== null) {
      window.clearTimeout(shapeAnimPreviewTimer.current);
      shapeAnimPreviewTimer.current = null;
    }
    const duration = anim.durationMs ?? 450;
    const start = () => {
      setShapeAnimPreview({ shapeId, nonce: Date.now() });
      shapeAnimPreviewTimer.current = window.setTimeout(() => {
        setShapeAnimPreview(null);
        shapeAnimPreviewTimer.current = null;
      }, duration + 140);
    };
    if (shapeAnimPreview) {
      setShapeAnimPreview(null);
      requestAnimationFrame(start);
    } else {
      start();
    }
  };
  const [marqueeRect, setMarqueeRect] = useState<SlideRect | null>(null);
  const marqueeDrag = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPctX: number;
    startPctY: number;
    rect: DOMRect;
    baseSelection: string[];
    active: boolean;
  } | null>(null);
  const [transitionPreview, setTransitionPreview] = useState<{ kind: SlideTransitionKind; nonce: number } | null>(null);
  const transitionPreviewTimer = useRef<number | null>(null);
  useEffect(() => () => { if (transitionPreviewTimer.current !== null) window.clearTimeout(transitionPreviewTimer.current); }, []);
  const updatePageTransition = (pageId: number, kind: SlideTransitionKind) => {
    const next = setSlideTransition(transitionsRef.current, pageId, kind);
    transitionsRef.current = next;
    setTransitions(next);
    schedulePageMetaSave(pageId, textStylesRef.current[pageId], kind, shapeGroupsRef.current[pageId]);
  };
  const triggerTransitionPreview = (kind: SlideTransitionKind) => {
    if (transitionPreviewTimer.current !== null) {
      window.clearTimeout(transitionPreviewTimer.current);
      transitionPreviewTimer.current = null;
    }
    if (kind === "none") {
      setTransitionPreview(null);
      return;
    }
    const startPreview = () => {
      setTransitionPreview({ kind, nonce: Date.now() });
      transitionPreviewTimer.current = window.setTimeout(() => {
        setTransitionPreview(null);
        transitionPreviewTimer.current = null;
      }, SLIDE_TRANSITION_DURATION_MS + 80);
    };
    if (transitionPreview) {
      setTransitionPreview(null);
      requestAnimationFrame(startPreview);
    } else {
      startPreview();
    }
  };
  const [titleFocusPage, setTitleFocusPage] = useState<number | null>(null);
  const [bodyFocusPage, setBodyFocusPage] = useState<number | null>(null);
  const [activeTextField, setActiveTextField] = useState<{ pageId: number; kind: "title" | "body" } | null>(null);
  const patchFieldStyle = (pageId: number, kind: "title" | "body", patch: Partial<SlideFieldTextStyle>) => {
    const prev = textStylesRef.current;
    const nextPage: SlidePageTextStyles = { ...prev[pageId], [kind]: { ...prev[pageId]?.[kind], ...patch } };
    const next: SlideTextStyleMap = { ...prev, [pageId]: nextPage };
    textStylesRef.current = next;
    setTextStyles(next);
    schedulePageMetaSave(pageId, nextPage, transitionsRef.current[pageId], shapeGroupsRef.current[pageId]);
  };
  const applyPageThemeStyle = (pageId: number, theme: SlideThemePreset) => {
    const prev = textStylesRef.current;
    const nextPage = applyThemeToPageTextStyle(prev[pageId], theme);
    const next: SlideTextStyleMap = { ...prev, [pageId]: nextPage };
    textStylesRef.current = next;
    setTextStyles(next);
    schedulePageMetaSave(pageId, nextPage, transitionsRef.current[pageId], shapeGroupsRef.current[pageId]);
  };
  const resetFieldStyle = (pageId: number, kind: "title" | "body") => {
    const prev = textStylesRef.current;
    const pageEntry: SlidePageTextStyles = { ...prev[pageId] };
    delete pageEntry[kind];
    const next: SlideTextStyleMap = { ...prev };
    if (pageEntry.title || pageEntry.body) next[pageId] = pageEntry;
    else delete next[pageId];
    textStylesRef.current = next;
    setTextStyles(next);
    schedulePageMetaSave(pageId, next[pageId], transitionsRef.current[pageId], shapeGroupsRef.current[pageId]);
  };
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
  const structureHistoryAction = useRef<(redo: boolean) => boolean>(() => false);
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
  // Hydrate text styles, transitions, shape groups, and element animations directly from cloud page.meta
  // whenever pages.data loads or updates (initial load, tab return, polling, or WS invalidation).
  useEffect(() => {
    if (!pages.data || metaBatchInFlightRef.current > 0) return;
    const serverStyles = hydrateSlideTextStyles(pages.data);
    const serverTransitions = hydrateSlideTransitions(pages.data);
    const serverGroups = hydrateSlideShapeGroups(pages.data);
    const serverAnimations = hydrateSlideAnimations(pages.data);
    const inFlight = metaInFlightRef.current;
    if (inFlight.size === 0) {
      textStylesRef.current = serverStyles;
      transitionsRef.current = serverTransitions;
      shapeGroupsRef.current = serverGroups;
      shapeAnimationsRef.current = serverAnimations;
      setTextStyles(serverStyles);
      setTransitions(serverTransitions);
      setShapeGroups(serverGroups);
      setShapeAnimations(serverAnimations);
      return;
    }
    const mergeMap = <T,>(server: Record<number, T>, local: Record<number, T>): Record<number, T> => {
      const merged: Record<number, T> = { ...server };
      for (const pageId of inFlight.keys()) {
        if (pageId in local) merged[pageId] = local[pageId];
        else delete merged[pageId];
      }
      return merged;
    };
    const nextStyles = mergeMap(serverStyles, textStylesRef.current);
    const nextTransitions = mergeMap(serverTransitions, transitionsRef.current);
    const nextGroups = mergeMap(serverGroups, shapeGroupsRef.current);
    const nextAnimations = mergeMap(serverAnimations, shapeAnimationsRef.current);
    textStylesRef.current = nextStyles;
    transitionsRef.current = nextTransitions;
    shapeGroupsRef.current = nextGroups;
    shapeAnimationsRef.current = nextAnimations;
    setTextStyles(nextStyles);
    setTransitions(nextTransitions);
    setShapeGroups(nextGroups);
    setShapeAnimations(nextAnimations);
  }, [pages.data, deckId, userId]);
  const queue = useMemo(() => new SlidesDraftQueue(
    (page, content) => slidesApi.update(deckId, page.id, userId, content.title, content.body, content.background, content.layout ?? "", page.revision, content.notes, content.shapes),
    (saved) => qc.setQueryData<Page[]>(["slides", deckId, userId], (old) => old?.map((item) => item.id === saved.id && item.revision <= saved.revision ? (metaInFlightRef.current.has(saved.id) || metaBatchInFlightRef.current > 0 ? { ...saved, meta: item.meta } : saved) : item)),
    () => setDraftVersion((version) => version + 1),
    () => {
      const pid = activePageRef.current;
      if (pid !== null) pageEditClock.current.set(pid, ++historyClock.current);
      setBackgroundHistory((history) => history.redo.length ? { ...history, redo: [] } : history);
      setStructureHistory((history) => history.redo.length ? { ...history, redo: [] } : history);
    },
    () => mayWrite.current,
  ), [deckId, userId, qc]);
  // Live multi-user WebSocket presence and revision invalidations.
  useEffect(() => {
    if (meta.data?.kind !== "slides" || !pages.isSuccess || typeof WebSocket === "undefined") return;
    let closed = false;
    let reconnectTimer: number | null = null;
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${proto}//${location.host}/api/slides/${deckId}/ws`);
      wsRef.current = socket;
      socket.onopen = () => {
        if (activePageRef.current !== null) {
          socket.send(JSON.stringify({ type: "cursor", pageId: activePageRef.current }));
        }
      };
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg?.type === "presence" && Array.isArray(msg.collaborators)) {
            setCollaborators((msg.collaborators as SlideCollaborator[]).filter((c) => c.userId !== userId));
          } else if (msg?.type === "revision") {
            void qc.invalidateQueries({ queryKey: ["slides", deckId, userId] });
            void qc.invalidateQueries({ queryKey: ["slides-meta", deckId, userId] });
          }
        } catch {
          /* ignore malformed ws payload */
        }
      };
      socket.onclose = (ev) => {
        if (wsRef.current === socket) wsRef.current = null;
        if (!closed && ev.code !== 1008) {
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      const sock = wsRef.current;
      wsRef.current = null;
      sock?.close();
      setCollaborators([]);
    };
  }, [meta.data?.kind, pages.isSuccess, deckId, userId, qc]);
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
  useEffect(() => {
    if (!fileMenu) return;
    const outside = (event: PointerEvent) => { if (!fileMenuRef.current?.contains(event.target as Node)) setFileMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setFileMenu(false); fileMenuRef.current?.querySelector<HTMLButtonElement>("[aria-haspopup]")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [fileMenu]);
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
    onSuccess: ({ page, anchorId }) => {
      const before = qc.getQueryData<Page[]>(["slides", deckId, userId]) ?? [];
      const anchorIdx = anchorId === null ? -1 : before.findIndex((item) => item.id === anchorId);
      const insertedIndex = anchorIdx < 0 ? before.length : anchorIdx + 1;
      setStructureHistory((history) =>
        pushStructureAction(history, {
          kind: "insert",
          seq: ++historyClock.current,
          pageId: page.id,
          index: insertedIndex,
          snapshot: snapshotSlidePage(page),
        }),
      );
      if (activePageRef.current === anchorId) { setCurrent(page.id); setSelectedShape(null); }
      void invalidate();
    },
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
      setStructureHistory((history) =>
        pushStructureAction(history, {
          kind: "delete",
          seq: ++historyClock.current,
          pageId: page.id,
          index: Math.max(0, index),
          snapshot: snapshotSlidePage(page),
        }),
      );
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
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "cursor", pageId: active?.id ?? 0 }));
  }, [active?.id]);
  useEffect(() => {
    marqueeDrag.current = null;
    setMarqueeRect(null);
    setPreviewShapes(null);
  }, [active?.id]);
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
  const existingShapeIdSet = new Set((draft?.content.shapes ?? []).map((shape) => shape.id));
  const activeSelectedShapes = draft ? selectedShapes.filter((id) => existingShapeIdSet.has(id)) : [];
  const activePageGroups = active ? shapeGroups[active.id] : undefined;
  const activePageAnimations = active ? shapeAnimations[active.id] : undefined;
  const chosenShape = activeSelectedShapes.length === 1 ? draft?.content.shapes.find((shape) => shape.id === activeSelectedShapes[0]) : undefined;
  const multiSelectedCount = activeSelectedShapes.length;
  const multiSelectionGrouped = activeSelectedShapes.length > 1 && isSelectionSingleGroup(activePageGroups, activeSelectedShapes);
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
  const replaceShapes = (nextShapes: SlideShape[]) => {
    if (!active) return;
    queue.edit(active, { shapes: nextShapes });
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
  const alignSelectedShapes = (alignment: ShapeAlignment) => {
    if (!active || activeSelectedShapes.length < 2) return;
    const next = alignMultipleShapes(queue.get(active).content.shapes, activeSelectedShapes, alignment);
    queue.edit(active, { shapes: next });
  };
  const distributeSelectedHorizontally = () => {
    if (!active || activeSelectedShapes.length < 3) return;
    const next = distributeShapesHorizontally(queue.get(active).content.shapes, activeSelectedShapes);
    queue.edit(active, { shapes: next });
  };
  const distributeSelectedVertically = () => {
    if (!active || activeSelectedShapes.length < 3) return;
    const next = distributeShapesVertically(queue.get(active).content.shapes, activeSelectedShapes);
    queue.edit(active, { shapes: next });
  };
  const groupSelectedShapes = () => {
    if (!active || activeSelectedShapes.length < 2) return;
    updatePageGroups(active.id, (prev) => groupShapes(prev, activeSelectedShapes));
  };
  const ungroupSelectedShapes = () => {
    if (!active || activeSelectedShapes.length < 2) return;
    updatePageGroups(active.id, (prev) => ungroupShapes(prev, activeSelectedShapes));
  };
  const deleteSelectedShapes = () => {
    if (!active || !activeSelectedShapes.length) return;
    const removeSet = new Set(activeSelectedShapes);
    const nextShapes = queue.get(active).content.shapes.filter((shape) => !removeSet.has(shape.id));
    const livingIds = new Set(nextShapes.map((shape) => shape.id));
    queue.edit(active, { shapes: nextShapes });
    updatePageGroups(active.id, (prev) => pruneShapeGroups(prev, livingIds));
    updatePageAnimations(active.id, (prev) => pruneShapeAnimations(prev, livingIds));
    setSelectedShapes([]);
  };
  const addShape = (kind: SlideShape["kind"]) => {
    if (!active || !draft || !canEdit || draft.content.shapes.length >= 100) return;
    const id = `shape-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const existing = draft.content.shapes;
    const cascade = (baseX: number, baseY: number, w: number, h: number) => {
      let x = baseX, y = baseY;
      for (let step = 0; step < 12; step++) {
        if (!existing.some((s) => Math.abs(s.x - x) < 2 && Math.abs(s.y - y) < 2)) break;
        x = baseX + ((step + 1) * 3) % Math.max(4, Math.floor(96 - w - baseX + 18));
        if (x + w > 96) x = 10 + ((step + 1) * 3) % 60;
        y = Math.min(92 - h, baseY + ((step + 1) * 3) % 24);
      }
      return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    };
    const shape: SlideShape = kind === "text"
      ? { id, kind, ...cascade(12, 55, 35, 15), width: 35, height: 15, color: "#1f2329", text: "", fontSize: 24 }
      : kind === "table"
        ? { id, kind, ...cascade(12, 28, 72, 42), width: 72, height: 42, color: "#3370ff", table: createDefaultSlideTable() }
        : kind === "chart"
          ? { id, kind, ...cascade(16, 26, 66, 48), width: 66, height: 48, color: "#3370ff", chart: createDefaultSlideChart() }
          : kind !== "image" && isLineSlideShape(kind as BasicSlideShape)
            ? { id, kind, ...cascade(35, 48, 30, 5), width: 30, height: 5, color: "#1f2329" }
            : { id, kind, ...cascade(14, 52, 16, 20), color: "#3370ff" };
    queue.edit(active, { shapes: [...existing, shape] });
    setSelectedShape(shape.id);
    setShapeMenu(false);
    if (kind === "table" || kind === "chart") {
      setFormatOpen(true);
    }
  };
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
      if (playing || sharing || importPreview || !canEdit || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const redo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
      if (key !== "z" && !redo) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || (target !== document.body && !target.closest("[data-slides-editor]"))) return;
      if (target.matches("input, textarea, [contenteditable=true]") && !target.hasAttribute("data-slide-history")) return;
      event.preventDefault();
      if (backgroundHistoryAction.current(redo)) return;
      if (structureHistoryAction.current(redo)) return;
      if (!active) return;
      if (redo) queue.redo(active); else queue.undo(active);
      const living = new Set(queue.get(active).content.shapes.map((shape) => shape.id));
      setSelectedShapes((prev) => { const next = prev.filter((id) => living.has(id)); return next.length === prev.length ? prev : next; });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, canEdit, playing, sharing, importPreview, queue]);

  useEffect(() => {
    if (!playing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); stopPresentation(); return; }
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !playbackPage) return;
      // Let focused buttons retain their native Enter/Space activation.
      if ((event.key === " " || event.key === "Enter") && event.target instanceof HTMLElement && event.target.closest("button")) return;
      if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "PageDown" || event.key === " " || event.key === "Enter") {
        const step = stepPresentationForward(playable, playbackPage.id, playbackAnimStep, shapeAnimationsRef.current);
        if (step) {
          event.preventDefault();
          if (step.pageId !== playbackPage.id) setCurrent(step.pageId);
          setPlaybackAnimStep(step.animStep);
        }
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "PageUp") {
        const step = stepPresentationBackward(playable, playbackPage.id, playbackAnimStep, shapeAnimationsRef.current);
        if (step) {
          event.preventDefault();
          if (step.pageId !== playbackPage.id) setCurrent(step.pageId);
          setPlaybackAnimStep(step.animStep);
        }
        return;
      }
      const next = presentationKeyTarget(list, playbackPage.id, event.key);
      if (next) { event.preventDefault(); setCurrent(next.id); setPlaybackAnimStep(0); }
    };
    window.addEventListener("keydown", onKey);
    audienceWindow?.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); audienceWindow?.removeEventListener("keydown", onKey); };
  }, [playing, playbackPage, playable, playbackAnimStep, list, audienceWindow]);

  if (meta.isPending) return <div className="grid flex-1 place-items-center text-[13px] text-subtle">正在打开演示文稿…</div>;
  if (meta.isError || !meta.data || pages.isError) return <div className="grid flex-1 place-items-center text-[13px] text-subtle"><div className="flex max-w-md flex-col items-center gap-3 px-4 text-center"><p>{pages.error instanceof ApiError && pages.error.status === 426 ? pages.error.message : "无法访问该演示文稿，请确认权限后重试。"}</p>{queue.hasUnsaved() && <p role="alert">当前页面有未保存内容，请勿刷新或关闭；恢复网络及权限后重试。</p>}<SlidesDraftRecovery queue={queue}/><SlideTitleRecovery draft={titleDraft}/><button type="button" onClick={() => { void meta.refetch(); void pages.refetch(); }} className="rounded-md border px-3 py-1.5 text-foreground hover:bg-hover">重试</button></div></div>;
  if (meta.data.kind !== "slides") return <ResourceTypeNotice id={deckId} kind={meta.data.kind} verified={!meta.isFetching} blockNavigation={queue.hasUnsaved() || !!titleDraft}>{queue.hasUnsaved() && <><p role="alert" className="mt-3 text-[13px] text-red-600">当前演示文稿有未保存内容，请勿刷新或关闭；恢复文件类型和权限后重试。</p><SlidesDraftRecovery queue={queue}/></>}<SlideTitleRecovery draft={titleDraft}/></ResourceTypeNotice>;

  if (playing && (!playbackPage || !playbackDraft)) return <div className="fixed inset-0 z-[80] grid place-items-center bg-[#1f2329] text-white"><div className="text-center"><p>没有可放映的幻灯片</p><button type="button" onClick={stopPresentation} className="mt-4 rounded border px-3 py-1">退出放映</button></div></div>;
  if (playing && playbackPage && playbackDraft) {
    const playbackTransition = getSlideTransition(transitions, playbackPage.id);
    const playbackAnimStyle = slideTransitionAnimationStyle(playbackTransition);
    const playbackPageAnims = getPageShapeAnimations(shapeAnimations, playbackPage.id);
    const playbackTotalSteps = buildAnimationSteps(playbackPageAnims).length;
    const playbackIndex = playable.findIndex((page) => page.id === playbackPage.id);
    const playbackInkStrokes = presenterInkByPage[playbackPage.id] ?? [];
    const canStepPrev = playbackAnimStep > 0 || playbackIndex > 0;
    const canStepNext = playbackAnimStep < playbackTotalSteps || (playbackIndex >= 0 && playbackIndex < playable.length - 1);
    const advancePlayback = () => {
      const next = stepPresentationForward(playable, playbackPage.id, playbackAnimStep, shapeAnimations);
      if (!next) return;
      if (next.pageId !== playbackPage.id) setCurrent(next.pageId);
      setPlaybackAnimStep(next.animStep);
    };
    const retreatPlayback = () => {
      const prev = stepPresentationBackward(playable, playbackPage.id, playbackAnimStep, shapeAnimations);
      if (!prev) return;
      if (prev.pageId !== playbackPage.id) setCurrent(prev.pageId);
      setPlaybackAnimStep(prev.animStep);
    };
    const handlePresenterToolChange = (nextTool: PresenterTool) => {
      setPresenterTool(nextTool);
      if (nextTool !== "laser") setPresenterLaserTrail([]);
    };
    return (
      <div ref={playbackRef} tabIndex={-1} aria-label={audienceWindow ? "演示者视图" : "幻灯片放映"} className="fixed inset-0 z-[80] outline-none" data-slides-playing>
        {audienceWindow ? <>
          <PresenterView
            pages={playable}
            currentId={playbackPage.id}
            content={playbackDraft.content}
            contentFor={(page) => queue.get(page).content}
            textStyles={textStyles}
            transitions={transitions}
            animations={shapeAnimations}
            animStep={playbackAnimStep}
            onAnimStepChange={setPlaybackAnimStep}
            tool={presenterTool}
            onToolChange={handlePresenterToolChange}
            inkColor={presenterInkColor}
            onInkColorChange={setPresenterInkColor}
            laserTrail={presenterLaserTrail}
            onLaserTrailChange={setPresenterLaserTrail}
            inkByPage={presenterInkByPage}
            onInkByPageChange={setPresenterInkByPage}
            externalKeyNav
            onSelect={(id) => { setCurrent(id); setPlaybackAnimStep(0); }}
            onExit={stopPresentation}
          />
          {createPortal(
            <div aria-label="观众视图" className="flex h-dvh items-center justify-center bg-black">
              <style>{`${SLIDE_TRANSITION_KEYFRAMES_CSS}\n${SLIDE_ANIMATION_KEYFRAMES_CSS}`}</style>
              <div className="w-full overflow-hidden" style={{ width: "min(100vw, calc(100dvh * 16 / 9))" }}>
                <div key={playbackPage.id} data-slide-transition={playbackTransition} style={playbackAnimStyle}>
                  <SlideSurface
                    content={playbackDraft.content}
                    textStyle={textStyles[playbackPage.id]}
                    animations={playbackPageAnims}
                    animationStep={playbackTotalSteps > 0 ? playbackAnimStep : undefined}
                    inkStrokes={playbackInkStrokes}
                    laserTrail={presenterTool === "laser" ? presenterLaserTrail : undefined}
                  />
                </div>
              </div>
            </div>,
            audienceMountRef.current!,
          )}
        </> : <div className="flex h-full flex-col items-center justify-center bg-[#1f2329] p-4 pb-16 sm:p-10 sm:pb-20">
          <style>{`${SLIDE_TRANSITION_KEYFRAMES_CSS}\n${SLIDE_ANIMATION_KEYFRAMES_CSS}`}</style>
          <div className="w-full max-w-[1280px] shrink-0 overflow-hidden" style={{ width: "min(100%, calc((100dvh - 7.5rem) * 16 / 9))" }}>
            <PresenterStageInteractive
              tool={presenterTool}
              inkColor={presenterInkColor}
              pageId={playbackPage.id}
              onLaserMove={(pt) => setPresenterLaserTrail((prev) => pushLaserTrailPoint(prev, pt))}
              onLaserLeave={() => setPresenterLaserTrail([])}
              onInkStart={(pid, pt, color) => setPresenterInkByPage((prev) => startInkStroke(prev, pid, pt, color))}
              onInkMove={(pid, pt) => setPresenterInkByPage((prev) => appendInkPoint(prev, pid, pt))}
            >
              <div key={playbackPage.id} data-slide-transition={playbackTransition} style={playbackAnimStyle}>
                <SlideSurface
                  content={playbackDraft.content}
                  textStyle={textStyles[playbackPage.id]}
                  animations={playbackPageAnims}
                  animationStep={playbackTotalSteps > 0 ? playbackAnimStep : undefined}
                  inkStrokes={playbackInkStrokes}
                  laserTrail={presenterTool === "laser" ? presenterLaserTrail : undefined}
                />
              </div>
            </PresenterStageInteractive>
          </div>
          <div className="absolute bottom-3 flex flex-wrap items-center justify-center gap-2.5 px-3">
            <div className="flex items-center gap-3 rounded-xl border border-white/12 bg-[#252629]/95 px-3 py-1.5 text-[13px] text-white shadow-[0_8px_24px_rgba(0,0,0,0.45)] backdrop-blur-md">
              <button type="button" disabled={!canStepPrev} onClick={retreatPlayback} className="rounded px-1.5 py-0.5 hover:bg-white/10 disabled:opacity-40">上一页</button>
              <span className="tabular-nums">{playbackIndex + 1} / {playable.length}</span>
              {playbackTotalSteps > 0 && (
                <span data-presenter-anim-step className="rounded bg-[#3370ff]/25 px-1.5 py-0.5 text-[11px] tabular-nums text-[#94bfff]">
                  动画 {playbackAnimStep}/{playbackTotalSteps}
                </span>
              )}
              <button type="button" disabled={!canStepNext} onClick={advancePlayback} className="rounded px-1.5 py-0.5 hover:bg-white/10 disabled:opacity-40">下一页</button>
              <span className="h-4 w-px bg-white/15" aria-hidden="true" />
              <button type="button" onClick={stopPresentation} className="rounded px-1.5 py-0.5 text-[#f2f3f5] hover:bg-white/10">退出放映</button>
            </div>
            <PresenterToolDock
              tool={presenterTool}
              inkColor={presenterInkColor}
              hasInk={playbackInkStrokes.length > 0}
              onToolChange={handlePresenterToolChange}
              onInkColorChange={setPresenterInkColor}
              onClearInk={() => setPresenterInkByPage((prev) => clearSlideInk(prev, playbackPage.id))}
            />
          </div>
        </div>}
      </div>
    );
  }

  const beginPageAction = () => { pageActionCount.current++; setPageActions(pageActionCount.current); };
  const endPageAction = () => { pageActionCount.current--; setPageActions(pageActionCount.current); };
  const mergeBackgroundPages = (after: Page[]) => {
    const byId = new Map(after.map((page) => [page.id, page]));
    qc.setQueryData<Page[]>(["slides", deckId, userId], (old) => old?.map((page) => { const saved = byId.get(page.id); return saved && page.revision <= saved.revision ? { ...saved, pos: page.pos, meta: page.meta, updatedAt: Date.parse(page.updatedAt) > Date.parse(saved.updatedAt) ? page.updatedAt : saved.updatedAt } : page; }));
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
  const canDownload = !meta.isError && !meta.isFetching && canDownloadDocument(meta.data);
  const structureTop = (redo: boolean): SlideStructureAction | undefined => structureHistory[redo ? "redo" : "undo"].at(-1);
  const structurePreferred = (redo: boolean): boolean => {
    const top = structureTop(redo);
    if (!top) return false;
    if (!active) return true;
    const hasContent = redo ? queue.canRedo(active) : queue.canUndo(active);
    if (!hasContent) return true;
    return top.seq > (pageEditClock.current.get(active.id) ?? 0);
  };
  const tryStructureHistory = (redo: boolean): boolean => {
    const top = structureHistoryRef.current[redo ? "redo" : "undo"].at(-1);
    if (!top || !structurePreferred(redo)) return false;
    if (!canEdit || !pages.isSuccess || pages.isFetching || queue.hasUnsaved() || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) {
      setOperationError("请等待页面保存和刷新完成后再撤销或重做。");
      return true;
    }
    const key = ["slides", deckId, userId];
    setOperationError("");
    beginPageAction();
    void (async () => {
      try {
        if ((top.kind === "delete" && !redo) || (top.kind === "insert" && redo)) {
          const res = await slidesApi.restorePage(deckId, userId, top.snapshot, top.index);
          qc.setQueryData<Page[]>(key, res.pages);
          activePageRef.current = res.page.id;
          setCurrent(res.page.id);
          setSelectedShape(null);
          setStructureHistory((history) => commitStructureTravel(history, redo, top, { ...top, pageId: res.page.id }));
          void invalidate();
          return;
        }
        if ((top.kind === "delete" && redo) || (top.kind === "insert" && !redo)) {
          const latestList = qc.getQueryData<Page[]>(key) ?? list;
          const targetIdx = latestList.findIndex((item) => item.id === top.pageId);
          const target = targetIdx >= 0 ? latestList[targetIdx] : undefined;
          if (!target) {
            setOperationError("目标页面已不存在，无法继续撤销或重做。");
            void invalidate();
            return;
          }
          const src = queue.get(target);
          if (src.state !== "saved") {
            setOperationError("目标页面正在保存，请稍后重试。");
            return;
          }
          const latestSnap = snapshotSlidePage(src.page);
          const receipt = await slidesApi.removeVersion(deckId, src.page.id, userId, src.page.revision);
          if (!validSlideDeleteReceipt(receipt, src.page)) throw new Error("invalid delete receipt");
          const next = latestList[targetIdx + 1] ?? latestList[targetIdx - 1];
          qc.setQueryData<Page[]>(key, (old) => old?.filter((item) => item.id !== src.page.id));
          if (activePageRef.current === src.page.id) {
            activePageRef.current = next?.id ?? null;
            setCurrent(next?.id ?? null);
            setSelectedShape(null);
          }
          setStructureHistory((history) =>
            commitStructureTravel(history, redo, top, { ...top, index: targetIdx, snapshot: latestSnap }),
          );
          void invalidate();
          return;
        }
        if (top.kind === "reorder") {
          const latestList = qc.getQueryData<Page[]>(key) ?? list;
          const snap = slidePositions(latestList);
          const targetIndex = redo ? top.toIndex : top.fromIndex;
          const currentIndex = snap.findIndex((item) => item.id === top.pageId);
          if (currentIndex < 0 || targetIndex < 0 || targetIndex >= snap.length || currentIndex === targetIndex) {
            setOperationError("页面顺序已变化，无法撤销或重做排序。");
            void invalidate();
            return;
          }
          const response = await slidesApi.reorder(deckId, userId, snap, top.pageId, targetIndex);
          const result = verifySlideOrder(snap, top.pageId, targetIndex, response?.positions);
          if (!result) throw new Error("invalid order receipt");
          const positions = new Map(result.map((item) => [item.id, item.pos]));
          qc.setQueryData<Page[]>(key, (old) =>
            old && samePositions(snap, slidePositions(old))
              ? [...old].map((item) => ({ ...item, pos: positions.get(item.id)! })).sort((a, b) => a.pos - b.pos)
              : old,
          );
          setStructureHistory((history) => commitStructureTravel(history, redo, top, top));
          void invalidate();
          return;
        }
        if (top.kind === "visibility") {
          const latestList = qc.getQueryData<Page[]>(key) ?? list;
          const target = latestList.find((item) => item.id === top.pageId);
          if (!target) {
            setOperationError("目标页面已不存在，无法撤销或重做隐藏状态。");
            void invalidate();
            return;
          }
          const src = queue.get(target);
          if (src.state !== "saved") {
            setOperationError("目标页面正在保存，请稍后重试。");
            return;
          }
          const desired = redo ? top.afterHidden : top.beforeHidden;
          const saved = await slidesApi.setPageHidden(deckId, src.page.id, userId, src.page.revision, desired);
          if (!saved || saved.id !== src.page.id || saved.hidden !== desired) throw new Error("invalid visibility response");
          if (!queue.acceptVisibility(src.page, saved)) {
            setVisibilityUnknown(true);
            setOperationError("页面状态已变化，请刷新后核对。");
            void invalidate();
            return;
          }
          qc.setQueryData<Page[]>(key, (old) => old?.map((item) => item.id === saved.id && item.revision <= saved.revision ? saved : item));
          setStructureHistory((history) => commitStructureTravel(history, redo, top, top));
          void invalidate();
        }
      } catch (error) {
        const msg = error instanceof ApiError ? error.message : "页面撤销/重做未完成，请刷新后核对。";
        setOperationError(msg);
        void invalidate();
      } finally {
        endPageAction();
      }
    })();
    return true;
  };
  structureHistoryAction.current = tryStructureHistory;

  const exportPptx = () => {
    if (!canDownload || !list.length) return;
    setFileMenu(false);
    setOperationError("");
    try {
      const deckTitle = (meta.data.title || "未命名幻灯片").trim() || "未命名幻灯片";
      const exportPages = list.map((page) => {
        const item = queue.get(page);
        return {
          title: item.content.title,
          body: item.content.body,
          background: item.content.background,
          layout: item.content.layout ?? "",
          notes: item.content.notes,
          shapes: item.content.shapes,
          hidden: page.hidden,
        };
      });
      const bytes = exportSlidesToPptx(exportPages, { title: deckTitle });
      const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${deckTitle.replace(/[\\/:*?"<>|]+/g, "_")}.pptx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setClipboardNotice("已导出 PPTX 演示文稿。");
    } catch (error) {
      setOperationError(error instanceof Error ? `导出 PPTX 失败：${error.message}` : "导出 PPTX 失败，请重试。");
    }
  };

  const handlePptxFile = async (file: File) => {
    if (!canEdit) return;
    setFileMenu(false);
    setOperationError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await parsePptxToSlides(bytes);
      setImportPreview({ fileName: file.name, parsed });
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "无法解析该 PPTX 文件，请检查格式。");
    }
  };

  const confirmImportPptx = async () => {
    if (!importPreview || !canEdit || importingPptx || queue.hasUnsaved() || pageActionCount.current > 0) return;
    setImportingPptx(true);
    setOperationError("");
    beginPageAction();
    try {
      const res = await slidesApi.importPptx(deckId, userId, importPreview.parsed.pages);
      const importedPages = res.pages ?? [];
      qc.setQueryData<Page[]>(["slides", deckId, userId], importedPages);
      const firstId = importedPages[0]?.id ?? null;
      activePageRef.current = firstId;
      setCurrent(firstId);
      setSelectedShape(null);
      setBackgroundHistory({ undo: [], redo: [] });
      setStructureHistory(emptyStructureHistory());
      pageEditClock.current.clear();
      setImportPreview(null);
      setClipboardNotice(`已导入 ${importedPages.length} 页幻灯片。`);
      void invalidate();
    } catch (error) {
      setOperationError(error instanceof ApiError ? error.message : "导入 PPTX 失败，请稍后重试。");
      void invalidate();
    } finally {
      setImportingPptx(false);
      endPageAction();
    }
  };

  const printSlides = () => {
    if (!canDownload || !list.length) return;
    setFileMenu(false);
    window.print();
  };
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
      resetPresenterState();
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
      setStructureHistory((history) =>
        pushStructureAction(history, { kind: "reorder", seq: ++historyClock.current, pageId: page.id, fromIndex: from, toIndex: to }),
      );
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
      setStructureHistory((history) =>
        pushStructureAction(history, {
          kind: "visibility",
          seq: ++historyClock.current,
          pageId: saved.id,
          beforeHidden: base.hidden,
          afterHidden: hidden,
        }),
      );
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
      const before = qc.getQueryData<Page[]>(["slides", deckId, userId]) ?? [];
      const srcIndex = before.findIndex((item) => item.id === page.id);
      setStructureHistory((history) =>
        pushStructureAction(history, {
          kind: "insert",
          seq: ++historyClock.current,
          pageId: copy.id,
          index: srcIndex < 0 ? before.length : srcIndex + 1,
          snapshot: snapshotSlidePage(copy),
        }),
      );
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
    if (!await ask("删除此页？", "删除后可通过撤销恢复。")) return;
    const latest = qc.getQueryData<Page[]>(["slides", deckId, userId])?.find((item) => item.id === page.id);
    if (!canEditRef.current || activePageRef.current !== page.id || !latest || latest.revision !== version || deletingPage.current || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) { setOperationError("页面或编辑状态已变化，请核对后重新操作。"); return; }
    const current = queue.get(latest);
    if (current.state !== "saved" || current.page.revision !== version || !sameSlideContent(current.content, content)) { setOperationError("页面已变化，请核对后重新操作。"); return; }
    setOperationError(""); deletingPage.current = true; beginPageAction(); remove.mutate(current.page);
  };
  const applyBackgroundToAll = async (overrideColor?: string, themeForStyles?: SlideThemePreset) => {
    if (!canEdit || !active || !pages.isSuccess || pages.isFetching || queue.hasUnsaved() || pageActionCount.current || insertingPage.current || create.isPending || remove.isPending) return;
    const before = list.map((page) => queue.get(page).page);
    const color = overrideColor ?? queue.get(active).content.background;
    if (!before.length || before.length > 1000 || !/^(|#[0-9a-f]{6})$/i.test(color)) { setOperationError("背景颜色或页面数量不受支持。"); return; }
    setOperationError(""); setBackgroundApplying(true); beginPageAction();
    try {
      const response = await slidesApi.applyBackground(deckId, userId, color, before.map(({ id, revision }) => ({ id, revision })));
      const after = applyBackgroundReceipts(before, color, response?.pages);
      const id = ++backgroundBatchSequence.current;
      if (!after || !queue.acceptBackgroundBatch(before, after, id)) { setBackgroundBatchUnknown(true); setOperationError("背景已提交，但页面状态发生变化；请保留内容并重新打开核对。"); void invalidate(); return; }
      mergeBackgroundPages(after);
      if (themeForStyles) {
        const pageIds = after.map((page) => page.id);
        const nextStyles = applyThemeToTextStyles(textStylesRef.current, pageIds, themeForStyles);
        textStylesRef.current = nextStyles;
        setTextStyles(nextStyles);
        await persistBatchPagesMeta({
          titleStyle: { color: themeForStyles.titleColor },
          bodyStyle: { color: themeForStyles.bodyColor },
        });
      }
      if (before.some((page, index) => page.background !== after[index].background)) setBackgroundHistory((history) => ({ undo: [...history.undo, { id, before, after }].slice(-50), redo: [] }));
      void invalidate();
    } catch (error) {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (!known) setBackgroundBatchUnknown(true);
      setOperationError(known ? error.status === 409 ? "页面已变化，未应用背景，请刷新后重试。" : error.status === 404 || error.status === 405 ? "服务端不支持批量设置背景，请升级后重试。" : error.message : "应用结果未确认，请重新打开并检查背景后再编辑。");
      void invalidate();
    } finally { setBackgroundApplying(false); endPageAction(); }
  };
  const applyTransitionToAll = (kind: SlideTransitionKind) => {
    const pageIds = list.map((page) => page.id);
    const next = applyTransitionToAllPages(transitionsRef.current, pageIds, kind);
    transitionsRef.current = next;
    setTransitions(next);
    void persistBatchPagesMeta({ transition: kind });
    setClipboardNotice(kind === "none" ? "已清除全部页面的切换动画。" : "已将切换动画应用到全部页面。");
  };
  const openPageMenu = (page: Page, x: number, y: number) => {
    activePageRef.current = page.id; setCurrent(page.id); setSelectedShape(null);
    setPageMenu({ id: page.id, ...slidePageMenuPosition(x, y, window.innerWidth, window.innerHeight) });
  };
  const undoBg = historyAvailable(false) || historyBlocksPartial(false);
  const redoBg = historyAvailable(true) || historyBlocksPartial(true);
  const undoStruct = !undoBg && structurePreferred(false);
  const redoStruct = !redoBg && structurePreferred(true);
  const canUndoAny = canEdit && (undoBg || structureHistory.undo.length > 0 || (!!active && queue.canUndo(active)));
  const canRedoAny = canEdit && (redoBg || structureHistory.redo.length > 0 || (!!active && queue.canRedo(active)));
  const undoLabel = undoBg ? "撤销整份背景" : undoStruct ? structureActionLabel(structureTop(false), false) : "撤销本页内容";
  const redoLabel = redoBg ? "重做整份背景" : redoStruct ? structureActionLabel(structureTop(true), true) : "重做本页内容";
  const printablePages = playable.length ? playable : list;
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#f5f6f7]" data-slides-editor data-document-print-restricted={!canDownload ? "true" : undefined}>
      <style>{`${SLIDE_TRANSITION_KEYFRAMES_CSS}\n${SLIDE_ANIMATION_KEYFRAMES_CSS}`}</style>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b bg-white pl-14 pr-2 sm:gap-2 sm:pr-3 md:px-5">
        <button type="button" onClick={() => { location.hash = "#/drive/mine"; }} aria-label="返回云盘" className="grid size-7 shrink-0 place-items-center rounded-md text-[#646a73] hover:bg-[#f2f3f5] sm:size-8"><ChevronLeft size={17}/></button>
        <span className="hidden size-7 shrink-0 place-items-center rounded-md bg-[#ff8800] text-white sm:grid"><Presentation size={15}/></span>
        <div className="min-w-0 flex-1 sm:flex-none"><SlideDeckTitle meta={meta.data} userId={userId} verified={!meta.isFetching && !meta.isError} draft={titleDraft} setDraft={setTitleDraft} busy={titleSaving} onSaved={(base, entry) => { qc.setQueryData<DocMeta>(["slides-meta", deckId, userId], (current) => current && current.id === entry.id && current.driveRevision === base.revision && current.title === base.title ? { ...current, title: entry.title, driveRevision: entry.revision, updatedAt: entry.updatedAt } : current); void qc.invalidateQueries({ queryKey: ["slides-meta", deckId, userId] }); void qc.invalidateQueries({ queryKey: ["docs"] }); void qc.invalidateQueries({ queryKey: ["drive"] }); void qc.invalidateQueries({ queryKey: ["recent"] }); }}/><div className="truncate text-[11px] text-[#8f959e]">{titleDraft?.phase === "saving" || draft?.state === "saving" ? "正在保存…" : titleDraft?.phase === "unknown" ? "名称保存未确认" : titleDraft && titleDraft.value !== titleDraft.base.title ? "名称未保存" : draft?.state === "saved" ? "已保存" : draft ? "有未保存内容" : "演示文稿"}</div></div>
        <div className={cn("ml-auto flex shrink-0 items-center gap-1 sm:gap-2", titleDraft && "hidden sm:flex")}>
          {collaborators.length > 0 && (
            <div data-slides-collaborators className="hidden items-center gap-1 sm:flex" aria-label="在线协作者">
              {collaborators.slice(0, 5).map((peer) => {
                const peerSlideIdx = peer.pageId ? list.findIndex((p) => p.id === peer.pageId) : -1;
                const peerTitle = peerSlideIdx >= 0 ? `${peer.name}（正在查看第 ${peerSlideIdx + 1} 页，点击定位）` : `${peer.name} 在线`;
                return (
                  <button
                    key={peer.userId}
                    type="button"
                    title={peerTitle}
                    data-slides-collaborator={peer.userId}
                    onClick={() => {
                      if (peer.pageId && list.some((p) => p.id === peer.pageId)) {
                        activePageRef.current = peer.pageId;
                        setCurrent(peer.pageId);
                        setSelectedShape(null);
                      }
                    }}
                    className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white ring-2 ring-white transition-transform hover:scale-105"
                    style={{ backgroundColor: slidePeerColor(peer.userId) }}
                  >
                    {(peer.name.trim()[0] || "?").toUpperCase()}
                  </button>
                );
              })}
              {collaborators.length > 5 && <span className="rounded-full bg-[#f2f3f5] px-1.5 py-0.5 text-[11px] text-[#646a73]">+{collaborators.length - 5}</span>}
            </div>
          )}
          <div ref={fileMenuRef} className="relative">
            <button type="button" aria-label="导入与导出" title="导入 / 导出" aria-haspopup="menu" aria-expanded={fileMenu} data-slides-file-menu onClick={() => setFileMenu((open) => !open)} className="flex h-8 items-center gap-1 rounded-md border border-[#d0d3d6] px-2 text-[12px] text-[#4e5969] hover:bg-[#f2f3f5]"><Download size={14}/><span className="hidden sm:inline">导入/导出</span></button>
            {fileMenu && (
              <div role="menu" aria-label="导入与导出" className="absolute right-0 top-10 z-[70] w-44 rounded-lg border border-[#dee0e3] bg-white p-1 text-[13px] text-[#1f2329] shadow-lg">
                <button role="menuitem" type="button" data-slides-import-pptx disabled={!canEdit || importingPptx || queue.hasUnsaved() || pageActions > 0} onClick={() => { setFileMenu(false); pptxInputRef.current?.click(); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><FileUp size={14}/>导入 PPTX</button>
                <button role="menuitem" type="button" data-slides-export-pptx disabled={!canDownload || !list.length} title={!canDownload ? "当前文档权限禁止导出" : "导出为标准 PowerPoint (.pptx)"} onClick={exportPptx} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><FileDown size={14}/>导出 PPTX</button>
                <button role="menuitem" type="button" data-slides-print-pdf disabled={!canDownload || !list.length} title={!canDownload ? "当前文档权限禁止导出或打印" : "打印或另存为 PDF"} onClick={printSlides} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><Printer size={14}/>打印 / 导出 PDF</button>
                <button role="menuitem" type="button" disabled={backgroundBatchUnknown || deletePageUnknown || copyingDeck || queue.hasUnsaved() || uploadingImage || create.isPending || remove.isPending || pageActions > 0} onClick={() => { setFileMenu(false); void duplicateDeck(); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5] disabled:opacity-40 sm:hidden"><Copy size={14}/>创建副本</button>
              </div>
            )}
            <input ref={pptxInputRef} type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" aria-label="选择要导入的 PPTX 文件" data-slides-pptx-input className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void handlePptxFile(file); }}/>
          </div>
          <button type="button" aria-label="创建整份幻灯片副本" title={backgroundBatchUnknown || deletePageUnknown ? "请先重新打开并核对页面" : queue.hasUnsaved() ? "请先等待内容保存" : "创建副本"} disabled={backgroundBatchUnknown || deletePageUnknown || copyingDeck || queue.hasUnsaved() || uploadingImage || create.isPending || remove.isPending || pageActions > 0} onClick={() => void duplicateDeck()} className="hidden size-8 shrink-0 place-items-center rounded-md border border-[#d0d3d6] text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-40 sm:grid" data-slides-copy>{copyingDeck ? <span className="text-[11px]">…</span> : <Copy size={14}/>}</button>
          <ResourceReferencesButton id={deckId} userId={userId} title={meta.data?.title || "未命名幻灯片"} kind="slides" />
          <button
            type="button"
            data-slides-comments-btn
            aria-label="评论批注"
            title="评论批注"
            aria-pressed={extrasPanel === "comments"}
            onClick={() => {
              setExtrasPanel((prev) => (prev === "comments" ? null : "comments"));
              setFormatOpen(false);
            }}
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-md border text-[#646a73] transition-colors",
              extrasPanel === "comments" ? "border-[#3370ff] bg-[#edf2ff] text-[#3370ff]" : "border-[#d0d3d6] hover:bg-[#f2f3f5]",
            )}
          >
            <MessageSquare size={14} />
          </button>
          <button
            type="button"
            data-slides-versions-btn
            aria-label="历史版本"
            title="历史版本"
            aria-pressed={extrasPanel === "versions"}
            onClick={() => {
              setExtrasPanel((prev) => (prev === "versions" ? null : "versions"));
              setFormatOpen(false);
            }}
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-md border text-[#646a73] transition-colors",
              extrasPanel === "versions" ? "border-[#3370ff] bg-[#edf2ff] text-[#3370ff]" : "border-[#d0d3d6] hover:bg-[#f2f3f5]",
            )}
          >
            <History size={14} />
          </button>
          <button ref={shareRef} type="button" onClick={() => setSharing(true)} className="h-8 rounded-md bg-[#3370ff] px-2 text-[13px] font-medium text-white hover:bg-[#245bdb] sm:px-3">分享</button>
          <div ref={playMenuRef} className="relative flex h-8 rounded-md border border-[#3370ff] text-[#3370ff]">
            <button type="button" aria-label={checkingPlayback ? "检查中…" : "演示"} disabled={!playable.length || visibilityUnknown || backgroundBatchUnknown || deletePageUnknown || checkingPlayback || pageActions > 0 || create.isPending || remove.isPending} title="从当前页开始演示" onClick={() => { setPlayMenu(false); void startPresentation(); }} className="flex items-center gap-1 rounded-l-md bg-white px-2 text-[13px] hover:bg-[#f5f6f7] disabled:opacity-40 sm:px-3"><Play size={13}/><span className="hidden sm:inline">{checkingPlayback ? "检查中…" : "演示"}</span></button>
            <button type="button" aria-label="演示选项" aria-haspopup="menu" aria-expanded={playMenu} disabled={!playable.length || visibilityUnknown || backgroundBatchUnknown || deletePageUnknown || checkingPlayback || pageActions > 0 || create.isPending || remove.isPending} onClick={() => setPlayMenu((open) => !open)} className="grid w-6 place-items-center rounded-r-md border-l border-[#3370ff] bg-white hover:bg-[#f5f6f7] disabled:opacity-40 sm:w-7"><ChevronDown size={14}/></button>
            {playMenu && <div role="menu" aria-label="演示选项" className="absolute right-0 top-10 z-[70] w-40 rounded-lg border border-[#dee0e3] bg-white p-1 text-[13px] text-[#1f2329] shadow-lg"><button role="menuitem" type="button" onClick={() => { setPlayMenu(false); void startPresentation(); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5]"><Play size={14}/>从当前开始</button><button role="menuitem" type="button" onClick={() => { setPlayMenu(false); void startPresentation(false, true); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5]"><Presentation size={14}/>演示者视图</button><button role="menuitem" type="button" onClick={() => { setPlayMenu(false); void startPresentation(true); }} className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-[#f2f3f5]"><Presentation size={14}/>从头开始</button></div>}
          </div>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        {showSlideList ? <aside className="order-2 flex h-24 w-full shrink-0 flex-row items-center border-t border-[#dee0e3] bg-white md:order-none md:h-auto md:w-[196px] md:flex-col md:items-stretch md:border-r md:border-t-0" data-slides-list onCopy={(event) => { const row = (event.target as HTMLElement).closest<HTMLElement>("[data-slides-page]"); const page = list.find((item) => item.id === Number(row?.dataset.slidesPage)); const text = page && clipboardReference(page); if (!text) return; event.preventDefault(); event.clipboardData.setData("text/plain", text); setOperationError(""); setClipboardNotice("已复制幻灯片，可粘贴到其他演示文稿。"); }} onPaste={(event) => { const row = (event.target as HTMLElement).closest<HTMLElement>("[data-slides-page]"); const page = list.find((item) => item.id === Number(row?.dataset.slidesPage)); if (!page) return; const text = event.clipboardData.getData("text/plain"); if (!parseSlideClipboard(text)) return; event.preventDefault(); pasteReference(text, page.id); }}>
          <div className="flex h-full shrink-0 flex-col items-center justify-center gap-1 border-r border-[#e5e6eb] px-2 md:h-14 md:w-full md:flex-row md:border-r-0 md:px-3"><div className="flex h-8 w-16 rounded-md border border-[#d0d3d6] bg-white md:min-w-0 md:flex-1"><button type="button" aria-label="新建幻灯片" title="新建幻灯片" disabled={!canInsert} onClick={() => doInsert(active)} className="flex min-w-0 flex-1 items-center justify-center gap-1 rounded-l-md text-[12px] text-[#1f2329] hover:bg-[#f5f6f7] disabled:opacity-40"><FilePlus2 size={14} className="shrink-0"/><span className="hidden whitespace-nowrap md:inline">新建幻灯片</span></button><button ref={layoutTriggerRef} type="button" disabled={!canInsert} aria-label="选择布局新建幻灯片" aria-haspopup="dialog" aria-expanded={!!layoutPicker} onClick={() => setLayoutPicker((open) => open ? null : { anchor: active })} className="grid w-7 shrink-0 place-items-center rounded-r-md border-l border-[#d0d3d6] text-[#646a73] hover:bg-[#f5f6f7] disabled:opacity-40"><ChevronDown size={14}/></button></div><button type="button" aria-label="收起幻灯片列表" onClick={() => { setLayoutPicker(null); setShowSlideList(false); }} className="grid size-7 shrink-0 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><ChevronsLeft size={15}/></button></div>
          {layoutPicker && layoutTriggerRef.current && createPortal(<div ref={layoutPickerRef} role="dialog" aria-label="选择布局新建" style={slideCreatePickerPosition(layoutTriggerRef.current.getBoundingClientRect(), window.innerWidth, window.innerHeight)} className="fixed z-[100] overflow-auto rounded-lg border border-[#dee0e3] bg-white shadow-[0_6px_24px_rgba(31,35,41,0.16)]"><SlideCreateLayoutPicker onSelect={(layout) => { const anchor = layoutPicker.anchor; setLayoutPicker(null); if (!canInsert || (anchor?.id ?? null) !== (active?.id ?? null) || (anchor && (!active || queue.get(active).page.revision !== anchor.revision))) { setOperationError("当前页面已变化，请重新选择布局。"); return; } doInsert(anchor, layout); }}/></div>, document.body)}
          <div ref={slideListRef} className="mobile-scroll-x flex h-full min-w-0 flex-1 flex-row items-center gap-2.5 overflow-y-hidden px-2.5 py-2 md:min-h-0 md:flex-col md:items-stretch md:gap-0 md:space-y-2 md:overflow-x-hidden md:overflow-y-auto md:px-2 md:pb-4 md:pt-0">
            {list.map((page, index) => {
              const item = queue.get(page);
              const pagePeers = collaborators.filter((c) => c.pageId === page.id);
              return <div key={page.id} className={cn("group relative flex w-[116px] shrink-0 gap-1 md:mb-0 md:w-auto md:shrink md:[@media(pointer:coarse)]:mb-6", dropMarker?.id === page.id && (dropMarker.after ? "after:absolute after:-bottom-1 after:left-5 after:right-0 after:h-0.5 after:bg-[#3370ff]" : "before:absolute before:-top-1 before:left-5 before:right-0 before:h-0.5 before:bg-[#3370ff]"))} data-slides-page={page.id} onContextMenu={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openPageMenu(page, event.clientX || rect.left, event.clientY || rect.bottom); }}>
                <span className={cn("w-4 pt-1 text-right text-[11px] text-[#8f959e]", page.hidden && "line-through")}>{index + 1}</span>
                <button type="button" draggable={false} onPointerDown={(event) => beginPageDrag(event, page, false)} onPointerMove={movePageDrag} onPointerUp={endPageDrag} onPointerCancel={stopPageDrag} onLostPointerCapture={() => { if (dragPage.current) stopPageDrag(); }} onClick={() => { if (suppressPageClick.current) return; activePageRef.current = page.id; setCurrent(page.id); setSelectedShape(null); }} onKeyDown={(event) => { if (!event.shiftKey && !event.altKey && event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "m") { event.preventDefault(); doInsert(page); } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "d") { event.preventDefault(); doCopy(page); } }} aria-label={`第 ${index + 1} 页 ${item.content.title || "未命名"}${page.hidden ? "，已隐藏" : ""}`} className={cn("relative aspect-video min-w-0 flex-1 overflow-hidden rounded-[4px] border-2 bg-white text-left shadow-sm", active?.id === page.id ? "border-[#3370ff]" : "border-transparent hover:border-[#c8d4f4]")} style={{ backgroundColor: item.content.background || "#fff", containerType: "inline-size" }}><SlideSurface content={item.content} textStyle={textStyles[page.id]} showPlaceholder/>{pagePeers.length > 0 && <span className="pointer-events-none absolute bottom-1 left-1 flex items-center gap-0.5">{pagePeers.slice(0, 3).map((peer) => <span key={peer.userId} data-slide-peer-badge={peer.userId} title={`${peer.name} 正在查看此页`} className="inline-flex h-4 items-center justify-center rounded-full px-1 text-[9px] font-medium text-white shadow-sm sm:px-1.5" style={{ backgroundColor: slidePeerColor(peer.userId) }}><span className="sm:hidden">{peer.name.slice(0, 1)}</span><span className="hidden sm:inline">{peer.name.slice(0, 4)}</span></span>)}</span>}{page.hidden && <span className="absolute bottom-1 right-1 grid size-5 place-items-center rounded bg-[#f2f3f5] text-[#646a73]" title="已隐藏"><EyeOff size={13}/></span>}</button>
                <button type="button" aria-label={`拖动第 ${index + 1} 页排序`} title="拖动排序" disabled={!canEdit || orderUnknown || queue.hasUnsaved()} onPointerDown={(event) => beginPageDrag(event, page, true)} onPointerMove={movePageDrag} onPointerUp={endPageDrag} onPointerCancel={stopPageDrag} onLostPointerCapture={() => { if (dragPage.current) stopPageDrag(); }} className="absolute -bottom-6 left-5 right-0 hidden h-6 touch-none select-none place-items-center rounded text-[#8f959e] active:bg-[#e8efff] active:text-[#3370ff] disabled:opacity-40 md:[@media(pointer:coarse)]:grid"><GripHorizontal size={16}/></button>
                <button type="button" aria-label={`第 ${index + 1} 页更多操作`} aria-haspopup="menu" aria-expanded={pageMenu?.id === page.id} data-slide-options={page.id} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openPageMenu(page, rect.right, rect.bottom); }} className={cn("absolute right-1 top-1 grid size-7 place-items-center rounded bg-white/90 text-[#646a73] shadow-sm hover:bg-[#f2f3f5] focus:pointer-events-auto focus:opacity-100 sm:pointer-events-auto sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100", active?.id === page.id ? "opacity-100" : "pointer-events-none opacity-0")}><MoreHorizontal size={16}/></button>
              </div>;
            })}
            {!list.length && pages.isSuccess && <p className="px-2 py-6 text-center text-[12px] text-[#8f959e]">暂无幻灯片</p>}
          </div>
        </aside> : <div className="order-2 flex h-9 w-full shrink-0 items-center justify-center border-t border-[#dee0e3] bg-white md:order-none md:block md:h-auto md:w-9 md:border-r md:border-t-0 md:pt-3 md:text-center"><button type="button" aria-label="展开幻灯片列表" onClick={() => setShowSlideList(true)} className="inline-grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><ChevronsRight size={15}/></button></div>}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="mobile-scroll-x flex h-14 shrink-0 items-center gap-1 whitespace-nowrap border-b border-[#e5e6eb] bg-white px-2 text-[12px] text-[#4e5969] sm:px-3 [&>button]:shrink-0 [&>button]:whitespace-nowrap" data-slides-toolbar>
            <div className="flex shrink-0 items-center gap-0.5 border-r border-[#e5e6eb] pr-2">
              <button type="button" data-slides-undo aria-label={undoLabel} title={`${undoLabel} (⌘/Ctrl+Z)`} disabled={!canUndoAny} onClick={() => { if (!tryBackgroundHistory(false) && !tryStructureHistory(false) && active) { queue.undo(active); const living = new Set(queue.get(active).content.shapes.map((shape) => shape.id)); setSelectedShapes((prev) => prev.filter((id) => living.has(id))); } }} className="flex h-12 min-w-10 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-30"><Undo2 size={15}/><span>撤销</span></button>
              <button type="button" data-slides-redo aria-label={redoLabel} title={`${redoLabel} (⌘/Ctrl+Shift+Z)`} disabled={!canRedoAny} onClick={() => { if (!tryBackgroundHistory(true) && !tryStructureHistory(true) && active) { queue.redo(active); const living = new Set(queue.get(active).content.shapes.map((shape) => shape.id)); setSelectedShapes((prev) => prev.filter((id) => living.has(id))); } }} className="flex h-12 min-w-10 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-30"><Redo2 size={15}/><span>重做</span></button>
            </div>
            <div className="flex min-w-max flex-1 items-center justify-center gap-1">
            <button type="button" disabled={!canEdit || !active || draft?.content.shapes.length === 100} onClick={() => addShape("text")} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Type size={16}/>文本</button>
            <div className="relative shrink-0"><button ref={shapeButtonRef} type="button" disabled={!canEdit || !active} aria-haspopup="dialog" aria-expanded={shapeMenu} onClick={() => setShapeMenu((open) => !open)} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Shapes size={16}/>图形</button></div>
            <button type="button" disabled={!canEdit || !active || uploadingImage || draft?.content.shapes.length === 100} onClick={() => imageInputRef.current?.click()} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><ImageIcon size={16}/>{uploadingImage ? "上传中" : "图片"}</button>
            <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" aria-label="选择幻灯片图片" className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void insertImage(file); }}/>
            <button type="button" data-slides-insert-table disabled={!canEdit || !active || draft?.content.shapes.length === 100} onClick={() => addShape("table")} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Table2 size={16}/>表格</button>
            <button type="button" data-slides-insert-chart disabled={!canEdit || !active || draft?.content.shapes.length === 100} onClick={() => addShape("chart")} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><BarChart3 size={16}/>图表</button>
            <button ref={backgroundButtonRef} type="button" disabled={!active} aria-expanded={formatOpen} onClick={() => setFormatOpen((open) => !open)} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Palette size={16}/>格式</button>
            <span className="mx-1 h-5 w-px bg-[#e5e6eb]" />
            <button type="button" aria-label="复制页面" disabled={!canEdit || !active || draft?.state !== "saved" || copyPageUnknown || visibilityUnknown || pageActions > 0} onClick={() => active && doCopy(active)} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Copy size={15}/>复制</button>
            <button type="button" disabled={!canEdit || !active || draft?.state !== "saved" || remove.isPending} onClick={() => { if (active) void doRemove(active); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><Trash2 size={15}/>删除</button>
            <button type="button" disabled={!canEdit || orderUnknown || queue.hasUnsaved() || !active || list.findIndex((page) => page.id === active.id) <= 0} onClick={() => { if (!active) return; const i = list.findIndex((page) => page.id === active.id); doMove(active, i - 1); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><ArrowUp size={15}/>上移</button>
            <button type="button" disabled={!canEdit || orderUnknown || queue.hasUnsaved() || !active || list.findIndex((page) => page.id === active.id) >= list.length - 1} onClick={() => { if (!active) return; const i = list.findIndex((page) => page.id === active.id); doMove(active, i + 1); }} className="flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] hover:bg-[#f2f3f5] disabled:opacity-40"><ArrowDown size={15}/>下移</button>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-3" role="group" aria-label="幻灯片缩放"><button type="button" aria-label="缩小幻灯片" onClick={() => setManualZoom(clampSlideZoom(zoom - 10))} className="grid size-7 place-items-center rounded-l border border-[#d0d3d6] hover:bg-[#f2f3f5]"><Minus size={14}/></button><label className="flex h-7 items-center border-y border-[#d0d3d6] text-[#646a73]"><input aria-label="幻灯片缩放比例" inputMode="decimal" value={zoomText} onFocus={(event) => { zoomEditing.current = true; event.currentTarget.select(); }} onChange={(event) => setZoomText(event.target.value)} onBlur={() => { if (!zoomEditing.current) return; zoomEditing.current = false; const value = parseSlideZoom(zoomText); if (value !== null) { setManualZoom(value); setZoomText(String(value)); } else setZoomText(String(zoom)); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { zoomEditing.current = false; setZoomText(String(zoom)); event.currentTarget.blur(); } }} className="w-9 bg-transparent text-right text-[12px] outline-none"/><span className="pr-1">%</span></label><button type="button" aria-label="放大幻灯片" onClick={() => setManualZoom(clampSlideZoom(zoom + 10))} className="grid size-7 place-items-center rounded-r border border-[#d0d3d6] hover:bg-[#f2f3f5]"><Plus size={14}/></button><button type="button" aria-label="适合屏幕" title="适合屏幕" onClick={() => setManualZoom(null)} className="ml-1 grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Maximize2 size={14}/></button></div>
          </div>
          {shapeMenu && shapeButtonRef.current && createPortal(<div ref={shapeMenuRef} role="dialog" aria-label="选择图形" style={slideShapePickerPosition(shapeButtonRef.current.getBoundingClientRect(), window.innerWidth, window.innerHeight)} className="fixed z-[100] overflow-hidden rounded-lg border border-[#dee0e3] bg-white shadow-[0_6px_24px_rgba(31,35,41,0.16)]"><SlideShapePicker onSelect={addShape}/></div>, document.body)}
          {(operationError || visibilityUnknown || create.isError || remove.isError) && <p role="alert" className="bg-[#fff2f0] px-4 py-2 text-[12px] text-[#d83931]">{operationError || (visibilityUnknown ? "隐藏状态未能确认，请重新打开并检查后再放映。" : "操作未完成，请刷新后检查。")}{createdCopyId && <a className="ml-2 underline" href={`#/slides/${createdCopyId}`}>打开已创建的副本</a>}</p>}
          {clipboardNotice && <p role="status" className="bg-[#f2f6ff] px-4 py-2 text-[12px] text-[#3370ff]">{clipboardNotice}<button type="button" onClick={() => setClipboardNotice("")} className="ml-3 underline">关闭</button></p>}
          {draft && (draft.state === "conflict" || draft.state === "unknown") && <p role="alert" className="bg-[#fff2f0] px-4 py-2 text-[12px] text-[#d83931]">{draft.state === "conflict" ? "此页已被其他人修改。" : "保存结果未确认。"}你的输入仍在页面中，请复制保留后重新打开。</p>}
          {draft?.state === "pending" && !canDraft && <div role="alert" className="bg-[#fff2f0] px-4 py-2 text-[12px] text-[#d83931]">权限尚未确认，输入仍保留在本地，未发送到服务器。<SlidesDraftRecovery queue={queue}/></div>}
          <div className="relative flex min-h-0 flex-1 flex-col">
          {chosenShape && canEdit && <SlideShapeControls shape={chosenShape} onChange={(patch) => updateShape(chosenShape.id, patch)} onOrder={(action) => orderShape(chosenShape.id, action)} onAlign={(alignment) => alignShape(chosenShape.id, alignment)} onDelete={() => { if (active) { const nextShapes = queue.get(active).content.shapes.filter((shape) => shape.id !== chosenShape.id); const livingIds = new Set(nextShapes.map((shape) => shape.id)); queue.edit(active, { shapes: nextShapes }); updatePageGroups(active.id, (prev) => pruneShapeGroups(prev, livingIds)); updatePageAnimations(active.id, (prev) => pruneShapeAnimations(prev, livingIds)); } setSelectedShape(null); }}/>}
          {multiSelectedCount > 1 && canEdit && (
            <SlideMultiShapeControls
              count={multiSelectedCount}
              grouped={multiSelectionGrouped}
              onGroup={groupSelectedShapes}
              onUngroup={ungroupSelectedShapes}
              onAlign={alignSelectedShapes}
              onDistributeHorizontal={distributeSelectedHorizontally}
              onDistributeVertical={distributeSelectedVertically}
              onDelete={deleteSelectedShapes}
            />
          )}
          {activeSelectedShapes.length === 0 && canDraft && active && draft && activeTextField?.pageId === active.id && (() => {
            const isTitle = activeTextField.kind === "title";
            const dark = isDarkSlideBackground(draft.content.background);
            const large = hasLargeSlideTitle(draft.content.layout);
            const currentStyle = isTitle ? (textStyles[active.id]?.title ?? {}) : (textStyles[active.id]?.body ?? {});
            return (
              <SlideTextControls
                target={activeTextField.kind}
                style={currentStyle}
                defaultFontSize={isTitle ? (large ? 54 : 36) : 21}
                defaultBold={isTitle}
                defaultAlign={isTitle && draft.content.layout === "title" ? "center" : "left"}
                defaultColor={dark ? (isTitle ? "#ffffff" : "#e5e7eb") : "#1f2329"}
                bulleted={!isTitle && bodyHasBullets(draft.content.body)}
                onChange={(patch) => patchFieldStyle(active.id, activeTextField.kind, patch)}
                onReset={() => resetFieldStyle(active.id, activeTextField.kind)}
                onToggleBullet={!isTitle ? () => queue.edit(active, { body: toggleBodyBullets(draft.content.body) }, "body") : undefined}
              />
            );
          })()}
          <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto">
            <div className="flex min-h-full min-w-full p-2 sm:p-4">
              {active && draft ? (() => {
                const titleStyle = textStyles[active.id]?.title;
                const bodyStyle = textStyles[active.id]?.body;
                const titleInlineStyle = titleStyle ? {
                  ...(titleStyle.fontSize !== undefined ? { fontSize: `${titleStyle.fontSize}px` } : {}),
                  ...(titleStyle.bold !== undefined ? { fontWeight: titleStyle.bold ? 700 : 400 } : {}),
                  ...(titleStyle.italic ? { fontStyle: "italic" as const } : {}),
                  ...(titleStyle.color ? { color: titleStyle.color } : {}),
                  ...(titleStyle.align ? { textAlign: titleStyle.align } : {}),
                } : undefined;
                const bodyInlineStyle = bodyStyle ? {
                  ...(bodyStyle.fontSize !== undefined ? { fontSize: `${bodyStyle.fontSize}px` } : {}),
                  ...(bodyStyle.bold !== undefined ? { fontWeight: bodyStyle.bold ? 700 : 400 } : {}),
                  ...(bodyStyle.italic ? { fontStyle: "italic" as const } : {}),
                  ...(bodyStyle.color ? { color: bodyStyle.color } : {}),
                  ...(bodyStyle.align ? { textAlign: bodyStyle.align } : {}),
                } : undefined;
                const keepTextToolbar = (related: EventTarget | null) =>
                  related instanceof Element && (!!related.closest("[data-slides-text-controls]") || !!related.closest('[role="listbox"]'));
                return <div
                  className={cn("group/slide relative m-auto shrink-0 bg-white shadow-[0_4px_18px_rgba(31,35,41,0.12)]", transitionPreview && "overflow-hidden")}
                  style={{
                    width: SLIDE_WIDTH * zoom / 100,
                    height: SLIDE_HEIGHT * zoom / 100,
                    backgroundColor: gpuActive ? "transparent" : draft.content.background || "#fff",
                    ...(transitionPreview ? slideTransitionAnimationStyle(transitionPreview.kind) : {}),
                  }}
                  data-slides-canvas
                  data-slide-transition-preview={transitionPreview?.kind}
                  onPointerDown={(event) => {
                    const target = event.target instanceof Element ? event.target : null;
                    if (!target || target.closest("[data-slide-object]")) return;
                    queue.endGroup(active.id);
                    if (!event.shiftKey) setSelectedShapes([]);
                    if (!target.closest("[data-slides-title]") && !target.closest("[data-slides-body]") && !target.closest("[data-slides-text-controls]")) {
                      setActiveTextField(null);
                    }
                    if (!canEdit || event.button !== 0 || target.closest("input, textarea, button, [data-slides-title], [data-slides-body], [data-slides-text-controls]")) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    if (!rect.width || !rect.height) return;
                    const startPctX = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
                    const startPctY = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100));
                    marqueeDrag.current = {
                      pointerId: event.pointerId,
                      startClientX: event.clientX,
                      startClientY: event.clientY,
                      startPctX,
                      startPctY,
                      rect,
                      baseSelection: event.shiftKey ? activeSelectedShapes : [],
                      active: false,
                    };
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      /* synthetic pointer events may not support capture */
                    }
                  }}
                  onPointerMove={(event) => {
                    const m = marqueeDrag.current;
                    if (!m || m.pointerId !== event.pointerId) return;
                    if (!m.active && Math.hypot(event.clientX - m.startClientX, event.clientY - m.startClientY) < 4) return;
                    m.active = true;
                    const curPctX = Math.min(100, Math.max(0, ((event.clientX - m.rect.left) / m.rect.width) * 100));
                    const curPctY = Math.min(100, Math.max(0, ((event.clientY - m.rect.top) / m.rect.height) * 100));
                    const nextRect: SlideRect = {
                      x: Math.min(m.startPctX, curPctX),
                      y: Math.min(m.startPctY, curPctY),
                      width: Math.abs(curPctX - m.startPctX),
                      height: Math.abs(curPctY - m.startPctY),
                    };
                    setMarqueeRect(nextRect);
                    const hits = shapesInMarquee(draft.content.shapes, nextRect);
                    const expanded = expandSelectionWithGroups([...m.baseSelection, ...hits], activePageGroups, existingShapeIdSet);
                    setSelectedShapes(expanded);
                  }}
                  onPointerUp={(event) => {
                    if (marqueeDrag.current?.pointerId === event.pointerId) {
                      marqueeDrag.current = null;
                      setMarqueeRect(null);
                    }
                  }}
                  onPointerCancel={(event) => {
                    if (marqueeDrag.current?.pointerId === event.pointerId) {
                      marqueeDrag.current = null;
                      setMarqueeRect(null);
                    }
                  }}
                >
                <SlidesGpuLayer background={draft.content.background} shapes={(previewShapes ? draft.content.shapes.map((s) => previewShapes.get(s.id) ?? s) : draft.content.shapes).filter((s) => s.kind !== "chart" && s.id !== shapeAnimPreview?.shapeId)} selectedId={selectedShape} onBackendReady={(backend) => { if (backend === "webgpu" || backend === "webgl2") setGpuActive(true); }} />
                <div className="absolute left-0 top-0 z-[1]" style={{ width: SLIDE_WIDTH, height: SLIDE_HEIGHT, padding: hasLargeSlideTitle(draft.content.layout) ? 0 : "48px 57.6px", transform: `scale(${zoom / 100})`, transformOrigin: "top left", containerType: "inline-size" }}>
                  {(!isBlankSlideLayout(draft.content.layout) || draft.content.title || titleFocusPage === active.id) && <input ref={titleRef} aria-label="幻灯片标题" value={draft.content.title} readOnly={!canDraft} style={titleInlineStyle} onFocus={() => { setSelectedShape(null); setTitleFocusPage(active.id); setActiveTextField({ pageId: active.id, kind: "title" }); }} onChange={(event) => queue.edit(active, { title: event.target.value }, "title")} onBlur={(event) => { setTitleFocusPage(null); queue.endGroup(active.id); if (!keepTextToolbar(event.relatedTarget)) setActiveTextField((prev) => prev?.kind === "title" ? null : prev); }} placeholder={draft.content.layout === "title" ? "点击修改大标题样式" : "点击添加标题"} className={cn("border border-transparent bg-transparent px-2 py-1 font-semibold leading-tight outline-none focus:border-[#3370ff] focus:placeholder:text-[#b8bec5]", isDarkSlideBackground(draft.content.background) ? "text-white" : "text-[#1f2329]", hasLargeSlideTitle(draft.content.layout) ? cn("absolute left-[9.5%] top-[41.3%] w-[81%] text-[54px]", isDarkSlideBackground(draft.content.background) ? "placeholder:text-white/80" : "placeholder:text-[#1f2329]", draft.content.layout === "title" ? "text-center" : "text-left") : "w-full text-[36px] placeholder:text-transparent group-hover/slide:placeholder:text-[#b8bec5] [@media(hover:none)]:placeholder:text-[#b8bec5]")} data-slides-title data-slide-history />}
                  {draft.content.layout === "blank" && !draft.content.title && titleFocusPage !== active.id && !!draft.content.body && <div aria-hidden="true" className="h-[55px]"/>}
                  {((draft.content.layout !== "title" && !isBlankSlideLayout(draft.content.layout)) || draft.content.body || bodyFocusPage === active.id) && <textarea aria-label="幻灯片正文" value={draft.content.body} readOnly={!canDraft} style={bodyInlineStyle} onFocus={() => { setSelectedShape(null); setBodyFocusPage(active.id); setActiveTextField({ pageId: active.id, kind: "body" }); }} onChange={(event) => queue.edit(active, { body: event.target.value }, "body")} onBlur={(event) => { setBodyFocusPage(null); queue.endGroup(active.id); if (!keepTextToolbar(event.relatedTarget)) setActiveTextField((prev) => prev?.kind === "body" ? null : prev); }} placeholder="点击添加正文" className={cn("resize-none border border-transparent bg-transparent px-2 py-1 text-[21px] leading-relaxed outline-none placeholder:text-transparent focus:border-[#3370ff] focus:placeholder:text-[#b8bec5] group-hover/slide:placeholder:text-[#b8bec5] [@media(hover:none)]:placeholder:text-[#b8bec5]", isDarkSlideBackground(draft.content.background) ? "text-[#e5e7eb]" : "text-[#1f2329]", hasLargeSlideTitle(draft.content.layout) ? "absolute left-[9.5%] top-[60%] h-[27%] w-[81%]" : "mt-[4%] h-[55%] w-full")} data-slides-body data-slide-history />}
                  <SlideShapes shapes={draft.content.shapes} editable={canEdit} textEditable={canDraft} selected={selectedShape} selectedIds={activeSelectedShapes} pageGroups={activePageGroups} animations={activePageAnimations} previewAnimShapeId={shapeAnimPreview?.shapeId ?? null} previewAnimNonce={shapeAnimPreview?.nonce ?? 0} scale={zoom / 100} gpuBacked={gpuActive} onPreviewManyChange={setPreviewShapes} onOpenInspector={() => setFormatOpen(true)} onSelect={(id) => { if (id !== selectedShape) queue.endGroup(active.id); setActiveTextField(null); setSelectedShapes([id]); }} onSelectMany={(ids) => { queue.endGroup(active.id); setActiveTextField(null); setSelectedShapes(ids); }} onChange={(shape) => updateShape(shape.id, { x: shape.x, y: shape.y, width: shape.width, height: shape.height, rotation: shape.rotation })} onChangeMany={(nextShapes) => replaceShapes(nextShapes)} onTextChange={(id, text) => { flushSync(() => { const shapes = patchSlideShape(queue.get(active).content.shapes, id, { text }); queue.edit(active, { shapes }, `text:${id}`); }); }} onTextBlur={() => queue.endGroup(active.id)}/>
                  {marqueeRect && (
                    <div
                      data-slides-marquee
                      aria-hidden="true"
                      className="pointer-events-none absolute z-20 rounded-[2px] border border-[#3370ff] bg-[#3370ff]/12"
                      style={{
                        left: `${marqueeRect.x}%`,
                        top: `${marqueeRect.y}%`,
                        width: `${marqueeRect.width}%`,
                        height: `${marqueeRect.height}%`,
                      }}
                    />
                  )}
                </div>
                <input ref={backgroundRef} type="color" value={/^#[0-9a-f]{6}$/i.test(draft.content.background) ? draft.content.background : "#ffffff"} disabled={!canEdit} onChange={(event) => { if (backgroundTarget.current === active.id && activePageRef.current === active.id && canEditRef.current && !pageActionCount.current) queue.edit(active, { background: event.target.value }); }} className="sr-only" aria-label="幻灯片背景颜色" />
              </div>; })() : <div className="m-auto flex flex-col items-center gap-3 text-[13px] text-[#8f959e]"><ImageIcon size={32} strokeWidth={1.2}/><span>新建一页，开始制作幻灯片</span></div>}
            </div>
          </div>
          </div>
          {active && draft && <SlideNotesPanel value={draft.content.notes} readOnly={!canDraft} onChange={(notes) => queue.edit(active, { notes }, "notes")} onBlur={() => queue.endGroup(active.id)}/>}
          <footer className="flex h-9 shrink-0 items-center justify-between border-t border-[#e5e6eb] bg-white px-4 text-[12px] text-[#8f959e]"><span>{active ? `${list.findIndex((page) => page.id === active.id) + 1} / ${list.length}` : "0 / 0"}</span><span className="hidden sm:inline">使用方向键切换放映页面</span></footer>
        </section>
      </div>
      {formatOpen && active && draft && (
        <>
          <div className="fixed inset-0 z-30 bg-black/25 md:hidden" aria-hidden="true" onClick={() => { setFormatOpen(false); backgroundButtonRef.current?.focus(); }} />
          <div
            data-slides-format-overlay
            className="fixed inset-y-0 right-0 z-40 flex w-[min(100vw,360px)] shadow-xl md:static md:z-auto md:w-auto md:shrink-0 md:shadow-none [&>aside]:h-full [&>aside]:max-h-none [&>aside]:w-full [&>aside]:border-t-0 md:[&>aside]:w-[294px]"
          >
            <SlideFormatPanel key={active.id} background={draft.content.background} layout={draft.content.layout ?? ""} shapes={draft.content.shapes} selectedShape={chosenShape ?? null} usedColors={list.map((page) => queue.get(page).content.background)} textStyle={textStyles[active.id]} transition={getSlideTransition(transitions, active.id)} pageAnimations={activePageAnimations} canEdit={canEdit} busy={pageActions > 0 || pages.isFetching || queue.hasUnsaved()} applying={backgroundApplying} onChange={(color) => { if (canEdit && !pageActionCount.current && activePageRef.current === active.id) queue.edit(active, { background: color }); }} onLayoutChange={(layout) => { if (!canEdit || pageActionCount.current || activePageRef.current !== active.id) return; const plan = planSlideLayout(queue.get(active).content, layout); if (!plan.ok) { setOperationError(plan.message); return; } setOperationError(""); setSelectedShape(null); queue.edit(active, plan.content); }} onMore={() => { if (canEdit && activePageRef.current === active.id) { backgroundTarget.current = active.id; backgroundRef.current?.click(); } }} onApplyAll={() => void applyBackgroundToAll()} onApplyTheme={(theme) => { if (!canEdit || pageActionCount.current || activePageRef.current !== active.id) return; applyPageThemeStyle(active.id, theme); }} onApplyThemeAll={(theme) => void applyBackgroundToAll(theme.background, theme)} onTransitionChange={(kind) => { if (canEdit && activePageRef.current === active.id) updatePageTransition(active.id, kind); }} onPreviewTransition={(kind) => triggerTransitionPreview(kind)} onApplyTransitionAll={(kind) => { if (canEdit) applyTransitionToAll(kind); }} onShapeChange={(id, patch) => { if (canEdit && activePageRef.current === active.id) updateShape(id, patch); }} onShapeAnimationChange={(shapeId, anim) => { if (canEdit && activePageRef.current === active.id) updatePageAnimations(active.id, (prev) => setShapeAnimation(prev, shapeId, anim)); }} onPreviewShapeAnimation={(shapeId, anim) => triggerShapeAnimPreview(shapeId, anim)} onClose={() => { setFormatOpen(false); backgroundButtonRef.current?.focus(); }}/>
          </div>
        </>
      )}
      {extrasPanel && (
        <>
          <div className="fixed inset-0 z-30 bg-black/25 md:hidden" aria-hidden="true" onClick={() => setExtrasPanel(null)} />
          <div
            data-slides-extras-overlay
            className="fixed inset-y-0 right-0 z-40 flex w-[min(100vw,360px)] shadow-xl md:static md:z-auto md:w-auto md:shrink-0 md:shadow-none"
          >
            <SlidesExtrasPanel
              key={extrasPanel}
              deckId={deckId}
              userId={userId}
              currentPageId={active?.id ?? null}
              selectedShapeId={selectedShape}
              pageIndexById={new Map(list.map((p, idx) => [p.id, idx + 1]))}
              canEdit={canEdit}
              canManage={meta.data?.role === "manage"}
              initialTab={extrasPanel}
              onJumpPage={(pageId) => {
                setCurrent(pageId);
                setSelectedShape(null);
              }}
              onRestored={(restoredPages) => {
                qc.setQueryData(["slides", deckId, userId], restoredPages);
                if (restoredPages.length > 0) setCurrent(restoredPages[0].id);
                setSelectedShape(null);
                void qc.invalidateQueries({ queryKey: ["slides", deckId, userId] });
              }}
              onClose={() => setExtrasPanel(null)}
            />
          </div>
        </>
      )}
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
      {sharing && <ShareDialog meta={meta.data} userId={userId} onClose={() => setSharing(false)} anchorRef={shareRef}/>}
      {importPreview && (
        <div role="dialog" aria-modal="true" aria-label="确认导入 PPTX" data-slides-import-modal className="fixed inset-0 z-[90] grid place-items-center bg-black/35 p-4">
          <div className="w-full max-w-md rounded-xl border border-[#dee0e3] bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-semibold text-[#1f2329]">确认导入 PPTX</h2>
                <p className="mt-1 text-[12px] text-[#646a73]">{importPreview.fileName}</p>
              </div>
              <button type="button" aria-label="关闭导入确认框" disabled={importingPptx} onClick={() => setImportPreview(null)} className="grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-40"><X size={15}/></button>
            </div>
            <div className="mt-4 rounded-lg bg-[#f5f6f7] p-3 text-[13px] text-[#1f2329]">
              <p>共解析 <strong>{importPreview.parsed.pages.length}</strong> 页幻灯片、<strong>{importPreview.parsed.shapeCount}</strong> 个图形/文本框元素。</p>
              <ul className="mt-2 space-y-1 text-[12px] text-[#646a73]">
                {importPreview.parsed.pages.slice(0, 5).map((pg, idx) => (
                  <li key={idx} className="truncate">第 {idx + 1} 页：{pg.title || "（无标题）"}{pg.hidden ? " [已隐藏]" : ""}</li>
                ))}
                {importPreview.parsed.pages.length > 5 && <li>…其余 {importPreview.parsed.pages.length - 5} 页</li>}
              </ul>
            </div>
            {importPreview.parsed.warnings.length > 0 && (
              <div className="mt-3 rounded-lg bg-[#fff7e8] p-2.5 text-[12px] text-[#b25900]">
                {importPreview.parsed.warnings.map((w, i) => <p key={i}>{w}</p>)}
              </div>
            )}
            <p className="mt-3 text-[12px] text-[#d83931]">注意：确认后将替换当前演示文稿的全部页面，请确保无需保留原内容或先创建副本。</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={importingPptx} onClick={() => setImportPreview(null)} className="h-8 rounded-md border border-[#d0d3d6] px-3 text-[13px] text-[#1f2329] hover:bg-[#f2f3f5] disabled:opacity-40">取消</button>
              <button type="button" data-slides-import-confirm disabled={importingPptx} onClick={() => void confirmImportPptx()} className="h-8 rounded-md bg-[#3370ff] px-3 text-[13px] font-medium text-white hover:bg-[#245bdb] disabled:opacity-40">{importingPptx ? "导入中…" : "确认导入"}</button>
            </div>
          </div>
        </div>
      )}
      {canDownload && printablePages.length > 0 && (
        <div data-slides-print-deck aria-hidden="true">
          {printablePages.map((page) => {
            const item = queue.get(page);
            return (
              <div key={page.id} data-slides-print-page style={{ backgroundColor: item.content.background || "#fff", containerType: "inline-size" }}>
                <SlideSurface content={item.content} textStyle={textStyles[page.id]}/>
              </div>
            );
          })}
        </div>
      )}
      <DocumentWatermark
        workspaceId={meta.data?.workspaceId}
        userName={me?.user.name}
        userEmail={me?.user.email}
        copyProtected={!!meta.data?.copyProtected}
      />
    </main>
  );
}

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Maximize2, Minus, Network, Plus, Search, X } from "lucide-react";
import { navigateDocumentHash } from "@/editor/block-handle";
import { t, useI18n } from "@/lib/i18n";
import { referenceKindMeta, referenceNodeHref, type DocumentReferenceItem, type DocumentReferences } from "./document-references";
import {
  layoutDocumentReferenceGraph,
  layoutMultiHopReferenceGraph,
  multiHopGraphBounds,
  referenceGraphBounds,
  referenceGraphPath,
  type MultiHopReferenceGraph,
  type PositionedMultiHopNode,
  type ReferenceGraphNode,
} from "./document-reference-graph-layout";
import { clampGraphZoom, fitGraphZoom, GRAPH_MAX_ZOOM, GRAPH_MIN_ZOOM, graphAnchorScroll, screenToGraph, stepGraphZoom, type GraphPoint } from "./document-reference-graph-viewport";

export interface ReferenceSearchDoc { id: number; title: string; kind?: string; docType?: string }
interface SearchResult { docs: ReferenceSearchDoc[]; truncated: boolean }
const VALID_SEARCH_KINDS = new Set(["doc", "sheet", "base", "slides", "survey"]);

export async function searchReferenceDocuments(query: string, userId: number, signal: AbortSignal): Promise<SearchResult> {
  const response = await fetch(`/api/account-document-search?q=${encodeURIComponent(query)}`, { credentials: "same-origin", cache: "no-store", signal, headers: { "X-Jiange-User-Id": String(userId) } });
  if (!response.ok) throw new Error(t("文档搜索未完成，请重试。"));
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error(t("文档搜索结果无效。"));
  const result = value as Partial<SearchResult>;
  if (
    !Array.isArray(result.docs) ||
    result.docs.length > 30 ||
    typeof result.truncated !== "boolean" ||
    !result.docs.every(
      (doc) =>
        doc &&
        Number.isSafeInteger(doc.id) &&
        doc.id > 0 &&
        typeof doc.title === "string" &&
        (doc.kind === undefined || (typeof doc.kind === "string" && VALID_SEARCH_KINDS.has(doc.kind))) &&
        (doc.docType === undefined || typeof doc.docType === "string")
    )
  ) {
    throw new Error(t("文档搜索结果无效。"));
  }
  return result as SearchResult;
}

type Center = { id: number; title: string; kind?: string; docType?: string };
type LoadReferences = (id: number, userId: number, signal: AbortSignal) => Promise<DocumentReferences>;
type LoadReferenceGraph = (id: number, userId: number, depth: 1 | 2 | 3, signal: AbortSignal) => Promise<MultiHopReferenceGraph>;

const name = (title: string) => title.trim() || t("未命名文档");
const shortName = (title: string) => { const chars = [...name(title)]; return chars.length > 13 ? `${chars.slice(0, 12).join("")}…` : chars.join(""); };

function GraphNodeGlyph({ x, y, r, kind, docType }: { x: number; y: number; r: number; kind?: string; docType?: string }) {
  const s = r / 17;
  if (kind === "sheet") {
    return (
      <path
        d={`M ${x - 6 * s} ${y - 4 * s} h ${12 * s} M ${x - 6 * s} ${y} h ${12 * s} M ${x - 6 * s} ${y + 4 * s} h ${12 * s} M ${x} ${y - 4 * s} v ${8 * s}`}
        stroke="white"
        strokeWidth={1.5 * s}
        strokeLinecap="round"
      />
    );
  }
  if (kind === "base") {
    return (
      <g fill="white">
        <rect x={x - 5.5 * s} y={y - 5.5 * s} width={4.5 * s} height={4.5 * s} rx={1 * s} />
        <rect x={x + 1 * s} y={y - 5.5 * s} width={4.5 * s} height={4.5 * s} rx={1 * s} opacity="0.82" />
        <rect x={x - 5.5 * s} y={y + 1 * s} width={4.5 * s} height={4.5 * s} rx={1 * s} opacity="0.82" />
        <rect x={x + 1 * s} y={y + 1 * s} width={4.5 * s} height={4.5 * s} rx={1 * s} />
      </g>
    );
  }
  if (kind === "slides") {
    return <path d={`M ${x - 3.5 * s} ${y - 5 * s} L ${x + 5.5 * s} ${y} L ${x - 3.5 * s} ${y + 5 * s} Z`} fill="white" />;
  }
  if (kind === "survey") {
    return (
      <path
        d={`M ${x - 5.5 * s} ${y - 2 * s} l ${2.5 * s} ${2.5 * s} l ${5 * s} ${-5 * s} M ${x - 5.5 * s} ${y + 4.5 * s} h ${11 * s}`}
        fill="none"
        stroke="white"
        strokeWidth={1.6 * s}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  if (docType === "board") {
    return (
      <g>
        <circle cx={x - 3.5 * s} cy={y - 3.5 * s} r={2.2 * s} fill="white" />
        <rect x={x + 0.8 * s} y={y + 0.8 * s} width={4.6 * s} height={4.6 * s} rx={1 * s} fill="white" />
        <path d={`M ${x - 1.5 * s} ${y - 1.5 * s} L ${x + 1.5 * s} ${y + 1.5 * s}`} stroke="white" strokeWidth={1.5 * s} strokeLinecap="round" />
      </g>
    );
  }
  return (
    <path
      d={`M ${x - 6 * s} ${y - 4 * s} h ${12 * s} M ${x - 6 * s} ${y} h ${10 * s} M ${x - 6 * s} ${y + 4 * s} h ${6 * s}`}
      stroke="white"
      strokeWidth={1.5 * s}
      strokeLinecap="round"
    />
  );
}

export function DocumentReferenceGraph({
  rootId,
  rootTitle,
  rootKind = "doc",
  rootDocType,
  userId,
  enabled,
  synced = false,
  syncVersion = 0,
  loadReferences,
  loadGraph,
  defaultDepth = 2,
  onClose,
}: {
  rootId: number;
  rootTitle: string;
  rootKind?: string;
  rootDocType?: string;
  userId: number;
  enabled: boolean;
  synced?: boolean;
  syncVersion?: number;
  loadReferences: LoadReferences;
  loadGraph?: LoadReferenceGraph;
  defaultDepth?: 1 | 2 | 3;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [center, setCenter] = useState<Center>({ id: rootId, title: rootTitle, kind: rootKind, docType: rootDocType });
  const [depth, setDepth] = useState<1 | 2 | 3>(defaultDepth);
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [shareSelection, setShareSelection] = useState<{ id: number; title: string; kind?: string; href?: string } | null>(null);
  const searchListId = useId();
  const arrowMarkerId = useId();
  const pendingClick = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const pendingZoom = useRef<{ world: GraphPoint; screen: GraphPoint; centerId: number } | null>(null);
  const pinch = useRef<{ first: number; second: number; distance: number; initialZoom: number; world: GraphPoint; centerId: number } | null>(null);
  const suppressClickUntil = useRef(0);
  const pan = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchContainer = useRef<HTMLDivElement>(null);
  const closeAction = useRef(onClose);
  closeAction.current = onClose;
  useEffect(() => { const timer = setTimeout(() => setDebounced(input.trim()), 250); return () => clearTimeout(timer); }, [input]);
  useEffect(() => () => { if (pendingClick.current) clearTimeout(pendingClick.current); }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); if (searchContainer.current?.contains(document.activeElement) && searchRef.current?.value) { setInput(""); setSearchFocused(false); searchRef.current.focus(); } else closeAction.current(); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')].filter((item) => item.getClientRects().length > 0);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (i < 0 || (event.shiftKey && i === 0) || (!event.shiftKey && i === items.length - 1)) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
  }, []);

  const multiHopMode = !!loadGraph;
  const multiQuery = useQuery({
    queryKey: ["document-reference-graph", userId, center.id, depth],
    queryFn: ({ signal }) => loadGraph!(center.id, userId, depth, signal),
    enabled: enabled && multiHopMode,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const singleQuery = useQuery({
    queryKey: ["document-references", userId, center.id],
    queryFn: ({ signal }) => loadReferences(center.id, userId, signal),
    enabled: enabled && !multiHopMode,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const activeQuery = multiHopMode ? multiQuery : singleQuery;
  const lastRootVersion = useRef(syncVersion);
  useEffect(() => {
    if (!enabled || !synced || center.id !== rootId || syncVersion === lastRootVersion.current) return;
    const timer = setTimeout(() => { lastRootVersion.current = syncVersion; void activeQuery.refetch(); }, 700);
    return () => clearTimeout(timer);
  }, [enabled, synced, center.id, rootId, syncVersion, activeQuery.refetch]);

  const search = useQuery({ queryKey: ["reference-graph-search", userId, debounced], queryFn: ({ signal }) => searchReferenceDocuments(debounced, userId, signal), enabled: enabled && !!debounced && [...debounced].length <= 100, retry: false, refetchOnWindowFocus: true, refetchInterval: searchFocused ? 30_000 : false, refetchIntervalInBackground: false });
  useEffect(() => {
    if (enabled && searchFocused && debounced && input.trim() === debounced && search.isSuccess && !search.isFetching && Date.now() - search.dataUpdatedAt >= 30_000) void search.refetch();
  }, [enabled, searchFocused, debounced, input, search.isSuccess, search.isFetching, search.dataUpdatedAt, search.refetch]);
  const results = enabled && input.trim() === debounced && search.isSuccess && !search.isFetching && Date.now() - search.dataUpdatedAt < 30_000 ? search.data : undefined;

  const multiData = multiHopMode && enabled && multiQuery.isSuccess && !multiQuery.isFetching && Date.now() - multiQuery.dataUpdatedAt < 30_000 ? multiQuery.data : undefined;
  const singleData = !multiHopMode && enabled && singleQuery.isSuccess && !singleQuery.isFetching && Date.now() - singleQuery.dataUpdatedAt < 30_000 ? singleQuery.data : undefined;
  const hasData = !!(multiData || singleData);

  const multiLayout = useMemo(() => (multiData ? layoutMultiHopReferenceGraph(multiData) : null), [multiData]);
  const singleLayout = useMemo(() => (singleData ? layoutDocumentReferenceGraph(singleData) : null), [singleData]);
  const dimensions = multiLayout
    ? { width: multiLayout.width, height: multiLayout.height, centerX: multiLayout.centerX, centerY: multiLayout.centerY }
    : singleLayout
      ? { width: singleLayout.width, height: singleLayout.height, centerX: singleLayout.centerX, centerY: singleLayout.centerY }
      : null;

  const dimRef = useRef(dimensions);
  const centerIdRef = useRef(center.id);
  dimRef.current = dimensions;
  centerIdRef.current = center.id;
  useEffect(() => { if (!dimensions) { pinch.current = null; pendingZoom.current = null; } }, [dimensions]);

  const applyZoom = useCallback((value: number, screen: GraphPoint, fixedWorld?: GraphPoint) => {
    const el = canvas.current, image = svg.current, graph = dimRef.current;
    if (!el || !image || !graph) return;
    const rect = image.getBoundingClientRect();
    const world = fixedWorld ?? screenToGraph(screen, rect, graph);
    if (!world) return;
    const next = clampGraphZoom(value);
    pendingZoom.current = { world, screen, centerId: centerIdRef.current };
    if (next === zoomRef.current) {
      if (Math.abs(rect.width / graph.width - next) < 0.001) {
        const offset = graphAnchorScroll({ x: el.scrollLeft, y: el.scrollTop }, rect, graph, world, screen);
        if (offset) { el.scrollLeft = offset.x; el.scrollTop = offset.y; }
        pendingZoom.current = null;
      }
      return;
    }
    zoomRef.current = next;
    setZoom(next);
  }, []);
  const zoomAtCenter = (value: number, world?: GraphPoint) => {
    const el = canvas.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    applyZoom(value, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, world);
  };
  useLayoutEffect(() => {
    const pending = pendingZoom.current, el = canvas.current, image = svg.current;
    if (!pending || !el || !image || !dimensions || pending.centerId !== center.id) { if (pending && pending.centerId !== center.id) pendingZoom.current = null; return; }
    const offset = graphAnchorScroll({ x: el.scrollLeft, y: el.scrollTop }, image.getBoundingClientRect(), dimensions, pending.world, pending.screen);
    if (offset) { el.scrollLeft = offset.x; el.scrollTop = offset.y; }
    pendingZoom.current = null;
  }, [zoom, center.id, dimensions]);
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el || !dimensions) return;
    const centerCanvas = () => {
      el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
      el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2);
    };
    centerCanvas();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(centerCanvas);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [center.id, depth, dimensions?.width, dimensions?.height]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !dimRef.current) return;
      if (event.cancelable) event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      const delta = Math.max(-1000, Math.min(1000, event.deltaY * unit));
      applyZoom(zoomRef.current * Math.exp(-delta * 0.002), { x: event.clientX, y: event.clientY });
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !svg.current || !dimRef.current) {
        if (event.touches.length > 2 && pinch.current) { pinch.current = null; suppressClickUntil.current = Date.now() + 500; if (event.cancelable) event.preventDefault(); }
        return;
      }
      const [a, b] = [event.touches[0], event.touches[1]], distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const screen = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
      const world = screenToGraph(screen, svg.current.getBoundingClientRect(), dimRef.current);
      if (!world || !Number.isFinite(distance) || distance < 5) return;
      if (pendingClick.current) { clearTimeout(pendingClick.current); pendingClick.current = null; }
      pinch.current = { first: a.identifier, second: b.identifier, distance, initialZoom: zoomRef.current, world, centerId: centerIdRef.current };
      suppressClickUntil.current = Date.now() + 500;
      if (event.cancelable) event.preventDefault();
    };
    const move = (event: TouchEvent) => {
      const active = pinch.current;
      if (!active || active.centerId !== centerIdRef.current) return;
      const touches = Array.from(event.touches), a = touches.find((touch) => touch.identifier === active.first), b = touches.find((touch) => touch.identifier === active.second);
      if (!a || !b) return;
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (!Number.isFinite(distance)) return;
      if (event.cancelable) event.preventDefault();
      suppressClickUntil.current = Date.now() + 500;
      applyZoom(active.initialZoom * distance / active.distance, { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }, active.world);
    };
    const end = (event: TouchEvent) => { if (pinch.current && event.touches.length < 2) { pinch.current = null; suppressClickUntil.current = Date.now() + 500; } };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => { pinch.current = null; el.removeEventListener("wheel", wheel); el.removeEventListener("touchstart", start); el.removeEventListener("touchmove", move); el.removeEventListener("touchend", end); el.removeEventListener("touchcancel", end); };
  }, [applyZoom]);

  const centerOn = (item: { id: number; title: string; kind?: string; docType?: string; href?: string }) => {
    setSearchFocused(false); setInput("");
    if (item.href) { setShareSelection(item); return; }
    setShareSelection(null);
    setCenter({ id: item.id, title: item.title, kind: item.kind, docType: item.docType });
  };
  const openResource = (item: { id: number; kind?: string; href?: string }) => {
    if (pendingClick.current) clearTimeout(pendingClick.current);
    onClose();
    navigateDocumentHash(referenceNodeHref(item));
  };
  const clickNode = (item: { id: number; title: string; kind?: string; docType?: string; href?: string }) => {
    if (Date.now() < suppressClickUntil.current) return;
    if (pendingClick.current) clearTimeout(pendingClick.current);
    pendingClick.current = setTimeout(() => { pendingClick.current = null; centerOn(item); }, 350);
  };

  const centerTitle = multiLayout?.centerNode?.title ?? (center.id === rootId ? rootTitle : center.title);
  const centerKind = multiLayout?.centerNode?.kind ?? center.kind ?? "doc";
  const centerDocType = multiLayout?.centerNode?.docType ?? center.docType;
  const centerMeta = referenceKindMeta(centerKind, centerDocType);

  const renderSingleNode = (node: ReferenceGraphNode) => {
    const meta = referenceKindMeta(node.kind, node.docType);
    return (
      <g key={node.id} role="button" tabIndex={0} aria-label={t("{name}，点击切换关系中心，双击打开", { name: name(node.title) })} className="cursor-pointer outline-none" data-reference-graph-node={node.id} onClick={() => clickNode(node)} onDoubleClick={() => { if (Date.now() >= suppressClickUntil.current) openResource(node); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); centerOn(node); } }}>
        <title>{t("{name}（{kind}）", { name: name(node.title), kind: meta.label })}</title>
        <circle cx={node.x} cy={node.y} r="16" fill={meta.color} />
        <GraphNodeGlyph x={node.x} y={node.y} r={16} kind={node.kind} docType={node.docType} />
        <text x={node.x} y={node.y + 37} textAnchor="middle" fontSize="13" fill="#646A73" stroke="#F5F6F7" strokeWidth="4" strokeLinejoin="round" style={{ paintOrder: "stroke" }}>{shortName(node.title)}</text>
      </g>
    );
  };

  const renderMultiNode = (node: PositionedMultiHopNode) => {
    const meta = referenceKindMeta(node.kind, node.docType);
    const opacity = node.depth === 1 ? 1 : node.depth === 2 ? 0.92 : 0.84;
    return (
      <g key={node.id} role="button" tabIndex={0} aria-label={t("{name}（{kind}，{depth}跳），点击切换关系中心，双击打开", { name: name(node.title), kind: meta.label, depth: node.depth })} className="cursor-pointer outline-none" data-reference-graph-node={node.id} data-reference-graph-depth={node.depth} opacity={opacity} onClick={() => clickNode(node)} onDoubleClick={() => { if (Date.now() >= suppressClickUntil.current) openResource(node); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); centerOn(node); } }}>
        <title>{t("{name}（{kind} · {depth} 跳）", { name: name(node.title), kind: meta.label, depth: node.depth })}</title>
        {node.depth >= 2 && <circle cx={node.x} cy={node.y} r={node.radius + 4} fill="none" stroke={meta.color} strokeOpacity="0.32" strokeWidth="1.2" strokeDasharray="3 2" />}
        <circle cx={node.x} cy={node.y} r={node.radius} fill={meta.color} />
        <GraphNodeGlyph x={node.x} y={node.y} r={node.radius} kind={node.kind} docType={node.docType} />
        <text x={node.x} y={node.y + node.radius + 19} textAnchor="middle" fontSize={node.depth === 1 ? "13" : "12"} fill="#4E5969" stroke="#F5F6F7" strokeWidth="4" strokeLinejoin="round" style={{ paintOrder: "stroke" }}>{shortName(node.title)}</text>
        {node.depth >= 2 && <text x={node.x} y={node.y + node.radius + 33} textAnchor="middle" fontSize="10" fill="#8F959E" stroke="#F5F6F7" strokeWidth="3.5" strokeLinejoin="round" style={{ paintOrder: "stroke" }}>{t("{depth}跳 · {kind}", { depth: node.depth, kind: meta.short })}</text>}
      </g>
    );
  };

  return <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("文档关系图")} data-reference-graph className="fixed inset-0 z-[80] flex h-[100dvh] flex-col bg-[#F5F6F7] text-[#1F2329] outline-none">
    <header className="relative z-10 flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-[#DEE0E3] bg-white px-3 py-2 sm:flex-nowrap sm:gap-3 sm:px-5">
      <button ref={closeRef} type="button" aria-label={t("返回文档")} onClick={onClose} className="grid size-9 shrink-0 place-items-center rounded text-[#646A73] hover:bg-[#F2F3F5]"><ArrowLeft size={19}/></button>
      <span className="hidden h-6 w-px bg-[#DEE0E3] sm:block"/>
      <div className="flex shrink-0 items-center gap-2 text-[15px] font-medium"><Network size={18}/>{t("文档关系图")}</div>
      {multiHopMode && (
        <div role="group" aria-label={t("关系图跳数深度")} data-reference-graph-depth-picker className="inline-flex shrink-0 items-center rounded-md border border-[#DEE0E3] bg-[#F5F6F7] p-0.5 text-[12px]">
          {([1, 2, 3] as const).map((d) => (
            <button
              key={d}
              type="button"
              data-graph-depth={d}
              aria-pressed={depth === d}
              onClick={() => setDepth(d)}
              className={`h-7 rounded px-2 font-medium transition-colors ${depth === d ? "bg-white text-[#3370FF] shadow-xs" : "text-[#646A73] hover:text-[#1F2329]"}`}
            >
              {t("{d} 跳", { d })}
            </button>
          ))}
        </div>
      )}
      <div ref={searchContainer} className="relative order-last w-full sm:order-none sm:mx-auto sm:w-[min(420px,36vw)]">
        <Search size={16} className="pointer-events-none absolute left-3 top-2.5 text-[#8F959E]"/>
        <input ref={searchRef} value={input} onChange={(event) => { setInput(event.target.value); setSearchFocused(true); }} onFocus={() => { if (pendingClick.current) { clearTimeout(pendingClick.current); pendingClick.current = null; } setSearchFocused(true); }} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "ArrowDown" && results?.docs.length) { event.preventDefault(); document.getElementById(searchListId)?.querySelector<HTMLButtonElement>("button")?.focus(); } else if (event.key === "Enter" && results?.docs.length) { event.preventDefault(); centerOn(results.docs[0]); } }} maxLength={100} disabled={!enabled} role="combobox" aria-autocomplete="list" aria-controls={searchFocused && !!input.trim() ? searchListId : undefined} aria-label={t("搜索文档关系图")} aria-expanded={searchFocused && !!input.trim()} placeholder={t("搜索文档、表格、多维表或幻灯片")} className="h-9 w-full rounded-md border border-[#DEE0E3] bg-white pl-9 pr-8 text-base outline-none focus:border-[#3370FF] sm:text-[14px]"/>
        {input && <button type="button" aria-label={t("清除搜索")} onClick={() => { setInput(""); searchRef.current?.focus(); }} className="absolute right-2 top-1.5 grid size-6 place-items-center rounded text-[#8F959E] hover:bg-[#F2F3F5]"><X size={14}/></button>}
        {searchFocused && !!input.trim() && <div id={searchListId} role="listbox" aria-label={t("文档搜索结果")} onKeyDown={(event) => { if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return; event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]')], index = items.indexOf(document.activeElement as HTMLButtonElement); if (items.length) items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus(); }} className="absolute inset-x-0 top-10 max-h-64 overflow-auto rounded-md border border-[#DEE0E3] bg-white py-1 text-[13px] shadow-[0_6px_20px_rgba(31,35,41,0.14)]">
          {(search.isFetching || input.trim() !== debounced) && <p className="px-3 py-2 text-[#8F959E]">{t("正在搜索…")}</p>}{search.isError && input.trim() === debounced && <p role="alert" className="px-3 py-2 text-[#8F959E]">{t("搜索未完成，请修改关键词重试。")}</p>}
          {results && results.docs.length === 0 && <p className="px-3 py-2 text-[#8F959E]">{t("没有找到文档")}</p>}
          {results?.docs.map((doc) => {
            const kmeta = referenceKindMeta(doc.kind, doc.docType);
            return (
              <button type="button" role="option" aria-selected="false" key={doc.id} onMouseDown={(event) => event.preventDefault()} onClick={() => centerOn(doc)} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.keyCode !== 229 && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); centerOn(doc); } }} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[#F2F3F5]">
                <span className="min-w-0 truncate">{name(doc.title)}</span>
                <span className="shrink-0 rounded bg-[#F2F3F5] px-1.5 py-0.5 text-[11px] text-[#646A73]">{kmeta.short}</span>
              </button>
            );
          })}
          {results?.truncated && <p className="px-3 py-2 text-[#8F959E]">{t("仅显示前 30 项，请缩小搜索范围。")}</p>}
        </div>}
      </div>
      <button type="button" disabled={!hasData} onClick={() => openResource({ id: center.id, kind: centerKind })} className="ml-auto inline-flex h-8 shrink-0 items-center gap-1 rounded px-2 text-[13px] text-[#646A73] hover:bg-[#F2F3F5] disabled:opacity-40"><ExternalLink size={14}/>{t("打开{kind}", { kind: centerMeta.short })}</button>
    </header>
    <main ref={canvas} data-reference-graph-canvas role="region" aria-label={t("关系图画布")} tabIndex={0} style={{ touchAction: "pan-x pan-y" }} className={`relative min-h-0 flex-1 overflow-auto overscroll-contain ${panning ? "cursor-grabbing" : ""}`} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || !dimensions) return;
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomAtCenter(stepGraphZoom(zoomRef.current, 1)); }
      else if (event.key === "-") { event.preventDefault(); zoomAtCenter(stepGraphZoom(zoomRef.current, -1)); }
      else if (event.key === "0") { event.preventDefault(); zoomAtCenter(1); }
    }} onPointerDown={(event) => {
      setSearchFocused(false);
      const el = event.currentTarget;
      if (event.pointerType !== "mouse" || event.button !== 0 || (event.target instanceof Element && event.target.closest("[data-reference-graph-node], [data-reference-graph-center]")) || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)) return;
      pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
      el.setPointerCapture(event.pointerId); setPanning(true); event.preventDefault();
    }} onPointerMove={(event) => { const active = pan.current; if (active?.pointer === event.pointerId) { event.currentTarget.scrollLeft = active.left - (event.clientX - active.x); event.currentTarget.scrollTop = active.top - (event.clientY - active.y); } }} onPointerUp={(event) => { if (pan.current?.pointer === event.pointerId) { pan.current = null; setPanning(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }} onPointerCancel={() => { pan.current = null; setPanning(false); }}>
      {!enabled && <p className="absolute inset-0 grid place-items-center text-[13px] text-[#8F959E]">{t("正在确认文档权限…")}</p>}
      {enabled && activeQuery.isFetching && <p role="status" className="absolute inset-0 grid place-items-center text-[13px] text-[#8F959E]">{t("正在加载关系图…")}</p>}
      {enabled && activeQuery.isError && !activeQuery.isFetching && <div role="alert" className="absolute inset-0 grid place-items-center text-center text-[13px] text-[#8F959E]"><div>{t("关系图未能加载，文档过多、权限变化或服务暂不可用。")}<div><button type="button" onClick={() => void activeQuery.refetch()} className="mt-2 text-[#3370FF]">{t("重试")}</button></div></div></div>}
      {dimensions && (
        <div className="grid h-full w-full place-items-center" style={{ minWidth: dimensions.width * zoom, minHeight: dimensions.height * zoom }}>
          <svg ref={svg} width={dimensions.width * zoom} height={dimensions.height * zoom} viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} aria-label={t("文档引用关系")} className="block">
            <defs>
              <marker id={`${arrowMarkerId}-indirect`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1 L 7 4 L 0 7 z" fill="#94A3B8" />
              </marker>
              <marker id={`${arrowMarkerId}-embed`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1 L 7 4 L 0 7 z" fill="#7B67EE" />
              </marker>
            </defs>
            {multiLayout ? (
              <>
                {multiLayout.edges.map((edge) => (
                  <g key={edge.key} data-reference-graph-edge={`${edge.sourceId}->${edge.targetId}`}>
                    <path
                      d={edge.path}
                      fill="none"
                      stroke={edge.color}
                      strokeWidth={edge.category === "indirect" ? "1.1" : "1.4"}
                      strokeDasharray={edge.dashed ? "5 4" : undefined}
                      markerEnd={edge.category === "indirect" ? `url(#${arrowMarkerId}-indirect)` : edge.category === "embed" ? `url(#${arrowMarkerId}-embed)` : undefined}
                    />
                    {edge.animated && (
                      <circle r="2.5" fill={edge.color} className="motion-reduce:hidden">
                        <animateMotion dur="3s" repeatCount="indefinite" path={edge.path} />
                      </circle>
                    )}
                  </g>
                ))}
                <circle cx={multiLayout.centerX} cy={multiLayout.centerY} r="46" fill={centerMeta.color} opacity="0.16" />
                <g role="button" tabIndex={0} aria-label={t("{name}，当前中心{kind}，双击打开", { name: name(centerTitle), kind: centerMeta.label })} className="cursor-pointer" data-reference-graph-center={center.id} onDoubleClick={() => { if (Date.now() >= suppressClickUntil.current) openResource({ id: center.id, kind: centerKind }); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); openResource({ id: center.id, kind: centerKind }); } }}>
                  <circle cx={multiLayout.centerX} cy={multiLayout.centerY} r="28" fill={centerMeta.color} />
                  <GraphNodeGlyph x={multiLayout.centerX} y={multiLayout.centerY} r={28} kind={centerKind} docType={centerDocType} />
                  <text x={multiLayout.centerX} y={multiLayout.centerY + 65} textAnchor="middle" fontSize="14" fontWeight="500" fill="#1F2329" stroke="#F5F6F7" strokeWidth="4" strokeLinejoin="round" style={{ paintOrder: "stroke" }}>{shortName(centerTitle)}</text>
                </g>
                {multiLayout.nodes.map(renderMultiNode)}
              </>
            ) : singleLayout ? (
              <>
                {singleLayout.nodes.flatMap((node, index) => ([node.incoming ? { incoming: true, color: "#26A7FF" } : null, node.outgoing ? { incoming: false, color: "#FFB800" } : null].filter((edge): edge is { incoming: boolean; color: string } => !!edge).map((edge) => { const path = referenceGraphPath(singleLayout, node, edge.incoming); return <g key={`${node.id}:${edge.incoming}`}><path d={path} fill="none" stroke={edge.color} strokeWidth="1"/>{index < 80 && <circle r="2.5" fill={edge.color} className="motion-reduce:hidden"><animateMotion dur="3s" repeatCount="indefinite" path={path}/></circle>}</g>; })))}
                <circle cx={singleLayout.centerX} cy={singleLayout.centerY} r="46" fill="#3370FF" opacity="0.16"/>
                <g role="button" tabIndex={0} aria-label={t("{name}，当前中心文档，双击打开", { name: name(centerTitle) })} className="cursor-pointer" data-reference-graph-center={center.id} onDoubleClick={() => { if (Date.now() >= suppressClickUntil.current) openResource(center); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); openResource(center); } }}>
                  <circle cx={singleLayout.centerX} cy={singleLayout.centerY} r="28" fill="#3370FF"/>
                  <GraphNodeGlyph x={singleLayout.centerX} y={singleLayout.centerY} r={28} kind="doc" />
                  <text x={singleLayout.centerX} y={singleLayout.centerY + 65} textAnchor="middle" fontSize="14" fill="#646A73">{shortName(centerTitle)}</text>
                </g>
                {singleLayout.nodes.map(renderSingleNode)}
              </>
            ) : null}
          </svg>
        </div>
      )}
    </main>
    <footer className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#DEE0E3] bg-white px-3 py-1.5 text-[12px] text-[#8F959E]">
      <span><span className="mr-1 inline-block size-2 rounded-full bg-[#26A7FF]"/>{t("反向引用")}</span>
      <span><span className="mr-1 inline-block size-2 rounded-full bg-[#FFB800]"/>{t("本文引用")}</span>
      {multiHopMode && <span><span className="mr-1 inline-block size-2 rounded-full bg-[#7B67EE]"/>{t("资源内嵌")}</span>}
      {multiHopMode && depth > 1 && <span><span className="mr-1 inline-block size-2 rounded-full bg-[#94A3B8]"/>{t("多跳关联")}</span>}
      {multiData && (
        <span data-reference-graph-stats className="text-[#646A73]">
          {multiData.truncated
            ? t("共 {nodes} 个节点 · {edges} 条关系（已按上限截断）", { nodes: multiData.nodes.length, edges: multiData.edges.length })
            : t("共 {nodes} 个节点 · {edges} 条关系", { nodes: multiData.nodes.length, edges: multiData.edges.length })}
        </span>
      )}
      <span className="hidden lg:inline">{t("单击切换中心，双击打开资源")}</span>
      <div data-reference-zoom-controls className="ml-auto flex items-center gap-0.5 rounded-md border border-[#DEE0E3] bg-white p-0.5 text-[#646A73]">
        <button type="button" aria-label={t("缩小关系图")} title={t("缩小")} disabled={!dimensions || zoom <= GRAPH_MIN_ZOOM} onClick={() => zoomAtCenter(stepGraphZoom(zoomRef.current, -1))} className="grid size-10 place-items-center rounded hover:bg-[#F2F3F5] disabled:opacity-35 sm:size-7"><Minus size={15}/></button>
        <button type="button" aria-label={t("重置关系图缩放，当前 {n}%", { n: Math.round(zoom * 100) })} title={t("重置缩放")} disabled={!dimensions} onClick={() => zoomAtCenter(1)} className="h-10 min-w-11 rounded px-1 text-center tabular-nums hover:bg-[#F2F3F5] disabled:opacity-35 sm:h-7">{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label={t("放大关系图")} title={t("放大")} disabled={!dimensions || zoom >= GRAPH_MAX_ZOOM} onClick={() => zoomAtCenter(stepGraphZoom(zoomRef.current, 1))} className="grid size-10 place-items-center rounded hover:bg-[#F2F3F5] disabled:opacity-35 sm:size-7"><Plus size={15}/></button>
        <span className="mx-0.5 h-4 w-px bg-[#DEE0E3]"/>
        <button type="button" aria-label={t("适应关系图画布")} title={t("适应画布")} disabled={!dimensions} onClick={() => {
          const el = canvas.current;
          if (!el) return;
          const bounds = multiLayout ? multiHopGraphBounds(multiLayout) : singleLayout ? referenceGraphBounds(singleLayout) : null;
          if (bounds) zoomAtCenter(fitGraphZoom(bounds, { width: el.clientWidth, height: el.clientHeight }), { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
        }} className="grid size-10 place-items-center rounded hover:bg-[#F2F3F5] disabled:opacity-35 sm:size-7"><Maximize2 size={14}/></button>
      </div>
      {shareSelection && <span role="status" className="basis-full text-right">{t("请先打开分享链接查看关系")} <button type="button" className="text-[#3370FF]" onClick={() => openResource(shareSelection)}>{t("打开资源")}</button></span>}
    </footer>
  </div>;
}

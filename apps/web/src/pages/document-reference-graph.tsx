import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Network, Search, X } from "lucide-react";
import { navigateDocumentHash } from "@/editor/block-handle";
import type { DocumentReferenceItem, DocumentReferences } from "./document-references";
import { layoutDocumentReferenceGraph, referenceGraphPath, type ReferenceGraphNode } from "./document-reference-graph-layout";

interface SearchResult { docs: { id: number; title: string }[]; truncated: boolean }
export async function searchReferenceDocuments(query: string, userId: number, signal: AbortSignal): Promise<SearchResult> {
  const response = await fetch(`/api/account-document-search?q=${encodeURIComponent(query)}`, { credentials: "same-origin", cache: "no-store", signal, headers: { "X-Jiange-User-Id": String(userId) } });
  if (!response.ok) throw new Error("文档搜索未完成，请重试。");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("文档搜索结果无效。");
  const result = value as Partial<SearchResult>;
  if (!Array.isArray(result.docs) || result.docs.length > 30 || typeof result.truncated !== "boolean" || !result.docs.every((doc) => doc && Number.isSafeInteger(doc.id) && doc.id > 0 && typeof doc.title === "string")) throw new Error("文档搜索结果无效。");
  return result as SearchResult;
}

type Center = { id: number; title: string };
type LoadReferences = (id: number, userId: number, signal: AbortSignal) => Promise<DocumentReferences>;
const name = (title: string) => title.trim() || "未命名文档";
const shortName = (title: string) => { const chars = [...name(title)]; return chars.length > 13 ? `${chars.slice(0, 12).join("")}…` : chars.join(""); };

export function DocumentReferenceGraph({ rootId, rootTitle, userId, enabled, synced = false, syncVersion = 0, loadReferences, onClose }: { rootId: number; rootTitle: string; userId: number; enabled: boolean; synced?: boolean; syncVersion?: number; loadReferences: LoadReferences; onClose: () => void }) {
  const [center, setCenter] = useState<Center>({ id: rootId, title: rootTitle });
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [shareSelection, setShareSelection] = useState<DocumentReferenceItem | null>(null);
  const searchListId = useId();
  const pendingClick = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
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
      if (i < 0 || event.shiftKey && i === 0 || !event.shiftKey && i === items.length - 1) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  const references = useQuery({ queryKey: ["document-references", userId, center.id], queryFn: ({ signal }) => loadReferences(center.id, userId, signal), enabled, retry: false, refetchOnWindowFocus: true, refetchInterval: 30_000, refetchIntervalInBackground: false });
  const lastRootVersion = useRef(syncVersion);
  useEffect(() => {
    if (!enabled || !synced || center.id !== rootId || syncVersion === lastRootVersion.current) return;
    const timer = setTimeout(() => { lastRootVersion.current = syncVersion; void references.refetch(); }, 700);
    return () => clearTimeout(timer);
  }, [enabled, synced, center.id, rootId, syncVersion, references.refetch]);
  const search = useQuery({ queryKey: ["reference-graph-search", userId, debounced], queryFn: ({ signal }) => searchReferenceDocuments(debounced, userId, signal), enabled: enabled && !!debounced && [...debounced].length <= 100, retry: false, refetchOnWindowFocus: true, refetchInterval: searchFocused ? 30_000 : false, refetchIntervalInBackground: false });
  useEffect(() => {
    if (enabled && searchFocused && debounced && input.trim() === debounced && search.isSuccess && !search.isFetching && Date.now() - search.dataUpdatedAt >= 30_000) void search.refetch();
  }, [enabled, searchFocused, debounced, input, search.isSuccess, search.isFetching, search.dataUpdatedAt, search.refetch]);
  const results = enabled && input.trim() === debounced && search.isSuccess && !search.isFetching && Date.now() - search.dataUpdatedAt < 30_000 ? search.data : undefined;
  const data = enabled && references.isSuccess && !references.isFetching && Date.now() - references.dataUpdatedAt < 30_000 ? references.data : undefined;
  const layout = useMemo(() => data ? layoutDocumentReferenceGraph(data) : null, [data]);
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el || !layout) return;
    const centerCanvas = () => {
      el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
      el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2);
    };
    centerCanvas();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(centerCanvas);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [center.id, layout?.width, layout?.height]);
  const centerOn = (item: DocumentReferenceItem) => {
    setSearchFocused(false); setInput("");
    if (item.href) { setShareSelection(item); return; }
    setShareSelection(null); setCenter({ id: item.id, title: item.title });
  };
  const openDocument = (item: { id: number; href?: string }) => { if (pendingClick.current) clearTimeout(pendingClick.current); onClose(); navigateDocumentHash(item.href ?? `#/doc/${item.id}`); };
  const clickNode = (item: DocumentReferenceItem) => {
    if (pendingClick.current) clearTimeout(pendingClick.current);
    pendingClick.current = setTimeout(() => { pendingClick.current = null; centerOn(item); }, 500);
  };
  const graphNode = (node: ReferenceGraphNode) => <g key={node.id} role="button" tabIndex={0} aria-label={`${name(node.title)}，点击切换关系中心，双击打开`} className="cursor-pointer outline-none" data-reference-graph-node={node.id} onClick={() => clickNode(node)} onDoubleClick={() => openDocument(node)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); centerOn(node); } }}>
    <title>{name(node.title)}</title><circle cx={node.x} cy={node.y} r="16" fill="#3370FF"/><path d={`M ${node.x - 6} ${node.y - 4} h 12 M ${node.x - 6} ${node.y} h 10 M ${node.x - 6} ${node.y + 4} h 6`} stroke="white" strokeWidth="1.5" strokeLinecap="round"/><text x={node.x} y={node.y + 37} textAnchor="middle" fontSize="13" fill="#646A73">{shortName(node.title)}</text>
  </g>;
  return <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="文档关系图" data-reference-graph className="fixed inset-0 z-[80] flex h-[100dvh] flex-col bg-[#F5F6F7] text-[#1F2329] outline-none">
    <header className="relative z-10 flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-[#DEE0E3] bg-white px-3 py-2 sm:flex-nowrap sm:px-5">
      <button ref={closeRef} type="button" aria-label="返回文档" onClick={onClose} className="grid size-9 shrink-0 place-items-center rounded text-[#646A73] hover:bg-[#F2F3F5]"><ArrowLeft size={19}/></button><span className="hidden h-6 w-px bg-[#DEE0E3] sm:block"/><div className="flex shrink-0 items-center gap-2 text-[15px] font-medium"><Network size={18}/>文档关系图</div>
      <div ref={searchContainer} className="relative order-last w-full sm:absolute sm:left-1/2 sm:top-2 sm:order-none sm:w-[min(520px,45vw)] sm:-translate-x-1/2">
        <Search size={16} className="pointer-events-none absolute left-3 top-2.5 text-[#8F959E]"/><input ref={searchRef} value={input} onChange={(event) => { setInput(event.target.value); setSearchFocused(true); }} onFocus={() => { if (pendingClick.current) { clearTimeout(pendingClick.current); pendingClick.current = null; } setSearchFocused(true); }} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "ArrowDown" && results?.docs.length) { event.preventDefault(); document.getElementById(searchListId)?.querySelector<HTMLButtonElement>("button")?.focus(); } else if (event.key === "Enter" && results?.docs.length) { event.preventDefault(); centerOn(results.docs[0]); } }} maxLength={100} disabled={!enabled} role="combobox" aria-autocomplete="list" aria-controls={searchFocused && !!input.trim() ? searchListId : undefined} aria-label="搜索文档关系图" aria-expanded={searchFocused && !!input.trim()} placeholder="搜索文档" className="h-9 w-full rounded-md border border-[#DEE0E3] bg-white pl-9 pr-8 text-base outline-none focus:border-[#3370FF] sm:text-[14px]"/>{input && <button type="button" aria-label="清除搜索" onClick={() => { setInput(""); searchRef.current?.focus(); }} className="absolute right-2 top-1.5 grid size-6 place-items-center rounded text-[#8F959E] hover:bg-[#F2F3F5]"><X size={14}/></button>}
        {searchFocused && !!input.trim() && <div id={searchListId} role="listbox" aria-label="文档搜索结果" onKeyDown={(event) => { if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return; event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]')], index = items.indexOf(document.activeElement as HTMLButtonElement); if (items.length) items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus(); }} className="absolute inset-x-0 top-10 max-h-64 overflow-auto rounded-md border border-[#DEE0E3] bg-white py-1 text-[13px] shadow-[0_6px_20px_rgba(31,35,41,0.14)]">
          {(search.isFetching || input.trim() !== debounced) && <p className="px-3 py-2 text-[#8F959E]">正在搜索…</p>}{search.isError && input.trim() === debounced && <p role="alert" className="px-3 py-2 text-[#8F959E]">搜索未完成，请修改关键词重试。</p>}
          {results && results.docs.length === 0 && <p className="px-3 py-2 text-[#8F959E]">没有找到文档</p>}{results?.docs.map((doc) => <button type="button" role="option" aria-selected="false" key={doc.id} onMouseDown={(event) => event.preventDefault()} onClick={() => centerOn(doc)} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.keyCode !== 229 && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); centerOn(doc); } }} className="block w-full truncate px-3 py-2 text-left hover:bg-[#F2F3F5]">{name(doc.title)}</button>)}{results?.truncated && <p className="px-3 py-2 text-[#8F959E]">仅显示前 30 项，请缩小搜索范围。</p>}
        </div>}
      </div>
      <button type="button" disabled={!data} onClick={() => openDocument(center)} className="ml-auto inline-flex h-8 items-center gap-1 rounded px-2 text-[13px] text-[#646A73] hover:bg-[#F2F3F5] disabled:opacity-40"><ExternalLink size={14}/>打开文档</button>
    </header>
    <main ref={canvas} data-reference-graph-canvas className={`relative min-h-0 flex-1 overflow-auto overscroll-contain ${panning ? "cursor-grabbing" : ""}`} onPointerDown={(event) => {
      setSearchFocused(false);
      const el = event.currentTarget;
      if (event.pointerType !== "mouse" || event.button !== 0 || (event.target instanceof Element && event.target.closest("[data-reference-graph-node], [data-reference-graph-center]")) || el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
      pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
      el.setPointerCapture(event.pointerId); setPanning(true); event.preventDefault();
    }} onPointerMove={(event) => { const active = pan.current; if (active?.pointer === event.pointerId) { event.currentTarget.scrollLeft = active.left - (event.clientX - active.x); event.currentTarget.scrollTop = active.top - (event.clientY - active.y); } }} onPointerUp={(event) => { if (pan.current?.pointer === event.pointerId) { pan.current = null; setPanning(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }} onPointerCancel={() => { pan.current = null; setPanning(false); }}>
      {!enabled && <p className="absolute inset-0 grid place-items-center text-[13px] text-[#8F959E]">正在确认文档权限…</p>}
      {enabled && references.isFetching && <p role="status" className="absolute inset-0 grid place-items-center text-[13px] text-[#8F959E]">正在加载关系图…</p>}
      {enabled && references.isError && !references.isFetching && <div role="alert" className="absolute inset-0 grid place-items-center text-center text-[13px] text-[#8F959E]"><div>关系图未能加载，文档过多、权限变化或服务暂不可用。<div><button type="button" onClick={() => void references.refetch()} className="mt-2 text-[#3370FF]">重试</button></div></div></div>}
      {data && layout && <div className="grid h-full w-full place-items-center" style={{ minWidth: layout.width, minHeight: layout.height }}><svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-label="文档引用关系" className="block">
        {layout.nodes.flatMap((node, index) => ([node.incoming ? { incoming: true, color: "#26A7FF" } : null, node.outgoing ? { incoming: false, color: "#FFB800" } : null].filter((edge): edge is { incoming: boolean; color: string } => !!edge).map((edge) => { const path = referenceGraphPath(layout, node, edge.incoming); return <g key={`${node.id}:${edge.incoming}`}><path d={path} fill="none" stroke={edge.color} strokeWidth="1"/>{index < 80 && <circle r="2.5" fill={edge.color} className="motion-reduce:hidden"><animateMotion dur="3s" repeatCount="indefinite" path={path}/></circle>}</g>; })))}
        <circle cx={layout.centerX} cy={layout.centerY} r="46" fill="#3370FF" opacity="0.16"/><g role="button" tabIndex={0} aria-label={`${name(center.id === rootId ? rootTitle : center.title)}，当前中心文档，双击打开`} className="cursor-pointer" data-reference-graph-center={center.id} onDoubleClick={() => openDocument(center)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); openDocument(center); } }}><circle cx={layout.centerX} cy={layout.centerY} r="28" fill="#3370FF"/><path d={`M ${layout.centerX - 10} ${layout.centerY - 7} h 20 M ${layout.centerX - 10} ${layout.centerY} h 16 M ${layout.centerX - 10} ${layout.centerY + 7} h 11`} stroke="white" strokeWidth="2" strokeLinecap="round"/><text x={layout.centerX} y={layout.centerY + 65} textAnchor="middle" fontSize="14" fill="#646A73">{shortName(center.id === rootId ? rootTitle : center.title)}</text></g>
        {layout.nodes.map(graphNode)}
      </svg></div>}
    </main>
    <footer className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-t border-[#DEE0E3] bg-white px-4 py-2 text-[12px] text-[#8F959E]"><span><span className="mr-1 inline-block size-2 rounded-full bg-[#26A7FF]"/>反向引用</span><span><span className="mr-1 inline-block size-2 rounded-full bg-[#FFB800]"/>本文引用</span><span className="hidden sm:inline">单击切换中心，双击打开文档</span><span className="sm:hidden">点选切换，顶部打开</span>{shareSelection && <span role="status" className="ml-auto">请先打开分享链接查看关系 <button type="button" className="text-[#3370FF]" onClick={() => openDocument(shareSelection)}>打开文档</button></span>}</footer>
  </div>;
}

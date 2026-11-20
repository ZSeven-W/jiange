import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Network, RefreshCw, X } from "lucide-react";
import { navigateDocumentHash } from "@/editor/block-handle";
import { DocumentReferenceGraph } from "./document-reference-graph";
import type { MultiHopReferenceGraph } from "./document-reference-graph-layout";

export interface DocumentReferenceContext { block: string; text?: string; relationKind?: string }
export interface DocumentReferenceItem { id: number; title: string; kind?: string; docType?: string; href?: string; relationKind?: string; contexts?: DocumentReferenceContext[] }
export interface DocumentReferences { incoming: DocumentReferenceItem[]; outgoing: DocumentReferenceItem[]; indexed?: boolean }

const VALID_KINDS = new Set(["doc", "sheet", "base", "slides", "survey"]);
const VALID_RELATIONS = new Set(["link", "embed"]);

function isValidContextBlock(block: unknown): block is string {
  if (typeof block !== "string") return false;
  if (/^\d+:\d+$/.test(block)) {
    return block.split(":").every((part) => Number.isSafeInteger(Number(part)));
  }
  if (/^(?:slide|rec):\d+$/.test(block)) {
    const [, num] = block.split(":");
    return Number.isSafeInteger(Number(num)) && Number(num) > 0;
  }
  return /^(?:sheet|survey):[A-Za-z0-9_-]{1,64}$/.test(block);
}

export function referenceNodeHref(item: { id: number; kind?: string; href?: string }): string {
  if (item.href) return item.href;
  const kind = item.kind && VALID_KINDS.has(item.kind) ? item.kind : "doc";
  return `#/${kind}/${item.id}`;
}

export function referenceContextHref(item: { id: number; kind?: string }, block: string): string {
  const kind = item.kind && VALID_KINDS.has(item.kind) ? item.kind : "doc";
  if (kind === "doc" && /^\d+:\d+$/.test(block)) {
    return `#/doc/${item.id}?block=${encodeURIComponent(block)}`;
  }
  return `#/${kind}/${item.id}`;
}

export function referenceKindMeta(kind?: string, docType?: string): { label: string; color: string; short: string } {
  if (kind === "sheet") return { label: "电子表格", color: "#18A058", short: "表格" };
  if (kind === "base") return { label: "多维表格", color: "#00B8D9", short: "多维表" };
  if (kind === "slides") return { label: "幻灯片", color: "#F59E0B", short: "幻灯片" };
  if (kind === "survey") return { label: "问卷", color: "#EC4899", short: "问卷" };
  if (docType === "board") return { label: "画板", color: "#7B67EE", short: "画板" };
  return { label: "文档", color: "#3370FF", short: "文档" };
}

export function ReferenceKindIcon({ kind, docType, size = 16 }: { kind?: string; docType?: string; size?: number }) {
  const meta = referenceKindMeta(kind, docType);
  if (kind === "sheet") {
    return (
      <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
        <rect x="2" y="1" width="12" height="14" rx="2" fill={meta.color} />
        <path d="M4.5 5.5h7M4.5 8.5h7M4.5 11.5h7M8 5.5v6" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "base") {
    return (
      <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
        <rect x="2" y="1" width="12" height="14" rx="2" fill={meta.color} />
        <rect x="4.5" y="4.5" width="3" height="3" rx="0.5" fill="white" />
        <rect x="8.5" y="4.5" width="3" height="3" rx="0.5" fill="white" opacity="0.8" />
        <rect x="4.5" y="8.5" width="3" height="3" rx="0.5" fill="white" opacity="0.8" />
        <rect x="8.5" y="8.5" width="3" height="3" rx="0.5" fill="white" />
      </svg>
    );
  }
  if (kind === "slides") {
    return (
      <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill={meta.color} />
        <path d="M6.5 5.5L11 8L6.5 10.5V5.5Z" fill="white" />
      </svg>
    );
  }
  if (kind === "survey") {
    return (
      <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
        <rect x="2" y="1" width="12" height="14" rx="2" fill={meta.color} />
        <path d="M5 6l1.5 1.5L9.5 4.5M5 10.5h6" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (docType === "board") {
    return (
      <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
        <rect x="2" y="1" width="12" height="14" rx="2" fill={meta.color} />
        <circle cx="6" cy="6" r="1.5" fill="white" />
        <rect x="8.5" y="8.5" width="3" height="3" rx="0.6" fill="white" />
        <path d="M7.2 7.2L9 9" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0">
      <rect x="2" y="1" width="12" height="14" rx="2" fill={meta.color} />
      <path d="M5 5h6M5 8h6M5 11h4" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export async function fetchDocumentReferences(id: number, userId: number, signal: AbortSignal): Promise<DocumentReferences> {
  const response = await fetch(`/api/docs/${id}/references`, { credentials: "same-origin", cache: "no-store", signal, headers: { "X-Jiange-User-Id": String(userId) } });
  if (!response.ok) throw new Error("引用查询未完成，请稍后重试。");
  const data: unknown = await response.json();
  const validItem = (value: unknown): value is DocumentReferenceItem => {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<DocumentReferenceItem>;
    return (
      Number.isSafeInteger(item.id) &&
      item.id! > 0 &&
      typeof item.title === "string" &&
      (item.kind === undefined || (typeof item.kind === "string" && VALID_KINDS.has(item.kind))) &&
      (item.docType === undefined || typeof item.docType === "string") &&
      (item.relationKind === undefined || (typeof item.relationKind === "string" && VALID_RELATIONS.has(item.relationKind))) &&
      (item.href === undefined || (typeof item.href === "string" && /^#\/(s|p)\/[A-Za-z0-9_-]{1,256}$/.test(item.href))) &&
      (item.contexts === undefined ||
        (Array.isArray(item.contexts) &&
          item.contexts.length <= 2000 &&
          item.contexts.every(
            (context) =>
              context &&
              isValidContextBlock(context.block) &&
              (context.text === undefined || (typeof context.text === "string" && [...context.text].length <= 181)) &&
              (context.relationKind === undefined || (typeof context.relationKind === "string" && VALID_RELATIONS.has(context.relationKind)))
          )))
    );
  };
  if (!data || typeof data !== "object") throw new Error("引用查询结果无效。");
  const result = data as Partial<DocumentReferences>;
  if (!Array.isArray(result.incoming) || !Array.isArray(result.outgoing) || result.incoming.length > 2000 || result.outgoing.length > 2000 || !result.incoming.every(validItem) || !result.outgoing.every(validItem)) throw new Error("引用查询结果无效。");
  return result as DocumentReferences;
}

export async function fetchDocumentReferenceGraph(id: number, userId: number, depth: 1 | 2 | 3, signal: AbortSignal): Promise<MultiHopReferenceGraph> {
  const response = await fetch(`/api/docs/${id}/reference-graph?depth=${depth}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { "X-Jiange-User-Id": String(userId) },
  });
  if (!response.ok) throw new Error("关系图查询未完成，请稍后重试。");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("关系图结果无效。");
  const g = data as Partial<MultiHopReferenceGraph>;
  if (
    !Number.isSafeInteger(g.centerId) ||
    g.centerId! <= 0 ||
    !Number.isSafeInteger(g.depth) ||
    g.depth! < 1 ||
    g.depth! > 3 ||
    typeof g.truncated !== "boolean" ||
    !Array.isArray(g.nodes) ||
    g.nodes.length > 500 ||
    !Array.isArray(g.edges) ||
    g.edges.length > 2000
  ) {
    throw new Error("关系图结果无效。");
  }
  const validNode = (n: unknown) => {
    if (!n || typeof n !== "object") return false;
    const item = n as Partial<MultiHopReferenceGraph["nodes"][number]>;
    return (
      Number.isSafeInteger(item.id) &&
      item.id! > 0 &&
      typeof item.title === "string" &&
      typeof item.kind === "string" &&
      VALID_KINDS.has(item.kind) &&
      (item.docType === undefined || typeof item.docType === "string") &&
      (item.href === undefined || (typeof item.href === "string" && /^#\/(s|p)\/[A-Za-z0-9_-]{1,256}$/.test(item.href))) &&
      Number.isSafeInteger(item.depth) &&
      item.depth! >= 0 &&
      item.depth! <= 3
    );
  };
  const validEdge = (e: unknown) => {
    if (!e || typeof e !== "object") return false;
    const item = e as Partial<MultiHopReferenceGraph["edges"][number]>;
    return (
      Number.isSafeInteger(item.sourceId) &&
      item.sourceId! > 0 &&
      Number.isSafeInteger(item.targetId) &&
      item.targetId! > 0 &&
      typeof item.relationKind === "string" &&
      VALID_RELATIONS.has(item.relationKind)
    );
  };
  if (!g.nodes.every(validNode) || !g.edges.every(validEdge)) {
    throw new Error("关系图结果无效。");
  }
  return g as MultiHopReferenceGraph;
}

/** Loading is deferred until the reader approaches the end of the document. */
export function DocumentReferencesPanel({ id, userId, title = "当前文档", kind = "doc", docType, enabled, synced, syncVersion = 0, allowCopy, onHide, hiding = false }: { id: number; userId: number; title?: string; kind?: string; docType?: string; enabled: boolean; synced: boolean; syncVersion?: number; allowCopy: boolean; onHide?: () => Promise<boolean>; hiding?: boolean }) {
  const marker = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [inView, setInView] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [tab, setTab] = useState<"incoming" | "outgoing">("incoming");
  const tabId = useId();
  const [graphOpen, setGraphOpen] = useState(false);
  const [confirmHide, setConfirmHide] = useState(false);
  const [hideError, setHideError] = useState(false);
  const confirmRef = useRef<HTMLElement>(null);
  useEffect(() => { if (!onHide) setConfirmHide(false); }, [onHide]);
  useEffect(() => {
    if (!confirmHide) return;
    const previous = document.activeElement as HTMLElement | null;
    confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !hiding) { event.preventDefault(); setConfirmHide(false); return; }
      if (event.key !== "Tab" || !confirmRef.current) return;
      const buttons = [...confirmRef.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (!buttons.length) return;
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0 || (event.shiftKey && i === 0) || (!event.shiftKey && i === buttons.length - 1)) { event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0].focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
  }, [confirmHide, hiding]);
  useEffect(() => {
    if (!enabled || !marker.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); setInView(true); return; }
    const observer = new IntersectionObserver((entries) => { const intersects = entries.some((entry) => entry.isIntersecting); setInView(intersects); if (intersects) setVisible(true); }, { rootMargin: "200px" });
    observer.observe(marker.current);
    return () => observer.disconnect();
  }, [enabled]);
  const query = useQuery({ queryKey: ["document-references", userId, id], queryFn: ({ signal }) => fetchDocumentReferences(id, userId, signal), enabled: enabled && visible && !graphOpen, retry: false, refetchOnWindowFocus: true, refetchInterval: inView && !graphOpen ? 30_000 : false, refetchIntervalInBackground: false });
  const lastSyncedVersion = useRef(syncVersion);
  useEffect(() => {
    if (graphOpen && synced) { lastSyncedVersion.current = syncVersion; return; }
    if (!enabled || !visible || !inView || graphOpen || !synced || syncVersion === lastSyncedVersion.current) return;
    const timer = setTimeout(() => { lastSyncedVersion.current = syncVersion; void query.refetch(); }, 700);
    return () => clearTimeout(timer);
  }, [enabled, visible, inView, graphOpen, synced, syncVersion, query.refetch]);
  useEffect(() => {
    if (enabled && visible && inView && !graphOpen && query.isSuccess && !query.isFetching && Date.now() - query.dataUpdatedAt >= 30_000) void query.refetch();
  }, [enabled, visible, inView, graphOpen, query.isSuccess, query.isFetching, query.dataUpdatedAt, query.refetch]);
  const data = enabled && query.isSuccess && !query.isFetching && Date.now() - query.dataUpdatedAt < 30_000 ? query.data : undefined;
  const toggle = (key: number) => setExpanded((old) => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const open = (event: React.MouseEvent<HTMLAnchorElement>, hash: string) => { event.preventDefault(); navigateDocumentHash(hash); };
  return <section ref={marker} aria-label="文档引用" data-document-references className="group/references mt-16 rounded-md bg-[#F5F6F7] px-4 pb-4 pt-1 text-[14px] text-[#1F2329] dark:bg-hover dark:text-foreground print:hidden" onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }}>
    <div className="flex min-h-12 items-center gap-2 border-b border-[#DEE0E3] dark:border-border">
      <div role="tablist" aria-label="文档引用分类" className="flex shrink-0" onKeyDown={(event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const next = event.key === "Home" ? "incoming" : event.key === "End" ? "outgoing" : tab === "incoming" ? "outgoing" : "incoming"; setTab(next); document.getElementById(`${tabId}-${next}`)?.focus(); }}>
      <button type="button" id={`${tabId}-incoming`} role="tab" tabIndex={tab === "incoming" ? 0 : -1} aria-controls={`${tabId}-panel`} aria-selected={tab === "incoming"} onClick={() => setTab("incoming")} className={`relative h-12 shrink-0 px-1 text-[13px] sm:px-2 sm:text-[14px] ${tab === "incoming" ? "font-medium text-[#3370FF] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[#3370FF]" : "text-foreground"}`}>反向引用{data ? ` (${data.incoming.length})` : ""}</button>
      <button type="button" id={`${tabId}-outgoing`} role="tab" tabIndex={tab === "outgoing" ? 0 : -1} aria-controls={`${tabId}-panel`} aria-selected={tab === "outgoing"} onClick={() => setTab("outgoing")} className={`relative h-12 shrink-0 px-1 text-[13px] sm:ml-5 sm:px-2 sm:text-[14px] ${tab === "outgoing" ? "font-medium text-[#3370FF] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[#3370FF]" : "text-foreground"}`}>本文引用{data ? ` (${data.outgoing.length})` : ""}</button>
      </div>
      <button type="button" data-open-reference-graph disabled={!enabled || !data} onClick={() => setGraphOpen(true)} className="ml-auto inline-flex h-8 shrink-0 items-center gap-1 rounded px-1.5 text-[13px] hover:bg-[#E9EBEF] disabled:opacity-40 dark:hover:bg-surface"><Network size={15}/>关系图</button>
      <button type="button" aria-label="刷新文档引用" title="刷新" disabled={!enabled || !visible || query.isFetching} onClick={() => void query.refetch()} className="grid size-7 shrink-0 place-items-center rounded text-[#8F959E] hover:bg-[#E9EBEF] disabled:opacity-40 dark:hover:bg-surface"><RefreshCw size={14}/></button>
      {onHide && <button type="button" aria-label="隐藏文档引用" title="隐藏" disabled={hiding} onClick={() => { setHideError(false); setConfirmHide(true); }} className="grid size-7 shrink-0 place-items-center rounded text-[#646A73] hover:bg-[#E9EBEF] disabled:opacity-40 dark:hover:bg-surface"><X size={17}/></button>}
    </div>
    {!synced && <p className="mt-3 text-[12px] text-[#8F959E]">文档尚未同步，引用结果以已保存内容为准。</p>}
    {visible && (query.isFetching || query.isPending) && <p role="status" className="py-4 text-[13px] text-[#8F959E]">正在加载文档引用…</p>}
    {visible && query.isError && !query.isFetching && <p role="alert" className="py-4 text-[13px] text-[#8F959E]">引用查询未完成，文档过多、内容过大或服务暂不可用，可点击刷新重试。</p>}
    {data && <div id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}`} className="pt-2">
      {tab === "incoming" && (data.incoming.length === 0 ? <p className="py-3 text-[13px] text-[#8F959E]">暂无反向引用</p> : data.incoming.map((item) => {
        const itemHref = referenceNodeHref(item);
        const kindInfo = referenceKindMeta(item.kind, item.docType);
        const showKindPill = (item.kind && item.kind !== "doc") || item.docType === "board";
        return <div key={item.id} className="rounded-md hover:bg-[#E9EBEF] dark:hover:bg-surface" data-reference-incoming-item={item.id}>
          <div className="flex min-w-0 items-center">
            <button type="button" aria-label={`${expanded.has(item.id) ? "收起" : "展开"}${item.title || "未命名文档"}的引用位置`} aria-expanded={expanded.has(item.id)} onClick={() => toggle(item.id)} className="grid size-8 shrink-0 place-items-center text-[#8F959E]">{expanded.has(item.id) ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button>
            <ReferenceKindIcon kind={item.kind} docType={item.docType} />
            <a href={itemHref} onClick={(event) => open(event, itemHref)} className="min-w-0 truncate py-2 pl-1.5 pr-2 text-[#3370FF] hover:underline">{item.title.trim() || "未命名文档"}</a>
            {showKindPill && <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[11px] text-[#646A73] dark:bg-white/10 dark:text-muted-foreground">{kindInfo.short}</span>}
            {item.relationKind === "embed" && <span className="ml-1 shrink-0 rounded bg-[#EEF2FF] px-1.5 py-0.5 text-[11px] font-medium text-[#5B4CE6] dark:bg-indigo-500/20 dark:text-indigo-300">内嵌</span>}
          </div>
          {expanded.has(item.id) && <div className="pb-2 pl-12 pr-2">{item.contexts?.map((context) => { const href = referenceContextHref(item, context.block); return <a key={context.block} href={href} onClick={(event) => open(event, href)} className="block truncate rounded px-2 py-1 text-[12px] text-[#646A73] hover:bg-[#E5EDFF] hover:text-[#1456F0] dark:hover:bg-hover">• {context.text || "查看引用位置"}</a>; })}</div>}
        </div>;
      }))}
      {tab === "outgoing" && (data.outgoing.length === 0 ? <p className="py-3 text-[13px] text-[#8F959E]">暂无本文引用</p> : data.outgoing.map((item) => {
        const href = referenceNodeHref(item);
        const kindInfo = referenceKindMeta(item.kind, item.docType);
        const showKindPill = (item.kind && item.kind !== "doc") || item.docType === "board";
        return <div key={item.id} className="flex items-center gap-1.5 rounded-md px-8 hover:bg-[#E9EBEF] dark:hover:bg-surface" data-reference-outgoing-item={item.id}>
          <ReferenceKindIcon kind={item.kind} docType={item.docType} />
          <a href={href} onClick={(event) => open(event, href)} className="min-w-0 truncate py-2 text-[#3370FF] hover:underline">{item.title.trim() || "未命名文档"}</a>
          {showKindPill && <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[11px] text-[#646A73] dark:bg-white/10 dark:text-muted-foreground">{kindInfo.short}</span>}
          {item.relationKind === "embed" && <span className="shrink-0 rounded bg-[#EEF2FF] px-1.5 py-0.5 text-[11px] font-medium text-[#5B4CE6] dark:bg-indigo-500/20 dark:text-indigo-300">内嵌</span>}
        </div>;
      }))}
    </div>}
    {graphOpen && <DocumentReferenceGraph rootId={id} rootTitle={title} rootKind={kind} rootDocType={docType} userId={userId} enabled={enabled} synced={synced} syncVersion={syncVersion} loadReferences={fetchDocumentReferences} loadGraph={fetchDocumentReferenceGraph} onClose={() => setGraphOpen(false)} />}
    {confirmHide && onHide && <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !hiding) setConfirmHide(false); }}><section ref={confirmRef} role="dialog" aria-modal="true" aria-labelledby="reference-hide-title" className="w-full max-w-[420px] rounded-lg bg-surface p-6 text-foreground shadow-xl"><h2 id="reference-hide-title" className="text-[16px] font-medium">隐藏文档引用</h2><p className="mt-3 text-[14px] leading-6 text-muted-foreground">隐藏后，所有协作者都将看不到文档底部的引用列表。可在文档菜单中重新显示。</p>{hideError && <p role="alert" className="mt-3 text-[13px] text-destructive">设置未能确认，请检查后重试。</p>}<div className="mt-6 flex justify-end gap-2"><button type="button" disabled={hiding} onClick={() => setConfirmHide(false)} className="h-8 rounded-md border px-4 text-[13px] hover:bg-hover disabled:opacity-50">取消</button><button type="button" disabled={hiding} onClick={() => { void onHide().then((ok) => { if (ok) setConfirmHide(false); else setHideError(true); }).catch(() => setHideError(true)); }} className="h-8 rounded-md bg-[#1456F0] px-4 text-[13px] text-white hover:bg-[#0F4DD6] disabled:opacity-50">{hiding ? "正在隐藏…" : "隐藏"}</button></div></section></div>}
  </section>;
}

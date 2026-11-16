import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Network, RefreshCw, X } from "lucide-react";
import { navigateDocumentHash } from "@/editor/block-handle";
import { DocumentReferenceGraph } from "./document-reference-graph";

export interface DocumentReferenceContext { block: string; text?: string }
export interface DocumentReferenceItem { id: number; title: string; href?: string; contexts?: DocumentReferenceContext[] }
export interface DocumentReferences { incoming: DocumentReferenceItem[]; outgoing: DocumentReferenceItem[] }

export async function fetchDocumentReferences(id: number, userId: number, signal: AbortSignal): Promise<DocumentReferences> {
  const response = await fetch(`/api/docs/${id}/references`, { credentials: "same-origin", cache: "no-store", signal, headers: { "X-Jiange-User-Id": String(userId) } });
  if (!response.ok) throw new Error("引用查询未完成，请稍后重试。");
  const data: unknown = await response.json();
  const validItem = (value: unknown): value is DocumentReferenceItem => {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<DocumentReferenceItem>;
    return Number.isSafeInteger(item.id) && item.id! > 0 && typeof item.title === "string" && (item.href === undefined || typeof item.href === "string" && /^#\/(s|p)\/[A-Za-z0-9_-]{1,256}$/.test(item.href)) && (item.contexts === undefined || Array.isArray(item.contexts) && item.contexts.length <= 2000 && item.contexts.every((context) => context && typeof context.block === "string" && /^\d+:\d+$/.test(context.block) && context.block.split(":").every((part) => Number.isSafeInteger(Number(part))) && (context.text === undefined || typeof context.text === "string" && [...context.text].length <= 181)));
  };
  if (!data || typeof data !== "object") throw new Error("引用查询结果无效。");
  const result = data as Partial<DocumentReferences>;
  if (!Array.isArray(result.incoming) || !Array.isArray(result.outgoing) || result.incoming.length > 200 || result.outgoing.length > 200 || !result.incoming.every(validItem) || !result.outgoing.every(validItem)) throw new Error("引用查询结果无效。");
  return result as DocumentReferences;
}

/** Loading is deferred until the reader approaches the end of the document. */
export function DocumentReferencesPanel({ id, userId, title = "当前文档", enabled, synced, syncVersion = 0, allowCopy, onHide, hiding = false }: { id: number; userId: number; title?: string; enabled: boolean; synced: boolean; syncVersion?: number; allowCopy: boolean; onHide?: () => Promise<boolean>; hiding?: boolean }) {
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
      if (i < 0 || event.shiftKey && i === 0 || !event.shiftKey && i === buttons.length - 1) { event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0].focus(); }
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
  const icon = <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0"><rect x="2" y="1" width="12" height="14" rx="2" fill="#3370FF"/><path d="M5 5h6M5 8h6M5 11h4" stroke="white" strokeWidth="1.2" strokeLinecap="round"/></svg>;
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
      {tab === "incoming" && (data.incoming.length === 0 ? <p className="py-3 text-[13px] text-[#8F959E]">暂无反向引用</p> : data.incoming.map((item) => <div key={item.id} className="rounded-md hover:bg-[#E9EBEF] dark:hover:bg-surface">
        <div className="flex min-w-0 items-center"><button type="button" aria-label={`${expanded.has(item.id) ? "收起" : "展开"}${item.title || "未命名文档"}的引用位置`} aria-expanded={expanded.has(item.id)} onClick={() => toggle(item.id)} className="grid size-8 shrink-0 place-items-center text-[#8F959E]">{expanded.has(item.id) ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button>{icon}<a href={`#/doc/${item.id}`} onClick={(event) => open(event, `#/doc/${item.id}`)} className="min-w-0 truncate py-2 pl-1.5 pr-2 text-[#3370FF] hover:underline">{item.title.trim() || "未命名文档"}</a></div>
        {expanded.has(item.id) && <div className="pb-2 pl-12 pr-2">{item.contexts?.map((context) => { const href = `#/doc/${item.id}?block=${encodeURIComponent(context.block)}`; return <a key={context.block} href={href} onClick={(event) => open(event, href)} className="block truncate rounded px-2 py-1 text-[12px] text-[#646A73] hover:bg-[#E5EDFF] hover:text-[#1456F0] dark:hover:bg-hover">• {context.text || "查看引用位置"}</a>; })}</div>}
      </div>))}
      {tab === "outgoing" && (data.outgoing.length === 0 ? <p className="py-3 text-[13px] text-[#8F959E]">暂无本文引用</p> : data.outgoing.map((item) => { const href = item.href ?? `#/doc/${item.id}`; return <div key={item.id} className="flex items-center gap-1.5 rounded-md px-8 hover:bg-[#E9EBEF] dark:hover:bg-surface">{icon}<a href={href} onClick={(event) => open(event, href)} className="min-w-0 truncate py-2 text-[#3370FF] hover:underline">{item.title.trim() || "未命名文档"}</a></div>; }))}
    </div>}
    {graphOpen && <DocumentReferenceGraph rootId={id} rootTitle={title} userId={userId} enabled={enabled} synced={synced} syncVersion={syncVersion} loadReferences={fetchDocumentReferences} onClose={() => setGraphOpen(false)} />}
    {confirmHide && onHide && <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !hiding) setConfirmHide(false); }}><section ref={confirmRef} role="dialog" aria-modal="true" aria-labelledby="reference-hide-title" className="w-full max-w-[420px] rounded-lg bg-surface p-6 text-foreground shadow-xl"><h2 id="reference-hide-title" className="text-[16px] font-medium">隐藏文档引用</h2><p className="mt-3 text-[14px] leading-6 text-muted-foreground">隐藏后，所有协作者都将看不到文档底部的引用列表。可在文档菜单中重新显示。</p>{hideError && <p role="alert" className="mt-3 text-[13px] text-destructive">设置未能确认，请检查后重试。</p>}<div className="mt-6 flex justify-end gap-2"><button type="button" disabled={hiding} onClick={() => setConfirmHide(false)} className="h-8 rounded-md border px-4 text-[13px] hover:bg-hover disabled:opacity-50">取消</button><button type="button" disabled={hiding} onClick={() => { void onHide().then((ok) => { if (ok) setConfirmHide(false); else setHideError(true); }).catch(() => setHideError(true)); }} className="h-8 rounded-md bg-[#1456F0] px-4 text-[13px] text-white hover:bg-[#0F4DD6] disabled:opacity-50">{hiding ? "正在隐藏…" : "隐藏"}</button></div></section></div>}
  </section>;
}

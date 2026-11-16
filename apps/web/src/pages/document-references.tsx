import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Link2, RefreshCw } from "lucide-react";
import { navigateDocumentHash } from "@/editor/block-handle";

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
export function DocumentReferencesPanel({ id, userId, enabled, synced, allowCopy }: { id: number; userId: number; enabled: boolean; synced: boolean; allowCopy: boolean }) {
  const marker = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [inView, setInView] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    if (!enabled || !marker.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); setInView(true); return; }
    const observer = new IntersectionObserver((entries) => { const intersects = entries.some((entry) => entry.isIntersecting); setInView(intersects); if (intersects) setVisible(true); }, { rootMargin: "200px" });
    observer.observe(marker.current);
    return () => observer.disconnect();
  }, [enabled]);
  const query = useQuery({ queryKey: ["document-references", userId, id], queryFn: ({ signal }) => fetchDocumentReferences(id, userId, signal), enabled: enabled && visible, retry: false, refetchOnWindowFocus: true, refetchInterval: inView ? 30_000 : false, refetchIntervalInBackground: false });
  useEffect(() => {
    if (enabled && visible && inView && query.isSuccess && !query.isFetching && Date.now() - query.dataUpdatedAt >= 30_000) void query.refetch();
  }, [enabled, visible, inView, query.isSuccess, query.isFetching, query.dataUpdatedAt, query.refetch]);
  const data = enabled && query.isSuccess && !query.isFetching && Date.now() - query.dataUpdatedAt < 30_000 ? query.data : undefined;
  const toggle = (key: number) => setExpanded((old) => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const open = (event: React.MouseEvent<HTMLAnchorElement>, hash: string) => { event.preventDefault(); navigateDocumentHash(hash); };
  return <section ref={marker} data-document-references className="mt-16 border-t border-[#E5E6EB] pt-5 text-[14px] text-[#1F2329] dark:border-border dark:text-foreground print:hidden" onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }}>
    <div className="mb-4 flex items-center gap-2"><Link2 size={16} className="text-[#646A73]" /><h2 className="font-medium">文档引用</h2><button type="button" aria-label="刷新文档引用" title="刷新" disabled={!enabled || !visible || query.isFetching} onClick={() => void query.refetch()} className="ml-auto grid size-7 place-items-center rounded text-[#8F959E] hover:bg-hover disabled:opacity-40"><RefreshCw size={14}/></button></div>
    {!synced && <p className="mb-3 text-[12px] text-[#8F959E]">文档尚未同步，引用结果以已保存内容为准。</p>}
    {visible && (query.isFetching || query.isPending) && <p role="status" className="py-3 text-[13px] text-[#8F959E]">正在加载文档引用…</p>}
    {visible && query.isError && !query.isFetching && <p role="alert" className="py-3 text-[13px] text-[#8F959E]">引用查询未完成，文档过多、内容过大或服务暂不可用，可点击刷新重试。</p>}
    {data && <div className="grid gap-6 sm:grid-cols-2">
      <div><h3 className="mb-2 text-[13px] font-medium text-[#646A73]">被引用 <span className="text-[#8F959E]">{data.incoming.length}</span></h3>
        {data.incoming.length === 0 ? <p className="py-2 text-[13px] text-[#8F959E]">暂无被引用文档</p> : data.incoming.map((item) => <div key={item.id} className="rounded-md hover:bg-[#F5F6F7] dark:hover:bg-hover">
          <div className="flex min-w-0 items-center"><button type="button" aria-label={`${expanded.has(item.id) ? "收起" : "展开"}${item.title || "未命名文档"}的引用位置`} aria-expanded={expanded.has(item.id)} onClick={() => toggle(item.id)} className="grid size-8 shrink-0 place-items-center text-[#8F959E]">{expanded.has(item.id) ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button><a href={`#/doc/${item.id}`} onClick={(event) => open(event, `#/doc/${item.id}`)} className="min-w-0 truncate py-2 pr-2 hover:text-[#1456F0]">{item.title.trim() || "未命名文档"}</a></div>
          {expanded.has(item.id) && <div className="pb-2 pl-8 pr-2">{item.contexts?.map((context) => { const href = `#/doc/${item.id}?block=${encodeURIComponent(context.block)}`; return <a key={context.block} href={href} onClick={(event) => open(event, href)} className="block truncate rounded px-2 py-1 text-[12px] text-[#8F959E] hover:bg-[#E5EDFF] hover:text-[#1456F0] dark:hover:bg-hover">{context.text || "查看引用位置"}</a>; })}</div>}
        </div>)}
      </div>
      <div><h3 className="mb-2 text-[13px] font-medium text-[#646A73]">引用文档 <span className="text-[#8F959E]">{data.outgoing.length}</span></h3>
        {data.outgoing.length === 0 ? <p className="py-2 text-[13px] text-[#8F959E]">暂无引用文档</p> : data.outgoing.map((item) => { const href = item.href ?? `#/doc/${item.id}`; return <a key={item.id} href={href} onClick={(event) => open(event, href)} className="block truncate rounded-md px-2 py-2 hover:bg-[#F5F6F7] hover:text-[#1456F0] dark:hover:bg-hover">{item.title.trim() || "未命名文档"}</a>; })}
      </div>
    </div>}
  </section>;
}

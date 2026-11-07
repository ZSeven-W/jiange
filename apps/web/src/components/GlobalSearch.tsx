import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Clock3, Filter, Grid2X2, Search, X } from "lucide-react";
import { ApiError, docsApi, extrasApi, type DocMeta } from "@/lib/api";
import { go } from "@/lib/route";
import { DocumentGlyph } from "./DocumentGlyph";
import { DocColorIcon } from "./FeishuIcons";
import { SearchOpenGuard, searchKeyboardTarget } from "./globalSearchActions";

type SearchDoc = DocMeta & { viewedAt?: string };
type QueryStatus = { isFetching: boolean; isPending: boolean; isError: boolean; fetchStatus: string; data?: SearchDoc[] };
export type GlobalSearchState = { status: "loading" | "error" | "empty" | "ready"; docs: SearchDoc[] };

/** A cached list is never evidence of current access during revalidation. */
export function globalSearchState(keyword: string, debounced: string, recent: QueryStatus, search: QueryStatus): GlobalSearchState {
  const q = keyword ? search : recent;
  if ((keyword && keyword !== debounced) || q.isFetching || q.isPending && q.fetchStatus !== "paused") return { status: "loading", docs: [] };
  if (q.isError || q.fetchStatus === "paused") return { status: "error", docs: [] };
  return q.data?.length ? { status: "ready", docs: q.data } : { status: "empty", docs: [] };
}

export function filterGlobalSearch(docs: SearchDoc[], kind: string, owner: string, userId: number): SearchDoc[] {
  return docs.filter((d) => (kind === "all" || (d.kind ?? "doc") === kind) && (owner !== "mine" || d.creatorId === userId));
}

function timeLabel(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const hhmm = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (day === dateDay) return `今天 ${hhmm}`;
  if (day - dateDay === 86400000) return `昨天 ${hhmm}`;
  return date.toLocaleDateString("zh-CN");
}

/** Global document search. It is mounted only for the active authenticated session. */
export function GlobalSearch({ userId, onClose }: { userId: number; onClose: (restoreFocus: boolean) => void }) {
  const instance = useId();
  const [value, setValue] = useState("");
  const [debounced, setDebounced] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [kind, setKind] = useState("all");
  const [owner, setOwner] = useState("all");
  const [opening, setOpening] = useState<number | null>(null);
  const [openError, setOpenError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const openGuard = useRef(new SearchOpenGuard());
  const visibleIds = useRef<number[]>([]);
  const keyword = value.trim();
  useEffect(() => {
    if (!keyword) { setDebounced(""); return; }
    const timer = window.setTimeout(() => setDebounced(keyword), 250);
    return () => window.clearTimeout(timer);
  }, [keyword]);
  useEffect(() => {
    openGuard.current.activate();
    input.current?.focus();
    return () => { openGuard.current.dispose(); };
  }, []);

  // Keys are isolated from the sidebar/home caches and from other openings.
  const recent = useQuery({ queryKey: ["global-search-recent", userId, instance], queryFn: docsApi.recent, enabled: !keyword,
    gcTime: 0, retry: false, refetchOnMount: "always", refetchOnWindowFocus: "always", refetchInterval: 15000, refetchIntervalInBackground: false });
  const search = useQuery({ queryKey: ["global-search-query", userId, instance, debounced], queryFn: ({ signal }) => extrasApi.search(debounced, signal),
    enabled: !!keyword && keyword === debounced, gcTime: 0, retry: false, refetchOnMount: "always", refetchOnWindowFocus: "always", refetchInterval: 15000, refetchIntervalInBackground: false });
  const state = globalSearchState(keyword, debounced, recent, search);
  const docs = useMemo(() => filterGlobalSearch(state.docs, kind, owner, userId), [state.docs, kind, owner, userId]);
  visibleIds.current = state.status === "ready" ? docs.map((doc) => doc.id) : [];
  const invalidateOpen = () => {
    openGuard.current.invalidate();
    setOpening(null);
    setOpenError("");
    setSelected(null);
  };

  const openDoc = async (doc: SearchDoc) => {
    const version = openGuard.current.begin();
    if (version === null) return;
    setOpening(doc.id); setOpenError("");
    try {
      // Access may have changed since the list response. Never navigate on an
      // old list entry without checking this account's current document grant.
      const current = await docsApi.get(doc.id);
      if (!openGuard.current.current(version)) return;
      if (!visibleIds.current.includes(doc.id)) {
        setOpenError("搜索结果已变化，请重新选择。");
        return;
      }
      onClose(false);
      go(current.kind === "base" ? `#/base/${current.id}` : `#/doc/${current.id}`);
    } catch (error) {
      if (!openGuard.current.current(version)) return;
      setOpenError(error instanceof ApiError && [401, 403, 404].includes(error.status)
        ? "文档不存在或访问权限已变化，请重新搜索。" : "无法确认文档访问权限，请检查网络后重试。");
      void (keyword ? search.refetch() : recent.refetch());
    } finally {
      if (openGuard.current.current(version)) { openGuard.current.finish(version); setOpening(null); }
    }
  };

  return createPortal(<div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/45 px-3 pt-[max(24px,8vh)] sm:px-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(false); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="全局搜索" className="flex max-h-[min(600px,calc(100dvh-48px))] w-full max-w-[540px] flex-col overflow-hidden rounded-lg border bg-surface text-foreground shadow-[0_16px_48px_rgba(31,35,41,0.24)]" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(true); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const nodes = [...dialog.current.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled),select:not(:disabled),[href]:not([tabindex="-1"])')];
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!dialog.current.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <Search size={18} className="shrink-0 text-subtle" aria-hidden="true" />
        <input ref={input} type="search" role="combobox" aria-autocomplete="list" aria-expanded={state.status === "ready" && docs.length > 0} aria-controls={`${instance}-results`} aria-activedescendant={selected !== null && visibleIds.current.includes(selected) ? `${instance}-result-${selected}` : undefined} value={value} onChange={(event) => { invalidateOpen(); setValue(event.target.value); }} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter")) return;
          const target = searchKeyboardTarget(visibleIds.current, selected, event.key);
          if (target === null) return;
          event.preventDefault();
          if (event.key === "Enter") {
            const doc = docs.find((item) => item.id === target);
            if (doc) void openDoc(doc);
          } else {
            setSelected(target);
            document.getElementById(`${instance}-result-${target}`)?.scrollIntoView({ block: "nearest" });
          }
        }} aria-label="搜索文档标题和正文" placeholder="搜索" className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-subtle sm:text-[14px]" />
        <button type="button" aria-label="筛选搜索结果" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)} className="grid size-8 place-items-center rounded text-muted-foreground hover:bg-hover"><Filter size={17}/></button>
        <button type="button" aria-label="关闭搜索" onClick={() => onClose(true)} className="grid size-8 place-items-center rounded text-muted-foreground hover:bg-hover"><X size={17}/></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)} className="my-1 flex h-9 w-full items-center gap-2 rounded-md bg-sidebar px-3 text-left text-[13px] font-medium hover:bg-hover">
          <span className="grid size-6 place-items-center rounded-full bg-[#3370ff] text-white"><Search size={14}/></span>高级搜索
        </button>
        {advanced && <div className="mx-1 mb-2 flex flex-wrap items-end gap-3 rounded-md border px-3 py-2 text-[12px] text-muted-foreground">
          <label className="grid gap-1">文档类型<select aria-label="文档类型筛选" value={kind} onChange={(e) => { invalidateOpen(); setKind(e.target.value); }} className="h-8 min-w-28 rounded border bg-surface px-2 text-foreground"><option value="all">全部类型</option><option value="doc">文档</option><option value="base">多维表格</option></select></label>
          <label className="grid gap-1">所有者<select aria-label="所有者筛选" value={owner} onChange={(e) => { invalidateOpen(); setOwner(e.target.value); }} className="h-8 min-w-28 rounded border bg-surface px-2 text-foreground"><option value="all">所有人</option><option value="mine">我创建的</option></select></label>
          <span className="pb-1">{keyword ? "筛选当前搜索结果" : "筛选最近浏览"}</span>
        </div>}
        <div className="px-2 pb-1 pt-2 text-[12px] text-subtle">{keyword ? "搜索结果" : "最近浏览"}</div>
        {openError && <p role="alert" className="px-2 py-2 text-[13px] text-destructive">{openError}</p>}
        {state.status === "loading" && <p role="status" className="px-2 py-8 text-center text-[13px] text-subtle">{keyword ? "正在搜索…" : "正在加载最近浏览…"}</p>}
        {state.status === "error" && <div role="alert" className="px-2 py-8 text-center text-[13px] text-destructive">{keyword && search.error instanceof ApiError && search.error.code === "search_incomplete" ? "搜索未完成，请稍后重试。" : "加载失败，请检查网络。"} <button type="button" className="text-primary underline" onClick={() => void (keyword ? search.refetch() : recent.refetch())}>重试</button></div>}
        {state.status === "empty" && <p className="px-2 py-8 text-center text-[13px] text-subtle">{keyword ? "没有找到相关文档" : "暂无最近浏览的文档"}</p>}
        {state.status === "ready" && !docs.length && <p className="px-2 py-8 text-center text-[13px] text-subtle">没有符合筛选条件的文档</p>}
        <div id={`${instance}-results`} role="listbox" aria-label={keyword ? "搜索结果" : "最近浏览"}>
        {state.status === "ready" && docs.map((doc) => <button id={`${instance}-result-${doc.id}`} role="option" aria-selected={selected === doc.id} key={`${doc.kind ?? "doc"}:${doc.id}`} type="button" disabled={opening !== null} onFocus={() => setSelected(doc.id)} onClick={() => void openDoc(doc)} className={`flex min-h-[59px] w-full items-center gap-3 rounded-md px-2 text-left hover:bg-hover focus-visible:bg-hover disabled:opacity-60 ${selected === doc.id ? "bg-hover" : ""}`}>
          <span className="grid size-7 shrink-0 place-items-center">{doc.kind === "base" ? <Grid2X2 size={20} className="text-[#7b56d9]"/> : <DocumentGlyph icon={doc.icon} className="!size-6 !text-xl" fallback={<DocColorIcon className="size-6"/>}/>}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{doc.title.trim() || "未命名文档"}</span><span className="mt-0.5 block truncate text-[12px] text-subtle">{doc.workspaceName || "我的文档库"}{doc.creatorName ? ` · 所有者：${doc.creatorName}` : ""}{doc.viewedAt ? ` · ${timeLabel(doc.viewedAt)}访问` : ""}</span></span>
        </button>)}
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center gap-2 border-t bg-sidebar px-4 text-[12px] text-subtle"><Clock3 size={14}/><button type="button" onClick={() => { onClose(false); go("#/recent"); }} className="truncate hover:text-foreground">查看最近浏览的文档</button></div>
    </div>
  </div>, document.body);
}

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Clock3, FileText, Filter, Folder, Grid2X2, Presentation, Search, X } from "lucide-react";
import { ApiError, docsApi, extrasApi, type DocMeta, type SearchFilters } from "@/lib/api";
import { go, nodeHref } from "@/lib/route";
import { DocumentGlyph } from "./document-glyph";
import { DocColorIcon, SheetColorIcon, WhiteboardIcon } from "./feishu-icons";
import { docTitle, isBoardDoc } from "./sidebar";
import { SearchOpenGuard, searchKeyboardTarget } from "./global-search-actions";

type SearchDoc = DocMeta & { viewedAt?: string };
type QueryStatus = { isFetching: boolean; isPending: boolean; isError: boolean; fetchStatus: string; data?: SearchDoc[] };
export type GlobalSearchState = { status: "loading" | "error" | "empty" | "ready"; docs: SearchDoc[] };

/** A cached list is never evidence of current access during revalidation. */
export function globalSearchState(
  keyword: string,
  debounced: string,
  recent: QueryStatus,
  search: QueryStatus,
  useSearch = Boolean(keyword),
): GlobalSearchState {
  const q = useSearch ? search : recent;
  if ((keyword && keyword !== debounced) || q.isFetching || q.isPending && q.fetchStatus !== "paused") return { status: "loading", docs: [] };
  if (q.isError || q.fetchStatus === "paused") return { status: "error", docs: [] };
  return q.data?.length ? { status: "ready", docs: q.data } : { status: "empty", docs: [] };
}

export function buildFolderOptions(nodes: DocMeta[]): { id: number; label: string }[] {
  const folders = nodes.filter((n) => n.kind === "folder");
  const byId = new Map<number, DocMeta>(folders.map((f) => [f.id, f]));
  const options = folders.map((f) => {
    const parts: string[] = [];
    const seen = new Set<number>();
    let cur: DocMeta | undefined = f;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.title || t("未命名文件夹"));
      cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
    }
    return { id: f.id, label: parts.join(" / ") };
  });
  return options.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

function parseDateBoundMs(dateStr: string, endOfDay: boolean): number | null {
  if (!dateStr) return null;
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  const dt = endOfDay ? new Date(y, m - 1, d + 1, 0, 0, 0, 0) : new Date(y, m - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function filterGlobalSearch(
  docs: SearchDoc[],
  kind: string,
  owner: string,
  userId: number,
  withinDays = 0,
  updatedFrom = "",
  updatedTo = "",
): SearchDoc[] {
  const since = withinDays > 0 ? Date.now() - withinDays * 86400000 : 0;
  const fromMs = parseDateBoundMs(updatedFrom, false);
  const toMs = parseDateBoundMs(updatedTo, true);
  return docs.filter((d) => {
    if (kind === "board" && !isBoardDoc(d)) return false;
    if (kind === "doc" && ((d.kind ?? "doc") !== "doc" || isBoardDoc(d))) return false;
    if (kind !== "all" && kind !== "board" && kind !== "doc" && (d.kind ?? "doc") !== kind) return false;
    if (owner === "mine" && d.creatorId !== userId) return false;
    if (since > 0) {
      const ts = new Date(d.viewedAt ?? d.updatedAt ?? 0).getTime();
      if (ts < since) return false;
    }
    if (fromMs !== null || toMs !== null) {
      const ts = new Date(d.updatedAt ?? d.viewedAt ?? 0).getTime();
      if (fromMs !== null && ts < fromMs) return false;
      if (toMs !== null && ts >= toMs) return false;
    }
    return true;
  });
}

function timeLabel(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const hhmm = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (day === dateDay) return `${t("今天")} ${hhmm}`;
  if (day - dateDay === 86400000) return `${t("昨天")} ${hhmm}`;
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
  const [within, setWithin] = useState("0");
  const [folderId, setFolderId] = useState("");
  const [updatedFrom, setUpdatedFrom] = useState("");
  const [updatedTo, setUpdatedTo] = useState("");
  const [opening, setOpening] = useState<number | null>(null);
  const [openError, setOpenError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const openGuard = useRef(new SearchOpenGuard());
  const visibleIds = useRef<number[]>([]);
  const keyword = value.trim();
  const hasServerFilters = Boolean(folderId || updatedFrom || updatedTo);
  const hasAnyFilter = kind !== "all" || owner !== "all" || within !== "0" || hasServerFilters;
  const useSearch = Boolean(keyword || hasServerFilters);

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

  const folderList = useQuery({
    queryKey: ["global-search-folders", userId, instance],
    queryFn: docsApi.list,
    enabled: advanced,
    gcTime: 0,
    retry: false,
  });
  const folderOptions = useMemo(() => buildFolderOptions(folderList.data ?? []), [folderList.data]);

  const serverFilters = useMemo<SearchFilters>(() => {
    const f: SearchFilters = {};
    if (kind !== "all") f.kind = kind;
    if (owner !== "all") f.owner = owner;
    if (folderId) {
      const id = Number(folderId);
      if (Number.isFinite(id) && id > 0) f.folderId = id;
    }
    if (updatedFrom) f.updatedFrom = updatedFrom;
    if (updatedTo) f.updatedTo = updatedTo;
    return f;
  }, [kind, owner, folderId, updatedFrom, updatedTo]);

  // Keys are isolated from the sidebar/home caches and from other openings.
  const recent = useQuery({ queryKey: ["global-search-recent", userId, instance], queryFn: docsApi.recent, enabled: !useSearch,
    gcTime: 0, retry: false, refetchOnMount: "always", refetchOnWindowFocus: "always", refetchInterval: 15000, refetchIntervalInBackground: false });
  const search = useQuery({
    queryKey: ["global-search-query", userId, instance, debounced, serverFilters],
    queryFn: ({ signal }) => extrasApi.search(debounced, signal, serverFilters),
    enabled: useSearch && (!keyword || keyword === debounced),
    gcTime: 0, retry: false, refetchOnMount: "always", refetchOnWindowFocus: "always", refetchInterval: 15000, refetchIntervalInBackground: false,
  });
  const state = globalSearchState(keyword, debounced, recent, search, useSearch);
  const docs = useMemo(
    () => filterGlobalSearch(state.docs, kind, owner, userId, Number(within), updatedFrom, updatedTo),
    [state.docs, kind, owner, userId, within, updatedFrom, updatedTo],
  );
  visibleIds.current = state.status === "ready" ? docs.map((doc) => doc.id) : [];
  const invalidateOpen = () => {
    openGuard.current.invalidate();
    setOpening(null);
    setOpenError("");
    setSelected(null);
  };
  const resetFilters = () => {
    invalidateOpen();
    setKind("all");
    setOwner("all");
    setWithin("0");
    setFolderId("");
    setUpdatedFrom("");
    setUpdatedTo("");
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
        setOpenError(t("搜索结果已变化，请重新选择。"));
        return;
      }
      onClose(false);
      go(nodeHref(current));
    } catch (error) {
      if (!openGuard.current.current(version)) return;
      setOpenError(error instanceof ApiError && [401, 403, 404].includes(error.status)
        ? t("文档不存在或访问权限已变化，请重新搜索。") : t("无法确认文档访问权限，请检查网络后重试。"));
      void (useSearch ? search.refetch() : recent.refetch());
    } finally {
      if (openGuard.current.current(version)) { openGuard.current.finish(version); setOpening(null); }
    }
  };

  return createPortal(<div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/45 px-3 pt-[max(24px,8vh)] sm:px-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(false); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("全局搜索")} className="flex max-h-[min(640px,calc(100dvh-48px))] w-full max-w-[600px] flex-col overflow-hidden rounded-lg border bg-surface text-foreground shadow-[0_16px_48px_rgba(31,35,41,0.24)]" onKeyDown={(event) => {
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
        }} aria-label={t("搜索文档标题和正文")} placeholder={t("搜索")} className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-subtle sm:text-[14px]" />
        <button type="button" aria-label={t("筛选搜索结果")} aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)} className={`grid size-8 place-items-center rounded hover:bg-hover ${hasAnyFilter ? "text-[#3370ff]" : "text-muted-foreground"}`}><Filter size={17}/></button>
        <button type="button" aria-label={t("关闭搜索")} onClick={() => onClose(true)} className="grid size-8 place-items-center rounded text-muted-foreground hover:bg-hover"><X size={17}/></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)} className="my-1 flex h-9 w-full items-center gap-2 rounded-md bg-sidebar px-3 text-left text-[13px] font-medium hover:bg-hover">
          <span className="grid size-6 place-items-center rounded-full bg-[#3370ff] text-white"><Search size={14}/></span>{t("高级搜索")}
        </button>
        {advanced && <div className="mx-1 mb-2 grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border bg-sidebar/40 px-3 py-2.5 text-[12px] text-muted-foreground sm:grid-cols-3">
          <label className="grid gap-1">{t("文档类型")}<select aria-label={t("文档类型筛选")} value={kind} onChange={(e) => { invalidateOpen(); setKind(e.target.value); }} className="h-8 rounded border bg-surface px-2 text-foreground"><option value="all">{t("全部类型")}</option><option value="doc">{t("文档")}</option><option value="sheet">{t("表格")}</option><option value="board">{t("画板")}</option><option value="base">{t("多维表格")}</option><option value="slides">{t("幻灯片")}</option><option value="survey">{t("问卷")}</option><option value="folder">{t("文件夹")}</option><option value="file">{t("文件")}</option></select></label>
          <label className="grid gap-1">{t("所有者")}<select aria-label={t("所有者筛选")} value={owner} onChange={(e) => { invalidateOpen(); setOwner(e.target.value); }} className="h-8 rounded border bg-surface px-2 text-foreground"><option value="all">{t("所有人")}</option><option value="mine">{t("我创建的")}</option></select></label>
          <label className="grid gap-1">{t("所在目录")}<select aria-label={t("所在目录筛选")} value={folderId} onChange={(e) => { invalidateOpen(); setFolderId(e.target.value); }} className="h-8 rounded border bg-surface px-2 text-foreground"><option value="">{t("全部目录")}</option>{folderOptions.map((opt) => <option key={opt.id} value={String(opt.id)}>{opt.label}</option>)}</select></label>
          <label className="grid gap-1">{t("更新时间")}<select aria-label={t("更新时间筛选")} value={within} onChange={(e) => { invalidateOpen(); setWithin(e.target.value); }} className="h-8 rounded border bg-surface px-2 text-foreground"><option value="0">{t("全部时间")}</option><option value="7">{t("最近 7 天")}</option><option value="30">{t("最近 30 天")}</option></select></label>
          <label className="grid gap-1">{t("开始日期")}<input type="date" aria-label={t("更新开始日期")} value={updatedFrom} onChange={(e) => { invalidateOpen(); setUpdatedFrom(e.target.value); }} className="h-8 rounded border bg-surface px-2 text-foreground" /></label>
          <label className="grid gap-1">{t("结束日期")}<input type="date" aria-label={t("更新结束日期")} value={updatedTo} onChange={(e) => { invalidateOpen(); setUpdatedTo(e.target.value); }} className="h-8 rounded border bg-surface px-2 text-foreground" /></label>
          <div className="col-span-2 flex items-center justify-between pt-0.5 sm:col-span-3">
            <span>{useSearch ? t("按筛选条件搜索") : t("筛选最近浏览")}</span>
            {hasAnyFilter && <button type="button" onClick={resetFilters} className="text-[#3370ff] hover:underline">{t("重置筛选")}</button>}
          </div>
        </div>}
        <div className="px-2 pb-1 pt-2 text-[12px] text-subtle">{useSearch ? t("搜索结果") : t("最近浏览")}</div>
        {openError && <p role="alert" className="px-2 py-2 text-[13px] text-destructive">{openError}</p>}
        {state.status === "loading" && <p role="status" className="px-2 py-8 text-center text-[13px] text-subtle">{useSearch ? t("正在搜索…") : t("正在加载最近浏览…")}</p>}
        {state.status === "error" && <div role="alert" className="px-2 py-8 text-center text-[13px] text-destructive">{useSearch && search.error instanceof ApiError && search.error.code === "search_incomplete" ? t("搜索未完成，请稍后重试。") : t("加载失败，请检查网络。")} <button type="button" className="text-primary underline" onClick={() => void (useSearch ? search.refetch() : recent.refetch())}>{t("重试")}</button></div>}
        {state.status === "empty" && <p className="px-2 py-8 text-center text-[13px] text-subtle">{useSearch ? t("没有找到相关文档") : t("暂无最近浏览的文档")}</p>}
        {state.status === "ready" && !docs.length && <p className="px-2 py-8 text-center text-[13px] text-subtle">{t("没有符合筛选条件的文档")}</p>}
        <div id={`${instance}-results`} role="listbox" aria-label={useSearch ? t("搜索结果") : t("最近浏览")}>
        {state.status === "ready" && docs.map((doc) => <button id={`${instance}-result-${doc.id}`} role="option" aria-selected={selected === doc.id} key={`${doc.kind ?? "doc"}:${doc.id}`} type="button" disabled={opening !== null} onFocus={() => setSelected(doc.id)} onClick={() => void openDoc(doc)} className={`flex min-h-[59px] w-full items-center gap-3 rounded-md px-2 text-left hover:bg-hover focus-visible:bg-hover disabled:opacity-60 ${selected === doc.id ? "bg-hover" : ""}`}>
          <span className="grid size-7 shrink-0 place-items-center">{doc.kind === "sheet" ? <SheetColorIcon className="size-6"/> : doc.kind === "base" ? <Grid2X2 size={20} className="text-[#7b56d9]"/> : doc.kind === "survey" ? <ClipboardList size={20} className="text-[#7b56d9]"/> : doc.kind === "folder" ? <Folder size={20} className="text-[#f59e0b]"/> : doc.kind === "file" ? <FileText size={20} className="text-[#3370ff]"/> : doc.kind === "slides" ? <Presentation size={20} className="text-[#ff8800]"/> : isBoardDoc(doc) ? <DocumentGlyph icon={doc.icon} className="!size-6 !text-xl" fallback={<WhiteboardIcon className="size-6 text-[#34c759]"/>}/> : <DocumentGlyph icon={doc.icon} className="!size-6 !text-xl" fallback={<DocColorIcon className="size-6"/>}/>}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{docTitle(doc)}</span><span className="mt-0.5 block truncate text-[12px] text-subtle">{doc.workspaceName || t("我的文档库")}{doc.creatorName ? t(" · 所有者：{name}", { name: doc.creatorName }) : ""}{doc.viewedAt ? t(" · {time}访问", { time: timeLabel(doc.viewedAt) }) : ""}</span></span>
        </button>)}
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center gap-2 border-t bg-sidebar px-4 text-[12px] text-subtle"><Clock3 size={14}/><button type="button" onClick={() => { onClose(false); go("#/recent"); }} className="truncate hover:text-foreground">{t("查看最近浏览的文档")}</button></div>
    </div>
  </div>, document.body);
}

import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, HelpCircle, Plus } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, docsApi, type DocView } from "@/lib/api";
import { ask } from "@/components/ui/ask";
import { canDiffViews, diffViews, type DiffRow } from "./VersionDiff";
import { formatEditTime } from "./docHeaderMeta";
import { ReadOnlyDoc } from "./ReadOnlyDoc";

export function restoreErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status !== 408 && error.status !== 429 && error.status < 500) {
    if (error.message && error.message !== "Conflict") return error.message;
    if (error.status === 409) return "文档已变化或版本无法安全还原，请重新查看后重试。";
    if (error.status === 401 || error.status === 403 || error.status === 404) return "当前无权还原该版本，请检查文档权限。";
  }
  return "无法确认还原结果，请返回文档检查当前内容后再操作。";
}

export function RestoreErrorNotice({ error, canEdit, onRetry, onDismiss }: { error: unknown; canEdit: boolean; onRetry: () => void; onDismiss: () => void }) {
  return <div role="alert" className="mx-4 mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-destructive">
    <p>{restoreErrorMessage(error)}</p>
    <div className="mt-2 flex gap-3">
      {canEdit && error instanceof ApiError && error.status === 409 && <button type="button" className="underline" onClick={onRetry}>重新尝试</button>}
      <button type="button" className="underline" onClick={onDismiss}>关闭提示</button>
    </div>
  </div>;
}

/** Full-screen history view with a timeline and a read-only document preview. */
export function VersionPanel({ id, userId, canEdit, canRestore, allowCopy = true, disableFileDownloads, currentView, onClose, onCreateVersion }: { id: number; userId: number; canEdit: boolean; canRestore: boolean; allowCopy?: boolean; disableFileDownloads: boolean; currentView?: DocView; onClose: () => void; onCreateVersion: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["versions", userId, id], queryFn: () => docsApi.versionEntries(id, userId) });
  const listVisible = list.isSuccess && !list.isFetching;
  const [previewing, setPreviewing] = useState<{ id: string; seq: number } | null>(null);
  const [diffMode, setDiffMode] = useState(false);
  const [mobilePreview, setMobilePreview] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const mobileToggle = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const confirming = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    back.current?.focus();
    return () => { mounted.current = false; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches) mobileToggle.current?.focus();
  }, [mobilePreview]);
  useEffect(() => {
    if (!listVisible || !list.data.length) return;
    if (!previewing || !list.data.some((version) => version.id === previewing.id && version.seq === previewing.seq)) {
      const first = list.data[0]; setPreviewing({ id: first.id, seq: first.seq });
    }
  }, [listVisible, list.data, previewing]);
  const selectedIndex = listVisible && previewing ? list.data.findIndex((v) => v.id === previewing.id && v.seq === previewing.seq) : -1;
  const preview = useQuery({
    queryKey: ["versions", userId, id, "preview", previewing?.seq],
    queryFn: () => docsApi.versionPreview(id, previewing!.seq),
    enabled: previewing !== null && selectedIndex >= 0,
  });
  const previewReady = canRestore && selectedIndex >= 0 && preview.isSuccess && !preview.isFetching;
  const latest = useRef({ id, userId, canRestore, previewing, previewReady });
  latest.current = { id, userId, canRestore, previewing, previewReady };
  const restore = useMutation({
    mutationFn: async (seq: number) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try { return await docsApi.restoreVersion(id, seq, userId, controller.signal); }
      finally { clearTimeout(timeout); }
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["versions", userId, id] }); },
  });
  const selectVersion = (v: { id: string; seq: number }) => {
    if (restore.isPending) return;
    restore.reset(); setPreviewing({ id: v.id, seq: v.seq }); setMobilePreview(true);
  };
  const startRestore = async () => {
    const target = latest.current;
    if (!target.canRestore || !target.previewReady || target.previewing === null || restore.isPending || confirming.current) return;
    confirming.current = true;
    let started = false;
    try {
      const confirmed = await ask("还原到该版本？", "当前内容会被新操作覆盖（历史保留）。", false);
      if (confirmed && mounted.current && latest.current.id === target.id && latest.current.userId === target.userId && latest.current.canRestore && latest.current.previewReady && latest.current.previewing === target.previewing) {
        restore.reset(); root.current?.focus(); restore.mutate(target.previewing.seq); started = true;
      }
    } finally { confirming.current = false; if (mounted.current && !started) back.current?.focus(); }
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (confirming.current) return;
    if (event.key === "Escape" && !confirming.current && !restore.isPending) { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab" || !root.current) return;
    const items = [...root.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled])")].filter((item) => item.getClientRects().length > 0);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === items.length - 1) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); }
  };
  const savedTitle = preview.data?.view.blocks.find((b) => b.type === "title")?.spans.map((span) => span.text).join("") || "未命名文档";
  const group = (iso: string) => {
    const date = new Date(iso); if (Number.isNaN(date.getTime())) return "其他";
    const now = new Date(); if (date.toDateString() === now.toDateString()) return "今天";
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1); if (date.toDateString() === yesterday.toDateString()) return "昨天";
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  };
  return <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label="历史记录" onKeyDown={onKeyDown} data-version-panel data-document-print-restricted={disableFileDownloads ? "true" : undefined} className="fixed inset-0 z-40 flex min-h-0 flex-col bg-surface text-foreground">
    <header className="flex h-14 shrink-0 items-center border-b sm:h-16">
      <button ref={back} type="button" onClick={onClose} disabled={restore.isPending} className="ml-3 flex h-9 items-center gap-1.5 rounded px-2 text-[14px] hover:bg-hover disabled:opacity-40 sm:ml-4"><ArrowLeft size={16}/><span>返回文档</span></button>
      <span className="mx-2 h-5 w-px bg-border sm:mx-3" />
      <span className="flex-1" />
      {canEdit && <button type="button" disabled={restore.isPending || !previewReady} onClick={() => void startRestore()} className="h-9 rounded px-2 text-[13px] text-[#1456F0] hover:bg-hover disabled:text-[#BBBFC4]" data-restore-version>{restore.isPending ? "还原中…" : "还原此历史记录"}</button>}
      <div className="hidden items-center gap-1 px-2 text-[13px] sm:flex">
        <button type="button" aria-label="上一个版本" disabled={!listVisible || selectedIndex <= 0 || restore.isPending} onClick={() => { if (listVisible && selectedIndex > 0) selectVersion(list.data[selectedIndex - 1]); }} className="rounded p-1 text-subtle hover:bg-hover disabled:opacity-30"><ChevronUp size={16}/></button>
        <span className="min-w-8 text-center">{selectedIndex >= 0 ? selectedIndex + 1 : 0}/{listVisible ? list.data.length : 0}</span>
        <button type="button" aria-label="下一个版本" disabled={!listVisible || selectedIndex < 0 || selectedIndex >= list.data.length - 1 || restore.isPending} onClick={() => { if (listVisible && selectedIndex >= 0 && selectedIndex + 1 < list.data.length) selectVersion(list.data[selectedIndex + 1]); }} className="rounded p-1 text-subtle hover:bg-hover disabled:opacity-30"><ChevronDown size={16}/></button>
      </div>
      <button ref={mobileToggle} type="button" onClick={() => setMobilePreview((v) => !v)} className="mr-2 rounded px-2 py-2 text-[13px] text-[#1456F0] hover:bg-hover md:hidden">{mobilePreview ? "版本列表" : "预览"}</button>
      <div className="hidden h-full w-[294px] shrink-0 items-center gap-2 border-l px-4 text-[16px] font-medium md:flex"><span>历史记录</span><HelpCircle size={14} className="text-subtle" aria-label="命名版本与历史快照"/>{canEdit && <button type="button" onClick={onCreateVersion} aria-label="创建当前版本" title="创建当前版本" className="ml-auto grid size-8 place-items-center rounded text-muted-foreground hover:bg-hover" data-create-version><Plus size={17}/></button>}</div>
    </header>
    <div className="flex min-h-0 flex-1">
      <main className={`${mobilePreview ? "flex" : "hidden"} min-w-0 flex-1 flex-col overflow-y-auto md:flex`} data-version-preview data-document-print-restricted={disableFileDownloads ? "true" : undefined} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }}>
        {restore.isError && <RestoreErrorNotice error={restore.error} canEdit={canRestore} onRetry={() => void startRestore()} onDismiss={() => restore.reset()} />}
        <div className="mx-auto w-full max-w-[960px] px-7 pb-24 pt-12 sm:px-16 sm:pt-14">
          {!listVisible || selectedIndex < 0 ? <p className="text-[14px] text-subtle">{list.isError ? "版本列表不可用。" : list.isFetching ? "正在加载版本…" : "创建版本后可在这里查看。"}</p> : preview.isError ? <p role="alert" className="text-[14px] text-destructive">版本预览加载失败，请检查文档权限。</p> : !preview.data || preview.isFetching ? <p className="text-[14px] text-subtle">正在加载版本…</p> : <>
            <h1 className="mb-8 break-words text-[32px] font-medium leading-[1.3]" data-version-title>{savedTitle}</h1>
            {diffMode && currentView && <section className="mb-6 rounded-md border p-4" aria-label="与当前内容对比"><div className="mb-2 text-[13px] text-muted-foreground">按块比较文本，不包含格式、图片与附件的变化。</div>{canDiffViews(preview.data.view, currentView) ? <VersionDiffView oldView={preview.data.view} newView={currentView} /> : <p className="text-[13px] text-subtle">文档过长，暂无法在浏览器中比较；下方仍可查看完整版本。</p>}</section>}
            <VersionView view={preview.data.view} disableFileDownloads={disableFileDownloads} versionSeq={previewing!.seq} />
          </>}
        </div>
      </main>
      <aside className={`${mobilePreview ? "hidden" : "flex"} min-h-0 w-full shrink-0 flex-col md:flex md:w-[294px] md:border-l`} aria-label="历史版本列表">
        <div className="flex h-12 shrink-0 items-center border-b px-4 text-[15px] font-medium md:hidden"><span>历史记录</span>{canEdit && <button type="button" onClick={onCreateVersion} className="ml-auto flex items-center gap-1 text-[13px] text-[#1456F0]" data-create-version><Plus size={16}/>创建版本</button>}</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {(list.isLoading || list.isFetching) && <p className="px-4 py-8 text-center text-[13px] text-subtle">正在加载版本…</p>}
          {list.isError && <p role="alert" className="px-4 py-8 text-center text-[13px] text-destructive">无法加载版本，请确认文档权限并重试。 <button type="button" className="underline" onClick={() => void list.refetch()}>重试</button></p>}
          {listVisible && list.data.length === 0 && <p className="px-4 py-8 text-center text-[13px] text-subtle">还没有版本</p>}
          {(listVisible ? list.data : []).map((v, i, all) => <Fragment key={v.id}>
            {(i === 0 || group(v.createdAt) !== group(all[i-1].createdAt)) && <div className="border-b px-4 py-2 text-[12px] text-subtle">{group(v.createdAt)}</div>}
            <button type="button" aria-pressed={previewing?.id === v.id} onClick={() => selectVersion(v)} data-version-item={v.id} className={`block w-full border-l-[3px] py-3 pl-7 pr-4 text-left text-[13px] ${previewing?.id === v.id ? "border-[#3370FF] bg-[#E1EAFF] hover:bg-[#E1EAFF] dark:bg-primary/20 dark:hover:bg-primary/20" : "border-transparent hover:bg-hover"}`}>
              <span className="block text-[#1456F0]">{formatEditTime(v.createdAt) || "时间未知"}</span>
              <span className="mt-1 block truncate text-foreground">{v.label || "历史版本"}</span>
              <span className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground"><span className="size-1.5 shrink-0 rounded-full bg-[#8D52E9]"/>{v.createdByName || "系统"}</span>
            </button>
          </Fragment>)}
        </div>
        <div className="flex h-12 shrink-0 items-center justify-between border-t px-4 text-[13px]"><span>对比当前</span><button type="button" role="switch" aria-label="对比当前" aria-checked={diffMode} disabled={!currentView || selectedIndex < 0} onClick={() => setDiffMode((v) => !v)} className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${diffMode ? "bg-[#1456F0]" : "bg-[#BBBFC4]"}`}><span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform ${diffMode ? "left-[18px]" : "left-0.5"}`}/></button></div>
      </aside>
    </div>
  </div>;
}

/** Read-only snapshot projection shared with publicly shared documents. */
export function VersionView({ view, disableFileDownloads = false, versionSeq }: { view: DocView; disableFileDownloads?: boolean; versionSeq?: number }) {
  return <ReadOnlyDoc view={view} disableFileDownloads={disableFileDownloads} imageVersionSeq={versionSeq} />;
}


/** 版本对比视图：老版本（红/删除线）vs 当前（绿底），changed 双列并排。 */
function VersionDiffView({ oldView, newView }: { oldView: DocView; newView: DocView }) {
  const rows = diffViews(oldView, newView);
  const stats = {
    added: rows.filter((r) => r.kind === "added").length,
    removed: rows.filter((r) => r.kind === "removed").length,
    changed: rows.filter((r) => r.kind === "changed").length,
  };
  return (
    <div data-version-diff>
      <div className="mb-3 flex items-center gap-3 text-[12px] text-muted-foreground">
        <span><span className="mr-1 inline-block size-2 rounded-full bg-[#00B42A]" />新增 {stats.added}</span>
        <span><span className="mr-1 inline-block size-2 rounded-full bg-[#F54A45]" />删除 {stats.removed}</span>
        <span><span className="mr-1 inline-block size-2 rounded-full bg-[#FF8800]" />修改 {stats.changed}</span>
      </div>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <DiffRowView key={i} r={r} />
        ))}
      </div>
    </div>
  );
}

function DiffRowView({ r }: { r: DiffRow }) {
  if (r.kind === "same") return <p className="text-foreground">{r.oldText}</p>;
  if (r.kind === "removed")
    return (
      <p className="rounded bg-[#F54A45]/10 px-2 py-0.5 text-[#F54A45] line-through decoration-[#F54A45]/60">
        − {r.oldText}
      </p>
    );
  if (r.kind === "added")
    return (
      <p className="rounded bg-[#00B42A]/10 px-2 py-0.5 text-[#00B42A]">
        + {r.newText}
      </p>
    );
  return (
    <div className="rounded bg-[#FF8800]/8 px-2 py-0.5">
      <p className="text-[#F54A45] line-through decoration-[#F54A45]/60">− {r.oldText}</p>
      <p className="text-[#00B42A]">+ {r.newText}</p>
    </div>
  );
}

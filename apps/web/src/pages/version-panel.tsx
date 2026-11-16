import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronUp, HelpCircle, Link, MoreHorizontal, Plus, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, docsApi, type DocView, type VersionEntry } from "@/lib/api";
import { ask } from "@/components/ui/ask";
import { canDiffViews, diffViews, type DiffRow } from "./version-diff";
import { formatEditTime } from "./doc-header-meta";
import { ReadOnlyDoc } from "./read-only-doc";
import { savedVersionLink, withVersionHash } from "@/lib/version-link";
import { VersionTrashDialog } from "./version-trash-dialog";

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

export type VersionMode = "history" | "saved";

/** History and explicitly saved versions have different visibility rules. */
export function VersionPanel({ id, userId, canEdit, canRestore, canViewHistory = true, mode = "history", initialVersionId, allowCopy = true, disableFileDownloads, currentView, onClose, onCreateVersion }: { id: number; userId: number; canEdit: boolean; canRestore: boolean; canViewHistory?: boolean; mode?: VersionMode; initialVersionId?: string | null; allowCopy?: boolean; disableFileDownloads: boolean; currentView?: DocView; onClose: () => void; onCreateVersion: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["versions", userId, id, "list", mode, canViewHistory],
    queryFn: () => docsApi.versionEntries(id, userId, mode),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: (count, error) => !(error instanceof ApiError && [401, 403, 404].includes(error.status)) && count < 2,
  });
  // Keep the last verified list visible while rechecking; hide it on failure.
  const listVisible = list.isSuccess;
  const listVerified = listVisible && !list.isFetching;
  const [previewing, setPreviewing] = useState<{ id: string; seq: number } | null>(null);
  const [requested, setRequested] = useState<string | null | undefined>(initialVersionId);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [menuVersion, setMenuVersion] = useState<string | null>(null);
  const [versionPicker, setVersionPicker] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<VersionEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [manageError, setManageError] = useState("");
  const [managing, setManaging] = useState(false);
  const [diffMode, setDiffMode] = useState(false);
  const [mobilePreview, setMobilePreview] = useState(initialVersionId !== undefined);
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const mobileToggle = useRef<HTMLButtonElement>(null);
  const shareButton = useRef<HTMLButtonElement>(null);
  const shareDialog = useRef<HTMLDivElement>(null);
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
  useEffect(() => { if (!copyStatus) return; const timer = window.setTimeout(() => setCopyStatus(""), 2000); return () => window.clearTimeout(timer); }, [copyStatus]);
  useEffect(() => {
    if (!listVisible) return;
    if (requested !== undefined) {
      const match = list.data.find((version) => version.id === requested);
      if (match) { setPreviewing({ id: match.id, seq: match.seq }); setRequested(undefined); }
      return;
    }
    if (!previewing || !list.data.some((version) => version.id === previewing.id && version.seq === previewing.seq)) {
      if (previewing && initialVersionId === previewing.id) { setPreviewing(null); setRequested(initialVersionId); return; }
      const first = list.data[0]; setPreviewing(first ? { id: first.id, seq: first.seq } : null);
    }
  }, [listVisible, list.data, previewing, requested, initialVersionId]);
  const selectedIndex = listVisible && previewing ? list.data.findIndex((v) => v.id === previewing.id && v.seq === previewing.seq) : -1;
  const preview = useQuery({
    queryKey: ["versions", userId, id, "preview", mode, previewing?.id, previewing?.seq, canViewHistory],
    queryFn: () => mode === "saved" ? docsApi.savedVersionPreview(id, previewing!.id, previewing!.seq, userId) : docsApi.versionPreview(id, previewing!.seq, userId),
    enabled: previewing !== null && selectedIndex >= 0,
    refetchOnMount: "always",
  });
  const previewReady = mode === "history" && canRestore && listVerified && selectedIndex >= 0 && preview.isSuccess && !preview.isFetching;
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
  const latestManage = useRef({ canEdit, listVerified, versions: list.data });
  latestManage.current = { canEdit, listVerified, versions: list.data };
  const canManage = (v: VersionEntry) => {
    const current = latestManage.current;
    return current.canEdit && current.listVerified && !!current.versions?.some((item) => item.id === v.id && item.revision === v.revision);
  };
  const manage = async (v: VersionEntry, action: "rename" | "delete", label?: string) => {
    if (managing || !canManage(v)) return;
    setManaging(true); setManageError("");
    try {
      await docsApi.manageVersionEntry(id, v.id, v.revision, action, userId, label);
      if (mounted.current) { setRenameTarget(null); setMenuVersion(null); if (action === "delete") onClose(); }
    } catch (error) {
      if (mounted.current) setManageError(error instanceof ApiError && error.status === 409 ? "版本已变化，请关闭并重新操作。" : "无法确认操作结果，请刷新版本列表后检查。 ");
    } finally {
      await qc.invalidateQueries({ queryKey: ["versions", userId, id] });
      if (mounted.current) setManaging(false);
    }
  };
  const deleteVersion = async (v: VersionEntry) => {
    if (!canManage(v) || confirming.current || managing) return;
    confirming.current = true; setMenuVersion(null);
    try { if (await ask("删除该版本？", "删除后，版本链接将失效，可在 30 天内通过版本回收站恢复。")) { if (mounted.current && canManage(v)) await manage(v, "delete"); } }
    finally { confirming.current = false; if (mounted.current) back.current?.focus(); }
  };
  const selectVersion = (v: { id: string; seq: number }) => {
    if (restore.isPending) return;
    restore.reset(); setRequested(undefined); setPreviewing({ id: v.id, seq: v.seq }); setMobilePreview(true); setShareLink(null); setCopyStatus(""); setMenuVersion(null);
    if (mode === "saved") { const hash = withVersionHash(location.hash, v.id); if (hash && hash !== location.hash) location.hash = hash; }
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
    if (event.key === "Escape" && versionPicker) { event.preventDefault(); setVersionPicker(false); root.current?.querySelector<HTMLButtonElement>("[data-version-picker-trigger]")?.focus(); return; }
    if (event.key === "Escape" && menuVersion) { event.preventDefault(); setMenuVersion(null); root.current?.querySelector<HTMLButtonElement>(`[data-version-menu="${menuVersion}"]`)?.focus(); return; }
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
  const title = mode === "saved" ? "已存版本" : "历史记录";
  const selected = selectedIndex >= 0 && listVisible ? list.data[selectedIndex] : null;
  const copyLink = () => {
    if (!selected) return;
    const target = selected.id;
    const link = savedVersionLink(location.href, id, selected.id); if (!link) return;
    if (!navigator.clipboard) { setCopyStatus(""); setShareLink(link); return; }
    void navigator.clipboard.writeText(link).then(() => { if (mounted.current && latest.current.previewing?.id === target) setCopyStatus("已复制"); }, () => { if (mounted.current && latest.current.previewing?.id === target) { setCopyStatus(""); setShareLink(link); } });
  };
  return <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown} onMouseDown={(event) => { if (menuVersion && !(event.target as HTMLElement).closest("[data-version-menu], [data-version-management-menu]")) setMenuVersion(null); if (versionPicker && !(event.target as HTMLElement).closest("[data-version-picker]")) setVersionPicker(false); }} data-version-panel data-version-mode={mode} data-document-print-restricted={disableFileDownloads ? "true" : undefined} className="fixed inset-0 z-40 flex min-h-0 flex-col bg-surface text-foreground">
    <header className="flex h-14 shrink-0 items-center border-b sm:h-16">
      <button ref={back} type="button" aria-label="返回文档" onClick={onClose} disabled={restore.isPending} className="ml-2 flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 text-[14px] hover:bg-hover disabled:opacity-40 sm:ml-4"><ArrowLeft size={16}/><span className="hidden sm:inline">返回文档</span></button>
      <span className="mx-2 h-5 w-px bg-border sm:mx-3" />
      {mode === "saved" && <div className="relative min-w-0" data-version-picker><button type="button" data-version-picker-trigger aria-expanded={versionPicker} aria-label="切换版本" disabled={!listVisible || !list.data.length} onClick={() => setVersionPicker((open) => !open)} className="flex max-w-[110px] items-center gap-1 rounded px-2 py-2 text-[13px] hover:bg-hover disabled:opacity-40 sm:max-w-[230px]"><span className="truncate">{selected?.label || "已存版本"}</span><ChevronDown size={14} className="shrink-0"/></button>
        {versionPicker && listVisible && <div role="menu" className="absolute left-0 top-full z-30 max-h-[min(360px,60dvh)] w-[240px] overflow-y-auto rounded-md border bg-surface py-1 shadow-lg">{list.data.map((version) => <button key={version.id} type="button" role="menuitem" onClick={() => { selectVersion(version); setVersionPicker(false); }} className={`block w-full truncate px-3 py-2 text-left text-[13px] hover:bg-hover ${selected?.id === version.id ? "text-[#1456F0]" : ""}`}>{version.label}</button>)}</div>}
      </div>}
      <span className="flex-1" />
      {mode === "saved" && <button ref={shareButton} type="button" aria-label={copyStatus || "复制版本链接"} title={copyStatus || "复制版本链接"} disabled={!listVerified || selectedIndex < 0 || !preview.isSuccess || preview.isFetching} onClick={copyLink} className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 text-[13px] text-[#1456F0] hover:bg-hover disabled:opacity-40" data-share-version>{copyStatus ? <Check size={15}/> : <Link size={15}/>}<span className="hidden sm:inline">{copyStatus || "复制版本链接"}</span></button>}
      {mode === "saved" && canEdit && selected && <div className="relative"><button type="button" aria-label="版本更多操作" aria-expanded={menuVersion === selected.id} disabled={!listVerified || managing} onClick={() => setMenuVersion((open) => open === selected.id ? null : selected.id)} className="grid size-9 place-items-center rounded text-muted-foreground hover:bg-hover disabled:opacity-40" data-version-menu={selected.id}><MoreHorizontal size={18}/></button>
        {menuVersion === selected.id && <div role="menu" data-version-management-menu className="absolute right-0 top-10 z-30 w-36 rounded-md border bg-surface py-1 text-[13px] shadow-lg"><button type="button" role="menuitem" className="block w-full px-3 py-2 text-left hover:bg-hover" onClick={() => { setManageError(""); setRenameTarget(selected); setRenameValue(selected.label); setMenuVersion(null); }} data-rename-version>重命名</button><button type="button" role="menuitem" className="block w-full px-3 py-2 text-left text-destructive hover:bg-hover" onClick={() => void deleteVersion(selected)} data-delete-version>删除</button></div>}
      </div>}
      {canEdit && mode === "history" && <button type="button" disabled={restore.isPending || !previewReady} onClick={() => void startRestore()} className="h-9 rounded px-2 text-[13px] text-[#1456F0] hover:bg-hover disabled:text-[#BBBFC4]" data-restore-version>{restore.isPending ? "还原中…" : "还原此历史记录"}</button>}
      <div className="hidden items-center gap-1 px-2 text-[13px] sm:flex">
        <button type="button" aria-label="上一个版本" disabled={!listVisible || selectedIndex <= 0 || restore.isPending} onClick={() => { if (listVisible && selectedIndex > 0) selectVersion(list.data[selectedIndex - 1]); }} className="rounded p-1 text-subtle hover:bg-hover disabled:opacity-30"><ChevronUp size={16}/></button>
        <span className="min-w-8 text-center">{selectedIndex >= 0 ? selectedIndex + 1 : 0}/{listVisible ? list.data.length : 0}</span>
        <button type="button" aria-label="下一个版本" disabled={!listVisible || selectedIndex < 0 || selectedIndex >= list.data.length - 1 || restore.isPending} onClick={() => { if (listVisible && selectedIndex >= 0 && selectedIndex + 1 < list.data.length) selectVersion(list.data[selectedIndex + 1]); }} className="rounded p-1 text-subtle hover:bg-hover disabled:opacity-30"><ChevronDown size={16}/></button>
      </div>
      <button ref={mobileToggle} type="button" onClick={() => setMobilePreview((v) => !v)} className="mr-2 shrink-0 whitespace-nowrap rounded px-2 py-2 text-[13px] text-[#1456F0] hover:bg-hover md:hidden">{mobilePreview ? "版本列表" : "预览"}</button>
      <div className="hidden h-full w-[294px] shrink-0 items-center gap-2 border-l px-4 text-[16px] font-medium md:flex"><span>{title}</span><HelpCircle size={14} className="text-subtle" aria-label="命名版本与历史快照"/>{canEdit && <button type="button" onClick={onCreateVersion} aria-label="创建当前版本" title="创建当前版本" className="ml-auto grid size-8 place-items-center rounded text-muted-foreground hover:bg-hover" data-create-version><Plus size={17}/></button>}</div>
    </header>
    {manageError && !renameTarget && <p role="alert" className="mx-4 mt-3 rounded border border-red-200 bg-red-50 p-3 text-[13px] text-destructive">{manageError}</p>}
    <div className="flex min-h-0 flex-1">
      <main className={`${mobilePreview ? "flex" : "hidden"} min-w-0 flex-1 flex-col overflow-y-auto md:flex`} data-version-preview data-document-print-restricted={disableFileDownloads ? "true" : undefined} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }}>
        {restore.isError && <RestoreErrorNotice error={restore.error} canEdit={canRestore} onRetry={() => void startRestore()} onDismiss={() => restore.reset()} />}
        <div className="mx-auto w-full max-w-[960px] px-7 pb-24 pt-12 sm:px-16 sm:pt-14">
          {!listVisible || selectedIndex < 0 ? <p className="text-[14px] text-subtle">{list.isError ? "版本列表不可用。" : list.isFetching ? "正在加载版本…" : requested !== undefined ? "版本不存在或你没有权限查看。" : "创建版本后可在这里查看。"}</p> : preview.isError ? <p role="alert" className="text-[14px] text-destructive">版本预览加载失败，请检查文档权限。</p> : !preview.data || preview.isFetching ? <p className="text-[14px] text-subtle">正在加载版本…</p> : <>
            <h1 className="mb-8 break-words text-[32px] font-medium leading-[1.3]" data-version-title>{savedTitle}</h1>
            {mode === "history" && diffMode && currentView && <section className="mb-6 rounded-md border p-4" aria-label="与当前内容对比"><div className="mb-2 text-[13px] text-muted-foreground">按块比较文本，不包含格式、图片与附件的变化。</div>{canDiffViews(preview.data.view, currentView) ? <VersionDiffView oldView={preview.data.view} newView={currentView} /> : <p className="text-[13px] text-subtle">文档过长，暂无法在浏览器中比较；下方仍可查看完整版本。</p>}</section>}
            <VersionView view={preview.data.view} disableFileDownloads={disableFileDownloads} versionSeq={previewing!.seq} />
          </>}
        </div>
      </main>
      <aside className={`${mobilePreview ? "hidden" : "flex"} min-h-0 w-full shrink-0 flex-col md:flex md:w-[294px] md:border-l`} aria-label={mode === "saved" ? "已存版本列表" : "历史版本列表"}>
        <div className="flex h-12 shrink-0 items-center border-b px-4 text-[15px] font-medium md:hidden"><span>{title}</span>{canEdit && <button type="button" onClick={onCreateVersion} className="ml-auto flex items-center gap-1 text-[13px] text-[#1456F0]" data-create-version><Plus size={16}/>创建版本</button>}</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.isLoading && <p className="px-4 py-8 text-center text-[13px] text-subtle">正在加载版本…</p>}
          {list.isError && <p role="alert" className="px-4 py-8 text-center text-[13px] text-destructive">无法加载版本，请确认文档权限并重试。 <button type="button" className="underline" onClick={() => void list.refetch()}>重试</button></p>}
          {listVisible && list.data.length === 0 && <p className="px-4 py-8 text-center text-[13px] text-subtle">还没有版本</p>}
          {(listVisible ? list.data : []).map((v, i, all) => <Fragment key={v.id}>
            {(i === 0 || group(v.createdAt) !== group(all[i-1].createdAt)) && <div className="border-b px-4 py-2 text-[12px] text-subtle">{group(v.createdAt)}</div>}
            <div className={`group relative border-l-[3px] ${previewing?.id === v.id ? "border-[#3370FF] bg-[#E1EAFF] dark:bg-primary/20" : "border-transparent hover:bg-hover"}`}>
            <button type="button" aria-pressed={previewing?.id === v.id} onClick={() => { setMenuVersion(null); selectVersion(v); }} data-version-item={v.id} className="block w-full py-3 pl-7 pr-12 text-left text-[13px]">
              <span className="block text-[#1456F0]">{formatEditTime(v.createdAt) || "时间未知"}</span>
              <span className="mt-1 block truncate text-foreground">{v.label || "历史版本"}</span>
              <span className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground"><span className="size-1.5 shrink-0 rounded-full bg-[#8D52E9]"/>{v.createdByName || "系统"}</span>
            </button>
            </div>
          </Fragment>)}
        </div>
        {mode === "saved" && canEdit && <button type="button" onClick={() => setTrashOpen(true)} className="flex h-12 shrink-0 items-center border-t px-4 text-left text-[13px] text-muted-foreground hover:bg-hover" data-version-trash>版本回收站</button>}
        {mode === "history" && <div className="flex h-12 shrink-0 items-center justify-between border-t px-4 text-[13px]"><span>对比当前</span><button type="button" role="switch" aria-label="对比当前" aria-checked={diffMode} disabled={!currentView || selectedIndex < 0} onClick={() => setDiffMode((v) => !v)} className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${diffMode ? "bg-[#1456F0]" : "bg-[#BBBFC4]"}`}><span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform ${diffMode ? "left-[18px]" : "left-0.5"}`}/></button></div>}
      </aside>
    </div>
    {trashOpen && canEdit && <VersionTrashDialog id={id} userId={userId} canEdit={canEdit} onClose={() => setTrashOpen(false)} />}
    {renameTarget && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4" onKeyDown={(event) => { if (event.key === "Escape" && !managing) { event.preventDefault(); event.stopPropagation(); setRenameTarget(null); } else if (event.key === "Tab") { event.stopPropagation(); const items = [...event.currentTarget.querySelectorAll<HTMLElement>("input:not([disabled]),button:not([disabled])")]; const i = items.indexOf(document.activeElement as HTMLElement); if (items.length && (i < 0 || event.shiftKey && i === 0 || !event.shiftKey && i === items.length - 1)) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); } } }}>
      <form role="dialog" aria-modal="true" aria-label="重命名版本" className="w-full max-w-[420px] rounded-lg bg-surface p-5 shadow-xl" onSubmit={(event) => { event.preventDefault(); const name = renameValue.trim(); if (name && name !== renameTarget.label) void manage(renameTarget, "rename", name); }}>
        <h2 className="text-[16px] font-medium">重命名版本</h2><label htmlFor="version-rename" className="mt-5 block text-[13px]">版本名称</label>
        <input autoFocus id="version-rename" maxLength={1000} value={renameValue} disabled={managing} onChange={(event) => setRenameValue(event.target.value)} className="mt-2 h-9 w-full rounded border px-3 text-[14px] outline-none focus:border-[#3370FF]" />
        {manageError && <p role="alert" className="mt-3 text-[13px] text-destructive">{manageError}</p>}
        <div className="mt-8 flex justify-end gap-3"><button type="button" disabled={managing} onClick={() => setRenameTarget(null)} className="h-8 rounded border px-4 text-[13px] hover:bg-hover">取消</button><button type="submit" disabled={managing || !renameValue.trim() || renameValue.trim() === renameTarget.label || !canManage(renameTarget)} className="h-8 rounded bg-[#3370FF] px-4 text-[13px] text-white disabled:opacity-40">{managing ? "保存中…" : "保存"}</button></div>
      </form>
    </div>}
    {shareLink && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShareLink(null); shareButton.current?.focus(); } }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setShareLink(null); shareButton.current?.focus(); }
      if (event.key === "Tab" && shareDialog.current) { event.stopPropagation(); const items = [...shareDialog.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")]; const index = items.indexOf(document.activeElement as HTMLElement); if (items.length && (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === items.length - 1)) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); } }
    }}>
      <div ref={shareDialog} role="dialog" aria-modal="true" aria-label="分享版本" className="w-full max-w-[440px] rounded-lg bg-white p-5 shadow-xl dark:bg-surface">
        <div className="flex items-center justify-between"><h2 className="text-[16px] font-medium">分享版本</h2><button type="button" aria-label="关闭" className="rounded p-1 hover:bg-hover" onClick={() => { setShareLink(null); shareButton.current?.focus(); }}><X size={18}/></button></div>
        <p className="mt-4 text-[13px] text-muted-foreground">链接不会授予文档访问权限，接收者需要有文档访问权限。</p>
        <input autoFocus aria-label="版本链接" readOnly value={shareLink} onFocus={(event) => event.currentTarget.select()} className="mt-4 h-9 w-full rounded border px-3 text-[13px] outline-none focus:border-[#3370FF]" />
        <div className="mt-4 flex items-center justify-end gap-3"><span role="status" className="text-[13px] text-muted-foreground">{copyStatus}</span><button type="button" onClick={() => { if (!navigator.clipboard) { setCopyStatus("请手动复制链接"); return; } void navigator.clipboard.writeText(shareLink).then(() => setCopyStatus("已复制"), () => setCopyStatus("请手动复制链接")); }} className="h-9 rounded bg-[#3370FF] px-4 text-[13px] text-white hover:bg-[#245bdb]">复制链接</button></div>
      </div>
    </div>}
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

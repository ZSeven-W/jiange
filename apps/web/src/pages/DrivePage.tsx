import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { driveApi, extrasApi, type DriveEntry } from "@/lib/api";
import { BaseIcon, hrefOf } from "@/components/Sidebar";
import { DocumentGlyph } from "@/components/DocumentGlyph";
import { ask, askText } from "@/components/ui/ask";
import { cn } from "@/lib/utils";
import { parseMarkdown } from "@/lib/markdown";
import { stageStarter } from "./pendingStarter";
import { StarterTemplates, type StarterTemplate } from "./StarterTemplates";
import { hasUnsupportedImportBlocks } from "./starterTemplateOps";
import { DirectoryPickerGate, type DriveUploadManager } from "./drive-upload";
import type { DriveDirectoryHandle } from "./drive-upload-plan";
import { formatDriveTime, ownRootFolders, sortDriveDocuments, sortDriveFolders, type FolderSortDirection, type FolderSortField } from "./drive-sort";
import { batchMessage, pruneSelection, runDriveBatch, toggleId } from "./drive-batch";
import { moveDriveColumn, readDriveColumns, writeDriveColumns, type DriveColumn, type DriveColumnPreferences } from "./drive-columns";
import { DriveDocGlyph, NewDocGlyph, UploadGlyph, TemplateGlyph } from "@/components/DriveActionIcons";
import { ArrowDownUp, Check, ChevronDown, ChevronRight, Ellipsis, Eye, EyeOff, FileInput, FileText, FileUp, Folder, FolderUp, GripVertical, LayoutGrid, Link2, List, ListFilter, Presentation, Search } from "lucide-react";

function driveColumnStorage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

/** Cloud drive: folder navigation and file operations use the guarded drive API. */
export function DrivePage({ folderId, personalRoot, userId, uploads }: { folderId: number | null; personalRoot: boolean; userId: number; uploads: DriveUploadManager }) {
  const uploadState = useSyncExternalStore(uploads.subscribe, uploads.snapshot, uploads.snapshot);
  const pickerGate = useRef(new DirectoryPickerGate());
  const pickerPending = useRef(false);
  const [useFallbackPicker, setUseFallbackPicker] = useState(false);
  useEffect(() => () => { pickerGate.current.invalidate(); pickerPending.current = false; }, [folderId, personalRoot, userId]);
  const fallbackPickerSupported = typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");
  const nativePicker = typeof window !== "undefined" && window.isSecureContext ? (window as Window & { showDirectoryPicker?: (options: { mode: "read" }) => Promise<DriveDirectoryHandle> }).showDirectoryPicker : undefined;
  const openNativeDirectory = () => {
    if (!nativePicker) return;
    pickerPending.current = true;
    pickerGate.current.choose(() => nativePicker.call(window, { mode: "read" }), (handle) => { pickerPending.current = false; void uploads.startDirectory(handle, folderId, scope); }, (error) => {
      pickerPending.current = false;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setUseFallbackPicker(fallbackPickerSupported);
      uploads.selectionError(fallbackPickerSupported ? "无法打开目录选择器，请重新选择“上传文件夹”；兼容模式不会上传空文件夹。" : "无法打开目录选择器，请检查浏览器权限后重试。");
    });
    setUploadMenu(false);
  };
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["drive", folderId, personalRoot], queryFn: () => driveApi.children(folderId, personalRoot), refetchInterval: 15000, refetchIntervalInBackground: false });
  const crumbs = useQuery({ queryKey: ["drive-ancestors", folderId], queryFn: () => driveApi.ancestors(folderId!), enabled: folderId !== null });
  const mine = useQuery({ queryKey: ["drive-root", "personal"], queryFn: () => driveApi.children(null, true), enabled: folderId !== null });
  const favorites = useQuery({ queryKey: ["favorites"], queryFn: extrasApi.favorites });
  const crumbsOrdered = useMemo(() => [...(crumbs.data ?? [])].reverse(), [crumbs.data]);
  const rootId = crumbsOrdered[0]?.id ?? folderId;
  const scope = folderId === null ? personalRoot : (mine.data ?? []).some((entry) => entry.id === rootId);
  const [folderSort, setFolderSort] = useState<FolderSortField>("created");
  const [folderDirection, setFolderDirection] = useState<FolderSortDirection>("desc");
  const [documentSort, setDocumentSort] = useState<FolderSortField>("updated");
  const [documentDirection, setDocumentDirection] = useState<FolderSortDirection>("desc");
  const [documentSortMenu, setDocumentSortMenu] = useState<FolderSortField | null>(null);
  const [sortMenu, setSortMenu] = useState(false);
  const sortTrigger = useRef<HTMLButtonElement>(null);
  const [showAllFolders, setShowAllFolders] = useState(true);
  const [folderDisplayMenu, setFolderDisplayMenu] = useState(false);
  const displayTrigger = useRef<HTMLButtonElement>(null);
  const sharedRoots = useQuery({ queryKey: ["drive", "owned-shared-roots", userId], queryFn: () => driveApi.children(null, false), enabled: folderId === null && personalRoot && showAllFolders, refetchInterval: 15000, refetchIntervalInBackground: false });
  const [grid, setGrid] = useState(false);
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const [displaySettings, setDisplaySettings] = useState(false);
  const [columnPreferences, setColumnPreferences] = useState(() => readDriveColumns(driveColumnStorage(), userId));
  const [columnStorageError, setColumnStorageError] = useState(false);
  useEffect(() => { setColumnStorageError(!writeDriveColumns(driveColumnStorage(), userId, columnPreferences)); }, [userId, columnPreferences]);
  const [moving, setMoving] = useState<{ entries: DriveEntry[]; batch: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [batchPending, setBatchPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [uploadMenu, setUploadMenu] = useState(false);
  const uploadTrigger = useRef<HTMLButtonElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [templatePending, setTemplatePending] = useState(false);
  const templateLock = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importing, setImporting] = useState(false);
  const importLock = useRef(false);
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["drive"] }); void qc.invalidateQueries({ queryKey: ["drive-nav"] }); void qc.invalidateQueries({ queryKey: ["drive-ancestors"] }); };
  const failure = () => { setError("操作结果未能确认，请刷新后检查。"); invalidate(); };
  const rename = useMutation({ mutationFn: ({ id, title, expected }: { id: number; title: string; expected: number }) => driveApi.rename(id, title, expected), onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ["docs"] }); }, onError: failure });
  const createFolder = useMutation({ mutationFn: (title: string) => driveApi.create(title, folderId, scope), onSuccess: invalidate, onError: failure });
  const createNode = useMutation({ mutationFn: ({ kind, title }: { kind: "doc" | "base" | "slides"; title: string }) => driveApi.createNode(kind, title, folderId, scope), onSuccess: (entry) => { invalidate(); void qc.invalidateQueries({ queryKey: ["docs"] }); location.hash = hrefOf({ id: entry.id, kind: entry.kind as "doc" | "base" | "slides" | "file" }); }, onError: failure });
  const trash = useMutation({ mutationFn: (entry: DriveEntry) => driveApi.trash(entry.id, entry.revision), onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ["docs"] }); void qc.invalidateQueries({ queryKey: ["trash"] }); }, onError: failure });
  const entries = useMemo(() => [...(list.data ?? [])].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")), [list.data]);
  const visible = useMemo(() => { const q = filter.trim().toLocaleLowerCase(); return q ? entries.filter((entry) => (entry.title || "未命名").toLocaleLowerCase().includes(q)) : entries; }, [entries, filter]);
  const folders = useMemo(() => {
    const includeShared = folderId === null && personalRoot && showAllFolders;
    return sortDriveFolders(ownRootFolders(visible, sharedRoots.isError ? [] : sharedRoots.data ?? [], userId, includeShared, filter.trim().toLocaleLowerCase()), folderSort, folderDirection);
  }, [visible, filter, folderId, personalRoot, showAllFolders, sharedRoots.data, sharedRoots.isError, userId, folderSort, folderDirection]);
  const files = useMemo(() => sortDriveDocuments(visible.filter((entry) => entry.kind !== "folder"), documentSort, documentDirection), [visible, documentSort, documentDirection]);
  useEffect(() => { setSelected((prev) => pruneSelection(prev, files.map((entry) => entry.id))); }, [files]);
  const chosen = files.filter((entry) => selected.has(entry.id));
  const finishBatch = (verb: string, result: { done: number[]; failed: number[] }) => {
    const { notice: n, error: e } = batchMessage(verb, result);
    setNotice(n); setError(e);
    setSelected(new Set(result.failed));
    invalidate(); void qc.invalidateQueries({ queryKey: ["docs"] });
  };
  const batchTrash = async () => {
    if (!chosen.length || batchPending) return;
    if (!(await ask(`删除选中的 ${chosen.length} 项？`, "会移到回收站，可恢复。"))) return;
    setBatchPending(true); setNotice(""); setError("");
    try { finishBatch("删除", await runDriveBatch(chosen, (entry) => driveApi.trash(entry.id, entry.revision))); void qc.invalidateQueries({ queryKey: ["trash"] }); }
    finally { setBatchPending(false); }
  };
  const batchStar = async () => {
    if (!chosen.length || batchPending) return;
    const starredIds = new Set((favorites.data ?? []).map((item) => item.id));
    setBatchPending(true); setNotice(""); setError("");
    try { finishBatch("收藏", await runDriveBatch(chosen, (entry) => starredIds.has(entry.id) ? Promise.resolve() : extrasApi.star(entry.id))); void favorites.refetch(); }
    finally { setBatchPending(false); }
  };
  const newItem = async (kind: "doc" | "base" | "slides" | "folder") => {
    setCreating(false); setError("");
    const label = kind === "doc" ? "文档" : kind === "base" ? "多维表格" : kind === "slides" ? "幻灯片" : "文件夹";
    const title = await askText(`新建${label}`, `${label}名称`);
    if (!title?.trim()) return;
    if (kind === "folder") createFolder.mutate(title.trim()); else createNode.mutate({ kind, title: title.trim() });
  };
  const importMarkdown = async (file: File) => {
    if (importLock.current) return;
    importLock.current = true; setImporting(true); setError("");
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("Markdown 文件不能超过 5 MB。");
      const markdown = await file.text();
      if (!parseMarkdown(markdown).length) throw new Error("文件没有可导入的内容。");
      if (hasUnsupportedImportBlocks(markdown)) throw new Error("暂不支持导入图片，请先移除图片内容。");
      const title = file.name.replace(/\.(md|markdown)$/i, "") || "导入文档";
      const doc = await driveApi.createNode("doc", title, folderId, scope);
      stageStarter(userId, doc.id, markdown);
      invalidate(); void qc.invalidateQueries({ queryKey: ["docs"] });
      location.hash = hrefOf({ id: doc.id, kind: "doc" });
    } catch (err) { setError(err instanceof Error ? err.message : "导入未完成，请检查目录后重试。"); }
    finally { importLock.current = false; setImporting(false); }
  };
  const chooseTemplate = async (template: StarterTemplate) => {
    if (templateLock.current) return;
    templateLock.current = true; setTemplatePending(true); setError("");
    try {
      const doc = await driveApi.createNode("doc", template.name, folderId, scope);
      stageStarter(userId, doc.id, template.body);
      invalidate(); void qc.invalidateQueries({ queryKey: ["docs"] });
      setLibraryOpen(false); location.hash = hrefOf({ id: doc.id, kind: "doc" });
    } catch { setError("创建模板文档未完成，请检查目录后重试。"); }
    finally { templateLock.current = false; setTemplatePending(false); }
  };
  const actions = (entry: DriveEntry) => ({
    onOpen: () => { location.hash = entry.kind === "folder" ? `#/drive/${entry.id}` : hrefOf({ id: entry.id, kind: entry.kind as "doc" | "base" | "slides" | "file" }); },
    onRename: async () => { const title = await askText("重命名", "名称", entry.title); if (title?.trim() && title.trim() !== entry.title) rename.mutate({ id: entry.id, title: title.trim(), expected: entry.revision }); },
    onMove: () => setMoving({ entries: [entry], batch: false }),
    onCopyLink: async () => { const route = entry.kind === "folder" ? `#/drive/${entry.id}` : hrefOf({ id: entry.id, kind: entry.kind as "doc" | "base" | "slides" | "file" }); try { await navigator.clipboard.writeText(`${location.origin}${location.pathname}${route}`); setNotice("链接已复制，访问者仍需具备权限。"); } catch { setError("复制失败，请检查浏览器剪贴板权限。"); } },
    onTrash: () => { void ask(`删除「${entry.title}」？`, entry.kind === "folder" ? "整个文件夹会移到回收站，可恢复。" : "会移到回收站，可恢复。").then((ok) => { if (ok) trash.mutate(entry); }); },
    onStar: (next: boolean) => { void (next ? extrasApi.star(entry.id) : extrasApi.unstar(entry.id)).then(() => favorites.refetch()).catch(failure); },
  });
  return <main className="flex min-w-0 flex-1 flex-col bg-white" data-drive-page>
    <header className="flex h-16 shrink-0 items-center pl-14 pr-5 md:px-7 xl:px-6"><h1 className="text-[20px] font-semibold text-[#1f2329]">云盘</h1><button type="button" aria-label="全局搜索" onClick={() => document.querySelector<HTMLElement>("[data-search]")?.click()} className="ml-auto grid size-8 place-items-center rounded-md text-[#646a73] hover:bg-[#f2f3f5]"><Search size={18}/></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-7 xl:px-6">
      <div className="grid grid-cols-2 gap-2 pt-2 md:grid-cols-4 md:gap-3 xl:grid-cols-[repeat(4,305px)]">
        <div className="relative min-w-0">
          <button type="button" onClick={() => setCreating((value) => !value)} aria-expanded={creating} className={cn("flex h-16 w-full items-center gap-2 rounded-lg border border-[#dee0e3] px-4 text-left hover:bg-[#f2f3f5]", creating && "bg-[#f2f3f5]")}><NewDocGlyph/><span className="min-w-0 flex-1"><span className="block text-[14px] font-medium text-[#1f2329]">新建</span><span className="hidden truncate text-[12px] text-[#8f959e] xl:block">新建文档开始协作</span></span><ChevronDown size={15} className={cn("shrink-0 text-[#646a73]", creating && "rotate-180")}/></button>
          {creating && <><div className="fixed inset-0 z-30" onClick={() => setCreating(false)}/><div role="menu" aria-label="新建" className="absolute left-0 top-[68px] z-40 w-full min-w-48 rounded-lg border border-[#dee0e3] bg-white py-1 shadow-[0_6px_24px_rgba(31,35,41,0.16)]" data-drive-new-menu>{(["doc", "slides", "base", "folder"] as const).map((kind) => <button key={kind} type="button" role="menuitem" onClick={() => void newItem(kind)} className={cn("flex h-10 w-full", kind === "folder" && "mt-1 border-t border-[#dee0e3] pt-1 h-11")} data-new-kind={kind}><span className="mx-1 flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-[14px] text-[#1f2329] hover:bg-[#f2f3f5]">{kind === "doc" ? <DriveDocGlyph/> : kind === "base" ? <BaseIcon/> : kind === "slides" ? <span className="grid size-5 place-items-center rounded bg-[#ff8800] text-white"><Presentation size={13}/></span> : <Folder size={18} fill="#ffcc4d" stroke="#f5a623"/>}{kind === "doc" ? "文档" : kind === "base" ? "多维表格" : kind === "slides" ? "幻灯片" : "文件夹"}</span></button>)}</div></>}
        </div>
        <div className="relative min-w-0">
          <button ref={uploadTrigger} type="button" aria-expanded={uploadMenu} disabled={importing || uploadState.phase === "uploading" || uploadState.phase === "scanning"} onKeyDown={(event) => { if (event.key === "Escape" && uploadMenu) { event.stopPropagation(); setUploadMenu(false); } }} onClick={() => { if (pickerPending.current && fallbackPickerSupported) { setUseFallbackPicker(true); uploads.selectionError("目录选择器未返回，请重新选择“上传文件夹”；兼容模式不会上传空文件夹。"); } pickerPending.current = false; pickerGate.current.invalidate(); setUploadMenu((open) => !open); }} className={cn("flex h-16 w-full items-center gap-2 rounded-lg border border-[#dee0e3] px-4 text-left hover:bg-[#f2f3f5] disabled:opacity-50", uploadMenu && "bg-[#f2f3f5]")}><UploadGlyph/><span className="min-w-0 flex-1"><span className="block text-[14px] font-medium text-[#1f2329]">{importing || uploadState.phase === "uploading" || uploadState.phase === "scanning" ? "上传中" : "上传"}</span><span className="hidden truncate text-[12px] text-[#8f959e] xl:block">上传本地文件</span></span><ChevronDown size={15} className={cn("shrink-0 text-[#646a73]", uploadMenu && "rotate-180")}/></button>
          {uploadMenu && <><div className="fixed inset-0 z-30" onClick={() => setUploadMenu(false)}/><div role="menu" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setUploadMenu(false); uploadTrigger.current?.focus(); } }} className="absolute right-0 top-[70px] z-40 w-48 rounded-lg border border-[#dee0e3] bg-white py-1.5 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.16)] sm:left-0 sm:right-auto">
            <label role="menuitem" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.querySelector("input")?.click(); } }} className="flex h-10 cursor-pointer items-center gap-3 px-4 hover:bg-[#f2f3f5] focus:bg-[#f2f3f5]"><span className="grid size-5 place-items-center rounded bg-[#f79557] text-white"><FileUp size={14}/></span>上传文件<input type="file" aria-label="上传云盘文件" tabIndex={-1} multiple className="sr-only" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; setUploadMenu(false); if (files.length) void uploads.start(files, "files", folderId, scope); }}/></label>
            {nativePicker && !useFallbackPicker ? <button type="button" role="menuitem" onClick={openNativeDirectory} className="flex h-10 w-full items-center gap-3 px-4 text-left hover:bg-[#f2f3f5] focus:bg-[#f2f3f5]"><span className="grid size-5 place-items-center rounded bg-[#ffca53] text-white"><FolderUp size={14}/></span>上传文件夹</button> : fallbackPickerSupported ? <label role="menuitem" tabIndex={0} title="浏览器选择器不包含空文件夹" onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.querySelector("input")?.click(); } }} className="flex h-10 cursor-pointer items-center gap-3 px-4 hover:bg-[#f2f3f5] focus:bg-[#f2f3f5]"><span className="grid size-5 place-items-center rounded bg-[#ffca53] text-white"><FolderUp size={14}/></span>上传文件夹<input ref={(input) => input?.setAttribute("webkitdirectory", "")} type="file" aria-label="选择上传文件夹" tabIndex={-1} multiple className="sr-only" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; setUploadMenu(false); setUseFallbackPicker(false); if (files.length) void uploads.start(files, "folder", folderId, scope); }}/></label> : <button type="button" role="menuitem" disabled title="当前浏览器不支持选择文件夹" className="flex h-10 w-full items-center gap-3 px-4 text-left text-[#bbbfc4]"><span className="grid size-5 place-items-center rounded bg-[#ffca53] text-white opacity-60"><FolderUp size={14}/></span>上传文件夹</button>}
            <label role="menuitem" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.querySelector("input")?.click(); } }} className="flex h-10 cursor-pointer items-center gap-3 px-4 hover:bg-[#f2f3f5] focus:bg-[#f2f3f5]"><span className="grid size-5 place-items-center rounded bg-[#6665ed] text-white"><FileInput size={14}/></span>导入为在线文档<input type="file" aria-label="导入 Markdown 文件" tabIndex={-1} accept=".md,.markdown,text/markdown" className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; setUploadMenu(false); if (file) void importMarkdown(file); }}/></label>
          </div></>}
        </div>
        <button type="button" disabled title="暂不支持添加快捷方式" className="flex h-16 min-w-0 items-center gap-2 rounded-lg border border-[#dee0e3] px-4 text-left opacity-50"><span className="grid size-6 shrink-0 place-items-center text-[#7652ed]"><Link2 size={21}/></span><span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">添加</span><span className="hidden truncate text-[12px] text-[#8f959e] xl:block">添加云文档的快捷方式</span></span><ChevronDown size={15} className="shrink-0 text-[#646a73]"/></button>
        <button type="button" onClick={() => setLibraryOpen(true)} className="flex h-16 min-w-0 items-center gap-2 rounded-lg border border-[#dee0e3] px-4 text-left hover:bg-[#f2f3f5]"><TemplateGlyph/><span className="min-w-0"><span className="block text-[14px] font-medium">模板库</span><span className="hidden truncate text-[12px] text-[#8f959e] xl:block">选择模板快速新建</span></span></button>
      </div>
      {folderId !== null && <nav aria-label="文件夹路径" className="mt-5 flex flex-wrap items-center gap-1 text-[13px] text-[#646a73]"><a href={scope ? "#/drive/mine" : "#/drive"} className="hover:text-[#3370ff]">{scope ? "我的文件夹" : "共享文件夹"}</a>{crumbsOrdered.map((item) => <span key={item.id} className="flex items-center gap-1"><ChevronRight size={13}/><a href={item.kind === "folder" ? `#/drive/${item.id}` : hrefOf(item)} className="hover:text-[#3370ff]">{item.title || "未命名"}</a></span>)}</nav>}
      <div className="mt-8 flex items-center gap-5 text-[14px]"><a href="#/drive/mine" className={cn("pb-1", scope ? "font-medium text-[#3370ff]" : "text-[#646a73]")}>我的文件夹</a><a href="#/drive" className={cn("pb-1", !scope ? "font-medium text-[#3370ff]" : "text-[#646a73]")}>共享文件夹</a><div className="ml-auto flex items-center gap-2">
        <div className="relative"><button ref={sortTrigger} type="button" aria-expanded={sortMenu} aria-haspopup="menu" onClick={() => { setFolderDisplayMenu(false); setSortMenu((open) => !open); }} onKeyDown={(event) => { if (event.key === "Escape") setSortMenu(false); }} className={cn("flex h-8 items-center gap-1 rounded px-2 text-[12px] text-[#646a73] hover:bg-[#f2f3f5]", sortMenu && "bg-[#edf2ff] text-[#3370ff]")}><ArrowDownUp size={14}/>排序<ChevronDown size={12}/></button>
          {sortMenu && <><button type="button" aria-label="关闭排序菜单" className="fixed inset-0 z-20 cursor-default" onClick={() => setSortMenu(false)}/><div role="menu" aria-label="文件夹排序" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setSortMenu(false); sortTrigger.current?.focus(); } }} className="absolute right-0 top-9 z-30 w-[120px] rounded-md border border-[#dee0e3] bg-white py-1 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.16)]">
            <div className="px-3 py-1.5 text-[12px] text-[#8f959e]">排序依据</div>{([ ["created", "创建时间"], ["updated", "修改时间"], ["name", "名称"] ] as const).map(([value, label]) => <button key={value} type="button" role="menuitemradio" aria-checked={folderSort === value} onClick={() => { setFolderSort(value); setSortMenu(false); }} className={cn("flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]", folderSort === value && "text-[#3370ff]")}>{label}</button>)}
            <div className="mt-1 border-t border-[#dee0e3] px-3 pb-1.5 pt-2 text-[12px] text-[#8f959e]">排序</div>{([ ["asc", folderSort === "name" ? "升序" : "由远到近"], ["desc", folderSort === "name" ? "降序" : "由近到远"] ] as const).map(([value, label]) => <button key={value} type="button" role="menuitemradio" aria-checked={folderDirection === value} onClick={() => { setFolderDirection(value); setSortMenu(false); }} className={cn("flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]", folderDirection === value && "text-[#3370ff]")}>{label}</button>)}
          </div></>}
        </div>
        <div className="relative"><button ref={displayTrigger} type="button" disabled={folderId !== null || !personalRoot} title={folderId !== null || !personalRoot ? "此处暂不支持文件夹展示规则" : undefined} aria-haspopup="menu" aria-expanded={folderDisplayMenu} onClick={() => { setSortMenu(false); setFolderDisplayMenu((open) => !open); }} onKeyDown={(event) => { if (event.key === "Escape") setFolderDisplayMenu(false); }} className={cn("flex h-8 items-center gap-1 rounded px-2 text-[12px] text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-50", folderDisplayMenu && "bg-[#edf2ff] text-[#3370ff]")}>展示<ChevronDown size={12}/></button>
          {folderDisplayMenu && <><button type="button" aria-label="关闭展示菜单" className="fixed inset-0 z-20 cursor-default" onClick={() => setFolderDisplayMenu(false)}/><div role="menu" aria-label="我的文件夹展示规则" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setFolderDisplayMenu(false); displayTrigger.current?.focus(); } }} className="absolute right-0 top-9 z-30 w-60 rounded-md border border-[#dee0e3] bg-white py-1 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.16)]"><div className="px-3 py-2 text-[12px] text-[#8f959e]">我的文件夹展示规则</div>{([ [true, "全部文件夹", "展示属于我的全部文件夹"], [false, "个人文件夹", "不展示共享文件夹"] ] as const).map(([value, label, description]) => <button key={label} type="button" role="menuitemradio" aria-checked={showAllFolders === value} onClick={() => { setShowAllFolders(value); setFolderDisplayMenu(false); }} className="flex w-full items-center px-3 py-2 text-left hover:bg-[#f2f3f5]"><span className="min-w-0 flex-1"><span className={cn("block", showAllFolders === value && "text-[#3370ff]")}>{label}</span><span className="mt-1 block text-[12px] text-[#8f959e]">{description}</span></span>{showAllFolders === value && <Check size={14} className="text-[#3370ff]"/>}</button>)}</div></>}
        </div>
      </div></div>
      {list.isError ? <p role="alert" className="py-10 text-center text-[13px] text-[#8f959e]">无法访问该目录，请确认权限后重试。</p> : <>
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">{folders.map((entry) => <FolderCard key={entry.id} entry={entry} starred={favorites.data?.some((item) => item.id === entry.id) ?? false} {...actions(entry)}/>)}{folders.length === 0 && !sharedRoots.isFetching && <p className="py-3 text-[13px] text-[#8f959e]">{filter ? "没有匹配的文件夹" : "暂无文件夹"}</p>}</div>
        {folderId === null && personalRoot && showAllFolders && sharedRoots.isError && <p role="alert" className="mt-2 text-[12px] text-destructive">无法加载属于我的共享文件夹，请重试。</p>}
        <div className="mt-8 flex h-9 items-center"><h2 className="text-[15px] font-semibold text-[#1f2329]">文档</h2><div className="ml-auto flex items-center gap-1">{!grid && <div className="relative"><button type="button" aria-label="显示设置" aria-expanded={displaySettings} onKeyDown={(event) => { if (event.key === "Escape") setDisplaySettings(false); }} onClick={() => setDisplaySettings((open) => !open)} className={cn("flex h-8 items-center gap-1 rounded px-2 text-[12px] text-[#646a73] hover:bg-[#f2f3f5]", displaySettings && "bg-[#f2f3f5]")}><ListFilter size={14}/><span className="hidden sm:inline">显示设置</span></button>{displaySettings && <><button type="button" aria-label="关闭显示设置" onClick={() => setDisplaySettings(false)} className="fixed inset-0 z-20 cursor-default"/><div role="group" aria-label="显示设置" onKeyDown={(event) => { if (event.key === "Escape") setDisplaySettings(false); }} className="absolute right-0 top-9 z-30 w-60 rounded-md border border-[#dee0e3] bg-white py-2 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.16)]"><div className="px-3 pb-2 font-medium text-[#1f2329]">显示设置</div><DriveColumnOptions preferences={columnPreferences} onChange={setColumnPreferences}/></div></>}</div>}<button type="button" onClick={() => setShowFilter((value) => !value)} aria-label="搜索当前目录" className="grid size-8 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Search size={15}/></button><button type="button" onClick={() => setGrid(false)} aria-label="列表视图" className={cn("grid size-8 place-items-center rounded", !grid ? "bg-[#edf2ff] text-[#3370ff]" : "text-[#8f959e]")}><List size={16}/></button><button type="button" onClick={() => setGrid(true)} aria-label="网格视图" className={cn("grid size-8 place-items-center rounded", grid ? "bg-[#edf2ff] text-[#3370ff]" : "text-[#8f959e]")}><LayoutGrid size={16}/></button></div></div>
        {showFilter && <input autoFocus value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索当前目录" className="my-2 h-8 w-56 rounded-md border px-2 text-[13px] outline-none focus:border-[#3370ff]"/>}
        {grid ? <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">{files.map((entry) => <FileCard key={entry.id} entry={entry} starred={favorites.data?.some((item) => item.id === entry.id) ?? false} {...actions(entry)}/>)}</div> : <div className="group/list mt-2">{chosen.length > 0 ? <div className="flex h-10 items-center gap-1 border-b border-[#dee0e3] px-2 text-[13px] text-[#1f2329]" role="toolbar" aria-label="批量操作" data-drive-batch><SelectBox checked={chosen.length === files.length ? true : "mixed"} label={chosen.length === files.length ? "取消全选" : "全选"} onToggle={() => setSelected(chosen.length === files.length ? new Set() : new Set(files.map((entry) => entry.id)))}/><span className="ml-2 mr-3">已选择 {chosen.length} 项</span><button type="button" disabled={batchPending} onClick={() => void batchStar()} className="h-7 rounded px-2 hover:bg-[#f2f3f5] disabled:opacity-40">收藏</button><button type="button" disabled={batchPending || new Set(chosen.map((entry) => !!entry.personal)).size > 1} onClick={() => setMoving({ entries: chosen, batch: true })} className="h-7 rounded px-2 hover:bg-[#f2f3f5] disabled:opacity-40">移动到…</button><button type="button" disabled={batchPending} onClick={() => void batchTrash()} className="h-7 rounded px-2 text-[#d83931] hover:bg-[#fff2f0] disabled:opacity-40">删除</button><button type="button" onClick={() => setSelected(new Set())} className="ml-auto h-7 rounded px-2 text-[#646a73] hover:bg-[#f2f3f5]">取消选择</button></div> : <div className="flex h-10 items-center border-b border-[#dee0e3] px-2 text-[12px] text-[#646a73]">{files.length > 0 && <SelectBox checked={false} label="全选" onToggle={() => setSelected(new Set(files.map((entry) => entry.id)))} hoverOnly/>}<div className="min-w-0 flex-1"><DocumentSortHeader label="标题" field="name" selected={documentSort} direction={documentDirection} open={documentSortMenu} setOpen={setDocumentSortMenu} onSelect={(direction) => { setDocumentSort("name"); setDocumentDirection(direction); }}/></div>{columnPreferences.order.map((column) => columnPreferences.visible[column] && <div key={column} className={cn("hidden w-32", column === "owner" || column === "modifier" ? "xl:block" : column === "updated" ? "sm:block" : "md:block")}>{column === "owner" || column === "modifier" ? <span className="px-1 text-[13px]">{driveColumnNames[column]}</span> : <DocumentSortHeader label={driveColumnNames[column]} field={column} selected={documentSort} direction={documentDirection} open={documentSortMenu} setOpen={setDocumentSortMenu} onSelect={(direction) => { setDocumentSort(column); setDocumentDirection(direction); }}/>}</div>)}<span className="w-9"/></div>}{files.map((entry) => <DriveRow key={entry.id} columns={columnPreferences} selected={selected.has(entry.id)} selecting={chosen.length > 0} onSelect={() => setSelected((prev) => toggleId(prev, entry.id))} entry={entry} starred={favorites.data?.some((item) => item.id === entry.id) ?? false} {...actions(entry)}/>)}</div>}
        {files.length === 0 && list.isSuccess && <p className="py-8 text-center text-[13px] text-[#8f959e]">{filter ? "没有匹配的文档" : "暂无文档"}</p>}
      </>}
      {columnStorageError && <p role="status" className="mt-4 text-[12px] text-[#8f959e]">浏览器无法保存显示设置，刷新后将恢复默认。</p>}
      {notice && <p role="status" className="mt-4 text-[12px] text-[#3370ff]">{notice}</p>}
      {error && <p role="alert" className="mt-4 text-[12px] text-destructive">{error}</p>}
    </div>
    {moving && <MoveDialog entries={moving.entries} onDone={(result) => { const batch = moving.batch; setMoving(null); if (result && batch) finishBatch("移动", result); }}/>}
    {libraryOpen && <div className="fixed inset-0 z-[60] grid place-items-center bg-black/25 p-4" onMouseDown={() => { if (!templatePending) setLibraryOpen(false); }}><div role="dialog" aria-modal="true" aria-label="模板库" className="max-h-[calc(100dvh-2rem)] w-full max-w-[880px] overflow-y-auto rounded-lg border bg-white p-5 shadow-xl" onMouseDown={(event) => event.stopPropagation()}><h2 className="mb-5 text-[16px] font-semibold">模板库</h2><StarterTemplates compact disabled={templatePending} onChoose={(template) => void chooseTemplate(template)} onHide={() => setLibraryOpen(false)}/>{error && <p role="alert" className="mt-3 text-[13px] text-destructive">{error}</p>}</div></div>}
  </main>;
}

function DriveIcon({ entry }: { entry: DriveEntry }) { return entry.kind === "folder" ? <Folder size={18} fill="#ffcc4d" stroke="#f5a623"/> : entry.kind === "base" ? <BaseIcon/> : entry.kind === "slides" ? <span className="grid size-5 place-items-center rounded bg-[#ff8800] text-white"><Presentation size={13}/></span> : entry.kind === "file" ? <span className="grid size-5 place-items-center rounded bg-[#e8efff] text-[#3370ff]"><FileText size={15}/></span> : <DocumentGlyph icon={entry.icon} fallback={<DriveDocGlyph/>}/>; }

type EntryActions = { entry: DriveEntry; starred: boolean; onStar: (next: boolean) => void; onOpen: () => void; onMove: () => void; onCopyLink: () => void; onRename: () => void; onTrash: () => void };

function FolderCard(props: EntryActions) {
  return <div className="relative flex h-16 min-w-0 items-center gap-2 rounded-md border border-[#e5e6eb] px-3 hover:bg-[#f7f8fa]"><button type="button" onClick={props.onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left"><Folder size={24} fill="#ffcc4d" stroke="#f5a623"/><span className="truncate text-[13px] text-[#1f2329]">{props.entry.title || "未命名文件夹"}</span></button><EntryMenu {...props}/></div>;
}

function FileCard(props: EntryActions) {
  return <div className="relative flex min-h-24 flex-col rounded-lg border p-3 hover:bg-[#f7f8fa]"><div className="flex items-start"><button type="button" onClick={props.onOpen} className="flex min-w-0 flex-1 flex-col items-start gap-2 text-left"><DriveIcon entry={props.entry}/><span className="w-full truncate text-[13px]">{props.entry.title || "未命名"}</span></button><EntryMenu {...props}/></div></div>;
}

const driveColumnNames: Record<DriveColumn, string> = { owner: "所有者", modifier: "修改者", updated: "修改时间", created: "创建时间" };

function DriveColumnOptions({ preferences, onChange }: { preferences: DriveColumnPreferences; onChange: (value: DriveColumnPreferences | ((previous: DriveColumnPreferences) => DriveColumnPreferences)) => void }) {
  const dragging = useRef<DriveColumn | null>(null);
  const move = (from: DriveColumn, to: DriveColumn) => onChange((previous) => moveDriveColumn(previous, from, to));
  return <>{preferences.order.map((column, index) => <div key={column}><div onDragOver={(event) => { if (dragging.current && dragging.current !== column) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => { if (dragging.current) { event.preventDefault(); move(dragging.current, column); dragging.current = null; } }} className="flex h-9 items-center gap-1 px-2 text-[#646a73] hover:bg-[#f2f3f5]">
    <button type="button" draggable aria-label={`调整${driveColumnNames[column]}列顺序`} title="拖动、点击或使用上下方向键调整顺序" onClick={() => move(column, preferences.order[index > 0 ? index - 1 : 1])} onKeyDown={(event) => { const target = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : -1; if (target >= 0 && target < preferences.order.length) { event.preventDefault(); move(column, preferences.order[target]); } }} onDragStart={(event) => { dragging.current = column; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", column); }} onDragEnd={() => { dragging.current = null; }} className="grid size-6 shrink-0 cursor-grab place-items-center rounded text-[#bbbfc4] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#3370ff] active:cursor-grabbing"><GripVertical size={14}/></button>
    <button type="button" role="checkbox" aria-checked={preferences.visible[column]} onClick={() => onChange((previous) => ({ ...previous, visible: { ...previous.visible, [column]: !previous.visible[column] } }))} className="flex h-full min-w-0 flex-1 items-center text-left"><span className="flex-1">{driveColumnNames[column]}</span>{preferences.visible[column] ? <Eye size={14}/> : <EyeOff size={14}/>}</button>
  </div></div>)}</>;
}

function DocumentSortHeader({ label, field, selected, direction, open, setOpen, onSelect }: { label: string; field: FolderSortField; selected: FolderSortField; direction: FolderSortDirection; open: FolderSortField | null; setOpen: (field: FolderSortField | null) => void; onSelect: (direction: FolderSortDirection) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const expanded = open === field;
  const choices: [FolderSortDirection, string][] = field === "name" ? [["asc", "升序 A→Z"], ["desc", "降序 Z→A"]] : [["asc", "由远到近"], ["desc", "由近到远"]];
  return <div className="relative inline-block"><button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : field)} onKeyDown={(event) => { if (event.key === "Escape") setOpen(null); }} className={cn("flex h-7 items-center gap-0.5 rounded px-1 text-[13px] hover:bg-[#f2f3f5]", expanded && "bg-[#edf2ff] text-[#3370ff]")}>{label}<ChevronDown size={13} className={cn(expanded && "rotate-180")}/></button>
    {expanded && <><button type="button" aria-label={`关闭${label}排序`} className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(null)}/><div role="menu" aria-label={`${label}排序`} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(null); trigger.current?.focus(); } }} className="absolute left-0 top-8 z-30 w-40 rounded-md border border-[#dee0e3] bg-white py-1 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.16)]">{choices.map(([value, text]) => <button key={value} type="button" role="menuitemradio" aria-checked={selected === field && direction === value} onClick={() => { onSelect(value); setOpen(null); }} className={cn("flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]", selected === field && direction === value && "text-[#3370ff]")}>{text}</button>)}</div></>}
  </div>;
}

/** 飞书云盘列表的勾选框：悬停或已有选中时显示。 */
function SelectBox({ checked, label, onToggle, hoverOnly = false }: { checked: boolean | "mixed"; label: string; onToggle: () => void; hoverOnly?: boolean }) {
  return <button type="button" role="checkbox" aria-checked={checked} aria-label={label} title={label} onClick={(event) => { event.stopPropagation(); onToggle(); }} className={cn("grid size-5 shrink-0 place-items-center", hoverOnly && "opacity-0 focus-visible:opacity-100 group-hover/list:opacity-100")} data-drive-select>
    <span className={cn("grid size-4 place-items-center rounded-[3px] border", checked ? "border-[#3370ff] bg-[#3370ff] text-white" : "border-[#bbbfc4] bg-white hover:border-[#3370ff]")}>{checked === "mixed" ? <span className="h-0.5 w-2 rounded bg-white"/> : checked ? <Check size={12} strokeWidth={3}/> : null}</span>
  </button>;
}

function DriveRow(props: EntryActions & { columns: DriveColumnPreferences; selected: boolean; selecting: boolean; onSelect: () => void }) {
  const { entry, onOpen, columns, selected, selecting, onSelect } = props;
  return <div className={cn("group relative flex min-h-14 items-center gap-3 border-b border-[#eef0f2] px-2 py-1", selected ? "bg-[#f0f4ff]" : "hover:bg-[#f7f8fa]")} data-drive-row={entry.id} aria-selected={selected}>
    <span className={cn("shrink-0", !selected && !selecting && "opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:hidden")}><SelectBox checked={selected} label={`选择「${entry.title || "未命名"}」`} onToggle={onSelect}/></span>
    <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left"><DriveIcon entry={entry}/><span className="min-w-0"><span className="block truncate text-[13px] text-[#1f2329]">{entry.title || "未命名"}</span>{columns.order.map((column) => columns.visible[column] && <span key={column} className={cn("block truncate text-[11px] leading-3 text-[#8f959e]", column === "owner" || column === "modifier" ? "xl:hidden" : column === "updated" ? "sm:hidden" : "md:hidden")}>{column === "owner" ? `所有者 ${entry.creatorName || "—"}` : column === "modifier" ? `修改者 ${entry.lastModifierName || "—"}` : `${column === "updated" ? "修改于" : "创建于"} ${formatDriveTime(column === "updated" ? entry.updatedAt : entry.createdAt)}`}</span>)}</span></button>
    {columns.order.map((column) => columns.visible[column] && <span key={column} className={cn("hidden w-32 text-[12px] text-[#8f959e]", column === "owner" || column === "modifier" ? "xl:block" : column === "updated" ? "sm:block" : "md:block")}>{column === "owner" || column === "modifier" ? <span className="flex items-center gap-2 pr-2" title={column === "owner" ? "当前版本的所有者为创建者" : "未记录或无法确认时显示空值"}>{(column === "owner" ? entry.creatorName : entry.lastModifierName) && <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-[#e8efff] text-[10px] text-[#3370ff]">{[...(column === "owner" ? entry.creatorName! : entry.lastModifierName!)][0]}</span>}<span className="truncate">{(column === "owner" ? entry.creatorName : entry.lastModifierName) || "—"}</span></span> : formatDriveTime(column === "updated" ? entry.updatedAt : entry.createdAt)}</span>)}
    <EntryMenu {...props}/>
  </div>;
}

function EntryMenu({ entry, starred, onStar, onMove, onCopyLink, onRename, onTrash }: EntryActions) {
  const [menu, setMenu] = useState(false);
  return <>
    <button type="button" aria-label={`${entry.title || "文档"}更多操作`} aria-expanded={menu} onClick={() => setMenu((value) => !value)} className="grid size-8 place-items-center rounded text-[#8f959e] hover:bg-[#e9eaec]"><Ellipsis size={17}/></button>
    {menu && <><button type="button" aria-label="关闭菜单" className="fixed inset-0 z-20 cursor-default" onClick={() => setMenu(false)}/><div className="absolute right-0 top-11 z-30 w-36 rounded-md border bg-white py-1 text-[13px] shadow-lg">{[[starred ? "取消收藏" : "收藏", () => onStar(!starred)], ["复制链接", onCopyLink], ["重命名", onRename], ["移动到…", onMove], ["移到回收站", onTrash]].map(([label, action]) => <button type="button" key={label as string} onClick={() => { setMenu(false); (action as () => void)(); }} className="block w-full px-4 py-2 text-left hover:bg-[#f2f3f5]">{label as string}</button>)}</div></>}
  </>;
}

/** Move within the same scope using actual folder names. */
function MoveDialog({ entries, onDone }: { entries: DriveEntry[]; onDone: (result?: { done: number[]; failed: number[] }) => void }) {
  const qc = useQueryClient();
  const entry = entries[0];
  const movingIds = new Set(entries.map((item) => item.id));
  const [path, setPath] = useState<DriveEntry[]>([]);
  const [error, setError] = useState("");
  const parent = path.at(-1)?.id ?? null;
  const dirs = useQuery({ queryKey: ["drive-move", entry.id, parent], queryFn: () => driveApi.children(parent, !!entry.personal) });
  const move = useMutation({
    mutationFn: async () => {
      if (entries.length === 1) { await driveApi.move(entry.id, parent, entry.revision); return { done: [entry.id], failed: [] }; }
      return runDriveBatch(entries, (item) => driveApi.move(item.id, parent, item.revision));
    },
    onSuccess: (result) => { void qc.invalidateQueries({ queryKey: ["drive"] }); void qc.invalidateQueries({ queryKey: ["drive-nav"] }); void qc.invalidateQueries({ queryKey: ["docs"] }); onDone(result); },
    onError: () => setError("移动未完成，请检查权限或目录后重试。"),
  });
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 px-4" onMouseDown={() => { if (!move.isPending) onDone(); }}><div role="dialog" aria-modal="true" aria-label="移动文件" className="w-full max-w-[420px] rounded-lg bg-white p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}><h3 className="text-[16px] font-semibold">{entries.length > 1 ? `移动 ${entries.length} 项` : `移动「${entry.title}」`}</h3><div className="mt-4 flex items-center gap-1 text-[13px] text-[#646a73]"><button type="button" onClick={() => setPath([])} className="hover:text-[#3370ff]">{entry.personal ? "我的文件夹" : "共享文件夹"}</button>{path.map((folder, i) => <span key={folder.id} className="flex items-center gap-1"><ChevronRight size={12}/><button type="button" onClick={() => setPath(path.slice(0, i + 1))}>{folder.title}</button></span>)}</div><div className="mt-3 h-44 overflow-y-auto rounded-md border">{(dirs.data ?? []).filter((item) => item.kind === "folder" && !movingIds.has(item.id)).map((folder) => <button type="button" key={folder.id} onClick={() => setPath([...path, folder])} className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-[#f2f3f5]"><Folder size={16} fill="#ffcc4d" stroke="#f5a623"/>{folder.title}<ChevronRight size={13} className="ml-auto text-[#8f959e]"/></button>)}{dirs.isError && <p className="p-3 text-xs text-destructive">无法加载文件夹</p>}</div>{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" disabled={move.isPending} onClick={() => onDone()} className="h-8 rounded-md border px-3 text-[13px] disabled:opacity-40">取消</button><button type="button" disabled={move.isPending || dirs.isError} onClick={() => move.mutate()} className="h-8 rounded-md bg-[#3370ff] px-3 text-[13px] text-white disabled:opacity-40">移动到这里</button></div></div></div>;
}

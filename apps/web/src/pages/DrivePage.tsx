import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { driveApi, extrasApi, type DriveEntry } from "@/lib/api";
import { BaseIcon, DocIcon, hrefOf } from "@/components/Sidebar";
import { ask, askText } from "@/components/ui/ask";
import { cn } from "@/lib/utils";
import { parseMarkdown } from "@/lib/markdown";
import { stageStarter } from "./pendingStarter";
import { StarterTemplates, type StarterTemplate } from "./StarterTemplates";
import { hasUnsupportedImportBlocks } from "./starterTemplateOps";
import { ArrowDownUp, ChevronDown, ChevronRight, CloudUpload, Ellipsis, Folder, FolderPlus, LayoutGrid, List, Presentation, Search, Table2 } from "lucide-react";

type DriveSort = "name" | "updated";

/** Cloud drive: folder navigation and file operations use the guarded drive API. */
export function DrivePage({ folderId, personalRoot, userId }: { folderId: number | null; personalRoot: boolean; userId: number }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["drive", folderId, personalRoot], queryFn: () => driveApi.children(folderId, personalRoot), refetchInterval: 15000, refetchIntervalInBackground: false });
  const crumbs = useQuery({ queryKey: ["drive-ancestors", folderId], queryFn: () => driveApi.ancestors(folderId!), enabled: folderId !== null });
  const mine = useQuery({ queryKey: ["drive-root", "personal"], queryFn: () => driveApi.children(null, true), enabled: folderId !== null });
  const favorites = useQuery({ queryKey: ["favorites"], queryFn: extrasApi.favorites });
  const crumbsOrdered = useMemo(() => [...(crumbs.data ?? [])].reverse(), [crumbs.data]);
  const rootId = crumbsOrdered[0]?.id ?? folderId;
  const scope = folderId === null ? personalRoot : (mine.data ?? []).some((entry) => entry.id === rootId);
  const [sort, setSort] = useState<DriveSort>("updated");
  const [grid, setGrid] = useState(false);
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const [moving, setMoving] = useState<DriveEntry | null>(null);
  const [creating, setCreating] = useState(false);
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
  const createNode = useMutation({ mutationFn: ({ kind, title }: { kind: "doc" | "base" | "slides"; title: string }) => driveApi.createNode(kind, title, folderId, scope), onSuccess: (entry) => { invalidate(); void qc.invalidateQueries({ queryKey: ["docs"] }); location.hash = hrefOf({ id: entry.id, kind: entry.kind as "doc" | "base" | "slides" }); }, onError: failure });
  const trash = useMutation({ mutationFn: (entry: DriveEntry) => driveApi.trash(entry.id, entry.revision), onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ["docs"] }); void qc.invalidateQueries({ queryKey: ["trash"] }); }, onError: failure });
  const entries = useMemo(() => [...(list.data ?? [])].sort((a, b) => {
    if ((a.kind === "folder") !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
    return sort === "updated" ? (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") : (a.title || "未命名").localeCompare(b.title || "未命名", "zh-CN");
  }), [list.data, sort]);
  const visible = useMemo(() => { const q = filter.trim().toLocaleLowerCase(); return q ? entries.filter((entry) => (entry.title || "未命名").toLocaleLowerCase().includes(q)) : entries; }, [entries, filter]);
  const folders = visible.filter((entry) => entry.kind === "folder");
  const files = visible.filter((entry) => entry.kind !== "folder");
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
    onOpen: () => { location.hash = entry.kind === "folder" ? `#/drive/${entry.id}` : hrefOf({ id: entry.id, kind: entry.kind as "doc" | "base" | "slides" }); },
    onRename: async () => { const title = await askText("重命名", "名称", entry.title); if (title?.trim() && title.trim() !== entry.title) rename.mutate({ id: entry.id, title: title.trim(), expected: entry.revision }); },
    onMove: () => setMoving(entry),
    onCopyLink: async () => { const route = entry.kind === "folder" ? `#/drive/${entry.id}` : hrefOf({ id: entry.id, kind: entry.kind as "doc" | "base" | "slides" }); try { await navigator.clipboard.writeText(`${location.origin}${location.pathname}${route}`); setNotice("链接已复制，访问者仍需具备权限。"); } catch { setError("复制失败，请检查浏览器剪贴板权限。"); } },
    onTrash: () => { void ask(`删除「${entry.title}」？`, entry.kind === "folder" ? "整个文件夹会移到回收站，可恢复。" : "会移到回收站，可恢复。").then((ok) => { if (ok) trash.mutate(entry); }); },
    onStar: (next: boolean) => { void (next ? extrasApi.star(entry.id) : extrasApi.unstar(entry.id)).then(() => favorites.refetch()).catch(failure); },
  });
  return <main className="flex min-w-0 flex-1 flex-col bg-white" data-drive-page>
    <header className="flex h-16 shrink-0 items-center pl-14 pr-5 md:px-7"><h1 className="text-[20px] font-semibold text-[#1f2329]">云盘</h1><button type="button" aria-label="全局搜索" onClick={() => document.querySelector<HTMLElement>("[data-search]")?.click()} className="ml-auto grid size-8 place-items-center rounded-md text-[#646a73] hover:bg-[#f2f3f5]"><Search size={18}/></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-7">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <div className="relative"><button type="button" onClick={() => setCreating((value) => !value)} aria-expanded={creating} className="flex h-16 w-full items-center gap-3 rounded-lg border border-[#e5e6eb] bg-white px-4 text-left hover:bg-[#f7f8fa]"><span className="grid size-8 place-items-center rounded-md bg-[#e8efff] text-[#3370ff]"><FolderPlus size={18}/></span><span className="min-w-0 flex-1"><span className="block text-[14px] font-medium text-[#1f2329]">新建</span><span className="hidden truncate text-[12px] text-[#8f959e] sm:block">新建文档开始协作</span></span><ChevronDown size={15} className="text-[#8f959e]"/></button>
          {creating && <><div className="fixed inset-0 z-30" onClick={() => setCreating(false)}/><div className="absolute left-0 top-[70px] z-40 w-48 rounded-lg border border-[#dee0e3] bg-white py-1 shadow-[0_6px_24px_rgba(31,35,41,0.16)]">{(["doc", "slides", "base", "folder"] as const).map((kind) => <button key={kind} type="button" onClick={() => void newItem(kind)} className="flex h-10 w-full items-center gap-3 px-4 text-left text-[14px] text-[#1f2329] hover:bg-[#f2f3f5]">{kind === "doc" ? <DocIcon/> : kind === "base" ? <BaseIcon/> : kind === "slides" ? <span className="grid size-5 place-items-center rounded bg-[#ff8800] text-white"><Presentation size={13}/></span> : <Folder size={18} fill="#ffcc4d" stroke="#f5a623"/>}{kind === "doc" ? "文档" : kind === "base" ? "多维表格" : kind === "slides" ? "幻灯片" : "文件夹"}</button>)}</div></>}
        </div>
        <label className="flex h-16 cursor-pointer items-center gap-3 rounded-lg border border-[#e5e6eb] px-4 text-left hover:bg-[#f7f8fa]"><span className="grid size-8 place-items-center rounded-md bg-[#fff1e6] text-[#ff8800]"><CloudUpload size={18}/></span><span><span className="block text-[14px] font-medium">{importing ? "正在导入…" : "上传"}</span><span className="hidden text-[12px] text-[#8f959e] sm:block">导入 Markdown 文档</span></span><input type="file" aria-label="上传 Markdown 文件" accept=".md,.markdown,text/markdown" disabled={importing} className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void importMarkdown(file); }}/></label>
        <button type="button" disabled title="暂不支持添加快捷方式" className="flex h-16 items-center gap-3 rounded-lg border border-[#e5e6eb] px-4 text-left opacity-50"><span className="grid size-8 place-items-center rounded-md bg-[#f0eaff] text-[#8657e5]"><ChevronRight size={18}/></span><span><span className="block text-[14px] font-medium">添加</span><span className="hidden text-[12px] text-[#8f959e] sm:block">添加云文档的快捷方式</span></span></button>
        <button type="button" onClick={() => setLibraryOpen(true)} className="flex h-16 items-center gap-3 rounded-lg border border-[#e5e6eb] px-4 text-left hover:bg-[#f7f8fa]"><span className="grid size-8 place-items-center rounded-md bg-[#fff6df] text-[#f5a623]"><Table2 size={18}/></span><span><span className="block text-[14px] font-medium">模板库</span><span className="hidden text-[12px] text-[#8f959e] sm:block">选择模板快速新建</span></span></button>
      </div>
      {folderId !== null && <nav aria-label="文件夹路径" className="mt-5 flex flex-wrap items-center gap-1 text-[13px] text-[#646a73]"><a href={scope ? "#/drive/mine" : "#/drive"} className="hover:text-[#3370ff]">{scope ? "我的文件夹" : "共享文件夹"}</a>{crumbsOrdered.map((item) => <span key={item.id} className="flex items-center gap-1"><ChevronRight size={13}/><a href={item.kind === "folder" ? `#/drive/${item.id}` : hrefOf(item)} className="hover:text-[#3370ff]">{item.title || "未命名"}</a></span>)}</nav>}
      <div className="mt-8 flex items-center gap-5 text-[14px]"><a href="#/drive/mine" className={cn("pb-1", scope ? "font-medium text-[#3370ff]" : "text-[#646a73]")}>我的文件夹</a><a href="#/drive" className={cn("pb-1", !scope ? "font-medium text-[#3370ff]" : "text-[#646a73]")}>共享文件夹</a><div className="ml-auto flex items-center gap-2"><button type="button" onClick={() => setSort((value) => value === "name" ? "updated" : "name")} className="flex h-8 items-center gap-1 rounded px-2 text-[12px] text-[#646a73] hover:bg-[#f2f3f5]" title={sort === "name" ? "按名称排序" : "按修改时间排序"}><ArrowDownUp size={14}/>排序<ChevronDown size={12}/></button><button type="button" onClick={() => setGrid((value) => !value)} className="flex h-8 items-center gap-1 rounded px-2 text-[12px] text-[#646a73] hover:bg-[#f2f3f5]">展示<ChevronDown size={12}/></button></div></div>
      {list.isError ? <p role="alert" className="py-10 text-center text-[13px] text-[#8f959e]">无法访问该目录，请确认权限后重试。</p> : <>
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">{folders.map((entry) => <FolderCard key={entry.id} entry={entry} starred={favorites.data?.some((item) => item.id === entry.id) ?? false} {...actions(entry)}/>)}{folders.length === 0 && <p className="py-3 text-[13px] text-[#8f959e]">{filter ? "没有匹配的文件夹" : "暂无文件夹"}</p>}</div>
        <div className="mt-8 flex h-9 items-center"><h2 className="text-[15px] font-semibold text-[#1f2329]">文档</h2><div className="ml-auto flex items-center gap-1"><button type="button" onClick={() => setShowFilter((value) => !value)} aria-label="搜索当前目录" className="grid size-8 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Search size={15}/></button><button type="button" onClick={() => setGrid(false)} aria-label="列表视图" className={cn("grid size-8 place-items-center rounded", !grid ? "bg-[#edf2ff] text-[#3370ff]" : "text-[#8f959e]")}><List size={16}/></button><button type="button" onClick={() => setGrid(true)} aria-label="网格视图" className={cn("grid size-8 place-items-center rounded", grid ? "bg-[#edf2ff] text-[#3370ff]" : "text-[#8f959e]")}><LayoutGrid size={16}/></button></div></div>
        {showFilter && <input autoFocus value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索当前目录" className="my-2 h-8 w-56 rounded-md border px-2 text-[13px] outline-none focus:border-[#3370ff]"/>}
        {grid ? <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">{files.map((entry) => <FileCard key={entry.id} entry={entry} starred={favorites.data?.some((item) => item.id === entry.id) ?? false} {...actions(entry)}/>)}</div> : <div className="mt-2"><div className="flex h-10 items-center border-b border-[#dee0e3] px-2 text-[12px] text-[#8f959e]"><span className="min-w-0 flex-1">标题</span><span className="hidden w-32 sm:block">修改时间</span><span className="hidden w-32 md:block">创建时间</span><span className="w-9"/></div>{files.map((entry) => <DriveRow key={entry.id} entry={entry} starred={favorites.data?.some((item) => item.id === entry.id) ?? false} {...actions(entry)}/>)}</div>}
        {files.length === 0 && list.isSuccess && <p className="py-8 text-center text-[13px] text-[#8f959e]">{filter ? "没有匹配的文档" : "暂无文档"}</p>}
      </>}
      {notice && <p role="status" className="mt-4 text-[12px] text-[#3370ff]">{notice}</p>}
      {error && <p role="alert" className="mt-4 text-[12px] text-destructive">{error}</p>}
    </div>
    {moving && <MoveDialog entry={moving} onDone={() => setMoving(null)}/>}
    {libraryOpen && <div className="fixed inset-0 z-[60] grid place-items-center bg-black/25 p-4" onMouseDown={() => { if (!templatePending) setLibraryOpen(false); }}><div role="dialog" aria-modal="true" aria-label="模板库" className="max-h-[calc(100dvh-2rem)] w-full max-w-[880px] overflow-y-auto rounded-lg border bg-white p-5 shadow-xl" onMouseDown={(event) => event.stopPropagation()}><h2 className="mb-5 text-[16px] font-semibold">模板库</h2><StarterTemplates compact disabled={templatePending} onChoose={(template) => void chooseTemplate(template)} onHide={() => setLibraryOpen(false)}/>{error && <p role="alert" className="mt-3 text-[13px] text-destructive">{error}</p>}</div></div>}
  </main>;
}

function DriveIcon({ entry }: { entry: DriveEntry }) { return entry.kind === "folder" ? <Folder size={18} fill="#ffcc4d" stroke="#f5a623"/> : entry.kind === "base" ? <BaseIcon/> : entry.kind === "slides" ? <span className="grid size-5 place-items-center rounded bg-[#ff8800] text-white"><Presentation size={13}/></span> : <DocIcon/>; }

type EntryActions = { entry: DriveEntry; starred: boolean; onStar: (next: boolean) => void; onOpen: () => void; onMove: () => void; onCopyLink: () => void; onRename: () => void; onTrash: () => void };

function FolderCard(props: EntryActions) {
  return <div className="relative flex h-16 min-w-0 items-center gap-2 rounded-md border border-[#e5e6eb] px-3 hover:bg-[#f7f8fa]"><button type="button" onClick={props.onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left"><Folder size={24} fill="#ffcc4d" stroke="#f5a623"/><span className="truncate text-[13px] text-[#1f2329]">{props.entry.title || "未命名文件夹"}</span></button><EntryMenu {...props}/></div>;
}

function FileCard(props: EntryActions) {
  return <div className="relative flex min-h-24 flex-col rounded-lg border p-3 hover:bg-[#f7f8fa]"><div className="flex items-start"><button type="button" onClick={props.onOpen} className="flex min-w-0 flex-1 flex-col items-start gap-2 text-left"><DriveIcon entry={props.entry}/><span className="w-full truncate text-[13px]">{props.entry.title || "未命名"}</span></button><EntryMenu {...props}/></div></div>;
}

function DriveRow(props: EntryActions) {
  const { entry, onOpen } = props;
  return <div className="group relative flex h-14 items-center gap-3 border-b border-[#eef0f2] px-2 hover:bg-[#f7f8fa]" data-drive-row={entry.id}>
    <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left"><DriveIcon entry={entry}/><span className="truncate text-[13px] text-[#1f2329]">{entry.title || "未命名"}</span></button>
    <span className="hidden w-32 text-[12px] text-[#8f959e] sm:block">{entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString("zh-CN") : ""}</span>
    <span className="hidden w-32 text-[12px] text-[#8f959e] md:block">{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString("zh-CN") : ""}</span>
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
function MoveDialog({ entry, onDone }: { entry: DriveEntry; onDone: () => void }) {
  const qc = useQueryClient();
  const [path, setPath] = useState<DriveEntry[]>([]);
  const [error, setError] = useState("");
  const parent = path.at(-1)?.id ?? null;
  const dirs = useQuery({ queryKey: ["drive-move", entry.id, parent], queryFn: () => driveApi.children(parent, !!entry.personal) });
  const move = useMutation({ mutationFn: () => driveApi.move(entry.id, parent, entry.revision), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["drive"] }); void qc.invalidateQueries({ queryKey: ["drive-nav"] }); void qc.invalidateQueries({ queryKey: ["docs"] }); onDone(); }, onError: () => setError("移动未完成，请检查权限或目录后重试。") });
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 px-4" onMouseDown={onDone}><div role="dialog" aria-modal="true" aria-label="移动文件" className="w-full max-w-[420px] rounded-lg bg-white p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}><h3 className="text-[16px] font-semibold">移动「{entry.title}」</h3><div className="mt-4 flex items-center gap-1 text-[13px] text-[#646a73]"><button type="button" onClick={() => setPath([])} className="hover:text-[#3370ff]">{entry.personal ? "我的文件夹" : "共享文件夹"}</button>{path.map((folder, i) => <span key={folder.id} className="flex items-center gap-1"><ChevronRight size={12}/><button type="button" onClick={() => setPath(path.slice(0, i + 1))}>{folder.title}</button></span>)}</div><div className="mt-3 h-44 overflow-y-auto rounded-md border">{(dirs.data ?? []).filter((item) => item.kind === "folder" && item.id !== entry.id).map((folder) => <button type="button" key={folder.id} onClick={() => setPath([...path, folder])} className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-[#f2f3f5]"><Folder size={16} fill="#ffcc4d" stroke="#f5a623"/>{folder.title}<ChevronRight size={13} className="ml-auto text-[#8f959e]"/></button>)}{dirs.isError && <p className="p-3 text-xs text-destructive">无法加载文件夹</p>}</div>{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onDone} className="h-8 rounded-md border px-3 text-[13px]">取消</button><button type="button" disabled={move.isPending || dirs.isError} onClick={() => move.mutate()} className="h-8 rounded-md bg-[#3370ff] px-3 text-[13px] text-white disabled:opacity-40">移动到这里</button></div></div></div>;
}

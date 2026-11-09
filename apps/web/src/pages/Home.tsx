import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { baseApi, docsApi, extrasApi, type DocMeta, type Me } from "@/lib/api";
import { DocumentGlyph } from "@/components/DocumentGlyph";
import { go } from "@/lib/route";
import { docTitle, hrefOf } from "@/components/Sidebar";
import { Avatar } from "@/components/brand";
import { colorFor } from "@/lib/presence";
import { DocColorIcon } from "@/components/FeishuIcons";
import { NewDocGlyph, UploadGlyph, TemplateGlyph } from "@/components/DriveActionIcons";
import { parseMarkdown } from "@/lib/markdown";
import { StarterTemplates, type StarterTemplate } from "./StarterTemplates";
import { stageStarter } from "./pendingStarter";
import { hasUnsupportedImportBlocks } from "./starterTemplateOps";
import { ChevronDown, FolderOpen, Plus, Star, Table2 } from "lucide-react";

type HomeTab = "recent" | "updated" | "mine" | "shared" | "favorites";
const LIST_GRID = "grid grid-cols-[minmax(0,1fr)_100px] sm:grid-cols-[minmax(0,1fr)_112px_120px] lg:grid-cols-[minmax(150px,2fr)_minmax(90px,1fr)_minmax(92px,1fr)_110px_120px]";

export function Home({ me, recent, favorites }: { me: Me; recent?: boolean; favorites?: boolean }) {
  const qc = useQueryClient();
  useEffect(() => { document.title = `${favorites ? "收藏" : recent ? "最近访问" : "主页"} - Jiange`; }, [favorites, recent]);
  const [tab, setTab] = useState<HomeTab>("recent");
  const [kind, setKind] = useState("all");
  const [newMenu, setNewMenu] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [importError, setImportError] = useState("");
  const newMenuRef = useRef<HTMLDivElement>(null);
  const contentLock = useRef(false);
  useEffect(() => {
    if (!newMenu) return;
    const close = (event: MouseEvent) => { if (!newMenuRef.current?.contains(event.target as Node)) setNewMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setNewMenu(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [newMenu]);
  useEffect(() => {
    if (!libraryOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setLibraryOpen(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [libraryOpen]);
  const selected = favorites ? "favorites" : recent ? "recent" : tab;
  const docs = useQuery({ queryKey: ["docs"], queryFn: docsApi.list });
  const recentDocs = useQuery({ queryKey: ["recent", me.user.id], queryFn: docsApi.recent, enabled: selected === "recent", refetchInterval: 15000, refetchIntervalInBackground: false });
  const shared = useQuery({ queryKey: ["shared"], queryFn: docsApi.shared, enabled: selected === "shared" });
  const favs = useQuery({ queryKey: ["favorites"], queryFn: extrasApi.favorites, enabled: selected === "favorites" });
  const create = useMutation({
    mutationFn: (type: "doc" | "base") => type === "base" ? baseApi.create() : docsApi.create(""),
    onSuccess: (d) => { qc.invalidateQueries({ queryKey: ["docs"] }); go(hrefOf(d)); },
  });
  const createWithContent = useMutation({
    mutationFn: async ({ title, markdown }: { title: string; markdown: string }) => {
      const doc = await docsApi.create(title);
      stageStarter(me.user.id, doc.id, markdown);
      return doc;
    },
    onSuccess: (d) => { qc.invalidateQueries({ queryKey: ["docs"] }); setLibraryOpen(false); go(hrefOf(d)); },
    onError: () => setImportError("创建文档失败，请稍后重试。"),
  });
  const importFile = async (file: File) => {
    if (contentLock.current) return;
    contentLock.current = true;
    setImportError("");
    if (file.size > 5 * 1024 * 1024) { setImportError("Markdown 文件不能超过 5 MB。"); contentLock.current = false; return; }
    try {
      const markdown = await file.text();
      if (!parseMarkdown(markdown).length) { setImportError("文件没有可导入的内容。"); contentLock.current = false; return; }
      if (hasUnsupportedImportBlocks(markdown)) { setImportError("暂不支持导入图片，请先移除图片内容。"); contentLock.current = false; return; }
      createWithContent.mutate({ title: file.name.replace(/\.(md|markdown)$/i, "") || "导入文档", markdown }, { onSettled: () => { contentLock.current = false; } });
    } catch { setImportError("读取文件失败，请重试。"); contentLock.current = false; }
  };
  const chooseTemplate = (template: StarterTemplate) => {
    if (contentLock.current) return;
    contentLock.current = true;
    createWithContent.mutate({ title: template.name, markdown: template.body }, { onSettled: () => { contentLock.current = false; } });
  };
  const query = selected === "favorites" ? favs : selected === "shared" ? shared : selected === "recent" ? recentDocs : docs;
  const items = [...(query.data ?? [])]
    .filter((d) => (kind === "all" || (d.kind ?? "doc") === kind) && (selected !== "mine" || d.creatorId === me.user.id))
    .sort((a, b) => selected === "recent" ? 0 : Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const pageTitle = favorites ? "收藏" : recent ? "最近访问" : "主页";
  const menu = newMenu && <div role="menu" className={`absolute top-[calc(100%+6px)] z-30 w-52 rounded-lg border bg-surface p-1.5 shadow-[0_6px_22px_rgba(31,35,41,0.16)] ${recent || favorites ? "right-0" : "left-0"}`}>
    <button role="menuitem" disabled={create.isPending} onClick={() => { setNewMenu(false); create.mutate("doc"); }} className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-[13px] hover:bg-hover"><FileBadge kind="doc" />文档</button>
    <button role="menuitem" disabled={create.isPending} onClick={() => { setNewMenu(false); create.mutate("base"); }} className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-[13px] hover:bg-hover"><FileBadge kind="base" />多维表格</button>
  </div>;
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center justify-between pl-16 pr-5 md:px-7 xl:px-6">
        <h1 className="text-[20px] font-semibold leading-7">{pageTitle}</h1>
        {(recent || favorites) && <div ref={newMenuRef} className="relative">
          <button onClick={() => setNewMenu((v) => !v)} aria-expanded={newMenu} aria-haspopup="menu" className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-hover"><Plus size={15} /> 新建 <ChevronDown size={13} /></button>
          {menu}
        </div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full px-5 pb-16 pt-2 sm:px-7 xl:px-6">
          {!recent && !favorites && <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-[repeat(3,305px)]">
            <div ref={newMenuRef} className="relative">
              <button onClick={() => setNewMenu((v) => !v)} aria-expanded={newMenu} aria-haspopup="menu" className="flex h-16 w-full items-center gap-3 rounded-lg border bg-surface px-4 text-left transition-colors hover:bg-hover/50 focus-visible:outline-2 focus-visible:outline-primary">
                <span className="grid size-8 shrink-0 place-items-center"><NewDocGlyph /></span>
                <span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">新建</span><span className="mt-0.5 block truncate text-[12px] text-subtle">新建文档开始协作</span></span><ChevronDown size={15} className="shrink-0 text-subtle" />
              </button>{menu}
            </div>
            <label className="flex h-16 w-full cursor-pointer items-center gap-3 rounded-lg border bg-surface px-4 text-left transition-colors hover:bg-hover/50 focus-within:outline-2 focus-within:outline-primary">
              <span className="grid size-8 shrink-0 place-items-center"><UploadGlyph /></span><span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">上传</span><span className="mt-0.5 block truncate text-[12px] text-subtle">导入 Markdown 文档</span></span><ChevronDown size={15} className="text-subtle" />
              <input type="file" aria-label="上传 Markdown 文件" accept=".md,.markdown,text/markdown" disabled={createWithContent.isPending} className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void importFile(file); }} />
            </label>
            <ActionCard icon={<TemplateGlyph />} title="模板库" description="选择模板快速新建" onClick={() => setLibraryOpen(true)} disabled={createWithContent.isPending} />
          </div>}
          {create.isError && <p role="alert" className="mt-3 text-[13px] text-destructive">新建失败，请检查网络后重试。</p>}
          {importError && <p role="alert" className="mt-3 text-[13px] text-destructive">{importError}</p>}
          {createWithContent.isPending && <p role="status" className="mt-3 text-[13px] text-subtle">正在创建文档…</p>}
          {!recent && !favorites ? <div className="mt-5 flex min-h-12 flex-wrap items-end gap-x-3 border-b">
            <nav aria-label="文档分类" className="flex min-w-0 flex-1 basis-full items-center gap-5 overflow-x-auto whitespace-nowrap text-[14px] sm:basis-auto sm:gap-7">
              {([ ["recent", "最近访问"], ["updated", "最近更新"], ["mine", "我创建的"], ["shared", "与我共享"], ["favorites", "收藏"] ] as const).map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`relative shrink-0 pb-3 pt-2 ${selected === id ? "font-medium text-primary after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>)}
            </nav>
            <TypeFilter kind={kind} onChange={setKind} />
          </div> : <div className="mt-2 flex min-h-12 items-end justify-between border-b"><div className="pb-3 text-[14px] font-medium">{favorites ? "收藏的文档" : "最近访问"}</div><TypeFilter kind={kind} onChange={setKind} /></div>}
          <div className={`${LIST_GRID} h-10 items-center gap-3 border-b px-2 text-[12px] text-subtle`}>
            <span>标题</span><span className="hidden truncate lg:block">位置</span><span className="hidden truncate sm:block">所有者</span><span className="hidden truncate lg:block">创建时间</span><span className="truncate">{selected === "recent" ? "最近访问" : "最近更新"}</span>
          </div>
          {query.isPending ? <p className="px-2 py-14 text-center text-[13px] text-subtle">加载中…</p> : query.isError ? <p role="alert" className="px-2 py-14 text-center text-[13px] text-destructive">加载失败，请检查网络。 <button type="button" className="underline" onClick={() => void query.refetch()}>重试</button></p> : items.length ? items.map((d) => <DocumentRow key={d.id} doc={d} viewedAt={selected === "recent" && "viewedAt" in d && typeof d.viewedAt === "string" ? d.viewedAt : undefined} workspaceName={d.workspaceName || me.workspaces.find((w) => w.id === d.workspaceId)?.name} />) : <div className="grid place-items-center px-5 py-20 text-center" data-empty-guide>
            <span className="grid size-14 place-items-center rounded-full bg-sidebar text-subtle">{selected === "favorites" ? <Star size={23} strokeWidth={1.4} /> : <FolderOpen size={24} strokeWidth={1.4} />}</span>
            <p className="mt-4 text-[13px] text-muted-foreground">{kind !== "all" ? "没有此类型的文档" : selected === "favorites" ? "还没有收藏的文档" : selected === "shared" ? "还没有与我共享的文档" : selected === "mine" ? "暂无我创建的文档" : selected === "recent" ? "还没有最近访问的文档" : "暂无文档"}</p>
            {selected === "recent" && kind === "all" && <button onClick={() => create.mutate("doc")} disabled={create.isPending} className="mt-3 text-[13px] text-primary hover:underline">新建文档</button>}
          </div>}
        </div>
      </div>
      {libraryOpen && <div className="fixed inset-0 z-40 grid place-items-center bg-black/20 p-4" onMouseDown={() => setLibraryOpen(false)}><div role="dialog" aria-modal="true" aria-label="模板库" className="max-h-[calc(100dvh-2rem)] w-full max-w-[880px] overflow-y-auto rounded-lg border bg-surface p-5 shadow-xl sm:p-6" onMouseDown={(event) => event.stopPropagation()}><h2 className="mb-5 text-[16px] font-semibold">模板库</h2><StarterTemplates compact disabled={createWithContent.isPending} onChoose={chooseTemplate} onHide={() => setLibraryOpen(false)} />{importError && <p role="alert" className="mt-3 text-[13px] text-destructive">{importError}</p>}</div></div>}
    </main>
  );
}
function TypeFilter({ kind, onChange }: { kind: string; onChange: (kind: string) => void }) {
  return <label className="relative mb-2 inline-flex shrink-0 items-center"><span className="sr-only">文档类型</span><select value={kind} onChange={(e) => onChange(e.target.value)} className="h-8 cursor-pointer appearance-none rounded-md bg-transparent pl-2 pr-6 text-[12px] text-muted-foreground outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40"><option value="all">所有类型</option><option value="doc">文档</option><option value="base">多维表格</option></select><ChevronDown size={12} className="pointer-events-none absolute right-2 text-subtle" /></label>;
}
function FileBadge({ kind, icon }: { kind: "doc" | "base"; icon?: string }) {
  return kind === "doc" ? <DocumentGlyph icon={icon} className="size-5 text-[18px]" fallback={<DocColorIcon className="size-5 shrink-0" />} /> : <span className="grid size-5 shrink-0 place-items-center rounded-[4px] bg-[#6756d9] text-white"><Table2 size={13} strokeWidth={2}/></span>;
}
function ActionCard({ icon, title, description, disabled, onClick }: { icon: React.ReactNode; title: string; description: string; disabled?: boolean; onClick: () => void }) {
  return <button onClick={onClick} disabled={disabled} className="flex h-16 w-full items-center gap-3 rounded-lg border bg-surface px-4 text-left transition-colors hover:bg-hover/50 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"><span className="grid size-8 shrink-0 place-items-center">{icon}</span><span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">{title}</span><span className="mt-0.5 block truncate text-[12px] text-subtle">{description}</span></span></button>;
}
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
}
function DocumentRow({ doc, viewedAt, workspaceName }: { doc: DocMeta; viewedAt?: string; workspaceName?: string }) {
  return <button onClick={() => go(hrefOf(doc))} className={`${LIST_GRID} group h-14 w-full items-center gap-3 border-b px-2 text-left transition-colors hover:bg-hover/60 focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-primary`}>
    <span className="flex min-w-0 items-center gap-3"><FileBadge kind={doc.kind === "base" ? "base" : "doc"} icon={doc.icon} /><span className="truncate text-[13px] group-hover:text-primary">{docTitle(doc)}</span></span>
    <span className="hidden min-w-0 truncate text-[12px] text-muted-foreground lg:block">{workspaceName || "—"}</span>
    <span className="hidden min-w-0 items-center gap-2 truncate text-[12px] text-muted-foreground sm:flex"><Avatar name={doc.creatorName || "未知"} color={colorFor(doc.creatorId - 1)} size={20} /><span className="truncate">{doc.creatorName || "—"}</span></span>
    <span className="hidden truncate text-[12px] text-subtle lg:block">{dateLabel(doc.createdAt)}</span>
    <span className="truncate text-[12px] text-subtle">{dateLabel(viewedAt ?? doc.updatedAt)}</span>
  </button>;
}

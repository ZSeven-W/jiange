import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, baseApi, docsApi, driveApi, extrasApi, type DocMeta, type Me } from "@/lib/api";
import { go, nodeHref, type Route } from "@/lib/route";
import { cn } from "@/lib/utils";
import { ask, askText } from "@/components/ui/ask";
import { Logo } from "./brand";
import { Avatar } from "./brand";
import { colorFor } from "@/lib/presence";
import { DocColorIcon } from "./FeishuIcons";
import { DocumentGlyph } from "./DocumentGlyph";
import { GlobalSearch } from "./GlobalSearch";

export const hrefOf = nodeHref;
export const docTitle = (d: Pick<DocMeta, "title">) => d.title.trim() || "未命名文档";

export function renameErrorMessage(error: unknown): string {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) return "无法重命名：文档不存在或当前没有编辑权限。";
  if (error instanceof ApiError && error.status === 400) return "名称无效，请检查名称长度后重试。";
  if (error instanceof ApiError && error.code === "upgrade_required") return "当前版本无法安全重命名，请刷新页面后重试。";
  if (error instanceof ApiError && error.status === 409) return "文档已发生变化，请刷新后重新命名。";
  // A disconnected client cannot know whether the server committed the write.
  return "无法确认重命名是否完成，请刷新后查看。";
}

export function Sidebar({ me, route, onLogout }: { me: Me; route: Route; onLogout: () => void }) {
  const qc = useQueryClient();
  const docs = useQuery({
    queryKey: ["docs"],
    queryFn: docsApi.list,
    refetchInterval: 15000,
  });
  const shared = useQuery({
    queryKey: ["shared"],
    queryFn: docsApi.shared,
    refetchInterval: 30000,
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTrigger = useRef<HTMLInputElement>(null);
  const skipSearchFocus = useRef(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const k = event.key.toLowerCase();
      // ⌘/Ctrl+J 与飞书云文档一致；⌘/Ctrl+K 在非输入区域也打开搜索（编辑区内留给链接等快捷键）。
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (k === "j" || (k === "k" && !typing)) { event.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const closeSearch = (restoreFocus: boolean) => {
    setSearchOpen(false);
    if (restoreFocus) requestAnimationFrame(() => {
      skipSearchFocus.current = true;
      searchTrigger.current?.focus();
      // Focus events run synchronously. If the sidebar is hidden, focus can
      // fail entirely; never leave the next real focus suppressed.
      skipSearchFocus.current = false;
    });
  };
  const [menu, setMenu] = useState(false);
  const accountMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!accountMenu.current?.contains(event.target as Node)) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const create = useMutation({
    mutationFn: (parent: Pick<DocMeta, "id" | "workspaceId"> | null = null) => docsApi.create("", parent?.id ?? null, parent?.workspaceId),
    onSuccess: (d) => {
      if (d.parentId) setOpen((o) => ({ ...o, [d.parentId!]: true }));
      qc.invalidateQueries({ queryKey: ["docs"] });
      go(`#/doc/${d.id}`);
    },
  });
  const createBase = useMutation({
    mutationFn: () => baseApi.create(),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["docs"] });
      go(hrefOf(d));
    },
  });
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: number; title: string }) => docsApi.rename(id, title),
    onSettled: (_data, _error, { id }) => {
      // Even an interrupted request may have committed; revalidate instead of
      // treating a transport error as proof that the name did not change.
      for (const key of [["docs"], ["search"], ["favorites"], ["recent"], ["shared"], ["doc", id]]) {
        void qc.invalidateQueries({ queryKey: key });
      }
    },
  });
  const ws = me.workspaces[0];
  const kids = useMemo(() => {
    const m = new Map<number | null, DocMeta[]>();
    const ids = new Set((docs.data ?? []).map((d) => d.id));
    for (const d of [...(docs.data ?? [])].sort((a, b) => a.id - b.id)) {
      const p = d.parentId && ids.has(d.parentId) ? d.parentId : null;
      m.set(p, [...(m.get(p) ?? []), d]);
    }
    return m;
  }, [docs.data]);
  // expand ancestors of the open doc
  const activeId = route.page === "doc" || route.page === "base" || route.page === "file" ? route.id : null;
  const ancestors = useMemo(() => {
    const byId = new Map((docs.data ?? []).map((d) => [d.id, d]));
    const out = new Set<number>();
    let cur = activeId ? byId.get(activeId) : undefined;
    while (cur?.parentId && !out.has(cur.parentId)) {
      out.add(cur.parentId);
      cur = byId.get(cur.parentId);
    }
    return out;
  }, [docs.data, activeId]);
  const renderTree = (parent: number | null, depth: number): React.ReactNode =>
    (kids.get(parent) ?? []).map((d) => {
      const has = (kids.get(d.id) ?? []).length > 0;
      const isOpen = open[d.id] ?? ancestors.has(d.id);
      return (
        <div key={d.id}>
          <TreeRow
            depth={depth}
            label={docTitle(d)}
            base={d.kind === "base"}
            icon={d.icon}
            muted={!d.title.trim()}
            active={activeId === d.id}
            expandable={has}
            open={isOpen}
            starred={favorites.data?.some((f) => f.id === d.id)}
            onToggle={() => setOpen((o) => ({ ...o, [d.id]: !isOpen }))}
            onClick={() => go(hrefOf(d))}
            onAdd={() => {
              if (d.kind === "folder") {
                // folder 子节点必须走 guarded 创建（fence 会拒旧式插入）
                driveApi.createNode("doc", "未命名文档", d.id).then((e) => {
                  qc.invalidateQueries({ queryKey: ["docs"] });
                  qc.invalidateQueries({ queryKey: ["drive"] });
                  setOpen((o) => ({ ...o, [d.id]: true }));
                  go(hrefOf({ id: e.id, kind: "doc" }));
                });
                return;
              }
              create.mutate({ id: d.id, workspaceId: d.workspaceId });
            }}
            onStar={() => {
              const starred = favorites.data?.some((f) => f.id === d.id);
              (starred ? extrasApi.unstar(d.id) : extrasApi.star(d.id)).then(() => {
                favorites.refetch();
                qc.invalidateQueries({ queryKey: ["favorites"] });
              });
            }}
            onRename={rename.isPending ? undefined : async () => {
              rename.reset();
              const t = await askText("重命名", "文档名称", docTitle(d));
              if (t && t.trim()) rename.mutate({ id: d.id, title: t.trim() });
            }}
            onCopyLink={() => {
              navigator.clipboard?.writeText(`${location.origin}${location.pathname}${hrefOf(d)}`).catch(() => {});
            }}
            onDelete={async () => {
              // 走版本化云盘删除：folder 子树会被 fence 拒绝旧式语句
              if (await ask(`删除「${docTitle(d)}」？`, "可在回收站还原。"))
                driveApi.trash(d.id, d.driveRevision ?? 0).then(() => {
                  qc.invalidateQueries({ queryKey: ["docs"] });
                  qc.invalidateQueries({ queryKey: ["drive"] });
                  qc.invalidateQueries({ queryKey: ["trash"] });
                });
            }}
          />
          {has && isOpen && renderTree(d.id, depth + 1)}
        </div>
      );
    });
  const favorites = useQuery({ queryKey: ["favorites"], queryFn: extrasApi.favorites, refetchInterval: 30000, refetchIntervalInBackground: false });
  const shown = [...(docs.data ?? [])].sort((a, b) => a.id - b.id);

  if (route.page === "drive") return <DriveSidebar route={route} userId={me.user.id} searchOpen={searchOpen} onSearch={() => setSearchOpen(true)} onCloseSearch={() => setSearchOpen(false)} />;

  return (
    <aside className="flex h-full w-[268px] max-w-[85vw] shrink-0 flex-col border-r bg-sidebar">
      <div className="relative px-3 pt-4">
        <div className="flex h-8 items-center px-2"><Logo className="gap-1.5" markClassName="size-6" wordmarkClassName="h-[14px]" /><span className="ml-1.5 text-[14px] font-semibold tracking-[-0.01em]">云文档</span></div>
        <label className="mt-3 flex h-9 items-center gap-2 rounded-md border border-transparent bg-white/70 px-2.5 text-[13px] text-subtle transition-colors focus-within:border-primary/50 focus-within:bg-surface dark:bg-white/5">
          <SearchIcon />
          <input ref={searchTrigger} type="search" readOnly aria-label="搜索标题和正文" onFocus={() => {
            if (skipSearchFocus.current) { skipSearchFocus.current = false; return; }
            setSearchOpen(true);
          }} onClick={() => setSearchOpen(true)} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSearchOpen(true); }
          }} placeholder="搜索标题和正文" className="w-full min-w-0 cursor-pointer bg-transparent text-[16px] text-foreground outline-none placeholder:text-subtle sm:text-[13px]" data-search />
          <kbd className="hidden shrink-0 font-sans text-[11px] text-[#b3b8bf] sm:inline">{typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} + J</kbd>
        </label>
      </div>
      <nav className="mt-4 space-y-1 px-3">
        <NavItem icon={<HomeIcon />} label="主页" active={route.page === "home"} onClick={() => go("#/")} />
        <NavItem icon={<FolderIcon size={16} strokeWidth={1.7} />} label="云盘" active={false} onClick={() => go("#/drive/mine")} />
        <NavItem icon={<ClockIcon />} label="最近访问" active={route.page === "recent"} onClick={() => go("#/recent")} />
        <NavItem icon={<StarIcon />} label="收藏" active={route.page === "favorites"} onClick={() => go("#/favorites")} />
        <NavItem icon={<TrashIcon />} label="回收站" active={route.page === "trash"} onClick={() => go("#/trash")} />
      </nav>
      <div className="mt-6 px-3">
        <div className="px-2 pb-1 text-xs font-medium text-subtle">收藏文档</div>
        {(favorites.data ?? []).slice(0, 4).map((d) => <NavItem key={d.id} icon={d.kind === "base" ? <BaseIcon /> : <DocumentGlyph icon={d.icon} fallback={<DocIcon />} />} label={docTitle(d)} active={activeId === d.id} onClick={() => go(hrefOf(d))} />)}
        {favorites.data?.length === 0 && <p className="px-2 py-1.5 text-xs text-subtle">暂无收藏</p>}
      </div>
      <div className="group mt-5 flex items-center justify-between px-5 text-xs font-medium text-subtle">
        <span>我的文档库</span>
        <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <button aria-label="新建多维表格" title="新建多维表格" onClick={() => createBase.mutate()} disabled={createBase.isPending} className="grid size-6 place-items-center rounded hover:bg-hover hover:text-foreground disabled:opacity-50" data-new-base>
            <Table2 size={14} strokeWidth={1.7} />
          </button>
          <button aria-label="新建文档" title="新建文档" onClick={() => create.mutate(null)} disabled={create.isPending} className="grid size-6 place-items-center rounded hover:bg-hover hover:text-foreground disabled:opacity-50" data-new-doc>
            <FilePlus size={14} strokeWidth={1.7} />
          </button>
        </span>
      </div>
      <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-2">
        {(create.isError || createBase.isError) && <p role="alert" className="px-2 py-1.5 text-xs text-destructive">新建失败，请稍后重试</p>}
        {rename.isError && <div role="alert" className="px-2 py-1.5 text-xs text-destructive">
          <p>{renameErrorMessage(rename.error)}</p>
          {rename.error instanceof ApiError && rename.error.status === 409 && rename.variables && <label className="mt-2 block text-muted-foreground">你输入的名称（可复制）
            <input readOnly value={rename.variables.title} className="mt-1 block h-8 w-full rounded border bg-surface px-2 text-foreground" />
          </label>}
        </div>}
        {renderTree(null, 0)}
        {docs.isError && <p role="alert" className="px-2 py-1.5 text-xs text-destructive">文档加载失败，请稍后重试</p>}
        {docs.data && shown.length === 0 && <p className="px-2 py-1.5 text-xs text-subtle">还没有文档</p>}
        {(shared.data?.length ?? 0) > 0 && (
          <>
            <div className="px-2 pb-1 pt-4 text-xs text-subtle">与我共享</div>
            {shared.data!.map((d) => (
              <NavItem key={d.id} icon={d.kind === "base" ? <BaseIcon /> : <DocumentGlyph icon={d.icon} fallback={<DocIcon />} />} label={docTitle(d)} active={activeId === d.id} onClick={() => go(hrefOf(d))} />
            ))}
          </>
        )}
      </div>
      <div ref={accountMenu} className="relative border-t px-3 py-2">
        {menu && <div className="absolute bottom-14 left-3 right-3 z-20 rounded-lg border bg-surface p-1 shadow-lg">
          <div className="px-3 py-2 text-xs text-subtle">{me.user.email}</div>
          {me.workspaces.map((w) => <div key={w.id} className="flex items-center justify-between rounded-md bg-accent px-3 py-1.5 text-[13px] text-accent-foreground">{w.name} <span>✓</span></div>)}
          <button className="mt-1 w-full rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-hover" onClick={onLogout}>退出登录</button>
        </div>}
        <div className="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-hover">
          <button onClick={() => setMenu((v) => !v)} aria-label="账号与空间" aria-expanded={menu} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <Avatar name={me.user.name} color={colorFor(me.user.id - 1)} size={24} />
            <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{me.user.name}</span><span className="block truncate text-[11px] text-subtle">{ws?.name ?? "我的空间"}</span></span>
            <Chevron className="text-subtle" />
          </button>
          <DarkToggle />
          <button className="rounded p-1 text-subtle hover:bg-black/5 hover:text-foreground" title="退出登录" onClick={onLogout} data-logout>
            <LogOut size={14} strokeWidth={1.7} />
          </button>
        </div>
      </div>
      {searchOpen && <GlobalSearch userId={me.user.id} onClose={closeSearch} />}
    </aside>
  );
}

function DriveSidebar({ route, userId, searchOpen, onSearch, onCloseSearch }: { route: Extract<Route, { page: "drive" }>; userId: number; searchOpen: boolean; onSearch: () => void; onCloseSearch: () => void }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState({ personal: true, shared: true });
  const [error, setError] = useState("");
  const mine = useQuery({ queryKey: ["drive-nav", "personal", userId], queryFn: () => driveApi.children(null, true), refetchInterval: 15000, refetchIntervalInBackground: false });
  const shared = useQuery({ queryKey: ["drive-nav", "shared", userId], queryFn: () => driveApi.children(null, false), refetchInterval: 15000, refetchIntervalInBackground: false });
  const addFolder = async (personal: boolean) => {
    const title = await askText("新建文件夹", "文件夹名称");
    if (!title?.trim()) return;
    setError("");
    try {
      const folder = await driveApi.create(title.trim(), null, personal);
      await Promise.all([qc.invalidateQueries({ queryKey: ["drive-nav"] }), qc.invalidateQueries({ queryKey: ["drive"] })]);
      go(`#/drive/${folder.id}`);
    } catch { setError("新建结果未能确认，请刷新后检查。"); }
  };
  const group = (personal: boolean) => {
    const query = personal ? mine : shared;
    const key = personal ? "personal" : "shared";
    const rootActive = route.folderId === null && route.personal === personal;
    return <div className="mb-3" key={key}>
      <div className={cn("flex h-9 items-center rounded-md px-1 text-[13px]", rootActive ? "bg-[#dce6ff] text-[#1456f0]" : "text-[#4e5969] hover:bg-[#e9eaec]")}>
        <button type="button" aria-label={`${expanded[key] ? "收起" : "展开"}${personal ? "我的文件夹" : "共享文件夹"}`} onClick={() => setExpanded((value) => ({ ...value, [key]: !value[key] }))} className="grid size-6 place-items-center">{expanded[key] ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>
        {personal ? <FolderIcon size={15}/> : <Users size={15}/>}<button type="button" onClick={() => go(personal ? "#/drive/mine" : "#/drive")} className="min-w-0 flex-1 truncate px-2 text-left">{personal ? "我的文件夹" : "共享文件夹"}</button>
      </div>
      {expanded[key] && <div className="space-y-0.5 pl-6">
        {!query.isError && (query.data ?? []).filter((item) => item.kind === "folder").map((folder) => <button key={folder.id} type="button" onClick={() => go(`#/drive/${folder.id}`)} className={cn("flex h-8 w-full items-center gap-2 truncate rounded-md px-2 text-left text-[13px]", route.folderId === folder.id ? "bg-[#dce6ff] text-[#1456f0]" : "text-[#4e5969] hover:bg-[#e9eaec]")}><FolderIcon size={14}/><span className="truncate">{folder.title || "未命名文件夹"}</span></button>)}
        <button type="button" onClick={() => void addFolder(personal)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-[#8f959e] hover:bg-[#e9eaec] hover:text-[#4e5969]"><Plus size={14}/>新建文件夹</button>
      </div>}
    </div>;
  };
  return <aside className="flex h-full w-[268px] max-w-[85vw] shrink-0 flex-col border-r border-[#dee0e3] bg-[#f5f6f7] xl:w-[300px]">
    <div className="flex h-14 items-center px-5"><Logo appearance="light" className="gap-1.5" markClassName="size-6" wordmarkClassName="h-[14px]"/><span className="ml-1.5 text-[14px] font-semibold">云文档</span></div>
    <div className="flex h-14 items-center gap-2 px-4"><button type="button" aria-label="返回主页" onClick={() => go("#/")} className="grid size-7 place-items-center rounded-md text-[#646a73] hover:bg-[#e9eaec]"><ArrowLeft size={16}/></button><span className="grid size-8 place-items-center rounded-md bg-white text-[#3370ff] shadow-sm"><FolderIcon size={18}/></span><span className="text-[14px] font-semibold">云盘</span></div>
    <button type="button" onClick={onSearch} data-search className="mx-3 mb-3 flex h-9 items-center gap-2 rounded-md bg-white/80 px-3 text-left text-[13px] text-[#8f959e]"><SearchIcon/>搜索<span className="ml-auto text-[11px] text-[#b3b8bf]">{typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} + J</span></button>
    <nav className="min-h-0 flex-1 overflow-y-auto px-2">{group(true)}{group(false)}{error && <p role="alert" className="px-2 text-xs text-destructive">{error}</p>}</nav>
    {searchOpen && <GlobalSearch userId={userId} onClose={onCloseSearch}/>}
  </aside>;
}

function TreeRow({
  depth,
  label,
  muted,
  active,
  expandable,
  open,
  onToggle,
  onClick,
  onAdd,
  base,
  icon,
  starred,
  onStar,
  onRename,
  onCopyLink,
  onDelete,
}: {
  base?: boolean;
  icon?: string;
  depth: number;
  label: string;
  muted: boolean;
  active: boolean;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
  onClick: () => void;
  onAdd: () => void;
  starred?: boolean;
  onStar?: () => void;
  onRename?: () => void;
  onCopyLink?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      data-tree-depth={depth}
      className={cn(
        "group relative flex h-9 w-full items-center rounded-md pr-1 text-[13px] transition-colors",
        active ? "bg-accent font-medium text-accent-foreground" : "text-foreground hover:bg-hover",
        muted && !active && "text-muted-foreground",
      )}
      style={{ paddingLeft: 4 + depth * 16 }}
      data-guides={depth}
    >
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="pointer-events-none absolute bottom-0 top-0 w-px bg-[#e8eaed]"
          style={{ left: 12 + i * 16 }}
        />
      ))}
      <div className="relative flex min-w-0 flex-1 items-center">
      {expandable ? (
        <button
          onClick={onToggle}
          className="grid size-5 shrink-0 place-items-center rounded text-subtle hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={`${open ? "收起" : "展开"} ${label}`}
          aria-expanded={open}
        >
          <ChevronRight size={12} strokeWidth={1.7} className={cn("transition-transform", open && "rotate-90")} />
        </button>
      ) : <span aria-hidden className="size-5 shrink-0" />}
      <button
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        title={label}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {base ? <span aria-hidden className="grid size-[18px] shrink-0 place-items-center rounded-[4px] bg-[#7159d8] text-white"><BaseIcon size={12} /></span> : <DocumentGlyph icon={icon} fallback={<DocColorIcon className="size-[18px] shrink-0" />} />}
        <span className="min-w-0 truncate">{label}</span>
      </button>
      <span className="ml-1 hidden items-center gap-0.5 group-hover:flex group-focus-within:flex [@media(hover:none)]:flex">
        <button
          aria-label="新建子文档"
          title="新建子文档"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          className="grid size-5 shrink-0 place-items-center rounded text-subtle hover:bg-black/5 hover:text-foreground"
        >
          +
        </button>
        {onStar && (
          <button
            aria-label={starred ? "取消收藏" : "收藏"}
            title={starred ? "取消收藏" : "收藏"}
            onClick={(e) => {
              e.stopPropagation();
              onStar();
            }}
            className={cn("grid size-5 shrink-0 place-items-center rounded text-subtle hover:bg-black/5 hover:text-foreground", starred && "text-amber-500")}
            data-star
          >
            {starred ? "★" : "☆"}
          </button>
        )}
        <RowMenu onRename={onRename} onCopyLink={onCopyLink} onDelete={onDelete} onAdd={onAdd} />
      </span>
      </div>
    </div>
  );
}

function NavItem({ icon, label, active, muted, onClick }: { icon: React.ReactNode; label: string; active?: boolean; muted?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[14px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
        active ? "bg-accent font-medium text-accent-foreground" : "text-foreground hover:bg-hover",
        muted && !active && "text-muted-foreground",
      )}
    >
      <span className={cn("shrink-0", active ? "text-primary" : "text-muted-foreground")}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

const svg = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;
export const DocIcon = (props: React.ComponentProps<typeof FileText>) => <FileText size={16} strokeWidth={1.7} {...props} />;
const HomeIcon = (props: React.SVGProps<SVGSVGElement>) => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}><path d="m20 10-8-5.939L4 10v10h5v-3.8a2.2 2.2 0 0 1 2.2-2.2h1.6a2.2 2.2 0 0 1 2.2 2.2V20h5zm-9 11a1 1 0 0 1-1 1H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .75-1.562l8-5.938a2 2 0 0 1 2.5 0l8 5.938A2 2 0 0 1 22 10v10a2 2 0 0 1-2 2h-6a1 1 0 0 1-1-1v-4.8a.2.2 0 0 0-.2-.2h-1.6a.2.2 0 0 0-.2.2z" /></svg>;
const ClockIcon = (props: React.ComponentProps<typeof Clock3>) => <Clock3 size={16} strokeWidth={1.7} {...props} />;
const StarIcon = (props: React.ComponentProps<typeof Star>) => <Star size={16} strokeWidth={1.7} {...props} />;
const TrashIcon = (props: React.ComponentProps<typeof Trash2>) => <Trash2 size={16} strokeWidth={1.7} {...props} />;
const SearchIcon = (props: React.SVGProps<SVGSVGElement>) => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}><path d="M16.473 17.887A9.46 9.46 0 0 1 10.5 20a9.5 9.5 0 1 1 9.5-9.5 9.46 9.46 0 0 1-2.113 5.973l3.773 3.773a.996.996 0 0 1-.007 1.407.996.996 0 0 1-1.407.007l-3.773-3.773ZM18 10.5a7.5 7.5 0 1 0-15 0 7.5 7.5 0 0 0 15 0Z" /></svg>;
export const Chevron = ({ className }: { className?: string }) => <ChevronDown size={12} strokeWidth={1.7} className={className} />;

export const BaseIcon = (props: React.ComponentProps<typeof Table2>) => <Table2 size={16} strokeWidth={1.7} {...props} />;

/** ⋯ hover menu for tree rows: add child / rename / copy link / delete. */
function RowMenu({ onAdd, onRename, onCopyLink, onDelete }: { onAdd?: () => void; onRename?: () => void; onCopyLink?: () => void; onDelete?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative">
      <button
        aria-label="更多操作"
        aria-expanded={open}
        title="更多"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="grid size-5 shrink-0 place-items-center rounded text-subtle hover:bg-black/5 hover:text-foreground"
        data-row-menu
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-30 w-32 rounded-lg border bg-surface py-1 text-[13px] shadow-lg" data-row-menu-pop>
          {onAdd && <button className="block w-full px-3 py-1.5 text-left hover:bg-hover" onClick={(e) => { e.stopPropagation(); setOpen(false); onAdd(); }}>新建子文档</button>}
          {onRename && <button className="block w-full px-3 py-1.5 text-left hover:bg-hover" onClick={(e) => { e.stopPropagation(); setOpen(false); onRename(); }}>重命名</button>}
          {onCopyLink && <button className="block w-full px-3 py-1.5 text-left hover:bg-hover" onClick={(e) => { e.stopPropagation(); setOpen(false); onCopyLink(); }}>复制链接</button>}
          {onDelete && <button className="block w-full px-3 py-1.5 text-left text-destructive hover:bg-hover" onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(); }}>删除</button>}
        </div>
      )}
    </span>
  );
}

/** 暗色模式开关（持久化到 localStorage，切 <html>.dark）。 */
export function DarkToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem("jiange:dark") === "1");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("jiange:dark", dark ? "1" : "0");
  }, [dark]);
  return (
    <button
      className="grid size-5 place-items-center rounded text-subtle hover:bg-black/10 hover:text-foreground dark:hover:bg-white/10"
      title={dark ? "切换到浅色" : "切换到深色"}
      aria-label={dark ? "切换到浅色" : "切换到深色"}
      onClick={() => setDark((v) => !v)}
      data-dark-toggle
    >
      {dark ? <Moon size={13} strokeWidth={1.7} /> : <Sun size={13} strokeWidth={1.7} />}
    </button>
  );
}

import { ArrowLeft, ChevronDown, ChevronRight, Clock3, FilePlus, FileText, FolderIcon, LogOut, Moon, Plus, Star, Sun, Table2, Trash2, Users } from "lucide-react";

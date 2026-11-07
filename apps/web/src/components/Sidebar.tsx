import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, baseApi, docsApi, extrasApi, type DocMeta, type Me } from "@/lib/api";
import { go, type Route } from "@/lib/route";
import { cn } from "@/lib/utils";
import { ask, askText } from "@/components/ui/ask";
import { Logo } from "./brand";
import { Avatar } from "./brand";
import { colorFor } from "@/lib/presence";
import { DocColorIcon } from "./FeishuIcons";

export const hrefOf = (d: Pick<DocMeta, "id" | "kind">) => (d.kind === "base" ? `#/base/${d.id}` : `#/doc/${d.id}`);
export const docTitle = (d: Pick<DocMeta, "title">) => d.title.trim() || "未命名文档";

export function renameErrorMessage(error: unknown): string {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) return "无法重命名：文档不存在或当前没有编辑权限。";
  if (error instanceof ApiError && error.status === 400) return "名称无效，请检查名称长度后重试。";
  if (error instanceof ApiError && error.code === "upgrade_required") return "当前版本无法安全重命名，请刷新页面后重试。";
  if (error instanceof ApiError && error.status === 409) return "文档已发生变化，请刷新后重新命名。";
  // A disconnected client cannot know whether the server committed the write.
  return "无法确认重命名是否完成，请刷新后查看。";
}

type SearchResultState<T> = { status: "idle" | "loading" | "error" | "empty"; docs: T[] } | { status: "ready"; docs: T[] };

// Cached results are not authorization evidence: hide them until this request succeeds.
export function sidebarSearchState<T>(keyword: string, debounced: string, query: {
  isFetching: boolean; isPending: boolean; isError: boolean; data?: T[]; fetchStatus: string;
}): SearchResultState<T> {
  if (!keyword) return { status: "idle", docs: [] };
  if (keyword !== debounced || query.isFetching) return { status: "loading", docs: [] };
  if (query.isError || query.fetchStatus === "paused") return { status: "error", docs: [] };
  if (query.isPending) return { status: "loading", docs: [] };
  return query.data?.length ? { status: "ready", docs: query.data } : { status: "empty", docs: [] };
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
  const [q, setQ] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const kw = q.trim();
  useEffect(() => {
    if (!kw) {
      setDebouncedSearch("");
      return;
    }
    const timer = window.setTimeout(() => setDebouncedSearch(kw), 250);
    return () => window.clearTimeout(timer);
  }, [kw]);
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
  const activeId = route.page === "doc" || route.page === "base" ? route.id : null;
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
            muted={!d.title.trim()}
            active={activeId === d.id}
            expandable={has}
            open={isOpen}
            starred={favorites.data?.some((f) => f.id === d.id)}
            onToggle={() => setOpen((o) => ({ ...o, [d.id]: !isOpen }))}
            onClick={() => go(hrefOf(d))}
            onAdd={() => create.mutate({ id: d.id, workspaceId: d.workspaceId })}
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
              if (await ask(`删除「${docTitle(d)}」？`, "可在回收站还原。")) docsApi.trash(d.id).then(() => qc.invalidateQueries({ queryKey: ["docs"] }));
            }}
          />
          {has && isOpen && renderTree(d.id, depth + 1)}
        </div>
      );
    });
  const searchQ = useQuery({
    queryKey: ["search", me.user.id, debouncedSearch],
    queryFn: ({ signal }) => extrasApi.search(debouncedSearch, signal),
    enabled: !!kw && kw === debouncedSearch,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: "always",
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
  });
  const searchState = sidebarSearchState(kw, debouncedSearch, searchQ);
  const favorites = useQuery({ queryKey: ["favorites"], queryFn: extrasApi.favorites });
  const shown = kw ? searchState.docs : [...(docs.data ?? [])].sort((a, b) => a.id - b.id);

  return (
    <aside className="flex h-full w-[277px] max-w-[85vw] shrink-0 flex-col border-r bg-sidebar">
      <div className="relative px-3 pt-4">
        <div className="flex h-8 items-center px-2"><Logo withText={false} className="[&>span]:size-6 [&>span]:text-[13px]" /><span className="ml-2 text-[14px] font-semibold tracking-[-0.01em]">Jiange 云文档</span></div>
        <label className="mt-3 flex h-9 items-center gap-2 rounded-md border border-transparent bg-white/70 px-2.5 text-[13px] text-subtle transition-colors focus-within:border-primary/50 focus-within:bg-surface dark:bg-white/5">
          <SearchIcon />
          <input type="search" aria-label="搜索标题和正文" value={q} onChange={(e) => {
            const next = e.target.value;
            if (next.trim() !== kw) void qc.cancelQueries({ queryKey: ["search", me.user.id] });
            setQ(next);
          }} placeholder="搜索标题和正文" className="w-full min-w-0 bg-transparent text-[16px] text-foreground outline-none placeholder:text-subtle sm:text-[13px]" data-search />
        </label>
      </div>
      <nav className="mt-4 space-y-1 px-3">
        <NavItem icon={<HomeIcon />} label="主页" active={route.page === "home"} onClick={() => go("#/")} />
        <NavItem icon={<ClockIcon />} label="最近访问" active={route.page === "recent"} onClick={() => go("#/recent")} />
        <NavItem icon={<StarIcon />} label="收藏" active={route.page === "favorites"} onClick={() => go("#/favorites")} />
        <NavItem icon={<TrashIcon />} label="回收站" active={route.page === "trash"} onClick={() => go("#/trash")} />
      </nav>
      {!kw && <div className="mt-6 px-3">
        <div className="px-2 pb-1 text-xs font-medium text-subtle">收藏文档</div>
        {(favorites.data ?? []).slice(0, 4).map((d) => <NavItem key={d.id} icon={d.kind === "base" ? <BaseIcon /> : <DocIcon />} label={docTitle(d)} active={activeId === d.id} onClick={() => go(hrefOf(d))} />)}
        {favorites.data?.length === 0 && <p className="px-2 py-1.5 text-xs text-subtle">暂无收藏</p>}
      </div>}
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
        {kw && <p className="px-2 py-1.5 text-xs text-subtle">搜索有权访问的文档</p>}
        {kw
          ? (searchState.status === "loading" && <p role="status" className="px-2 py-1.5 text-xs text-subtle">搜索中…</p>)
          : renderTree(null, 0)}
        {kw && shown.map((d) => <NavItem key={d.id} icon={d.kind === "base" ? <BaseIcon /> : <DocIcon />} label={docTitle(d)} muted={!d.title.trim()} active={activeId === d.id} onClick={() => go(hrefOf(d))} />)}
        {searchState.status === "error" && <div role="alert" className="px-2 py-1.5 text-xs text-destructive">{searchQ.error instanceof ApiError && searchQ.error.code === "search_incomplete" ? "搜索未完成，请稍后重试" : "搜索失败，请检查网络后重试"} <button type="button" onClick={() => void searchQ.refetch()} className="ml-1 text-primary underline">重试</button></div>}
        {searchState.status === "empty" && <p className="px-2 py-1.5 text-xs text-subtle">没有匹配的文档</p>}
        {!kw.trim() && docs.isError && <p role="alert" className="px-2 py-1.5 text-xs text-destructive">文档加载失败，请稍后重试</p>}
        {!kw.trim() && docs.data && shown.length === 0 && <p className="px-2 py-1.5 text-xs text-subtle">还没有文档</p>}
        {!q.trim() && (shared.data?.length ?? 0) > 0 && (
          <>
            <div className="px-2 pb-1 pt-4 text-xs text-subtle">与我共享</div>
            {shared.data!.map((d) => (
              <NavItem key={d.id} icon={d.kind === "base" ? <BaseIcon /> : <DocIcon />} label={docTitle(d)} active={activeId === d.id} onClick={() => go(hrefOf(d))} />
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
    </aside>
  );
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
  starred,
  onStar,
  onRename,
  onCopyLink,
  onDelete,
}: {
  base?: boolean;
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
        {base ? <span aria-hidden className="grid size-[18px] shrink-0 place-items-center rounded-[4px] bg-[#7159d8] text-white"><BaseIcon size={12} /></span> : <DocColorIcon className="size-[18px] shrink-0" />}
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

import { ChevronDown, ChevronRight, Clock3, FilePlus, FileText, LogOut, Moon, Star, Sun, Table2, Trash2 } from "lucide-react";

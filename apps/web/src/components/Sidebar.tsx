import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { baseApi, docsApi, extrasApi, type DocMeta, type Me } from "@/lib/api";
import { NotificationBell } from "@/pages/NotificationBell";
import { go, type Route } from "@/lib/route";
import { cn } from "@/lib/utils";
import { Logo } from "./brand";

export const hrefOf = (d: Pick<DocMeta, "id" | "kind">) => (d.kind === "base" ? `#/base/${d.id}` : `#/doc/${d.id}`);
export const docTitle = (d: Pick<DocMeta, "title">) => d.title.trim() || "未命名文档";

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
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const create = useMutation({
    mutationFn: (parentId: number | null = null) => docsApi.create("", parentId),
    onSuccess: (d) => {
      if (d.parentId) setOpen((o) => ({ ...o, [d.parentId!]: true }));
      qc.invalidateQueries({ queryKey: ["docs"] });
      go(`#/doc/${d.id}`);
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
            onAdd={() => create.mutate(d.id)}
            onStar={() => {
              const starred = favorites.data?.some((f) => f.id === d.id);
              (starred ? extrasApi.unstar(d.id) : extrasApi.star(d.id)).then(() => {
                favorites.refetch();
                qc.invalidateQueries({ queryKey: ["favorites"] });
              });
            }}
            onRename={() => {
              const t = prompt("重命名", docTitle(d));
              if (t && t.trim()) docsApi.rename(d.id, t.trim()).then(() => {
                qc.invalidateQueries({ queryKey: ["docs"] });
                qc.invalidateQueries({ queryKey: ["search", kw] });
              });
            }}
            onCopyLink={() => {
              navigator.clipboard?.writeText(`${location.origin}${location.pathname}${hrefOf(d)}`).catch(() => {});
            }}
            onDelete={() => {
              if (confirm(`删除「${docTitle(d)}」？可在回收站还原。`)) docsApi.trash(d.id).then(() => qc.invalidateQueries({ queryKey: ["docs"] }));
            }}
          />
          {has && isOpen && renderTree(d.id, depth + 1)}
        </div>
      );
    });
  // server-side search (title + collaborative text) while typing
  const kw = q.trim();
  const searchQ = useQuery({ queryKey: ["search", kw], queryFn: () => extrasApi.search(kw), enabled: kw.length > 0 });
  const favorites = useQuery({ queryKey: ["favorites"], queryFn: extrasApi.favorites });
  const shown = kw ? (searchQ.data ?? []) : [...(docs.data ?? [])].sort((a, b) => a.id - b.id);

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r bg-sidebar">
      <div className="relative px-3 pt-3">
        <button onClick={() => setMenu((v) => !v)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover">
          <Logo withText={false} className="[&>span]:size-6 [&>span]:text-[13px]" />
          <span className="truncate text-[14px] font-semibold">{ws?.name ?? "我的空间"}</span>
          <Chevron className="ml-0.5 text-subtle" />
        </button>
        {menu && (
          <div className="absolute left-3 right-3 top-12 z-20 rounded-lg border bg-white p-1 shadow-lg" onMouseLeave={() => setMenu(false)}>
            <div className="px-3 py-2 text-xs text-subtle">{me.user.email}</div>
            {me.workspaces.map((w) => (
              <div key={w.id} className="flex items-center justify-between rounded-md bg-accent px-3 py-1.5 text-[13px] text-accent-foreground">
                {w.name} <span>✓</span>
              </div>
            ))}
            <button className="mt-1 w-full rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-hover" onClick={onLogout}>
              退出登录
            </button>
          </div>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border bg-white px-2.5 text-[13px] text-subtle focus-within:border-primary">
            <SearchIcon />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题和正文" className="w-full min-w-0 bg-transparent text-foreground outline-none placeholder:text-subtle" data-search />
          </label>
          <NotificationBell onOpenDoc={(id) => go(`#/doc/${id}`)} />
        </div>
      </div>
      <nav className="mt-3 space-y-0.5 px-3">
        <NavItem icon={<HomeIcon />} label="主页" active={route.page === "home"} onClick={() => go("#/")} />
        <NavItem icon={<ClockIcon />} label="最近访问" active={route.page === "recent"} onClick={() => go("#/recent")} />
        <NavItem icon={<StarIcon />} label="收藏" active={route.page === "favorites"} onClick={() => go("#/favorites")} />
        <NavItem icon={<TrashIcon />} label="回收站" active={route.page === "trash"} onClick={() => go("#/trash")} />
      </nav>
      <div className="mt-5 flex items-center justify-between px-5 text-xs text-subtle">
        <span>文档</span>
        <button title="新建文档" onClick={() => create.mutate(null)} className="grid size-5 place-items-center rounded hover:bg-hover hover:text-foreground">
          +
        </button>
      </div>
      <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-2">
        {kw.trim()
          ? (searchQ.isFetching && <p className="px-2 py-1.5 text-xs text-subtle">搜索中…</p>)
          : renderTree(null, 0)}
        {kw.trim() && shown.map((d) => <NavItem key={d.id} icon={d.kind === "base" ? <BaseIcon /> : <DocIcon />} label={docTitle(d)} muted={!d.title.trim()} active={activeId === d.id} onClick={() => go(hrefOf(d))} />)}
        {kw.trim() && !searchQ.isFetching && shown.length === 0 && <p className="px-2 py-1.5 text-xs text-subtle">没有匹配的文档</p>}
        {!kw.trim() && docs.data && shown.length === 0 && <p className="px-2 py-1.5 text-xs text-subtle">还没有文档</p>}
        {!q.trim() && (shared.data?.length ?? 0) > 0 && (
          <>
            <div className="px-2 pb-1 pt-4 text-xs text-subtle">与我共享</div>
            {shared.data!.map((d) => (
              <NavItem key={d.id} icon={<DocIcon />} label={docTitle(d)} active={activeId === d.id} onClick={() => go(hrefOf(d))} />
            ))}
          </>
        )}
      </div>
      <div className="border-t px-3 py-2.5">
        <button onClick={() => create.mutate(null)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground">
          <span className="text-base leading-none">+</span> 新建文档
        </button>
        <button
          onClick={async () => {
            const b = await baseApi.create();
            qc.invalidateQueries({ queryKey: ["docs"] });
            go(`#/base/${b.id}`);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <span className="text-base leading-none">+</span> 新建多维表格
        </button>
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
      onClick={onClick}
      data-tree-depth={depth}
      className={cn(
        "group flex h-8 w-full cursor-pointer items-center gap-1 rounded-md pr-1 text-[14px] transition-colors",
        active ? "bg-accent font-medium text-accent-foreground" : "text-foreground hover:bg-hover",
        muted && !active && "text-muted-foreground",
      )}
      style={{ paddingLeft: 4 + depth * 16 }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={cn("grid size-5 shrink-0 place-items-center rounded text-[10px] text-subtle hover:bg-black/5", !expandable && "invisible")}
        aria-label={open ? "收起" : "展开"}
      >
        <span className={cn("transition-transform", open && "rotate-90")}>▶</span>
      </button>
      <span className={cn("shrink-0", active ? "text-primary" : "text-muted-foreground")}>
        {base ? <BaseIcon /> : <DocIcon />}
      </span>
      <span className="ml-1 truncate">{label}</span>
      <span className="ml-auto hidden items-center gap-0.5 group-hover:flex">
        <button
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
  );
}

function NavItem({ icon, label, active, muted, onClick }: { icon: React.ReactNode; label: string; active?: boolean; muted?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[14px] transition-colors",
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
export const DocIcon = () => (
  <svg {...svg}>
    <path d="M4 1.75h5.5L12.5 4.8v9.45H4z" />
    <path d="M6 7.5h4.5M6 10h4.5" />
  </svg>
);
const HomeIcon = () => (
  <svg {...svg}>
    <path d="M2.5 7 8 2.5 13.5 7v6.5h-11z" />
    <path d="M6.5 13.5v-4h3v4" />
  </svg>
);
const ClockIcon = () => (
  <svg {...svg}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3.2l2 1.3" />
  </svg>
);
const StarIcon = () => (
  <svg {...svg}>
    <path d="m8 2.3 1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11l-3.4 1.8.7-3.8L2.5 6.3l3.8-.5z" />
  </svg>
);
const TrashIcon = () => (
  <svg {...svg}>
    <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9" />
  </svg>
);
const SearchIcon = () => (
  <svg {...svg} width={14} height={14}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </svg>
);
export const Chevron = ({ className }: { className?: string }) => (
  <svg {...svg} width={12} height={12} className={className}>
    <path d="m4 6 4 4 4-4" />
  </svg>
);

export const BaseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M2.5 6.2h11M2.5 9.8h11M6.5 6.2v7.3" />
  </svg>
);

/** ⋯ hover menu for tree rows: add child / rename / copy link / delete. */
function RowMenu({ onAdd, onRename, onCopyLink, onDelete }: { onAdd?: () => void; onRename?: () => void; onCopyLink?: () => void; onDelete?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <span ref={ref} className="relative">
      <button
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
        <div className="absolute left-0 top-6 z-30 w-28 rounded-lg border bg-white py-1 text-[13px] shadow-lg" data-row-menu-pop>
          {onAdd && <button className="block w-full px-3 py-1.5 text-left hover:bg-hover" onClick={(e) => { e.stopPropagation(); setOpen(false); onAdd(); }}>新建子文档</button>}
          {onRename && <button className="block w-full px-3 py-1.5 text-left hover:bg-hover" onClick={(e) => { e.stopPropagation(); setOpen(false); onRename(); }}>重命名</button>}
          {onCopyLink && <button className="block w-full px-3 py-1.5 text-left hover:bg-hover" onClick={(e) => { e.stopPropagation(); setOpen(false); onCopyLink(); }}>复制链接</button>}
          {onDelete && <button className="block w-full px-3 py-1.5 text-left text-destructive hover:bg-hover" onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(); }}>删除</button>}
        </div>
      )}
    </span>
  );
}

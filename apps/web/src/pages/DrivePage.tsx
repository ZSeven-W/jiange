import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { driveApi, extrasApi, type DriveEntry } from "@/lib/api";
import { BaseIcon, DocIcon, hrefOf } from "@/components/Sidebar";
import { ask, askText } from "@/components/ui/ask";
import { cn } from "@/lib/utils";
import { ArrowUpDownIcon, FolderIcon, FolderPlusIcon, LayoutGridIcon, ListIcon, PencilIcon, PlusIcon, RotateCcwIcon, SearchIcon, StarIcon, TableIcon, Trash2Icon } from "lucide-react";

type DriveSort = "name" | "updated";

/** 云盘：目录列表 + 真实面包屑 + 我的空间/共享空间 + 新建/重命名/排序/移动/回收恢复。 */
export function DrivePage({ folderId, personalRoot }: { folderId: number | null; personalRoot: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["drive", folderId, personalRoot],
    queryFn: () => driveApi.children(folderId, personalRoot),
  });
  // 父链面包屑（root→当前目录），folder 页可用
  const crumbs = useQuery({
    queryKey: ["drive-ancestors", folderId],
    queryFn: () => driveApi.ancestors(folderId!),
    enabled: folderId !== null,
  });
  const favorites = useQuery({ queryKey: ["favorites"], queryFn: extrasApi.favorites });
  // 顶层空间由路由决定；目录内空间由其条目继承（子节点跟随父目录）
  const scope = folderId === null ? personalRoot : (list.data?.[0]?.personal ?? false);
  const [sort, setSort] = useState<DriveSort>("name");
  const [grid, setGrid] = useState(false);
  const [filter, setFilter] = useState("");
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["drive"] });
    qc.invalidateQueries({ queryKey: ["drive-ancestors"] });
  };
  const [moving, setMoving] = useState<DriveEntry | null>(null);
  const [creating, setCreating] = useState(false);

  const rename = useMutation({
    mutationFn: ({ id, title, expected }: { id: number; title: string; expected: number }) => driveApi.rename(id, title, expected),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["docs"] });
    },
  });

  const createFolder = useMutation({
    mutationFn: async (title: string) => driveApi.create(title, folderId, scope),
    onSuccess: invalidate,
  });
  const createNode = useMutation({
    mutationFn: async ({ kind, title }: { kind: "doc" | "base"; title: string }) => driveApi.createNode(kind, title, folderId, scope),
    onSuccess: (entry) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["docs"] });
      location.hash = hrefOf({ id: entry.id, kind: entry.kind as "doc" | "base" });
    },
  });
  const trash = useMutation({
    mutationFn: (e: DriveEntry) => driveApi.trash(e.id, e.revision),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["docs"] });
      qc.invalidateQueries({ queryKey: ["trash"] });
    },
  });
  const restore = useMutation({
    mutationFn: (e: DriveEntry) => driveApi.restore(e.id, e.revision + 1),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["docs"] });
      qc.invalidateQueries({ queryKey: ["trash"] });
    },
  });

  const entries = useMemo(() => {
    const es = [...(list.data ?? [])];
    es.sort((a, b) => {
      if (a.kind === "folder" !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1; // 文件夹在前
      if (sort === "updated") return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      return (a.title || "未命名").localeCompare(b.title || "未命名", "zh-CN");
    });
    return es;
  }, [list.data, sort]);
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => (e.title || "未命名").toLowerCase().includes(q));
  }, [entries, filter]);
  const folders = visible.filter((e) => e.kind === "folder");
  const files = visible.filter((e) => e.kind !== "folder");
  // Ancestors 返回从直接父级到根；渲染为 根→…→父级
  const crumbsOrdered = useMemo(() => [...(crumbs.data ?? [])].reverse(), [crumbs.data]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b px-5 text-[14px]">
        <span className="font-semibold">云盘</span>
        <div className="ml-2 flex items-center gap-1 rounded-lg bg-hover/60 p-0.5 text-[13px]" data-drive-tabs>
          <a
            href="#/drive"
            className={cn("rounded-md px-2.5 py-1", !scope ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
            data-drive-tab-shared
          >
            共享空间
          </a>
          <a
            href="#/drive/mine"
            className={cn("rounded-md px-2.5 py-1", scope ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
            data-drive-tab-personal
          >
            我的空间
          </a>
        </div>
        {folderId !== null && (
          <nav className="ml-1 flex min-w-0 items-center gap-1 text-[13px]" data-drive-crumbs>
            {crumbsOrdered.map((c) => (
              <span key={c.id} className="flex min-w-0 items-center gap-1">
                <span className="text-subtle">/</span>
                <a href={c.kind === "folder" ? `#/drive/${c.id}` : hrefOf({ id: c.id, kind: (c.kind ?? "doc") as "doc" | "base" })} className="max-w-[10em] truncate text-muted-foreground hover:text-primary">
                  {c.title || "未命名"}
                </a>
              </span>
            ))}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <SearchIcon size={14} strokeWidth={1.7} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索当前目录"
              className="h-8 w-[180px] rounded-md border pl-8 pr-2.5 text-[13px] outline-none focus:border-primary"
              data-drive-search
            />
          </div>
          <button
            className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-hover hover:text-foreground"
            onClick={() => setGrid((v) => !v)}
            title={grid ? "切换为列表视图" : "切换为网格视图"}
            data-drive-view
          >
            {grid ? <ListIcon size={15} strokeWidth={1.7} /> : <LayoutGridIcon size={15} strokeWidth={1.7} />}
          </button>
          <div className="relative">
            <button
              className="flex h-8 items-center gap-1 rounded-md border px-2.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
              onClick={() => setSort((v) => (v === "name" ? "updated" : "name"))}
              title={sort === "name" ? "按名称排序（点击切换为更新时间）" : "按更新时间排序（点击切换为名称）"}
              data-drive-sort
            >
              <ArrowUpDownIcon size={14} strokeWidth={1.7} />
              {sort === "name" ? "名称" : "更新时间"}
            </button>
          </div>
          <div className="relative">
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:opacity-90"
              onClick={() => setCreating((v) => !v)}
              data-drive-new-menu
            >
              <PlusIcon size={14} strokeWidth={1.7} /> 新建
            </button>
            {creating && <div className="fixed inset-0 z-30" onClick={() => setCreating(false)} data-drive-new-menu-backdrop />}
            {creating && (
              <div className="absolute right-0 top-9 z-40 w-[160px] overflow-hidden rounded-lg border bg-surface py-1 shadow-xl" data-drive-new-menu-list>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-hover"
                  onClick={async () => {
                    setCreating(false);
                    const t = await askText("新建文档", "文档名称");
                    if (t && t.trim()) createNode.mutate({ kind: "doc", title: t.trim() });
                  }}
                  data-drive-new-doc
                >
                  <DocIcon /> 文档
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-hover"
                  onClick={async () => {
                    setCreating(false);
                    const t = await askText("新建多维表格", "名称");
                    if (t && t.trim()) createNode.mutate({ kind: "base", title: t.trim() });
                  }}
                  data-drive-new-base
                >
                  <TableIcon size={15} strokeWidth={1.7} /> 多维表格
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-hover"
                  onClick={async () => {
                    setCreating(false);
                    const t = await askText("新建文件夹", "文件夹名称");
                    if (t && t.trim()) createFolder.mutate(t.trim());
                  }}
                  data-drive-new-folder
                >
                  <FolderPlusIcon size={15} strokeWidth={1.7} /> 文件夹
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {list.isError && <p className="py-12 text-center text-[13px] text-subtle">无法访问该目录（可能已删除或无权限）</p>}
        {!list.isError && grid ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3" data-drive-grid>
            {visible.map((e) => (
              <div
                key={e.id}
                className="group flex cursor-pointer flex-col gap-2 rounded-lg border p-3 hover:bg-sidebar"
                data-drive-row={e.id}
                onClick={() => (location.hash = e.kind === "folder" ? `#/drive/${e.id}` : hrefOf({ id: e.id, kind: e.kind as "doc" | "base" }))}
              >
                <span className="text-primary">
                  {e.kind === "folder" ? <FolderIcon size={28} strokeWidth={1.5} /> : e.kind === "base" ? <BaseIcon /> : <DocIcon />}
                </span>
                <span className="truncate text-[13px]">{e.title || "未命名"}</span>
                <span className="text-[11px] text-subtle">{e.updatedAt ? new Date(e.updatedAt).toLocaleDateString("zh-CN") : ""}</span>
              </div>
            ))}
            {visible.length === 0 && list.isSuccess && <p className="col-span-full py-12 text-center text-[13px] text-subtle" data-drive-empty>{filter ? "没有匹配的条目" : "此文件夹为空"}</p>}
          </div>
        ) : !list.isError && (
          <div className="overflow-hidden rounded-lg border" data-drive-list>
            {folders.map((e) => (
              <DriveRow
                key={e.id}
                entry={e}
                starred={favorites.data?.some((f) => f.id === e.id) ?? false}
                onStar={(next) => (next ? extrasApi.star(e.id) : extrasApi.unstar(e.id)).then(() => favorites.refetch())}
                onOpen={() => (location.hash = `#/drive/${e.id}`)}
                onMove={() => setMoving(e)}
                onRename={async () => {
                  const t = await askText("重命名", (e.title || "未命名"), e.title);
                  if (t && t.trim() && t.trim() !== e.title) rename.mutate({ id: e.id, title: t.trim(), expected: e.revision });
                }}
                onTrash={() => void ask(`删除「${e.title}」？`, "整个文件夹会移到回收站，可恢复。").then((ok) => ok && trash.mutate(e))}
              />
            ))}
            {files.map((e) => (
              <DriveRow
                key={e.id}
                entry={e}
                starred={favorites.data?.some((f) => f.id === e.id) ?? false}
                onStar={(next) => (next ? extrasApi.star(e.id) : extrasApi.unstar(e.id)).then(() => favorites.refetch())}
                onOpen={() => (location.hash = hrefOf({ id: e.id, kind: e.kind as "doc" | "base" }))}
                onMove={() => setMoving(e)}
                onRename={async () => {
                  const t = await askText("重命名", (e.title || "未命名"), e.title);
                  if (t && t.trim() && t.trim() !== e.title) rename.mutate({ id: e.id, title: t.trim(), expected: e.revision });
                }}
                onTrash={() => void ask(`删除「${e.title}」？`, "会移到回收站，可恢复。").then((ok) => ok && trash.mutate(e))}
              />
            ))}
            {visible.length === 0 && list.isSuccess && <p className="px-4 py-12 text-center text-[13px] text-subtle" data-drive-empty>{filter ? "没有匹配的条目" : scope ? "此处为空；我的空间仅自己可见，分享后他人才能访问" : "此文件夹为空"}</p>}
          </div>
        )}
      </div>
      {moving && <MoveDialog entry={moving} onDone={() => setMoving(null)} />}
    </div>
  );
}

function DriveRow({ entry, starred, onStar, onOpen, onMove, onRename, onTrash }: { entry: DriveEntry; starred: boolean; onStar: (next: boolean) => void; onOpen: () => void; onMove: () => void; onRename: () => void; onTrash: () => void }) {
  const trashed = false;
  return (
    <div className="group flex cursor-pointer items-center gap-3 border-b px-4 py-2.5 last:border-b-0 hover:bg-sidebar" data-drive-row={entry.id} onClick={onOpen}>
      <span className="shrink-0 text-primary">
        {entry.kind === "folder" ? <FolderIcon size={16} strokeWidth={1.7} /> : entry.kind === "base" ? <BaseIcon /> : <DocIcon />}
      </span>
      <span className="truncate text-[14px]">{entry.title || "未命名"}</span>
      <button
        className={cn("shrink-0 rounded p-0.5", starred ? "text-amber-400" : "text-subtle opacity-0 hover:text-amber-400 group-hover:opacity-100")}
        title={starred ? "取消收藏" : "收藏"}
        data-drive-star
        onClick={(e) => {
          e.stopPropagation();
          onStar(!starred);
        }}
      >
        <StarIcon size={14} strokeWidth={1.7} fill={starred ? "currentColor" : "none"} />
      </button>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {trashed ? (
          <button className="rounded p-1 text-subtle hover:text-primary" title="恢复" onClick={(e) => e.stopPropagation()}>
            <RotateCcwIcon size={14} strokeWidth={1.7} />
          </button>
        ) : (
          <>
            <button
              className="rounded p-1 text-subtle opacity-0 hover:text-primary group-hover:opacity-100"
              title="重命名"
              data-drive-rename
              onClick={(e) => {
                e.stopPropagation();
                onRename();
              }}
            >
              <PencilIcon size={14} strokeWidth={1.7} />
            </button>
            <button
              className="rounded p-1 text-subtle opacity-0 hover:text-primary group-hover:opacity-100"
              title="移动到…"
              onClick={(e) => {
                e.stopPropagation();
                onMove();
              }}
            >
              →
            </button>
            <button
              className="rounded p-1 text-subtle opacity-0 hover:text-destructive group-hover:opacity-100"
              title="删除"
              onClick={(e) => {
                e.stopPropagation();
                onTrash();
              }}
            >
              <Trash2Icon size={14} strokeWidth={1.7} />
            </button>
          </>
        )}
      </span>
      <span className="w-24 shrink-0 text-right text-[12px] text-subtle">{entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString("zh-CN") : ""}</span>
    </div>
  );
}

/** 移动对话框：输入目标文件夹 id（顶层留空）。 */
function MoveDialog({ entry, onDone }: { entry: DriveEntry; onDone: () => void }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState("");
  const move = useMutation({
    mutationFn: () => driveApi.move(entry.id, target.trim() ? Number(target.trim()) : null, entry.revision),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["drive"] });
      qc.invalidateQueries({ queryKey: ["docs"] });
      onDone();
    },
  });
  const [err, setErr] = useState("");
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30" onMouseDown={onDone} data-move-dialog>
      <div className="w-[360px] rounded-xl bg-surface p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="text-[16px] font-semibold">移动「{entry.title}」</h3>
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="目标文件夹 ID（留空 = 顶层）"
          className="mt-3 h-9 w-full rounded-md border px-2.5 text-[14px] outline-none focus:border-primary"
          data-move-target
        />
        {err && <p className="mt-1 text-[12px] text-destructive">{err}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="h-8 rounded-md border px-3 text-[13px] text-foreground hover:bg-hover" onClick={onDone}>
            取消
          </button>
          <button
            className="h-8 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:opacity-90"
            data-move-ok
            onClick={() =>
              move.mutate(undefined, {
                onError: (e) => setErr(e instanceof Error ? e.message : "移动失败"),
              })
            }
          >
            移动
          </button>
        </div>
      </div>
    </div>
  );
}

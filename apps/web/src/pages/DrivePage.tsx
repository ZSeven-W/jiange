import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { driveApi, type DriveEntry } from "@/lib/api";
import { BaseIcon, DocIcon, hrefOf } from "@/components/Sidebar";
import { ask, askText } from "@/components/ui/ask";
import { cn } from "@/lib/utils";
import { FolderIcon, FolderPlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";

/** 云盘：目录列表 + 面包屑 + 新建文件夹/移动/回收恢复。 */
export function DrivePage({ folderId }: { folderId: number | null }) {
  const qc = useQueryClient();
  const key = ["drive", folderId];
  const list = useQuery({ queryKey: key, queryFn: () => driveApi.children(folderId) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["drive"] });
  const [moving, setMoving] = useState<DriveEntry | null>(null);

  const createFolder = useMutation({
    mutationFn: async (title: string) => driveApi.create(title, folderId),
    onSuccess: invalidate,
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

  const entries = list.data ?? [];
  const folders = entries.filter((e) => e.kind === "folder");
  const files = entries.filter((e) => e.kind !== "folder");

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b px-5 text-[14px]">
        <a href="#/drive" className="font-semibold hover:text-primary">
          云盘
        </a>
        {folderId !== null && entries.length > 0 && <span className="text-subtle">/ …</span>}
        <div className="ml-auto flex items-center gap-2">
          <button
            className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
            onClick={async () => {
              const t = await askText("新建文件夹", "文件夹名称");
              if (t && t.trim()) createFolder.mutate(t.trim());
            }}
            data-new-folder
          >
            <FolderPlusIcon size={14} strokeWidth={1.7} /> 新建文件夹
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {list.isError && <p className="py-12 text-center text-[13px] text-subtle">无法访问该目录（可能已删除或无权限）</p>}
        {!list.isError && (
          <div className="overflow-hidden rounded-lg border" data-drive-list>
            {folders.map((e) => (
              <DriveRow
                key={e.id}
                entry={e}
                onOpen={() => (location.hash = `#/drive/${e.id}`)}
                onMove={() => setMoving(e)}
                onTrash={() => void ask(`删除「${e.title}」？`, "整个文件夹会移到回收站，可恢复。").then((ok) => ok && trash.mutate(e))}
              />
            ))}
            {files.map((e) => (
              <DriveRow
                key={e.id}
                entry={e}
                onOpen={() => (location.hash = hrefOf({ id: e.id, kind: e.kind as "doc" | "base" }))}
                onMove={() => setMoving(e)}
                onTrash={() => void ask(`删除「${e.title}」？`, "会移到回收站，可恢复。").then((ok) => ok && trash.mutate(e))}
              />
            ))}
            {entries.length === 0 && list.isSuccess && <p className="px-4 py-12 text-center text-[13px] text-subtle" data-drive-empty>此文件夹为空</p>}
          </div>
        )}
      </div>
      {moving && <MoveDialog entry={moving} onDone={() => setMoving(null)} />}
    </div>
  );
}

function DriveRow({ entry, onOpen, onMove, onTrash }: { entry: DriveEntry; onOpen: () => void; onMove: () => void; onTrash: () => void }) {
  const trashed = false;
  return (
    <div className="group flex cursor-pointer items-center gap-3 border-b px-4 py-2.5 last:border-b-0 hover:bg-sidebar" data-drive-row={entry.id} onClick={onOpen}>
      <span className="shrink-0 text-primary">
        {entry.kind === "folder" ? <FolderIcon size={16} strokeWidth={1.7} /> : entry.kind === "base" ? <BaseIcon /> : <DocIcon />}
      </span>
      <span className="truncate text-[14px]">{entry.title || "未命名"}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {trashed ? (
          <button className="rounded p-1 text-subtle hover:text-primary" title="恢复" onClick={(e) => e.stopPropagation()}>
            <RotateCcwIcon size={14} strokeWidth={1.7} />
          </button>
        ) : (
          <>
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

export const _unused = cn;

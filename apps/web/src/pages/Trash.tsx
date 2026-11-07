import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { driveApi, type DocMeta } from "@/lib/api";
import { BaseIcon, DocIcon, docTitle } from "@/components/Sidebar";
import { DocumentGlyph } from "@/components/DocumentGlyph";
import { FolderIcon } from "lucide-react";

/** 回收站：还原走版本化云盘 API（列表带回 driveRevision，乐观并发）。 */
export function Trash() {
  const qc = useQueryClient();
  const trash = useQuery({ queryKey: ["trash"], queryFn: () => driveApi.trashList() });
  const [err, setErr] = useState("");
  const restore = useMutation({
    // 列表里的 driveRevision 即当前修订号（服务端要求精确匹配）
    mutationFn: (d: DocMeta) => driveApi.restore(d.id, d.driveRevision ?? 0),
    onSuccess: () => {
      setErr("");
      qc.invalidateQueries({ queryKey: ["trash"] });
      qc.invalidateQueries({ queryKey: ["docs"] });
      qc.invalidateQueries({ queryKey: ["drive"] });
    },
    onError: (e) => setErr(e instanceof Error && e.message ? e.message : "还原失败，请刷新后重试。"),
  });
  const entries = trash.data ?? [];
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center pl-16 pr-5 text-[18px] font-semibold md:px-7">回收站</header>
      <div className="mx-auto w-full max-w-[1320px] px-6 py-4 md:px-7">
        <p className="mb-5 text-[13px] text-muted-foreground">删除的文档会连同子文档一起移到这里，可随时还原。</p>
        {err && <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive" data-trash-error>{err}</p>}
        <div className="overflow-hidden border-t" data-trash-list>
          {entries.map((d) => (
            <div key={d.id} className="flex min-h-[52px] items-center gap-3 border-b px-2 py-2 hover:bg-hover/60" data-trash-row={d.id}>
              <span className="text-primary">
                {d.kind === "base" ? <BaseIcon /> : d.kind === "folder" ? <FolderIcon size={16} strokeWidth={1.7} /> : d.kind && d.kind !== "doc" ? <FolderIcon size={16} strokeWidth={1.7} className="opacity-40" /> : <DocumentGlyph icon={d.icon} fallback={<DocIcon />} />}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]">{docTitle(d)}</span>
              {d.kind === "base" && <span className="rounded bg-accent px-1.5 py-0.5 text-[11px] text-subtle" data-base-tag>多维表格</span>}
              {d.kind === "folder" && <span className="rounded bg-accent px-1.5 py-0.5 text-[11px] text-subtle">文件夹</span>}
              <span className="hidden text-xs text-subtle sm:block">修改于 {new Date(d.updatedAt).toLocaleString("zh-CN", { hour12: false })}</span>
              <button className="h-7 rounded-md border px-3 text-[13px] hover:bg-hover" onClick={() => restore.mutate(d)}>
                还原
              </button>
            </div>
          ))}
          {trash.isSuccess && entries.length === 0 && <p className="px-4 py-16 text-center text-[13px] text-subtle">回收站是空的</p>}
        </div>
      </div>
    </div>
  );
}

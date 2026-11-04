import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { docsApi } from "@/lib/api";
import { BaseIcon, DocIcon, docTitle } from "@/components/Sidebar";

export function Trash() {
  const qc = useQueryClient();
  const trash = useQuery({ queryKey: ["trash"], queryFn: docsApi.listTrash });
  const restore = useMutation({
    mutationFn: docsApi.restore,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trash"] });
      qc.invalidateQueries({ queryKey: ["docs"] });
    },
  });
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center border-b px-6 text-[14px] font-medium">回收站</header>
      <div className="mx-auto w-full max-w-[880px] px-10 py-10">
        <p className="mb-4 text-[14px] text-muted-foreground">删除的文档会连同子文档一起移到这里，可随时还原。</p>
        <div className="overflow-hidden rounded-lg border">
          {(trash.data ?? []).map((d) => (
            <div key={d.id} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
              <span className="text-primary">{d.kind === "base" ? <BaseIcon /> : <DocIcon />}</span>
              <span className="truncate">{docTitle(d)}</span>
              {d.kind === "base" && <span className="rounded bg-accent px-1.5 py-0.5 text-[11px] text-subtle" data-base-tag>多维表格</span>}
              <span className="ml-auto text-xs text-subtle">修改于 {new Date(d.updatedAt).toLocaleString("zh-CN", { hour12: false })}</span>
              <button className="h-7 rounded-md border px-3 text-[13px] hover:bg-hover" onClick={() => restore.mutate(d.id)}>
                还原
              </button>
            </div>
          ))}
          {trash.data?.length === 0 && <p className="px-4 py-10 text-center text-[13px] text-subtle">回收站是空的</p>}
        </div>
      </div>
    </div>
  );
}

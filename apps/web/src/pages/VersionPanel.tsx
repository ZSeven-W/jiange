import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { docsApi, type DocView } from "@/lib/api";
import { ask, askText } from "@/components/ui/ask";
import { ReadOnlyDoc } from "./ReadOnlyDoc";

/** Right drawer: version list, read-only preview and restore (P6). */
export function VersionPanel({ id, canEdit, onClose }: { id: number; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["versions", id], queryFn: () => docsApi.versions(id) });
  const [previewing, setPreviewing] = useState<number | null>(null);
  const preview = useQuery({
    queryKey: ["versions", id, previewing],
    queryFn: () => docsApi.versionPreview(id, previewing!),
    enabled: previewing !== null,
  });
  const create = useMutation({
    mutationFn: (label: string) => docsApi.createVersion(id, label),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["versions", id] }),
  });
  const restore = useMutation({
    mutationFn: (seq: number) => docsApi.restoreVersion(id, seq),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["versions", id] });
      setPreviewing(null);
    },
  });
  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-96 flex-col border-l bg-surface shadow-xl" data-version-panel>
      <header className="flex h-[52px] shrink-0 items-center border-b px-4 text-[15px] font-semibold">
        历史版本
        <button className="ml-auto rounded p-1 text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        {canEdit && (
          <button
            className="mb-3 h-8 w-full rounded-md bg-primary text-[13px] font-medium text-white hover:opacity-90"
            onClick={async () => {
              const label = await askText("创建版本", "版本名称", "手动版本");
              if (label !== null) create.mutate(label.trim() || "手动版本");
            }}
            data-create-version
          >
            + 创建当前版本
          </button>
        )}
        {(list.data ?? []).length === 0 && <p className="px-2 py-8 text-center text-[13px] text-subtle">还没有版本</p>}
        {(list.data ?? []).map((v) => (
          <div
            key={v.seq}
            className={`mb-2 cursor-pointer rounded-lg border p-3 text-[13px] hover:bg-hover ${previewing === v.seq ? "border-primary" : ""}`}
            onClick={() => setPreviewing(v.seq)}
            data-version-item={v.seq}
          >
            <div className="flex items-center gap-2 font-medium">
              <span className="truncate">{v.label}</span>
              <span className="ml-auto shrink-0 text-[11px] text-subtle">#{v.seq}</span>
            </div>
            <div className="mt-1 text-[12px] text-muted-foreground">
              {v.createdByName || "系统"} · {new Date(v.createdAt).toLocaleString("zh-CN", { hour12: false })}
            </div>
          </div>
        ))}
      </div>
      {previewing !== null && (
        <div className="flex h-[55%] shrink-0 flex-col border-t" data-version-preview>
          <div className="flex items-center gap-2 border-b px-4 py-2 text-[13px] font-medium">
            版本预览（只读）
            {canEdit && (
              <button
                className="ml-auto h-7 rounded-md bg-primary px-3 text-[12px] font-normal text-white hover:opacity-90"
                disabled={restore.isPending}
                onClick={async () => {
                  if (await ask("还原到该版本？", "当前内容会被新操作覆盖（历史保留）。", false)) restore.mutate(previewing);
                }}
                data-restore-version
              >
                {restore.isPending ? "还原中…" : "还原到此版本"}
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 text-[14px] leading-6">
            {preview.data ? <VersionView view={preview.data.view} /> : <p className="text-subtle">加载中…</p>}
          </div>
        </div>
      )}
    </aside>
  );
}

/** Read-only snapshot projection shared with publicly shared documents. */
export function VersionView({ view }: { view: DocView }) {
  return <ReadOnlyDoc view={view} />;
}

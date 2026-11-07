import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, docsApi, type DocView } from "@/lib/api";
import { ask, askText } from "@/components/ui/ask";
import { ReadOnlyDoc } from "./ReadOnlyDoc";

export function restoreErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.message && error.message !== "Conflict") return error.message;
    if (error.status === 409) return "文档已变化或版本无法安全还原，请重新查看后重试。";
    if (error.status === 401 || error.status === 403 || error.status === 404) return "当前无权还原该版本，请检查文档权限。";
  }
  return "还原失败，请检查网络后重试。";
}

export function RestoreErrorNotice({ error, canEdit, onRetry, onDismiss }: { error: unknown; canEdit: boolean; onRetry: () => void; onDismiss: () => void }) {
  return <div role="alert" className="mx-4 mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-destructive">
    <p>{restoreErrorMessage(error)}</p>
    <div className="mt-2 flex gap-3">
      {canEdit && <button type="button" className="underline" onClick={onRetry}>重新尝试</button>}
      <button type="button" className="underline" onClick={onDismiss}>关闭提示</button>
    </div>
  </div>;
}

/** Right drawer: version list, read-only preview and restore (P6). */
export function VersionPanel({ id, canEdit, disableFileDownloads, onClose }: { id: number; canEdit: boolean; disableFileDownloads: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["versions", id], queryFn: () => docsApi.versions(id) });
  const [previewing, setPreviewing] = useState<number | null>(null);
  const latest = useRef({ id, canEdit, previewing });
  latest.current = { id, canEdit, previewing };
  const mounted = useRef(true);
  const confirming = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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
  const startRestore = async () => {
    const target = latest.current;
    if (!target.canEdit || target.previewing === null || restore.isPending || confirming.current) return;
    confirming.current = true;
    try {
      const confirmed = await ask("还原到该版本？", "当前内容会被新操作覆盖（历史保留）。", false);
      if (confirmed && mounted.current && latest.current.id === target.id && latest.current.canEdit && latest.current.previewing === target.previewing) {
        restore.reset();
        restore.mutate(target.previewing);
      }
    } finally { confirming.current = false; }
  };
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
            onClick={() => { if (!restore.isPending) { restore.reset(); setPreviewing(v.seq); } }}
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
                onClick={() => void startRestore()}
                data-restore-version
              >
                {restore.isPending ? "还原中…" : "还原到此版本"}
              </button>
            )}
          </div>
          {restore.isError && <RestoreErrorNotice error={restore.error} canEdit={canEdit} onRetry={() => void startRestore()} onDismiss={() => restore.reset()} />}
          <div className="flex-1 overflow-y-auto px-5 py-4 text-[14px] leading-6">
            {preview.data ? <VersionView view={preview.data.view} disableFileDownloads={disableFileDownloads} versionSeq={previewing} /> : <p className="text-subtle">加载中…</p>}
          </div>
        </div>
      )}
    </aside>
  );
}

/** Read-only snapshot projection shared with publicly shared documents. */
export function VersionView({ view, disableFileDownloads = false, versionSeq }: { view: DocView; disableFileDownloads?: boolean; versionSeq?: number }) {
  return <ReadOnlyDoc view={view} disableFileDownloads={disableFileDownloads} imageVersionSeq={versionSeq} />;
}

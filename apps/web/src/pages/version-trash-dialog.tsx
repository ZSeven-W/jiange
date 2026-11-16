import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, X } from "lucide-react";
import { ApiError, docsApi, type DeletedVersionEntry } from "@/lib/api";
import { formatEditTime } from "./doc-header-meta";

/** Only editors can enumerate or restore deleted named versions. */
export function VersionTrashDialog({ id, userId, canEdit, onClose }: { id: number; userId: number; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["versions", userId, id, "trash"], queryFn: () => docsApi.deletedVersionEntries(id, userId), enabled: canEdit, refetchOnMount: "always", refetchInterval: 15_000, refetchIntervalInBackground: false, retry: (n, error) => !(error instanceof ApiError && [401, 403, 404].includes(error.status)) && n < 2 });
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState("");
  const pending = useRef(false), mounted = useRef(true), current = useRef({ canEdit, list }); current.current = { canEdit, list };
  const root = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; mounted.current = true; close.current?.focus(); return () => { mounted.current = false; if (previous?.isConnected) previous.focus(); }; }, []);
  const recover = async (v: DeletedVersionEntry) => {
    const state = current.current;
    if (pending.current || !state.canEdit || !state.list.isSuccess || state.list.isFetching || !state.list.data.some((x) => x.id === v.id && x.revision === v.revision)) return;
    pending.current = true; setBusy(v.id); setError("");
    try { await docsApi.manageVersionEntry(id, v.id, v.revision, "restore", userId); }
    catch (e) { if (mounted.current) setError(e instanceof ApiError && [404, 409].includes(e.status) ? "版本已变化或超过 30 天，请刷新后查看。" : "无法确认恢复结果，请刷新列表后检查。"); }
    finally { await qc.invalidateQueries({ queryKey: ["versions", userId, id] }); pending.current = false; if (mounted.current) setBusy(null); }
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-3" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }} onKeyDown={(e) => {
    if (e.key === "Escape") { e.stopPropagation(); if (!busy) { e.preventDefault(); onClose(); } return; }
    if (e.key !== "Tab" || !root.current) return; e.stopPropagation(); const items = [...root.current.querySelectorAll<HTMLElement>("button:not([disabled])")]; const i = items.indexOf(document.activeElement as HTMLElement); if (items.length && (i < 0 || e.shiftKey && i === 0 || !e.shiftKey && i === items.length-1)) { e.preventDefault(); items[e.shiftKey ? items.length-1 : 0].focus(); }
  }}>
    <section ref={root} role="dialog" aria-modal="true" aria-label="版本回收站" className="flex max-h-[min(620px,calc(100dvh-24px))] min-h-[360px] w-full max-w-[600px] flex-col overflow-hidden rounded-lg bg-surface shadow-xl">
      <header className="flex h-14 shrink-0 items-center border-b px-5"><ArrowLeft size={17} className="mr-2 text-subtle"/><h2 className="text-[16px] font-medium">版本回收站</h2><button ref={close} type="button" aria-label="关闭版本回收站" disabled={!!busy} onClick={onClose} className="ml-auto rounded p-2 hover:bg-hover disabled:opacity-40"><X size={17}/></button></header>
      <p className="px-5 pt-4 text-[13px] text-subtle">可恢复 30 天内删除的版本。</p>
      {error && <p role="alert" className="mx-5 mt-3 text-[13px] text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-3">
        {list.isLoading && <p className="py-12 text-center text-[13px] text-subtle">正在加载…</p>}
        {list.isError && <p role="alert" className="py-8 text-center text-[13px] text-destructive">无法加载版本回收站。 <button type="button" className="underline" onClick={() => void list.refetch()}>重试</button></p>}
        {list.isSuccess && list.data.length === 0 && <p className="py-12 text-center text-[13px] text-subtle">暂无可恢复的版本</p>}
        {(list.isSuccess ? list.data : []).map((v) => <div key={v.id} data-deleted-version={v.id} className="flex min-h-16 items-center gap-4 border-b py-3"><div className="min-w-0 flex-1"><p className="truncate text-[14px]">{v.label}</p><p className="mt-1 text-[12px] text-subtle">{v.createdByName || "未知用户"} · 删除于 {formatEditTime(v.deletedAt) || "未知时间"}</p></div><button type="button" disabled={!canEdit || list.isFetching || !!busy} onClick={() => void recover(v)} className="shrink-0 rounded px-2 py-1 text-[13px] text-[#1456F0] hover:bg-hover disabled:opacity-40" data-restore-deleted-version>{busy === v.id ? "恢复中…" : "恢复"}</button></div>)}
      </div>
    </section>
  </div>;
}

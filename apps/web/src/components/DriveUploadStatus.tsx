import { useEffect, useSyncExternalStore } from "react";
import { CheckCircle2, ChevronRight, CloudUpload, X } from "lucide-react";
import { go } from "@/lib/route";
import type { DriveUploadManager } from "@/pages/drive-upload";

/** Stays mounted while navigating within the same authenticated session. */
export function DriveUploadStatus({ manager }: { manager: DriveUploadManager }) {
  const state = useSyncExternalStore(manager.subscribe, manager.snapshot, manager.snapshot);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (manager.active) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [manager]);
  if (state.phase === "idle") return null;
  const active = state.phase === "scanning" || state.phase === "uploading";
  const title = state.phase === "scanning" ? "正在读取文件夹" : active ? "正在上传" : state.phase === "complete" ? "上传完成" : state.phase === "cancelled" ? "已停止上传" : "上传未完成";
  const total = state.total + state.directoriesTotal;
  const completed = state.completed + state.directoriesCompleted;
  return <aside role="status" aria-live="polite" className="fixed bottom-4 right-4 z-[70] w-[min(360px,calc(100vw-32px))] rounded-lg border border-[#dee0e3] bg-white text-[#1f2329] shadow-[0_6px_24px_rgba(31,35,41,0.16)]" data-drive-upload-status>
    <div className="flex h-12 items-center gap-2 border-b px-4"><span className="text-[#3370ff]">{state.phase === "complete" ? <CheckCircle2 size={17}/> : <CloudUpload size={17}/>}</span><strong className="min-w-0 flex-1 text-[14px] font-medium">{title}</strong>{state.phase !== "scanning" && <span className="text-[12px] text-[#8f959e]">文件 {state.completed}/{state.total}{state.directoriesTotal > 0 ? ` · 目录 ${state.directoriesCompleted}/${state.directoriesTotal}` : ""}</span>}{active ? <button type="button" onClick={() => manager.cancel()} className="rounded px-2 py-1 text-[12px] text-[#646a73] hover:bg-[#f2f3f5]">停止</button> : <button type="button" aria-label="关闭上传状态" onClick={() => manager.dismiss()} className="grid size-7 place-items-center rounded text-[#8f959e] hover:bg-[#f2f3f5]"><X size={15}/></button>}</div>
    <div className="space-y-2 px-4 py-3"><div role="progressbar" aria-label={state.phase === "scanning" ? "正在读取文件夹" : "上传进度"} aria-valuemin={0} aria-valuemax={Math.max(total, 1)} aria-valuenow={state.phase === "scanning" ? undefined : total === 0 && state.phase === "complete" ? 1 : completed} className="h-1.5 w-full overflow-hidden rounded-full bg-[#e8efff]"><div className="h-full rounded-full bg-[#3370ff] transition-[width]" style={{ width: state.phase === "scanning" ? "35%" : `${total ? completed / total * 100 : state.phase === "complete" ? 100 : 0}%` }}/></div>{active && <p className="truncate text-[12px] text-[#646a73]" title={state.current}>{state.current || (state.phase === "scanning" ? state.rootName : "准备中…")}</p>}{state.message && <p className={`text-[12px] ${state.phase === "failed" || state.uncertain ? "text-[#d83931]" : "text-[#646a73]"}`}>{state.message}</p>}{state.rootId !== null && <button type="button" onClick={() => go(`#/drive/${state.rootId}`)} className="flex items-center gap-0.5 text-[12px] text-[#3370ff] hover:underline">查看「{state.rootName}」<ChevronRight size={13}/></button>}</div>
  </aside>;
}

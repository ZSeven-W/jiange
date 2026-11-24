import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Download, FileText } from "lucide-react";
import { docsApi, driveApi } from "@/lib/api";
import { ShareDialog } from "@/components/share-dialog";
import { RichFilePreview } from "@/components/rich-file-preview";
import { canCopyContent, canDownloadDocument } from "./document-copy";
import { createVisitRecorder } from "@/lib/recent-visit";

/** Opens a standalone drive file through the same authenticated blob endpoint as attachments. */
export function DriveFilePage({ id, userId }: { id: number; userId: number }) {
  const qc = useQueryClient();
  const [sharing, setSharing] = useState(false);
  const shareRef = useRef<HTMLButtonElement>(null);
  const meta = useQuery({ queryKey: ["drive-file-node", id], queryFn: () => docsApi.get(id), refetchInterval: 15000, retry: false });
  const file = useQuery({ queryKey: ["drive-file", id], queryFn: () => driveApi.file(id), enabled: !!meta.data && meta.data.kind === "file" && !meta.isError, refetchInterval: 15000, retry: false });
  const visitRecorder = useMemo(() => createVisitRecorder(
    () => docsApi.recordVisit(id),
    () => { void qc.invalidateQueries({ queryKey: ["recent"] }); },
    () => { void qc.invalidateQueries({ queryKey: ["drive-file-node", id] }); void qc.invalidateQueries({ queryKey: ["drive-file", id] }); },
  ), [id, qc]);
  useEffect(() => {
    if (!meta.isFetchedAfterMount || !file.isFetchedAfterMount || !meta.isSuccess || !file.isSuccess || meta.isFetching || file.isFetching || meta.data.kind !== "file") return;
    visitRecorder.start();
    return () => visitRecorder.stop();
  }, [meta.isFetchedAfterMount, file.isFetchedAfterMount, meta.isSuccess, file.isSuccess, meta.isFetching, file.isFetching, meta.data?.kind, visitRecorder]);
  const allowed = canDownloadDocument(meta.data) && !meta.isError;
  const allowCopy = canCopyContent(meta.data) && !meta.isError;
  if (meta.isPending || (meta.isSuccess && meta.data.kind === "file" && file.isPending)) return <div className="grid flex-1 place-items-center text-sm text-subtle">正在打开文件…</div>;
  if (meta.isError || file.isError || meta.data?.kind !== "file" || !file.data) return <div className="grid flex-1 place-items-center text-sm text-subtle">无法访问该文件，请确认权限后重试。</div>;
  const info = file.data;
  const size = info.size < 1024 ? `${info.size} B` : info.size < 1024 * 1024 ? `${(info.size / 1024).toFixed(1)} KB` : `${(info.size / 1024 / 1024).toFixed(1)} MB`;
  const src = `/api/files/${info.id}`;
  return <main className="flex min-w-0 flex-1 flex-col bg-[#f5f6f7]">
    <header className="flex h-14 items-center gap-2 border-b bg-white pl-14 pr-4 md:px-5"><button type="button" aria-label="返回云盘" onClick={() => { location.hash = meta.data.parentId ? `#/drive/${meta.data.parentId}` : info.personal ? "#/drive/mine" : "#/drive"; }} className="grid size-8 place-items-center rounded hover:bg-[#f2f3f5]"><ChevronLeft size={18}/></button><FileText size={18} className="text-[#3370ff]"/><span className="min-w-0 flex-1 truncate text-[14px] font-medium">{meta.data.title}</span><button ref={shareRef} type="button" onClick={() => setSharing(true)} className="h-8 rounded-md border px-3 text-[13px] hover:bg-[#f2f3f5]">分享</button>{allowed ? <a href={src} download={meta.data.title} className="flex h-8 items-center gap-1 rounded-md bg-[#3370ff] px-3 text-[13px] text-white"><Download size={14}/>下载</a> : <span className="text-[13px] text-subtle">下载未开放</span>}</header>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">{allowed ? <RichFilePreview src={src} name={meta.data.title || info.name} mime={info.mime} size={info.size} allowCopy={allowCopy} allowPrint={allowed} theme="light" /> : <div className="flex max-w-md flex-col items-center gap-3 text-center"><span className="grid size-20 place-items-center rounded-2xl bg-white text-[#3370ff] shadow-sm"><FileText size={38}/></span><h1 className="break-all text-[17px] font-medium">{meta.data.title}</h1><p className="text-[13px] text-[#8f959e]">{size} · 下载未开放</p></div>}</div>
    {sharing && <ShareDialog meta={meta.data} userId={userId} onClose={() => setSharing(false)} anchorRef={shareRef}/>}
  </main>;
}

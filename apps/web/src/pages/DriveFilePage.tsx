import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Download, FileText } from "lucide-react";
import { docsApi, driveApi } from "@/lib/api";
import { ShareDialog } from "@/components/ShareDialog";
import { canDownloadDocument } from "./documentCopy";

/** Opens a standalone drive file through the same authenticated blob endpoint as attachments. */
export function DriveFilePage({ id }: { id: number }) {
  const [sharing, setSharing] = useState(false);
  const shareRef = useRef<HTMLButtonElement>(null);
  const meta = useQuery({ queryKey: ["drive-file-node", id], queryFn: () => docsApi.get(id), refetchInterval: 15000, retry: false });
  const file = useQuery({ queryKey: ["drive-file", id], queryFn: () => driveApi.file(id), enabled: !!meta.data && meta.data.kind === "file" && !meta.isError, refetchInterval: 15000, retry: false });
  const allowed = canDownloadDocument(meta.data) && !meta.isError;
  const plainText = !!file.data && file.data.mime.toLowerCase().startsWith("text/plain") && file.data.size <= 1024 * 1024;
  const text = useQuery({ queryKey: ["drive-file-text", id, file.data?.id], enabled: plainText && allowed && !file.isError, retry: false, gcTime: 0, refetchInterval: 15000, queryFn: async () => {
    const response = await fetch(`/api/files/${file.data!.id}`, { cache: "no-store" });
    if (!response.ok) throw new Error("无法预览文件");
    return response.text();
  } });
  if (meta.isPending || (meta.isSuccess && meta.data.kind === "file" && file.isPending)) return <div className="grid flex-1 place-items-center text-sm text-subtle">正在打开文件…</div>;
  if (meta.isError || file.isError || meta.data?.kind !== "file" || !file.data) return <div className="grid flex-1 place-items-center text-sm text-subtle">无法访问该文件，请确认权限后重试。</div>;
  const info = file.data;
  const size = info.size < 1024 ? `${info.size} B` : info.size < 1024 * 1024 ? `${(info.size / 1024).toFixed(1)} KB` : `${(info.size / 1024 / 1024).toFixed(1)} MB`;
  const inline = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(info.mime.toLowerCase());
  const src = `/api/files/${info.id}`;
  return <main className="flex min-w-0 flex-1 flex-col bg-[#f5f6f7]">
    <header className="flex h-14 items-center gap-2 border-b bg-white pl-14 pr-4 md:px-5"><button type="button" aria-label="返回云盘" onClick={() => { location.hash = meta.data.parentId ? `#/drive/${meta.data.parentId}` : info.personal ? "#/drive/mine" : "#/drive"; }} className="grid size-8 place-items-center rounded hover:bg-[#f2f3f5]"><ChevronLeft size={18}/></button><FileText size={18} className="text-[#3370ff]"/><span className="min-w-0 flex-1 truncate text-[14px] font-medium">{meta.data.title}</span><button ref={shareRef} type="button" onClick={() => setSharing(true)} className="h-8 rounded-md border px-3 text-[13px] hover:bg-[#f2f3f5]">分享</button>{allowed ? <a href={src} download={meta.data.title} className="flex h-8 items-center gap-1 rounded-md bg-[#3370ff] px-3 text-[13px] text-white"><Download size={14}/>下载</a> : <span className="text-[13px] text-subtle">下载未开放</span>}</header>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">{allowed && inline ? <img src={src} alt={meta.data.title} className="max-h-full max-w-full object-contain shadow-sm"/> : allowed && plainText && !text.isError ? <pre className="max-h-full w-full max-w-[900px] self-start overflow-auto whitespace-pre-wrap break-words rounded-md bg-white p-6 text-[14px] leading-7 text-[#1f2329] shadow-sm">{text.isPending ? "正在加载预览…" : text.data}</pre> : <div className="flex max-w-md flex-col items-center gap-3 text-center"><span className="grid size-20 place-items-center rounded-2xl bg-white text-[#3370ff] shadow-sm"><FileText size={38}/></span><h1 className="break-all text-[17px] font-medium">{meta.data.title}</h1><p className="text-[13px] text-[#8f959e]">{size} · {allowed ? "暂不支持在线预览，可下载查看" : "下载未开放"}</p></div>}</div>
    {sharing && <ShareDialog meta={meta.data} onClose={() => setSharing(false)} anchorRef={shareRef}/>}
  </main>;
}

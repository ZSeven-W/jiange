import { useEffect, useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, Download, MessageSquarePlus, RefreshCw, Trash2 } from "lucide-react";
import type { SyncStatus } from "@jiange/collab";
import { cn } from "@/lib/utils";
import { shouldRetryImage, type ImageFailure } from "./imageRetry";

export type ImageAlign = "left" | "center" | "right";
/** 图片默认居中（飞书）；只接受已知值。 */
export const imageAlign = (v?: string): ImageAlign => (v === "left" || v === "right" ? v : "center");

/** 宽度预设：百分比为相对正文宽度；undefined = 原始大小（不超过正文宽度）。 */
export const IMAGE_WIDTHS: { label: string; value: number | undefined }[] = [
  { label: "原始大小", value: undefined },
  { label: "50%", value: 50 },
  { label: "75%", value: 75 },
  { label: "适应宽度", value: 100 },
];

/** 拖动缩放：按正文宽度换算百分比，限制在 10%–100%，取整。 */
export function resizedWidth(startPx: number, dx: number, containerPx: number, side: "left" | "right", align: ImageAlign): number {
  // 居中时两侧同时伸缩，位移计两倍。
  const delta = (side === "right" ? dx : -dx) * (align === "center" ? 2 : 1);
  const px = Math.max(1, startPx + delta);
  return Math.max(10, Math.min(100, Math.round((px / Math.max(1, containerPx)) * 100)));
}

const tb = "grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground";
const keep = (e: React.MouseEvent) => e.preventDefault();

export function ImageBlock({ fileId, name, mime, width, align, caption, version, status, canDownload, onPreview, onProp, onReplace, onDelete, onComment, uploadProgress }: {
  fileId?: string; name?: string; mime?: string; width?: number; align?: string; caption?: string;
  version: number; status: SyncStatus; canDownload: boolean;
  onPreview?: (src: string, alt: string, mime?: string) => void;
  /** 编辑者：设置块属性（imageWidth / align / caption）。 */
  onProp?: (key: string, value: string) => void;
  onReplace?: (file: File, progress: (p: number) => void) => Promise<void>;
  onDelete?: () => void;
  onComment?: () => void;
  /** 0–100：正在替换/上传时显示进度遮罩。 */
  uploadProgress?: number | null;
}) {
  const [failure, setFailure] = useState<ImageFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [automatic, setAutomatic] = useState(0);
  const [live, setLive] = useState<number | null>(null);
  const [replacing, setReplacing] = useState<number | null>(null);
  const [replaceError, setReplaceError] = useState("");
  const [draft, setDraft] = useState(caption ?? "");
  const fig = useRef<HTMLElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(caption ?? ""), [caption]);
  useEffect(() => {
    if (!failure || !shouldRetryImage(failure, version, status, automatic)) return;
    setFailure(null);
    setAutomatic((n) => n + 1);
    setAttempt((n) => n + 1);
  }, [failure, version, status, automatic]);
  const src = `/api/files/${fileId}`;
  const a = imageAlign(align);
  const shown = live ?? width;
  const progress = replacing ?? uploadProgress ?? null;
  const editable = !!onProp;
  const startResize = (e: React.MouseEvent, side: "left" | "right") => {
    if (!onProp || !frame.current || !fig.current) return;
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startPx = frame.current.getBoundingClientRect().width, containerPx = fig.current.getBoundingClientRect().width;
    let last = width ?? Math.round((startPx / containerPx) * 100);
    const move = (ev: MouseEvent) => { last = resizedWidth(startPx, ev.clientX - startX, containerPx, side, a); setLive(last); };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      setLive(null);
      if (last !== width) onProp("imageWidth", String(last));
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const commitCaption = () => { if (onProp && draft !== (caption ?? "")) onProp("caption", draft); };
  return (
    <figure ref={fig} contentEditable={false} className={cn("group/img my-2 flex select-none flex-col", a === "center" ? "items-center" : a === "right" ? "items-end" : "items-start")} data-image-block data-image-align={a}>
      <div ref={frame} className="relative max-w-full" style={shown ? { width: `${shown}%` } : undefined} data-image-frame>
        {failure ? <button type="button" className="rounded border px-3 py-2 text-[13px] text-subtle hover:bg-hover" onClick={() => { setFailure(null); setAttempt((n) => n + 1); }}>图片暂不可用，点击重试</button> : (
          <img key={`${fileId}:${attempt}`} src={src} alt={caption || name} className={cn("block max-h-[640px] max-w-full cursor-zoom-in rounded-[4px] object-contain", shown ? "w-full" : "h-auto", editable && "group-hover/img:outline group-hover/img:outline-2 group-hover/img:outline-[#3370FF]/40")} draggable={false} onContextMenu={(event) => { if (!canDownload) event.preventDefault(); }} onClick={() => onPreview?.(src, caption || name || "图片", mime)} onError={() => setFailure({ version, status })} data-preview-image />
        )}
        {progress !== null && <div className="absolute inset-0 grid place-items-center rounded-[4px] bg-white/70 dark:bg-black/50" data-image-uploading>
          <div className="w-1/2 min-w-[120px] text-center text-[12px] text-muted-foreground">正在上传 {Math.round(progress)}%<div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div></div>
        </div>}
        {editable && !failure && <>
          <span className="absolute -left-1 top-1/2 hidden h-10 w-2 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-white bg-[#3370FF] shadow group-hover/img:block" onMouseDown={(e) => startResize(e, "left")} data-image-resize="left" />
          <span className="absolute -right-1 top-1/2 hidden h-10 w-2 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-white bg-[#3370FF] shadow group-hover/img:block" onMouseDown={(e) => startResize(e, "right")} data-image-resize="right" />
          {live !== null && <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white" data-image-live-width>{live}%</span>}
        </>}
        {(editable || canDownload || onComment) && !failure && <div className="absolute left-1/2 top-2 z-20 hidden -translate-x-1/2 items-center gap-0.5 whitespace-nowrap rounded-lg border bg-surface p-0.5 shadow-[0_4px_16px_rgba(31,35,41,0.16)] group-hover/img:flex" onMouseDown={keep} data-image-toolbar>
          {editable && <>
            {([["left", "左对齐", AlignLeft], ["center", "居中", AlignCenter], ["right", "右对齐", AlignRight]] as const).map(([v, l, Icon]) => (
              <button key={v} type="button" title={l} aria-label={l} aria-pressed={a === v} className={cn(tb, a === v && "bg-primary/10 text-primary")} onClick={() => onProp!("align", v)} data-image-align-btn={v}><Icon size={15} strokeWidth={1.8} /></button>
            ))}
            <span className="mx-0.5 h-4 w-px bg-border" />
            {IMAGE_WIDTHS.map(({ label, value }) => (
              <button key={label} type="button" className={cn("h-7 rounded px-1.5 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground", width === value && "bg-primary/10 text-primary")} onClick={() => onProp!("imageWidth", value === undefined ? "" : String(value))} data-image-width={value ?? "auto"}>{label}</button>
            ))}
            <span className="mx-0.5 h-4 w-px bg-border" />
          </>}
          {onReplace && <button type="button" title="替换图片" aria-label="替换图片" className={tb} onClick={() => picker.current?.click()} data-image-replace><RefreshCw size={14} strokeWidth={1.8} /></button>}
          {canDownload && <a href={src} download={name || "image"} title="下载" aria-label="下载" className={tb} data-image-download><Download size={14} strokeWidth={1.8} /></a>}
          {onComment && <button type="button" title="评论" aria-label="评论" className={tb} onClick={onComment} data-image-comment><MessageSquarePlus size={14} strokeWidth={1.8} /></button>}
          {onDelete && <button type="button" title="删除" aria-label="删除" className={cn(tb, "hover:text-destructive")} onClick={onDelete} data-image-delete><Trash2 size={14} strokeWidth={1.8} /></button>}
        </div>}
      </div>
      {(editable || caption) && <div className="mt-1.5 w-full max-w-full text-center" style={shown ? { width: `${shown}%` } : undefined}>
        {editable ? (
          <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commitCaption} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitCaption(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") { setDraft(caption ?? ""); (e.target as HTMLInputElement).blur(); } }} placeholder="添加图片说明" aria-label="图片说明" className={cn("w-full bg-transparent text-center text-[14px] text-muted-foreground outline-none placeholder:text-subtle", !draft && "opacity-0 focus:opacity-100 group-hover/img:opacity-100")} data-image-caption />
        ) : <figcaption className="text-[14px] text-muted-foreground" data-image-caption>{caption}</figcaption>}
      </div>}
      {replaceError && <p role="alert" className="mt-1 text-[12px] text-destructive">{replaceError}</p>}
      {onReplace && <input ref={picker} type="file" accept="image/*" hidden onChange={(e) => {
        const f = e.target.files?.[0]; e.target.value = "";
        if (!f) return;
        setReplaceError(""); setReplacing(0);
        onReplace(f, (p) => setReplacing(p)).then(() => setReplacing(null), () => { setReplacing(null); setReplaceError("替换失败，请检查网络后重试。"); });
      }} data-image-replace-input />}
    </figure>
  );
}

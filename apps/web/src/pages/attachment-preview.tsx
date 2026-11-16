import { useEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus, RotateCw } from "lucide-react";
import { IMAGE_ZOOM_LEVELS, previewImageSize, stepImageZoom } from "./image-preview-zoom";
import { useImagePreviewTouch } from "./use-image-preview-touch";

/**
 * 附件在线预览遮罩：图片大图、PDF 内嵌、文本/代码内容预览；
 * 其余类型回退为下载卡片。allowCopy/allowPrint 由分享策略控制。
 */
export function AttachmentPreview({
  src,
  name,
  mime,
  allowCopy = true,
  allowPrint = true,
  onClose,
}: {
  src: string;
  name: string;
  mime?: string;
  allowCopy?: boolean;
  allowPrint?: boolean;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const imageFrame = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [imageError, setImageError] = useState(false);
  const isImage = !!mime?.startsWith("image/");
  useEffect(() => { setNatural(null); setZoom(1); setRotation(0); setImageError(false); }, [src]);
  useEffect(() => {
    const node = viewport.current;
    if (!isImage || !node) return;
    const measure = () => setViewportSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure); observer.observe(node); return () => observer.disconnect();
    }
    window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure);
  }, [isImage]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const isPdf = mime === "application/pdf";
  const isText = !!mime && (mime.startsWith("text/") || /^(application\/(json|xml|javascript|x-yaml|sql))$/.test(mime));
  const size = previewImageSize(natural, viewportSize, zoom, rotation);
  const sideways = rotation % 180 !== 0;
  const touch = useImagePreviewTouch(viewport, imageFrame, zoom, setZoom, src, rotation);
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`预览：${name}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
        if (isImage && !imageError && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
          if (event.key === "+" || event.key === "=") { event.preventDefault(); setZoom((value) => stepImageZoom(value, 1)); return; }
          if (event.key === "-") { event.preventDefault(); setZoom((value) => stepImageZoom(value, -1)); return; }
          if (event.key === "0") { event.preventDefault(); setZoom(1); return; }
        }
        if (event.key !== "Tab" || !root.current) return;
        const items = [...root.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], iframe")].filter((item) => item.getClientRects().length > 0);
        if (!items.length) return;
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === items.length - 1) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); }
      }}
      className="fixed inset-0 z-50 flex flex-col bg-[#1f2024] p-4 sm:p-6"
      onClick={onClose}
      onCopy={(event) => {
        if (!allowCopy) event.preventDefault();
      }}
      onCut={(event) => {
        if (!allowCopy) event.preventDefault();
      }}
      data-attachment-preview
    >
      <div className="mb-3 flex shrink-0 items-center gap-3 px-1" onClick={(e) => e.stopPropagation()}>
        <span className="truncate text-[14px] text-white/90">{name}</span>
        <span className="text-[12px] text-white/40">{mime}</span>
        <button ref={close} type="button" onClick={onClose} className="ml-auto rounded-full bg-white/10 px-3 py-1.5 text-[13px] text-white hover:bg-white/20" aria-label="关闭">
          ✕
        </button>
      </div>
      <div ref={viewport} className={isImage ? "flex min-h-0 flex-1 overflow-auto" : "grid min-h-0 flex-1 place-items-center overflow-auto"} style={isImage ? { touchAction: "none" } : undefined} {...(isImage && natural && !imageError ? touch : {})} onClick={(e) => e.stopPropagation()}>
        {isImage ? (
          imageError ? <p role="status" className="m-auto text-[13px] text-white/70">图片加载失败</p> : <div ref={imageFrame} style={size} className={size ? "relative m-auto shrink-0" : "m-auto flex max-h-full max-w-full shrink-0"}><img
            src={src}
            alt={name}
            onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setImageError(true)}
            draggable={allowPrint}
            data-document-print-restricted={!allowPrint ? "true" : undefined}
            onContextMenu={(event) => {
              if (!allowPrint) event.preventDefault();
            }}
            style={size ? { width: sideways ? size.height : size.width, height: sideways ? size.width : size.height, transform: `translate(-50%, -50%) rotate(${rotation}deg)` } : undefined}
            className={size ? "absolute left-1/2 top-1/2 max-h-none max-w-none rounded-lg object-contain shadow-2xl" : "m-auto max-h-full max-w-full rounded-lg object-contain shadow-2xl"}
          /></div>
        ) : isPdf ? (
          <iframe src={src} title={name} className="h-full w-full max-w-5xl rounded-lg bg-white shadow-2xl" data-pdf-frame />
        ) : isText ? (
          <TextPreview src={src} name={name} />
        ) : (
          <div className="grid place-items-center gap-3 text-center">
            <span className="grid size-14 place-items-center rounded-2xl bg-white/10 text-[22px]">📎</span>
            <p className="text-[13px] text-white/60">此格式暂不支持在线预览</p>
            {allowPrint && (
              <a href={src} className="rounded-md bg-primary px-4 py-2 text-[13px] text-white no-underline hover:opacity-90" download={name}>
                下载文件
              </a>
            )}
          </div>
        )}
      </div>
      {isImage && <div className="mt-3 flex shrink-0 justify-center" onClick={(event) => event.stopPropagation()}><div className="flex items-center gap-1 rounded-lg bg-white/10 p-1 text-white shadow-lg" role="group" aria-label="图片缩放">
        <button type="button" aria-label="缩小图片" title="缩小" aria-disabled={imageError || zoom <= IMAGE_ZOOM_LEVELS[0]} onClick={() => { if (!imageError) setZoom((value) => stepImageZoom(value, -1)); }} className="grid size-9 place-items-center rounded hover:bg-white/15 aria-disabled:opacity-35"><Minus size={17}/></button>
        <span className="min-w-14 text-center text-[13px] tabular-nums" aria-label={`缩放比例，相对于适应窗口 ${Math.round(zoom * 100)}%`}>{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="放大图片" title="放大" aria-disabled={imageError || zoom >= IMAGE_ZOOM_LEVELS[IMAGE_ZOOM_LEVELS.length - 1]} onClick={() => { if (!imageError) setZoom((value) => stepImageZoom(value, 1)); }} className="grid size-9 place-items-center rounded hover:bg-white/15 aria-disabled:opacity-35"><Plus size={17}/></button>
        <span className="mx-1 h-5 w-px bg-white/20"/>
        <button type="button" aria-label="适应窗口" title="适应窗口" aria-disabled={imageError || zoom === 1} onClick={() => { if (!imageError) setZoom(1); }} className="grid size-9 place-items-center rounded hover:bg-white/15 aria-disabled:opacity-35"><Maximize2 size={16}/></button>
        <button type="button" aria-label="顺时针旋转图片" title="顺时针旋转" aria-disabled={imageError} onClick={() => { if (!imageError) setRotation((value) => (value + 90) % 360); }} className="grid size-9 place-items-center rounded hover:bg-white/15 aria-disabled:opacity-35"><RotateCw size={17}/></button>
      </div></div>}
    </div>
  );
}

/** 文本/代码内容预览（截断到 64KB，自动识别超长换行）。 */
function TextPreview({ src, name }: { src: string; name: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    fetch(src, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const t = await r.text();
        if (alive) setContent(t.length > 64 * 1024 ? t.slice(0, 64 * 1024) + "\n…（内容过长，已截断）" : t);
      })
      .catch((e) => alive && setErr(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [src]);
  if (err) return <p className="text-[13px] text-white/60">加载失败：{err}</p>;
  if (content === null) return <p className="text-[13px] text-white/60">加载中…</p>;
  return (
    <pre className="max-h-full w-full max-w-4xl overflow-auto rounded-lg bg-white p-4 font-mono text-[12.5px] leading-5 text-foreground shadow-2xl" data-text-preview={name}>
      {content}
    </pre>
  );
}

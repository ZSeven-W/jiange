import { useEffect, useState } from "react";

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
  const isImage = mime?.startsWith("image/");
  const isPdf = mime === "application/pdf";
  const isText = !!mime && (mime.startsWith("text/") || /^(application\/(json|xml|javascript|x-yaml|sql))$/.test(mime));
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/80 p-6"
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
        <button className="ml-auto rounded-full bg-white/10 px-3 py-1.5 text-[13px] text-white hover:bg-white/20" aria-label="关闭">
          ✕
        </button>
      </div>
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto" onClick={(e) => e.stopPropagation()}>
        {isImage ? (
          <img
            src={src}
            alt={name}
            draggable={allowPrint}
            data-document-print-restricted={!allowPrint ? "true" : undefined}
            onContextMenu={(event) => {
              if (!allowPrint) event.preventDefault();
            }}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
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

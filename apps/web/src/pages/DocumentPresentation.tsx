import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, Maximize2, MessageSquare, Minimize2 } from "lucide-react";
import type { DocView } from "@/lib/api";
import { DocumentCover } from "@/components/DocumentCover";
import { displayDocumentIcon } from "@/components/DocumentGlyph";
import { ReadOnlyDoc } from "./ReadOnlyDoc";
import { AttachmentPreview } from "./AttachmentPreview";

/** A live, read-only projection; no document content is copied to another service. */
export function DocumentPresentation({ id, userId, title, icon, view, synced, allowCopy, allowPrint, commentsOpen, onComments, onRevalidate, onClose, children }: {
  id: number; userId: number; title: string; icon?: string; view: DocView; synced: boolean;
  allowCopy: boolean; allowPrint: boolean; commentsOpen: boolean;
  onComments?: () => void; onRevalidate: () => void; onClose: () => void; children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  const ownedFullscreen = useRef(false);
  const [fullscreen, setFullscreen] = useState(() => typeof document !== "undefined" && !!document.fullscreenElement);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{ src: string; name: string; mime?: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    back.current?.focus();
    const change = () => { if (!document.fullscreenElement) ownedFullscreen.current = false; setFullscreen(!!document.fullscreenElement); };
    document.addEventListener("fullscreenchange", change);
    return () => {
      mounted.current = false;
      document.removeEventListener("fullscreenchange", change);
      if (ownedFullscreen.current && document.fullscreenElement === document.documentElement && typeof document.exitFullscreen === "function") void document.exitFullscreen().catch(() => {});
      ownedFullscreen.current = false;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); ownedFullscreen.current = false; }
      else {
        await document.documentElement.requestFullscreen();
        if (!mounted.current) { if (document.fullscreenElement === document.documentElement) await document.exitFullscreen(); return; }
        ownedFullscreen.current = true;
      }
      if (mounted.current) setNotice("");
    } catch { if (mounted.current) setNotice("当前浏览器无法切换全屏，仍可在演示视图中阅读。"); }
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (preview) { setPreview(null); return; }
      if (commentsOpen && onComments) { onComments(); return; }
      if (ownedFullscreen.current && document.fullscreenElement && typeof document.exitFullscreen === "function") { void document.exitFullscreen().catch(() => {}); return; }
      onClose(); return;
    }
    if (event.key !== "Tab" || !root.current) return;
    const items = [...root.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((item) => item.getClientRects().length > 0);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0 || event.shiftKey && i === 0 || !event.shiftKey && i === items.length - 1) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); }
  };
  const glyph = displayDocumentIcon(icon);
  return <div ref={root} role="dialog" aria-modal="true" aria-label="文档演示模式" data-document-presentation data-document-print-restricted={!allowPrint ? "true" : undefined} onKeyDown={keyDown} className="fixed inset-0 z-40 flex min-h-0 flex-col bg-surface text-foreground">
    <header className="flex h-14 shrink-0 items-center border-b px-3 sm:h-16 sm:px-10">
      <button ref={back} type="button" onClick={onClose} className="flex h-9 items-center gap-1 rounded px-2 text-[14px] hover:bg-hover"><ChevronLeft size={17}/><span>返回</span></button>
      <div className="ml-auto flex items-center gap-3">
        {onComments && <button type="button" aria-label={commentsOpen ? "关闭评论" : "打开评论"} aria-pressed={commentsOpen} onClick={onComments} className="grid size-8 place-items-center rounded-full border text-muted-foreground hover:bg-hover"><MessageSquare size={15}/></button>}
        {typeof document !== "undefined" && typeof document.documentElement.requestFullscreen === "function" && <button type="button" aria-label={fullscreen ? "退出全屏" : "进入全屏"} onClick={() => void toggleFullscreen()} className="grid size-8 place-items-center rounded-full border text-muted-foreground hover:bg-hover">{fullscreen ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button>}
      </div>
    </header>
    {!synced && <div role="status" className="border-b px-5 py-2 text-[13px] text-muted-foreground">文档尚未同步完成，演示内容可能包含未保存的修改。</div>}
    {notice && <div role="status" className="border-b px-5 py-2 text-[13px] text-muted-foreground">{notice}</div>}
    <main className={`min-h-0 flex-1 overflow-y-auto ${commentsOpen ? "sm:pr-[296px]" : ""}`} data-presentation-content data-document-print-restricted={!allowPrint ? "true" : undefined} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }} onContextMenu={(event) => { if (!allowCopy || !allowPrint) event.preventDefault(); }}>
      <DocumentCover id={id} userId={userId} visible enabled={false} hasIcon={!!glyph} allowCopy={allowCopy} allowPrint={allowPrint} onRevalidate={onRevalidate}>{({ hasCover }) => <article className={`mx-auto w-full max-w-[960px] px-7 pb-32 sm:px-16 ${hasCover ? "pt-8" : "pt-12 sm:pt-14"}`}>
        {glyph && <div aria-label="文档图标" className="mb-2 text-[32px] leading-none">{glyph}</div>}
        <h1 className="mb-8 break-words text-[32px] font-medium leading-[1.3]">{title.trim() || "未命名文档"}</h1>
        <ReadOnlyDoc view={view} disableFileDownloads={!allowPrint} onPreviewImage={(src, name, mime) => setPreview({ src, name, mime })}/>
      </article>}</DocumentCover>
    </main>
    {children}
    {preview && <AttachmentPreview src={preview.src} name={preview.name} mime={preview.mime} allowCopy={allowCopy} allowPrint={allowPrint} onClose={() => setPreview(null)} />}
  </div>;
}

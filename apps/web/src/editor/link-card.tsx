import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { copyableURL, safeURL } from "@/lib/safe-url";
import { Copy, ExternalLink, FileText, Globe, Pencil, Unlink } from "lucide-react";

/** 链接卡片上显示的域名与路径：去掉协议与末尾斜杠。 */
export function linkDisplay(href: string): { host: string; rest: string } {
  try {
    const u = new URL(href);
    const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`;
    return { host: u.host || href, rest };
  } catch {
    return { host: href, rest: "" };
  }
}

const btn = "grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground";

/** 飞书风格链接悬停卡片：链接地址 + 打开 / 复制 / 编辑 / 取消链接。 */
export function LinkCard({ href, docTitle, x, y, onOpen, onCopy, onEdit, onUnlink, onEnter, onLeave, onEditingChange, initialEditing = false }: {
  href: string; x: number; y: number;
  /** 文档提及（#/doc/ID）时的标题；显示为文档卡片而非网址。 */
  docTitle?: string;
  onOpen: () => void; onCopy: () => void;
  onEdit?: (url: string) => void; onUnlink?: () => void;
  onEnter?: () => void; onLeave?: () => void; onEditingChange?: (editing: boolean) => void;
  initialEditing?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(initialEditing ? href : null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ dx: 0, dy: 0, maxWidth: 420 });
  const placementRef = useRef(placement);
  useLayoutEffect(() => {
    const place = () => {
      const el = cardRef.current; if (!el) return;
      const viewport = window.visualViewport, left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const right = left + (viewport?.width ?? window.innerWidth), bottom = top + (viewport?.height ?? window.innerHeight);
      const maxWidth = Math.max(1, Math.min(420, right - left - 16));
      el.style.maxWidth = `${maxWidth}px`;
      const rect = el.getBoundingClientRect(), previous = placementRef.current, naturalLeft = rect.left - previous.dx, naturalTop = rect.top - previous.dy;
      const targetLeft = Math.max(left + 8, Math.min(naturalLeft, right - rect.width - 8));
      const above = naturalTop - rect.height - 30;
      const targetTop = naturalTop + rect.height > bottom - 8 && above >= top + 8 ? above : Math.max(top + 8, Math.min(naturalTop, bottom - rect.height - 8));
      const next = { dx: Math.round(targetLeft - naturalLeft), dy: Math.round(targetTop - naturalTop), maxWidth };
      if (next.dx !== previous.dx || next.dy !== previous.dy || next.maxWidth !== previous.maxWidth) { placementRef.current = next; setPlacement(next); }
    };
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true); window.visualViewport?.addEventListener("resize", place); window.visualViewport?.addEventListener("scroll", place);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); window.visualViewport?.removeEventListener("resize", place); window.visualViewport?.removeEventListener("scroll", place); };
  }, [x, y, editing]);
  const displayHref = typeof window === "undefined" ? href : copyableURL(href, window.location.href) ?? href;
  const { host, rest } = linkDisplay(displayHref);
  useEffect(() => () => onEditingChange?.(false), []);
  const valid = editing !== null && !!safeURL(editing.trim()) && editing.trim().length <= 8192;
  const stopEditing = () => { setEditing(null); onEditingChange?.(false); };
  return <div ref={cardRef} contentEditable={false} className="absolute z-30 flex h-10 items-center gap-1 rounded-lg border bg-surface pl-3 pr-1 text-[13px] shadow-[0_4px_16px_rgba(31,35,41,0.16)]" style={{ left: x + placement.dx, top: y + placement.dy, maxWidth: placement.maxWidth }} onMouseEnter={onEnter} onMouseLeave={onLeave} onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault(); }} data-link-card>
    {editing !== null && onEdit ? (
      <form className="flex min-w-0 items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (!valid) return; onEdit(editing.trim()); stopEditing(); }}>
        <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopEditing(); } }} className="h-7 w-64 min-w-0 flex-1 rounded border px-2 text-base outline-none focus:border-primary sm:text-[13px]" aria-label="链接地址" data-link-card-input />
        <button disabled={!valid} className="h-7 rounded bg-primary px-2.5 text-[13px] text-white disabled:opacity-40">确定</button>
      </form>
    ) : <>
      {docTitle !== undefined ? <>
        <FileText size={15} className="shrink-0 text-primary" />
        <a href={href} className="min-w-0 truncate font-medium text-foreground hover:text-primary" title={docTitle} onClick={(e) => { e.preventDefault(); onOpen(); }} data-link-card-doc>{docTitle || "未命名文档"}</a>
        <span className="shrink-0 text-[12px] text-subtle">云文档</span>
      </> : <><Globe size={14} className="shrink-0 text-subtle" />
      <a href={href} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-primary hover:underline" title={displayHref} onClick={(e) => { e.preventDefault(); onOpen(); }} data-link-card-url><span>{host}</span><span className="text-subtle">{rest}</span></a></>}
      <span className="mx-1 h-4 w-px shrink-0 bg-border" />
      <button type="button" className={btn} title={docTitle !== undefined ? "打开文档" : "打开链接"} aria-label={docTitle !== undefined ? "打开文档" : "打开链接"} onClick={onOpen} data-link-open><ExternalLink size={14} /></button>
      <button type="button" className={btn} title="复制链接" aria-label="复制链接" onClick={onCopy} data-link-copy><Copy size={14} /></button>
      {onEdit && docTitle === undefined && <button type="button" className={btn} title="编辑链接" aria-label="编辑链接" onClick={() => { onEditingChange?.(true); setEditing(href); }} data-link-edit><Pencil size={14} /></button>}
      {onUnlink && <button type="button" className={btn} title="取消链接" aria-label="取消链接" onClick={onUnlink} data-link-unlink><Unlink size={14} /></button>}
    </>}
  </div>;
}

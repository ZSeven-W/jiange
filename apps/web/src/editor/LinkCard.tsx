import { useState } from "react";
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

const btn = "grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground";

/** 飞书风格链接悬停卡片：链接地址 + 打开 / 复制 / 编辑 / 取消链接。 */
export function LinkCard({ href, docTitle, x, y, onOpen, onCopy, onEdit, onUnlink, onEnter, onLeave, initialEditing = false }: {
  href: string; x: number; y: number;
  /** 文档提及（#/doc/ID）时的标题；显示为文档卡片而非网址。 */
  docTitle?: string;
  onOpen: () => void; onCopy: () => void;
  onEdit?: (url: string) => void; onUnlink?: () => void;
  onEnter?: () => void; onLeave?: () => void;
  initialEditing?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(initialEditing ? href : null);
  const { host, rest } = linkDisplay(href);
  return <div contentEditable={false} className="absolute z-30 flex h-10 max-w-[420px] items-center gap-1 rounded-lg border bg-surface pl-3 pr-1 text-[13px] shadow-[0_4px_16px_rgba(31,35,41,0.16)]" style={{ left: x, top: y }} onMouseEnter={onEnter} onMouseLeave={onLeave} onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault(); }} data-link-card>
    {editing !== null && onEdit ? (
      <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (editing.trim()) onEdit(editing.trim()); setEditing(null); }}>
        <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }} className="h-7 w-64 rounded border px-2 text-[13px] outline-none focus:border-primary" aria-label="链接地址" data-link-card-input />
        <button className="h-7 rounded bg-primary px-2.5 text-[13px] text-white">确定</button>
      </form>
    ) : <>
      {docTitle !== undefined ? <>
        <FileText size={15} className="shrink-0 text-primary" />
        <a href={href} className="min-w-0 truncate font-medium text-foreground hover:text-primary" title={docTitle} onClick={(e) => { e.preventDefault(); onOpen(); }} data-link-card-doc>{docTitle || "未命名文档"}</a>
        <span className="shrink-0 text-[12px] text-subtle">云文档</span>
      </> : <><Globe size={14} className="shrink-0 text-subtle" />
      <a href={href} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-primary hover:underline" title={href} onClick={(e) => { e.preventDefault(); onOpen(); }} data-link-card-url><span>{host}</span><span className="text-subtle">{rest}</span></a></>}
      <span className="mx-1 h-4 w-px shrink-0 bg-border" />
      <button type="button" className={btn} title={docTitle !== undefined ? "打开文档" : "打开链接"} aria-label={docTitle !== undefined ? "打开文档" : "打开链接"} onClick={onOpen} data-link-open><ExternalLink size={14} /></button>
      <button type="button" className={btn} title="复制链接" aria-label="复制链接" onClick={onCopy} data-link-copy><Copy size={14} /></button>
      {onEdit && docTitle === undefined && <button type="button" className={btn} title="编辑链接" aria-label="编辑链接" onClick={() => setEditing(href)} data-link-edit><Pencil size={14} /></button>}
      {onUnlink && <button type="button" className={btn} title="取消链接" aria-label="取消链接" onClick={onUnlink} data-link-unlink><Unlink size={14} /></button>}
    </>}
  </div>;
}

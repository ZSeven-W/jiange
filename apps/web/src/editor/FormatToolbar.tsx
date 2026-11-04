import { useState } from "react";
import { cn } from "@/lib/utils";

const TYPES: [string, string][] = [["paragraph", "正文"], ["h1", "一级标题"], ["h2", "二级标题"], ["h3", "三级标题"], ["bullet", "无序列表"], ["ordered", "有序列表"], ["todo", "待办"], ["quote", "引用"], ["code", "代码块"]];
const MARKS: [string, string, string][] = [["bold", "B", "font-bold"], ["italic", "I", "italic font-serif"], ["underline", "U", "underline"], ["strike", "S", "line-through"], ["code", "</>", "font-mono text-[12px]"]];

export function FormatToolbar({ x, y, marks, blockType, onMark, onLink, onType, onComment }: {
  x: number; y: number; marks: Record<string, string>; blockType: string;
  onMark: (key: string, value?: string) => void; onLink: (url: string) => void; onType: (t: string) => void;
  onComment?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const label = TYPES.find(([t]) => t === blockType)?.[1] ?? "正文";
  return (
    <div
      data-format-toolbar
      className="absolute z-30 flex h-9 -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-lg border bg-surface px-1.5 shadow-[0_6px_24px_rgba(31,35,41,0.12)]"
      style={{ left: x, top: y - 8 }}
      onMouseDown={(e) => (e.target as HTMLElement).tagName !== "INPUT" && e.preventDefault()}
    >
      {link !== null ? (
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (link.trim()) onLink(link.trim()); setLink(null); }}>
          <input autoFocus value={link} onChange={(e) => setLink(e.target.value)} placeholder="粘贴或输入链接" className="h-7 w-56 rounded border px-2 text-[13px] outline-none focus:border-primary" />
          <button className="h-7 rounded bg-primary px-2.5 text-[13px] text-white">确定</button>
        </form>
      ) : (
        <>
          <div className="relative">
            <button className="flex h-7 items-center gap-1 rounded px-2 text-[13px] hover:bg-hover" onClick={() => setMenu((m) => !m)}>
              {label} <span className="text-[10px] text-subtle">▾</span>
            </button>
            {menu && (
              <div className="absolute left-0 top-8 w-32 rounded-lg border bg-surface p-1 shadow-lg">
                {TYPES.map(([t, l]) => (
                  <button key={t} className={cn("block w-full rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-hover", t === blockType && "text-primary")} onClick={() => { onType(t); setMenu(false); }}>
                    {l}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="mx-1 h-4 w-px bg-border" />
          {MARKS.map(([k, l, c]) => (
            <button key={k} title={k} onClick={() => onMark(k)} className={cn("grid h-7 min-w-7 place-items-center rounded px-1.5 text-[14px] hover:bg-hover", c, marks[k] && "bg-accent text-primary")}>
              {l}
            </button>
          ))}
          <button title="链接" onClick={() => (marks.link ? onMark("link", marks.link) : setLink(""))} className={cn("grid h-7 min-w-7 place-items-center rounded px-1.5 text-[13px] hover:bg-hover", marks.link && "bg-accent text-primary")}>
            🔗
          </button>
        </>
      )}
      {onComment && (
        <button className="mx-0.5 grid h-7 w-7 place-items-center rounded hover:bg-hover" title="评论" onClick={onComment} data-comment-btn>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 3h11v8h-6L4 14v-3H2.5z" />
          </svg>
        </button>
      )}
    </div>
  );
}

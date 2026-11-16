import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, WrapText } from "lucide-react";
import { cn } from "@/lib/utils";

export const CODE_LANGS: [string, string][] = [
  ["plain", "纯文本"], ["typescript", "TypeScript"], ["javascript", "JavaScript"], ["go", "Go"],
  ["python", "Python"], ["rust", "Rust"], ["java", "Java"], ["sql", "SQL"], ["json", "JSON"],
  ["bash", "Bash"], ["css", "CSS"], ["html", "HTML"],
];

export const codeLangLabel = (lang?: string) => CODE_LANGS.find(([v]) => v === lang)?.[1] ?? "纯文本";

/** 语言搜索：同时匹配标识与显示名，忽略大小写。 */
export function filterCodeLangs(query: string) {
  const q = query.trim().toLowerCase();
  return q ? CODE_LANGS.filter(([v, l]) => v.includes(q) || l.toLowerCase().includes(q)) : CODE_LANGS;
}

const keep = (e: React.MouseEvent) => e.preventDefault();

/** 飞书代码块顶部：左侧语言选择（可搜索），右侧悬停显示 自动换行 / 复制。 */
export function CodeBlockHeader({ lang, wrap, onLang, onWrap, onCopy, initialOpen = false }: {
  lang?: string; wrap: boolean;
  onLang?: (lang: string) => void; onWrap?: (wrap: boolean) => void; onCopy?: () => Promise<void> | void;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [open]);
  useEffect(() => { if (!copied) return; const t = window.setTimeout(() => setCopied(false), 1500); return () => window.clearTimeout(t); }, [copied]);
  const items = filterCodeLangs(query);
  return <div contentEditable={false} className="flex h-[38px] select-none items-center gap-1 pl-[22px] pr-2 pt-1 text-[14px] text-subtle" data-code-header>
    <div ref={ref} className="relative">
      <button type="button" disabled={!onLang} onMouseDown={keep} onClick={() => { setOpen((v) => !v); setQuery(""); }} className={cn("flex h-6 items-center gap-0.5 rounded px-1.5", onLang && "hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10")} title="代码语言" aria-haspopup="listbox" aria-expanded={open} data-code-lang={lang ?? "plain"}>
        {codeLangLabel(lang)}{onLang && <ChevronDown size={12} />}
      </button>
      {open && onLang && <div className="absolute left-0 top-7 z-40 w-44 rounded-lg border bg-surface p-1 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.12)]" data-code-lang-pop>
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && items[0]) { e.preventDefault(); onLang(items[0][0]); setOpen(false); }
        }} placeholder="搜索语言" className="mb-1 h-7 w-full rounded border px-2 text-[12px] outline-none focus:border-primary" data-code-lang-search />
        <div role="listbox" className="max-h-56 overflow-y-auto">
          {items.map(([v, l]) => <button key={v} type="button" role="option" aria-selected={v === (lang ?? "plain")} onMouseDown={keep} onClick={() => { onLang(v); setOpen(false); }} className={cn("flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-hover", v === (lang ?? "plain") && "text-primary")} data-code-lang-option={v}>{l}{v === (lang ?? "plain") && <Check size={13} />}</button>)}
          {!items.length && <div className="px-2 py-1.5 text-subtle">没有匹配的语言</div>}
        </div>
      </div>}
    </div>
    <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      {onWrap && <button type="button" onMouseDown={keep} onClick={() => onWrap(!wrap)} aria-pressed={wrap} className={cn("flex h-6 items-center gap-1 rounded px-1.5 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10", wrap && "text-primary")} title="自动换行" data-code-wrap><WrapText size={13} />自动换行</button>}
      {onCopy && <button type="button" onMouseDown={keep} onClick={async () => { await onCopy(); setCopied(true); }} className="flex h-6 items-center gap-1 rounded px-1.5 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10" title="复制代码" data-code-copy>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "已复制" : "复制"}</button>}
    </span>
  </div>;
}

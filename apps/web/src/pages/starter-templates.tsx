import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { templatesApi } from "@/lib/api";
import { SearchIcon } from "@/components/feishu-icons";
import { parseMarkdown } from "@/lib/markdown";
import { TemplateLibrary } from "./template-library";
import { STARTER_TEMPLATES, type StarterTemplate } from "./starter-template-data";

export { STARTER_TEMPLATES } from "./starter-template-data";
export type { StarterTemplate } from "./starter-template-data";

/** Preview the same blocks that will be inserted instead of decorative placeholders. */
function TemplatePreview({ template }: { template: StarterTemplate }) {
  const blocks = parseMarkdown(template.body);
  return <span aria-hidden="true" className="mx-2 mt-1.5 block h-[119px] overflow-hidden rounded-[2px] border border-[#f0f1f3] bg-white px-[7px] pb-2 pt-[5px] text-[#525866]">
    {blocks.map((block, index) => {
      const text = block.spans.map((span) => span.text).join("") || block.text;
      if (/^h[1-3]$/.test(block.type)) return <span key={index} className="mb-[2px] mt-[4px] block truncate text-[7px] font-semibold leading-[10px] text-[#1f2329] first:mt-0">{text}</span>;
      if (block.type === "todo") return <span key={index} className="flex min-h-[10px] items-start gap-[3px] text-[6px] leading-[10px]"><span className={`mt-[2px] grid size-[6px] shrink-0 place-items-center rounded-[1px] border ${block.props.checked ? "border-[#3370ff] bg-[#3370ff] text-white" : "border-[#aeb5c0]"}`}>{block.props.checked ? "✓" : ""}</span><span className="min-w-0 truncate">{text}</span></span>;
      if (block.type === "bullet" || block.type === "ordered") return <span key={index} className="flex min-h-[10px] items-start gap-[4px] text-[6px] leading-[10px]"><span className="shrink-0 text-[#8f959e]">•</span><span className="min-w-0 truncate">{text}</span></span>;
      return <span key={index} className="block min-h-[10px] truncate text-[6px] leading-[10px]">{text}</span>;
    })}
  </span>;
}

function MoreTemplatesIcon() {
  return <span aria-hidden="true" className="relative block h-12 w-12">
    <span className="absolute left-[7px] top-[5px] h-[36px] w-[30px] rounded-[2px] bg-[#e5e6e8]" />
    <span className="absolute left-[13px] top-[17px] h-[27px] w-[20px] rounded-[2px] border border-[#99a8c4] bg-white px-[3px] pt-[5px]"><span className="mb-[3px] block h-px w-full bg-[#aebbd3]"/><span className="block h-px w-3/4 bg-[#aebbd3]"/></span>
    <span className="absolute right-0 top-0 grid size-[18px] place-items-center rounded-full bg-[#3370ff] text-[14px] leading-none text-white">›</span>
  </span>;
}

/** Reserve one 150px card for the library entry, with 16px gaps. */
export function starterTemplateCount(width: number): number {
  const fitted = Math.max(0, Math.min(4, Math.floor((width + 16) / 166) - 1));
  return width >= 200 ? Math.max(1, fitted) : fitted;
}

/** Real starter documents shown only while the collaborative body is empty. */
export function StarterTemplates({ onChoose, onHide, disabled = false }: { onChoose: (template: StarterTemplate) => void; onHide: () => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(4);
  const [cardWidth, setCardWidth] = useState(150);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = section.current;
    if (!node) return;
    const measure = () => { const width = node.getBoundingClientRect().width; if (width > 0) { setVisibleCount(starterTemplateCount(width)); setCardWidth(Math.min(150, width >= 200 ? (width - 16) / 2 : width)); } };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    if (!observer) window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); if (!observer) window.removeEventListener("resize", measure); };
  }, []);
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ["my-templates"], queryFn: templatesApi.list, staleTime: 30_000 });
  const own: (StarterTemplate & { userTemplateId: number })[] = (mine.data ?? []).map((t) => ({ id: `u:${t.id}`, name: t.name, body: t.body, color: "#eef3ff", userTemplateId: t.id }));
  const items = [...own, ...STARTER_TEMPLATES].filter((t) => t.name.includes(query.trim()));
  const visible = query.trim() ? items : items.slice(0, visibleCount);
  return <section ref={section} className="mt-auto w-full pt-20" aria-label="文档模板" data-starter-templates>
    <div className="mb-4 flex items-center justify-between gap-4">
      <label className="flex h-8 w-[240px] max-w-full items-center gap-2 rounded-md border px-3 text-subtle focus-within:border-primary"><SearchIcon className="size-[15px] shrink-0"/><span className="sr-only">搜索模板</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入关键词搜索模板" className="w-full min-w-0 bg-transparent text-[16px] text-foreground outline-none placeholder:text-subtle sm:text-[13px]"/></label>
      <button type="button" onClick={onHide} className="shrink-0 rounded px-1 text-[13px] text-muted-foreground hover:text-foreground">隐藏</button>
    </div>
    <div className="flex gap-4 overflow-x-auto pb-1">
      {visible.map((t) => <span key={t.id} className="group relative shrink-0">
        <button type="button" disabled={disabled} onClick={() => onChoose(t)} style={{ width: cardWidth }} className="h-[162px] overflow-hidden rounded-lg border bg-surface text-left shadow-[0_2px_10px_rgba(31,35,41,0.05)] transition-shadow hover:shadow-[0_5px_18px_rgba(31,35,41,0.12)] focus-visible:outline-2 focus-visible:outline-primary" data-starter-template={t.id}>
          <span className="flex items-center gap-1 px-2.5 pt-2 text-[12px] font-medium"><span className="truncate">{t.name}</span>{"userTemplateId" in t && <span className="shrink-0 rounded bg-[#e1eaff] px-1 text-[10px] font-normal text-primary">我的</span>}</span>
          <TemplatePreview template={t} />
        </button>
        {"userTemplateId" in t && <button type="button" aria-label={`删除模板「${t.name}」`} title="删除模板" onClick={() => { void templatesApi.remove((t as { userTemplateId: number }).userTemplateId).then(() => qc.invalidateQueries({ queryKey: ["my-templates"] })); }} className="absolute right-1.5 top-1.5 hidden size-5 place-items-center rounded bg-surface text-[12px] text-muted-foreground shadow group-hover:grid hover:text-destructive" data-delete-template>×</button>}
      </span>)}
      {!query.trim() && <button type="button" disabled={disabled} onClick={() => setLibraryOpen(true)} style={{ width: cardWidth }} className="flex h-[162px] max-w-full shrink-0 flex-col items-center justify-center gap-2 rounded-lg border bg-surface text-[13px] text-muted-foreground shadow-[0_2px_10px_rgba(31,35,41,0.05)] hover:bg-hover/40"><MoreTemplatesIcon />更多模板</button>}
      {items.length === 0 && <p className="py-8 text-[13px] text-subtle">没有找到匹配的模板</p>}
    </div>
    {libraryOpen && <TemplateLibrary onChoose={onChoose} onClose={() => setLibraryOpen(false)} disabled={disabled}/>}
  </section>;
}

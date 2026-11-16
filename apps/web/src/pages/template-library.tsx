import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Search, X } from "lucide-react";
import { templatesApi } from "@/lib/api";
import { parseMarkdown } from "@/lib/markdown";
import { TemplateGlyph } from "@/components/drive-action-icons";
import { useI18n } from "@/lib/i18n";
import { STARTER_TEMPLATES, type StarterTemplate } from "./starter-template-data";

type TemplateCategory = "recommended" | "mine" | "meeting" | "weekly" | "project" | "personal";
type LibraryTemplate = StarterTemplate & { userTemplateId?: number };
const CATEGORIES: { id: TemplateCategory; label: string }[] = [
  { id: "mine", label: "我的模板" },
  { id: "recommended", label: "推荐" },
  { id: "meeting", label: "会议" },
  { id: "weekly", label: "周报日报" },
  { id: "project", label: "项目管理" },
  { id: "personal", label: "个人" },
];
const TEMPLATE_CATEGORIES: Record<string, TemplateCategory> = { meeting: "meeting", weekly: "weekly", project: "project", brief: "project", todo: "personal", notes: "personal" };

export function filterTemplateCatalog(items: LibraryTemplate[], category: TemplateCategory, query: string): LibraryTemplate[] {
  const normalized = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    const categoryMatches = category === "recommended" || (category === "mine" ? item.userTemplateId !== undefined : item.userTemplateId === undefined && TEMPLATE_CATEGORIES[item.id] === category);
    return categoryMatches && (!normalized || item.name.toLocaleLowerCase().includes(normalized));
  });
}

/** A local catalog of the templates Jiange can actually apply. */
export function TemplateLibrary({ onChoose, onClose, disabled = false }: { onChoose: (template: StarterTemplate) => void; onClose: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  const [category, setCategory] = useState<TemplateCategory>("recommended");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<LibraryTemplate | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const previewTrigger = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  const previewRef = useRef(preview);
  onCloseRef.current = onClose;
  previewRef.current = preview;
  const mine = useQuery({ queryKey: ["my-templates"], queryFn: templatesApi.list, staleTime: 30_000 });
  const own: LibraryTemplate[] = (mine.data ?? []).map((item) => ({ id: `u:${item.id}`, name: item.name, body: item.body, color: "#eef3ff", userTemplateId: item.id }));
  const items = filterTemplateCatalog([...own, ...STARTER_TEMPLATES], category, query);
  const showEmpty = items.length === 0 && !(category === "mine" && (mine.isPending || mine.isError));

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (previewRef.current) setPreview(null); else onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const nodes = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? [])].filter((node) => node.getClientRects().length > 0);
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (preview) back.current?.focus();
    else if (previewTrigger.current !== null) {
      const id = previewTrigger.current;
      const trigger = [...(panel.current?.querySelectorAll<HTMLElement>("[data-preview-template]") ?? [])].find((node) => node.dataset.previewTemplate === id);
      (trigger ?? close.current)?.focus();
      previewTrigger.current = null;
    }
  }, [preview]);

  const useTemplate = (item: LibraryTemplate) => { if (disabled) return; onChoose(item); onClose(); };
  return createPortal(<div className="fixed inset-0 z-[100] grid place-items-center bg-black/50 p-3 sm:p-10" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label={preview ? `${t("模板预览")}：${preview.name}` : t("模板库")} className="flex h-[min(900px,calc(100dvh-24px))] w-full max-w-[1100px] flex-col overflow-hidden rounded-lg border bg-surface shadow-2xl sm:w-[calc(100%-72px)]">
      {preview ? <>
        <header className="flex h-16 shrink-0 items-center gap-3 border-b px-4 sm:px-6"><button ref={back} type="button" aria-label={t("返回模板库")} onClick={() => setPreview(null)} className="grid size-8 shrink-0 place-items-center rounded hover:bg-hover"><ArrowLeft size={18}/></button><div className="min-w-0 flex-1"><h2 className="truncate text-[15px] font-semibold">{preview.name}</h2><p className="text-[12px] text-subtle">{t("模板预览")}</p></div><button ref={close} type="button" aria-label={t("关闭模板库")} onClick={onClose} className="grid size-8 place-items-center rounded text-muted-foreground hover:bg-hover"><X size={18}/></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto bg-[#f5f6f7] p-4 sm:p-8 dark:bg-background"><article className="mx-auto min-h-full max-w-[720px] rounded bg-surface px-6 py-8 shadow-sm sm:px-12"><h3 className="mb-7 break-words text-[24px] font-semibold">{preview.name}</h3><TemplateBody template={preview}/></article></div>
        <footer className="flex h-16 shrink-0 items-center justify-end border-t px-5"><button type="button" disabled={disabled} onClick={() => useTemplate(preview)} className="rounded-md bg-primary px-4 py-2 text-[13px] font-medium text-white hover:bg-primary-hover disabled:opacity-50">{t("使用该模板")}</button></footer>
      </> : <>
        <header className="flex h-16 shrink-0 items-center gap-3 border-b px-4 sm:px-6"><span className="grid size-6 shrink-0 place-items-center"><TemplateGlyph/></span><h2 className="shrink-0 text-[16px] font-semibold">{t("模板库")}</h2><label className="ml-auto flex h-9 w-full min-w-0 max-w-[264px] items-center gap-2 rounded-md border bg-background px-3 text-subtle"><Search size={15} className="shrink-0"/><span className="sr-only">{t("搜索模板库")}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索模板")} className="min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none sm:text-[13px]"/></label><button ref={close} type="button" aria-label={t("关闭模板库")} onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded text-muted-foreground hover:bg-hover"><X size={18}/></button></header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav aria-label={t("模板分类")} className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-[196px] sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-2">{CATEGORIES.map((entry) => <button key={entry.id} type="button" aria-pressed={category === entry.id} onClick={() => setCategory(entry.id)} className={`h-9 shrink-0 rounded-md px-4 text-left text-[14px] ${category === entry.id ? "bg-accent font-medium text-accent-foreground" : "text-foreground hover:bg-hover"}`}>{t(entry.label)}</button>)}</nav>
          <div className="min-h-0 flex-1 overflow-y-auto bg-[#f5f6f7] p-4 sm:p-6 dark:bg-background"><h3 className="mb-5 text-[16px] font-semibold">{t(category === "recommended" ? "为你推荐" : CATEGORIES.find((entry) => entry.id === category)?.label ?? "模板库")}</h3>
            {mine.isError && (category === "mine" || category === "recommended") && <p role="alert" className="mb-4 text-[13px] text-destructive">{t("个人模板加载失败。")}<button type="button" className="underline" onClick={() => void mine.refetch()}>{t("重试")}</button></p>}
            {category === "mine" && mine.isPending && <p role="status" className="text-[13px] text-subtle">{t("加载中…")}</p>}
            {showEmpty && <p className="py-12 text-center text-[13px] text-subtle">{t(category === "mine" && !query.trim() ? "还没有个人模板" : "没有找到匹配的模板")}</p>}
            {items.length > 0 && <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3">{items.map((item) => <article key={item.id} className="group min-w-0 rounded-lg border bg-surface p-3 shadow-sm"><h4 className="truncate text-[14px] font-medium">{item.name}</h4><div className="mt-3 h-[164px] overflow-hidden rounded border bg-white px-3 py-2 text-[#525866]"><TemplateBody template={item} compact/></div><div className="mt-3 flex justify-end gap-2"><button type="button" data-preview-template={item.id} aria-label={`${t("预览")} ${item.name}`} onClick={() => { previewTrigger.current = item.id; setPreview(item); }} className="rounded-md border px-3 py-1.5 text-[13px] hover:bg-hover">{t("预览")}</button><button type="button" aria-label={`${t("使用")} ${item.name}`} disabled={disabled} onClick={() => useTemplate(item)} className="rounded-md bg-primary px-3 py-1.5 text-[13px] text-white hover:bg-primary-hover disabled:opacity-50">{t("使用")}</button></div></article>)}</div>}
          </div>
        </div>
      </>}
    </div>
  </div>, document.body);
}

function TemplateBody({ template, compact = false }: { template: StarterTemplate; compact?: boolean }) {
  return <div className={compact ? "text-[9px] leading-[15px]" : "text-[14px] leading-7"}>{parseMarkdown(template.body).map((block, index) => {
    const text = block.spans.length ? block.spans.map((span, i) => <span key={i} className={`${span.marks.bold ? "font-semibold " : ""}${span.marks.italic ? "italic " : ""}${span.marks.strike ? "line-through " : ""}${span.marks.code ? "rounded bg-[#f2f3f5] px-1 font-mono " : ""}${span.marks.link ? "text-primary underline" : ""}`}>{span.text}</span>) : block.text || "\u00a0";
    if (/^h[1-6]$/.test(block.type)) return <p key={index} className={compact ? "mt-2 font-semibold text-[#1f2329] first:mt-0" : "mb-2 mt-6 text-[18px] font-semibold first:mt-0"}>{text}</p>;
    if (block.type === "divider") return <hr key={index} className="my-3"/>;
    if (block.type === "todo") return <p key={index}>{block.props.checked ? "☑" : "□"} {text}</p>;
    if (block.type === "bullet" || block.type === "ordered") return <p key={index}>• {text}</p>;
    if (block.type === "code") return <pre key={index} className="my-2 overflow-x-auto rounded bg-[#f2f3f5] p-2 font-mono">{text}</pre>;
    if (block.type === "quote") return <blockquote key={index} className="my-2 border-l-2 pl-3">{text}</blockquote>;
    return <p key={index} className="whitespace-pre-wrap break-words">{text}</p>;
  })}</div>;
}

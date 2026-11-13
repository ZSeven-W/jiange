import { useEffect, useRef, useState } from "react";
import { Eye, Info, ListFilter, ScrollText, X } from "lucide-react";
import type { DocMeta } from "@/lib/api";
import type { DocumentTextStats } from "./docInfoStats";
import { formatEditTime } from "./docHeaderMeta";
import { cn } from "@/lib/utils";

type Tab = "overview" | "visits" | "activity";
const TABS = [{ id: "overview", label: "信息与数据", icon: ListFilter }, { id: "visits", label: "访问记录", icon: Eye }, { id: "activity", label: "操作记录", icon: ScrollText }] as const;

export function DocumentInfoDialog({ meta, stats, comments, synced, allowCopy, allowPrint, onClose }: { meta: DocMeta; stats: DocumentTextStats | null; comments: number | null; synced: boolean; allowCopy: boolean; allowPrint: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === items.length - 1) {
        event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
  }, [onClose]);
  const card = "flex min-h-10 items-center gap-3 rounded-md bg-[#F5F6F7] px-4 text-[14px] dark:bg-hover";
  const label = "shrink-0 text-[#8F959E]";
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="doc-info-title" data-document-print-restricted={!allowPrint ? "true" : undefined} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }} className="flex max-h-[min(620px,calc(100dvh-24px))] min-h-0 w-full max-w-[840px] flex-col overflow-hidden rounded-lg bg-surface text-foreground shadow-xl outline-none">
      <header className="flex h-[64px] shrink-0 items-center border-b px-5 text-[16px] font-medium sm:h-[72px] sm:px-6"><h2 id="doc-info-title">文档信息</h2><button type="button" aria-label="关闭文档信息" onClick={onClose} className="ml-auto grid size-9 place-items-center rounded text-[#646A73] hover:bg-hover"><X size={18}/></button></header>
      <div className="flex min-h-0 flex-1 flex-col sm:min-h-[488px] sm:flex-row">
        <nav aria-label="文档信息分类" className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2 sm:w-[224px] sm:flex-col sm:border-b-0 sm:border-r sm:py-3">
          {TABS.map(({ id, label: text, icon: Icon }) => <button key={id} type="button" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)} className={cn("flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-left text-[14px] sm:h-12 sm:w-full", tab === id ? "bg-[#E5EDFF] font-medium text-[#1456F0] dark:bg-primary/20" : "text-foreground hover:bg-hover")}><Icon size={17}/>{text}</button>)}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {tab === "overview" ? <>
            <h3 className="mb-3 text-[14px] font-medium">概览</h3>
            <div className="grid grid-cols-1 gap-2 min-[520px]:grid-cols-2">
              <div className={card}><span className={label}>所有者</span><span title="当前服务未提供所有者信息">—</span></div>
              <div className={card}><span className={label}>创建者</span><span className="truncate">{meta.creatorName || "—"}</span></div>
              <div className={card}><span className={label}>创建时间</span><span>{formatEditTime(meta.createdAt) || "—"}</span></div>
              <div className={card}><span className={label}>最近修改</span><span>{formatEditTime(meta.updatedAt) || "—"}</span></div>
            </div>
            <h3 className="mb-3 mt-4 text-[14px] font-medium">文档统计</h3>
            <div className="grid grid-cols-1 gap-2 min-[520px]:grid-cols-2">
              <div className={card}><span className={label}>正文字符（不含空白）</span><strong className="text-[18px] font-medium">{stats?.nonWhitespace ?? "—"}</strong></div>
              <div className={card}><span className={label}>正文字符（含空白）</span><strong className="text-[18px] font-medium">{stats?.characters ?? "—"}</strong></div>
              <div className={card}><span className={label}>大小</span><span title="当前服务未提供文档大小">—</span></div>
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[#8F959E]">统计已加载的正文文字、表格可见单元格、图片说明和流程图文字，不含标题与公式源码。{!synced && "文档尚未同步完成，结果可能变化。"}</p>
            <h3 className="mb-3 mt-4 text-[14px] font-medium">互动统计</h3>
            <div className="grid grid-cols-2 gap-2 min-[520px]:grid-cols-4">{[["访问人数", "—"], ["访问次数", "—"], ["点赞总数", "—"], ["评论总数", comments ?? "—"]].map(([name, value]) => <div key={name} className="flex min-h-[90px] flex-col items-center justify-center gap-2 rounded-md bg-[#F5F6F7] text-[13px] text-[#8F959E] dark:bg-hover"><span>{name}</span><span className="text-[18px] text-foreground">{value}</span></div>)}</div>
            <p className="mt-2 text-[12px] text-[#8F959E]">“—”表示当前数据不可用。</p>
          </> : <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-center text-[14px] text-subtle"><Info size={28} strokeWidth={1.4}/><p>{tab === "visits" ? "访问记录尚未采集" : "操作记录尚未采集"}</p><p className="text-[12px]">当前无法显示{tab === "visits" ? "访问者" : "操作"}信息。</p></div>}
        </div>
      </div>
    </section>
  </div>;
}

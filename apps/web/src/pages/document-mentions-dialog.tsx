import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MapPin, UsersRound, X } from "lucide-react";
import { Avatar } from "@/components/brand";
import { colorFor } from "@/lib/presence";
import { useI18n } from "@/lib/i18n";
import type { MentionSummary, MentionedPerson } from "./document-mentions";

export function DocumentMentionsDialog({ summary, synced, allowCopy, allowPrint, onJump, onClose }: { summary: MentionSummary; synced: boolean; allowCopy: boolean; allowPrint: boolean; onJump: (person: MentionedPerson) => boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  const panel = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null), onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const nodes = [...(panel.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])].filter((node) => node.getClientRects().length > 0);
      if (!nodes.length) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === nodes[0] || !panel.current?.contains(document.activeElement))) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
      else if (!event.shiftKey && (document.activeElement === nodes[nodes.length - 1] || !panel.current?.contains(document.activeElement))) { event.preventDefault(); nodes[0].focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="fixed inset-0 z-[100] grid place-items-center bg-black/50 p-3" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-label={t("提及的人")} data-document-print-restricted={!allowPrint ? "true" : undefined} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }} className="flex h-[min(420px,calc(100dvh-24px))] w-full max-w-[480px] flex-col overflow-hidden rounded-lg bg-surface shadow-xl">
      <header className="flex h-14 shrink-0 items-center px-6"><h2 className="text-[16px] font-medium">{t("提及的人")}</h2><button ref={close} type="button" aria-label={t("关闭提及的人")} onClick={onClose} className="ml-auto grid size-8 place-items-center rounded text-muted-foreground hover:bg-hover"><X size={18}/></button></header>
      <div className="flex h-10 shrink-0 items-center border-b px-6 text-[14px]"><span className="flex h-full items-center border-b-2 border-primary font-medium text-primary">{t("正文提及")} ({summary.people.length})</span></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">{summary.people.length === 0 ? <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-subtle"><UsersRound size={40} strokeWidth={1.2}/><span>{t("正文中暂未提及任何人")}</span></div> : summary.people.map((person) => <div key={person.userId} className="flex min-h-14 items-center gap-3"><Avatar name={person.name || "?"} color={colorFor(person.userId - 1)} size={32}/><div className="min-w-0 flex-1"><div className="truncate text-[14px]">{person.name || t("未知成员")}</div><div className="text-[12px] text-subtle">{t("提及 {count} 处", { count: person.count })}{!person.resolvedName && ` · ${t("名称来自文档")}`}</div></div><button type="button" aria-label={t("定位 {name}", { name: person.name || t("未知成员") })} onClick={() => { setError(""); if (onJump(person)) onClose(); else setError(t("提及内容已变化，请重新打开后重试。")); }} className="flex h-8 shrink-0 items-center gap-1 rounded px-2 text-[13px] text-primary hover:bg-hover"><MapPin size={14}/>{t("定位")}</button></div>)}</div>
      <footer className="shrink-0 border-t px-6 py-3 text-[12px] leading-5 text-subtle">{t("仅统计正文提及；通知状态暂不可用。")}{!synced && ` ${t("当前文档尚未同步，结果可能变化。")}`}{summary.truncated && ` ${t("内容较多，仅显示部分结果。")}`}{error && <p role="alert" className="mt-1 text-destructive">{error}</p>}</footer>
    </section>
  </div>, document.body);
}

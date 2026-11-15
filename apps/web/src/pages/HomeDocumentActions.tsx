import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, MoreHorizontal, Pin, Share2, Star } from "lucide-react";
import type { DocMeta } from "@/lib/api";
import { t } from "@/lib/i18n";
import { docTitle } from "@/components/Sidebar";

export function HomeDocumentActions({ doc, starred, pinned, ready, busy, onFavorite, onPin, onCopy, onShare }: {
  doc: DocMeta; starred: boolean; pinned: boolean; ready: boolean; busy: boolean;
  onFavorite: () => void; onPin: () => void; onCopy: () => void; onShare: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    const resize = () => setOpen(false);
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape); window.addEventListener("resize", resize); window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("resize", resize); window.removeEventListener("scroll", scroll, true); };
  }, [open]);
  const show = () => {
    if (open) { setOpen(false); return; }
    const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
    const width = Math.min(208, window.innerWidth - 16), height = 168;
    setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)) }); setOpen(true);
  };
  const item = "flex h-9 w-full items-center gap-2 rounded px-3 text-left text-[13px] text-[#1f2329] hover:bg-[#f2f3f5] focus:bg-[#f2f3f5] focus:outline-none disabled:opacity-40";
  return <><button ref={trigger} type="button" aria-label={`${docTitle(doc)} ${t("更多操作")}`} aria-haspopup="menu" aria-expanded={open} onClick={show} className="grid size-8 place-items-center rounded text-[#646a73] hover:bg-[#e9ebef] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary"><MoreHorizontal size={17}/></button>
    {open && createPortal(<div ref={menu} role="menu" aria-label={t("更多操作")} style={{ left: position.left, top: position.top, width: "min(208px, calc(100vw - 16px))" }} className="fixed z-[100] rounded-lg border border-[#dee0e3] bg-white p-1 shadow-[0_6px_24px_rgba(31,35,41,0.16)]" onKeyDown={(event) => { if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return; const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])]; if (!buttons.length) return; event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : (index + buttons.length - 1) % buttons.length].focus(); }}>
      <button role="menuitem" type="button" onClick={() => { setOpen(false); onShare(); }} className={item}><Share2 size={15}/>{t("分享")}</button>
      <button role="menuitem" type="button" onClick={() => { setOpen(false); onCopy(); }} className={item}><Link size={15}/>{t("复制链接")}</button>
      <div className="my-1 border-t border-[#e5e6eb]"/>
      <button role="menuitem" type="button" disabled={!ready || busy} onClick={() => { setOpen(false); onPin(); }} className={item}><Pin size={15}/>{pinned ? t("取消置顶") : t("置顶")}</button>
      <button role="menuitem" type="button" disabled={!ready || busy} onClick={() => { setOpen(false); onFavorite(); }} className={item}><Star size={15}/>{starred ? t("取消收藏") : t("收藏")}</button>
    </div>, document.body)}
  </>;
}

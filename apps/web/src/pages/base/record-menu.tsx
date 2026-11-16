import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { History, MessageSquare, PanelRightOpen, Trash2 } from "lucide-react";
import { t } from "@/lib/i18n";

export function recordMenuPosition(x: number, y: number, viewportWidth: number, viewportHeight: number, height: number) {
  return { left: Math.max(4, Math.min(x, viewportWidth - 188)), top: Math.max(4, Math.min(y, viewportHeight - height - 8)) };
}

export function RecordMenu({ x, y, multiple, canEdit, ready, anchor, onClose, onDetail, onHistory, onComment, onDelete }: {
  x: number; y: number; multiple: boolean; canEdit: boolean; ready: boolean; anchor: HTMLElement | null;
  onClose: () => void; onDetail: () => void; onHistory: () => void; onComment: () => void; onDelete: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) close.current(); };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close.current(); };
    const resize = () => close.current();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); if (anchor?.isConnected) anchor.focus({ preventScroll: true }); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : (index + buttons.length - 1) % buttons.length;
      buttons[next].focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", resize); };
  }, [anchor]);
  const position = recordMenuPosition(x, y, window.innerWidth, window.innerHeight, multiple ? (canEdit ? 88 : 48) : canEdit ? 156 : 116);
  return createPortal(<div ref={panel} role="menu" aria-label={t("记录操作")} aria-busy={!ready} data-record-menu style={position} className="fixed z-[100] w-[180px] rounded-md border border-[#dee0e3] bg-surface py-1 text-[13px] text-foreground shadow-[0_4px_16px_rgba(31,35,41,0.15)]">
    {!multiple && <button type="button" role="menuitem" disabled={!ready} onClick={onDetail} className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-hover focus:bg-hover focus:outline-none disabled:opacity-40"><PanelRightOpen size={15}/>{t("查看详情")}</button>}
    <button type="button" role="menuitem" disabled={!ready} onClick={onHistory} className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-hover focus:bg-hover focus:outline-none disabled:opacity-40"><History size={15}/>{t("查看记录历史")}</button>
    {!multiple && <button type="button" role="menuitem" disabled={!ready} onClick={onComment} className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-hover focus:bg-hover focus:outline-none disabled:opacity-40"><MessageSquare size={15}/>{t("添加评论")}</button>}
    {canEdit && <div className="mt-1 border-t pt-1"><button type="button" role="menuitem" disabled={!ready} onClick={onDelete} className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-hover focus:bg-hover focus:outline-none disabled:opacity-40"><Trash2 size={15}/>{t("删除记录")}</button></div>}
  </div>, document.body);
}

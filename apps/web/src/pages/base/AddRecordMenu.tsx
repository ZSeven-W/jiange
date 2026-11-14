import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, CirclePlus, ClipboardPaste, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { popupPosition } from "./popupPosition";

/** Keep the direct add action separate from its menu, as in the grid toolbar. */
export function AddRecordMenu({ disabled, onAdd }: { disabled: boolean; onAdd: () => void }) {
  const { t } = useI18n();
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof popupPosition> | null>(null);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (open && position && !disabled) panel.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus({ preventScroll: true }); }, [open, !!position, disabled]);

  useLayoutEffect(() => {
    if (!open || disabled) { setPosition(null); return; }
    const place = () => { const rect = trigger.current?.getBoundingClientRect(); if (rect) setPosition(popupPosition(rect, window.innerWidth, window.innerHeight, 164, 72)); };
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false); };
    const focusOutside = (event: FocusEvent) => { if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); setOpen(false); trigger.current?.focus({ preventScroll: true }); }
    };
    place(); document.addEventListener("pointerdown", outside); document.addEventListener("focusin", focusOutside); document.addEventListener("keydown", key); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place); window.visualViewport?.addEventListener("scroll", place);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", focusOutside); document.removeEventListener("keydown", key); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); window.visualViewport?.removeEventListener("resize", place); window.visualViewport?.removeEventListener("scroll", place); };
  }, [open, disabled]);

  return <div className="flex h-8 shrink-0 items-center text-primary" data-add-record-controls>
    <button type="button" disabled={disabled} onClick={onAdd} className="flex h-8 items-center gap-1 rounded px-1.5 font-medium hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50" data-add-record><Plus size={15}/><span className="hidden sm:inline">{t("添加记录")}</span><span className="sr-only sm:hidden">{t("添加记录")}</span></button>
    <button ref={trigger} type="button" disabled={disabled} aria-label={t("添加记录更多操作")} aria-haspopup="menu" aria-expanded={open && !disabled} onClick={() => setOpen((value) => !value)} className="grid h-7 w-5 place-items-center rounded hover:bg-hover disabled:opacity-50" data-add-record-menu><ChevronDown size={13} className={open && !disabled ? "rotate-180" : ""}/></button>
    {open && !disabled && position && createPortal(<div ref={panel} role="menu" aria-label={t("添加记录更多操作")} style={position} className="fixed z-[100] rounded-md border border-[#dee0e3] bg-surface py-1 text-[13px] text-foreground shadow-[0_4px_16px_rgba(31,35,41,0.15)]" data-add-record-panel>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); onAdd(); }} className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-hover"><CirclePlus size={14} className="text-subtle"/>{t("添加记录")}</button>
      <button type="button" role="menuitem" disabled title={t("AI 粘贴录入暂不可用")} className="flex h-8 w-full cursor-not-allowed items-center gap-2 px-3 text-left text-subtle opacity-60"><ClipboardPaste size={14}/>{t("AI 粘贴录入")}<span className="rounded-full bg-[#f16862] px-1 text-[10px] leading-4 text-white">New</span></button>
    </div>, document.body)}
  </div>;
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import type { View } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { popupPosition } from "./popup-position";
import { ViewGlyph } from "./view-glyph";

export const VIEW_CHOICES: ReadonlyArray<{ type: View["type"]; label: string }> = [
  { type: "grid", label: "表格视图" }, { type: "kanban", label: "看板视图" },
  { type: "calendar", label: "日历视图" }, { type: "gantt", label: "甘特视图" },
  { type: "gallery", label: "画册视图" }, { type: "form", label: "表单视图" },
];

/** A success response must identify the requested view before it is selected. */
export function isCreatedView(value: unknown, baseId: number, type: View["type"], name: string): value is View {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<View>;
  return Number.isSafeInteger(result.id) && result.id! > 0 && result.baseId === baseId && result.type === type && result.name === name && typeof result.pos === "number" && Number.isFinite(result.pos) && !!result.config && typeof result.config === "object" && !Array.isArray(result.config);
}

export interface CreatedViewSelection { baseId: number; userId: number; viewId: number; revision: number; baseline: unknown }
/** A create may finish after a user switches views or access is revalidated. */
export function createdViewSelectionResult(selection: CreatedViewSelection, state: {
  baseId: number; userId: number; revision: number; ready: boolean; fetching: boolean; blocked: boolean;
  snapshot?: { base: { role?: string }; views: readonly Pick<View, "id" | "baseId">[]; writeRestricted?: boolean };
}): "wait" | "discard" | "missing" | "select" {
  if (selection.baseId !== state.baseId || selection.userId !== state.userId || selection.revision !== state.revision) return "discard";
  const data = state.snapshot;
  if (!state.ready || state.fetching || state.blocked || !data || data === selection.baseline) return "wait";
  if (data.writeRestricted || !["edit", "manage"].includes(data.base.role ?? "")) return "discard";
  return data.views.some((view) => view.id === selection.viewId && view.baseId === selection.baseId) ? "select" : "missing";
}

export function NewViewMenu({ open, onOpenChange, canEdit, busy, onCreate }: {
  open: boolean; onOpenChange: (open: boolean) => void; canEdit: boolean; busy: boolean;
  onCreate: (type: View["type"], name: string, isPersonal?: boolean) => void;
}) {
  const { t } = useI18n();
  const [personal, setPersonal] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof popupPosition> | null>(null);
  const onOpenRef = useRef(onOpenChange); onOpenRef.current = onOpenChange;
  useEffect(() => { if (!canEdit && open) onOpenRef.current(false); }, [canEdit, open]);
  useLayoutEffect(() => {
    if (!open || !canEdit) { setPosition(null); return; }
    const place = () => { const rect = trigger.current?.getBoundingClientRect(); if (rect) setPosition(popupPosition(rect, window.innerWidth, window.innerHeight, 192, 240)); };
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) onOpenRef.current(false); };
    const focusOutside = (event: FocusEvent) => { if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) onOpenRef.current(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); onOpenRef.current(false); trigger.current?.focus({ preventScroll: true }); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !panel.current?.contains(document.activeElement)) return;
      const buttons = [...panel.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (current + 1) % buttons.length : (current + buttons.length - 1) % buttons.length;
      buttons[next].focus();
    };
    place(); document.addEventListener("pointerdown", outside); document.addEventListener("focusin", focusOutside); document.addEventListener("keydown", key); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place); window.visualViewport?.addEventListener("scroll", place);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", focusOutside); document.removeEventListener("keydown", key); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); window.visualViewport?.removeEventListener("resize", place); window.visualViewport?.removeEventListener("scroll", place); };
  }, [open, canEdit]);
  useEffect(() => { if (open && position && !busy) panel.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus({ preventScroll: true }); }, [open, !!position, busy]);
  if (!canEdit) return null;
  return <>
    <button ref={trigger} type="button" disabled={busy} className="grid size-8 shrink-0 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground disabled:opacity-50" title={t("新建视图")} aria-label={t("新建视图")} aria-haspopup="menu" aria-expanded={open} onClick={() => onOpenChange(!open)} data-new-view-menu><Plus size={15}/></button>
    {open && position && createPortal(<div ref={panel} role="menu" aria-label={t("新建视图")} style={position} className="fixed z-[100] overflow-y-auto rounded-lg border border-[#dee0e3] bg-surface p-1 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.14)]" data-new-view-panel>
      <label className="mx-1 mb-1 flex cursor-pointer items-center gap-2 rounded-md border-b px-2 py-2 text-[12px] text-muted-foreground hover:bg-hover" data-new-view-personal>
        <input type="checkbox" className="accent-primary" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />
        <span>{t("设为个人视图（仅自己可见）")}</span>
      </label>
      <div className="px-2.5 pb-1 pt-1 text-[12px] text-subtle">{t("基础视图")}</div>
      {VIEW_CHOICES.filter((c) => !personal || c.type !== "form").map(({ type, label }) => <button key={type} type="button" role="menuitem" disabled={busy} className="flex h-8 w-full items-center gap-2.5 rounded px-2.5 text-left hover:bg-hover disabled:opacity-50" onClick={() => { onOpenChange(false); onCreate(type, personal ? `${t("个人")}${t(label)}` : t(label), personal); setPersonal(false); }}><ViewGlyph type={type}/>{t(label)}</button>)}
    </div>, document.body)}
  </>;
}

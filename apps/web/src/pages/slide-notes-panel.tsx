import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

const MIN_HEIGHT = 72;
const MAX_HEIGHT = 420;
const DEFAULT_HEIGHT = 100;

/** Leave room for the slide, toolbar and footer, even in a short viewport. */
export function notesHeightLimit(sectionHeight: number): number {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.floor(sectionHeight - 56 - 36 - 160 - 16)));
}
export function clampNotesHeight(height: number, maximum: number): number {
  return Math.min(maximum, Math.max(MIN_HEIGHT, Math.round(height)));
}

export function SlideNotesPanel({ value, readOnly, onChange, onBlur }: { value: string; readOnly: boolean; onChange: (value: string) => void; onBlur: () => void }) {
  const { t } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; height: number } | null>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [maximum, setMaximum] = useState(MAX_HEIGHT);
  useEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const limit = notesHeightLimit(parent.clientHeight);
      setMaximum(limit);
      setHeight((current) => clampNotesHeight(current, limit));
    };
    measure();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  return <div ref={panel} className="mx-3 mb-3 flex shrink-0 flex-col overflow-hidden rounded-lg border border-[#dee0e3] bg-white shadow-[0_2px_8px_rgba(31,35,41,0.06)] sm:mx-5 sm:mb-4" style={{ height }} data-slide-notes>
    <div role="separator" aria-label={t("调整备注区高度")} aria-orientation="horizontal" aria-valuemin={MIN_HEIGHT} aria-valuemax={maximum} aria-valuenow={height} tabIndex={0}
      className="grid h-5 shrink-0 touch-none cursor-ns-resize place-items-center outline-none focus-visible:bg-[#edf3ff]"
      onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); drag.current = { pointerId: event.pointerId, startY: event.clientY, height }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { const start = drag.current; if (start?.pointerId === event.pointerId) setHeight(clampNotesHeight(start.height + start.startY - event.clientY, maximum)); }}
      onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }}
      onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) { setHeight(clampNotesHeight(drag.current.height, maximum)); drag.current = null; } }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => { const delta = event.key === "ArrowUp" ? 16 : event.key === "ArrowDown" ? -16 : 0; if (!delta && event.key !== "Home" && event.key !== "End") return; event.preventDefault(); setHeight((current) => event.key === "Home" ? MIN_HEIGHT : event.key === "End" ? maximum : clampNotesHeight(current + delta, maximum)); }}>
      <span aria-hidden="true" className="h-[7px] w-4 border-y border-[#b8bec5] before:relative before:top-[2px] before:block before:border-t before:border-[#b8bec5]"/>
    </div>
    <textarea aria-label={t("演示者备注")} value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} placeholder={t("点击添加演示者备注")} className="min-h-0 w-full flex-1 resize-none bg-transparent px-5 pb-3 text-[13px] leading-5 text-[#1f2329] outline-none placeholder:text-[#a3aab3]" data-slide-history />
  </div>;
}

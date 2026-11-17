import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

// The Feishu insertion picker displays five bars; additional columns can be
// added later up to the document's separate ten-column limit.
export const COLUMN_PICKER_MIN = 2;
export const COLUMN_PICKER_MAX = 5;
export const validColumnPickerCount = (count: number) => Number.isInteger(count) && count >= COLUMN_PICKER_MIN && count <= COLUMN_PICKER_MAX;
export function nextColumnPickerCount(count: number, key: string): number | null {
  if (!validColumnPickerCount(count)) return null;
  if (key === "Home") return COLUMN_PICKER_MIN;
  if (key === "End") return COLUMN_PICKER_MAX;
  if (key === "ArrowLeft" || key === "ArrowUp") return Math.max(COLUMN_PICKER_MIN, count - 1);
  if (key === "ArrowRight" || key === "ArrowDown") return Math.min(COLUMN_PICKER_MAX, count + 1);
  return null;
}

export function ColumnCountPicker({ anchor, count, onChange, onPick, onClose }: { anchor: RefObject<HTMLButtonElement | null>; count: number; onChange: (count: number) => void; onPick: (count: number) => void; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null), id = useId();
  const [position, setPosition] = useState({ left: -1000, top: -1000, maxHeight: 240 });
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const a = anchor.current, panel = root.current;
      if (!a || !panel) return;
      const rect = a.getBoundingClientRect(), menu = a.closest("[data-slash-menu]")?.getBoundingClientRect() ?? rect;
      const vv = window.visualViewport, left = vv?.offsetLeft ?? 0, top = vv?.offsetTop ?? 0;
      const right = left + (vv?.width ?? window.innerWidth), bottom = top + (vv?.height ?? window.innerHeight);
      const width = panel.getBoundingClientRect().width, height = Math.min(panel.scrollHeight, Math.max(1, bottom - top - 16));
      const sideSpace = menu.right + 4 + width <= right - 8 || menu.left - 4 - width >= left + 8;
      const proposed = menu.right + 4 + width <= right - 8 ? menu.right + 4 : menu.left - 4 - width >= left + 8 ? menu.left - 4 - width : left + 8;
      const preferredTop = sideSpace ? rect.top + rect.height / 2 - height / 2 : menu.top;
      setPosition({ left: Math.max(left + 8, Math.min(proposed, right - width - 8)), top: Math.max(top + 8, Math.min(preferredTop, bottom - height - 8)), maxHeight: Math.max(1, bottom - top - 16) });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure(); window.addEventListener("resize", schedule); window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule); window.visualViewport?.addEventListener("scroll", schedule);
    return () => { if (frame) cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); window.visualViewport?.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("scroll", schedule); };
  }, [anchor]);
  if (typeof document === "undefined") return null;
  return createPortal(<div ref={root} data-column-count-picker role="listbox" tabIndex={0} aria-label="选择分栏数量" aria-activedescendant={`${id}-${count}`}
    className="fixed z-[80] w-[228px] max-w-[calc(100vw-16px)] overflow-auto rounded-lg border border-[#D9DBDF] bg-surface p-[14px] text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.12)] outline-none dark:border-border"
    style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }} onMouseDown={(event) => event.preventDefault()}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; } if (event.target !== event.currentTarget) return; const next = nextColumnPickerCount(count, event.key); if (next !== null) { event.preventDefault(); event.stopPropagation(); onChange(next); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onPick(count); } }}>
    <div className="mb-4 flex items-center justify-between text-subtle"><span><button type="button" className="mr-2 text-primary sm:hidden" onClick={onClose} aria-label="返回插入菜单">‹ 返回</button>选择栏数</span><span aria-live="polite" data-column-count-label>{count} 栏</span></div>
    <div className="flex gap-[7px] rounded-sm border border-[#DEE0E3] p-[14px] dark:border-border">
      {Array.from({ length: COLUMN_PICKER_MAX }, (_, index) => {
        const value = Math.max(COLUMN_PICKER_MIN, index + 1), active = index < count;
        return <button key={index} id={index ? `${id}-${value}` : undefined} type="button" role="option" tabIndex={-1} aria-hidden={index === 0 ? true : undefined} aria-label={`${value} 栏`} aria-selected={index === 0 ? undefined : value === count} data-column-count={index + 1}
          className={`h-[94px] min-w-0 flex-1 border ${active ? "border-[#8AA9F8] bg-[#8AA9F8]" : "border-[#E8EAED] bg-[#F1F2F3] dark:border-border dark:bg-hover"}`}
          onMouseEnter={() => onChange(value)} onClick={() => onPick(value)} />;
      })}
    </div>
  </div>, document.body);
}

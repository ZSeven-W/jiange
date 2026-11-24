import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";

export const TABLE_PICKER_LIMIT = 9;
export type TableSize = { rows: number; columns: number };
export const validTablePickerSize = (size: TableSize) => Number.isInteger(size.rows) && Number.isInteger(size.columns) && size.rows >= 1 && size.rows <= TABLE_PICKER_LIMIT && size.columns >= 1 && size.columns <= TABLE_PICKER_LIMIT;

export function TableSizePicker({ anchor, size, onChange, onPick, onClose }: { anchor: RefObject<HTMLButtonElement | null>; size: TableSize; onChange: (size: TableSize) => void; onPick: (size: TableSize) => void; onClose: () => void }) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null), id = useId();
  const [position, setPosition] = useState({ left: -1000, top: -1000, maxHeight: 300 });
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
      setPosition({ left: Math.max(left + 8, Math.min(proposed, right - width - 8)), top: Math.max(top + 8, Math.min(sideSpace ? rect.top : menu.top, bottom - height - 8)), maxHeight: Math.max(1, bottom - top - 16) });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure(); window.addEventListener("resize", schedule); window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule); window.visualViewport?.addEventListener("scroll", schedule);
    return () => { if (frame) cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); window.visualViewport?.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("scroll", schedule); };
  }, [anchor]);
  if (typeof document === "undefined") return null;
  const move = (key: string): TableSize | null => {
    const rows = Math.max(1, Math.min(TABLE_PICKER_LIMIT, size.rows + (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0)));
    const columns = Math.max(1, Math.min(TABLE_PICKER_LIMIT, size.columns + (key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0)));
    return key.startsWith("Arrow") ? { rows, columns } : null;
  };
  return createPortal(<div ref={root} data-table-size-picker role="grid" tabIndex={0} aria-label={t("选择表格行列")} aria-rowcount={TABLE_PICKER_LIMIT} aria-colcount={TABLE_PICKER_LIMIT} aria-activedescendant={`${id}-${size.rows}-${size.columns}`}
    className="fixed z-[80] w-[248px] max-w-[calc(100vw-16px)] overflow-auto rounded-lg border border-[#D9DBDF] bg-surface p-2 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.12)] outline-none dark:border-border"
    style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }} onMouseDown={(event) => event.preventDefault()}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; } if (event.target !== event.currentTarget) return; const next = move(event.key); if (next) { event.preventDefault(); event.stopPropagation(); onChange(next); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onPick(size); } }}>
    <div className="mb-2 flex items-center justify-between px-1 text-subtle"><span><button type="button" className="mr-2 text-primary sm:hidden" onClick={onClose} aria-label={t("返回插入菜单")}>‹ {t("返回")}</button>{t("插入表格")}</span><span aria-live="polite" data-table-size-label>{size.columns} × {size.rows}</span></div>
    <div className="w-fit rounded-sm border border-[#DEE0E3] p-2 dark:border-border">
      {Array.from({ length: TABLE_PICKER_LIMIT }, (_, row) => <div key={row} role="row" className="flex gap-[5px]" style={{ marginBottom: row === TABLE_PICKER_LIMIT - 1 ? 0 : 5 }}>
        {Array.from({ length: TABLE_PICKER_LIMIT }, (_, column) => {
          const next = { rows: row + 1, columns: column + 1 }, active = next.rows <= size.rows && next.columns <= size.columns;
          return <button key={column} id={`${id}-${next.rows}-${next.columns}`} type="button" role="gridcell" tabIndex={-1} aria-label={t("{rows} 行 {columns} 列", { rows: next.rows, columns: next.columns })} aria-selected={active} data-table-size-cell={`${next.rows}:${next.columns}`}
            className={`size-[19px] shrink-0 border ${active ? "border-[#99B3FF] bg-[#A3BAFA]" : "border-[#E8EAED] bg-[#F1F2F3] dark:border-border dark:bg-hover"}`}
            onMouseEnter={() => onChange(next)} onClick={() => onPick(next)} />;
        })}
      </div>)}
    </div>
  </div>, document.body);
}

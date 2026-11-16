import { useLayoutEffect, useRef, type RefObject } from "react";

/** Keep the first row at the scrollport edge until the table itself leaves. */
export function tableHeaderOffset(rowTop: number, rowHeight: number, tableBottom: number, viewportTop: number): number {
  if (![rowTop, rowHeight, tableBottom, viewportTop].every(Number.isFinite) || rowHeight <= 0) return 0;
  return Math.max(0, Math.min(viewportTop - rowTop, tableBottom - rowTop - rowHeight));
}

/**
 * Horizontal overflow creates a separate CSS scroll container, so native
 * position:sticky cannot follow the document's vertical scrollport. Translate
 * the actual row instead: widths, horizontal scrolling and cell controls stay
 * attached to the original table without a duplicate editable header.
 */
export function useTableStickyHeader(root: RefObject<HTMLElement | null>, enabled: boolean): void {
  const scheduleRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const container = root.current;
    if (!enabled || !container || typeof window === "undefined") return;
    let row: HTMLTableRowElement | null = null, applied = 0, frame = 0;
    const clipped = new Map<HTMLElement, string>();
    const restore = () => {
      for (const [cell, value] of clipped) cell.style.clipPath = value;
      clipped.clear();
      if (row) { row.style.transform = ""; row.style.position = ""; row.style.zIndex = ""; delete row.dataset.tableHeaderStuck; }
      applied = 0;
    };
    const measure = () => {
      frame = 0;
      const next = container.querySelector<HTMLTableRowElement>("[data-table-title-row]");
      if (next !== row) { restore(); row = next; }
      const table = row?.closest("table");
      if (!row || !table || !container.isConnected) { restore(); return; }
      const rect = row.getBoundingClientRect(), tableRect = table.getBoundingClientRect();
      let top = window.visualViewport?.offsetTop ?? 0;
      for (let parent = container.parentElement; parent; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowY;
        if (overflow === "auto" || overflow === "scroll" || overflow === "hidden" || overflow === "clip") top = Math.max(top, parent.getBoundingClientRect().top + parent.clientTop);
      }
      const offset = tableHeaderOffset(rect.top - applied, rect.height, tableRect.bottom, top);
      if (offset <= 0.5) { restore(); return; }
      applied = offset;
      row.style.position = "relative"; row.style.zIndex = "20"; row.style.transform = `translateY(${offset}px)`;
      row.dataset.tableHeaderStuck = "true";
      // A cell spanning later rows must not cover those rows while pinned.
      for (const cell of Array.from(row.cells)) {
        if (cell.rowSpan <= 1) continue;
        if (!clipped.has(cell)) clipped.set(cell, cell.style.clipPath);
        const hidden = Math.max(0, cell.getBoundingClientRect().height - rect.height);
        cell.style.clipPath = `inset(0px 0px ${hidden}px 0px)`;
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    scheduleRef.current = schedule;
    const beforePrint = () => { if (frame) cancelAnimationFrame(frame); frame = 0; restore(); };
    window.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule); window.visualViewport?.addEventListener("scroll", schedule);
    window.addEventListener("beforeprint", beforePrint); window.addEventListener("afterprint", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(container); const table = container.querySelector("table"); if (table) observer?.observe(table);
    measure();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (scheduleRef.current === schedule) scheduleRef.current = null;
      observer?.disconnect(); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("beforeprint", beforePrint); window.removeEventListener("afterprint", schedule); restore();
    };
  }, [enabled, root]);
  useLayoutEffect(() => { scheduleRef.current?.(); });
}

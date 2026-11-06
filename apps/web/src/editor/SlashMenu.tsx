import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { MenuItem } from "./pinyin";
import { MenuGlyph } from "./menuIcons";

/**
 * 斜杠菜单（受控列表）：高亮完全由 index 驱动，↑/↓ 换高亮、Enter 选中、
 * hover 同步 index——不再经由 cmdk（其 value 是搜索框而非选中项，方向键
 * 高亮会失灵）。
 */
export function SlashMenu({
  x,
  y,
  query,
  items,
  index,
  onPick,
  onHover,
}: {
  x: number;
  y: number;
  query?: string;
  items: MenuItem[];
  index: number;
  onPick: (it: MenuItem) => void;
  onHover: (i: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ dx: 0, dy: 0, maxHeight: 360 });
  const placementRef = useRef(placement);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const previous = placementRef.current;
      const naturalLeft = rect.left - previous.dx;
      const naturalTop = rect.top - previous.dy;
      const vv = window.visualViewport;
      let left = vv?.offsetLeft ?? 0, top = vv?.offsetTop ?? 0;
      let right = left + (vv?.width ?? window.innerWidth), bottom = top + (vv?.height ?? window.innerHeight);
      // Menus are inside the document scroller; intersect it with the visible
      // viewport so clipping and the mobile keyboard are both accounted for.
      for (let parent = el.parentElement?.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const box = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
      const edge = 8;
      const wantedHeight = Math.min(360, el.scrollHeight + 2);
      const below = Math.max(0, bottom - edge - naturalTop);
      // y is the bottom of the caret plus a small gap; place above its line
      // when there is more useful space there than below it.
      const aboveEnd = naturalTop - 32;
      const above = Math.max(0, aboveEnd - top - edge);
      const useAbove = below < wantedHeight && above > below;
      const available = useAbove ? above : below;
      const maxHeight = Math.max(1, Math.min(wantedHeight, available));
      const desiredTop = useAbove ? aboveEnd - maxHeight : Math.max(top + edge, Math.min(naturalTop, bottom - edge - maxHeight));
      const desiredLeft = Math.max(left + edge, Math.min(naturalLeft, right - edge - rect.width));
      const next = { dx: Math.round(desiredLeft - naturalLeft), dy: Math.round(desiredTop - naturalTop), maxHeight: Math.floor(maxHeight) };
      if (next.dx !== previous.dx || next.dy !== previous.dy || next.maxHeight !== previous.maxHeight) {
        placementRef.current = next;
        setPlacement(next);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(el);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [x, y, items.length, query]);
  useEffect(() => {
    const list = listRef.current;
    const selected = list?.querySelector<HTMLElement>("[data-selected=true]");
    if (!list || !selected) return;
    const item = selected.getBoundingClientRect(), bounds = list.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  }, [index, items]);
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <div className="absolute z-30 w-[264px] max-w-[calc(100vw-16px)]" style={{ left: x + placement.dx, top: y + placement.dy }} onMouseDown={(e) => e.preventDefault()} data-slash-menu>
      <div ref={listRef} style={{ maxHeight: placement.maxHeight }} className="overflow-y-auto rounded-lg border bg-surface p-1.5 shadow-[0_4px_16px_rgba(31,35,41,0.16)]">
        <div className="px-2.5 pb-2 pt-1.5 text-[12px] text-subtle">{query ? `搜索：${query}` : "插入内容"}</div>
        {items.length === 0 && <div className="px-3 py-2 text-[13px] text-subtle">没有匹配的块</div>}
        {groups.map((g) => (
          <div key={g}>
            <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-medium text-subtle">{g}</div>
            {items
              .filter((i) => i.group === g)
              .map((it) => {
                const gi = items.indexOf(it);
                const selected = gi === index;
                return (
                  <button
                    key={it.id}
                    data-selected={selected}
                    data-value={it.id}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
                      selected ? "bg-hover font-medium text-foreground" : "text-foreground hover:bg-hover",
                    )}
                    onMouseEnter={() => onHover(gi)}
                    onClick={() => onPick(it)}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-surface text-muted-foreground">
                      <MenuGlyph id={it.id} fallback={it.icon} />
                    </span>
                    <span className="flex-1 truncate">{it.label}</span>

                  </button>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}

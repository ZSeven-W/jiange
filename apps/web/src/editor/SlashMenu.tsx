import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { MenuItem } from "./pinyin";
import { MenuGlyph } from "./menuIcons";

/**
 * 斜杠菜单（受控列表）：高亮完全由 index 驱动，↑/↓ 换高亮、Enter 选中、
 * hover 同步 index——不再经由 cmdk（其 value 是搜索框而非选中项，方向键
 * 高亮会失灵）。
 */
/** 图标网格列数。 */
export const SLASH_GRID_COLS = 5;

/** 无搜索词且基础/列表块齐全时，返回网格中的项数（它们位于 items 开头）；否则为 0。 */
export function slashGridSize(_items: MenuItem[], _query?: string): number {
  // 飞书当前版本（2026-11-11 实测）斜杠菜单为纯列表，不再平铺图标网格。
  return 0;
}

/**
 * 斜杠菜单方向键：网格内 ←/→ 逐个、↑/↓ 按行移动，越过网格底部进入下方列表，
 * 列表顶部按 ↑ 回到网格最后一行；列表中 ←/→ 不处理（返回 null，交给光标）。
 */
export function nextSlashIndex(index: number, key: string, n: number, grid: number, cols = SLASH_GRID_COLS): number | null {
  if (n <= 0) return null;
  const i = Math.max(0, Math.min(index, n - 1));
  const inGrid = i < grid;
  if (key === "ArrowLeft" || key === "ArrowRight") return inGrid ? (i + (key === "ArrowRight" ? 1 : n - 1)) % n : null;
  if (key !== "ArrowDown" && key !== "ArrowUp") return null;
  const down = key === "ArrowDown";
  if (!inGrid) {
    if (down) return i + 1 < n ? i + 1 : 0;
    if (i - 1 >= grid) return i - 1;
    return grid > 0 ? Math.floor((grid - 1) / cols) * cols : n - 1;
  }
  if (down) {
    if (i + cols < grid) return i + cols;
    if (grid < n) return grid;
    return i % cols;
  }
  if (i - cols >= 0) return i - cols;
  if (grid < n) return n - 1;
  const lastRow = Math.floor((grid - 1) / cols) * cols;
  return Math.min(lastRow + (i % cols), grid - 1);
}

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
    <div className="absolute z-30 w-[232px] max-w-[calc(100vw-16px)]" style={{ left: x + placement.dx, top: y + placement.dy }} onMouseDown={(e) => e.preventDefault()} data-slash-menu>
      {/* 飞书实测：宽 232、#D9DBDF 描边、内边距 8、分组标题 40 高（含上内边距）、行高 32、图标 20 距行左 8、文字距图标 16、选中 #EDEDEE。 */}
      <div ref={listRef} style={{ maxHeight: placement.maxHeight }} className="overflow-y-auto rounded-lg border border-[#D9DBDF] bg-surface px-2 pb-2 shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border">
        {query && <div className="flex h-8 items-end px-1 pb-1 text-[12px] text-subtle">搜索：{query}</div>}
        {items.length === 0 && <div className="px-2 py-3 text-[13px] text-subtle">没有匹配的块</div>}
        {groups.map((g) => (
          <div key={g}>
            <div className="flex h-10 items-center px-1 pt-1 text-[12px] text-subtle">{g}</div>
            {items
              .filter((i) => i.group === g)
              .map((it) => {
                const gi = items.indexOf(it);
                const selected = gi === index;
                return (
                  <button
                    key={it.id}
                    type="button"
                    data-selected={selected}
                    data-value={it.id}
                    className={cn("flex h-8 w-full items-center gap-4 rounded-md px-2 text-left text-[14px] text-foreground", selected ? "bg-[#EDEDEE] dark:bg-hover" : "hover:bg-[#EDEDEE] dark:hover:bg-hover")}
                    onMouseEnter={() => onHover(gi)}
                    onClick={() => onPick(it)}
                  >
                    <span className={cn("grid size-5 shrink-0 place-items-center", it.id === "code" ? "text-[#2EA121]" : "text-primary")}>
                      <MenuGlyph id={it.id} fallback={it.icon} size={18} />
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

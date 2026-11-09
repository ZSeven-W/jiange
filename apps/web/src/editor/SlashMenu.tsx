import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { SLASH_ITEMS, type MenuItem } from "./pinyin";
import { MenuGlyph } from "./menuIcons";

/**
 * 斜杠菜单（受控列表）：高亮完全由 index 驱动，↑/↓ 换高亮、Enter 选中、
 * hover 同步 index——不再经由 cmdk（其 value 是搜索框而非选中项，方向键
 * 高亮会失灵）。
 */
/** 在无搜索词时以图标网格展示的分组。 */
const GRID_GROUPS = new Set(["基础", "列表"]);

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
  // 飞书式：无搜索词时“基础/列表”类块以图标网格平铺在顶部，其余以列表展示；搜索时全部为列表。
  const browsing = !query && SLASH_ITEMS.filter((it) => GRID_GROUPS.has(it.group)).every((it) => items.some((x) => x.id === it.id));
  const gridItems = browsing ? items.filter((it) => GRID_GROUPS.has(it.group)) : [];
  const listItems = items.filter((it) => !gridItems.includes(it));
  const groups = [...new Set(listItems.map((i) => i.group))];
  const selectedGrid = gridItems.find((it) => items.indexOf(it) === index);
  return (
    <div className="absolute z-30 w-[272px] max-w-[calc(100vw-16px)]" style={{ left: x + placement.dx, top: y + placement.dy }} onMouseDown={(e) => e.preventDefault()} data-slash-menu>
      <div ref={listRef} style={{ maxHeight: placement.maxHeight }} className="overflow-y-auto rounded-lg border bg-surface p-1 shadow-[0_6px_24px_rgba(31,35,41,0.12)]">
        {query && <div className="px-2.5 pb-1 pt-1.5 text-[12px] text-subtle">搜索：{query}</div>}
        {items.length === 0 && <div className="px-3 py-2 text-[13px] text-subtle">没有匹配的块</div>}
        {gridItems.length > 0 && (
          <div className="px-1 pb-1 pt-1" data-slash-grid>
            <div className="flex h-6 items-center px-1.5 text-[12px] text-subtle">基础{selectedGrid && <span className="ml-auto text-muted-foreground" aria-live="polite">{selectedGrid.label}</span>}</div>
            <div className="grid grid-cols-5 gap-1 px-0.5">
              {gridItems.map((it) => {
                const gi = items.indexOf(it);
                const selected = gi === index;
                return (
                  <button
                    key={it.id}
                    type="button"
                    data-selected={selected}
                    data-value={it.id}
                    title={it.label}
                    aria-label={it.label}
                    className={cn("grid h-9 place-items-center rounded-md text-muted-foreground transition-colors", selected ? "bg-hover text-foreground" : "hover:bg-hover hover:text-foreground")}
                    onMouseEnter={() => onHover(gi)}
                    onClick={() => onPick(it)}
                  >
                    <MenuGlyph id={it.id} fallback={it.icon} size={18} />
                  </button>
                );
              })}
            </div>
            {listItems.length > 0 && <div className="mx-1.5 mt-1.5 h-px bg-border" />}
          </div>
        )}
        {groups.map((g) => (
          <div key={g}>
            <div className="flex h-7 items-end px-2.5 pb-1 text-[12px] text-subtle">{g}</div>
            {listItems
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
                    className={cn(
                      "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[14px]",
                      selected ? "bg-hover text-foreground" : "text-foreground hover:bg-hover",
                    )}
                    onMouseEnter={() => onHover(gi)}
                    onClick={() => onPick(it)}
                  >
                    <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
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

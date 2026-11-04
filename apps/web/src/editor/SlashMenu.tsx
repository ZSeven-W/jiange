import { useEffect, useRef } from "react";
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
  items,
  index,
  onPick,
  onHover,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  index: number;
  onPick: (it: MenuItem) => void;
  onHover: (i: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector("[data-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [index, items]);
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <div className="absolute z-30 w-[264px]" style={{ left: x, top: y }} onMouseDown={(e) => e.preventDefault()} data-slash-menu>
      <div ref={listRef} className="max-h-[320px] overflow-y-auto rounded-lg border bg-surface p-1.5 shadow-[0_6px_24px_rgba(31,35,41,0.12)]">
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
                      selected ? "bg-accent font-medium text-accent-foreground" : "text-foreground hover:bg-hover",
                    )}
                    onMouseEnter={() => onHover(gi)}
                    onClick={() => onPick(it)}
                  >
                    <span className="grid size-6 shrink-0 place-items-center rounded border text-muted-foreground">
                      <MenuGlyph id={it.id} fallback={it.icon} />
                    </span>
                    <span className="flex-1 truncate">{it.label}</span>
                    <span className="shrink-0 text-[11px] text-subtle">{it.py.map((p) => p[0]).join("")}</span>
                  </button>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}

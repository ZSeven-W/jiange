import { useState } from "react";
import { ChevronDown, ChevronRight, ListTree, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OutlineItem } from "@/pages/outline-panel";

export interface TocBlockProps {
  items: readonly OutlineItem[];
  headingNumbers?: ReadonlyMap<string, string>;
  readOnly?: boolean;
  onJump?: (blockId: string) => void;
  onDelete?: () => void;
}

/** Feishu-style in-document Table of Contents block (`/目录`). */
export function TocBlockView({ items, headingNumbers, readOnly, onJump, onDelete }: TocBlockProps) {
  const [collapsed, setCollapsed] = useState(false);
  const minLevel = items.reduce((m, it) => Math.min(m, it.level), 9);

  return (
    <div
      contentEditable={false}
      data-toc-block
      className="group/toc my-2.5 select-none rounded-lg border border-[#e5e6eb] bg-[#fafbfc] px-4 py-3 text-[13px] transition-colors hover:border-[#d0d3d6] dark:border-border dark:bg-sidebar/50"
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1.5 text-[13px] font-medium text-[#1f2329] hover:text-[#3370ff] dark:text-foreground"
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={14} className="text-[#8f959e]" /> : <ChevronDown size={14} className="text-[#8f959e]" />}
          <ListTree size={14} className="text-[#3370ff]" />
          <span>目录</span>
          {items.length > 0 && <span className="text-[11px] font-normal text-[#8f959e]">({items.length})</span>}
        </button>
        {!readOnly && onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title="删除目录"
            aria-label="删除目录"
            className="grid size-6 place-items-center rounded text-[#8f959e] opacity-0 transition-opacity hover:bg-[#eff0f1] hover:text-destructive group-hover/toc:opacity-100"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {!collapsed && (
        items.length === 0 ? (
          <p className="mt-2 pl-5 text-[12px] text-[#8f959e]">添加标题（H1–H9）后将自动生成文档目录</p>
        ) : (
          <nav aria-label="文内目录" className="mt-2 space-y-0.5 border-l border-[#e5e6eb] pl-2 dark:border-border">
            {items.map((item) => {
              const depth = Math.max(0, Math.min(5, item.level - minLevel));
              const num = headingNumbers?.get(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onJump?.(item.id)}
                  style={{ paddingLeft: `${depth * 14 + 8}px` }}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left transition-colors hover:bg-[#eff0f1] hover:text-[#3370ff] dark:hover:bg-hover",
                    depth === 0 ? "font-medium text-[#1f2329] dark:text-foreground" : "text-[#646a73] dark:text-muted-foreground",
                  )}
                >
                  {num && <span className="shrink-0 tabular-nums text-[#8f959e]">{num}</span>}
                  <span className="truncate">{item.text}</span>
                </button>
              );
            })}
          </nav>
        )
      )}
    </div>
  );
}

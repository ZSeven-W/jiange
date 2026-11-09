import { useMemo } from "react";
import { cn } from "@/lib/utils";

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
}

/** 从文档块列表提取标题大纲（h1-h6）。 */
export function outlineOf(blocks: { id: string; type: string; spans: { text: string }[] }[]): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const b of blocks) {
    if (!/^h[1-6]$/.test(b.type)) continue;
    const text = b.spans.map((s) => s.text).join("").trim();
    if (text) out.push({ id: b.id, level: Number(b.type[1]), text });
  }
  return out;
}

/** 当前阅读位置对应的目录项：最后一个顶部越过阅读线的标题；都未越过时取第一个。 */
export function activeOutlineId(items: OutlineItem[], tops: Record<string, number>, readingLine: number): string | null {
  let active: string | null = null;
  for (const it of items) {
    const top = tops[it.id];
    if (top === undefined) continue;
    if (top <= readingLine) active = it.id;
    else break;
  }
  return active ?? items[0]?.id ?? null;
}

/**
 * 飞书式目录：宽屏（≥1280px）时作为正文左侧的常驻目录随页面吸顶，不遮挡顶栏；
 * 窄屏时退化为顶栏下方的右侧抽屉。层级缩进 16px，当前阅读位置以主色和左侧指示条标出。
 */
export function OutlinePanel({
  items,
  activeId,
  allowCopy = true,
  allowPrint = true,
  onJump,
  onClose,
  yieldToSidePanel = false,
}: {
  items: OutlineItem[];
  activeId: string | null;
  /** 评论/历史面板停靠在右侧时，1680px 以下让出空间（与飞书打开评论时收起目录一致）。 */
  yieldToSidePanel?: boolean;
  allowCopy?: boolean;
  allowPrint?: boolean;
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  const minLevel = items.reduce((m, it) => Math.min(m, it.level), 6);
  return (
    <aside
      className={cn("fixed bottom-0 right-0 top-14 z-30 flex w-72 flex-col border-l bg-surface shadow-xl xl:sticky xl:top-0 xl:z-10 xl:h-[calc(100vh-56px)] xl:w-[248px] xl:shrink-0 xl:self-start xl:border-0 xl:bg-transparent xl:shadow-none", yieldToSidePanel && "hidden min-[1680px]:flex")}
      aria-label="目录"
      data-outline-panel
    >
      <header className="flex h-11 shrink-0 items-center pl-6 pr-3 pt-2 text-[14px] font-medium text-foreground xl:h-auto xl:pt-[58px] xl:text-[13px] xl:text-muted-foreground">
        目录
        <button type="button" className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label="关闭目录" title="关闭目录">
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>
        </button>
      </header>
      <nav className="min-h-0 flex-1 overflow-y-auto py-2 pl-4 pr-3 text-[14px] xl:pr-2" data-outline-list data-document-print-restricted={!allowPrint ? "true" : undefined} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }}>
        {items.length === 0 && <p className="px-2 py-8 text-center text-[13px] text-subtle">在文档中使用标题即可生成目录</p>}
        {items.map((it) => {
          const active = activeId === it.id;
          return (
            <button
              key={it.id}
              type="button"
              className={cn(
                "relative block w-full truncate rounded-md py-[5px] pr-2 text-left leading-[22px] transition-colors hover:bg-hover",
                active ? "font-medium text-primary" : it.level === minLevel ? "text-foreground" : "text-muted-foreground",
              )}
              style={{ paddingLeft: 8 + (it.level - minLevel) * 16 }}
              title={it.text}
              aria-current={active ? "location" : undefined}
              onClick={() => onJump(it.id)}
              data-outline-item={it.id}
            >
              {active && <span aria-hidden className="absolute inset-y-[7px] left-0 w-[2px] rounded-full bg-primary" />}
              {it.text}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

/** 飞书式图片大图预览遮罩。 */
export function ImagePreview({ src, alt, allowCopy = true, allowPrint = true, onClose }: { src: string; alt: string; allowCopy?: boolean; allowPrint?: boolean; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80" onClick={onClose} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }} data-image-preview>
      <img src={src} alt={alt} draggable={allowPrint} data-document-print-restricted={!allowPrint ? "true" : undefined} onContextMenu={(event) => { if (!allowPrint) event.preventDefault(); }} className="max-h-[88vh] max-w-[92vw] rounded-lg object-contain shadow-2xl" />
      <button className="absolute right-4 top-4 rounded-full bg-white/10 px-3 py-1.5 text-[13px] text-white hover:bg-white/20" aria-label="关闭">
        ✕
      </button>
    </div>
  );
}

/** useOutline 的 useMemo 辅助保持纯函数即可；这里无需额外 hook。 */
export function useNothing() {
  return useMemo(() => null, []);
}

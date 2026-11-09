import { useMemo, useState } from "react";
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

/** 目录中可见的项：被折叠标题的下级标题隐藏。返回 [项, 是否有下级] 列表。 */
export function visibleOutline(items: OutlineItem[], collapsed: ReadonlySet<string>): { item: OutlineItem; hasChildren: boolean }[] {
  const out: { item: OutlineItem; hasChildren: boolean }[] = [];
  let hideBelow: number | null = null;
  items.forEach((item, index) => {
    if (hideBelow !== null && item.level > hideBelow) return;
    hideBelow = null;
    const next = items[index + 1];
    const hasChildren = !!next && next.level > item.level;
    out.push({ item, hasChildren });
    if (hasChildren && collapsed.has(item.id)) hideBelow = item.level;
  });
  return out;
}

const PIN_KEY = "jiange.outline.pinned";
/** 读取/保存“固定目录”偏好（默认固定）；存储不可用时退回默认。 */
export function loadOutlinePinned(): boolean {
  try { return window.localStorage.getItem(PIN_KEY) !== "0"; } catch { return true; }
}
export function saveOutlinePinned(pinned: boolean) {
  try { window.localStorage.setItem(PIN_KEY, pinned ? "1" : "0"); } catch { /* ignore */ }
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return <svg viewBox="0 0 16 16" className="size-3.5" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" aria-hidden><path d="M6 2.5h4l-.6 4 2.1 2.3H4.5L6.6 6.5 6 2.5zM8 8.8v4.7" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

/**
 * 飞书式目录：宽屏（≥1280px）时位于正文左侧并随页面吸顶，不遮挡顶栏。
 * 「固定」时常驻展开；取消固定后收成一列短横线（按层级长短、当前位置高亮），
 * 悬停展开浮层。有下级的标题可折叠。窄屏时为顶栏下方的右侧抽屉。
 */
export function OutlinePanel({
  items,
  activeId,
  allowCopy = true,
  allowPrint = true,
  onJump,
  onClose,
  yieldToSidePanel = false,
  pinned = true,
  onPinnedChange,
}: {
  items: OutlineItem[];
  activeId: string | null;
  allowCopy?: boolean;
  allowPrint?: boolean;
  onJump: (id: string) => void;
  onClose: () => void;
  /** 评论/历史面板停靠在右侧时，1680px 以下让出空间（与飞书打开评论时收起目录一致）。 */
  yieldToSidePanel?: boolean;
  /** 宽屏下是否固定展开；未固定时显示缩略横线，悬停展开。 */
  pinned?: boolean;
  onPinnedChange?: (pinned: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const minLevel = items.reduce((m, it) => Math.min(m, it.level), 6);
  const rows = visibleOutline(items, collapsed);
  const toggle = (id: string) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <aside
      className={cn(
        "group/outline fixed bottom-0 right-0 top-14 z-30 flex w-72 flex-col border-l bg-surface shadow-xl xl:sticky xl:top-0 xl:z-10 xl:h-[calc(100vh-56px)] xl:shrink-0 xl:self-start xl:border-0 xl:bg-transparent xl:shadow-none",
        pinned ? "xl:w-[248px]" : "xl:w-14",
        yieldToSidePanel && "hidden min-[1680px]:flex",
      )}
      aria-label="目录"
      data-outline-panel
      data-outline-pinned={pinned ? "true" : "false"}
    >
      <div className={cn("flex min-h-0 flex-1 flex-col", !pinned && "xl:absolute xl:left-3 xl:top-[50px] xl:z-30 xl:hidden xl:max-h-[calc(100vh-140px)] xl:w-[248px] xl:flex-none xl:rounded-lg xl:border xl:bg-surface xl:pb-1 xl:shadow-[0_6px_24px_rgba(31,35,41,0.12)] xl:group-hover/outline:flex xl:group-focus-within/outline:flex")} data-outline-body>
        <header className={cn("flex h-11 shrink-0 items-center gap-0.5 pl-6 pr-3 pt-2 text-[14px] font-medium text-foreground xl:h-auto xl:text-[13px] xl:text-muted-foreground", pinned ? "xl:pt-[58px]" : "xl:pb-1 xl:pl-4 xl:pt-3")}>
          <span className="mr-auto">目录</span>
          {onPinnedChange && <button type="button" className={cn("hidden size-6 place-items-center rounded hover:bg-hover hover:text-foreground xl:grid", pinned ? "text-primary" : "text-subtle")} onClick={(event) => { event.currentTarget.blur(); onPinnedChange(!pinned); }} aria-label={pinned ? "取消固定目录" : "固定目录"} title={pinned ? "取消固定（收起为缩略目录）" : "固定目录"} aria-pressed={pinned} data-outline-pin>
            <PinIcon pinned={pinned} />
          </button>}
          <button type="button" className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label="关闭目录" title="关闭目录">
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>
          </button>
        </header>
        <nav className="min-h-0 flex-1 overflow-y-auto py-2 pl-4 pr-3 text-[14px] xl:pr-2" data-outline-list data-document-print-restricted={!allowPrint ? "true" : undefined} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }}>
          {items.length === 0 && <p className="px-2 py-8 text-center text-[13px] text-subtle">在文档中使用标题即可生成目录</p>}
          {rows.map(({ item: it, hasChildren }) => {
            const active = activeId === it.id;
            const folded = collapsed.has(it.id);
            const pad = 8 + (it.level - minLevel) * 16;
            return (
              <div key={it.id} className="group/row relative">
                {hasChildren && <button type="button" tabIndex={-1} aria-label={folded ? "展开" : "折叠"} aria-expanded={!folded} onClick={() => toggle(it.id)} className={cn("absolute top-[7px] z-10 grid size-5 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground", folded ? "" : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100")} style={{ left: pad - 18 }} data-outline-fold={it.id}>
                  <svg viewBox="0 0 16 16" className={cn("size-3 transition-transform", !folded && "rotate-90")} fill="currentColor" aria-hidden><path d="M6 4l4 4-4 4z" /></svg>
                </button>}
                <button
                  type="button"
                  className={cn(
                    "relative block w-full truncate rounded-md py-[5px] pr-2 text-left leading-[22px] transition-colors hover:bg-hover",
                    active ? "font-medium text-primary" : it.level === minLevel ? "text-foreground" : "text-muted-foreground",
                  )}
                  style={{ paddingLeft: pad }}
                  title={it.text}
                  aria-current={active ? "location" : undefined}
                  onClick={() => onJump(it.id)}
                  data-outline-item={it.id}
                >
                  {active && <span aria-hidden className="absolute inset-y-[7px] left-0 w-[2px] rounded-full bg-primary" />}
                  {it.text}
                </button>
              </div>
            );
          })}
        </nav>
      </div>
      {!pinned && <div className="hidden flex-col gap-[9px] pl-5 pt-[70px] xl:flex xl:group-hover/outline:invisible" aria-hidden data-outline-mini>
        {items.slice(0, 40).map((it) => <span key={it.id} className={cn("block h-[3px] rounded-full", activeId === it.id ? "bg-primary" : "bg-[#DEE0E3] dark:bg-border")} style={{ width: Math.max(8, 22 - (it.level - minLevel) * 5) }} />)}
      </div>}
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

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

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
export function activeOutlineId(items: OutlineItem[], tops: Record<string, number>, readingLine: number, fallbackFirst = true): string | null {
  let active: string | null = null;
  for (const it of items) {
    const top = tops[it.id];
    if (top === undefined) continue;
    if (top <= readingLine) active = it.id;
    else break;
  }
  return active ?? (fallbackFirst ? items[0]?.id ?? null : null);
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

export function compactOutlinePlacement(hostLeft: number, hostTop: number, anchorTop: number, viewportHeight: number) {
  return { left: Math.round(hostLeft), top: Math.round(Math.max(hostTop + 8, Math.min(anchorTop, viewportHeight - 180))) };
}

/** Keep the compact outline aligned to the document viewport and title. */
function useOutlinePlacement(hostRef?: RefObject<HTMLDivElement | null>) {
  const [placement, setPlacement] = useState({ left: 0, top: 64 });
  useLayoutEffect(() => {
    const host = hostRef?.current;
    if (!host) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const hostBox = host.getBoundingClientRect();
      const anchor = host.querySelector<HTMLElement>("[data-outline-anchor]");
      const anchorTop = anchor?.getBoundingClientRect().top ?? hostBox.top;
      const next = compactOutlinePlacement(hostBox.left, hostBox.top, anchorTop, window.innerHeight);
      setPlacement((prev) => prev.left === next.left && prev.top === next.top ? prev : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(host);
    const anchor = host.querySelector<HTMLElement>("[data-outline-anchor]");
    if (anchor) observer?.observe(anchor);
    const content = anchor?.closest<HTMLElement>("[data-document-focus-scope]")?.parentElement;
    if (content) observer?.observe(content);
    host.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => { if (frame) cancelAnimationFrame(frame); observer?.disconnect(); host.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, [hostRef]);
  return placement;
}

/** Direct entry beside the document, matching the compact Feishu outline. */
export function OutlineTrigger({ hostRef, buttonRef, panelId, expanded, yieldToSidePanel = false, onToggle }: { hostRef: RefObject<HTMLDivElement | null>; buttonRef: RefObject<HTMLButtonElement | null>; panelId: string; expanded: boolean; yieldToSidePanel?: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const placement = useOutlinePlacement(hostRef);
  return <button ref={buttonRef} type="button" aria-label={t(expanded ? "关闭目录" : "展开目录")} title={t(expanded ? "关闭目录" : "展开目录")} aria-expanded={expanded} aria-controls={expanded ? panelId : undefined} onClick={onToggle} style={{ left: placement.left + 10, top: placement.top }} className={cn("fixed z-[35] hidden size-8 place-items-center rounded-md text-[#646a73] hover:bg-hover focus-visible:outline-2 focus-visible:outline-primary md:grid", expanded && "xl:hidden", yieldToSidePanel && "md:max-[1679px]:hidden")} data-outline-trigger>
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M1.5 3.375c0-.207.168-.375.375-.375h14.25c.207 0 .375.168.375.375v.75a.375.375 0 0 1-.375.375H1.875a.375.375 0 0 1-.375-.375v-.75zm0 5.25c0-.207.168-.375.375-.375h14.25c.207 0 .375.168.375.375v.75a.375.375 0 0 1-.375.375H1.875a.375.375 0 0 1-.375-.375v-.75zm.375 4.875a.375.375 0 0 0-.375.375v.75c0 .207.168.375.375.375h9.75a.375.375 0 0 0 .375-.375v-.75a.375.375 0 0 0-.375-.375h-9.75z" fill="currentColor"/></svg>
  </button>;
}

/**
 * 飞书式目录：宽屏（≥1280px）时位于正文左侧并随页面吸顶，不遮挡顶栏。
 * 「固定」时常驻展开；取消固定后收成一列短横线（按层级长短、当前位置高亮），
 * 悬停或键盘展开浮层。有下级的标题可折叠；窄桌面贴正文左侧，手机使用抽屉。
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
  title,
  onTop,
  hostRef,
  id,
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
  /** 飞书目录首行显示文档标题，点击回到顶部。 */
  title?: string;
  onTop?: () => void;
  /** Scroll viewport that positions the compact desktop popover. */
  hostRef?: RefObject<HTMLDivElement | null>;
  id?: string;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [miniOpen, setMiniOpen] = useState(false);
  const [miniHover, setMiniHover] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const miniTrigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const placement = useOutlinePlacement(hostRef);
  useEffect(() => {
    if (!miniOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); setMiniOpen(false); setMiniHover(false); miniTrigger.current?.focus(); } };
    const outside = (event: PointerEvent) => { if (!asideRef.current?.contains(event.target as Node)) { setMiniOpen(false); setMiniHover(false); } };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside, true);
    return () => { document.removeEventListener("keydown", escape, true); document.removeEventListener("pointerdown", outside, true); };
  }, [miniOpen]);
  const minLevel = items.reduce((m, it) => Math.min(m, it.level), 6);
  const rows = visibleOutline(items, collapsed);
  const toggle = (id: string) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const afterJump = () => {
    if (!pinned && window.matchMedia("(min-width: 1280px)").matches) {
      setMiniOpen(false); setMiniHover(false);
      requestAnimationFrame(() => miniTrigger.current?.focus());
    }
  };
  return (
    <aside
      id={id}
      ref={asideRef}
      className={cn(
        "group/outline fixed bottom-0 right-0 top-14 z-30 flex w-72 max-w-[calc(100vw-16px)] flex-col border-l bg-surface shadow-xl md:bottom-auto md:right-auto md:left-[var(--outline-left)] md:top-[var(--outline-top)] md:max-h-[calc(100dvh_-_var(--outline-top)_-_8px)] md:w-[208px] md:rounded-lg md:border md:shadow-lg xl:sticky xl:left-auto xl:top-0 xl:z-10 xl:h-[calc(100vh-56px)] xl:max-h-none xl:shrink-0 xl:self-start xl:rounded-none xl:border-0 xl:bg-transparent xl:shadow-none",
        pinned ? "xl:w-[248px]" : "xl:w-14",
        yieldToSidePanel && "hidden min-[1680px]:flex",
      )}
      style={{ "--outline-left": `${placement.left}px`, "--outline-top": `${placement.top}px` } as CSSProperties}
      aria-label={t("目录")}
      data-outline-panel
      data-outline-pinned={pinned ? "true" : "false"}
      onMouseEnter={() => { if (!pinned && window.matchMedia("(hover: hover)").matches) setMiniHover(true); }}
      onMouseLeave={() => setMiniHover(false)}
      onFocusCapture={(event) => { if (!pinned && event.target !== miniTrigger.current && window.matchMedia("(min-width: 1280px)").matches) setMiniOpen(true); }}
    >
      <div id={panelId} className={cn("flex min-h-0 flex-1 flex-col", !pinned && "xl:absolute xl:left-3 xl:top-[50px] xl:z-30 xl:max-h-[calc(100vh-140px)] xl:w-[248px] xl:flex-none xl:rounded-lg xl:border xl:bg-surface xl:pb-1 xl:shadow-[0_6px_24px_rgba(31,35,41,0.12)]", !pinned && !(miniOpen || miniHover) && "xl:hidden")} data-outline-body>
        <header className={cn("flex h-11 shrink-0 items-center gap-0.5 pl-6 pr-3 pt-2 text-[14px] font-medium text-foreground md:max-xl:h-8 md:max-xl:pl-4 md:max-xl:pt-1 xl:h-auto xl:text-[13px] xl:text-muted-foreground", pinned ? "xl:pt-[58px]" : "xl:pb-1 xl:pl-4 xl:pt-3")}>
          <span className="mr-auto"><span className="md:max-xl:sr-only">{t("目录")}</span></span>
          {onPinnedChange && <button type="button" className={cn("hidden size-6 place-items-center rounded hover:bg-hover hover:text-foreground xl:grid", pinned ? "text-primary" : "text-subtle")} onClick={() => { const wasPinned = pinned; setMiniOpen(false); setMiniHover(false); onPinnedChange(!pinned); if (wasPinned) requestAnimationFrame(() => miniTrigger.current?.focus()); }} aria-label={t(pinned ? "取消固定目录" : "固定目录")} title={t(pinned ? "取消固定（收起为缩略目录）" : "固定目录")} aria-pressed={pinned} data-outline-pin>
            <PinIcon pinned={pinned} />
          </button>}
          <button type="button" className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label={t("关闭目录")} title={t("关闭目录")}>
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>
          </button>
        </header>
        <nav className="min-h-0 flex-1 overflow-y-auto py-2 pl-3 pr-3 text-[14px] xl:pr-2" data-outline-list data-document-print-restricted={!allowPrint ? "true" : undefined} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }}>
          {title !== undefined && onTop && <button type="button" className={cn("relative block w-full truncate rounded-md py-1 pl-2 pr-2 text-left leading-[22px] transition-colors hover:bg-hover", activeId === null ? "font-medium text-primary" : "text-foreground")} title={title} onClick={() => { onTop(); afterJump(); }} data-outline-title>{title}</button>}
          {items.length === 0 && <p className="px-2 py-8 text-center text-[13px] text-subtle">{t("在文档中使用标题即可生成目录")}</p>}
          {rows.map(({ item: it, hasChildren }) => {
            const active = activeId === it.id;
            const folded = collapsed.has(it.id);
            const pad = 8 + (it.level - minLevel) * 15;
            return (
              <div key={it.id} className="group/row relative">
                {hasChildren && <button type="button" aria-label={t(folded ? "展开 {title}" : "折叠 {title}", { title: it.text })} aria-expanded={!folded} onClick={() => toggle(it.id)} className={cn("absolute top-[5px] z-10 grid size-5 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground", folded ? "" : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100")} style={{ left: pad - 18 }} data-outline-fold={it.id}>
                  <svg viewBox="0 0 16 16" className={cn("size-3 transition-transform", !folded && "rotate-90")} fill="currentColor" aria-hidden><path d="M6 4l4 4-4 4z" /></svg>
                </button>}
                <button
                  type="button"
                  className={cn(
                    "relative block w-full truncate rounded-md py-1 pr-2 text-left leading-[22px] transition-colors hover:bg-hover",
                    active ? "font-medium text-primary" : it.level === minLevel ? "text-foreground" : "text-muted-foreground",
                  )}
                  style={{ paddingLeft: pad }}
                  title={it.text}
                  aria-current={active ? "location" : undefined}
                  onClick={() => { onJump(it.id); afterJump(); }}
                  data-outline-item={it.id}
                >
                  {active && <span aria-hidden className="absolute inset-y-[6px] left-0 w-[2px] rounded-full bg-primary" />}
                  {it.text}
                </button>
              </div>
            );
          })}
        </nav>
      </div>
      {!pinned && <button ref={miniTrigger} type="button" aria-label={t("展开目录")} aria-expanded={miniOpen || miniHover} aria-controls={panelId} onClick={() => setMiniOpen((value) => !value)} className="hidden w-14 flex-col gap-[9px] rounded pl-5 pt-[70px] text-left focus-visible:outline-2 focus-visible:outline-primary xl:flex" data-outline-mini>
        {items.slice(0, 40).map((it) => <span aria-hidden key={it.id} className={cn("block h-[3px] rounded-full", activeId === it.id ? "bg-primary" : "bg-[#DEE0E3] dark:bg-border")} style={{ width: Math.max(8, 22 - (it.level - minLevel) * 5) }} />)}
      </button>}
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

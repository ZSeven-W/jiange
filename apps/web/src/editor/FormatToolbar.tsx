import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { AlignCenter, AlignLeft, AlignRight, Bold, ChevronDown, Code2, Eraser, Italic, LayoutGrid, Link, Link2, MessageSquarePlus, Sparkles, Strikethrough, Underline } from "lucide-react";
import { MENU_ICONS } from "./menuIcons";

const TYPES: [string, string][] = [["paragraph", "文本"], ["h1", "一级标题"], ["h2", "二级标题"], ["h3", "三级标题"], ["h4", "四级标题"], ["bullet", "无序列表"], ["ordered", "有序列表"], ["todo", "待办"], ["quote", "引用"], ["code", "代码块"]];
const MARKS = [
  { key: "bold", label: "加粗", Icon: Bold },
  { key: "strike", label: "删除线", Icon: Strikethrough },
  { key: "italic", label: "斜体", Icon: Italic },
  { key: "underline", label: "下划线", Icon: Underline },
  { key: "code", label: "行内代码", Icon: Code2 },
] as const;

export const ALIGNS = [
  { value: "left", label: "左对齐", Icon: AlignLeft },
  { value: "center", label: "居中对齐", Icon: AlignCenter },
  { value: "right", label: "右对齐", Icon: AlignRight },
] as const;
export type Align = (typeof ALIGNS)[number]["value"];
/** 只接受已知对齐值，其余（含缺省）按左对齐处理。 */
export const blockAlign = (value: string | undefined): Align => (value === "center" || value === "right" ? value : "left");

/** 飞书文本色板（2026-11-11 实测面板）：字体颜色 8 个（首个为默认），背景颜色两排 16 个（首个为无）。 */
export const TEXT_COLORS = ["#1F2329", "#8F959E", "#D83931", "#DE7802", "#DC9B04", "#2EA121", "#245BDB", "#6425D0"];
export const BG_COLORS = ["", "#EFF0F1", "#FBBFBC", "#FED4A4", "#FFF67A", "#B7EDB1", "#BACEFD", "#CDB2FA", "#DEE0E3", "#BBBFC4", "#F76964", "#FFA53D", "#FFE928", "#62D256", "#4E83FD", "#935AF6"];

export function FormatToolbar({ x, y, marks, blockType, align, onMark, onLink, onType, onAlign, onClearFormat, onCopyLink, onComment, onAI, readOnly, commentError }: {
  x: number; y: number; marks: Record<string, string>; blockType: string;
  align?: string;
  onAlign?: (align: Align) => void;
  onClearFormat?: () => void;
  onCopyLink?: () => void;
  onMark: (key: string, value?: string) => void; onLink: (url: string) => void; onType: (t: string) => void;
  onComment?: () => void;
  /** 对选中文字使用 AI（未配置页面级 AI 时不显示）。 */
  onAI?: () => void;
  readOnly?: boolean;
  commentError?: string | null;
}) {
  const [link, setLink] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<"color" | null>(null);
  const [pop, setPop] = useState<"align" | "more" | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const [placement, setPlacement] = useState<{ left: number; top: number; maxWidth: number } | null>(null);

  // A fixed toolbar escapes the editor's scrolling clip. visualViewport also
  // tracks the area above a mobile keyboard and pinch-zoom offsets.
  useLayoutEffect(() => {
    const place = () => {
      const toolbar = toolbarRef.current;
      const parent = toolbar?.parentElement;
      if (!toolbar || !parent) return;
      const viewport = window.visualViewport;
      const leftBound = viewport?.offsetLeft ?? 0;
      const topBound = viewport?.offsetTop ?? 0;
      const rightBound = leftBound + (viewport?.width ?? window.innerWidth);
      const bottomBound = topBound + (viewport?.height ?? window.innerHeight);
      const maxWidth = Math.max(1, rightBound - leftBound - 16);
      // Set the width cap before measuring so wrapped toolbars have their real height.
      toolbar.style.maxWidth = `${maxWidth}px`;
      const parentRect = parent.getBoundingClientRect();
      const rect = toolbar.getBoundingClientRect();
      const anchorX = parentRect.left + x;
      const anchorY = parentRect.top + y;
      const left = Math.max(leftBound + 8, Math.min(anchorX - rect.width / 2, rightBound - rect.width - 8));
      const above = anchorY - rect.height - 8;
      const below = anchorY + 28;
      const preferredTop = above >= topBound + 8 ? above : below + rect.height <= bottomBound - 8 ? below : above;
      const top = Math.max(topBound + 8, Math.min(preferredTop, bottomBound - rect.height - 8));
      setPlacement((previous) => previous && previous.left === left && previous.top === top && previous.maxWidth === maxWidth ? previous : { left, top, maxWidth });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [x, y, link, blockType, onComment, readOnly, commentError]);

  // The type and color popovers remain descendants (so editor selection is
  // retained) but flip/clamp to the visible viewport and scroll if necessary.
  useLayoutEffect(() => {
    const fit = (element: HTMLDivElement | null) => {
      if (!element) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const right = left + (viewport?.width ?? window.innerWidth);
      const bottom = top + (viewport?.height ?? window.innerHeight);
      element.style.transform = "";
      element.style.maxHeight = `${Math.max(1, bottom - top - 16)}px`;
      element.style.overflowY = "auto";
      const rect = element.getBoundingClientRect();
      const dx = rect.left < left + 8 ? left + 8 - rect.left : rect.right > right - 8 ? right - 8 - rect.right : 0;
      let dy = 0;
      if (rect.bottom > bottom - 8) {
        const flipped = -rect.height - 40;
        dy = rect.top + flipped >= top + 8 ? flipped : bottom - 8 - rect.bottom;
      }
      if (rect.top + dy < top + 8) dy = top + 8 - rect.top;
      element.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const update = () => { fit(typeMenuRef.current); fit(paletteRef.current); fit(popRef.current); };
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [palette, menu, pop, placement]);
  const current = blockAlign(align);
  const AlignIcon = ALIGNS.find((a) => a.value === current)!.Icon;
  const more = !readOnly && (onClearFormat || onCopyLink);
  const label = TYPES.find(([t]) => t === blockType)?.[1] ?? "文本";
  const TypeIcon = MENU_ICONS[blockType] ?? MENU_ICONS.paragraph;
  const sep = <span className="mx-1 h-5 w-px shrink-0 bg-[#DEE0E3] dark:bg-border" />;
  const btn = "grid size-7 shrink-0 place-items-center rounded-md text-[#1F2329] hover:bg-hover dark:text-foreground";
  return (
    <div
      ref={toolbarRef}
      data-format-toolbar
      className="fixed z-30 flex min-h-10 w-max flex-wrap items-center gap-0.5 rounded-lg border border-[#DEE0E3] bg-surface px-1.5 py-1 text-foreground shadow-[0_4px_16px_rgba(31,35,41,0.12)] dark:border-border"
      style={placement ? { left: placement.left, top: placement.top, maxWidth: placement.maxWidth } : { left: 0, top: 0, visibility: "hidden" }}
      onMouseDown={(e) => (e.target as HTMLElement).tagName !== "INPUT" && e.preventDefault()}
    >
      {!readOnly && link !== null ? (
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (link.trim()) onLink(link.trim()); setLink(null); }}>
          <input autoFocus value={link} onChange={(e) => setLink(e.target.value)} placeholder="粘贴或输入链接" className="h-8 w-56 max-w-[calc(100vw-96px)] rounded border px-2 text-base outline-none focus:border-primary sm:h-7 sm:text-[13px]" />
          <button className="h-7 rounded bg-primary px-2.5 text-[13px] text-white">确定</button>
        </form>
      ) : <>
        {/* 飞书实测顺序：AI | 文本类型、对齐 | 加粗、删除线、斜体、下划线、链接、行内代码、颜色 | 更多、评论 */}
        {onAI && <><button type="button" onClick={onAI} className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] hover:bg-hover" title="AI" data-toolbar-ai><Sparkles size={15} className="text-primary" />AI</button>{sep}</>}
        {!readOnly && <>
          <div className="relative">
            <button type="button" title={`文本类型：${label}`} aria-label={`文本类型：${label}`} aria-haspopup="menu" aria-expanded={menu} className={cn("flex h-7 shrink-0 items-center gap-0.5 rounded-md px-1 hover:bg-hover", menu && "bg-hover")} onClick={() => { setMenu((m) => !m); setPalette(null); setPop(null); }} data-type-btn>
              <TypeIcon size={16} strokeWidth={1.7} /><ChevronDown size={12} className="text-subtle" />
            </button>
            {menu && (
              <div ref={typeMenuRef} className="absolute left-0 top-9 z-40 w-36 rounded-lg border border-[#DEE0E3] bg-surface p-1 shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border">
                {TYPES.map(([t, l]) => { const Icon = MENU_ICONS[t] ?? MENU_ICONS.paragraph; return (
                  <button key={t} type="button" className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover", t === blockType && "text-primary")} onClick={() => { onType(t); setMenu(false); }}>
                    <Icon size={15} strokeWidth={1.7} />{l}
                  </button>
                ); })}
              </div>
            )}
          </div>
          {onAlign && <span className="relative flex">
            <button type="button" title="对齐" aria-label="对齐" aria-haspopup="menu" aria-expanded={pop === "align"} onClick={() => { setPop((p) => (p === "align" ? null : "align")); setMenu(false); setPalette(null); }} className={cn("flex h-7 items-center gap-0.5 rounded-md px-1 hover:bg-hover", pop === "align" && "bg-hover")} data-align-btn>
              <AlignIcon size={15} strokeWidth={1.8} /><ChevronDown size={12} className="text-subtle" />
            </button>
            {pop === "align" && <div ref={popRef} role="menu" className="absolute left-0 top-9 z-40 flex gap-0.5 rounded-lg border border-[#DEE0E3] bg-surface p-1 shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border" data-align-pop>
              {ALIGNS.map(({ value, label: alignLabel, Icon }) => (
                <button key={value} type="button" role="menuitemradio" aria-checked={current === value} title={alignLabel} aria-label={alignLabel} onClick={() => { onAlign(value); setPop(null); }} className={cn("grid size-7 place-items-center rounded hover:bg-hover", current === value && "bg-primary/10 text-primary")} data-align={value}>
                  <Icon size={15} strokeWidth={1.8} />
                </button>
              ))}
            </div>}
          </span>}
          {sep}
          {MARKS.map(({ key, label: markLabel, Icon }) => key === "code" ? null : (
            <button key={key} type="button" title={markLabel} aria-label={markLabel} aria-pressed={!!marks[key]} onClick={() => onMark(key)} className={cn(btn, marks[key] && "bg-[#E1EAFF] text-primary dark:bg-primary/20")}>
              <Icon size={15} strokeWidth={1.8} />
            </button>
          ))}
          <button type="button" title="链接" aria-label="链接" onClick={() => (marks.link ? onMark("link", marks.link) : setLink(""))} className={cn(btn, marks.link && "bg-[#E1EAFF] text-primary dark:bg-primary/20")}>
            <Link2 size={15} strokeWidth={1.7} />
          </button>
          <button type="button" title="行内代码" aria-label="行内代码" aria-pressed={!!marks.code} onClick={() => onMark("code")} className={cn(btn, marks.code && "bg-[#E1EAFF] text-primary dark:bg-primary/20")}>
            <Code2 size={15} strokeWidth={1.8} />
          </button>
          <span className="relative flex">
            <button type="button" title="字体与背景颜色" aria-label="字体与背景颜色" aria-haspopup="dialog" aria-expanded={!!palette} onClick={() => { setPalette((p) => (p ? null : "color")); setMenu(false); setPop(null); }} className={cn("flex h-7 items-center gap-0.5 rounded-md px-1 hover:bg-hover", palette && "bg-hover")} data-color-btn>
              <span className="grid size-[18px] place-items-center rounded-[3px] text-[13px] font-medium leading-none" style={{ color: marks.color || "#1F2329", background: marks.bg || "#FFF67A" }}>A</span>
              <ChevronDown size={12} className={cn("text-subtle transition-transform", palette && "rotate-180")} />
            </button>
            {palette && (
              <div ref={paletteRef} className="absolute left-0 top-9 z-40 w-[227px] rounded-lg border border-[#DEE0E3] bg-surface p-2.5 shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border" data-color-pop>
                <div className="mb-1.5 text-[12px] text-[#646A73]">字体颜色</div>
                <div className="grid grid-cols-8 gap-1">
                  {TEXT_COLORS.map((c, i) => {
                    const on = i === 0 ? !marks.color : marks.color === c;
                    return <button key={c} type="button" title={i === 0 ? "默认字体颜色" : `字体颜色 ${c}`} aria-label={i === 0 ? "默认字体颜色" : `字体颜色 ${c}`} aria-pressed={on} onClick={() => onMark("color", i === 0 ? "" : on ? undefined : c)} className={cn("grid size-[22px] place-items-center rounded border text-[13px] font-medium", on ? "border-primary" : "border-[#DEE0E3] hover:border-[#BBBFC4]")} style={{ color: c }} data-text-color={c}>A</button>;
                  })}
                </div>
                <div className="mb-1.5 mt-2.5 text-[12px] text-[#646A73]">背景颜色</div>
                <div className="grid grid-cols-8 gap-1">
                  {BG_COLORS.map((c, i) => {
                    const on = i === 0 ? !marks.bg : marks.bg === c;
                    return <button key={c || "none"} type="button" title={i === 0 ? "无背景色" : `背景颜色 ${c}`} aria-label={i === 0 ? "无背景色" : `背景颜色 ${c}`} aria-pressed={on} onClick={() => onMark("bg", i === 0 ? "" : on ? undefined : c)} className={cn("relative size-[22px] overflow-hidden rounded border", on ? "border-primary ring-1 ring-primary" : "border-transparent hover:border-[#BBBFC4]", i === 0 && "border-[#DEE0E3] bg-surface")} style={i === 0 ? undefined : { background: c }} data-bg-color={c || "none"}>{i === 0 && <span className="absolute left-1/2 top-[-3px] h-[28px] w-px rotate-45 bg-[#F54A45]" />}</button>;
                  })}
                </div>
                <button type="button" className="mt-2.5 block h-7 w-full rounded-md border border-[#DEE0E3] text-[12px] text-[#1F2329] hover:bg-hover dark:border-border dark:text-foreground" onClick={() => { onMark("color", ""); onMark("bg", ""); setPalette(null); }} data-clear-color>恢复默认</button>
              </div>
            )}
          </span>
          {sep}
        </>}
        {more && <span className="relative flex">
          <button type="button" title="更多" aria-label="更多" aria-haspopup="menu" aria-expanded={pop === "more"} onClick={() => { setPop((p) => (p === "more" ? null : "more")); setMenu(false); setPalette(null); }} className={cn(btn, pop === "more" && "bg-hover")} data-more-btn>
            <LayoutGrid size={15} strokeWidth={1.7} />
          </button>
          {pop === "more" && <div ref={popRef} role="menu" className="absolute right-0 top-9 z-40 w-40 rounded-lg border border-[#DEE0E3] bg-surface p-1 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border" data-more-pop>
            {onClearFormat && <button type="button" role="menuitem" onClick={() => { onClearFormat(); setPop(null); }} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover" data-clear-format><Eraser size={14} strokeWidth={1.7} className="text-muted-foreground" />清除格式</button>}
            {onCopyLink && <button type="button" role="menuitem" onClick={() => { onCopyLink(); setPop(null); }} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover" data-copy-block-link><Link size={14} strokeWidth={1.7} className="text-muted-foreground" />复制段落链接</button>}
          </div>}
        </span>}
        {onComment && (
          <button type="button" className={btn} title="评论" aria-label="评论" onClick={onComment} data-comment-btn>
            <MessageSquarePlus size={15} strokeWidth={1.7} />
          </button>
        )}
      </>}
      {commentError && <span role="alert" className="max-w-52 px-2 text-[12px] text-destructive">{commentError}</span>}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ChevronRight, Copy, IndentDecrease, IndentIncrease, Link2, MessageSquarePlus, Palette, Scissors, Trash2 } from "lucide-react";
import { MENU_ICONS } from "./menuIcons";
import { cn } from "@/lib/utils";

/** 纯文本类块：可显示“+”空行入口，也可在块菜单中互相转换、缩进和设置颜色。 */
export const TEXT_BLOCKS = new Set(["paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "bullet", "ordered", "todo", "quote"]);
export const CONVERTIBLE = TEXT_BLOCKS;
/** 块菜单可设置文字/背景颜色的块。 */
export const COLORABLE = new Set([...TEXT_BLOCKS, "callout"]);
export const MAX_INDENT = 5;

/** 飞书块菜单顶部的“转换为”图标行（顺序与飞书一致：正文、标题、列表、任务、引用）。 */
export const CONVERT_TARGETS: { type: string; label: string }[] = [
  { type: "paragraph", label: "正文" },
  { type: "h1", label: "一级标题" },
  { type: "h2", label: "二级标题" },
  { type: "h3", label: "三级标题" },
  { type: "ordered", label: "有序列表" },
  { type: "bullet", label: "无序列表" },
  { type: "todo", label: "任务列表" },
  { type: "quote", label: "引用" },
];

/** 飞书风格色板：文字色与同色浅背景。与浮动工具栏共用。 */
export const PALETTE = ["#1F2329", "#F54A45", "#FF8800", "#FFC60A", "#00B42A", "#3370FF", "#7B61FF", "#E63995"];

export type BlockMenuAction =
  | { kind: "convert"; type: string }
  | { kind: "indent"; delta: 1 | -1 }
  | { kind: "color"; key: "color" | "bg"; value: string | null }
  | { kind: "copy" }
  | { kind: "cut" }
  | { kind: "link" }
  | { kind: "comment" }
  | { kind: "insertAfter" }
  | { kind: "delete" };

export interface BlockMenuAbilities {
  convert?: boolean;
  color?: boolean;
  indent?: boolean;
  copy?: boolean;
  cut?: boolean;
  link?: boolean;
  comment?: boolean;
  insertAfter?: boolean;
  delete?: boolean;
}

function TypeGlyph({ type, size = 16 }: { type: string; size?: number }) {
  const Icon = MENU_ICONS[type] ?? MENU_ICONS.paragraph;
  return <Icon size={size} strokeWidth={1.7} />;
}

function Grip() {
  return <svg viewBox="0 0 8 14" className="h-[14px] w-[8px]" fill="currentColor" aria-hidden>
    {[2, 7, 12].map((y) => <g key={y}><circle cx="2" cy={y} r="1.1" /><circle cx="6" cy={y} r="1.1" /></g>)}
  </svg>;
}

/**
 * 飞书式块手柄：悬停块时在左侧显示“块类型图标 + 拖拽点”，可拖动排序，点击展开块菜单：
 * 转换为 / 颜色 / 缩进 / 剪切、复制、复制链接、评论 / 在下方添加、删除。
 * 跨块选区时手柄出现在第一个选中块上，`count` 为选中块数，菜单作用于全部选中块。
 */
export function BlockHandle({ type, open, onOpenChange, onDragStart, onDragEnd, onAction, can = {}, count = 1, indent = 0 }: {
  type: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onAction?: (action: BlockMenuAction) => void;
  can?: BlockMenuAbilities;
  count?: number;
  indent?: number;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [colors, setColors] = useState(false);
  useEffect(() => {
    if (!open) { setColors(false); return; }
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) onOpenChange(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onOpenChange(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, onOpenChange]);
  const act = (action: BlockMenuAction) => () => { onOpenChange(false); onAction?.(action); };
  const multi = count > 1;
  const item = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[14px] text-foreground hover:bg-hover disabled:pointer-events-none disabled:opacity-40";
  const icon = "shrink-0 text-muted-foreground";
  const keep = (event: React.MouseEvent) => event.preventDefault();
  const groupA = can.color || can.indent;
  const groupB = can.cut || can.copy || (can.link && !multi) || (can.comment && !multi);
  const groupC = (can.insertAfter && !multi) || can.delete;
  return <span ref={root} className="relative" contentEditable={false}>
    <button
      type="button"
      draggable={!!onDragStart && !multi}
      onDragStart={(e) => { if (!onDragStart || multi) return; e.dataTransfer.setData("text/plain", ""); e.dataTransfer.effectAllowed = "move"; onOpenChange(false); onDragStart(); }}
      onDragEnd={onDragEnd}
      onMouseDown={keep}
      onClick={() => onOpenChange(!open)}
      title={multi ? `已选择 ${count} 个块` : onDragStart ? "点击打开菜单，拖动以移动" : "块菜单"}
      aria-label={multi ? `${count} 个块的菜单` : "块菜单"}
      aria-haspopup="menu"
      aria-expanded={open}
      className={cn("flex h-6 items-center gap-px rounded-md px-1 text-subtle transition-colors hover:bg-hover hover:text-foreground", onDragStart && !multi && "cursor-grab active:cursor-grabbing", (open || multi) && "bg-hover text-foreground", multi && "bg-primary/10 text-primary")}
      data-block-handle
    >
      {multi ? <span className="min-w-[15px] text-center text-[12px] font-medium tabular-nums">{count}</span> : <TypeGlyph type={type} size={15} />}
      <Grip />
    </button>
    {open && <div role="menu" className="absolute left-0 top-7 z-40 w-[236px] rounded-lg border bg-surface p-1 text-[14px] font-normal leading-normal tracking-normal shadow-[0_6px_24px_rgba(31,35,41,0.12)]" data-block-menu>
      {multi && <div className="px-2 pb-1 pt-1.5 text-[12px] text-subtle">已选择 {count} 个块</div>}
      {can.convert && <>
        <div className="grid grid-cols-8 gap-0.5 p-1">
          {CONVERT_TARGETS.map((t) => <button key={t.type} type="button" role="menuitem" title={t.label} aria-label={`转换为${t.label}`} onMouseDown={keep} onClick={act({ kind: "convert", type: t.type })} className={cn("grid size-[26px] place-items-center rounded-md hover:bg-hover", t.type === type && !multi ? "bg-primary/10 text-primary" : "text-muted-foreground")} data-convert-to={t.type}><TypeGlyph type={t.type} /></button>)}
        </div>
        {(groupA || groupB || groupC) && <div className="mx-1 my-1 h-px bg-border" />}
      </>}
      {can.color && <div className="relative" onMouseEnter={() => setColors(true)} onMouseLeave={() => setColors(false)}>
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={colors} className={cn(item, colors && "bg-hover")} onMouseDown={keep} onClick={() => setColors((v) => !v)} data-block-colors><Palette size={16} strokeWidth={1.6} className={icon} />颜色<ChevronRight size={14} className="ml-auto text-subtle" /></button>
        {colors && <div role="menu" className="absolute left-full top-0 z-50 ml-1 w-[208px] rounded-lg border bg-surface p-2 shadow-[0_6px_24px_rgba(31,35,41,0.12)]" data-block-color-pop>
          <div className="mb-1 px-0.5 text-[12px] text-subtle">字体颜色</div>
          <div className="grid grid-cols-8 gap-1">
            {PALETTE.map((c) => <button key={c} type="button" title={`字体颜色 ${c}`} aria-label={`字体颜色 ${c}`} onMouseDown={keep} onClick={act({ kind: "color", key: "color", value: c })} className="grid size-[21px] place-items-center rounded border border-border text-[12px] font-semibold hover:ring-1 hover:ring-primary" style={{ color: c }} data-block-text-color={c}>A</button>)}
          </div>
          <div className="mb-1 mt-2 px-0.5 text-[12px] text-subtle">背景颜色</div>
          <div className="grid grid-cols-8 gap-1">
            {PALETTE.map((c) => <button key={c} type="button" title={`背景颜色 ${c}`} aria-label={`背景颜色 ${c}`} onMouseDown={keep} onClick={act({ kind: "color", key: "bg", value: c })} className="size-[21px] rounded border border-transparent hover:ring-1 hover:ring-primary" style={{ background: `${c}33` }} data-block-bg-color={c} />)}
          </div>
          <button type="button" onMouseDown={keep} onClick={() => { onOpenChange(false); onAction?.({ kind: "color", key: "color", value: null }); onAction?.({ kind: "color", key: "bg", value: null }); }} className="mt-2 block w-full rounded px-1.5 py-1 text-left text-[12px] text-muted-foreground hover:bg-hover" data-block-color-reset>恢复默认</button>
        </div>}
      </div>}
      {can.indent && <>
        <button type="button" role="menuitem" className={item} disabled={!multi && indent >= MAX_INDENT} onMouseDown={keep} onClick={act({ kind: "indent", delta: 1 })} data-block-indent><IndentIncrease size={16} strokeWidth={1.6} className={icon} />增加缩进<span className="ml-auto text-[12px] text-subtle">Tab</span></button>
        <button type="button" role="menuitem" className={item} disabled={!multi && indent <= 0} onMouseDown={keep} onClick={act({ kind: "indent", delta: -1 })} data-block-outdent><IndentDecrease size={16} strokeWidth={1.6} className={icon} />减少缩进<span className="ml-auto text-[12px] text-subtle">Shift+Tab</span></button>
      </>}
      {groupA && groupB && <div className="mx-1 my-1 h-px bg-border" />}
      {can.cut && <button type="button" role="menuitem" className={item} onMouseDown={keep} onClick={act({ kind: "cut" })} data-block-cut><Scissors size={16} strokeWidth={1.6} className={icon} />剪切</button>}
      {can.copy && <button type="button" role="menuitem" className={item} onMouseDown={keep} onClick={act({ kind: "copy" })} data-block-copy><Copy size={16} strokeWidth={1.6} className={icon} />复制</button>}
      {can.link && !multi && <button type="button" role="menuitem" className={item} onMouseDown={keep} onClick={act({ kind: "link" })} data-block-link><Link2 size={16} strokeWidth={1.6} className={icon} />复制链接</button>}
      {can.comment && !multi && <button type="button" role="menuitem" className={item} onMouseDown={keep} onClick={act({ kind: "comment" })} data-block-comment><MessageSquarePlus size={16} strokeWidth={1.6} className={icon} />评论</button>}
      {(groupA || groupB) && groupC && <div className="mx-1 my-1 h-px bg-border" />}
      {can.insertAfter && !multi && <button type="button" role="menuitem" className={item} onMouseDown={keep} onClick={act({ kind: "insertAfter" })} data-insert-after><ArrowDownToLine size={16} strokeWidth={1.6} className={icon} />在下方添加</button>}
      {can.delete && <button type="button" role="menuitem" className={cn(item, "hover:text-destructive")} onClick={act({ kind: "delete" })} data-delete-block><Trash2 size={16} strokeWidth={1.6} className={icon} />{multi ? `删除 ${count} 个块` : "删除"}</button>}
    </div>}
  </span>;
}

/** 复制块链接：当前文档地址 + `?block=` 参数（哈希路由）。 */
export function blockLink(href: string, blockKey: string): string {
  const [base, hash = ""] = href.split("#");
  const route = hash.replace(/\?.*$/, "");
  return `${base}#${route}?block=${encodeURIComponent(blockKey)}`;
}

/** 从地址哈希中读取被链接的块。 */
export function linkedBlock(hash: string): string | null {
  const m = /[?&]block=([^&]+)/.exec(hash);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

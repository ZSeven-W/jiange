import { useEffect, useRef } from "react";
import { ArrowDownToLine, Trash2 } from "lucide-react";
import { MENU_ICONS } from "./menuIcons";
import { cn } from "@/lib/utils";

/** 纯文本类块：可显示“+”空行入口，也可在块菜单中互相转换。 */
export const TEXT_BLOCKS = new Set(["paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "bullet", "ordered", "todo", "quote"]);
export const CONVERTIBLE = TEXT_BLOCKS;

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
 * 飞书式块手柄：悬停块时在左侧显示“块类型图标 + 拖拽点”，可拖动排序，
 * 点击展开块菜单（转换为 / 在下方添加 / 删除）。
 */
export function BlockHandle({ type, open, onOpenChange, onDragStart, onDragEnd, onInsertAfter, onDelete, onConvert }: {
  type: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onInsertAfter?: () => void;
  onDelete?: () => void;
  onConvert?: (type: string) => void;
}) {
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) onOpenChange(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onOpenChange(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, onOpenChange]);
  const run = (fn?: () => void) => () => { onOpenChange(false); fn?.(); };
  const item = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[14px] text-foreground hover:bg-hover";
  return <span ref={root} className="relative" contentEditable={false}>
    <button
      type="button"
      draggable={!!onDragStart}
      onDragStart={(e) => { if (!onDragStart) return; e.dataTransfer.setData("text/plain", ""); e.dataTransfer.effectAllowed = "move"; onOpenChange(false); onDragStart(); }}
      onDragEnd={onDragEnd}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onOpenChange(!open)}
      title={onDragStart ? "点击打开菜单，拖动以移动" : "块菜单"}
      aria-label="块菜单"
      aria-haspopup="menu"
      aria-expanded={open}
      className={cn("flex h-6 items-center gap-px rounded-md px-1 text-subtle transition-colors hover:bg-hover hover:text-foreground", onDragStart && "cursor-grab active:cursor-grabbing", open && "bg-hover text-foreground")}
      data-block-handle
    >
      <TypeGlyph type={type} size={15} />
      <Grip />
    </button>
    {open && <div role="menu" className="absolute left-0 top-7 z-40 w-[236px] text-[14px] font-normal leading-normal tracking-normal rounded-lg border bg-surface p-1 shadow-[0_6px_24px_rgba(31,35,41,0.12)]" data-block-menu>
      {onConvert && <>
        <div className="grid grid-cols-8 gap-0.5 p-1">
          {CONVERT_TARGETS.map((t) => <button key={t.type} type="button" role="menuitem" title={t.label} aria-label={`转换为${t.label}`} onMouseDown={(event) => event.preventDefault()} onClick={run(() => { if (t.type !== type) onConvert(t.type); })} className={cn("grid size-[26px] place-items-center rounded-md hover:bg-hover", t.type === type ? "bg-primary/10 text-primary" : "text-muted-foreground")} data-convert-to={t.type}><TypeGlyph type={t.type} /></button>)}
        </div>
        <div className="mx-1 my-1 h-px bg-border" />
      </>}
      {onInsertAfter && <button type="button" role="menuitem" className={item} onMouseDown={(event) => event.preventDefault()} onClick={run(onInsertAfter)} data-insert-after><ArrowDownToLine size={16} strokeWidth={1.6} className="text-muted-foreground" />在下方添加</button>}
      {onDelete && <button type="button" role="menuitem" className={cn(item, "hover:text-destructive")} onClick={run(onDelete)} data-delete-block><Trash2 size={16} strokeWidth={1.6} className="text-muted-foreground" />删除</button>}
    </div>}
  </span>;
}

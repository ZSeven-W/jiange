import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { CALLOUT_COLORS } from "./blockStyles";

/** 飞书高亮块常用图标（分组顺序：提示、状态、标记、表情）。 */
export const CALLOUT_EMOJIS = [
  "💡", "📌", "📢", "⚠️", "❗", "❓", "✅", "❌",
  "🔥", "⭐", "🎯", "🚀", "📝", "📎", "📅", "⏰",
  "🔔", "🔒", "🔑", "🧭", "📊", "📈", "🛠️", "🎉",
  "👍", "👀", "🙋", "🤔", "😀", "😎", "❤️", "🌈",
] as const;

/** 高亮块配色名称，与 CALLOUT_COLORS 一一对应。 */
export const CALLOUT_COLOR_NAMES = ["橙色", "蓝色", "绿色", "灰色", "黄色", "紫色", "红色"] as const;

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open, close]);
  return ref;
}

const keep = (e: React.MouseEvent) => e.preventDefault();

/** 高亮块左侧图标：点击打开图标面板（只读时仅展示）。 */
export function CalloutEmoji({ emoji, onPick, initialOpen = false }: { emoji?: string; onPick?: (emoji: string) => void; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const ref = useDismiss(open, () => setOpen(false));
  const current = emoji || "💡";
  return <span ref={ref} contentEditable={false} className="relative select-none pt-0.5 text-[16px] leading-6">
    <button type="button" className={cn("grid size-6 place-items-center rounded", onPick && "hover:bg-black/5")} title={onPick ? "更换图标" : undefined} aria-label="高亮块图标" aria-haspopup={onPick ? "dialog" : undefined} aria-expanded={onPick ? open : undefined} disabled={!onPick} onMouseDown={keep} onClick={() => setOpen((v) => !v)} data-callout-emoji>
      {current}
    </button>
    {open && onPick && <div role="dialog" aria-label="选择图标" className="absolute left-0 top-8 z-40 w-[264px] rounded-lg border bg-surface p-2 text-[14px] shadow-[0_6px_24px_rgba(31,35,41,0.12)]" data-callout-emoji-pop>
      <div className="px-1 pb-1.5 text-[12px] text-subtle">图标</div>
      <div className="grid grid-cols-8 gap-0.5">
        {CALLOUT_EMOJIS.map((e) => <button key={e} type="button" onMouseDown={keep} onClick={() => { onPick(e); setOpen(false); }} className={cn("grid size-[30px] place-items-center rounded-md text-[18px] hover:bg-hover", e === current && "bg-primary/10")} aria-label={`使用 ${e}`} data-callout-emoji-option={e}>{e}</button>)}
      </div>
    </div>}
  </span>;
}

/** 悬停高亮块时右上角的浮动配色条（飞书：背景与边框成对切换）。 */
export function CalloutColorBar({ color, onPick }: { color?: string; onPick: (index: number) => void }) {
  const active = Number(color ?? 0) || 0;
  return <span contentEditable={false} className="absolute -top-[38px] right-0 z-20 hidden items-center gap-1 rounded-lg border bg-surface px-2 py-1.5 shadow-[0_4px_16px_rgba(31,35,41,0.12)] group-hover:flex" data-callout-colors>
    <span className="mr-0.5 text-[12px] text-subtle">颜色</span>
    {CALLOUT_COLORS.map(([bg, border], i) => (
      <button key={i} type="button" onMouseDown={keep} onClick={() => onPick(i)} title={CALLOUT_COLOR_NAMES[i]} aria-label={`高亮块${CALLOUT_COLOR_NAMES[i]}`} aria-pressed={active === i} className={cn("size-[18px] rounded-[4px] border-2", active === i && "ring-2 ring-primary ring-offset-1")} style={{ background: bg, borderColor: border }} data-callout-color-option={i} />
    ))}
  </span>;
}

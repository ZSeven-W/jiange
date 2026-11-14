import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Palette, X } from "lucide-react";
import { backgroundPopoverPosition, SLIDE_BACKGROUND_COLORS } from "./slides-background";

export function SlideFormatPanel({ background, usedColors, canEdit, busy, applying, onChange, onMore, onApplyAll, onClose }: {
  background: string; usedColors: string[]; canEdit: boolean; busy: boolean; applying: boolean;
  onChange: (color: string) => void; onMore: () => void; onApplyAll: () => void; onClose: () => void;
}) {
  const [palette, setPalette] = useState(false);
  const paletteRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!palette) return;
    const outside = (event: PointerEvent) => { if (!paletteRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPalette(false); };
    const close = () => setPalette(false);
    const scroll = (event: Event) => { if (!paletteRef.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", close); window.removeEventListener("scroll", scroll, true); };
  }, [palette]);
  const colors = [...new Set(usedColors.filter((color) => /^#[0-9a-f]{6}$/i.test(color)).map((color) => color.toLowerCase()))].slice(0, 7);
  const choose = (color: string) => { onChange(color); setPalette(false); trigger.current?.focus(); };
  return <aside className="z-20 flex max-h-[42%] w-full shrink-0 flex-col border-t border-[#dee0e3] bg-white md:max-h-none md:w-[294px] md:border-l md:border-t-0" data-slide-format aria-label="幻灯片格式" onKeyDown={(event) => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); if (palette) { setPalette(false); trigger.current?.focus(); } else onClose(); }}>
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[#e5e6eb] px-5 text-[14px] font-medium text-[#1f2329]"><Palette size={16} strokeWidth={1.7}/><span>幻灯片格式</span><button type="button" onClick={onClose} className="ml-auto grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]" aria-label="关闭幻灯片格式"><X size={16}/></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4 text-[13px] text-[#1f2329]">
      <div className="mb-4 font-medium">背景</div>
      <div className="relative flex h-9 items-center justify-between"><span>颜色填充</span><button ref={trigger} type="button" disabled={!canEdit} aria-label="选择背景颜色" aria-expanded={palette} onClick={() => setPalette((open) => !open)} className="grid size-7 place-items-center rounded border border-[#dee0e3] hover:border-[#3370ff] disabled:opacity-40"><span className="grid size-5 place-items-center rounded-sm border border-[#d0d3d6]" style={{ background: background || "linear-gradient(135deg,#fff 45%,#f28b82 47%,#f28b82 53%,#fff 55%)" }}/></button>
        {palette && trigger.current && createPortal(<div ref={paletteRef} role="group" aria-label="背景颜色" style={backgroundPopoverPosition(trigger.current.getBoundingClientRect(), window.innerWidth, window.innerHeight, colors.length ? 300 : 265)} className="fixed z-[100] overflow-y-auto rounded-lg border border-[#dee0e3] bg-white p-3 text-[12px] shadow-[0_6px_24px_rgba(31,35,41,0.16)]">
          {colors.length > 0 && <><p className="mb-2 text-[#8f959e]">幻灯片使用过的颜色</p><div className="mb-3 flex flex-wrap gap-1.5">{colors.map((color) => <ColorButton key={color} color={color} disabled={!canEdit} selected={background.toLowerCase() === color} onClick={() => choose(color)}/>)}</div></>}
          <p className="mb-2 text-[#8f959e]">基础色</p><div className="grid grid-cols-7 gap-1.5">{SLIDE_BACKGROUND_COLORS.map((color) => <ColorButton key={color} color={color} disabled={!canEdit} selected={background.toLowerCase() === color} onClick={() => choose(color)}/>)}</div>
          <div className="mt-3 border-t border-[#e5e6eb] pt-1"><button type="button" disabled={!canEdit} onClick={() => choose("")} className="flex h-8 w-full items-center gap-2 rounded px-1 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><span className="size-4 rounded-full border border-[#dee0e3]" style={{ background: "linear-gradient(135deg,#fff 45%,#f28b82 47%,#f28b82 53%,#fff 55%)" }}/>无填充</button><button type="button" disabled={!canEdit} onClick={() => { setPalette(false); onMore(); }} className="flex h-8 w-full items-center gap-2 rounded px-1 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><span className="size-4 rounded-full" style={{ background: "conic-gradient(#f65,#fc4,#4c8,#48f,#b6e,#f65)" }}/>更多颜色<ChevronRight size={14} className="ml-auto"/></button></div>
        </div>, document.body)}
      </div>
      <button type="button" disabled={!canEdit || busy} onClick={onApplyAll} className="mt-4 h-8 w-full rounded-md border border-[#dee0e3] text-[12px] hover:bg-[#f2f3f5] disabled:opacity-40">{applying ? "正在应用…" : "应用到全部"}</button>
    </div>
  </aside>;
}

function ColorButton({ color, disabled, selected, onClick }: { color: string; disabled: boolean; selected: boolean; onClick: () => void }) {
  return <button type="button" aria-label={`背景颜色 ${color}`} aria-pressed={selected} title={color} disabled={disabled} onClick={onClick} className="grid size-6 place-items-center rounded-full border border-black/10 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#3370ff] disabled:opacity-40" style={{ backgroundColor: color }}>{selected && <Check size={13} strokeWidth={2} className={color === "#1f2329" ? "text-white" : "text-[#1f2329]"}/>}</button>;
}

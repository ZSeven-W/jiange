import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { SLIDE_SHAPES, SlideShapeGraphic, type BasicSlideShape } from "./slide-shape-catalog";

const groups = ["基础", "线条", "箭头"] as const;
type ShapeGroup = typeof groups[number];

/** Keep the popover within the viewport, including short landscape screens. */
export function slideShapePickerPosition(trigger: Pick<DOMRect, "left" | "top" | "bottom">, width: number, height: number) {
  const margin = 12;
  const panelWidth = Math.max(1, Math.min(516, width - margin * 2));
  const panelHeight = Math.max(1, Math.min(360, height - margin * 2));
  const below = trigger.bottom + 4;
  const top = below + panelHeight <= height - margin ? below : Math.max(margin, Math.min(trigger.top - panelHeight - 4, height - margin - panelHeight));
  return { left: Math.max(margin, Math.min(trigger.left, width - margin - panelWidth)), top, width: panelWidth, height: panelHeight };
}

/** The sections remain in one scrolling pane, as in the reference picker. */
export function SlideShapePicker({ onSelect }: { onSelect: (kind: BasicSlideShape) => void }) {
  const [active, setActive] = useState<ShapeGroup>("基础");
  const pane = useRef<HTMLDivElement>(null);
  const sections = useRef<Partial<Record<ShapeGroup, HTMLElement>>>({});
  const navigating = useRef<ShapeGroup | null>(null);
  const navigate = (group: ShapeGroup) => {
    const container = pane.current, section = sections.current[group];
    if (!container || !section) return;
    setActive(group);
    const top = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + section.getBoundingClientRect().top - container.getBoundingClientRect().top));
    if (Math.abs(top - container.scrollTop) < 1) return;
    navigating.current = group;
    container.scrollTo({ top, behavior: "instant" });
  };
  return <div className="flex h-full min-h-0 flex-col text-[13px] text-[#1f2329]" data-slide-shape-picker>
    <div className="flex h-12 shrink-0 items-end border-b border-[#e5e6eb] px-3"><span className="flex h-12 items-center border-b-2 border-[#3370ff] px-1 font-medium text-[#3370ff]">形状</span></div>
    <div className="flex min-h-0 flex-1 py-3">
      <nav aria-label="图形分类" className="w-[112px] shrink-0 border-r border-[#e5e6eb] px-2 sm:w-[200px]">{groups.map((group) => <button key={group} type="button" aria-pressed={active === group} onClick={() => navigate(group)} className={cn("flex h-10 w-full items-center rounded px-3 text-left", active === group ? "bg-[#e8efff] text-[#245bdb]" : "hover:bg-[#f2f3f5]")}>{group}</button>)}</nav>
      <div ref={pane} aria-label="图形列表" className="min-w-0 flex-1 overflow-y-auto px-3" onScroll={() => {
        const container = pane.current;
        if (!container) return;
        if (navigating.current) { setActive(navigating.current); navigating.current = null; return; }
        const top = container.getBoundingClientRect().top + container.clientHeight / 2;
        const lastVisible = [...groups].reverse().find((group) => (sections.current[group]?.getBoundingClientRect().top ?? Infinity) <= top);
        if (lastVisible) setActive(lastVisible);
      }}>
        {groups.map((group) => <section key={group} ref={(element) => { if (element) sections.current[group] = element; else delete sections.current[group]; }} aria-label={`${group}图形`} className="pb-5">
          <div className="mb-2 text-[12px] text-[#8f959e]">{group}</div>
          <div className="grid grid-cols-3 gap-1 sm:grid-cols-5">{SLIDE_SHAPES.filter((shape) => shape.group === group).map((shape) => <button type="button" key={shape.kind} aria-label={shape.label} title={shape.label} onClick={() => onSelect(shape.kind)} className="grid aspect-square w-full max-w-12 place-items-center rounded-md p-1.5 hover:bg-[#f2f3f5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#3370ff]"><SlideShapeGraphic kind={shape.kind} color="#4b5058" outline/></button>)}</div>
        </section>)}
      </div>
    </div>
  </div>;
}

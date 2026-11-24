import type { SlideLayout } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { Columns3 } from "lucide-react";

export type NewSlideLayout = Extract<SlideLayout, "" | "title" | "blank"> | "two-column";
export function slideCreatePickerPosition(trigger: Pick<DOMRect, "left" | "top" | "bottom">, width: number, height: number) {
  const panelWidth = Math.max(1, Math.min(468, width - 24));
  const left = Math.max(12, Math.min(trigger.left - 120, width - panelWidth - 12));
  const below = trigger.bottom + 8, above = trigger.top - 8 - 300;
  const top = below + 300 <= height - 12 ? below : above >= 12 ? above : Math.max(12, Math.min(below, height - 152));
  return { left, top, width: panelWidth, maxHeight: Math.max(1, height - top - 12) };
}

export function SlideCreateLayoutPicker({ onSelect }: { onSelect: (layout: NewSlideLayout) => void }) {
  const { t } = useI18n();
  const layouts: { value: NewSlideLayout; name: string }[] = [
    { value: "blank", name: t("空白") },
    { value: "title", name: t("标题") },
    { value: "", name: t("标题与正文") },
    { value: "two-column", name: t("标题与两栏内容") },
  ];
  return <div className="p-3 text-[#1f2329]" data-slide-create-layout>
    <div className="flex h-7 items-center gap-2 text-[13px] font-medium"><Columns3 size={15} strokeWidth={1.7}/>{t("选择布局新建")}</div>
    <div className="mb-2 mt-2 text-[12px] text-[#8f959e]">{t("默认母版")}</div>
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      {layouts.map(({ value, name }) => <button key={value || "body"} type="button" aria-label={t("使用{name}布局新建", { name })} onClick={() => onSelect(value)} className="min-w-0 rounded-md text-center outline-none focus-visible:ring-2 focus-visible:ring-[#3370ff]" data-create-layout={value || "body"}>
        <span className="relative block aspect-video overflow-hidden rounded-md border border-[#dee0e3] bg-white hover:border-[#3370ff] hover:bg-[#f9fbff]">
          {value === "title" && <span className="absolute left-[24%] top-[46%] h-[5%] w-[52%] rounded-full bg-[#646a73]"/>}
          {value === "" && <><span className="absolute left-[10%] top-[15%] h-[5%] w-[60%] rounded-full bg-[#8f959e]"/><span className="absolute left-[10%] top-[37%] h-[3%] w-[72%] rounded-full bg-[#c4c8ce]"/><span className="absolute left-[10%] top-[48%] h-[3%] w-[55%] rounded-full bg-[#c4c8ce]"/></>}
          {value === "two-column" && <><span className="absolute left-[8%] top-[12%] h-[5%] w-[55%] rounded-full bg-[#8f959e]"/><span className="absolute left-[8%] top-[30%] h-[55%] w-[38%] rounded-sm bg-[#e5e6eb]"/><span className="absolute right-[8%] top-[30%] h-[55%] w-[38%] rounded-sm bg-[#e5e6eb]"/></>}
        </span>
        <span className="mt-1 block truncate text-[12px] text-[#646a73]">{name}</span>
      </button>)}
    </div>
  </div>;
}

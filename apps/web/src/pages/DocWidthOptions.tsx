import { cn } from "@/lib/utils";
import type { DocWidth } from "@/lib/docWidth";

const OPTIONS: { value: DocWidth; label: string; lines: number }[] = [
  { value: "default", label: "默认", lines: 16 },
  { value: "wider", label: "较宽", lines: 22 },
  { value: "full", label: "全宽", lines: 28 },
];

export function DocWidthOptions({ width, onChange }: { width: DocWidth; onChange: (value: DocWidth) => void }) {
  return <div className="w-full rounded-md border border-[#DEE0E3] bg-surface p-3 shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border sm:w-[240px]" role="radiogroup" aria-label="页宽设置" data-doc-width-options>
    <div className="mb-3 text-[12px] text-[#8F959E]">为当前窗口选择合适页宽</div>
    <div className="flex items-center justify-between gap-2">
      {OPTIONS.map(({ value, label, lines }) => <button key={value} type="button" role="radio" aria-checked={width === value} onClick={() => onChange(value)} data-doc-width-option={value} className={cn("flex h-[65px] w-[56px] shrink-0 flex-col items-center justify-center gap-1 rounded border text-[12px]", width === value ? "border-[#3370FF] bg-[#F2F6FF] font-medium text-[#3370FF]" : "border-[#DEE0E3] text-[#646A73] hover:bg-hover dark:border-border")}>
        <span aria-hidden="true" className={cn("grid h-[29px] w-[42px] place-items-center rounded-sm", width === value ? "bg-[#E1EAFF]" : "bg-[#F2F3F5] dark:bg-hover")}><svg width="32" height="20" viewBox="0 0 32 20" fill="none"><path d={`M${(32-lines)/2} 5h${lines} M${(32-lines)/2} 8h${lines} M${(32-lines)/2} 11h${lines} M${(32-lines)/2} 14h${lines}`} stroke={width === value ? "#90B3FF" : "#BBBFC4"} strokeWidth="1.3" strokeLinecap="round" /></svg></span>
        {label}
      </button>)}
    </div>
  </div>;
}

import type { SlideShape } from "@/lib/api";

/** Percentages are measured against the slide, not the browser viewport. */
export function SlideShapeControls({ shape, onChange, onDelete }: { shape: SlideShape; onChange: (patch: Partial<SlideShape>) => void; onDelete: () => void }) {
  const controls = [
    { name: "宽度", label: "图形宽度", value: shape.width ?? 16, min: 5, max: 100, unit: "%", set: (n: number) => ({ width: n }) },
    { name: "高度", label: "图形高度", value: shape.height ?? 20, min: 5, max: 100, unit: "%", set: (n: number) => ({ height: n }) },
    { name: "旋转", label: "图形旋转角度", value: shape.rotation ?? 0, min: 0, max: 359, unit: "°", set: (n: number) => ({ rotation: n }) },
  ];
  return <div className="flex shrink-0 items-center gap-3 overflow-x-auto whitespace-nowrap border-b bg-white px-4 py-2 text-[12px] text-[#4e5969] [&>*]:shrink-0" role="group" aria-label="图形格式">
    <label className="flex items-center gap-1">颜色<input type="color" aria-label="图形颜色" value={shape.color} onChange={(event) => onChange({ color: event.target.value })}/></label>
    {controls.map((control) => <label key={control.label} className="flex items-center gap-1">{control.name}<input type="range" aria-label={control.label} min={control.min} max={control.max} step="1" value={control.value} onChange={(event) => onChange(control.set(Number(event.target.value)))} className="w-16 accent-[#3370ff]"/><span className="w-9 tabular-nums">{control.value}{control.unit}</span></label>)}
    <button type="button" onClick={onDelete} className="rounded px-2 py-1 text-[#d83931] hover:bg-[#f2f3f5]">删除图形</button>
  </div>;
}

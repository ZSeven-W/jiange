import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, BringToFront, ChevronDown, ChevronUp, SendToBack } from "lucide-react";
import type { SlideShape } from "@/lib/api";
import type { ShapeAlignment, ShapeOrderAction } from "./slides-shape-order";

/** Percentages are measured against the slide, not the browser viewport. */
export function SlideShapeControls({ shape, onChange, onDelete, onOrder, onAlign }: { shape: SlideShape; onChange: (patch: Partial<SlideShape>) => void; onDelete: () => void; onOrder: (action: ShapeOrderAction) => void; onAlign: (alignment: ShapeAlignment) => void; }) {
  const text = shape.kind === "text";
  const image = shape.kind === "image";
  const controls = [
    { name: "宽度", label: "图形宽度", value: shape.width ?? 16, min: 5, max: 100, unit: "%", set: (n: number) => ({ width: n }) },
    { name: "高度", label: "图形高度", value: shape.height ?? 20, min: 5, max: 100, unit: "%", set: (n: number) => ({ height: n }) },
    { name: "旋转", label: "图形旋转角度", value: shape.rotation ?? 0, min: 0, max: 359, unit: "°", set: (n: number) => ({ rotation: n }) },
  ];
  const orders: [ShapeOrderAction, string, typeof BringToFront][] = [["front", "置于顶层", BringToFront], ["forward", "上移一层", ChevronUp], ["backward", "下移一层", ChevronDown], ["back", "置于底层", SendToBack]];
  const alignments: [ShapeAlignment, string, typeof BringToFront][] = [["left", "左对齐到页面", AlignStartHorizontal], ["hcenter", "水平居中到页面", AlignCenterHorizontal], ["right", "右对齐到页面", AlignEndHorizontal], ["top", "顶对齐到页面", AlignStartVertical], ["vcenter", "垂直居中到页面", AlignCenterVertical], ["bottom", "底对齐到页面", AlignEndVertical]];
  return <div className="flex shrink-0 items-center gap-3 overflow-x-auto whitespace-nowrap border-b bg-white px-4 py-2 text-[12px] text-[#4e5969] [&>*]:shrink-0" role="group" aria-label={text ? "文本框格式" : image ? "图片格式" : "图形格式"}>
    {!image && <label className="flex items-center gap-1">颜色<input type="color" aria-label={text ? "文字颜色" : "图形颜色"} value={shape.color} onChange={(event) => onChange({ color: event.target.value })}/></label>}
    {text && <><label className="flex items-center gap-1">字号<input type="number" aria-label="文字字号" min={12} max={96} value={shape.fontSize ?? 24} onChange={(event) => { const n = event.target.valueAsNumber; if (Number.isFinite(n)) onChange({ fontSize: Math.max(12, Math.min(96, n)) }); }} className="w-12 rounded border border-[#d0d3d6] px-1 py-0.5"/></label><button type="button" aria-label="加粗文字" aria-pressed={!!shape.bold} onClick={() => onChange({ bold: !shape.bold })} className={`rounded px-2 py-1 font-bold ${shape.bold ? "bg-[#e8efff] text-[#3370ff]" : "hover:bg-[#f2f3f5]"}`}>B</button><label className="flex items-center gap-1">文字对齐<select aria-label="文字对齐" value={shape.align ?? "left"} onChange={(event) => onChange({ align: event.target.value as "left" | "center" | "right" })} className="rounded border border-[#d0d3d6] px-1 py-0.5"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label></>}
    {controls.map((control) => <label key={control.label} className="flex items-center gap-1">{control.name}<input type="range" aria-label={control.label} min={control.min} max={control.max} step="1" value={control.value} onChange={(event) => onChange(control.set(Number(event.target.value)))} className="w-16 accent-[#3370ff]"/><span className="w-9 tabular-nums">{control.value}{control.unit}</span></label>)}
    <span className="h-5 w-px bg-[#e5e6eb]" aria-hidden="true"/>
    <div className="flex items-center gap-0.5" role="group" aria-label="对象层级">{orders.map(([action, label, Icon]) => <button key={action} type="button" aria-label={label} title={label} onClick={() => onOrder(action)} className="grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Icon size={15}/></button>)}</div>
    <div className="flex items-center gap-0.5" role="group" aria-label="对象对齐到页面">{alignments.map(([alignment, label, Icon]) => <button key={alignment} type="button" aria-label={label} title={label} onClick={() => onAlign(alignment)} className="grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Icon size={15}/></button>)}</div>
    <button type="button" onClick={onDelete} className="rounded px-2 py-1 text-[#d83931] hover:bg-[#f2f3f5]">{text ? "删除文本框" : image ? "删除图片" : "删除图形"}</button>
  </div>;
}

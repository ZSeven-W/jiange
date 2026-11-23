import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, BringToFront, ChevronDown, ChevronUp, SendToBack, Trash2 } from "lucide-react";
import type { SlideShape } from "@/lib/api";
import { FeishuSelect } from "@/components/feishu-select";
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
  return (
    <div
      className="pointer-events-auto absolute left-1/2 top-2.5 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1.5 overflow-x-auto whitespace-nowrap rounded-lg border border-[#dee0e3] bg-white/95 px-2.5 py-1 text-[12px] text-[#4e5969] shadow-[0_4px_16px_rgba(31,35,41,0.12)] backdrop-blur-xs [&>*]:shrink-0"
      role="group"
      aria-label={text ? "文本框格式" : image ? "图片格式" : "图形格式"}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {!image && (
        <label className="relative flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-[#f2f3f5]" title={text ? "文字颜色" : "图形颜色"}>
          <span>颜色</span>
          <span className="size-4 rounded border border-[#d0d3d6] shadow-2xs" style={{ backgroundColor: shape.color }} />
          <input type="color" aria-label={text ? "文字颜色" : "图形颜色"} value={shape.color} onChange={(event) => onChange({ color: event.target.value })} className="sr-only" />
        </label>
      )}
      {text && (
        <>
          <label className="flex items-center gap-1">
            字号
            <input type="number" aria-label="文字字号" min={12} max={96} value={shape.fontSize ?? 24} onChange={(event) => { const n = event.target.valueAsNumber; if (Number.isFinite(n)) onChange({ fontSize: Math.max(12, Math.min(96, n)) }); }} className="h-6 w-11 rounded border border-[#d0d3d6] px-1 text-[12px] outline-none focus:border-[#3370ff]" />
          </label>
          <button type="button" aria-label="加粗文字" aria-pressed={!!shape.bold} onClick={() => onChange({ bold: !shape.bold })} className={`grid size-6 place-items-center rounded font-bold ${shape.bold ? "bg-[#e8efff] text-[#3370ff]" : "hover:bg-[#f2f3f5]"}`}>B</button>
          <FeishuSelect
            ariaLabel="文字对齐"
            title="文字对齐"
            value={shape.align ?? "left"}
            options={[{ value: "left", label: "左对齐" }, { value: "center", label: "居中" }, { value: "right", label: "右对齐" }]}
            onChange={(val) => onChange({ align: val as "left" | "center" | "right" })}
            className="h-6 border border-[#d0d3d6] px-1.5 text-[12px]"
            chevronSize={11}
            menuMinWidth={80}
          />
        </>
      )}
      <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
      {controls.map((control) => (
        <label key={control.label} className="flex items-center gap-1">
          <span className="text-[#646a73]">{control.name}</span>
          <input type="range" aria-label={control.label} min={control.min} max={control.max} step="1" value={control.value} onChange={(event) => onChange(control.set(Number(event.target.value)))} className="h-1 w-10 cursor-pointer accent-[#3370ff]" />
          <span className="w-7 text-right text-[11px] tabular-nums text-[#4e5969]">{control.value}{control.unit}</span>
        </label>
      ))}
      <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
      <div className="flex items-center gap-0.5" role="group" aria-label="对象层级">{orders.map(([action, label, Icon]) => <button key={action} type="button" aria-label={label} title={label} onClick={() => onOrder(action)} className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Icon size={13} /></button>)}</div>
      <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
      <div className="flex items-center gap-0.5" role="group" aria-label="对象对齐到页面">{alignments.map(([alignment, label, Icon]) => <button key={alignment} type="button" aria-label={label} title={label} onClick={() => onAlign(alignment)} className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Icon size={13} /></button>)}</div>
      <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
      <button type="button" onClick={onDelete} title={text ? "删除文本框" : image ? "删除图片" : "删除图形"} aria-label={text ? "删除文本框" : image ? "删除图片" : "删除图形"} className="flex h-6 items-center gap-1 rounded px-1.5 text-[#d83931] hover:bg-[#fff2f0]"><Trash2 size={13} /><span>删除</span></button>
    </div>
  );
}

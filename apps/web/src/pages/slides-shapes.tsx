import { useRef, useState } from "react";
import { GripHorizontal } from "lucide-react";
import type { SlideShape } from "@/lib/api";
import { resizeSlideShape, type ResizeHandle } from "./slides-shape-resize";

const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(0, value)) * 10) / 10;

const handles: { id: ResizeHandle; label: string; left: string; top: string; cursor: string }[] = [
  { id: "nw", label: "左上", left: "0%", top: "0%", cursor: "nwse-resize" },
  { id: "n", label: "上", left: "50%", top: "0%", cursor: "ns-resize" },
  { id: "ne", label: "右上", left: "100%", top: "0%", cursor: "nesw-resize" },
  { id: "e", label: "右", left: "100%", top: "50%", cursor: "ew-resize" },
  { id: "se", label: "右下", left: "100%", top: "100%", cursor: "nwse-resize" },
  { id: "s", label: "下", left: "50%", top: "100%", cursor: "ns-resize" },
  { id: "sw", label: "左下", left: "0%", top: "100%", cursor: "nesw-resize" },
  { id: "w", label: "左", left: "0%", top: "50%", cursor: "ew-resize" },
];

export function SlideShapes({ shapes, editable, selected, onSelect, onChange, onTextChange, onTextBlur, scale = 1 }: {
  shapes: SlideShape[];
  editable: boolean;
  selected: string | null;
  onSelect?: (id: string) => void;
  onChange?: (shape: SlideShape) => void;
  onTextChange?: (id: string, value: string) => void;
  onTextBlur?: () => void;
  scale?: number;
}) {
  const drag = useRef<{ shape: SlideShape; startX: number; startY: number; width: number; height: number } | null>(null);
  const resizing = useRef<{ shape: SlideShape; handle: ResizeHandle; startX: number; startY: number; width: number; height: number } | null>(null);
  const [preview, setPreview] = useState<SlideShape | null>(null);
  return <>{shapes.map((shape) => {
    const item = preview?.id === shape.id ? preview : shape;
    const textStyle = { color: item.color, fontSize: `${(item.fontSize ?? 24) / 9.6}cqw`, fontWeight: item.bold ? 700 : 400, textAlign: item.align ?? "left" } as const;
    const graphic = item.kind === "text" ? <div className="h-full w-full overflow-hidden whitespace-pre-wrap break-words px-[0.4cqw] py-[0.2cqw] leading-[1.3]" style={textStyle}>{item.text}</div> : item.kind === "image" ? <img src={`/api/files/${item.fileId}`} alt="" draggable={false} className="h-full w-full object-contain"/> : <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">{item.kind === "rectangle" ? <rect x="2" y="2" width="96" height="96" fill={item.color}/> : item.kind === "ellipse" ? <ellipse cx="50" cy="50" rx="48" ry="48" fill={item.color}/> : <polygon points="50,2 98,98 2,98" fill={item.color}/>}</svg>;
    const style = { left: `${item.x}%`, top: `${item.y}%`, width: `${item.width ?? 16}%`, height: `${item.height ?? 20}%`, transform: `rotate(${item.rotation ?? 0}deg)` };
    if (!editable) return <div key={item.id} className="pointer-events-none absolute" style={style}>{graphic}</div>;
    const editingText = item.kind === "text" && selected === item.id;
    return <div key={item.id} data-slide-object className={`absolute ${editingText ? "outline outline-2 outline-[#3370ff] outline-offset-2" : ""}`} style={style}>
    <button type="button" aria-label={item.kind === "text" ? (editingText ? "移动文本框" : "文本框") : item.kind === "image" ? "幻灯片图片" : `图形 ${item.kind}`} aria-pressed={selected === item.id} className={editingText ? "absolute z-10 grid h-5 w-8 touch-none place-items-center rounded border border-[#c9cdd4] bg-white text-[#646a73]" : `h-full w-full touch-none ${selected === item.id ? "outline outline-2 outline-[#3370ff] outline-offset-2" : "hover:outline hover:outline-1 hover:outline-[#3370ff]"}`} style={editingText ? { left: "50%", top: 0, marginTop: -20 / Math.max(scale, 0.1), transform: `translate(-50%, -50%) scale(${1 / Math.max(scale, 0.1)})` } : undefined}
      onPointerDown={(event) => { const canvas = event.currentTarget.closest<HTMLElement>("[data-slides-canvas]"); if (!canvas) return; const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { shape, startX: event.clientX, startY: event.clientY, width: rect.width, height: rect.height }; onSelect?.(shape.id); }}
      onPointerMove={(event) => { const d = drag.current; if (d?.shape.id !== shape.id) return; setPreview({ ...d.shape, x: clamp(d.shape.x + (event.clientX - d.startX) / d.width * 100, 100 - (d.shape.width ?? 16)), y: clamp(d.shape.y + (event.clientY - d.startY) / d.height * 100, 100 - (d.shape.height ?? 20)) }); }}
      onPointerUp={(event) => { const d = drag.current; if (d?.shape.id === shape.id) { onChange?.({ ...d.shape, x: clamp(d.shape.x + (event.clientX - d.startX) / d.width * 100, 100 - (d.shape.width ?? 16)), y: clamp(d.shape.y + (event.clientY - d.startY) / d.height * 100, 100 - (d.shape.height ?? 20)) }); drag.current = null; setPreview(null); } }}
      onPointerCancel={() => { drag.current = null; setPreview(null); }}
      onKeyDown={(event) => { const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }; const move = delta[event.key]; if (move) { event.preventDefault(); onChange?.({ ...shape, x: clamp(shape.x + move[0], 100 - (shape.width ?? 16)), y: clamp(shape.y + move[1], 100 - (shape.height ?? 20)) }); } }}>{editingText ? <GripHorizontal size={14}/> : graphic}</button>
    {editingText && <textarea autoFocus aria-label="文本框内容" data-slide-history maxLength={1000} value={item.text ?? ""} onChange={(event) => onTextChange?.(item.id, event.target.value)} onBlur={onTextBlur} placeholder="输入文字" className="absolute inset-0 h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent px-[0.4cqw] py-[0.2cqw] leading-[1.3] outline-none placeholder:text-[#a3aab3]" style={textStyle}/>}
    {selected === item.id && handles.map((handle) => <button key={handle.id} type="button" aria-label={`调整图形${handle.label}边界`} className="absolute z-10 grid size-6 touch-none place-items-center" style={{ left: handle.left, top: handle.top, transform: `translate(-50%, -50%) scale(${1 / Math.max(scale, 0.1)})`, cursor: handle.cursor }}
      onPointerDown={(event) => { const canvas = event.currentTarget.closest<HTMLElement>("[data-slides-canvas]"); if (!canvas) return; const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); resizing.current = { shape, handle: handle.id, startX: event.clientX, startY: event.clientY, width: rect.width, height: rect.height }; }}
      onPointerMove={(event) => { const d = resizing.current; if (!d || d.shape.id !== shape.id || d.handle !== handle.id) return; setPreview(resizeSlideShape(d.shape, d.handle, event.clientX - d.startX, event.clientY - d.startY, d.width, d.height)); }}
      onPointerUp={(event) => { const d = resizing.current; if (!d || d.shape.id !== shape.id || d.handle !== handle.id) return; if (event.clientX !== d.startX || event.clientY !== d.startY) onChange?.(resizeSlideShape(d.shape, d.handle, event.clientX - d.startX, event.clientY - d.startY, d.width, d.height)); resizing.current = null; setPreview(null); }}
      onPointerCancel={() => { resizing.current = null; setPreview(null); }}
      onKeyDown={(event) => { const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }; const move = delta[event.key]; if (!move) return; const rect = event.currentTarget.closest<HTMLElement>("[data-slides-canvas]")?.getBoundingClientRect(); if (!rect) return; event.preventDefault(); onChange?.(resizeSlideShape(shape, handle.id, move[0] * rect.width / 100, move[1] * rect.height / 100, rect.width, rect.height)); }}><span className="size-2 rounded-full border border-[#3370ff] bg-white shadow-sm" /></button>)}
    </div>;
  })}</>;
}

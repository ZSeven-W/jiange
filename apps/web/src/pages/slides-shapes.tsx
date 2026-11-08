import { useRef, useState } from "react";
import type { SlideShape } from "@/lib/api";

const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(0, value)) * 10) / 10;

export function SlideShapes({ shapes, editable, selected, onSelect, onChange }: {
  shapes: SlideShape[];
  editable: boolean;
  selected: string | null;
  onSelect?: (id: string) => void;
  onChange?: (shape: SlideShape) => void;
}) {
  const drag = useRef<{ shape: SlideShape; startX: number; startY: number; width: number; height: number } | null>(null);
  const [preview, setPreview] = useState<SlideShape | null>(null);
  return <>{shapes.map((shape) => {
    const item = preview?.id === shape.id ? preview : shape;
    const graphic = <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">{item.kind === "rectangle" ? <rect x="2" y="2" width="96" height="96" fill={item.color}/> : item.kind === "ellipse" ? <ellipse cx="50" cy="50" rx="48" ry="48" fill={item.color}/> : <polygon points="50,2 98,98 2,98" fill={item.color}/>}</svg>;
    const style = { left: `${item.x}%`, top: `${item.y}%`, width: "16%", height: "20%" };
    if (!editable) return <div key={item.id} className="pointer-events-none absolute" style={style}>{graphic}</div>;
    return <button key={item.id} type="button" aria-label={`图形 ${item.kind}`} aria-pressed={selected === item.id} className={`absolute touch-none ${selected === item.id ? "outline outline-2 outline-[#3370ff] outline-offset-2" : "hover:outline hover:outline-1 hover:outline-[#3370ff]"}`} style={style}
      onPointerDown={(event) => { const canvas = event.currentTarget.closest<HTMLElement>("[data-slides-canvas]"); if (!canvas) return; const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { shape, startX: event.clientX, startY: event.clientY, width: rect.width, height: rect.height }; onSelect?.(shape.id); }}
      onPointerMove={(event) => { const d = drag.current; if (d?.shape.id !== shape.id) return; setPreview({ ...d.shape, x: clamp(d.shape.x + (event.clientX - d.startX) / d.width * 100, 84), y: clamp(d.shape.y + (event.clientY - d.startY) / d.height * 100, 80) }); }}
      onPointerUp={(event) => { const d = drag.current; if (d?.shape.id === shape.id) { onChange?.({ ...d.shape, x: clamp(d.shape.x + (event.clientX - d.startX) / d.width * 100, 84), y: clamp(d.shape.y + (event.clientY - d.startY) / d.height * 100, 80) }); drag.current = null; setPreview(null); } }}
      onPointerCancel={() => { drag.current = null; setPreview(null); }}
      onKeyDown={(event) => { const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }; const move = delta[event.key]; if (move) { event.preventDefault(); onChange?.({ ...shape, x: clamp(shape.x + move[0], 84), y: clamp(shape.y + move[1], 80) }); } }}>{graphic}</button>;
  })}</>;
}

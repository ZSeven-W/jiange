import { useEffect, useRef, useState } from "react";
import { GripHorizontal } from "lucide-react";
import type { SlideShape } from "@/lib/api";
import { isLineSlideShape, SlideShapeGraphic } from "./slide-shape-catalog";
import { resizeSlideShape, type ResizeHandle } from "./slides-shape-resize";
import { moveSlideLineEndpoint, type LineEndpoint } from "./slides-line-endpoints";
import { slidePresetControlLabel, slidePresetPlaceholder } from "./slides-layout-preset";
import { isGpuNativeSlideShape } from "./slides-gpu-layer";
import { computeSlideShapeSnap, type SlideSnapGuide } from "./slides-snap";
import {
  isSelectionSingleGroup,
  moveMultipleShapes,
  multiSelectionBounds,
  snapMultipleShapes,
  toggleShapeSelection,
  type SlideShapeGroups,
} from "./slides-multi-select";

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

export function SlideShapes({
  shapes,
  editable,
  textEditable = editable,
  selected,
  selectedIds,
  pageGroups,
  onSelect,
  onSelectMany,
  onChange,
  onChangeMany,
  onTextChange,
  onTextBlur,
  scale = 1,
  gpuBacked = false,
  onPreviewChange,
  onPreviewManyChange,
}: {
  shapes: SlideShape[];
  editable: boolean;
  textEditable?: boolean;
  selected: string | null;
  selectedIds?: readonly string[];
  pageGroups?: SlideShapeGroups;
  onSelect?: (id: string) => void;
  onSelectMany?: (ids: string[]) => void;
  onChange?: (shape: SlideShape) => void;
  onChangeMany?: (shapes: SlideShape[]) => void;
  onTextChange?: (id: string, value: string) => void;
  onTextBlur?: () => void;
  scale?: number;
  gpuBacked?: boolean;
  onPreviewChange?: (shape: SlideShape | null) => void;
  onPreviewManyChange?: (previewMap: ReadonlyMap<string, SlideShape> | null) => void;
}) {
  const drag = useRef<{
    anchorId: string;
    shape: SlideShape;
    dragIds: string[];
    allShapes: SlideShape[];
    startX: number;
    startY: number;
    width: number;
    height: number;
    wasAlreadyMulti: boolean;
  } | null>(null);
  const resizing = useRef<{ shape: SlideShape; handle: ResizeHandle; startX: number; startY: number; width: number; height: number } | null>(null);
  const lineDrag = useRef<{ shape: SlideShape; endpoint: LineEndpoint; pointer: number; startX: number; startY: number; width: number; height: number } | null>(null);
  const [previewMap, setPreviewMapState] = useState<ReadonlyMap<string, SlideShape> | null>(null);
  const [snapGuides, setSnapGuides] = useState<SlideSnapGuide[]>([]);

  const setPreviewMap = (next: ReadonlyMap<string, SlideShape> | null) => {
    setPreviewMapState(next);
    onPreviewManyChange?.(next);
    onPreviewChange?.(next && next.size === 1 ? [...next.values()][0] : null);
  };
  const setPreviewSingle = (next: SlideShape | null) => {
    setPreviewMap(next ? new Map([[next.id, next]]) : null);
  };

  useEffect(() => {
    if (!editable) {
      drag.current = null;
      resizing.current = null;
      lineDrag.current = null;
      setPreviewMapState(null);
      setSnapGuides([]);
      onPreviewChange?.(null);
      onPreviewManyChange?.(null);
    }
  }, [editable, onPreviewChange, onPreviewManyChange]);

  const effectiveSelectedIds = selectedIds ?? (selected ? [selected] : []);
  const selectedSet = new Set(effectiveSelectedIds);
  const singleSelectedId = effectiveSelectedIds.length === 1 ? effectiveSelectedIds[0] : null;
  const shapeIdSet = new Set(shapes.map((s) => s.id));
  const renderedShapes = previewMap ? shapes.map((s) => previewMap.get(s.id) ?? s) : shapes;
  const selectionBounds = effectiveSelectedIds.length > 1 ? multiSelectionBounds(renderedShapes, effectiveSelectedIds) : null;
  const selectionIsGrouped = effectiveSelectedIds.length > 1 && isSelectionSingleGroup(pageGroups, effectiveSelectedIds);

  const applySelection = (ids: string[]) => {
    if (onSelectMany) onSelectMany(ids);
    else if (ids[0]) onSelect?.(ids[0]);
  };

  return <>{shapes.map((shape) => {
    const item = previewMap?.get(shape.id) ?? shape;
    const isSelected = selectedSet.has(item.id);
    const isSingleSelected = singleSelectedId === item.id;
    const placeholder = item.kind === "text" ? slidePresetPlaceholder(item.id) : null;
    const textStyle = { color: item.color, fontSize: `${(item.fontSize ?? 24) / 9.6}cqw`, fontWeight: item.bold ? 700 : 400, textAlign: item.align ?? "left" } as const;
    const gpuRendered = gpuBacked && isGpuNativeSlideShape(item);
    const graphic = item.kind === "text" ? <div className={`h-full w-full overflow-hidden whitespace-pre-wrap break-words px-[0.4cqw] py-[0.2cqw] leading-[1.3] ${editable && placeholder && !item.text ? "border border-dashed border-[#c9cdd4]" : ""}`} style={editable && placeholder && !item.text ? { ...textStyle, color: "#a3aab3" } : textStyle}>{item.text || (editable ? placeholder : "")}</div> : item.kind === "image" ? <img src={`/api/files/${item.fileId}`} alt="" draggable={false} className="h-full w-full object-contain"/> : item.kind === "table" ? <table className="h-full w-full border-collapse text-[1.1cqw]"><tbody>{(item.table?.rows ?? []).map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} className="border border-[#d0d5dd] px-1 py-0.5">{cell}</td>)}</tr>)}</tbody></table> : item.kind === "chart" ? <div className={gpuRendered ? "flex h-full w-full items-start justify-center pt-[0.5cqw] text-[1.2cqw] text-[#475467]" : "flex h-full w-full items-center justify-center rounded border border-[#d0d5dd] bg-[#f8fafc] text-[1.2cqw] text-[#475467]"}>{item.chart?.title || "Chart"}</div> : gpuRendered ? <div className="h-full w-full" aria-hidden="true" /> : <SlideShapeGraphic kind={item.kind} color={item.color}/>;
    const style = { left: `${item.x}%`, top: `${item.y}%`, width: `${item.width ?? 16}%`, height: `${item.height ?? 20}%`, transform: `rotate(${item.rotation ?? 0}deg)` };
    const editingText = item.kind === "text" && isSingleSelected;
    const line = item.kind !== "text" && item.kind !== "image" && item.kind !== "table" && item.kind !== "chart" && isLineSlideShape(item.kind);
    // Keep the active textarea mounted across temporary permission checks so
    // a background refetch does not discard focus or the browser's selection.
    if (!editable && !editingText) return <div key={item.id} className="pointer-events-none absolute" style={style}>{graphic}</div>;
    return <div key={item.id} data-slide-object data-slide-shape-id={item.id} className={`absolute ${editingText ? "outline outline-2 outline-[#3370ff] outline-offset-2" : ""}`} style={style}>
    <button type="button" disabled={!editable} aria-label={item.kind === "text" ? (editingText ? "移动文本框" : slidePresetControlLabel(item.id, !!item.text) ?? "文本框") : item.kind === "image" ? "幻灯片图片" : `图形 ${item.kind}`} aria-pressed={isSelected} className={editingText ? "absolute z-10 grid h-5 w-8 touch-none place-items-center rounded border border-[#c9cdd4] bg-white text-[#646a73]" : `h-full w-full touch-none ${isSelected ? "outline outline-2 outline-[#3370ff] outline-offset-2" : "hover:outline hover:outline-1 hover:outline-[#3370ff]"}`} style={editingText ? { left: "50%", top: 0, marginTop: -20 / Math.max(scale, 0.1), transform: `translate(-50%, -50%) scale(${1 / Math.max(scale, 0.1)})` } : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const canvas = event.currentTarget.closest<HTMLElement>("[data-slides-canvas]");
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        if (event.shiftKey) {
          const nextIds = toggleShapeSelection(effectiveSelectedIds, shape.id, true, pageGroups, shapeIdSet);
          applySelection(nextIds);
          return;
        }
        const wasAlreadyMulti = selectedSet.has(shape.id) && effectiveSelectedIds.length > 1;
        let dragIds: string[];
        if (wasAlreadyMulti) {
          dragIds = [...effectiveSelectedIds];
        } else {
          const nextIds = toggleShapeSelection(effectiveSelectedIds, shape.id, false, pageGroups, shapeIdSet);
          dragIds = nextIds.length ? nextIds : [shape.id];
          applySelection(dragIds);
        }
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* synthetic pointer events in tests may not support capture */
        }
        drag.current = {
          anchorId: shape.id,
          shape,
          dragIds,
          allShapes: shapes,
          startX: event.clientX,
          startY: event.clientY,
          width: rect.width,
          height: rect.height,
          wasAlreadyMulti,
        };
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d || d.anchorId !== shape.id) return;
        const dx = ((event.clientX - d.startX) / d.width) * 100;
        const dy = ((event.clientY - d.startY) / d.height) * 100;
        if (d.dragIds.length === 1) {
          const raw: SlideShape = {
            ...d.shape,
            x: clamp(d.shape.x + dx, 100 - (d.shape.width ?? 16)),
            y: clamp(d.shape.y + dy, 100 - (d.shape.height ?? 20)),
          };
          if (event.altKey) {
            setSnapGuides([]);
            setPreviewSingle(raw);
          } else {
            const snapped = computeSlideShapeSnap(raw, d.allShapes);
            setSnapGuides(snapped.guides);
            setPreviewSingle(snapped.shape);
          }
        } else {
          const dragSet = new Set(d.dragIds);
          if (event.altKey) {
            const moved = moveMultipleShapes(d.allShapes, d.dragIds, dx, dy);
            setSnapGuides([]);
            setPreviewMap(new Map(moved.filter((s) => dragSet.has(s.id)).map((s) => [s.id, s])));
          } else {
            const snapped = snapMultipleShapes(d.allShapes, d.dragIds, dx, dy);
            setSnapGuides(snapped.guides);
            setPreviewMap(new Map(snapped.shapes.filter((s) => dragSet.has(s.id)).map((s) => [s.id, s])));
          }
        }
      }}
      onPointerUp={(event) => {
        const d = drag.current;
        if (!d || d.anchorId !== shape.id) return;
        const moved = Math.hypot(event.clientX - d.startX, event.clientY - d.startY) > 2;
        if (moved) {
          const dx = ((event.clientX - d.startX) / d.width) * 100;
          const dy = ((event.clientY - d.startY) / d.height) * 100;
          if (d.dragIds.length === 1) {
            const raw: SlideShape = {
              ...d.shape,
              x: clamp(d.shape.x + dx, 100 - (d.shape.width ?? 16)),
              y: clamp(d.shape.y + dy, 100 - (d.shape.height ?? 20)),
            };
            const finalShape = event.altKey ? raw : computeSlideShapeSnap(raw, d.allShapes).shape;
            onChange?.(finalShape);
          } else {
            const finalShapes = event.altKey
              ? moveMultipleShapes(d.allShapes, d.dragIds, dx, dy)
              : snapMultipleShapes(d.allShapes, d.dragIds, dx, dy).shapes;
            onChangeMany?.(finalShapes);
          }
        } else if (d.wasAlreadyMulti && !isSelectionSingleGroup(pageGroups, d.dragIds)) {
          applySelection(toggleShapeSelection([], shape.id, false, pageGroups, shapeIdSet));
        } else if (d.dragIds.length === 1 && shape.kind === "text") {
          const button = event.currentTarget;
          requestAnimationFrame(() => {
            if (document.activeElement !== button && document.activeElement !== document.body) return;
            button.closest<HTMLElement>("[data-slide-object]")?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
          });
        }
        drag.current = null;
        setSnapGuides([]);
        setPreviewMap(null);
      }}
      onPointerCancel={() => { drag.current = null; setSnapGuides([]); setPreviewMap(null); }}
      onClick={(event) => {
        if (event.detail === 0) {
          const nextIds = toggleShapeSelection(effectiveSelectedIds, shape.id, event.shiftKey, pageGroups, shapeIdSet);
          applySelection(nextIds);
        }
      }}
      onKeyDown={(event) => {
        const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const move = delta[event.key];
        if (!move) return;
        event.preventDefault();
        if (effectiveSelectedIds.length > 1 && selectedSet.has(shape.id) && onChangeMany) {
          onChangeMany(moveMultipleShapes(shapes, effectiveSelectedIds, move[0], move[1]));
        } else {
          onChange?.({ ...shape, x: clamp(shape.x + move[0], 100 - (shape.width ?? 16)), y: clamp(shape.y + move[1], 100 - (shape.height ?? 20)) });
        }
      }}>{editingText ? <GripHorizontal size={14}/> : graphic}</button>
    {editingText && <textarea autoFocus readOnly={!textEditable} aria-label="文本框内容" data-slide-history maxLength={1000} value={item.text ?? ""} onChange={(event) => { if (textEditable) onTextChange?.(item.id, event.target.value); }} onBlur={onTextBlur} placeholder={placeholder ?? "输入文字"} className="absolute inset-0 h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent px-[0.4cqw] py-[0.2cqw] leading-[1.3] outline-none placeholder:text-[#a3aab3]" style={textStyle}/>}
    {editable && isSingleSelected && line && (["start", "end"] as const).map((endpoint) => <button key={endpoint} type="button" aria-label={endpoint === "start" ? "调整线条起点" : "调整线条终点"} className="absolute z-10 grid size-6 touch-none place-items-center" style={{ left: endpoint === "start" ? "5%" : "95%", top: "50%", transform: `translate(-50%, -50%) scale(${1 / Math.max(scale, 0.1)})`, cursor: "crosshair" }}
      onPointerDown={(event) => { const rect = event.currentTarget.closest<HTMLElement>("[data-slides-canvas]")?.getBoundingClientRect(); if (!rect?.width || !rect.height) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); lineDrag.current = { shape, endpoint, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, width: rect.width, height: rect.height }; }}
      onPointerMove={(event) => { const d = lineDrag.current; if (!d || d.pointer !== event.pointerId || d.shape.id !== shape.id || d.endpoint !== endpoint) return; setPreviewSingle(moveSlideLineEndpoint(d.shape, endpoint, event.clientX - d.startX, event.clientY - d.startY, d.width, d.height)); }}
      onPointerUp={(event) => { const d = lineDrag.current; if (!d || d.pointer !== event.pointerId || d.shape.id !== shape.id || d.endpoint !== endpoint) return; if (event.clientX !== d.startX || event.clientY !== d.startY) onChange?.(moveSlideLineEndpoint(d.shape, endpoint, event.clientX - d.startX, event.clientY - d.startY, d.width, d.height)); lineDrag.current = null; setPreviewSingle(null); }}
      onPointerCancel={(event) => { if (lineDrag.current?.pointer === event.pointerId) { lineDrag.current = null; setPreviewSingle(null); } }} onLostPointerCapture={(event) => { if (lineDrag.current?.pointer === event.pointerId) { lineDrag.current = null; setPreviewSingle(null); } }}
      onKeyDown={(event) => { const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }; const move = delta[event.key]; const rect = event.currentTarget.closest<HTMLElement>("[data-slides-canvas]")?.getBoundingClientRect(); if (!move || !rect?.width || !rect.height) return; event.preventDefault(); onChange?.(moveSlideLineEndpoint(shape, endpoint, move[0] * rect.width / 100, move[1] * rect.height / 100, rect.width, rect.height)); }}><span className="size-2 rounded-full border border-[#3370ff] bg-white shadow-sm"/></button>)}
    {editable && isSingleSelected && !line && handles.map((handle) => <button key={handle.id} type="button" aria-label={`调整图形${handle.label}边界`} className="absolute z-10 grid size-6 touch-none place-items-center" style={{ left: handle.left, top: handle.top, transform: `translate(-50%, -50%) scale(${1 / Math.max(scale, 0.1)})`, cursor: handle.cursor }}
      onPointerDown={(event) => { const canvas = event.currentTarget.closest<HTMLElement>("[data-slides-canvas]"); if (!canvas) return; const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); resizing.current = { shape, handle: handle.id, startX: event.clientX, startY: event.clientY, width: rect.width, height: rect.height }; }}
      onPointerMove={(event) => { const d = resizing.current; if (!d || d.shape.id !== shape.id || d.handle !== handle.id) return; setPreviewSingle(resizeSlideShape(d.shape, d.handle, event.clientX - d.startX, event.clientY - d.startY, d.width, d.height)); }}
      onPointerUp={(event) => { const d = resizing.current; if (!d || d.shape.id !== shape.id || d.handle !== handle.id) return; if (event.clientX !== d.startX || event.clientY !== d.startY) onChange?.(resizeSlideShape(d.shape, d.handle, event.clientX - d.startX, event.clientY - d.startY, d.width, d.height)); resizing.current = null; setPreviewSingle(null); }}
      onPointerCancel={() => { resizing.current = null; setPreviewSingle(null); }}
      onKeyDown={(event) => { const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }; const move = delta[event.key]; if (!move) return; const rect = event.currentTarget.closest<HTMLElement>("[data-slides-canvas]")?.getBoundingClientRect(); if (!rect) return; event.preventDefault(); onChange?.(resizeSlideShape(shape, handle.id, move[0] * rect.width / 100, move[1] * rect.height / 100, rect.width, rect.height)); }}><span className="size-2 rounded-full border border-[#3370ff] bg-white shadow-sm" /></button>)}
    </div>;
  })}
  {editable && effectiveSelectedIds.length > 1 && selectionBounds && (
    <div
      aria-hidden="true"
      data-slides-selection-bounds
      data-slides-selection-grouped={selectionIsGrouped ? "true" : undefined}
      className={`pointer-events-none absolute z-10 rounded-[2px] ${
        selectionIsGrouped
          ? "border-2 border-[#3370ff] bg-[#3370ff]/[0.03]"
          : "border border-dashed border-[#3370ff]/80 bg-[#3370ff]/[0.03]"
      }`}
      style={{
        left: `${selectionBounds.x}%`,
        top: `${selectionBounds.y}%`,
        width: `${selectionBounds.width}%`,
        height: `${selectionBounds.height}%`,
      }}
    />
  )}
  {snapGuides.map((guide, idx) => (
    <div
      key={`${guide.axis}-${guide.pos}-${idx}`}
      aria-hidden="true"
      data-slide-snap-guide={guide.axis}
      className="pointer-events-none absolute z-30 bg-[#f54a45]"
      style={
        guide.axis === "x"
          ? { left: `${guide.pos}%`, top: 0, bottom: 0, width: `${1 / Math.max(scale, 0.25)}px` }
          : { top: `${guide.pos}%`, left: 0, right: 0, height: `${1 / Math.max(scale, 0.25)}px` }
      }
    />
  ))}
  </>;
}

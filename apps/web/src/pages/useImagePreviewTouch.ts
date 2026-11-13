import { useEffect, useLayoutEffect, useRef, type PointerEvent, type RefObject } from "react";
import { ImagePreviewTouch } from "./imagePreviewTouch";

export function useImagePreviewTouch(viewport: RefObject<HTMLDivElement | null>, frame: RefObject<HTMLDivElement | null>, zoom: number, setZoom: (value: number) => void, identity: string, rotation: number) {
  const controller = useRef(new ImagePreviewTouch());
  useEffect(() => { controller.current.reset(); }, [identity, rotation]);
  const align = () => { if (viewport.current) controller.current.align(viewport.current, frame.current?.getBoundingClientRect()); };
  useLayoutEffect(align, [zoom]);
  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (event.pointerType !== "touch" || !viewport.current) return;
      event.preventDefault();
      controller.current.down(event.pointerId, { x: event.clientX, y: event.clientY }, viewport.current, frame.current?.getBoundingClientRect(), zoom);
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer may already be gone. */ }
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      if (event.pointerType !== "touch" || !viewport.current || !controller.current.has(event.pointerId)) return;
      event.preventDefault();
      const next = controller.current.move(event.pointerId, { x: event.clientX, y: event.clientY }, viewport.current);
      if (next === undefined) return;
      if (Math.abs(next - zoom) < 0.0001) align(); else setZoom(next);
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      if (event.pointerType !== "touch" || !viewport.current || !controller.current.has(event.pointerId)) return;
      controller.current.up(event.pointerId, viewport.current, frame.current?.getBoundingClientRect(), zoom);
    },
    onPointerCancel(event: PointerEvent<HTMLDivElement>) {
      if (event.pointerType !== "touch" || !viewport.current || !controller.current.has(event.pointerId)) return;
      controller.current.up(event.pointerId, viewport.current, frame.current?.getBoundingClientRect(), zoom);
    },
  };
}

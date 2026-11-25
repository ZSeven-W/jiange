/**
 * Zero-framework DOM mount helper for `@zseven-w/sheet-ui`.
 * Mounts a WebGPU/WebGL2 `<canvas>` + recycled text overlay pool + singleton `<input>` IME editor.
 */

import { GpuSurface, type GpuSurfaceOptions } from "@zseven-w/render-gpu";
import type { Workbook } from "@zseven-w/sheet-sdk";
import { SheetViewController, type SheetViewControllerOptions } from "./controller.js";
import { SheetGpuRenderer, type SheetRenderTheme } from "./sheet-renderer.js";

export interface MountSheetViewOptions extends SheetViewControllerOptions {
  gpu?: GpuSurfaceOptions;
  theme?: Partial<SheetRenderTheme>;
}

export interface MountedSheetView {
  controller: SheetViewController<HTMLElement>;
  resize(width: number, height: number): void;
  dispose(): void;
}

export async function mountSheetView(
  container: HTMLElement,
  workbook: Workbook,
  options: MountSheetViewOptions = {},
): Promise<MountedSheetView> {
  const doc = container.ownerDocument;
  container.style.position = "relative";
  container.style.overflow = "hidden";
  container.style.userSelect = "none";

  const canvas = doc.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.display = "block";
  container.appendChild(canvas);

  const textLayer = doc.createElement("div");
  textLayer.style.position = "absolute";
  textLayer.style.inset = "0";
  textLayer.style.pointerEvents = "none";
  textLayer.style.overflow = "hidden";
  container.appendChild(textLayer);

  const editorInput = doc.createElement("input");
  editorInput.type = "text";
  editorInput.style.position = "absolute";
  editorInput.style.display = "none";
  editorInput.style.boxSizing = "border-box";
  editorInput.style.border = "2px solid #3370ff";
  editorInput.style.padding = "0 6px";
  editorInput.style.outline = "none";
  editorInput.style.zIndex = "10";
  container.appendChild(editorInput);

  const surface = await GpuSurface.create(canvas, options.gpu);
  const renderer = new SheetGpuRenderer<HTMLElement>(
    surface,
    () => {
      const div = doc.createElement("div");
      div.style.overflow = "hidden";
      div.style.whiteSpace = "nowrap";
      div.style.textOverflow = "ellipsis";
      div.style.padding = "4px 6px";
      div.style.boxSizing = "border-box";
      div.style.fontSize = "13px";
      textLayer.appendChild(div);
      return div;
    },
    options.theme,
  );

  const controller = new SheetViewController(workbook, renderer, options);
  const syncEditorDom = () => {
    const ed = controller.getEditorState();
    if (!ed.active) {
      editorInput.style.display = "none";
      return;
    }
    editorInput.style.display = "block";
    editorInput.style.transform = `translate3d(${ed.rect.x}px, ${ed.rect.y}px, 0)`;
    editorInput.style.width = `${ed.rect.width}px`;
    editorInput.style.height = `${ed.rect.height}px`;
    editorInput.value = ed.value;
    editorInput.focus();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    controller.scrollBy(e.deltaX, e.deltaY);
  };
  const onPointerDown = (e: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    controller.handlePointerDown(e.clientX - rect.left, e.clientY - rect.top, e.shiftKey);
    syncEditorDom();
  };
  const onDblClick = () => {
    controller.beginEdit();
    syncEditorDom();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (controller.handleKeyDown(e.key, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey })) {
      e.preventDefault();
      syncEditorDom();
    }
  };
  const onInput = () => controller.updateEditValue(editorInput.value);

  container.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("dblclick", onDblClick);
  container.addEventListener("keydown", onKeyDown);
  editorInput.addEventListener("input", onInput);

  const w = container.clientWidth || 800;
  const h = container.clientHeight || 600;
  renderer.resize(w, h);
  controller.render();

  return {
    controller,
    resize(width: number, height: number) {
      renderer.resize(width, height);
      controller.render();
    },
    dispose() {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("dblclick", onDblClick);
      container.removeEventListener("keydown", onKeyDown);
      editorInput.removeEventListener("input", onInput);
      controller.dispose();
      canvas.remove();
      textLayer.remove();
      editorInput.remove();
    },
  };
}

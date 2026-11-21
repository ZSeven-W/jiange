/**
 * WebGPU / WebGL2 SDF Presentation Stage + Virtual Thumbnail Rail over `@jiange/slides-sdk`.
 * Zero Canvas 2D usage.
 */

import {
  DomNodePool,
  GpuSurface,
  InstanceBatch,
  VirtualList1D,
  packColorRGBA,
  type GpuFrameStats,
  type GpuSurfaceOptions,
  type PoolableElement,
} from "@jiange/render-gpu";
import type { Presentation, SlideShape } from "@jiange/slides-sdk";

export interface SlidesViewOptions {
  gpu?: GpuSurfaceOptions;
  initialSlide?: number;
  presenterMode?: boolean;
  onSlideChange?: (index: number) => void;
  onSelectShape?: (shapeId: string | null) => void;
}

export interface SlidesFrameResult {
  gpu: GpuFrameStats;
  slideIndex: number;
  stageRect: { x: number; y: number; w: number; h: number };
  visibleThumbnails: number;
}

function isLineKind(kind: SlideShape["kind"]): boolean {
  return (
    kind === "line" ||
    kind === "line-arrow" ||
    kind === "line-arrow-filled" ||
    kind === "line-dot" ||
    kind === "line-double-arrow"
  );
}

export class SlidesViewController<T extends PoolableElement = PoolableElement> {
  readonly thumbnails: VirtualList1D<T>;
  readonly textPool: DomNodePool<T>;
  private readonly batch = new InstanceBatch(512, 512, 128);
  private slideIndex = 0;
  private selectedShapeId: string | null = null;
  private presenterMode: boolean;
  private width = 960;
  private height = 540;
  private thumbScrollTop = 0;

  constructor(
    readonly deck: Presentation,
    readonly surface: GpuSurface,
    thumbFactory: () => T,
    private readonly options: SlidesViewOptions = {},
    textFactory?: () => T,
  ) {
    this.slideIndex = Math.max(0, Math.min(Math.max(0, deck.slideCount - 1), options.initialSlide ?? 0));
    this.presenterMode = Boolean(options.presenterMode);
    this.thumbnails = new VirtualList1D<T>(deck.slideCount, 108, thumbFactory);
    this.textPool = new DomNodePool<T>(textFactory ?? thumbFactory);
  }

  getSlideIndex(): number {
    return this.slideIndex;
  }

  getSelectedShapeId(): string | null {
    return this.selectedShapeId;
  }

  isPresenterMode(): boolean {
    return this.presenterMode;
  }

  setPresenterMode(enabled: boolean): SlidesFrameResult {
    this.presenterMode = enabled;
    if (enabled) this.selectedShapeId = null;
    return this.render();
  }

  resize(widthPx: number, heightPx: number, dpr?: number): void {
    this.width = Math.max(160, Math.floor(widthPx));
    this.height = Math.max(90, Math.floor(heightPx));
    this.surface.resize(this.width, this.height, dpr);
  }

  goToSlide(index: number): SlidesFrameResult {
    const clamped = Math.max(0, Math.min(Math.max(0, this.deck.slideCount - 1), index));
    this.slideIndex = clamped;
    this.selectedShapeId = null;
    this.options.onSlideChange?.(clamped);
    return this.render();
  }

  nextSlide(): SlidesFrameResult {
    return this.goToSlide(this.slideIndex + 1);
  }

  prevSlide(): SlidesFrameResult {
    return this.goToSlide(this.slideIndex - 1);
  }

  selectShape(shapeId: string | null): void {
    this.selectedShapeId = shapeId;
    this.options.onSelectShape?.(shapeId);
  }

  /** Compute centered 16:9 stage rectangle inside the GPU canvas. */
  getStageRect(): { x: number; y: number; w: number; h: number } {
    const pad = this.presenterMode ? 0 : 28;
    const availW = Math.max(16, this.width - pad * 2);
    const availH = Math.max(9, this.height - pad * 2);
    const aspect = 16 / 9;
    let w = availW;
    let h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    return {
      x: (this.width - w) / 2,
      y: (this.height - h) / 2,
      w,
      h,
    };
  }

  /** Hit-test top-most shape at canvas-local `(x, y)` coordinates. */
  hitTestShape(x: number, y: number): SlideShape | null {
    const page = this.deck.getSlide(this.slideIndex);
    if (!page) return null;
    const stage = this.getStageRect();
    const px = ((x - stage.x) / stage.w) * 100;
    const py = ((y - stage.y) / stage.h) * 100;
    for (let i = page.shapes.length - 1; i >= 0; i--) {
      const s = page.shapes[i];
      const sw = s.width ?? 16;
      const sh = s.height ?? 20;
      if (px >= s.x && px <= s.x + sw && py >= s.y && py <= s.y + sh) return s;
    }
    return null;
  }

  moveSelectedShape(dxPct: number, dyPct: number): boolean {
    if (!this.selectedShapeId) return false;
    const page = this.deck.getSlide(this.slideIndex);
    const s = page?.shapes.find((x) => x.id === this.selectedShapeId);
    if (!s) return false;
    const w = s.width ?? 16;
    const h = s.height ?? 20;
    const nx = Math.max(0, Math.min(100 - w, s.x + dxPct));
    const ny = Math.max(0, Math.min(100 - h, s.y + dyPct));
    this.deck.updateShape(this.slideIndex, s.id, { x: nx, y: ny });
    this.render();
    return true;
  }

  handlePointerDown(x: number, y: number): SlideShape | null {
    const hit = this.hitTestShape(x, y);
    this.selectShape(hit?.id ?? null);
    this.render();
    return hit;
  }

  handleKeyDown(key: string, opts?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): boolean {
    const mod = Boolean(opts?.ctrlKey || opts?.metaKey);
    if (mod && key.toLowerCase() === "z") {
      if (opts?.shiftKey) this.deck.redo();
      else this.deck.undo();
      this.render();
      return true;
    }
    if (key === "ArrowRight" || key === "PageDown" || (this.presenterMode && key === " ")) {
      this.nextSlide();
      return true;
    }
    if (key === "ArrowLeft" || key === "PageUp") {
      this.prevSlide();
      return true;
    }
    if ((key === "Delete" || key === "Backspace") && this.selectedShapeId && !this.presenterMode) {
      this.deck.deleteShape(this.slideIndex, this.selectedShapeId);
      this.selectShape(null);
      this.render();
      return true;
    }
    return false;
  }

  scrollThumbnails(scrollTop: number): SlidesFrameResult {
    this.thumbScrollTop = Math.max(0, scrollTop);
    return this.render();
  }

  render(): SlidesFrameResult {
    const stage = this.getStageRect();
    const page = this.deck.getSlide(this.slideIndex);
    const theme = this.deck.getTheme();
    this.batch.reset();

    // Slide stage shadow + solid backdrop
    this.batch.pushRect({
      x: stage.x + 2,
      y: stage.y + 4,
      w: stage.w,
      h: stage.h,
      fill: [0.06, 0.09, 0.16, 0.1],
      radius: this.presenterMode ? 0 : 8,
    });
    this.batch.pushRect({
      x: stage.x,
      y: stage.y,
      w: stage.w,
      h: stage.h,
      fill: packColorRGBA(page?.background || theme.background),
      radius: this.presenterMode ? 0 : 6,
      borderWidth: this.presenterMode ? 0 : 1,
      borderColor: [0.85, 0.88, 0.93, 1],
    });

    const textItems: Array<{
      key: string;
      x: number;
      y: number;
      width: number;
      height: number;
      render: (el: T, newlyBound: boolean) => void;
    }> = [];
    const scale = stage.w / 1280;

    if (page) {
      if (page.layout !== "blank") {
        if (page.title) {
          textItems.push({
            key: `slide-title:${this.slideIndex}`,
            x: stage.x + stage.w * 0.06,
            y: stage.y + stage.h * 0.07,
            width: stage.w * 0.88,
            height: stage.h * 0.14,
            render: (el) => {
              el.textContent = page.title;
              el.style.fontSize = `${Math.max(8, 36 * scale).toFixed(2)}px`;
              el.style.fontWeight = "700";
              el.style.color = theme.textDark;
              el.style.textAlign = "left";
              el.style.justifyContent = "flex-start";
              el.style.padding = "0";
            },
          });
        }
        if (page.body) {
          textItems.push({
            key: `slide-body:${this.slideIndex}`,
            x: stage.x + stage.w * 0.06,
            y: stage.y + stage.h * 0.24,
            width: stage.w * 0.88,
            height: stage.h * 0.16,
            render: (el) => {
              el.textContent = page.body;
              el.style.fontSize = `${Math.max(7, 22 * scale).toFixed(2)}px`;
              el.style.fontWeight = "400";
              el.style.color = "#374151";
              el.style.textAlign = "left";
              el.style.justifyContent = "flex-start";
              el.style.padding = "0";
            },
          });
        }
      }

      for (const s of page.shapes) {
        const x = stage.x + (s.x / 100) * stage.w;
        const y = stage.y + (s.y / 100) * stage.h;
        const w = ((s.width ?? 16) / 100) * stage.w;
        const h = ((s.height ?? 20) / 100) * stage.h;
        const col = packColorRGBA(s.color, s.opacity);
        const rotRad = ((s.rotation ?? 0) * Math.PI) / 180;

        if (isLineKind(s.kind)) {
          const midY = y + h / 2;
          const thickness = Math.max(1.5, (s.strokeWidth ?? 3) * scale);
          this.batch.pushLine({ x1: x, y1: midY, x2: x + w, y2: midY, thickness, color: col });
          if (s.kind !== "line" && s.kind !== "line-dot") {
            const ah = Math.max(5, 9 * scale);
            this.batch.pushLine({ x1: x + w - ah, y1: midY - ah * 0.55, x2: x + w, y2: midY, thickness, color: col });
            this.batch.pushLine({ x1: x + w - ah, y1: midY + ah * 0.55, x2: x + w, y2: midY, thickness, color: col });
            if (s.kind === "line-double-arrow") {
              this.batch.pushLine({ x1: x + ah, y1: midY - ah * 0.55, x2: x, y2: midY, thickness, color: col });
              this.batch.pushLine({ x1: x + ah, y1: midY + ah * 0.55, x2: x, y2: midY, thickness, color: col });
            }
          }
        } else if (s.kind === "ellipse") {
          this.batch.pushArc({ cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, color: col });
        } else if (s.kind === "table" && s.table) {
          const rows = Math.max(1, s.table.rows.length);
          const cols = Math.max(1, ...s.table.rows.map((r) => r.length));
          const cw = w / cols;
          const rh = h / rows;
          for (let r = 0; r < rows; r++) {
            const isHeader = Boolean(s.table.headerRow && r === 0);
            const fill = isHeader ? col : r % 2 === 1 ? [0.96, 0.97, 0.99, 1] as [number, number, number, number] : [1, 1, 1, 1] as [number, number, number, number];
            this.batch.pushRect({ x, y: y + r * rh, w, h: rh, fill, borderWidth: 1, borderColor: [0.82, 0.84, 0.88, 1] });
            for (let c = 0; c < cols; c++) {
              const cellText = s.table.rows[r]?.[c] ?? "";
              textItems.push({
                key: `tbl:${s.id}:${r}:${c}`,
                x: x + c * cw,
                y: y + r * rh,
                width: cw,
                height: rh,
                render: (el) => {
                  el.textContent = cellText;
                  el.style.fontSize = `${Math.max(4, 13 * scale).toFixed(2)}px`;
                  el.style.fontWeight = isHeader ? "700" : "400";
                  el.style.color = isHeader ? "#ffffff" : "#1f2329";
                  el.style.textAlign = "left";
                  el.style.justifyContent = "flex-start";
                  el.style.padding = `0 ${Math.max(2, 6 * scale).toFixed(1)}px`;
                },
              });
            }
          }
          for (let c = 1; c < cols; c++) {
            this.batch.pushLine({ x1: x + c * cw, y1: y, x2: x + c * cw, y2: y + h, thickness: 1, color: [0.82, 0.84, 0.88, 1] });
          }
        } else if (s.kind === "chart" && s.chart) {
          this.batch.pushRect({ x, y, w, h, fill: [0.97, 0.98, 1, 1], radius: 6, borderWidth: 1, borderColor: [0.86, 0.89, 0.94, 1] });
          const chartTitle = s.chart.title;
          const titleOffset = chartTitle ? 26 * scale : 10 * scale;
          if (chartTitle) {
            textItems.push({
              key: `chart-title:${s.id}`,
              x,
              y: y + 4 * scale,
              width: w,
              height: 22 * scale,
              render: (el) => {
                el.textContent = chartTitle;
                el.style.fontSize = `${Math.max(4, 15 * scale).toFixed(2)}px`;
                el.style.fontWeight = "700";
                el.style.color = "#1f2329";
                el.style.textAlign = "center";
                el.style.justifyContent = "center";
                el.style.padding = "0 4px";
              },
            });
          }
          const vals = s.chart.series[0]?.values ?? [];
          const maxV = Math.max(1, ...vals.map((v) => Math.abs(v)));
          const barW = vals.length ? (w - 24) / vals.length : 10;
          const plotH = Math.max(8, h - titleOffset - 16);
          vals.forEach((v, i) => {
            const bh = (Math.max(0, v) / maxV) * plotH;
            this.batch.pushRect({ x: x + 12 + i * barW + 2, y: y + h - 12 - bh, w: Math.max(3, barW - 4), h: Math.max(2, bh), fill: col, radius: 2 });
          });
        } else if (s.kind === "text") {
          const textContent = s.text ?? "";
          if (textContent) {
            const align = s.align ?? "left";
            const textColor = s.color || theme.textDark;
            textItems.push({
              key: `txt:${s.id}`,
              x,
              y,
              width: w,
              height: h,
              render: (el) => {
                el.textContent = textContent;
                el.style.fontSize = `${Math.max(4, (s.fontSize ?? 24) * scale).toFixed(2)}px`;
                el.style.fontWeight = s.bold ? "700" : "400";
                el.style.color = textColor;
                el.style.textAlign = align;
                el.style.justifyContent = align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";
                el.style.padding = "0";
              },
            });
          }
        } else {
          this.batch.pushRect({
            x,
            y,
            w,
            h,
            fill: col,
            radius: s.kind === "rounded-rectangle" ? Math.min(w, h) * 0.16 : 0,
            rotationRad: rotRad,
          });
        }

        if (this.selectedShapeId === s.id && !this.presenterMode) {
          this.batch.pushRect({
            x: x - 2,
            y: y - 2,
            w: w + 4,
            h: h + 4,
            fill: [0.2, 0.44, 1, 0.08],
            borderWidth: 2,
            borderColor: [0.2, 0.44, 1, 1],
            radius: 2,
          });
          // 4 corner resize handles
          for (const [hx, hy] of [[x - 4, y - 4], [x + w - 4, y - 4], [x - 4, y + h - 4], [x + w - 4, y + h - 4]]) {
            this.batch.pushRect({ x: hx, y: hy, w: 8, h: 8, fill: [1, 1, 1, 1], borderWidth: 1.5, borderColor: [0.2, 0.44, 1, 1], radius: 2 });
          }
        }
      }
    }

    this.textPool.sync(textItems);
    const gpu = this.surface.render([this.batch]);
    this.thumbnails.sizes.setCount(this.deck.slideCount);
    const thumbFrame = this.thumbnails.update(this.thumbScrollTop, this.height, 152, (idx, el) => {
      const p = this.deck.getSlide(idx);
      el.textContent = `${idx + 1}. ${p?.title || "Untitled"}`;
      el.setAttribute?.("data-slide-index", String(idx));
    });

    return { gpu, slideIndex: this.slideIndex, stageRect: stage, visibleThumbnails: thumbFrame.items.length };
  }

  dispose(): void {
    this.textPool.clear();
    this.thumbnails.pool.clear();
    this.surface.dispose();
  }
}

export interface MountedSlidesView {
  controller: SlidesViewController<HTMLElement>;
  resize(width: number, height: number): void;
  dispose(): void;
}

export async function mountSlidesView(
  container: HTMLElement,
  deck: Presentation,
  options: SlidesViewOptions = {},
): Promise<MountedSlidesView> {
  const doc = container.ownerDocument;
  container.style.position = "relative";
  container.style.display = "flex";
  container.style.overflow = "hidden";

  const rail = doc.createElement("div");
  rail.style.position = "relative";
  rail.style.width = "168px";
  rail.style.overflow = "hidden";
  container.appendChild(rail);

  const stageHost = doc.createElement("div");
  stageHost.style.position = "relative";
  stageHost.style.flex = "1";
  container.appendChild(stageHost);

  const canvas = doc.createElement("canvas");
  canvas.style.display = "block";
  stageHost.appendChild(canvas);

  const textLayer = doc.createElement("div");
  textLayer.style.position = "absolute";
  textLayer.style.inset = "0";
  textLayer.style.pointerEvents = "none";
  textLayer.style.overflow = "hidden";
  stageHost.appendChild(textLayer);

  const surface = await GpuSurface.create(canvas, options.gpu);
  const controller = new SlidesViewController<HTMLElement>(
    deck,
    surface,
    () => {
      const item = doc.createElement("div");
      item.style.padding = "8px";
      item.style.boxSizing = "border-box";
      item.style.overflow = "hidden";
      item.style.whiteSpace = "nowrap";
      item.style.textOverflow = "ellipsis";
      rail.appendChild(item);
      return item;
    },
    options,
    () => {
      const el = doc.createElement("div");
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.boxSizing = "border-box";
      el.style.overflow = "hidden";
      el.style.whiteSpace = "nowrap";
      el.style.textOverflow = "ellipsis";
      textLayer.appendChild(el);
      return el;
    },
  );

  const onPointerDown = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    controller.handlePointerDown(e.clientX - rect.left, e.clientY - rect.top);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (controller.handleKeyDown(e.key, { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey })) {
      e.preventDefault();
    }
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("keydown", onKeyDown);

  const w = Math.max(320, (container.clientWidth || 960) - 168);
  const h = container.clientHeight || 540;
  controller.resize(w, h);
  controller.render();

  return {
    controller,
    resize(width: number, height: number) {
      controller.resize(Math.max(160, width - 168), height);
      controller.render();
    },
    dispose() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("keydown", onKeyDown);
      controller.dispose();
      rail.remove();
      stageHost.remove();
    },
  };
}

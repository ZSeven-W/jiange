/**
 * WebGPU / WebGL2 Infinite Canvas Whiteboard UI over `@jiange/whiteboard-sdk` + `@jiange/render-gpu`.
 * Uses `SpatialIndex` for O(1) frustum culling, `Camera2D` for pan/zoom, SDF GPU primitives for
 * shapes/edges/mindmaps/strokes, and `DomNodePool` for recycled text overlays. Zero Canvas 2D!
 */

import {
  Camera2D,
  DomNodePool,
  GpuSurface,
  InstanceBatch,
  SpatialIndex,
  packColorRGBA,
  type GpuFrameStats,
  type GpuSurfaceOptions,
  type PoolableElement,
} from "@jiange/render-gpu";
import {
  layoutMindTopics,
  themeOf,
  type Board,
  type FlowNode,
} from "@jiange/whiteboard-sdk";

export interface WhiteboardViewOptions {
  gpu?: GpuSurfaceOptions;
  onSelectionChange?: (nodeIds: string[]) => void;
}

export interface WhiteboardFrameResult {
  gpu: GpuFrameStats;
  visibleNodes: number;
  totalNodes: number;
  visibleMindTopics: number;
  zoom: number;
}

export class WhiteboardViewController<T extends PoolableElement = PoolableElement> {
  readonly camera = new Camera2D(0, 0, 1);
  readonly spatial = new SpatialIndex<string>(256);
  readonly labelPool: DomNodePool<T>;
  private readonly batch = new InstanceBatch(2048, 2048, 256);
  private width = 960;
  private height = 600;
  private selectedIds = new Set<string>();

  constructor(
    readonly board: Board,
    readonly surface: GpuSurface,
    labelFactory: () => T,
    private readonly options: WhiteboardViewOptions = {},
  ) {
    this.labelPool = new DomNodePool<T>(labelFactory);
    this.rebuildSpatialIndex();
  }

  getSelectedIds(): string[] {
    return [...this.selectedIds];
  }

  resize(widthPx: number, heightPx: number, dpr?: number): void {
    this.width = Math.max(100, Math.floor(widthPx));
    this.height = Math.max(100, Math.floor(heightPx));
    this.surface.resize(this.width, this.height, dpr);
  }

  rebuildSpatialIndex(graph?: ReturnType<Board["toGraph"]>): void {
    this.spatial.clear();
    const g = graph ?? this.board.toGraph();
    for (const n of g.nodes) {
      this.spatial.insert(n.id, { minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + n.h });
    }
  }

  pan(dxScreen: number, dyScreen: number): WhiteboardFrameResult {
    this.camera.x -= dxScreen / this.camera.zoom;
    this.camera.y -= dyScreen / this.camera.zoom;
    return this.render();
  }

  zoomAt(factor: number, screenX: number, screenY: number): WhiteboardFrameResult {
    const before = this.camera.screenToWorld(screenX, screenY);
    this.camera.zoom = Math.max(0.15, Math.min(4, this.camera.zoom * factor));
    const after = this.camera.screenToWorld(screenX, screenY);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    return this.render();
  }

  fitToScreen(padding = 48): WhiteboardFrameResult {
    const g = this.board.toGraph();
    if (g.nodes.length === 0) {
      this.camera.x = 0;
      this.camera.y = 0;
      this.camera.zoom = 1;
      return this.render();
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of g.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const availW = Math.max(64, this.width - padding * 2);
    const availH = Math.max(64, this.height - padding * 2);
    this.camera.zoom = Math.max(0.2, Math.min(2, Math.min(availW / contentW, availH / contentH)));
    this.camera.x = minX - (this.width / this.camera.zoom - contentW) / 2;
    this.camera.y = minY - (this.height / this.camera.zoom - contentH) / 2;
    return this.render();
  }

  selectNodes(ids: readonly string[]): void {
    this.selectedIds = new Set(ids);
    this.options.onSelectionChange?.(this.getSelectedIds());
  }

  hitTest(screenX: number, screenY: number): string | null {
    const w = this.camera.screenToWorld(screenX, screenY);
    const hits = this.spatial.hitTest(w.x, w.y);
    return hits.length > 0 ? hits[hits.length - 1] : null;
  }

  handlePointerDown(screenX: number, screenY: number, shiftKey = false): string | null {
    const hit = this.hitTest(screenX, screenY);
    if (hit) {
      if (shiftKey) {
        const next = new Set(this.selectedIds);
        if (next.has(hit)) next.delete(hit);
        else next.add(hit);
        this.selectNodes([...next]);
      } else {
        this.selectNodes([hit]);
      }
    } else if (!shiftKey) {
      this.selectNodes([]);
    }
    this.render();
    return hit;
  }

  dragSelected(dxScreen: number, dyScreen: number): boolean {
    if (this.selectedIds.size === 0) return false;
    const dx = Math.round(dxScreen / this.camera.zoom);
    const dy = Math.round(dyScreen / this.camera.zoom);
    const g = this.board.toGraph();
    const ops = g.nodes
      .filter((n) => this.selectedIds.has(n.id))
      .map((n) => ({ op: "updateNode" as const, id: n.id, patch: { x: n.x + dx, y: n.y + dy } }));
    if (ops.length === 0) return false;
    this.board.apply(ops);
    this.render();
    return true;
  }

  handleKeyDown(key: string, opts?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): boolean {
    const mod = Boolean(opts?.ctrlKey || opts?.metaKey);
    if (mod && key.toLowerCase() === "z") {
      if (opts?.shiftKey) this.board.redo();
      else this.board.undo();
      this.render();
      return true;
    }
    if ((key === "Delete" || key === "Backspace") && this.selectedIds.size > 0) {
      const ops = [...this.selectedIds].map((id) => ({ op: "deleteNode" as const, id }));
      this.board.apply(ops);
      this.selectNodes([]);
      this.render();
      return true;
    }
    return false;
  }

  render(): WhiteboardFrameResult {
    const g = this.board.toGraph();
    const theme = themeOf(g.theme);
    this.rebuildSpatialIndex(g);

    const topLeft = this.camera.screenToWorld(0, 0);
    const botRight = this.camera.screenToWorld(this.width, this.height);
    const visibleIdSet = new Set(
      this.spatial.queryRect({ minX: topLeft.x - 40, minY: topLeft.y - 40, maxX: botRight.x + 40, maxY: botRight.y + 40 }),
    );
    const nodesById = new Map<string, FlowNode>(g.nodes.map((n) => [n.id, n]));

    this.batch.reset();
    this.batch.camera.x = this.camera.x;
    this.batch.camera.y = this.camera.y;
    this.batch.camera.zoom = this.camera.zoom;
    this.surface.setClearColor(packColorRGBA(theme.canvas));

    // 1. Visible Edges (cull edges where neither endpoint is visible)
    const edgeColor = packColorRGBA(theme.edge);
    for (const e of g.edges) {
      if (!visibleIdSet.has(e.from) && !visibleIdSet.has(e.to)) continue;
      const a = nodesById.get(e.from);
      const b = nodesById.get(e.to);
      if (!a || !b) continue;
      this.batch.pushLine({
        x1: a.x + a.w / 2,
        y1: a.y + a.h / 2,
        x2: b.x + b.w / 2,
        y2: b.y + b.h / 2,
        thickness: 2,
        color: e.color ? packColorRGBA(e.color) : edgeColor,
        dashLen: e.dashed ? 6 : 0,
        gapLen: e.dashed ? 4 : 0,
      });
    }

    // 2. Visible Flowchart Nodes (SDF GPU shapes + recycled text pool)
    const labelItems: Array<{
      key: string;
      x: number;
      y: number;
      width: number;
      height: number;
      render: (el: T, newlyBound: boolean) => void;
    }> = [];

    for (const id of visibleIdSet) {
      const n = nodesById.get(id)!;
      const fill = packColorRGBA(n.fill ?? theme.fill);
      const stroke = packColorRGBA(n.stroke ?? theme.stroke);
      if (n.shape === "ellipse") {
        this.batch.pushArc({ cx: n.x + n.w / 2, cy: n.y + n.h / 2, rx: n.w / 2, ry: n.h / 2, color: fill, borderWidth: theme.strokeWidth });
      } else {
        const radius = n.shape === "terminator" ? n.h / 2 : n.shape === "round" ? 14 : theme.radius;
        this.batch.pushRect({
          x: n.x,
          y: n.y,
          w: n.w,
          h: n.h,
          fill: n.shape === "text" ? [0, 0, 0, 0] : fill,
          radius,
          borderWidth: n.shape === "text" ? 0 : theme.strokeWidth,
          borderColor: stroke,
          rotationRad: ((n.rot ?? 0) * Math.PI) / 180,
        });
      }

      if (this.selectedIds.has(n.id)) {
        this.batch.pushRect({
          x: n.x - 3,
          y: n.y - 3,
          w: n.w + 6,
          h: n.h + 6,
          fill: [0.2, 0.44, 1, 0.08],
          borderWidth: 2,
          borderColor: [0.2, 0.44, 1, 1],
          radius: 4,
        });
      }

      if (n.text) {
        const screen = this.camera.worldToScreen(n.x, n.y);
        labelItems.push({
          key: `n:${n.id}`,
          x: screen.x,
          y: screen.y,
          width: n.w * this.camera.zoom,
          height: n.h * this.camera.zoom,
          render: (el) => { el.textContent = n.text; },
        });
      }
    }

    // 3. MindMap layout & topics
    let visibleMindTopics = 0;
    if (g.mind && g.mind.length > 0) {
      const positioned = layoutMindTopics(g.mind, new Set(g.mindCollapsed ?? []), g.mindStyles, g.mindDescriptions, g.mindDescriptionStyles);
      const posById = new Map(positioned.map((p) => [p.topic.id, p]));
      for (const item of positioned) {
        if (item.x + item.w < topLeft.x || item.x > botRight.x || item.y + item.h < topLeft.y || item.y > botRight.y) continue;
        visibleMindTopics++;
        if (item.topic.parent) {
          const parentPos = posById.get(item.topic.parent);
          if (parentPos) {
            this.batch.pushLine({
              x1: parentPos.x + parentPos.w,
              y1: parentPos.y + parentPos.h / 2,
              x2: item.x,
              y2: item.y + item.h / 2,
              thickness: 1.6,
              color: edgeColor,
            });
          }
        }
        const isRoot = item.topic.parent === null;
        this.batch.pushRect({
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          fill: packColorRGBA(isRoot ? "#5b7ff1" : "#eef3fe"),
          borderWidth: 1.5,
          borderColor: packColorRGBA("#3370ff"),
          radius: 8,
        });
        const scr = this.camera.worldToScreen(item.x, item.y);
        labelItems.push({
          key: `m:${item.topic.id}`,
          x: scr.x,
          y: scr.y,
          width: item.w * this.camera.zoom,
          height: item.h * this.camera.zoom,
          render: (el) => { el.textContent = item.topic.text; },
        });
      }
    }

    // 4. Ink strokes
    for (const stroke of g.strokes ?? []) {
      const color = packColorRGBA(stroke.color, stroke.marker ? 0.4 : 1);
      for (let i = 0; i + 1 < stroke.points.length; i++) {
        this.batch.pushLine({
          x1: stroke.points[i].x,
          y1: stroke.points[i].y,
          x2: stroke.points[i + 1].x,
          y2: stroke.points[i + 1].y,
          thickness: stroke.width,
          color,
        });
      }
    }

    this.labelPool.sync(labelItems);
    const gpu = this.surface.render([this.batch]);
    return {
      gpu,
      visibleNodes: visibleIdSet.size,
      totalNodes: g.nodes.length,
      visibleMindTopics,
      zoom: this.camera.zoom,
    };
  }

  dispose(): void {
    this.labelPool.clear();
    this.spatial.clear();
    this.surface.dispose();
  }
}

export interface MountedWhiteboardView {
  controller: WhiteboardViewController<HTMLElement>;
  resize(width: number, height: number): void;
  dispose(): void;
}

export async function mountWhiteboardView(
  container: HTMLElement,
  board: Board,
  options: WhiteboardViewOptions = {},
): Promise<MountedWhiteboardView> {
  const doc = container.ownerDocument;
  container.style.position = "relative";
  container.style.overflow = "hidden";

  const canvas = doc.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.display = "block";
  container.appendChild(canvas);

  const labelLayer = doc.createElement("div");
  labelLayer.style.position = "absolute";
  labelLayer.style.inset = "0";
  labelLayer.style.pointerEvents = "none";
  container.appendChild(labelLayer);

  const surface = await GpuSurface.create(canvas, options.gpu);
  const controller = new WhiteboardViewController<HTMLElement>(
    board,
    surface,
    () => {
      const el = doc.createElement("div");
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.textAlign = "center";
      el.style.fontSize = "13px";
      labelLayer.appendChild(el);
      return el;
    },
    options,
  );

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = container.getBoundingClientRect();
      controller.zoomAt(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - rect.left, e.clientY - rect.top);
    } else {
      controller.pan(-e.deltaX, -e.deltaY);
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    controller.handlePointerDown(e.clientX - rect.left, e.clientY - rect.top, e.shiftKey);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (controller.handleKeyDown(e.key, { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey })) {
      e.preventDefault();
    }
  };

  container.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("keydown", onKeyDown);

  controller.resize(container.clientWidth || 960, container.clientHeight || 600);
  controller.fitToScreen();

  return {
    controller,
    resize(width: number, height: number) {
      controller.resize(width, height);
      controller.render();
    },
    dispose() {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("keydown", onKeyDown);
      controller.dispose();
      canvas.remove();
      labelLayer.remove();
    },
  };
}

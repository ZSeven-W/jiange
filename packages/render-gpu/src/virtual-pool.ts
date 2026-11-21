/**
 * Zero-churn DOM Node Recycling Pool, 1D Virtual List, and 4-Quadrant Frozen 2D Virtual Grid.
 *
 * Recycled nodes stay mounted and are positioned strictly via GPU-composited
 * `transform: translate3d(x, y, 0)` + `contain: strict` — zero DOM mount/unmount during scroll!
 */

import { FenwickVirtualizer } from "./fenwick.js";

export interface PoolableElement {
  style: {
    transform: string;
    width: string;
    height: string;
    display: string;
    position?: string;
    top?: string;
    left?: string;
    contain?: string;
    willChange?: string;
  };
  textContent: string | null;
  setAttribute?(name: string, value: string): void;
}

export interface PooledSlot<T extends PoolableElement = PoolableElement> {
  key: string;
  element: T;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Fixed/bounded element recycling pool that diffs active keys between frames
 * and reuses freed elements without creating/destroying DOM nodes.
 */
export class DomNodePool<T extends PoolableElement = PoolableElement> {
  private active = new Map<string, PooledSlot<T>>();
  private free: T[] = [];
  private created = 0;
  private recycled = 0;

  constructor(private readonly factory: () => T) {}

  get activeCount(): number {
    return this.active.size;
  }

  get freeCount(): number {
    return this.free.length;
  }

  get totalCreated(): number {
    return this.created;
  }

  get totalRecycled(): number {
    return this.recycled;
  }

  /** Reconcile desired visible items into pooled slots with zero unnecessary DOM allocations. */
  sync(
    items: ReadonlyArray<{
      key: string;
      x: number;
      y: number;
      width: number;
      height: number;
      render: (el: T, newlyBound: boolean) => void;
    }>,
  ): ReadonlyMap<string, PooledSlot<T>> {
    const nextKeys = new Set<string>();
    for (const item of items) nextKeys.add(item.key);

    // 1. Release slots no longer visible into free list
    for (const [key, slot] of this.active) {
      if (!nextKeys.has(key)) {
        slot.element.style.display = "none";
        this.free.push(slot.element);
        this.active.delete(key);
      }
    }

    // 2. Bind or update visible items
    for (const item of items) {
      let slot = this.active.get(item.key);
      let newlyBound = false;
      if (!slot) {
        newlyBound = true;
        let el: T;
        if (this.free.length > 0) {
          el = this.free.pop()!;
          this.recycled++;
        } else {
          el = this.factory();
          el.style.position = "absolute";
          el.style.top = "0px";
          el.style.left = "0px";
          el.style.contain = "strict";
          el.style.willChange = "transform";
          this.created++;
        }
        el.style.display = "";
        slot = { key: item.key, element: el, x: NaN, y: NaN, width: NaN, height: NaN };
        this.active.set(item.key, slot);
      }

      if (slot.x !== item.x || slot.y !== item.y) {
        slot.x = item.x;
        slot.y = item.y;
        slot.element.style.transform = `translate3d(${item.x}px, ${item.y}px, 0)`;
      }
      if (slot.width !== item.width) {
        slot.width = item.width;
        slot.element.style.width = `${item.width}px`;
      }
      if (slot.height !== item.height) {
        slot.height = item.height;
        slot.element.style.height = `${item.height}px`;
      }
      item.render(slot.element, newlyBound);
    }

    return this.active;
  }

  /** Hide all active slots and return them to the free pool. */
  clear(): void {
    for (const slot of this.active.values()) {
      slot.element.style.display = "none";
      this.free.push(slot.element);
    }
    this.active.clear();
  }
}

export interface VirtualList1DItem {
  index: number;
  offset: number;
  size: number;
}

export class VirtualList1D<T extends PoolableElement = PoolableElement> {
  readonly sizes: FenwickVirtualizer;
  readonly pool: DomNodePool<T>;

  constructor(count: number, defaultItemHeight: number, elementFactory: () => T) {
    this.sizes = new FenwickVirtualizer(count, defaultItemHeight);
    this.pool = new DomNodePool<T>(elementFactory);
  }

  update(
    scrollTop: number,
    viewportHeight: number,
    viewportWidth: number,
    renderItem: (index: number, el: T, newlyBound: boolean) => void,
    overscan = 3,
  ): { start: number; end: number; totalHeight: number; items: VirtualList1DItem[] } {
    const range = this.sizes.visibleRange(scrollTop, viewportHeight, overscan);
    const items: VirtualList1DItem[] = [];
    const poolInputs: Array<{
      key: string;
      x: number;
      y: number;
      width: number;
      height: number;
      render: (el: T, newlyBound: boolean) => void;
    }> = [];

    for (let i = range.start; i <= range.end; i++) {
      const h = this.sizes.getSize(i);
      if (h <= 0) continue;
      const y = this.sizes.indexToOffset(i);
      items.push({ index: i, offset: y, size: h });
      poolInputs.push({
        key: `r:${i}`,
        x: 0,
        y: y - scrollTop,
        width: viewportWidth,
        height: h,
        render: (el, newlyBound) => renderItem(i, el, newlyBound),
      });
    }

    this.pool.sync(poolInputs);
    return { start: range.start, end: range.end, totalHeight: range.totalSize, items };
  }
}

export type GridQuadrant = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface VisibleGridCell {
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  quadrant: GridQuadrant;
}

export interface VirtualGridViewport {
  scrollLeft: number;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
  frozenRows?: number;
  frozenCols?: number;
  overscanRows?: number;
  overscanCols?: number;
}

export interface VirtualGridFrame {
  cells: VisibleGridCell[];
  frozenWidth: number;
  frozenHeight: number;
  totalWidth: number;
  totalHeight: number;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

/**
 * 2D Pooled Virtual Grid with 4-quadrant frozen row/column panes for Sheets & Base tables.
 */
export class VirtualGrid2D<T extends PoolableElement = PoolableElement> {
  readonly rows: FenwickVirtualizer;
  readonly cols: FenwickVirtualizer;
  readonly pool: DomNodePool<T>;

  constructor(
    rowCount: number,
    colCount: number,
    defaultRowHeight: number,
    defaultColWidth: number,
    elementFactory: () => T,
  ) {
    this.rows = new FenwickVirtualizer(rowCount, defaultRowHeight);
    this.cols = new FenwickVirtualizer(colCount, defaultColWidth);
    this.pool = new DomNodePool<T>(elementFactory);
  }

  /** Compute visible cells across all 4 frozen-pane quadrants without touching DOM yet. */
  computeFrame(vp: VirtualGridViewport): VirtualGridFrame {
    const frozenRows = Math.max(0, Math.min(this.rows.itemCount, vp.frozenRows ?? 0));
    const frozenCols = Math.max(0, Math.min(this.cols.itemCount, vp.frozenCols ?? 0));
    const frozenHeight = this.rows.indexToOffset(frozenRows);
    const frozenWidth = this.cols.indexToOffset(frozenCols);

    const bodyViewH = Math.max(0, vp.viewportHeight - frozenHeight);
    const bodyViewW = Math.max(0, vp.viewportWidth - frozenWidth);
    const rowRange = this.rows.visibleRange(frozenHeight + vp.scrollTop, bodyViewH, vp.overscanRows ?? 2);
    const colRange = this.cols.visibleRange(frozenWidth + vp.scrollLeft, bodyViewW, vp.overscanCols ?? 2);

    const rowStart = Math.max(frozenRows, rowRange.start);
    const colStart = Math.max(frozenCols, colRange.start);
    const cells: VisibleGridCell[] = [];

    const pushCell = (row: number, col: number, x: number, y: number, w: number, h: number, quadrant: GridQuadrant) => {
      if (w <= 0 || h <= 0) return;
      cells.push({ row, col, x, y, width: w, height: h, quadrant });
    };

    // Quadrant 1: Top-Left (frozen rows x frozen cols)
    for (let r = 0; r < frozenRows; r++) {
      const y = this.rows.indexToOffset(r);
      const h = this.rows.getSize(r);
      for (let c = 0; c < frozenCols; c++) {
        pushCell(r, c, this.cols.indexToOffset(c), y, this.cols.getSize(c), h, "top-left");
      }
    }

    // Quadrant 2: Top-Right (frozen rows x scrollable cols)
    for (let r = 0; r < frozenRows; r++) {
      const y = this.rows.indexToOffset(r);
      const h = this.rows.getSize(r);
      for (let c = colStart; c <= colRange.end; c++) {
        const x = this.cols.indexToOffset(c) - vp.scrollLeft;
        pushCell(r, c, x, y, this.cols.getSize(c), h, "top-right");
      }
    }

    // Quadrant 3: Bottom-Left (scrollable rows x frozen cols)
    for (let r = rowStart; r <= rowRange.end; r++) {
      const y = this.rows.indexToOffset(r) - vp.scrollTop;
      const h = this.rows.getSize(r);
      for (let c = 0; c < frozenCols; c++) {
        pushCell(r, c, this.cols.indexToOffset(c), y, this.cols.getSize(c), h, "bottom-left");
      }
    }

    // Quadrant 4: Bottom-Right (scrollable body)
    for (let r = rowStart; r <= rowRange.end; r++) {
      const y = this.rows.indexToOffset(r) - vp.scrollTop;
      const h = this.rows.getSize(r);
      for (let c = colStart; c <= colRange.end; c++) {
        const x = this.cols.indexToOffset(c) - vp.scrollLeft;
        pushCell(r, c, x, y, this.cols.getSize(c), h, "bottom-right");
      }
    }

    return {
      cells,
      frozenWidth,
      frozenHeight,
      totalWidth: this.cols.totalSize,
      totalHeight: this.rows.totalSize,
      rowStart,
      rowEnd: rowRange.end,
      colStart,
      colEnd: colRange.end,
    };
  }

  /** Sync visible cells into the recycled DOM pool. Optionally filter to non-empty cells only. */
  sync(
    vp: VirtualGridViewport,
    renderCell: (cell: VisibleGridCell, el: T, newlyBound: boolean) => void,
    shouldMount?: (row: number, col: number) => boolean,
  ): VirtualGridFrame {
    const frame = this.computeFrame(vp);
    const inputs: Array<{
      key: string;
      x: number;
      y: number;
      width: number;
      height: number;
      render: (el: T, newlyBound: boolean) => void;
    }> = [];

    for (const cell of frame.cells) {
      if (shouldMount && !shouldMount(cell.row, cell.col)) continue;
      inputs.push({
        key: `${cell.row}:${cell.col}`,
        x: cell.x,
        y: cell.y,
        width: cell.width,
        height: cell.height,
        render: (el, newlyBound) => renderCell(cell, el, newlyBound),
      });
    }

    this.pool.sync(inputs);
    return frame;
  }
}

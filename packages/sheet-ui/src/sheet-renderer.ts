/**
 * WebGPU / WebGL2 + 4-Quadrant Pooled 2D Virtual Grid Spreadsheet Renderer.
 *
 * ZERO Canvas 2D usage:
 * - Background fills, conditional format fills, gridlines, borders, selection highlights,
 *   collaborator cursors, and inline charts are packed into pre-allocated Float32Array
 *   `InstanceBatch`es and rendered via `GpuSurface` (WebGPU primary / WebGL2 fallback).
 * - Visible non-empty cell text is rendered via `VirtualGrid2D`'s fixed-size recycled
 *   DOM pool positioned with `translate3d` + `contain: strict`.
 */

import {
  GpuSurface,
  InstanceBatch,
  VirtualGrid2D,
  packColorRGBA,
  type GpuFrameStats,
  type GridQuadrant,
  type PoolableElement,
  type RgbaTuple,
  type VirtualGridFrame,
} from "@jiange/render-gpu";
import {
  buildWorksheetGridMap,
  evaluateSheetConditionalFormat,
  extractChartDataset,
  formatCellDisplay,
  type SheetWorksheet,
  type Workbook,
} from "@jiange/sheet-sdk";

export interface SheetSelectionRange {
  anchorRow: number;
  anchorCol: number;
  focusRow: number;
  focusCol: number;
}

export interface SheetCollaboratorCursor {
  id: string;
  name: string;
  color: string;
  row: number;
  col: number;
}

export interface SheetRenderTheme {
  background: RgbaTuple;
  headerBg: RgbaTuple;
  gridLine: RgbaTuple;
  frozenLine: RgbaTuple;
  selectionFill: RgbaTuple;
  selectionBorder: RgbaTuple;
  defaultRowHeight: number;
  defaultColWidth: number;
  headerHeight: number;
  rowHeaderWidth: number;
}

export const DEFAULT_SHEET_THEME: SheetRenderTheme = {
  background: [1, 1, 1, 1],
  headerBg: [0.96, 0.97, 0.985, 1],
  gridLine: [0.89, 0.91, 0.94, 1],
  frozenLine: [0.82, 0.86, 0.91, 1],
  selectionFill: [0.2, 0.44, 1, 0.12],
  selectionBorder: [0.2, 0.44, 1, 1],
  defaultRowHeight: 28,
  defaultColWidth: 108,
  headerHeight: 26,
  rowHeaderWidth: 48,
};

const CHART_COLORS: RgbaTuple[] = [
  [0.2, 0.44, 1, 0.92],
  [0, 0.71, 0.16, 0.92],
  [1, 0.49, 0, 0.92],
  [0.45, 0.18, 0.82, 0.92],
  [0.96, 0.25, 0.25, 0.92],
];

export interface SheetFrameResult {
  gpu: GpuFrameStats;
  grid: VirtualGridFrame;
  mountedTextCells: number;
}

export class SheetGpuRenderer<T extends PoolableElement = PoolableElement> {
  readonly grid: VirtualGrid2D<T>;
  readonly theme: SheetRenderTheme;
  private readonly quadBatches: Record<GridQuadrant, InstanceBatch>;
  private readonly overlayBatch: InstanceBatch;
  private viewportWidth = 960;
  private viewportHeight = 600;
  private scrollLeft = 0;
  private scrollTop = 0;
  private syncedSheetId = -1;
  private syncedVersion = -1;

  constructor(
    readonly surface: GpuSurface,
    cellFactory: () => T,
    theme?: Partial<SheetRenderTheme>,
  ) {
    this.theme = { ...DEFAULT_SHEET_THEME, ...theme };
    this.grid = new VirtualGrid2D<T>(
      100,
      26,
      this.theme.defaultRowHeight,
      this.theme.defaultColWidth,
      cellFactory,
    );
    this.quadBatches = {
      "bottom-right": new InstanceBatch(2048, 2048, 64),
      "bottom-left": new InstanceBatch(512, 512, 16),
      "top-right": new InstanceBatch(512, 512, 16),
      "top-left": new InstanceBatch(128, 128, 16),
    };
    this.overlayBatch = new InstanceBatch(256, 512, 128);
  }

  resize(widthPx: number, heightPx: number, dpr?: number): void {
    this.viewportWidth = Math.max(1, Math.floor(widthPx));
    this.viewportHeight = Math.max(1, Math.floor(heightPx));
    this.surface.resize(this.viewportWidth, this.viewportHeight, dpr);
  }

  setScroll(scrollLeft: number, scrollTop: number): void {
    const maxX = Math.max(0, this.grid.cols.totalSize - this.contentWidth);
    const maxY = Math.max(0, this.grid.rows.totalSize - this.contentHeight);
    this.scrollLeft = Math.max(0, Math.min(maxX, scrollLeft));
    this.scrollTop = Math.max(0, Math.min(maxY, scrollTop));
  }

  getScroll(): { scrollLeft: number; scrollTop: number } {
    return { scrollLeft: this.scrollLeft, scrollTop: this.scrollTop };
  }

  get contentWidth(): number {
    return Math.max(1, this.viewportWidth - this.theme.rowHeaderWidth);
  }

  get contentHeight(): number {
    return Math.max(1, this.viewportHeight - this.theme.headerHeight);
  }

  /** Sync variable row heights and column widths into the sparse O(log N) Fenwick trees. */
  syncDimensions(ws: SheetWorksheet, workbookVersion: number): void {
    if (this.syncedSheetId === ws.id && this.syncedVersion === workbookVersion) return;
    this.syncedSheetId = ws.id;
    this.syncedVersion = workbookVersion;

    this.grid.rows.setCount(ws.rows.length);
    this.grid.cols.setCount(ws.columns.length);
    this.grid.rows.resetAll(this.theme.defaultRowHeight);
    this.grid.cols.resetAll(this.theme.defaultColWidth);

    ws.rows.forEach((r, idx) => {
      if (r.size === 0) this.grid.rows.setSize(idx, 0);
      else if (r.size && r.size > 0) this.grid.rows.setSize(idx, r.size);
    });
    ws.columns.forEach((c, idx) => {
      if (c.size === 0) this.grid.cols.setSize(idx, 0);
      else if (c.size && c.size > 0) this.grid.cols.setSize(idx, c.size);
    });
  }

  /** O(log N) hit-test from canvas-local pixel coordinates to `(row, col)`. */
  pointToCell(x: number, y: number, ws: SheetWorksheet): { row: number; col: number } | null {
    const gx = x - this.theme.rowHeaderWidth;
    const gy = y - this.theme.headerHeight;
    if (gx < 0 || gy < 0) return null;

    const frozenW = this.grid.cols.indexToOffset(Math.min(ws.frozenCols, ws.columns.length));
    const frozenH = this.grid.rows.indexToOffset(Math.min(ws.frozenRows, ws.rows.length));

    const worldX = gx < frozenW ? gx : gx + this.scrollLeft;
    const worldY = gy < frozenH ? gy : gy + this.scrollTop;
    const col = this.grid.cols.offsetToIndex(worldX);
    const row = this.grid.rows.offsetToIndex(worldY);
    return { row, col };
  }

  /** Compute screen-local pixel rect for a single cell (used to position the singleton IME editor). */
  getCellRect(row: number, col: number, ws: SheetWorksheet): { x: number; y: number; width: number; height: number } {
    const isFrozenRow = row < ws.frozenRows;
    const isFrozenCol = col < ws.frozenCols;
    const x = this.theme.rowHeaderWidth + this.grid.cols.indexToOffset(col) - (isFrozenCol ? 0 : this.scrollLeft);
    const y = this.theme.headerHeight + this.grid.rows.indexToOffset(row) - (isFrozenRow ? 0 : this.scrollTop);
    return { x, y, width: this.grid.cols.getSize(col), height: this.grid.rows.getSize(row) };
  }

  /** Pack visible grid geometry, conditional formats, selections, cursors, and charts into GPU batches + sync text pool. */
  render(
    workbook: Workbook,
    sheetIndexOrName: number | string,
    selection: SheetSelectionRange | null,
    collaborators: readonly SheetCollaboratorCursor[] = [],
  ): SheetFrameResult {
    const proxy = workbook.sheet(sheetIndexOrName);
    const ws = workbook._getWorksheetById(proxy.id)!;
    this.syncDimensions(ws, workbook.version);

    const { cellByKey } = buildWorksheetGridMap(ws);
    const headerX = this.theme.rowHeaderWidth;
    const headerY = this.theme.headerHeight;

    for (const q of Object.keys(this.quadBatches) as GridQuadrant[]) {
      this.quadBatches[q].reset();
    }
    this.overlayBatch.reset();

    const mountedRef = { count: 0 };
    const evalMap = new Map<string, ReturnType<Workbook["_getEvalValue"]>>();
    const evalNumber = (r: number, c: number) => {
      const key = `${r}:${c}`;
      const cached = evalMap.get(key);
      if (cached !== undefined) return cached;
      const ev = workbook._getEvalValue(ws.id, r, c);
      evalMap.set(key, ev);
      return ev;
    };

    const frozenW = this.grid.cols.indexToOffset(Math.min(ws.frozenCols, ws.columns.length));
    const frozenH = this.grid.rows.indexToOffset(Math.min(ws.frozenRows, ws.rows.length));
    const chartBoxes = (ws.charts ?? []).map((chart, idx) => ({
      x: headerX + (chart.x ?? (24 + idx * 340)) - this.scrollLeft,
      y: headerY + (chart.y ?? 24) - this.scrollTop,
      w: chart.width ?? 320,
      h: chart.height ?? 200,
    }));

    const gridFrame = this.grid.sync(
      {
        scrollLeft: this.scrollLeft,
        scrollTop: this.scrollTop,
        viewportWidth: this.contentWidth,
        viewportHeight: this.contentHeight,
        frozenRows: ws.frozenRows,
        frozenCols: ws.frozenCols,
      },
      (cell, el) => {
        mountedRef.count++;
        const rawCell = cellByKey.get(`${cell.row}:${cell.col}`);
        const ev = evalNumber(cell.row, cell.col);
        el.textContent = formatCellDisplay(rawCell?.raw ?? "", ev, rawCell?.style);
        // Shift recycled text slot by header offsets and clip against frozen panes so scrolled text never bleeds through
        const sx = headerX + cell.x;
        const sy = headerY + cell.y;
        el.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;
        const clipLeft = (cell.quadrant === "top-right" || cell.quadrant === "bottom-right") ? Math.max(0, frozenW - cell.x) : 0;
        const clipTop = (cell.quadrant === "bottom-left" || cell.quadrant === "bottom-right") ? Math.max(0, frozenH - cell.y) : 0;
        el.style.clipPath = clipTop > 0 || clipLeft > 0 ? `inset(${clipTop}px 0px 0px ${clipLeft}px)` : "";
        el.style.zIndex = cell.quadrant === "top-left" ? "4" : cell.quadrant === "bottom-right" ? "1" : "3";
        const occludedByChart = chartBoxes.some(
          (b) => sx + cell.width > b.x && sx < b.x + b.w && sy + cell.height > b.y && sy < b.y + b.h,
        );
        el.style.opacity = occludedByChart ? "0" : "";
      },
      (row, col) => {
        const isScrollCol = col >= ws.frozenCols;
        const isScrollRow = row >= ws.frozenRows;
        if (isScrollCol && this.grid.cols.indexToOffset(col + 1) - this.scrollLeft <= frozenW) return false;
        if (isScrollRow && this.grid.rows.indexToOffset(row + 1) - this.scrollTop <= frozenH) return false;
        const rawCell = cellByKey.get(`${row}:${col}`);
        const ev = evalNumber(row, col);
        return Boolean((rawCell && rawCell.raw !== "") || (ev && ev.kind !== "empty"));
      },
    );

    // Configure 4-quadrant GPU scissor rects so scrolled cells never bleed under frozen headers
    const fw = gridFrame.frozenWidth;
    const fh = gridFrame.frozenHeight;
    this.quadBatches["top-left"].scissor = { x: headerX, y: headerY, w: Math.max(1, fw), h: Math.max(1, fh) };
    this.quadBatches["top-right"].scissor = { x: headerX + fw, y: headerY, w: Math.max(1, this.contentWidth - fw), h: Math.max(1, fh) };
    this.quadBatches["bottom-left"].scissor = { x: headerX, y: headerY + fh, w: Math.max(1, fw), h: Math.max(1, this.contentHeight - fh) };
    this.quadBatches["bottom-right"].scissor = { x: headerX + fw, y: headerY + fh, w: Math.max(1, this.contentWidth - fw), h: Math.max(1, this.contentHeight - fh) };

    // Pack visible cells into GPU batches (fills + conditional formatting + crisp gridlines)
    for (const cell of gridFrame.cells) {
      const batch = this.quadBatches[cell.quadrant];
      const sx = headerX + cell.x;
      const sy = headerY + cell.y;
      const rawCell = cellByKey.get(`${cell.row}:${cell.col}`);
      const ev = evalNumber(cell.row, cell.col);
      const condStyle = ws.conditionalFormats?.length
        ? evaluateSheetConditionalFormat(rawCell?.raw ?? "", ev, ws.conditionalFormats, cell.row, cell.col)
        : null;
      const bgCss = condStyle?.bg ?? rawCell?.style?.bg;

      if (bgCss) {
        batch.pushRect({
          x: sx,
          y: sy,
          w: cell.width,
          h: cell.height,
          fill: packColorRGBA(bgCss),
        });
      }

      // Right & bottom 1px crisp gridlines
      batch.pushLine({
        x1: sx + cell.width,
        y1: sy,
        x2: sx + cell.width,
        y2: sy + cell.height,
        thickness: 1,
        color: this.theme.gridLine,
      });
      batch.pushLine({
        x1: sx,
        y1: sy + cell.height,
        x2: sx + cell.width,
        y2: sy + cell.height,
        thickness: 1,
        color: this.theme.gridLine,
      });
    }

    // Header bars & frozen pane divider lines on overlay batch
    this.overlayBatch.pushRect({ x: 0, y: 0, w: this.viewportWidth, h: headerY, fill: this.theme.headerBg });
    this.overlayBatch.pushRect({ x: 0, y: headerY, w: headerX, h: this.contentHeight, fill: this.theme.headerBg });
    if (fh > 0) {
      this.overlayBatch.pushLine({ x1: 0, y1: headerY + fh, x2: this.viewportWidth, y2: headerY + fh, thickness: 1.5, color: this.theme.frozenLine });
    }
    if (fw > 0) {
      this.overlayBatch.pushLine({ x1: headerX + fw, y1: 0, x2: headerX + fw, y2: this.viewportHeight, thickness: 1.5, color: this.theme.frozenLine });
    }

    // Active selection range highlight
    if (selection) {
      const r1 = Math.min(selection.anchorRow, selection.focusRow);
      const r2 = Math.max(selection.anchorRow, selection.focusRow);
      const c1 = Math.min(selection.anchorCol, selection.focusCol);
      const c2 = Math.max(selection.anchorCol, selection.focusCol);
      const topLeft = this.getCellRect(r1, c1, ws);
      const botRight = this.getCellRect(r2, c2, ws);
      const selW = Math.max(topLeft.width, botRight.x + botRight.width - topLeft.x);
      const selH = Math.max(topLeft.height, botRight.y + botRight.height - topLeft.y);
      this.overlayBatch.pushRect({
        x: topLeft.x,
        y: topLeft.y,
        w: selW,
        h: selH,
        fill: this.theme.selectionFill,
        borderWidth: 2,
        borderColor: this.theme.selectionBorder,
        radius: 2,
      });
    }

    // Remote collaborator cursors
    for (const collab of collaborators) {
      const rect = this.getCellRect(collab.row, collab.col, ws);
      const col = packColorRGBA(collab.color);
      this.overlayBatch.pushRect({
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
        fill: [col[0], col[1], col[2], 0.08],
        borderWidth: 2,
        borderColor: col,
        radius: 2,
      });
    }

    // GPU-rendered inline charts (zero Canvas 2D!)
    if (ws.charts?.length) {
      const evalRecord: Record<string, NonNullable<ReturnType<Workbook["_getEvalValue"]>>> = {};
      for (const cell of ws.cells) {
        const rIdx = ws.rows.findIndex((r) => r.id === cell.rowId);
        const cIdx = ws.columns.findIndex((c) => c.id === cell.columnId);
        if (rIdx >= 0 && cIdx >= 0) {
          const ev = workbook._getEvalValue(ws.id, rIdx, cIdx);
          if (ev) evalRecord[`${rIdx}:${cIdx}`] = ev;
        }
      }
      ws.charts.forEach((chart, idx) => {
        const model = extractChartDataset(ws, evalRecord, chart);
        const box = chartBoxes[idx];
        const cx = box.x;
        const cy = box.y;
        const cw = box.w;
        const ch = box.h;
        this.overlayBatch.pushRect({
          x: cx,
          y: cy,
          w: cw,
          h: ch,
          fill: [1, 1, 1, 0.98],
          borderWidth: 1,
          borderColor: [0.85, 0.88, 0.93, 1],
          radius: 8,
        });
        const maxVal = Math.max(1, ...model.series.flatMap((s) => s.values.map((v) => Math.abs(v))));
        const plotX = cx + 20;
        const plotY = cy + 28;
        const plotW = cw - 40;
        const plotH = ch - 48;

        if (chart.type === "pie") {
          const vals = model.series[0]?.values ?? [];
          const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
          let angle = 0;
          vals.forEach((v, i) => {
            const sweep = (Math.max(0, v) / total) * Math.PI * 2;
            this.overlayBatch.pushArc({
              cx: plotX + plotW / 2,
              cy: plotY + plotH / 2,
              rx: Math.min(plotW, plotH) * 0.42,
              ry: Math.min(plotW, plotH) * 0.42,
              startAngle: angle,
              endAngle: angle + sweep,
              color: CHART_COLORS[i % CHART_COLORS.length],
            });
            angle += sweep;
          });
        } else if (chart.type === "line" || chart.type === "area") {
          const denom = Math.max(1, model.labels.length - 1);
          model.series.forEach((s, sIdx) => {
            const color = CHART_COLORS[sIdx % CHART_COLORS.length];
            for (let i = 0; i + 1 < s.values.length; i++) {
              const x1 = plotX + (i / denom) * plotW;
              const y1 = plotY + plotH - (Math.max(0, s.values[i]) / maxVal) * plotH;
              const x2 = plotX + ((i + 1) / denom) * plotW;
              const y2 = plotY + plotH - (Math.max(0, s.values[i + 1]) / maxVal) * plotH;
              this.overlayBatch.pushLine({ x1, y1, x2, y2, thickness: 2.5, color });
            }
          });
        } else {
          const cats = Math.max(1, model.labels.length);
          const sCount = Math.max(1, model.series.length);
          const groupW = plotW / cats;
          const barW = Math.max(4, (groupW * 0.72) / sCount);
          model.series.forEach((s, sIdx) => {
            const color = CHART_COLORS[sIdx % CHART_COLORS.length];
            s.values.forEach((v, cIdx) => {
              const bh = (Math.max(0, v) / maxVal) * plotH;
              this.overlayBatch.pushRect({
                x: plotX + cIdx * groupW + groupW * 0.14 + sIdx * barW,
                y: plotY + plotH - bh,
                w: Math.max(2, barW - 2),
                h: Math.max(1, bh),
                fill: color,
                radius: 2,
              });
            });
          });
        }
      });
    }

    const gpu = this.surface.render([
      this.quadBatches["bottom-right"],
      this.quadBatches["bottom-left"],
      this.quadBatches["top-right"],
      this.quadBatches["top-left"],
      this.overlayBatch,
    ]);

    return { gpu, grid: gridFrame, mountedTextCells: mountedRef.count };
  }

  dispose(): void {
    this.grid.pool.clear();
    this.surface.dispose();
  }
}

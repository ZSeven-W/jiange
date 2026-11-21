/**
 * WebGPU / WebGL2 + Virtual Grid / Kanban / Gantt / Dashboard UI over `@jiange/base-sdk`.
 * Zero Canvas 2D usage.
 */

import {
  formatCellText,
  matchFillRule,
  type Base,
  type BaseCell,
  type BaseField,
  type BaseRecord,
  type FillRule,
  type QueryRecordsOptions,
} from "@jiange/base-sdk";
import {
  GpuSurface,
  InstanceBatch,
  VirtualGrid2D,
  packColorRGBA,
  type GpuFrameStats,
  type GpuSurfaceOptions,
  type PoolableElement,
  type RgbaTuple,
} from "@jiange/render-gpu";

export type BaseRenderMode = "grid" | "kanban" | "gantt" | "dashboard";

export interface BaseViewOptions {
  gpu?: GpuSurfaceOptions;
  tableId?: number;
  mode?: BaseRenderMode;
  frozenCols?: number;
  rowHeight?: number;
  colWidth?: number;
  fills?: FillRule[];
}

export interface BaseFrameResult {
  mode: BaseRenderMode;
  gpu: GpuFrameStats;
  recordCount: number;
  mountedElements: number;
}

const ROW_FILL_COLORS: RgbaTuple[] = [
  [0.93, 0.95, 1, 1],
  [0.86, 0.99, 0.91, 1],
  [1, 0.95, 0.86, 1],
  [1, 0.9, 0.9, 1],
  [0.95, 0.91, 1, 1],
];

export class BaseViewController<T extends PoolableElement = PoolableElement> {
  readonly grid: VirtualGrid2D<T>;
  private readonly batch = new InstanceBatch(1024, 1024, 128);
  private tableId: number | undefined;
  private mode: BaseRenderMode;
  private queryOptions: QueryRecordsOptions = {};
  private fills: FillRule[];
  private scrollLeft = 0;
  private scrollTop = 0;
  private width = 960;
  private height = 560;
  private frozenCols: number;
  private queryEpoch = 0;
  private cachedVersion = -1;
  private cachedEpoch = -1;
  private cachedFields: BaseField[] = [];
  private cachedRecords: BaseRecord[] = [];

  constructor(
    readonly base: Base,
    readonly surface: GpuSurface,
    cellFactory: () => T,
    options: BaseViewOptions = {},
  ) {
    this.tableId = options.tableId;
    this.mode = options.mode ?? "grid";
    this.frozenCols = options.frozenCols ?? 1;
    this.fills = options.fills ?? [];
    this.grid = new VirtualGrid2D<T>(0, 0, options.rowHeight ?? 34, options.colWidth ?? 160, cellFactory);
  }

  getMode(): BaseRenderMode {
    return this.mode;
  }

  setMode(mode: BaseRenderMode): BaseFrameResult {
    this.mode = mode;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    return this.render();
  }

  setTable(tableId: number): BaseFrameResult {
    this.tableId = tableId;
    this.queryEpoch++;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    return this.render();
  }

  setQuery(query: QueryRecordsOptions): BaseFrameResult {
    this.queryOptions = { ...query };
    this.queryEpoch++;
    return this.render();
  }

  setFills(fills: readonly FillRule[]): void {
    this.fills = [...fills];
  }

  resize(widthPx: number, heightPx: number, dpr?: number): void {
    this.width = Math.max(160, Math.floor(widthPx));
    this.height = Math.max(120, Math.floor(heightPx));
    this.surface.resize(this.width, this.height, dpr);
  }

  scrollBy(dx: number, dy: number): BaseFrameResult {
    this.scrollLeft = Math.max(0, this.scrollLeft + dx);
    this.scrollTop = Math.max(0, this.scrollTop + dy);
    return this.render();
  }

  updateCell(recordId: number, fieldIdOrName: string, value: BaseCell | null): BaseFrameResult {
    this.base.updateRecord(recordId, { [fieldIdOrName]: value });
    return this.render();
  }

  private getViewData(): { fields: BaseField[]; records: BaseRecord[] } {
    if (this.cachedVersion === this.base.version && this.cachedEpoch === this.queryEpoch) {
      return { fields: this.cachedFields, records: this.cachedRecords };
    }
    this.cachedFields = this.base.getFields(this.tableId);
    this.cachedRecords = this.base.query({ ...this.queryOptions, tableId: this.tableId }).records;
    this.cachedVersion = this.base.version;
    this.cachedEpoch = this.queryEpoch;
    return { fields: this.cachedFields, records: this.cachedRecords };
  }

  render(): BaseFrameResult {
    const { fields, records } = this.getViewData();
    this.batch.reset();

    if (this.mode === "grid") {
      this.grid.rows.setCount(records.length);
      this.grid.cols.setCount(fields.length);
      const headerH = 34;

      // Header row backdrop
      this.batch.pushRect({ x: 0, y: 0, w: this.width, h: headerH, fill: [0.96, 0.97, 0.99, 1] });
      this.batch.pushLine({ x1: 0, y1: headerH, x2: this.width, y2: headerH, thickness: 1, color: [0.85, 0.88, 0.93, 1] });

      let mounted = 0;
      const frame = this.grid.sync(
        {
          scrollLeft: this.scrollLeft,
          scrollTop: this.scrollTop,
          viewportWidth: this.width,
          viewportHeight: Math.max(1, this.height - headerH),
          frozenRows: 0,
          frozenCols: Math.min(this.frozenCols, fields.length),
        },
        (cell, el) => {
          mounted++;
          const rec = records[cell.row];
          const field = fields[cell.col];
          el.textContent = formatCellText(rec.cells[String(field.id)]);
          el.style.transform = `translate3d(${cell.x}px, ${headerH + cell.y}px, 0)`;
        },
      );

      const paintedRows = new Set<number>();
      for (const cell of frame.cells) {
        const sy = headerH + cell.y;
        if (!paintedRows.has(cell.row)) {
          paintedRows.add(cell.row);
          const rec = records[cell.row];
          const fillIdx = matchFillRule(rec, this.fills);
          if (fillIdx !== null) {
            this.batch.pushRect({
              x: 0,
              y: sy,
              w: this.width,
              h: cell.height,
              fill: ROW_FILL_COLORS[Math.abs(fillIdx) % ROW_FILL_COLORS.length],
            });
          }
          this.batch.pushLine({ x1: 0, y1: sy + cell.height, x2: this.width, y2: sy + cell.height, thickness: 1, color: [0.91, 0.93, 0.96, 1] });
        }
        this.batch.pushLine({ x1: cell.x + cell.width, y1: sy, x2: cell.x + cell.width, y2: sy + cell.height, thickness: 1, color: [0.91, 0.93, 0.96, 1] });
      }

      const gpu = this.surface.render([this.batch]);
      return { mode: this.mode, gpu, recordCount: records.length, mountedElements: mounted };
    }

    if (this.mode === "kanban") {
      const groupField = fields.find((f) => f.type === "select" || f.type === "multi_select") ?? fields[0];
      const grouped = this.base.query({ ...this.queryOptions, tableId: this.tableId, groupBy: groupField?.id });
      const groups = grouped.groups ?? [{ key: "all", label: "All", records }];
      const colW = 260;
      const gap = 16;
      const cardH = 72;
      const poolInputs: Array<{
        key: string;
        x: number;
        y: number;
        width: number;
        height: number;
        render: (el: T, newlyBound: boolean) => void;
      }> = [];

      groups.forEach((g, gIdx) => {
        const x = 16 + gIdx * (colW + gap) - this.scrollLeft;
        this.batch.pushRect({ x, y: 12, w: colW, h: this.height - 24, fill: [0.96, 0.97, 0.99, 1], radius: 8 });
        g.records.forEach((rec, rIdx) => {
          const cy = 48 + rIdx * (cardH + 10) - this.scrollTop;
          if (cy + cardH < 0 || cy > this.height) return;
          this.batch.pushRect({
            x: x + 10,
            y: cy,
            w: colW - 20,
            h: cardH,
            fill: [1, 1, 1, 1],
            radius: 6,
            borderWidth: 1,
            borderColor: [0.87, 0.9, 0.94, 1],
          });
          const primary = fields.find((f) => f.isPrimary) ?? fields[0];
          const label = primary ? formatCellText(rec.cells[String(primary.id)]) : `#${rec.id}`;
          poolInputs.push({
            key: `k:${rec.id}`,
            x: x + 18,
            y: cy + 10,
            width: colW - 36,
            height: cardH - 20,
            render: (el) => { el.textContent = `${label} [${g.label}]`; },
          });
        });
      });

      this.grid.pool.sync(poolInputs);
      const gpu = this.surface.render([this.batch]);
      return { mode: this.mode, gpu, recordCount: records.length, mountedElements: poolInputs.length };
    }

    if (this.mode === "gantt") {
      const dateField = fields.find((f) => f.type === "date");
      const primary = fields.find((f) => f.isPrimary) ?? fields[0];
      const rowH = 38;
      const poolInputs: Array<{
        key: string;
        x: number;
        y: number;
        width: number;
        height: number;
        render: (el: T, newlyBound: boolean) => void;
      }> = [];

      records.forEach((rec, idx) => {
        const y = 32 + idx * rowH - this.scrollTop;
        if (y + rowH < 0 || y > this.height) return;
        this.batch.pushLine({ x1: 0, y1: y + rowH, x2: this.width, y2: y + rowH, thickness: 1, color: [0.92, 0.94, 0.97, 1] });
        const dateStr = dateField ? formatCellText(rec.cells[String(dateField.id)]) : "";
        const dayOffset = dateStr ? (Date.parse(dateStr) / 86400000) % 30 : idx * 2;
        const barX = 180 + Math.max(0, dayOffset) * 18 - this.scrollLeft;
        const barW = 120;
        this.batch.pushRect({
          x: barX,
          y: y + 7,
          w: barW,
          h: rowH - 14,
          fill: [0.2, 0.44, 1, 0.88],
          radius: 5,
        });
        poolInputs.push({
          key: `g:${rec.id}`,
          x: 12,
          y: y + 8,
          width: 156,
          height: rowH - 12,
          render: (el) => { el.textContent = primary ? formatCellText(rec.cells[String(primary.id)]) : `#${rec.id}`; },
        });
      });

      this.grid.pool.sync(poolInputs);
      const gpu = this.surface.render([this.batch]);
      return { mode: this.mode, gpu, recordCount: records.length, mountedElements: poolInputs.length };
    }

    // Dashboard GPU mode
    const evaluated = this.base.evaluateDashboard(undefined, this.tableId);
    const cardW = 280;
    const cardH = 180;
    const colsPerRow = Math.max(1, Math.floor((this.width - 32) / (cardW + 16)));
    const poolInputs: Array<{
      key: string;
      x: number;
      y: number;
      width: number;
      height: number;
      render: (el: T, newlyBound: boolean) => void;
    }> = [];

    evaluated.forEach((item, idx) => {
      const col = idx % colsPerRow;
      const row = Math.floor(idx / colsPerRow);
      const x = 16 + col * (cardW + 16);
      const y = 16 + row * (cardH + 16) - this.scrollTop;
      this.batch.pushRect({
        x,
        y,
        w: cardW,
        h: cardH,
        fill: [1, 1, 1, 1],
        radius: 10,
        borderWidth: 1,
        borderColor: [0.87, 0.9, 0.94, 1],
      });

      if (item.series && item.series.buckets.length > 0) {
        if (item.widget.type === "pie") {
          let angle = 0;
          const total = item.series.totalValue || 1;
          item.series.buckets.forEach((b) => {
            const sweep = (Math.max(0, b.value) / total) * Math.PI * 2;
            this.batch.pushArc({
              cx: x + cardW / 2,
              cy: y + cardH * 0.58,
              rx: 52,
              ry: 52,
              innerRatio: 0.45,
              startAngle: angle,
              endAngle: angle + sweep,
              color: packColorRGBA(b.color),
            });
            angle += sweep;
          });
        } else {
          const maxV = Math.max(1, ...item.series.buckets.map((b) => Math.abs(b.value)));
          const bw = (cardW - 40) / item.series.buckets.length;
          item.series.buckets.forEach((b, bIdx) => {
            const bh = (Math.max(0, b.value) / maxV) * (cardH - 72);
            this.batch.pushRect({
              x: x + 20 + bIdx * bw + 3,
              y: y + cardH - 16 - bh,
              w: Math.max(4, bw - 6),
              h: Math.max(2, bh),
              fill: packColorRGBA(b.color),
              radius: 3,
            });
          });
        }
      }

      poolInputs.push({
        key: `d:${item.widget.id}`,
        x: x + 14,
        y: y + 12,
        width: cardW - 28,
        height: 40,
        render: (el) => {
          el.textContent = item.metric ? `${item.widget.title}: ${item.metric.headline}` : item.widget.title;
        },
      });
    });

    this.grid.pool.sync(poolInputs);
    const gpu = this.surface.render([this.batch]);
    return { mode: this.mode, gpu, recordCount: records.length, mountedElements: poolInputs.length };
  }

  dispose(): void {
    this.grid.pool.clear();
    this.surface.dispose();
  }
}

export interface MountedBaseView {
  controller: BaseViewController<HTMLElement>;
  resize(width: number, height: number): void;
  dispose(): void;
}

export async function mountBaseView(
  container: HTMLElement,
  base: Base,
  options: BaseViewOptions = {},
): Promise<MountedBaseView> {
  const doc = container.ownerDocument;
  container.style.position = "relative";
  container.style.overflow = "hidden";

  const canvas = doc.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.display = "block";
  container.appendChild(canvas);

  const textLayer = doc.createElement("div");
  textLayer.style.position = "absolute";
  textLayer.style.inset = "0";
  textLayer.style.pointerEvents = "none";
  container.appendChild(textLayer);

  const surface = await GpuSurface.create(canvas, options.gpu);
  const controller = new BaseViewController<HTMLElement>(
    base,
    surface,
    () => {
      const el = doc.createElement("div");
      el.style.boxSizing = "border-box";
      el.style.padding = "6px 8px";
      el.style.overflow = "hidden";
      el.style.whiteSpace = "nowrap";
      el.style.textOverflow = "ellipsis";
      el.style.fontSize = "13px";
      textLayer.appendChild(el);
      return el;
    },
    options,
  );

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    controller.scrollBy(e.deltaX, e.deltaY);
  };
  container.addEventListener("wheel", onWheel, { passive: false });

  controller.resize(container.clientWidth || 960, container.clientHeight || 560);
  controller.render();

  return {
    controller,
    resize(width: number, height: number) {
      controller.resize(width, height);
      controller.render();
    },
    dispose() {
      container.removeEventListener("wheel", onWheel);
      controller.dispose();
      canvas.remove();
      textLayer.remove();
    },
  };
}

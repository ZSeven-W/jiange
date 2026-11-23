import { useCallback, useEffect, useRef } from "react";
import {
  GpuSurface,
  InstanceBatch,
  type GpuBackendKind,
  type RgbaTuple as RGBA,
} from "@jiange/render-gpu";
import {
  pointKey,
  selected,
  selectionBounds,
  type SheetPoint,
  type SheetSelection,
} from "@jiange/sheet-sdk/grid";
import type { SheetWorksheet } from "@/lib/api";
import { colorFor } from "@/lib/presence";
import { cssColorToRGBA } from "@/components/gpu-canvas";
import { remoteCollaboratorBounds, type RemoteCollaborator } from "./sheet-collab";
import { evaluateSheetConditionalFormat, isSheetCellProtected } from "./sheet-rules";
import type { EvaluatedSheetMap, FormulaRefHighlight } from "./workbook-engine";

const COL_HEADER_BG: RGBA = [0.961, 0.965, 0.969, 1]; // #f5f6f7
const HEADER_ACTIVE_BG: RGBA = [0.914, 0.937, 1, 1]; // #e9efff
const HEADER_BORDER: RGBA = [0.871, 0.878, 0.89, 1]; // #dee0e3
const GRID_LINE: RGBA = [0.871, 0.878, 0.89, 1]; // #dee0e3 (Feishu crisp hairline)
const FREEZE_LINE: RGBA = [0.62, 0.718, 0.961, 1]; // #9eb7f5
const SEL_FILL: RGBA = [0.929, 0.953, 1, 1]; // #edf3ff
const FOCUS_BLUE: RGBA = [0.2, 0.439, 1, 1]; // #3370ff
const PROTECTED_BG: RGBA = [0.98, 0.984, 0.988, 1]; // #fafbfc
const WHITE: RGBA = [1, 1, 1, 1];

/** Snap a 1px CSS gridline coordinate to an exact pixel center (matches CSS border-r / border-b). */
function snapHairline(v: number): number {
  return Math.round(v) - 0.5;
}

export interface SheetGpuGridLayerProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  activeSheet: SheetWorksheet;
  visibleRows: readonly number[];
  colWidths: readonly number[];
  rowHeights: readonly number[];
  rowHeaderWidth: number;
  colHeaderHeight: number;
  zoom: number;
  selection: SheetSelection;
  gridCellByKey: ReadonlyMap<string, SheetWorksheet["cells"][number]>;
  activeEvalMap: EvaluatedSheetMap;
  formulaHighlights: readonly FormulaRefHighlight[];
  collaborators: readonly RemoteCollaborator[];
  userId: number;
  role: string;
  onBackendReady?: (backend: GpuBackendKind) => void;
}

/**
 * Hardware-accelerated WebGPU / WebGL2 SDF Grid Layer for Jiange Sheet.
 * Renders gridlines, cell & conditional fills, frozen pane dividers, headers,
 * selection ranges, dashed orange formula reference highlights, and remote
 * collaborator cursors directly on GPU with zero Canvas 2D usage.
 */
export function SheetGpuGridLayer(props: SheetGpuGridLayerProps) {
  const { scrollContainerRef, onBackendReady } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<GpuSurface | null>(null);
  const batchesRef = useRef<{
    body: InstanceBatch;
    frozenCol: InstanceBatch;
    frozenRow: InstanceBatch;
    chrome: InstanceBatch;
  } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const onBackendReadyRef = useRef(onBackendReady);
  onBackendReadyRef.current = onBackendReady;
  const rafRef = useRef<number | null>(null);
  const instanceIdRef = useRef(`sheet-grid:${Math.random().toString(36).slice(2, 8)}`);

  const drawFrame = useCallback(() => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    const scrollEl = scrollContainerRef.current;
    if (!surface || !canvas || !scrollEl) return;

    const p = propsRef.current;
    const viewW = Math.max(1, Math.floor(scrollEl.clientWidth));
    const viewH = Math.max(1, Math.floor(scrollEl.clientHeight));
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;
    surface.resize(viewW, viewH, dpr);
    surface.setClearColor(WHITE);

    if (!batchesRef.current) {
      batchesRef.current = {
        body: new InstanceBatch(2048, 2048, 64),
        frozenCol: new InstanceBatch(512, 512, 16),
        frozenRow: new InstanceBatch(512, 512, 16),
        chrome: new InstanceBatch(512, 512, 16),
      };
    }
    const { body, frozenCol, frozenRow, chrome } = batchesRef.current;
    body.reset();
    frozenCol.reset();
    frozenRow.reset();
    chrome.reset();

    const scale = Math.max(0.25, p.zoom / 100);
    const scrollLeft = scrollEl.scrollLeft;
    const scrollTop = scrollEl.scrollTop;
    const rhW = p.rowHeaderWidth * scale;
    const chH = p.colHeaderHeight * scale;

    // Precompute scaled column positions
    const colCount = p.activeSheet.columns.length;
    const colX = new Float64Array(colCount);
    const colW = new Float64Array(colCount);
    let cx = rhW;
    for (let c = 0; c < colCount; c++) {
      colX[c] = cx;
      const w = (p.colWidths[c] ?? 105) * scale;
      colW[c] = w;
      cx += w;
    }
    const totalW = cx;

    // Precompute scaled visible row positions
    const vCount = p.visibleRows.length;
    const visRowY = new Float64Array(vCount);
    const visRowH = new Float64Array(vCount);
    let ry = chH;
    for (let vi = 0; vi < vCount; vi++) {
      const rIdx = p.visibleRows[vi];
      visRowY[vi] = ry;
      const h = (p.rowHeights[rIdx] ?? 27) * scale;
      visRowH[vi] = h;
      ry += h;
    }
    const totalH = ry;

    const frozenCols = Math.min(colCount, Math.max(0, p.activeSheet.frozenCols));
    const frozenRows = Math.min(vCount, Math.max(0, p.activeSheet.frozenRows));
    const frozenRight = frozenCols > 0 ? colX[frozenCols - 1] + colW[frozenCols - 1] : rhW;
    const frozenBottom = frozenRows > 0 ? visRowY[frozenRows - 1] + visRowH[frozenRows - 1] : chH;

    // Configure hardware scissor rects
    body.scissor = {
      x: frozenRight,
      y: frozenBottom,
      w: Math.max(0, viewW - frozenRight),
      h: Math.max(0, viewH - frozenBottom),
    };
    frozenCol.scissor = {
      x: rhW,
      y: frozenBottom,
      w: Math.max(0, frozenRight - rhW),
      h: Math.max(0, viewH - frozenBottom),
    };
    frozenRow.scissor = {
      x: frozenRight,
      y: chH,
      w: Math.max(0, viewW - frozenRight),
      h: Math.max(0, frozenBottom - chH),
    };

    // Determine visible scrollable column range
    let cStart = frozenCols;
    while (cStart < colCount && colX[cStart] + colW[cStart] - scrollLeft < frozenRight) cStart++;
    let cEnd = cStart;
    while (cEnd < colCount && colX[cEnd] - scrollLeft < viewW) cEnd++;

    // Determine visible scrollable row range
    let vrStart = frozenRows;
    while (vrStart < vCount && visRowY[vrStart] + visRowH[vrStart] - scrollTop < frozenBottom) vrStart++;
    let vrEnd = vrStart;
    while (vrEnd < vCount && visRowY[vrEnd] - scrollTop < viewH) vrEnd++;

    const selB = selectionBounds(p.selection);
    const activePeers = p.collaborators
      .filter((c) => c.worksheetId === p.activeSheet.id)
      .map((c) => ({ collab: c, bounds: remoteCollaboratorBounds(c), color: cssColorToRGBA(colorFor(c.userId - 1)) }));

    const drawCellGeometry = (
      target: InstanceBatch,
      rowIdx: number,
      colIdx: number,
      x: number,
      y: number,
      w: number,
      h: number,
    ) => {
      const pt: SheetPoint = { row: rowIdx, col: colIdx };
      const key = pointKey(pt);
      const cell = p.gridCellByKey.get(key);
      const style = cell?.style ?? {};
      const ev = p.activeEvalMap[key];
      const condStyle = evaluateSheetConditionalFormat(cell?.raw ?? "", ev, p.activeSheet.conditionalFormats, rowIdx, colIdx);
      const protState = isSheetCellProtected(p.activeSheet.protectedRanges, rowIdx, colIdx, p.userId, p.role);
      const isSel = selected(p.selection, pt);
      const isFocus = p.selection.focus.row === rowIdx && p.selection.focus.col === colIdx;
      const refHighlight = p.formulaHighlights.find((fh) => rowIdx >= fh.top && rowIdx <= fh.bottom && colIdx >= fh.left && colIdx <= fh.right);
      const peerMatch = activePeers.find(({ bounds: rb }) => rowIdx >= rb.top && rowIdx <= rb.bottom && colIdx >= rb.left && colIdx <= rb.right);

      const effectiveBg = condStyle?.bg || style.bg;
      let fill: RGBA | null = null;
      if (refHighlight) {
        fill = cssColorToRGBA(refHighlight.color, 0.08);
      } else if (isSel && !isFocus) {
        fill = SEL_FILL;
      } else if (peerMatch && !effectiveBg) {
        fill = [peerMatch.color[0], peerMatch.color[1], peerMatch.color[2], 0.09];
      } else if (effectiveBg) {
        fill = cssColorToRGBA(effectiveBg);
      } else if (protState.blocked) {
        fill = PROTECTED_BG;
      }

      if (fill && fill[3] > 0) {
        target.pushRect({ x, y, w, h, fill });
      }

      // Custom cell borders
      if (style.borders) {
        const bc = cssColorToRGBA(style.borders.color || "#9aa0a6");
        if (style.borders.top) target.pushLine({ x1: x, y1: y + 0.5, x2: x + w, y2: y + 0.5, thickness: 1, color: bc });
        if (style.borders.bottom) target.pushLine({ x1: x, y1: y + h - 0.5, x2: x + w, y2: y + h - 0.5, thickness: 1, color: bc });
        if (style.borders.left) target.pushLine({ x1: x + 0.5, y1: y, x2: x + 0.5, y2: y + h, thickness: 1, color: bc });
        if (style.borders.right) target.pushLine({ x1: x + w - 0.5, y1: y, x2: x + w - 0.5, y2: y + h, thickness: 1, color: bc });
      }

      // Feishu-style dashed orange formula highlight perimeter
      if (refHighlight) {
        const rc = cssColorToRGBA(refHighlight.color);
        if (rowIdx === refHighlight.top) {
          target.pushLine({ x1: x, y1: y + 1, x2: x + w, y2: y + 1, thickness: 1.5, color: rc, dashLen: 5, gapLen: 3 });
        }
        if (rowIdx === refHighlight.bottom) {
          target.pushLine({ x1: x, y1: y + h - 1, x2: x + w, y2: y + h - 1, thickness: 1.5, color: rc, dashLen: 5, gapLen: 3 });
        }
        if (colIdx === refHighlight.left) {
          target.pushLine({ x1: x + 1, y1: y, x2: x + 1, y2: y + h, thickness: 1.5, color: rc, dashLen: 5, gapLen: 3 });
        }
        if (colIdx === refHighlight.right) {
          target.pushLine({ x1: x + w - 1, y1: y, x2: x + w - 1, y2: y + h, thickness: 1.5, color: rc, dashLen: 5, gapLen: 3 });
        }
      }

      // Selection perimeter & focus ring
      if (isSel) {
        if (rowIdx === selB.top) target.pushLine({ x1: x, y1: y + 1, x2: x + w, y2: y + 1, thickness: 2, color: FOCUS_BLUE });
        if (rowIdx === selB.bottom) target.pushLine({ x1: x, y1: y + h - 1, x2: x + w, y2: y + h - 1, thickness: 2, color: FOCUS_BLUE });
        if (colIdx === selB.left) target.pushLine({ x1: x + 1, y1: y, x2: x + 1, y2: y + h, thickness: 2, color: FOCUS_BLUE });
        if (colIdx === selB.right) target.pushLine({ x1: x + w - 1, y1: y, x2: x + w - 1, y2: y + h, thickness: 2, color: FOCUS_BLUE });
      }
      if (isFocus) {
        target.pushRect({
          x: x + 0.5,
          y: y + 0.5,
          w: Math.max(1, w - 1),
          h: Math.max(1, h - 1),
          fill: [0, 0, 0, 0],
          borderWidth: 2,
          borderColor: FOCUS_BLUE,
        });
      }
    };

    // 1. Body pane gridlines + cells
    const bodyMaxX = Math.min(viewW, totalW - scrollLeft);
    const bodyMaxY = Math.min(viewH, totalH - scrollTop);
    for (let c = cStart; c < cEnd; c++) {
      const gx = snapHairline(colX[c] + colW[c] - scrollLeft);
      body.pushLine({ x1: gx, y1: frozenBottom, x2: gx, y2: bodyMaxY, thickness: 1, color: GRID_LINE });
    }
    for (let vi = vrStart; vi < vrEnd; vi++) {
      const gy = snapHairline(visRowY[vi] + visRowH[vi] - scrollTop);
      body.pushLine({ x1: frozenRight, y1: gy, x2: bodyMaxX, y2: gy, thickness: 1, color: GRID_LINE });
    }
    for (let vi = vrStart; vi < vrEnd; vi++) {
      const rowIdx = p.visibleRows[vi];
      const y = visRowY[vi] - scrollTop;
      const h = visRowH[vi];
      for (let c = cStart; c < cEnd; c++) {
        drawCellGeometry(body, rowIdx, c, colX[c] - scrollLeft, y, colW[c], h);
      }
    }

    // 2. Frozen columns pane
    if (frozenCols > 0) {
      frozenCol.pushRect({ x: rhW, y: frozenBottom, w: frozenRight - rhW, h: Math.max(0, viewH - frozenBottom), fill: WHITE });
      for (let c = 0; c < frozenCols; c++) {
        const gx = snapHairline(colX[c] + colW[c]);
        frozenCol.pushLine({ x1: gx, y1: frozenBottom, x2: gx, y2: bodyMaxY, thickness: 1, color: GRID_LINE });
      }
      for (let vi = vrStart; vi < vrEnd; vi++) {
        const rowIdx = p.visibleRows[vi];
        const y = visRowY[vi] - scrollTop;
        const h = visRowH[vi];
        const gy = snapHairline(y + h);
        frozenCol.pushLine({ x1: rhW, y1: gy, x2: frozenRight, y2: gy, thickness: 1, color: GRID_LINE });
        for (let c = 0; c < frozenCols; c++) {
          drawCellGeometry(frozenCol, rowIdx, c, colX[c], y, colW[c], h);
        }
      }
    }

    // 3. Frozen rows pane
    if (frozenRows > 0) {
      frozenRow.pushRect({ x: frozenRight, y: chH, w: Math.max(0, viewW - frozenRight), h: frozenBottom - chH, fill: WHITE });
      for (let c = cStart; c < cEnd; c++) {
        const gx = snapHairline(colX[c] + colW[c] - scrollLeft);
        frozenRow.pushLine({ x1: gx, y1: chH, x2: gx, y2: frozenBottom, thickness: 1, color: GRID_LINE });
      }
      for (let vi = 0; vi < frozenRows; vi++) {
        const rowIdx = p.visibleRows[vi];
        const y = visRowY[vi];
        const h = visRowH[vi];
        const gy = snapHairline(y + h);
        frozenRow.pushLine({ x1: frozenRight, y1: gy, x2: bodyMaxX, y2: gy, thickness: 1, color: GRID_LINE });
        for (let c = cStart; c < cEnd; c++) {
          drawCellGeometry(frozenRow, rowIdx, c, colX[c] - scrollLeft, y, colW[c], h);
        }
      }
    }

    // 4. Chrome: Column headers, Row headers, Corner, Frozen corner cells & Divider lines
    if (frozenCols > 0 && frozenRows > 0) {
      chrome.pushRect({ x: rhW, y: chH, w: frozenRight - rhW, h: frozenBottom - chH, fill: WHITE });
      for (let vi = 0; vi < frozenRows; vi++) {
        const rowIdx = p.visibleRows[vi];
        const y = visRowY[vi];
        const h = visRowH[vi];
        chrome.pushLine({ x1: rhW, y1: y + h, x2: frozenRight, y2: y + h, thickness: 1, color: GRID_LINE });
        for (let c = 0; c < frozenCols; c++) {
          chrome.pushLine({ x1: colX[c] + colW[c], y1: chH, x2: colX[c] + colW[c], y2: frozenBottom, thickness: 1, color: GRID_LINE });
          drawCellGeometry(chrome, rowIdx, c, colX[c], y, colW[c], h);
        }
      }
    }

    // Column Header strip
    chrome.pushRect({ x: 0, y: 0, w: viewW, h: chH, fill: COL_HEADER_BG });
    for (let c = 0; c < frozenCols; c++) {
      if (p.selection.focus.col === c) {
        chrome.pushRect({ x: colX[c], y: 0, w: colW[c], h: chH, fill: HEADER_ACTIVE_BG });
      }
      chrome.pushLine({ x1: colX[c] + colW[c], y1: 0, x2: colX[c] + colW[c], y2: chH, thickness: 1, color: HEADER_BORDER });
    }
    for (let c = cStart; c < cEnd; c++) {
      const sx = colX[c] - scrollLeft;
      const clippedLeft = Math.max(frozenRight, sx);
      const clippedRight = Math.min(viewW, sx + colW[c]);
      if (clippedRight > clippedLeft) {
        if (p.selection.focus.col === c) {
          chrome.pushRect({ x: clippedLeft, y: 0, w: clippedRight - clippedLeft, h: chH, fill: HEADER_ACTIVE_BG });
        }
        chrome.pushLine({ x1: sx + colW[c], y1: 0, x2: sx + colW[c], y2: chH, thickness: 1, color: HEADER_BORDER });
      }
    }
    chrome.pushLine({ x1: 0, y1: chH - 0.5, x2: viewW, y2: chH - 0.5, thickness: 1, color: HEADER_BORDER });

    // Row Header strip
    chrome.pushRect({ x: 0, y: chH, w: rhW, h: Math.max(0, viewH - chH), fill: COL_HEADER_BG });
    for (let vi = 0; vi < frozenRows; vi++) {
      const rowIdx = p.visibleRows[vi];
      if (p.selection.focus.row === rowIdx) {
        chrome.pushRect({ x: 0, y: visRowY[vi], w: rhW, h: visRowH[vi], fill: HEADER_ACTIVE_BG });
      }
      chrome.pushLine({ x1: 0, y1: visRowY[vi] + visRowH[vi], x2: rhW, y2: visRowY[vi] + visRowH[vi], thickness: 1, color: HEADER_BORDER });
    }
    for (let vi = vrStart; vi < vrEnd; vi++) {
      const rowIdx = p.visibleRows[vi];
      const sy = visRowY[vi] - scrollTop;
      const clippedTop = Math.max(frozenBottom, sy);
      const clippedBot = Math.min(viewH, sy + visRowH[vi]);
      if (clippedBot > clippedTop) {
        if (p.selection.focus.row === rowIdx) {
          chrome.pushRect({ x: 0, y: clippedTop, w: rhW, h: clippedBot - clippedTop, fill: HEADER_ACTIVE_BG });
        }
        chrome.pushLine({ x1: 0, y1: sy + visRowH[vi], x2: rhW, y2: sy + visRowH[vi], thickness: 1, color: HEADER_BORDER });
      }
    }
    chrome.pushLine({ x1: rhW - 0.5, y1: 0, x2: rhW - 0.5, y2: viewH, thickness: 1, color: HEADER_BORDER });

    // Top-left select-all corner
    chrome.pushRect({ x: 0, y: 0, w: rhW, h: chH, fill: COL_HEADER_BG });
    chrome.pushLine({ x1: rhW - 0.5, y1: 0, x2: rhW - 0.5, y2: chH, thickness: 1, color: HEADER_BORDER });
    chrome.pushLine({ x1: 0, y1: chH - 0.5, x2: rhW, y2: chH - 0.5, thickness: 1, color: HEADER_BORDER });

    // Soft Feishu frozen pane dividers
    if (frozenCols > 0) {
      chrome.pushLine({ x1: frozenRight, y1: 0, x2: frozenRight, y2: viewH, thickness: 2, color: FREEZE_LINE });
    }
    if (frozenRows > 0) {
      chrome.pushLine({ x1: 0, y1: frozenBottom, x2: viewW, y2: frozenBottom, thickness: 2, color: FREEZE_LINE });
    }

    const batches: InstanceBatch[] = [body];
    if (frozenCols > 0) batches.push(frozenCol);
    if (frozenRows > 0) batches.push(frozenRow);
    batches.push(chrome);
    const stats = surface.render(batches);

    canvas.dataset.gpuBackend = stats.backend;
    canvas.dataset.gpuDraws = String(stats.drawCalls);
    const totalInstances = stats.rectInstances + stats.lineInstances + stats.arcInstances + stats.glyphInstances;
    canvas.dataset.gpuInstances = String(totalInstances);
    if (typeof window !== "undefined") {
      const store = (window.__JIANGE_GPU_STATUS__ ??= {});
      store[instanceIdRef.current] = {
        kind: "sheet-grid",
        backend: stats.backend,
        drawCalls: stats.drawCalls,
        instances: totalInstances,
        frameTimeMs: Number(stats.frameTimeMs.toFixed(3)),
        width: viewW,
        height: viewH,
        updatedAt: Date.now(),
      };
    }
  }, [scrollContainerRef]);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      drawFrame();
    });
  }, [drawFrame]);

  // Mount WebGPU / WebGL2 surface
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    const statusKey = instanceIdRef.current;

    void GpuSurface.create(canvas, { prefer: "webgpu" }).then((surface) => {
      if (!alive) {
        surface.dispose();
        return;
      }
      surfaceRef.current = surface;
      canvas.dataset.gpuBackend = surface.backendKind;
      onBackendReadyRef.current?.(surface.backendKind);
      drawFrame();
      scheduleDraw();
    });

    return () => {
      alive = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (typeof window !== "undefined" && window.__JIANGE_GPU_STATUS__) {
        delete window.__JIANGE_GPU_STATUS__[statusKey];
      }
      if (surfaceRef.current) {
        surfaceRef.current.dispose();
        surfaceRef.current = null;
      }
    };
  }, [drawFrame]);

  // Listen to native scroll & resize directly for 60-120fps WebGPU updates without React churn
  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl) return;
    const onScroll = () => drawFrame();
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(scheduleDraw);
      ro.observe(scrollEl);
    }
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, [scrollContainerRef, drawFrame, scheduleDraw]);

  // Repaint whenever sheet state updates
  useEffect(() => {
    drawFrame();
  }, [
    drawFrame,
    props.activeSheet,
    props.visibleRows,
    props.colWidths,
    props.rowHeights,
    props.zoom,
    props.selection,
    props.gridCellByKey,
    props.activeEvalMap,
    props.formulaHighlights,
    props.collaborators,
  ]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-jiange-gpu="sheet-grid"
      data-gpu-backend="init"
      className="pointer-events-none absolute left-0 top-0 z-0"
    />
  );
}

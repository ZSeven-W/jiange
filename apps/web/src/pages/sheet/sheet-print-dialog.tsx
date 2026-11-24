import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FileDown, Printer, RotateCcw, X } from "lucide-react";
import type { SheetCellStyle, SheetWorksheet } from "@/lib/api";
import { t } from "@/lib/i18n";
import { FeishuSelect } from "@/components/feishu-select";
import {
  buildMergeLookup,
  buildWorksheetGridMap,
  formatCellDisplay,
  type EvaluatedSheetMap,
} from "./workbook-engine";
import { formatSheetRectA1, type SheetRect } from "./sheet-rules";

export type SheetPrintRange = "sheet" | "selection";
export type SheetPrintOrientation = "landscape" | "portrait";
export type SheetPrintPaper = "a4" | "a3" | "letter";
export type SheetPrintFitScale = "fit-width" | "actual";

export interface SheetPrintSettings {
  range: SheetPrintRange;
  orientation: SheetPrintOrientation;
  paper: SheetPrintPaper;
  fitScale: SheetPrintFitScale;
  showGridlines: boolean;
  repeatHeaderRow: boolean;
}

export const DEFAULT_SHEET_PRINT_SETTINGS: SheetPrintSettings = {
  range: "sheet",
  orientation: "landscape",
  paper: "a4",
  fitScale: "fit-width",
  showGridlines: true,
  repeatHeaderRow: true,
};

const PAPER_CSS: Record<SheetPrintPaper, string> = {
  a4: "A4",
  a3: "A3",
  letter: "Letter",
};

const MAX_PRINT_ROWS = 500;
const MAX_PRINT_COLS = 50;

export interface PrintableCell {
  colIdx: number;
  text: string;
  style: SheetCellStyle;
  rowSpan: number;
  colSpan: number;
}

export interface PrintableRow {
  rowIdx: number;
  cells: PrintableCell[];
}

export interface PrintableSheetGrid {
  bounds: SheetRect;
  rows: PrintableRow[];
  colCount: number;
  truncated: boolean;
}

function hasVisibleStyle(style?: SheetCellStyle): boolean {
  if (!style) return false;
  return !!(
    style.bg ||
    (style.borders && (style.borders.top || style.borders.right || style.borders.bottom || style.borders.left))
  );
}

export function resolvePrintableBounds(
  sheet: SheetWorksheet,
  selectionRect: SheetRect,
  range: SheetPrintRange,
): { bounds: SheetRect; truncated: boolean } {
  const maxRowIdx = Math.max(0, sheet.rows.length - 1);
  const maxColIdx = Math.max(0, sheet.columns.length - 1);

  let top = 0;
  let left = 0;
  let bottom = 0;
  let right = 0;

  if (range === "selection") {
    top = Math.max(0, Math.min(maxRowIdx, selectionRect.top));
    bottom = Math.max(top, Math.min(maxRowIdx, selectionRect.bottom));
    left = Math.max(0, Math.min(maxColIdx, selectionRect.left));
    right = Math.max(left, Math.min(maxColIdx, selectionRect.right));
  } else {
    const { rowPosById, colPosById } = buildWorksheetGridMap(sheet);
    let found = false;
    for (const cell of sheet.cells) {
      if (!cell.raw && !hasVisibleStyle(cell.style)) continue;
      const r = rowPosById.get(cell.rowId);
      const c = colPosById.get(cell.columnId);
      if (r === undefined || c === undefined) continue;
      if (!found) {
        bottom = r;
        right = c;
        found = true;
      } else {
        if (r > bottom) bottom = r;
        if (c > right) right = c;
      }
    }
    for (const m of sheet.merges ?? []) {
      if (m.bottom <= maxRowIdx && m.right <= maxColIdx) {
        if (!found) {
          bottom = m.bottom;
          right = m.right;
          found = true;
        } else {
          if (m.bottom > bottom) bottom = m.bottom;
          if (m.right > right) right = m.right;
        }
      }
    }
    if (!found) {
      bottom = Math.min(maxRowIdx, 4);
      right = Math.min(maxColIdx, 3);
    }
  }

  let truncated = false;
  if (bottom - top + 1 > MAX_PRINT_ROWS) {
    bottom = top + MAX_PRINT_ROWS - 1;
    truncated = true;
  }
  if (right - left + 1 > MAX_PRINT_COLS) {
    right = left + MAX_PRINT_COLS - 1;
    truncated = true;
  }
  return { bounds: { top, left, bottom, right }, truncated };
}

export function buildPrintableSheetGrid(
  sheet: SheetWorksheet,
  evalMap: EvaluatedSheetMap,
  selectionRect: SheetRect,
  range: SheetPrintRange,
): PrintableSheetGrid {
  const { bounds, truncated } = resolvePrintableBounds(sheet, selectionRect, range);
  const { cellByKey } = buildWorksheetGridMap(sheet);
  const mergeLookup = buildMergeLookup(sheet.merges ?? []);
  const rows: PrintableRow[] = [];

  for (let r = bounds.top; r <= bounds.bottom; r++) {
    const rowCells: PrintableCell[] = [];
    for (let c = bounds.left; c <= bounds.right; c++) {
      const mInfo = mergeLookup.get(`${r}:${c}`);
      if (mInfo?.kind === "covered" && mInfo.masterRow >= bounds.top && mInfo.masterCol >= bounds.left) {
        continue;
      }
      const cell = cellByKey.get(`${r}:${c}`);
      const ev = evalMap[`${r}:${c}`];
      const text = formatCellDisplay(cell?.raw ?? "", ev, cell?.style);
      const rowSpan = mInfo?.kind === "master" ? Math.min(mInfo.rowSpan, bounds.bottom - r + 1) : 1;
      const colSpan = mInfo?.kind === "master" ? Math.min(mInfo.colSpan, bounds.right - c + 1) : 1;
      rowCells.push({
        colIdx: c,
        text,
        style: cell?.style ?? {},
        rowSpan,
        colSpan,
      });
    }
    rows.push({ rowIdx: r, cells: rowCells });
  }

  return {
    bounds,
    rows,
    colCount: bounds.right - bounds.left + 1,
    truncated,
  };
}

/** Generates standards-compliant @page and @media print CSS for spreadsheet PDF export. */
export function buildSheetPrintCss(settings: SheetPrintSettings): string {
  const pageSize = `${PAPER_CSS[settings.paper]} ${settings.orientation}`;
  const tableWidthCss = settings.fitScale === "fit-width" ? "width: 100%; table-layout: auto;" : "width: auto; table-layout: auto;";
  const gridBorderCss = settings.showGridlines
    ? "border: 1px solid #d0d3d6;"
    : "border: none;";
  const headerGroupCss = settings.repeatHeaderRow
    ? "[data-sheet-print-root] thead { display: table-header-group; }"
    : "";

  return [
    `@page { size: ${pageSize}; margin: 12mm; }`,
    `[data-sheet-print-root] { display: none; }`,
    `@media print {`,
    `  html, body { background: #ffffff !important; height: auto !important; overflow: visible !important; }`,
    `  body > *:not([data-sheet-print-root]) { display: none !important; }`,
    `  [data-sheet-print-root] { display: block !important; width: 100%; color: #1f2329; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }`,
    `  [data-sheet-print-root] .sheet-print-title { font-size: 14px; font-weight: 600; margin: 0 0 8px 0; color: #1f2329; }`,
    `  [data-sheet-print-root] table { ${tableWidthCss} border-collapse: collapse; font-size: 11px; }`,
    `  [data-sheet-print-root] th, [data-sheet-print-root] td { ${gridBorderCss} padding: 4px 6px; vertical-align: middle; word-break: break-word; }`,
    `  [data-sheet-print-root] tr { break-inside: avoid; page-break-inside: avoid; }`,
    `  ${headerGroupCss}`,
    `}`,
  ].join("\n");
}

export function applySheetPrintStyle(settings: SheetPrintSettings, doc: Document = document): () => void {
  const existing = doc.head.querySelectorAll("style[data-sheet-print-style]");
  for (const node of existing) node.remove();
  const style = doc.createElement("style");
  style.setAttribute("data-sheet-print-style", "1");
  style.textContent = buildSheetPrintCss(settings);
  doc.head.appendChild(style);
  return () => {
    style.remove();
  };
}

function previewAspectClass(paper: SheetPrintPaper, orientation: SheetPrintOrientation): string {
  if (paper === "letter") {
    return orientation === "landscape" ? "aspect-[279/216] max-w-[400px]" : "aspect-[216/279] max-w-[270px]";
  }
  if (paper === "a3") {
    return orientation === "landscape" ? "aspect-[420/297] max-w-[420px]" : "aspect-[297/420] max-w-[280px]";
  }
  return orientation === "landscape" ? "aspect-[297/210] max-w-[400px]" : "aspect-[210/297] max-w-[270px]";
}

function cellInlineStyle(style: SheetCellStyle): React.CSSProperties {
  return {
    fontWeight: style.bold ? 600 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: [style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
    color: style.color || undefined,
    backgroundColor: style.bg || undefined,
    textAlign: style.align || undefined,
  };
}

export interface SheetPrintDialogProps {
  workbookTitle: string;
  sheet: SheetWorksheet;
  evalMap: EvaluatedSheetMap;
  selectionRect: SheetRect;
  onClose: () => void;
  onPrint?: () => void;
}

export function SheetPrintDialog({
  workbookTitle,
  sheet,
  evalMap,
  selectionRect,
  onClose,
  onPrint,
}: SheetPrintDialogProps) {
  const [settings, setSettings] = useState<SheetPrintSettings>(DEFAULT_SHEET_PRINT_SETTINGS);
  const [printingActive, setPrintingActive] = useState(false);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const printable = useMemo(
    () => buildPrintableSheetGrid(sheet, evalMap, selectionRect, settings.range),
    [sheet, evalMap, selectionRect, settings.range],
  );

  const selectionAddr = formatSheetRectA1(selectionRect);
  const printBoundsAddr = formatSheetRectA1(printable.bounds);
  const displayTitle = workbookTitle.trim() || t("未命名表格");

  const previewMaxRows = settings.orientation === "landscape" ? 10 : 14;
  const previewMaxCols = settings.fitScale === "fit-width" ? 10 : 7;
  const previewRows = printable.rows.slice(0, previewMaxRows);

  const update = (patch: Partial<SheetPrintSettings>) =>
    setSettings((prev) => ({ ...prev, ...patch }));

  const handleConfirmPrint = () => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const cleanupStyle = applySheetPrintStyle(settings, document);
    setPrintingActive(true);
    onPrint?.();

    let cleaned = false;
    const cleanupAll = () => {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener("afterprint", cleanupAll);
      cleanupStyle();
      setPrintingActive(false);
    };
    window.addEventListener("afterprint", cleanupAll);
    window.requestAnimationFrame(() => {
      try {
        window.print();
      } finally {
        window.setTimeout(cleanupAll, 1500);
      }
    });
  };

  const headRow = settings.repeatHeaderRow && printable.rows.length > 0 ? printable.rows[0] : null;
  const bodyRows = headRow ? printable.rows.slice(1) : printable.rows;

  const printPortal =
    printingActive && typeof document !== "undefined"
      ? createPortal(
          <div data-sheet-print-root aria-hidden="true">
            <h1 className="sheet-print-title">
              {displayTitle} — {sheet.title} ({printBoundsAddr})
            </h1>
            <table>
              {headRow && (
                <thead>
                  <tr>
                    {headRow.cells.map((cell) => (
                      <th
                        key={cell.colIdx}
                        rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                        colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                        style={{ fontWeight: 600, backgroundColor: "#f7f8fa", ...cellInlineStyle(cell.style) }}
                      >
                        {cell.text}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {bodyRows.map((row) => (
                  <tr key={row.rowIdx}>
                    {row.cells.map((cell) => (
                      <td
                        key={cell.colIdx}
                        rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                        colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                        style={cellInlineStyle(cell.style)}
                      >
                        {cell.text}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label={t("打印 / 导出 PDF")}
        data-sheet-print-dialog
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div className="flex max-h-[92dvh] w-full max-w-[820px] flex-col overflow-hidden rounded-xl border border-[#dee0e3] bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-[#e5e6eb] px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Printer className="size-4 text-[#3370ff]" />
              <h2 className="text-[15px] font-semibold text-[#1f2329]">{t("打印 / 导出 PDF")}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("关闭打印设置")}
              data-sheet-print-close
              className="grid size-7 place-items-center rounded-md text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[300px_1fr]">
            {/* Left controls (ZERO native <select>) */}
            <div className="space-y-3.5 border-b border-[#e5e6eb] p-5 md:border-b-0 md:border-r">
              <div className="grid gap-1.5">
                <span className="text-[12px] font-medium text-[#646a73]">{t("打印范围")}</span>
                <FeishuSelect
                  ariaLabel={t("打印范围")}
                  dataAttr={{ "data-sheet-print-range": true }}
                  value={settings.range}
                  options={[
                    { value: "sheet", label: t("当前工作表") },
                    { value: "selection", label: `${t("选中区域")} (${selectionAddr})` },
                  ]}
                  onChange={(val) => update({ range: val as SheetPrintRange })}
                  className="h-9 w-full border border-[#dee0e3] bg-white px-2.5 text-[13px]"
                  menuMinWidth={220}
                />
              </div>

              <div className="grid gap-1.5">
                <span className="text-[12px] font-medium text-[#646a73]">{t("页面方向")}</span>
                <FeishuSelect
                  ariaLabel={t("页面方向")}
                  dataAttr={{ "data-sheet-print-orientation": true }}
                  value={settings.orientation}
                  options={[
                    { value: "landscape", label: t("横向") },
                    { value: "portrait", label: t("纵向") },
                  ]}
                  onChange={(val) => update({ orientation: val as SheetPrintOrientation })}
                  className="h-9 w-full border border-[#dee0e3] bg-white px-2.5 text-[13px]"
                  menuMinWidth={180}
                />
              </div>

              <div className="grid gap-1.5">
                <span className="text-[12px] font-medium text-[#646a73]">{t("纸张大小")}</span>
                <FeishuSelect
                  ariaLabel={t("纸张大小")}
                  dataAttr={{ "data-sheet-print-paper": true }}
                  value={settings.paper}
                  options={[
                    { value: "a4", label: "A4 (210×297 mm)" },
                    { value: "a3", label: "A3 (297×420 mm)" },
                    { value: "letter", label: "Letter (216×279 mm)" },
                  ]}
                  onChange={(val) => update({ paper: val as SheetPrintPaper })}
                  className="h-9 w-full border border-[#dee0e3] bg-white px-2.5 text-[13px]"
                  menuMinWidth={200}
                />
              </div>

              <div className="grid gap-1.5">
                <span className="text-[12px] font-medium text-[#646a73]">{t("缩放比例")}</span>
                <FeishuSelect
                  ariaLabel={t("缩放比例")}
                  dataAttr={{ "data-sheet-print-scale": true }}
                  value={settings.fitScale}
                  options={[
                    { value: "fit-width", label: t("适应单页宽度") },
                    { value: "actual", label: t("实际大小") },
                  ]}
                  onChange={(val) => update({ fitScale: val as SheetPrintFitScale })}
                  className="h-9 w-full border border-[#dee0e3] bg-white px-2.5 text-[13px]"
                  menuMinWidth={200}
                />
              </div>

              <div className="space-y-2.5 border-t border-[#e5e6eb] pt-3.5">
                <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[#1f2329]">
                  <input
                    type="checkbox"
                    data-sheet-print-gridlines
                    checked={settings.showGridlines}
                    onChange={(e) => update({ showGridlines: e.target.checked })}
                    className="size-4 rounded border-[#c9cdd4] accent-[#3370ff]"
                  />
                  <span>{t("显示网格线")}</span>
                </label>

                <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[#1f2329]">
                  <input
                    type="checkbox"
                    data-sheet-print-repeat-header
                    checked={settings.repeatHeaderRow}
                    onChange={(e) => update({ repeatHeaderRow: e.target.checked })}
                    className="size-4 rounded border-[#c9cdd4] accent-[#3370ff]"
                  />
                  <span>{t("每页重复打印首行标题")}</span>
                </label>
              </div>
            </div>

            {/* Right: live scaled preview */}
            <div className="flex flex-col items-center justify-between gap-4 bg-[#f5f6f7] p-5" data-sheet-print-preview>
              <div className="flex w-full items-center justify-between text-[12px] text-[#646a73]">
                <span>{t("表格版式预览")}</span>
                <span>
                  {PAPER_CSS[settings.paper]} · {settings.orientation === "landscape" ? t("横向") : t("纵向")} ·{" "}
                  {printBoundsAddr}
                </span>
              </div>

              <div
                data-sheet-print-preview-sheet
                className={`flex w-full flex-col overflow-hidden rounded border border-[#dee0e3] bg-white p-3.5 text-[#1f2329] shadow-md ${previewAspectClass(settings.paper, settings.orientation)}`}
              >
                <div className="mb-2 flex items-center justify-between gap-2 border-b border-[#eff0f1] pb-1">
                  <span className="truncate text-[11px] font-semibold text-[#1f2329]">
                    {displayTitle} · {sheet.title}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-[#8f959e]">
                    {settings.fitScale === "fit-width" ? t("适应单页宽度") : t("实际大小")}
                  </span>
                </div>

                <div className="min-h-0 flex-1 overflow-hidden">
                  <table
                    className={`border-collapse text-[8.5px] leading-tight ${
                      settings.fitScale === "fit-width" ? "w-full table-fixed" : "w-auto"
                    }`}
                  >
                    <tbody>
                      {previewRows.map((row, rIdx) => {
                        const isHeader = settings.repeatHeaderRow && rIdx === 0;
                        return (
                          <tr key={row.rowIdx}>
                            {row.cells.slice(0, previewMaxCols).map((cell) => (
                              <td
                                key={cell.colIdx}
                                rowSpan={cell.rowSpan > 1 ? Math.min(cell.rowSpan, previewRows.length - rIdx) : undefined}
                                colSpan={cell.colSpan > 1 ? Math.min(cell.colSpan, previewMaxCols) : undefined}
                                style={{
                                  backgroundColor: isHeader ? "#f5f7fa" : undefined,
                                  fontWeight: isHeader ? 600 : undefined,
                                  ...cellInlineStyle(cell.style),
                                }}
                                className={`truncate px-1 py-0.5 ${
                                  settings.showGridlines ? "border border-[#dee0e3]" : ""
                                }`}
                              >
                                {cell.text || "\u00a0"}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {(printable.rows.length > previewMaxRows || printable.colCount > previewMaxCols) && (
                    <div className="mt-1.5 text-right text-[9px] text-[#8f959e]">
                      {t("共 {rows} 行 × {cols} 列（预览仅展示前部内容）", {
                        rows: printable.rows.length,
                        cols: printable.colCount,
                      })}
                    </div>
                  )}
                </div>
              </div>

              <p className="w-full rounded-md bg-white/85 px-3 py-2 text-[11px] leading-relaxed text-[#646a73]">
                {t("提示：点击「打印 / 导出 PDF」后，在系统打印弹窗中选择「另存为 PDF」即可输出高清矢量分页文档。")}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#e5e6eb] px-5 py-3">
            <button
              type="button"
              onClick={() => setSettings(DEFAULT_SHEET_PRINT_SETTINGS)}
              data-sheet-print-reset
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
            >
              <RotateCcw className="size-3.5" />
              <span>{t("重置默认")}</span>
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-[#dee0e3] px-3.5 py-1.5 text-[13px] text-[#1f2329] hover:bg-[#f2f3f5]"
              >
                {t("取消")}
              </button>
              <button
                type="button"
                onClick={handleConfirmPrint}
                data-sheet-print-confirm
                className="inline-flex items-center gap-1.5 rounded-md bg-[#1456f0] px-4 py-1.5 text-[13px] font-medium text-white hover:bg-[#0f4dd6]"
              >
                <FileDown className="size-4" />
                <span>{t("打印 / 导出 PDF")}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      {printPortal}
    </>
  );
}

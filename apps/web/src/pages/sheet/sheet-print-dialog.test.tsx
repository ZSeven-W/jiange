import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SheetWorksheet } from "@/lib/api";
import { calculateWorkbook } from "./workbook-engine";
import {
  buildPrintableSheetGrid,
  buildSheetPrintCss,
  DEFAULT_SHEET_PRINT_SETTINGS,
  SheetPrintDialog,
} from "./sheet-print-dialog";
import { clampChartBounds } from "./sheet-chart-overlay";

function makeSampleSheet(): SheetWorksheet {
  return {
    id: 11,
    nodeId: 7,
    title: "利润表",
    pos: 0,
    frozenRows: 1,
    frozenCols: 0,
    merges: [{ top: 0, left: 0, bottom: 0, right: 1 }],
    filter: {},
    revision: 1,
    rows: [
      { id: 1, pos: 0 },
      { id: 2, pos: 1 },
      { id: 3, pos: 2 },
      { id: 4, pos: 3 },
    ],
    columns: [
      { id: 101, pos: 0 },
      { id: 102, pos: 1 },
      { id: 103, pos: 2 },
    ],
    cells: [
      { rowId: 1, columnId: 101, raw: "Q4 汇总", style: { bold: true }, revision: 1 },
      { rowId: 1, columnId: 103, raw: "金额", style: { bold: true }, revision: 1 },
      { rowId: 2, columnId: 101, raw: "华东", style: {}, revision: 1 },
      { rowId: 2, columnId: 102, raw: "100", style: {}, revision: 1 },
      { rowId: 2, columnId: 103, raw: "=B2*2", style: { numFmt: "currency" }, revision: 1 },
    ],
  };
}

describe("SheetPrintDialog", () => {
  it("renders Feishu-style print dialog with FeishuSelect controls, zero native <select>, checkboxes, and live table preview", () => {
    const ws = makeSampleSheet();
    const evalMap = calculateWorkbook([ws]).get(ws.id) ?? {};

    const html = renderToStaticMarkup(
      <SheetPrintDialog
        workbookTitle="年度经营报表"
        sheet={ws}
        evalMap={evalMap}
        selectionRect={{ top: 0, left: 0, bottom: 1, right: 2 }}
        onClose={() => {}}
      />,
    );

    expect(html).toContain("data-sheet-print-dialog");
    expect(html).toContain("data-sheet-print-range");
    expect(html).toContain("data-sheet-print-orientation");
    expect(html).toContain("data-sheet-print-paper");
    expect(html).toContain("data-sheet-print-scale");
    expect(html).toContain("data-sheet-print-gridlines");
    expect(html).toContain("data-sheet-print-repeat-header");
    expect(html).toContain("data-sheet-print-confirm");
    expect(html).toContain("data-sheet-print-preview-sheet");
    expect(html).not.toContain("<select");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("年度经营报表");
    expect(html).toContain("Q4 汇总");
    expect(html).toContain("¥200.00");
    expect(html).toContain("显示网格线");
    expect(html).toContain("每页重复打印首行标题");
  });

  it("extracts printable grid honoring merges, formulas, and selection range", () => {
    const ws = makeSampleSheet();
    const evalMap = calculateWorkbook([ws]).get(ws.id) ?? {};

    const full = buildPrintableSheetGrid(ws, evalMap, { top: 1, left: 0, bottom: 1, right: 2 }, "sheet");
    expect(full.bounds).toEqual({ top: 0, left: 0, bottom: 1, right: 2 });
    // Row 0 has A1:B1 merged (colSpan=2) + C1 => 2 cells total.
    expect(full.rows[0].cells).toHaveLength(2);
    expect(full.rows[0].cells[0]).toMatchObject({ text: "Q4 汇总", colSpan: 2, rowSpan: 1 });
    expect(full.rows[1].cells[2].text).toBe("¥200.00");

    const selOnly = buildPrintableSheetGrid(ws, evalMap, { top: 1, left: 0, bottom: 1, right: 1 }, "selection");
    expect(selOnly.bounds).toEqual({ top: 1, left: 0, bottom: 1, right: 1 });
    expect(selOnly.rows).toHaveLength(1);
    expect(selOnly.rows[0].cells.map((c) => c.text)).toEqual(["华东", "100"]);
  });

  it("generates dynamic @page and @media print CSS matching paper, orientation, gridlines, and header repetition", () => {
    const landscapeA3 = buildSheetPrintCss({
      ...DEFAULT_SHEET_PRINT_SETTINGS,
      paper: "a3",
      orientation: "landscape",
      fitScale: "fit-width",
      showGridlines: true,
      repeatHeaderRow: true,
    });
    expect(landscapeA3).toContain("@page { size: A3 landscape; margin: 12mm; }");
    expect(landscapeA3).toContain("width: 100%;");
    expect(landscapeA3).toContain("border: 1px solid #d0d3d6;");
    expect(landscapeA3).toContain("display: table-header-group;");

    const portraitLetter = buildSheetPrintCss({
      ...DEFAULT_SHEET_PRINT_SETTINGS,
      paper: "letter",
      orientation: "portrait",
      fitScale: "actual",
      showGridlines: false,
      repeatHeaderRow: false,
    });
    expect(portraitLetter).toContain("@page { size: Letter portrait; margin: 12mm; }");
    expect(portraitLetter).toContain("width: auto;");
    expect(portraitLetter).toContain("border: none;");
    expect(portraitLetter).not.toContain("display: table-header-group;");
  });
});

describe("clampChartBounds (mobile overflow protection)", () => {
  it("clamps wide/right-offset charts strictly within 390px mobile viewport", () => {
    const clamped = clampChartBounds({ x: 320, width: 460 }, 390);
    expect(clamped.width).toBe(366);
    expect(clamped.left).toBe(16);
    expect(clamped.left + clamped.width).toBeLessThanOrEqual(390);
  });

  it("clamps charts on very narrow 320px viewports without breaking minimum readable width", () => {
    const clamped = clampChartBounds({ x: 180, width: 420 }, 320);
    expect(clamped.width).toBe(296);
    expect(clamped.left).toBe(16);
    expect(clamped.left + clamped.width).toBeLessThanOrEqual(320);
  });

  it("preserves original chart coordinates on desktop viewports", () => {
    const desktop = clampChartBounds({ x: 240, width: 460 }, 1440);
    expect(desktop).toEqual({ left: 240, width: 460 });
  });
});

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { computeSheetSelectionStats, formatSheetStatNumber } from "./sheet-selection-stats";
import { SheetSelectionStatsBar } from "./sheet-selection-stats-bar";

describe("sheet selection stats", () => {
  it("computes sum, avg, count, numericCount, min, and max cleanly with floating-point precision", () => {
    const stats = computeSheetSelectionStats(
      { top: 0, bottom: 1, left: 0, right: 2 },
      {
        "0:0": { kind: "number", value: 0.1 },
        "0:1": { kind: "number", value: 0.2 },
        "0:2": { kind: "string", value: "项目A" },
        "1:0": { kind: "number", value: 10 },
        "1:1": { kind: "empty" },
      },
      (r, c) => (r === 1 && c === 2 ? "备注" : undefined),
    );
    expect(stats).toEqual({
      totalCells: 6,
      count: 5,
      numericCount: 3,
      sum: 10.3,
      avg: Number((10.3 / 3).toPrecision(12)),
      min: 0.1,
      max: 10,
    });
    expect(formatSheetStatNumber(35500)).toBe("35,500");
    expect(formatSheetStatNumber(null)).toBe("—");
  });

  it("supports text-only multi-cell selections with count while keeping numeric stats null", () => {
    const stats = computeSheetSelectionStats(
      { top: 0, bottom: 0, left: 0, right: 2 },
      {
        "0:0": { kind: "string", value: "一月" },
        "0:1": { kind: "string", value: "二月" },
      },
    );
    expect(stats).toEqual({
      totalCells: 3,
      count: 2,
      numericCount: 0,
      sum: null,
      avg: null,
      min: null,
      max: null,
    });
  });

  it("returns null for single-cell or all-empty ranges", () => {
    expect(computeSheetSelectionStats({ top: 0, bottom: 0, left: 0, right: 0 }, { "0:0": { kind: "number", value: 42 } })).toBeNull();
    expect(computeSheetSelectionStats({ top: 0, bottom: 1, left: 0, right: 1 }, { "0:0": { kind: "empty" } })).toBeNull();
  });

  it("renders Feishu inline aggregation pills with data-sheet-aggregates", () => {
    const html = renderToStaticMarkup(
      <SheetSelectionStatsBar
        stats={{ totalCells: 3, count: 3, numericCount: 3, sum: 60, avg: 20, min: 10, max: 30 }}
      />,
    );
    expect(html).toContain("data-sheet-aggregates");
    expect(html).toContain("求和");
    expect(html).toContain("60");
    expect(html).toContain("平均值");
    expect(html).toContain("20");
    expect(html).toContain("计数");
  });
});

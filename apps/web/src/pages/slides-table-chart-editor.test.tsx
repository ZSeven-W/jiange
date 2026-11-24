import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SlideShape } from "@/lib/api";
import {
  addTableCol,
  addTableRow,
  createDefaultSlideChart,
  createDefaultSlideTable,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  removeTableCol,
  removeTableRow,
  SlideChartEditor,
  SlideChartSvg,
  SlideElementAnimationControls,
  SlideTableEditor,
  updateTableCell,
} from "./slides-table-chart-editor";

describe("slides table, chart, and element animation editors", () => {
  it("renders crisp vector SVG for bar, line, and pie charts with labels and legend", () => {
    const base = createDefaultSlideChart();
    const barHtml = renderToStaticMarkup(<SlideChartSvg chart={base} />);
    expect(barHtml).toContain("data-slide-chart-svg");
    expect(barHtml).toContain('data-chart-type="bar"');
    expect(barHtml).toContain("季度业绩概览");
    expect(barHtml).toContain("Q1");
    expect(barHtml).toContain("Q3");
    expect(barHtml).toContain("118");
    expect(barHtml).toContain("data-slide-chart-legend");
    expect(barHtml).toContain("#3370ff");

    const lineHtml = renderToStaticMarkup(
      <SlideChartSvg chart={{ ...base, type: "line" }} />,
    );
    expect(lineHtml).toContain('data-chart-type="line"');
    expect(lineHtml).toContain("<polyline");
    expect(lineHtml).toContain("<circle");

    const pieHtml = renderToStaticMarkup(
      <SlideChartSvg chart={{ ...base, type: "pie" }} />,
    );
    expect(pieHtml).toContain('data-chart-type="pie"');
    expect(pieHtml).toContain("<path");
    expect(pieHtml).toContain("%");

    const zeroPieHtml = renderToStaticMarkup(
      <SlideChartSvg
        chart={{ type: "pie", title: "空饼图", categories: ["A"], series: [{ name: "S", values: [0] }] }}
      />,
    );
    expect(zeroPieHtml).toContain("暂无数据");
  });

  it("enforces table row/col bounds (1x1..12x8) and updates cells cleanly", () => {
    let tbl = createDefaultSlideTable();
    expect(tbl.rows).toHaveLength(3);
    expect(tbl.rows[0]).toHaveLength(3);

    tbl = updateTableCell(tbl, 1, 2, "已上线");
    expect(tbl.rows[1][2]).toBe("已上线");

    tbl = addTableRow(tbl);
    expect(tbl.rows).toHaveLength(4);
    tbl = addTableCol(tbl);
    expect(tbl.rows[0]).toHaveLength(4);

    // Grow to max bounds
    for (let i = 0; i < 20; i++) {
      tbl = addTableRow(tbl);
      tbl = addTableCol(tbl);
    }
    expect(tbl.rows).toHaveLength(MAX_TABLE_ROWS);
    expect(tbl.rows[0]).toHaveLength(MAX_TABLE_COLS);

    // Shrink to min bounds (1x1)
    for (let i = 0; i < 20; i++) {
      tbl = removeTableRow(tbl);
      tbl = removeTableCol(tbl);
    }
    expect(tbl.rows).toHaveLength(1);
    expect(tbl.rows[0]).toHaveLength(1);
  });

  it("renders SlideTableEditor, SlideChartEditor, and SlideElementAnimationControls without native <select>", () => {
    const tableShape: SlideShape = {
      id: "tbl-1",
      kind: "table",
      x: 10,
      y: 20,
      width: 60,
      height: 40,
      color: "#3370ff",
      table: createDefaultSlideTable(),
    };
    const chartShape: SlideShape = {
      id: "cht-1",
      kind: "chart",
      x: 15,
      y: 25,
      width: 55,
      height: 45,
      color: "#3370ff",
      chart: createDefaultSlideChart(),
    };

    const tableHtml = renderToStaticMarkup(
      <SlideTableEditor shape={tableShape} canEdit onChange={() => {}} />,
    );
    expect(tableHtml).toContain("data-slide-table-editor");
    expect(tableHtml).toContain("+ 行");
    expect(tableHtml).toContain("+ 列");
    expect(tableHtml).toContain("- 末行");
    expect(tableHtml).toContain("- 末列");
    expect(tableHtml).not.toContain("<select");

    const chartHtml = renderToStaticMarkup(
      <SlideChartEditor shape={chartShape} canEdit onChange={() => {}} />,
    );
    expect(chartHtml).toContain("data-slide-chart-editor");
    expect(chartHtml).toContain("data-slide-chart-type-select");
    expect(chartHtml).toContain('data-select-value="bar"');
    expect(chartHtml).toContain("柱状图");
    expect(chartHtml).toContain("data-slide-chart-add-category");
    expect(chartHtml).toContain("data-slide-chart-add-series");
    expect(chartHtml).not.toContain("<select");

    const animHtml = renderToStaticMarkup(
      <SlideElementAnimationControls
        shapeId="cht-1"
        animation={{ effect: "slide-up", order: 2, durationMs: 500, trigger: "after_prev" }}
        canEdit
        onChange={() => {}}
        onPreview={() => {}}
      />,
    );
    expect(animHtml).toContain("data-slide-element-animation-section");
    expect(animHtml).toContain('data-select-value="slide-up"');
    expect(animHtml).toContain('data-select-value="after_prev"');
    expect(animHtml).toContain("预览动画");
    expect(animHtml).not.toContain("<select");
  });
});

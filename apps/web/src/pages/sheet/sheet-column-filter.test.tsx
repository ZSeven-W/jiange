import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DocMeta, Me, SheetSnapshot, SheetWorksheet } from "@/lib/api";
import { buildWorksheetGridMap, calculateWorkbook, getVisibleRowIndices } from "./workbook-engine";
import { SheetPage } from "./sheet-page";
import {
  buildNextColumnFilterConfig,
  collectColumnFilterOptions,
  isColumnFilterActive,
  resolveInitialFilterSelection,
  SheetColumnFilterPopover,
} from "./sheet-column-filter";
import {
  buildColorScaleRule,
  buildDataBarRule,
  computeVisualCondFormatBounds,
  evaluateSheetConditionalFormat,
  evaluateSheetVisualCondFormat,
  parseVisualCondFormat,
} from "./sheet-rules";

function makeSampleSheet(): SheetWorksheet {
  return {
    id: 1,
    nodeId: 10,
    title: "任务表",
    pos: 0,
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    filter: {},
    validations: [],
    conditionalFormats: [],
    protectedRanges: [],
    revision: 1,
    rows: [
      { id: 1, pos: 0 }, // header
      { id: 2, pos: 1 },
      { id: 3, pos: 2 },
      { id: 4, pos: 3 },
      { id: 5, pos: 4 },
      { id: 6, pos: 5 },
      { id: 7, pos: 6 }, // completely empty trailing row
      { id: 8, pos: 7 }, // completely empty trailing row
    ],
    columns: [
      { id: 101, pos: 0 }, // 任务
      { id: 102, pos: 1 }, // 状态
      { id: 103, pos: 2 }, // 进度
    ],
    cells: [
      { rowId: 1, columnId: 101, raw: "任务", style: {}, revision: 1 },
      { rowId: 1, columnId: 102, raw: "状态", style: {}, revision: 1 },
      { rowId: 1, columnId: 103, raw: "进度", style: {}, revision: 1 },
      { rowId: 2, columnId: 101, raw: "需求评审", style: {}, revision: 1 },
      { rowId: 2, columnId: 102, raw: "已完成", style: {}, revision: 1 },
      { rowId: 2, columnId: 103, raw: "100", style: {}, revision: 1 },
      { rowId: 3, columnId: 101, raw: "接口开发", style: {}, revision: 1 },
      { rowId: 3, columnId: 102, raw: "进行中", style: {}, revision: 1 },
      { rowId: 3, columnId: 103, raw: "=25+25", style: {}, revision: 1 },
      { rowId: 4, columnId: 101, raw: "前端联调", style: {}, revision: 1 },
      { rowId: 4, columnId: 102, raw: "进行中", style: {}, revision: 1 },
      { rowId: 4, columnId: 103, raw: "20", style: {}, revision: 1 },
      { rowId: 5, columnId: 101, raw: "待补充项", style: {}, revision: 1 },
      // row 4 (id=5), col 1 intentionally blank!
      { rowId: 5, columnId: 103, raw: "0", style: {}, revision: 1 },
      { rowId: 6, columnId: 101, raw: "上线验收", style: {}, revision: 1 },
      { rowId: 6, columnId: 102, raw: "已完成", style: {}, revision: 1 },
      { rowId: 6, columnId: 103, raw: "80", style: {}, revision: 1 },
    ],
  };
}

describe("sheet-column-filter", () => {
  it("collects unique values and counts including (blank) while ignoring empty trailing rows", () => {
    const ws = makeSampleSheet();
    const evalMap = calculateWorkbook([ws]).get(ws.id) ?? {};

    const statusOpts = collectColumnFilterOptions(ws, evalMap, 1);
    expect(statusOpts).toHaveLength(3);
    expect(statusOpts[2]).toEqual({ value: "", count: 1, isBlank: true });
    expect(statusOpts.slice(0, 2)).toEqual(
      expect.arrayContaining([
        { value: "进行中", count: 2, isBlank: false },
        { value: "已完成", count: 2, isBlank: false },
      ]),
    );

    // Evaluates formula cell (=25+25 -> "50") and sorts numerically
    const progressOpts = collectColumnFilterOptions(ws, evalMap, 2);
    expect(progressOpts.map((o) => o.value)).toEqual(["0", "20", "50", "80", "100"]);
  });

  it("resolves initial selection from values or legacy query rules and filters rows cleanly", () => {
    const ws = makeSampleSheet();
    const evalMap = calculateWorkbook([ws]).get(ws.id) ?? {};
    const statusOpts = collectColumnFilterOptions(ws, evalMap, 1);

    // No rule -> all selected
    expect(resolveInitialFilterSelection(statusOpts, undefined).size).toBe(3);
    expect(isColumnFilterActive(undefined)).toBe(false);

    // Values rule -> subset selected
    const ruleValues = { values: ["进行中"] };
    expect([...resolveInitialFilterSelection(statusOpts, ruleValues)]).toEqual(["进行中"]);
    expect(isColumnFilterActive(ruleValues)).toBe(true);

    // Legacy query rule -> matching options pre-checked
    expect([...resolveInitialFilterSelection(statusOpts, { query: "完成" })]).toEqual(["已完成"]);

    // Applying subset builds valid SheetFilterConfig that filters visible rows accurately
    const nextFilter = buildNextColumnFilterConfig(ws.filter, 1, ["已完成"], statusOpts.length);
    const filteredSheet = { ...ws, filter: nextFilter };
    expect(getVisibleRowIndices(filteredSheet, evalMap)).toEqual([0, 1, 5]);

    // Selecting blank matches blank row (and blank trailing rows)
    const blankFilter = buildNextColumnFilterConfig(ws.filter, 1, [""], statusOpts.length);
    expect(getVisibleRowIndices({ ...ws, filter: blankFilter }, evalMap)).toContain(4);
    expect(getVisibleRowIndices({ ...ws, filter: blankFilter }, evalMap)).not.toContain(1);

    // Selecting all options clears the column rule cleanly
    const cleared = buildNextColumnFilterConfig(nextFilter, 1, ["进行中", "已完成", ""], statusOpts.length);
    expect(cleared.rules?.["1"]).toBeUndefined();
    expect(getVisibleRowIndices({ ...ws, filter: cleared }, evalMap).length).toBe(ws.rows.length);
  });

  it("renders Feishu column header filter popover with sort shortcuts, search, select-all/clear, and counts", () => {
    const ws = makeSampleSheet();
    const evalMap = calculateWorkbook([ws]).get(ws.id) ?? {};
    const statusOpts = collectColumnFilterOptions(ws, evalMap, 1);

    const html = renderToStaticMarkup(
      <SheetColumnFilterPopover
        col={1}
        colLabel="状态"
        options={statusOpts}
        activeRule={{ values: ["进行中"] }}
        anchorRect={{ left: 160, top: 120, bottom: 144, right: 265, width: 105 }}
        onSort={() => {}}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('data-sheet-col-filter="1"');
    expect(html).toContain('data-sheet-col-sort="asc"');
    expect(html).toContain('data-sheet-col-sort="desc"');
    expect(html).toContain("升序 A→Z");
    expect(html).toContain("降序 Z→A");
    expect(html).toContain("搜索选项");
    expect(html).toContain("全选");
    expect(html).toContain("清空");
    expect(html).toContain('data-sheet-col-filter-option="进行中"');
    expect(html).toContain('data-sheet-col-filter-option="已完成"');
    expect(html).toContain('data-sheet-col-filter-option="__blank__"');
    expect(html).toContain("(空白)");
    expect(html).toContain("1/3");
    expect(html).toContain('data-sheet-col-filter-confirm');
  });

  it("evaluates conditional format Data Bars and Color Scales without interfering with standard highlight rules", () => {
    const ws = makeSampleSheet();
    const evalMap = calculateWorkbook([ws]).get(ws.id) ?? {};
    const { cellByKey } = buildWorksheetGridMap(ws);

    const barRule = buildDataBarRule({ top: 1, left: 2, bottom: 5, right: 2 }, "blue");
    const scaleRule = buildColorScaleRule({ top: 1, left: 2, bottom: 5, right: 2 }, "gyr");

    // Backend-safe serialization: op must remain valid on Go server
    expect(barRule.op).toBe("not_empty");
    expect(scaleRule.op).toBe("not_empty");
    expect(parseVisualCondFormat(barRule)?.kind).toBe("dataBar");
    expect(parseVisualCondFormat(scaleRule)?.kind).toBe("colorScale");

    // Base highlight evaluator ignores encoded visual rules
    expect(evaluateSheetConditionalFormat("100", evalMap["1:2"], [barRule, scaleRule], 1, 2)).toBeNull();

    const bounds = computeVisualCondFormatBounds([barRule, scaleRule], cellByKey, evalMap);
    expect(bounds.get(barRule.id)).toEqual({ min: 0, max: 100, count: 5 });

    // Row 1 (100) -> 100% bar & high green color scale
    const hi = evaluateSheetVisualCondFormat("100", evalMap["1:2"], [barRule, scaleRule], 1, 2, bounds);
    expect(hi?.dataBar?.percent).toBe(100);
    expect(hi?.dataBar?.barColor).toBe("#3370ff");
    expect(hi?.colorScaleBg).toBe("#bbf7d0");

    // Row 2 (=25+25 -> 50) -> 50% bar & mid yellow color scale
    const mid = evaluateSheetVisualCondFormat("=25+25", evalMap["2:2"], [barRule, scaleRule], 2, 2, bounds);
    expect(mid?.dataBar?.percent).toBe(50);
    expect(mid?.colorScaleBg).toBe("#fef08a");

    // Row 4 (0) -> 0% bar & low red color scale
    const lo = evaluateSheetVisualCondFormat("0", evalMap["4:2"], [barRule, scaleRule], 4, 2, bounds);
    expect(lo?.dataBar?.percent).toBe(0);
    expect(lo?.colorScaleBg).toBe("#fecaca");

    // Non-numeric text cell -> null
    expect(evaluateSheetVisualCondFormat("已完成", evalMap["1:1"], [barRule, scaleRule], 1, 1, bounds)).toBeNull();
  });

  it("renders Data Bars, Color Scales, and column filter buttons inside SheetPage", () => {
    const ws = makeSampleSheet();
    ws.filter = { enabled: true, headerRow: 0, rules: { "1": { values: ["已完成", "进行中"] } } };
    ws.conditionalFormats = [
      buildDataBarRule({ top: 1, left: 2, bottom: 5, right: 2 }, "blue"),
      buildColorScaleRule({ top: 1, left: 2, bottom: 5, right: 2 }, "gyr"),
    ];
    const snapshot: SheetSnapshot = {
      nodeId: 10,
      workspaceId: 1,
      parentId: null,
      title: "任务表",
      role: "manage",
      creatorId: 1,
      creatorName: "Owner",
      driveRevision: 1,
      workbookRevision: 2,
      updatedAt: "2026-11-23T00:00:00Z",
      sheets: [ws],
    };
    const meta: DocMeta = {
      id: 10,
      workspaceId: 1,
      parentId: null,
      title: "任务表",
      icon: "",
      creatorId: 1,
      creatorName: "Owner",
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
      kind: "sheet",
      role: "manage",
    };
    const me: Me = {
      user: { id: 1, email: "owner@example.com", name: "Owner", createdAt: "2026-11-23T00:00:00Z" },
      workspaces: [{ id: 1, name: "我的文档库", ownerId: 1 }],
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    qc.setQueryData(["doc", 10, 1], meta);
    qc.setQueryData(["sheet-ancestors", 10, 1], []);
    qc.setQueryData(["home-pins", 1], []);
    qc.setQueryData(["sheet-comments", 10, 1], { comments: [] });
    qc.setQueryData(["sheet", 10, 1], snapshot);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SheetPage sheetId={10} me={me} />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-sheet-tool="borders"');
    expect(html).toContain('data-sheet-col-filter-btn="1"');
    expect(html).toContain('data-sheet-cond-databar="100"');
    expect(html).toContain('data-sheet-cond-databar="50"');
    expect(html).toContain('data-sheet-cond-colorscale="#bbf7d0"');
    // Row 4 (blank status) is filtered out by active values rule
    expect(html).not.toContain("待补充项");
    expect(html).toContain("需求评审");
    expect(html).toContain("接口开发");
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DocMeta, Me, SheetOutlineGroup, SheetSnapshot, SheetSparkline, SheetWorksheet } from "@/lib/api";
import { buildImageFormula } from "./sheet-cell-image";
import { FORMULA_SPEC_MAP } from "./sheet-formula-autocomplete";
import {
  addOutlineGroup,
  getOutlineGroupsAtAnchor,
  getOutlineHiddenIndices,
  getOutlineToggleAnchor,
  hasOutlineGroupInRange,
  removeOutlineGroupsInRange,
  toggleOutlineGroupCollapsed,
} from "./sheet-outline";
import { SheetPage } from "./sheet-page";
import { extractSparklineValues, SheetSparklineSvg } from "./sheet-sparkline";

const me: Me = {
  user: { id: 1, email: "owner@example.com", name: "Owner", createdAt: "2026-11-24T00:00:00Z" },
  workspaces: [{ id: 1, name: "我的文档库", ownerId: 1 }],
};

function makeWorksheet(overrides: Partial<SheetWorksheet> = {}): SheetWorksheet {
  return {
    id: overrides.id ?? 11,
    nodeId: 7,
    title: overrides.title ?? "Sheet1",
    pos: overrides.pos ?? 0,
    frozenRows: overrides.frozenRows ?? 0,
    frozenCols: overrides.frozenCols ?? 0,
    merges: overrides.merges ?? [],
    filter: overrides.filter ?? {},
    validations: overrides.validations ?? [],
    conditionalFormats: overrides.conditionalFormats ?? [],
    protectedRanges: overrides.protectedRanges ?? [],
    sparklines: overrides.sparklines ?? [],
    outlineGroups: overrides.outlineGroups ?? [],
    revision: overrides.revision ?? 1,
    rows: overrides.rows ?? Array.from({ length: 6 }, (_, i) => ({ id: 101 + i, pos: i })),
    columns: overrides.columns ?? Array.from({ length: 6 }, (_, i) => ({ id: 201 + i, pos: i })),
    cells: overrides.cells ?? [],
  };
}

function renderSheetPage(ws: SheetWorksheet, role: "view" | "edit" | "manage" = "manage"): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  const meta: DocMeta = {
    id: 7,
    workspaceId: 1,
    parentId: null,
    title: "现代电子表格",
    icon: "",
    creatorId: 1,
    creatorName: "Owner",
    createdAt: "2026-11-24T00:00:00Z",
    updatedAt: "2026-11-24T00:00:00Z",
    kind: "sheet",
    role,
  };
  const snapshot: SheetSnapshot = {
    nodeId: 7,
    workspaceId: 1,
    parentId: null,
    title: "现代电子表格",
    role,
    creatorId: 1,
    creatorName: "Owner",
    driveRevision: 1,
    workbookRevision: 1,
    updatedAt: "2026-11-24T00:00:00Z",
    sheets: [ws],
  };
  qc.setQueryData(["doc", 7, 1], meta);
  qc.setQueryData(["sheet-ancestors", 7, 1], []);
  qc.setQueryData(["home-pins", 1], []);
  qc.setQueryData(["sheet-comments", 7, 1], { comments: [] });
  qc.setQueryData(["sheet", 7, 1], snapshot);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SheetPage sheetId={7} me={me} />
    </QueryClientProvider>,
  );
}

describe("Sheet Wave 2 (E4-2): Sparklines, Outline Grouping, Cell Images & Modern Formulas", () => {
  it("renders inline SVG sparklines (line, bar, winloss) from live evaluated formulas and exposes toolbar triggers", () => {
    const sparklines: SheetSparkline[] = [
      { id: "sp-line", row: 0, col: 4, sourceTop: 0, sourceLeft: 0, sourceBottom: 0, sourceRight: 3, type: "line", color: "#3370ff", showMarkers: true },
      { id: "sp-bar", row: 1, col: 4, sourceTop: 1, sourceLeft: 0, sourceBottom: 1, sourceRight: 3, type: "bar", color: "#00b42a", negativeColor: "#f54a45" },
      { id: "sp-wl", row: 2, col: 4, sourceTop: 2, sourceLeft: 0, sourceBottom: 2, sourceRight: 3, type: "winloss", color: "#00b42a", negativeColor: "#f54a45" },
    ];
    const ws = makeWorksheet({
      sparklines,
      cells: [
        { rowId: 101, columnId: 201, raw: "10", revision: 1 },
        { rowId: 101, columnId: 202, raw: "=A1*2", revision: 1 },
        { rowId: 101, columnId: 203, raw: "15", revision: 1 },
        { rowId: 101, columnId: 204, raw: "=LET(x, 30, x+5)", revision: 1 },
        { rowId: 102, columnId: 201, raw: "-5", revision: 1 },
        { rowId: 102, columnId: 202, raw: "12", revision: 1 },
        { rowId: 102, columnId: 203, raw: "8", revision: 1 },
        { rowId: 103, columnId: 201, raw: "1", revision: 1 },
        { rowId: 103, columnId: 202, raw: "-1", revision: 1 },
        { rowId: 103, columnId: 203, raw: "0", revision: 1 },
      ],
    });
    const html = renderSheetPage(ws);
    expect(html).toContain("data-sheet-sparkline-btn");
    expect(html).toContain("data-sheet-cell-image-btn");
    expect(html).toContain("data-sheet-group-rows-btn");
    expect(html).toContain("data-sheet-group-cols-btn");
    expect(html).toContain('data-sheet-sparkline-id="sp-line"');
    expect(html).toContain('data-sheet-sparkline-type="line"');
    expect(html).toContain("<polyline");
    expect(html).toContain("<circle");
    expect(html).toContain('data-sheet-sparkline-id="sp-bar"');
    expect(html).toContain('data-sheet-sparkline-type="bar"');
    expect(html).toContain('data-sheet-sparkline-id="sp-wl"');
    expect(html).toContain('data-sheet-sparkline-type="winloss"');

    // Direct helper verification
    const extracted = extractSparklineValues(
      { "0:0": { kind: "number", value: 10 }, "0:1": { kind: "number", value: 25 }, "0:2": { kind: "string", value: "skip" } },
      new Map(),
      { sourceTop: 0, sourceLeft: 0, sourceBottom: 0, sourceRight: 2 },
    );
    expect(extracted).toEqual([10, 25]);
    const emptySvg = renderToStaticMarkup(<SheetSparklineSvg values={[]} type="line" sparklineId="sp-empty" />);
    expect(emptySvg).toContain('data-sheet-sparkline-id="sp-empty"');
    expect(emptySvg).toContain("stroke-dasharray");
  });

  it("handles row & col outline grouping state transitions and hides collapsed rows/columns while preserving summary headers", () => {
    let groups: SheetOutlineGroup[] = addOutlineGroup([], "row", 1, 3);
    expect(groups).toHaveLength(1);
    expect(getOutlineToggleAnchor(groups[0])).toBe(0);
    expect(hasOutlineGroupInRange(groups, "row", 1, 3)).toBe(true);
    expect(getOutlineHiddenIndices(groups, "row").size).toBe(0);

    // Collapse the row group -> rows 1, 2, 3 hidden, summary row 0 remains visible!
    groups = toggleOutlineGroupCollapsed(groups, groups[0].id);
    expect([...getOutlineHiddenIndices(groups, "row")]).toEqual([1, 2, 3]);
    expect(getOutlineGroupsAtAnchor(groups, "row", 0)).toHaveLength(1);

    // Add a col group starting at col 0 (A..C) -> col 0 stays visible, cols 1..2 collapse
    groups = addOutlineGroup(groups, "col", 0, 2);
    const colGroup = groups.find((g) => g.axis === "col")!;
    expect(getOutlineToggleAnchor(colGroup)).toBe(0);
    groups = toggleOutlineGroupCollapsed(groups, colGroup.id);
    expect([...getOutlineHiddenIndices(groups, "col")]).toEqual([1, 2]);

    // Render SheetPage with collapsed row & col groups
    const ws = makeWorksheet({
      outlineGroups: groups,
      cells: [
        { rowId: 101, columnId: 201, raw: "汇总表头", revision: 1 },
        { rowId: 102, columnId: 201, raw: "隐藏明细行2", revision: 1 },
        { rowId: 105, columnId: 201, raw: "可见行5", revision: 1 },
        { rowId: 101, columnId: 202, raw: "隐藏明细列B", revision: 1 },
        { rowId: 101, columnId: 204, raw: "可见列D", revision: 1 },
      ],
    });
    const html = renderSheetPage(ws);
    expect(html).toContain(`data-outline-toggle="${groups[0].id}"`);
    expect(html).toContain(`data-outline-toggle="${colGroup.id}"`);
    expect(html).toContain('data-outline-collapsed="true"');
    // Summary row 0 and non-collapsed row 4 / col 3 remain visible
    expect(html).toContain("汇总表头");
    expect(html).toContain("可见行5");
    expect(html).toContain("可见列D");
    // Collapsed row 1 and collapsed col 1 are hidden from the DOM grid
    expect(html).not.toContain("隐藏明细行2");
    expect(html).not.toContain("隐藏明细列B");

    // Ungrouping removes matching axis group
    const afterUngroup = removeOutlineGroupsInRange(groups, "row", 1, 3);
    expect(afterUngroup.filter((g) => g.axis === "row")).toHaveLength(0);
    expect(afterUngroup.filter((g) => g.axis === "col")).toHaveLength(1);
  });

  it("renders inline cell images for safe =IMAGE(...) formulas and blocks unsafe schemes like javascript:", () => {
    expect(buildImageFormula("https://example.com/a.png")).toBe('=IMAGE("https://example.com/a.png")');
    expect(buildImageFormula("/api/files/99", 'My "Logo"', 2)).toBe('=IMAGE("/api/files/99", "My ""Logo""", 2)');

    const ws = makeWorksheet({
      cells: [
        { rowId: 101, columnId: 201, raw: '=IMAGE("https://example.com/chart.png", "季度封面", 1)', revision: 1 },
        { rowId: 101, columnId: 202, raw: '=IMAGE("/api/files/42", "本地图")', revision: 1 },
        { rowId: 101, columnId: 203, raw: '=IMAGE("javascript:alert(1)", "XSS")', revision: 1 },
      ],
    });
    const html = renderSheetPage(ws);
    expect(html).toContain('data-sheet-cell-image="0:0"');
    expect(html).toContain('src="https://example.com/chart.png"');
    expect(html).toContain('alt="季度封面"');
    expect(html).toContain('data-sheet-cell-image="0:1"');
    expect(html).toContain('src="/api/files/42"');
    // Unsafe javascript: scheme produces #VALUE! and never renders an <img> tag
    expect(html).not.toContain('data-sheet-cell-image="0:2"');
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toContain("#VALUE!");
  });

  it("includes all 8 modern formula functions in the formula bar autocomplete catalog", () => {
    for (const fn of ["REGEXMATCH", "REGEXREPLACE", "REGEXEXTRACT", "LET", "LAMBDA", "ARRAYFORMULA", "QUERY", "IMAGE"]) {
      expect(FORMULA_SPEC_MAP.has(fn)).toBe(true);
    }
  });
});

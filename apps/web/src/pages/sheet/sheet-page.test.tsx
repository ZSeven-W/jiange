import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DocMeta, Me, SheetComment, SheetSnapshot, SheetWorksheet } from "@/lib/api";
import { buildSheetRowFenwick, computeSheetVirtualWindow, SheetPage } from "./sheet-page";

const me: Me = {
  user: { id: 1, email: "owner@example.com", name: "Owner", createdAt: "2026-11-18T00:00:00Z" },
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
    revision: overrides.revision ?? 1,
    rows: overrides.rows ?? [
      { id: 101, pos: 0 },
      { id: 102, pos: 1 },
      { id: 103, pos: 2 },
    ],
    columns: overrides.columns ?? [
      { id: 201, pos: 0 },
      { id: 202, pos: 1 },
      { id: 203, pos: 2 },
    ],
    cells: overrides.cells ?? [],
  };
}

function renderSheetPage(
  metaOverrides: Partial<DocMeta> = {},
  snapshot?: SheetSnapshot,
  comments: SheetComment[] = [],
): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  const meta: DocMeta = {
    id: 7,
    workspaceId: 1,
    parentId: null,
    title: "预算明细",
    icon: "",
    creatorId: 1,
    creatorName: "Owner",
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
    kind: "sheet",
    role: "manage",
    ...metaOverrides,
  };
  qc.setQueryData(["doc", 7, 1], meta);
  qc.setQueryData(["sheet-ancestors", 7, 1], []);
  qc.setQueryData(["home-pins", 1], []);
  qc.setQueryData(["sheet-comments", 7, 1], { comments });
  if (snapshot) {
    qc.setQueryData(["sheet", 7, 1], snapshot);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SheetPage sheetId={7} me={me} />
    </QueryClientProvider>,
  );
}

describe("SheetPage", () => {
  it("renders Feishu header, worksheet tabs above toolbar, formula bar, grid, and quick templates for empty sheets", () => {
    const emptySnapshot: SheetSnapshot = {
      nodeId: 7,
      workspaceId: 1,
      parentId: null,
      title: "预算明细",
      role: "manage",
      creatorId: 1,
      creatorName: "Owner",
      driveRevision: 1,
      workbookRevision: 1,
      updatedAt: "2026-11-18T00:00:00Z",
      sheets: [makeWorksheet()],
    };
    const html = renderSheetPage({}, emptySnapshot);
    expect(html).toContain('data-sheet-page="7"');
    expect(html).toContain("预算明细");
    expect(html).toContain('data-sheet-tab="Sheet1"');
    expect(html).toContain("data-sheet-templates");
    expect(html.indexOf("data-sheet-tabs")).toBeLessThan(html.indexOf("data-sheet-toolbar"));
    expect(html.indexOf("data-sheet-toolbar")).toBeLessThan(html.indexOf("data-sheet-formula"));
    expect(html.indexOf("data-sheet-formula")).toBeLessThan(html.indexOf("data-sheet-grid"));
  });

  it("evaluates cross-sheet formulas and highlights referenced cells with #ff8800", () => {
    const s1 = makeWorksheet({
      id: 11,
      title: "Sheet1",
      pos: 0,
      cells: [
        { rowId: 101, columnId: 201, raw: "=SUM(B1:C1)+Sheet2!A1", style: {}, revision: 1 },
        { rowId: 101, columnId: 202, raw: "12.5", style: {}, revision: 1 },
        { rowId: 101, columnId: 203, raw: "7.5", style: {}, revision: 1 },
      ],
    });
    const s2 = makeWorksheet({
      id: 12,
      title: "Sheet2",
      pos: 1,
      rows: [{ id: 301, pos: 0 }],
      columns: [{ id: 401, pos: 0 }],
      cells: [{ rowId: 301, columnId: 401, raw: "5", style: {}, revision: 1 }],
    });
    const snapshot: SheetSnapshot = {
      nodeId: 7,
      workspaceId: 1,
      parentId: null,
      title: "跨表统计",
      role: "edit",
      creatorId: 1,
      creatorName: "Owner",
      driveRevision: 1,
      workbookRevision: 2,
      updatedAt: "2026-11-18T00:00:00Z",
      sheets: [s1, s2],
    };
    const html = renderSheetPage({ title: "跨表统计", role: "edit" }, snapshot);
    expect(html).toContain("=SUM(B1:C1)+Sheet2!A1");
    expect(html).toContain(">25<");
    expect(html).toContain("#ff8800");
    expect(html).toContain('data-sheet-tab="Sheet2"');
    expect(html).not.toContain("data-sheet-templates");
  });

  it("renders readonly indicator for view-only collaborators and hides quick templates", () => {
    const snapshot: SheetSnapshot = {
      nodeId: 7,
      workspaceId: 1,
      parentId: null,
      title: "只读视图",
      role: "view",
      creatorId: 1,
      creatorName: "Owner",
      driveRevision: 1,
      workbookRevision: 1,
      updatedAt: "2026-11-18T00:00:00Z",
      sheets: [makeWorksheet()],
    };
    const html = renderSheetPage({ title: "只读视图", role: "view" }, snapshot);
    expect(html).toContain("只读权限");
    expect(html).not.toContain("data-sheet-templates");
  });

  it("renders conditional formatting over formulas, validation dropdown trigger, protected range state, and cell comment badges", () => {
    const ws = makeWorksheet({
      id: 11,
      validations: [
        { id: "v1", top: 0, left: 0, bottom: 2, right: 0, type: "list", options: ["进行中", "已完成"], strict: true },
      ],
      conditionalFormats: [
        { id: "c1", top: 0, left: 1, bottom: 2, right: 1, op: "gt", value1: "100", bg: "#dcfce7", color: "#166534", bold: true },
      ],
      protectedRanges: [
        { id: "p1", top: 1, left: 2, bottom: 2, right: 2, description: "锁定区" },
      ],
      cells: [
        { rowId: 101, columnId: 201, raw: "进行中", style: {}, revision: 1 },
        { rowId: 101, columnId: 202, raw: "=60+65", style: {}, revision: 1 },
      ],
    });
    const snapshot: SheetSnapshot = {
      nodeId: 7,
      workspaceId: 1,
      parentId: null,
      title: "高级规则表",
      role: "edit",
      creatorId: 9,
      creatorName: "Admin",
      driveRevision: 1,
      workbookRevision: 3,
      updatedAt: "2026-11-19T00:00:00Z",
      sheets: [ws],
    };
    const comments: SheetComment[] = [
      {
        id: 501,
        nodeId: 7,
        worksheetId: 11,
        rowId: 101,
        columnId: 202,
        authorId: 9,
        authorName: "Admin",
        body: "请核对公式结果",
        resolved: false,
        createdAt: "2026-11-19T08:00:00Z",
        updatedAt: "2026-11-19T08:00:00Z",
      },
    ];
    const html = renderSheetPage({ title: "高级规则表", role: "edit" }, snapshot, comments);
    expect(html).toContain('data-sheet-tool="validation"');
    expect(html).toContain('data-sheet-tool="cond-fmt"');
    expect(html).toContain('data-sheet-tool="protect"');
    expect(html).toContain('data-sheet-tool="comments"');
    expect(html).toContain('data-sheet-comment-count');
    expect(html).toContain('data-sheet-cond-bg="#dcfce7"');
    expect(html).toContain('data-sheet-cell-dropdown-btn="0:0"');
    expect(html).toContain('data-sheet-protected="blocked"');
    expect(html).toContain('data-sheet-cell-comment-badge="0:1"');
  });

  it("renders ResourceTypeNotice when the node kind is not sheet", () => {
    const html = renderSheetPage({ kind: "doc", title: "普通文档" });
    expect(html).toContain("data-resource-type-notice");
    expect(html).toContain('href="#/doc/7"');
    expect(html).not.toContain("data-sheet-page");
  });

  it("virtualizes large sheets via FenwickVirtualizer while preserving frozen rows and exact scroll height", () => {
    const rowCount = 5000;
    const visibleRows = Array.from({ length: rowCount }, (_, i) => i);
    const rowHeights = Array.from({ length: rowCount }, (_, i) => (i % 50 === 0 ? 54 : 27));
    const scrollable = visibleRows.slice(2);
    const fenwick = buildSheetRowFenwick(scrollable, rowHeights);

    // Small sheet or unmeasured viewport skips virtualization
    const small = computeSheetVirtualWindow([0, 1, 2], [27, 27, 27], 1, 0, 600);
    expect(small.virtualized).toBe(false);
    expect(small.frozen).toEqual([0]);
    expect(small.virtual).toEqual([1, 2]);
    expect(small.topSpacer).toBe(0);
    expect(small.bottomSpacer).toBe(0);

    // Large sheet at mid-scroll virtualizes strictly to viewport + overscan
    const mid = computeSheetVirtualWindow(visibleRows, rowHeights, 2, 27_000, 600, 5, fenwick);
    expect(mid.virtualized).toBe(true);
    expect(mid.frozen).toEqual([0, 1]);
    expect(mid.virtual.length).toBeLessThan(60);
    expect(mid.virtual[0]).toBeGreaterThan(900);
    expect(mid.topSpacer).toBeGreaterThan(20_000);
    expect(mid.bottomSpacer).toBeGreaterThan(50_000);
    const virtualHeight = mid.virtual.reduce((sum, idx) => sum + rowHeights[idx], 0);
    expect(mid.topSpacer + virtualHeight + mid.bottomSpacer).toBe(fenwick.totalSize);
  });
});

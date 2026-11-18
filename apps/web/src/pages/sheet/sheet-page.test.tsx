import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DocMeta, Me, SheetSnapshot, SheetWorksheet } from "@/lib/api";
import { SheetPage } from "./sheet-page";

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

function renderSheetPage(metaOverrides: Partial<DocMeta> = {}, snapshot?: SheetSnapshot): string {
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

  it("renders ResourceTypeNotice when the node kind is not sheet", () => {
    const html = renderSheetPage({ kind: "doc", title: "普通文档" });
    expect(html).toContain("data-resource-type-notice");
    expect(html).toContain('href="#/doc/7"');
    expect(html).not.toContain("data-sheet-page");
  });
});

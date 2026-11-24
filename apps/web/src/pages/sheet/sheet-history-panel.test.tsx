import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SheetWorksheet } from "@/lib/api";
import type { SheetDefinedName } from "@jiange/sheet-sdk/types";
import type { SheetCellHistoryEntry, SheetVersionMeta } from "@/lib/sheet-history-api";
import {
  DEFINED_NAME_REGEX,
  parseDefinedNameTarget,
  SheetCellHistoryPanel,
  SheetDefinedNamesPanel,
  SheetVersionsPanel,
  validateDefinedName,
} from "./sheet-history-panel";

function makeWorksheet(overrides: Partial<SheetWorksheet> = {}): SheetWorksheet {
  return {
    id: overrides.id ?? 11,
    nodeId: 7,
    title: overrides.title ?? "Sheet1",
    pos: overrides.pos ?? 0,
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    filter: {},
    revision: 1,
    rows: [
      { id: 101, pos: 0 },
      { id: 102, pos: 1 },
      { id: 103, pos: 2 },
      { id: 104, pos: 3 },
    ],
    columns: [
      { id: 201, pos: 0 },
      { id: 202, pos: 1 },
      { id: 203, pos: 2 },
    ],
    cells: [],
  };
}

describe("SheetVersionsPanel", () => {
  const sampleVersions: SheetVersionMeta[] = [
    {
      id: 2,
      sheetId: 7,
      label: "恢复前自动备份",
      autoSaved: true,
      createdBy: 1,
      actorName: "张三",
      createdAt: "2026-11-24T04:00:00Z",
      worksheetCount: 2,
      cellCount: 18,
    },
    {
      id: 1,
      sheetId: 7,
      label: "Q4 预算基线",
      autoSaved: false,
      createdBy: 2,
      actorName: "李四",
      createdAt: "2026-11-23T08:30:00Z",
      worksheetCount: 1,
      cellCount: 12,
    },
  ];

  it("renders save form, version badges, stats, and enabled restore buttons for editors", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["sheet-versions", 7, 1], { versions: sampleVersions });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SheetVersionsPanel sheetId={7} userId={1} canEdit onVersionRestored={() => {}} />
      </QueryClientProvider>,
    );

    expect(html).toContain("data-sheet-versions-panel");
    expect(html).toContain("data-sheet-version-input");
    expect(html).toContain("保存版本");
    expect(html).toContain("Q4 预算基线");
    expect(html).toContain("恢复前自动备份");
    expect(html).toContain("自动备份");
    expect(html).toContain("手动命名");
    expect(html).toContain("2 个工作表 · 18 个单元格");
    expect(html).toContain('data-sheet-version-restore="1"');
    expect(html).not.toContain('data-sheet-version-restore="1" disabled');
    expect(html).not.toContain("<select");
  });

  it("disables restore actions and hides save form for read-only viewers", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["sheet-versions", 7, 1], { versions: sampleVersions });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SheetVersionsPanel sheetId={7} userId={1} canEdit={false} onVersionRestored={() => {}} />
      </QueryClientProvider>,
    );

    expect(html).not.toContain("data-sheet-version-save");
    expect(html).toContain("只读权限下可浏览历史版本");
    expect(html).toMatch(/disabled[^>]*data-sheet-version-restore="1"|data-sheet-version-restore="1"[^>]*disabled/);
  });
});

describe("SheetCellHistoryPanel", () => {
  it("renders active cell address, actor info, value diff, and formula diff chips", () => {
    const ws = makeWorksheet({ id: 11, title: "销售汇总" });
    const entries: SheetCellHistoryEntry[] = [
      {
        id: 20,
        sheetId: 7,
        worksheetId: 11,
        row: 1,
        col: 1,
        prevValue: "120",
        nextValue: "",
        prevFormula: "",
        nextFormula: "=SUM(A1:A5)",
        actorId: 1,
        actorName: "王五",
        createdAt: "2026-11-24T04:15:00Z",
      },
      {
        id: 19,
        sheetId: 7,
        worksheetId: 11,
        row: 1,
        col: 1,
        prevValue: "",
        nextValue: "120",
        prevFormula: "",
        nextFormula: "",
        actorId: 2,
        actorName: "赵六",
        createdAt: "2026-11-24T03:00:00Z",
      },
    ];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["sheet-cell-history", 7, 1, 11, 1, 1], { entries });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SheetCellHistoryPanel sheetId={7} userId={1} activeSheet={ws} focusedPoint={{ row: 1, col: 1 }} />
      </QueryClientProvider>,
    );

    expect(html).toContain("data-sheet-cell-history-panel");
    expect(html).toContain(">B2<");
    expect(html).toContain("销售汇总");
    expect(html).toContain("王五");
    expect(html).toContain("公式变更");
    expect(html).toContain("=SUM(A1:A5)");
    expect(html).toContain("120");
    expect(html).toContain("(空)");
  });

  it("renders empty placeholder when no cell history exists", () => {
    const ws = makeWorksheet({ id: 11 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["sheet-cell-history", 7, 1, 11, 0, 0], { entries: [] });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SheetCellHistoryPanel sheetId={7} userId={1} activeSheet={ws} focusedPoint={{ row: 0, col: 0 }} />
      </QueryClientProvider>,
    );

    expect(html).toContain("该单元格暂无修改记录");
  });
});

describe("SheetDefinedNamesPanel & helpers", () => {
  it("validates defined name regex, uniqueness per scope, and ref presence", () => {
    expect(DEFINED_NAME_REGEX.test("TaxRate")).toBe(true);
    expect(DEFINED_NAME_REGEX.test("_q1.sales_2026")).toBe(true);
    expect(DEFINED_NAME_REGEX.test("1Invalid")).toBe(false);
    expect(DEFINED_NAME_REGEX.test("Bad-Name")).toBe(false);
    expect(DEFINED_NAME_REGEX.test("a".repeat(65))).toBe(false);

    const existing: SheetDefinedName[] = [{ name: "TaxRate", ref: "Sheet1!B1" }];
    expect(validateDefinedName("taxrate", "Sheet1!B2", undefined, existing).ok).toBe(false);
    expect(validateDefinedName("TaxRate", "Sheet2!B2", "Sheet2", existing).ok).toBe(true);
    expect(validateDefinedName("1bad", "Sheet1!A1", undefined, existing).ok).toBe(false);
    expect(validateDefinedName("Good_Name", "=Sheet1!A1:B3", undefined, existing)).toEqual({
      ok: true,
      item: { name: "Good_Name", ref: "Sheet1!A1:B3" },
    });
  });

  it("parses cross-sheet and quoted defined name references", () => {
    const s1 = makeWorksheet({ id: 11, title: "Sheet1" });
    const s2 = makeWorksheet({ id: 12, title: "Q1 Sales" });
    expect(parseDefinedNameTarget({ name: "Range1", ref: "Sheet1!A1:B3" }, [s1, s2], s1)).toEqual({
      sheetId: 11,
      rect: { top: 0, left: 0, bottom: 2, right: 1 },
    });
    expect(parseDefinedNameTarget({ name: "Quoted", ref: "'Q1 Sales'!$B$2:$C$4" }, [s1, s2], s1)).toEqual({
      sheetId: 12,
      rect: { top: 1, left: 1, bottom: 3, right: 2 },
    });
  });

  it("renders FeishuSelect scope picker without native <select> and lists defined names", () => {
    const s1 = makeWorksheet({ id: 11, title: "Sheet1" });
    const s2 = makeWorksheet({ id: 12, title: "汇总" });
    const html = renderToStaticMarkup(
      <SheetDefinedNamesPanel
        sheets={[s1, s2]}
        activeSheet={s1}
        selectionBoundsRect={{ top: 0, left: 0, bottom: 2, right: 1 }}
        definedNames={[
          { name: "TaxRate", ref: "Sheet1!A1" },
          { name: "LocalTotal", ref: "汇总!B2:B4", sheetName: "汇总" },
        ]}
        canEdit
        onUpdateDefinedNames={() => {}}
      />,
    );

    expect(html).toContain("data-sheet-names-panel");
    expect(html).toContain("data-sheet-name-scope");
    expect(html).toContain('role="combobox"');
    expect(html).not.toContain("<select");
    expect(html).toContain("TaxRate");
    expect(html).toContain("=Sheet1!A1");
    expect(html).toContain("LocalTotal");
    expect(html).toContain('data-sheet-name-delete="TaxRate"');
  });
});

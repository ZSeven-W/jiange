import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SheetWorksheet } from "@/lib/api";
import type { SheetDefinedName } from "@jiange/sheet-sdk/types";
import {
  sheetHistoryApi,
  type SheetCellHistoryEntry,
  type SheetDefinedNameRecord,
  type SheetVersionMeta,
} from "@/lib/sheet-history-api";
import * as sheetHistoryPanelModule from "./sheet-history-panel";
import {
  DEFINED_NAME_REGEX,
  definedNameRecordsToSdk,
  MAX_DEFINED_NAME_REF_LENGTH,
  MAX_DEFINED_NAMES,
  parseDefinedNameTarget,
  sdkDefinedNamesToRecords,
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

  it("enforces max 200 names and 512-char ref limits in validateDefinedName", () => {
    const fullList: SheetDefinedName[] = Array.from({ length: MAX_DEFINED_NAMES }, (_, i) => ({
      name: `N_${i}`,
      ref: `Sheet1!A${i + 1}`,
    }));
    expect(validateDefinedName("ExtraName", "Sheet1!B1", undefined, fullList).ok).toBe(false);
    expect(validateDefinedName("LongRef", "A".repeat(MAX_DEFINED_NAME_REF_LENGTH + 1), undefined, []).ok).toBe(false);
    expect(validateDefinedName("OkRef", "A".repeat(MAX_DEFINED_NAME_REF_LENGTH), undefined, []).ok).toBe(true);
  });

  it("maps cloud defined name records to SDK format and back while preserving sheetId and comment", () => {
    const s1 = makeWorksheet({ id: 11, title: "Sheet1" });
    const s2 = makeWorksheet({ id: 12, title: "汇总" });
    const records: SheetDefinedNameRecord[] = [
      { name: "TaxRate", ref: "Sheet1!$A$1", comment: "全局税率" },
      { name: "LocalTotal", ref: "汇总!B2:B4", sheetId: 12, comment: "汇总页" },
      { name: "OrphanScope", ref: "OldSheet!A1", sheetId: 999 },
    ];

    const sdkNames = definedNameRecordsToSdk(records, [s1, s2]);
    expect(sdkNames).toEqual([
      { name: "TaxRate", ref: "Sheet1!$A$1" },
      { name: "LocalTotal", ref: "汇总!B2:B4", sheetName: "汇总" },
      { name: "OrphanScope", ref: "OldSheet!A1", sheetName: "#999" },
    ]);

    // Worksheet rename keeps scope attached to sheetId.
    const renamedS2 = makeWorksheet({ id: 12, title: "年度汇总" });
    const afterRename = definedNameRecordsToSdk(records, [s1, renamedS2]);
    expect(afterRename[1]).toEqual({ name: "LocalTotal", ref: "汇总!B2:B4", sheetName: "年度汇总" });

    // Round-trip back to cloud records preserves sheetId & comment.
    const backToRecords = sdkDefinedNamesToRecords(sdkNames, [s1, s2], records);
    expect(backToRecords).toEqual([
      { name: "TaxRate", ref: "Sheet1!$A$1", comment: "全局税率" },
      { name: "LocalTotal", ref: "汇总!B2:B4", sheetId: 12, comment: "汇总页" },
      { name: "OrphanScope", ref: "OldSheet!A1", sheetId: 999 },
    ]);
  });

  describe("cloud defined names API (zero localStorage dependency)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("removes localStorage helpers and persists defined names via backend API", async () => {
      expect("loadStoredDefinedNames" in sheetHistoryPanelModule).toBe(false);
      expect("saveStoredDefinedNames" in sheetHistoryPanelModule).toBe(false);

      const sampleRecords: SheetDefinedNameRecord[] = [
        { name: "TaxRate", ref: "Sheet1!$A$1", comment: "税率" },
        { name: "LocalSum", ref: "Sheet1!B1:B5", sheetId: 11 },
      ];
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ definedNames: sampleRecords }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ definedNames: sampleRecords }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const loaded = await sheetHistoryApi.getDefinedNames(7, 42);
      expect(loaded.definedNames).toEqual(sampleRecords);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "/api/sheets/7/defined-names",
        expect.objectContaining({
          method: "GET",
          credentials: "same-origin",
          headers: expect.objectContaining({
            "X-Jiange-User-Id": "42",
            "X-Jiange-Sheet-Version": "1",
          }),
        }),
      );

      const saved = await sheetHistoryApi.saveDefinedNames(7, 42, sampleRecords);
      expect(saved.definedNames).toEqual(sampleRecords);
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/sheets/7/defined-names",
        expect.objectContaining({
          method: "PUT",
          credentials: "same-origin",
          headers: expect.objectContaining({
            "X-Jiange-User-Id": "42",
            "X-Jiange-Sheet-Version": "1",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ definedNames: sampleRecords }),
        }),
      );
    });
  });
});

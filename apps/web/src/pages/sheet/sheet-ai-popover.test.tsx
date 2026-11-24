import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocMeta, Me, SheetCell, SheetSnapshot, SheetWorksheet } from "@/lib/api";
import { aiSuiteApi } from "@/lib/ai-suite-api";
import {
  extractSheetAiContext,
  SHEET_AI_PRESETS,
  SheetAiPopover,
} from "./sheet-ai-popover";
import { SheetPage } from "./sheet-page";

const me: Me = {
  user: { id: 1, email: "owner@example.com", name: "Owner", createdAt: "2026-11-24T00:00:00Z" },
  workspaces: [{ id: 1, name: "我的文档库", ownerId: 1 }],
};

function makeWorksheet(): SheetWorksheet {
  return {
    id: 21,
    nodeId: 9,
    title: "销售汇总",
    pos: 0,
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    filter: {},
    validations: [],
    conditionalFormats: [],
    protectedRanges: [],
    sparklines: [],
    outlineGroups: [],
    revision: 1,
    rows: Array.from({ length: 6 }, (_, i) => ({ id: 101 + i, pos: i })),
    columns: Array.from({ length: 5 }, (_, i) => ({ id: 201 + i, pos: i })),
    cells: [
      { rowId: 101, columnId: 201, raw: "部门", revision: 1 },
      { rowId: 101, columnId: 202, raw: "销售额", revision: 1 },
      { rowId: 102, columnId: 201, raw: "华东", revision: 1 },
      { rowId: 102, columnId: 202, raw: "1200", revision: 1 },
    ],
  };
}

describe("SheetAiPopover & Toolbar integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes AI 助手 trigger button in SheetPage toolbar", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    const meta: DocMeta = {
      id: 9,
      workspaceId: 1,
      parentId: null,
      title: "季度报表",
      icon: "",
      creatorId: 1,
      creatorName: "Owner",
      createdAt: "2026-11-24T00:00:00Z",
      updatedAt: "2026-11-24T00:00:00Z",
      kind: "sheet",
      role: "manage",
    };
    const snapshot: SheetSnapshot = {
      nodeId: 9,
      workspaceId: 1,
      parentId: null,
      title: "季度报表",
      role: "manage",
      creatorId: 1,
      creatorName: "Owner",
      driveRevision: 1,
      workbookRevision: 1,
      updatedAt: "2026-11-24T00:00:00Z",
      sheets: [makeWorksheet()],
    };
    qc.setQueryData(["doc", 9, 1], meta);
    qc.setQueryData(["sheet-ancestors", 9, 1], []);
    qc.setQueryData(["home-pins", 1], []);
    qc.setQueryData(["sheet-comments", 9, 1], { comments: [] });
    qc.setQueryData(["sheet", 9, 1], snapshot);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SheetPage sheetId={9} me={me} />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-sheet-ai-btn");
    expect(html).toContain("AI 助手");
  });

  it("renders natural-language input, all 4 preset chips, formula code card, apply button, and zero native select", () => {
    const html = renderToStaticMarkup(
      <SheetAiPopover
        sheetTitle="销售汇总"
        activeCell="C5"
        headers={["部门", "邮箱", "销售额"]}
        sampleRows={[["华东", "a@acme.cn", "1200"], ["华南", "b@acme.cn", "1800"]]}
        canEdit
        anchorRect={{ left: 100, top: 80, bottom: 120, right: 160 }}
        onApplyFormula={() => {}}
        onClose={() => {}}
        initialResult={{
          answer: "已为「销售额」（C 列）生成求和公式。",
          suggestedFormula: "=SUM(C2:C3)",
          explanation: "SUM(C2:C3) 对区域内全部数值求和。",
          mode: "local",
        }}
      />,
    );
    expect(html).toContain("data-sheet-ai-popover");
    expect(html).toContain("data-sheet-ai-input");
    expect(html).toContain("C5");
    for (const preset of SHEET_AI_PRESETS) {
      expect(html).toContain(preset);
    }
    expect(html).toContain("data-sheet-ai-formula");
    expect(html).toContain("=SUM(C2:C3)");
    expect(html).toContain("data-sheet-ai-apply");
    expect(html).toContain("填入当前单元格");
    expect(html).toContain("data-sheet-ai-explanation");
    expect(html).toContain("内置公式引擎");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("disables apply button when viewer is read-only", () => {
    const html = renderToStaticMarkup(
      <SheetAiPopover
        sheetTitle="销售汇总"
        activeCell="C5"
        headers={["部门", "销售额"]}
        sampleRows={[]}
        canEdit={false}
        anchorRect={{ left: 100, top: 80, bottom: 120, right: 160 }}
        onApplyFormula={() => {}}
        onClose={() => {}}
        initialResult={{
          answer: "均值公式",
          suggestedFormula: "=AVERAGE(B2:B10)",
          explanation: "计算平均值",
          mode: "llm",
        }}
      />,
    );
    expect(html).toContain("只读模式不可写入");
    expect(html).toContain("disabled");
    expect(html).toContain("AI 模型");
  });

  it("extracts real headers and sample rows from sheet cells and evalMap", () => {
    const ws = makeWorksheet();
    const cellByKey = new Map<string, SheetCell>([
      ["0:0", { rowId: 101, columnId: 201, raw: "部门", revision: 1 }],
      ["0:1", { rowId: 101, columnId: 202, raw: "销售额", revision: 1 }],
      ["1:0", { rowId: 102, columnId: 201, raw: "华东", revision: 1 }],
      ["1:1", { rowId: 102, columnId: 202, raw: "=600*2", revision: 1 }],
      ["2:0", { rowId: 103, columnId: 201, raw: "华南", revision: 1 }],
      ["2:1", { rowId: 103, columnId: 202, raw: "1800", revision: 1 }],
    ]);
    const evalMap = {
      "1:1": { kind: "number" as const, value: 1200 },
    };
    const ctx = extractSheetAiContext(ws, evalMap, cellByKey);
    expect(ctx.headers).toEqual(["部门", "销售额"]);
    expect(ctx.sampleRows).toEqual([
      ["华东", "1200"],
      ["华南", "1800"],
    ]);
  });

  it("posts prompt and sheet context to /api/ai/sheet-assist", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        answer: "均值 1500",
        suggestedFormula: "=AVERAGE(B2:B3)",
        explanation: "计算 B 列平均值",
        mode: "local",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await aiSuiteApi.sheetAssist({
      prompt: "计算平均值",
      headers: ["部门", "销售额"],
      sampleRows: [["华东", "1200"], ["华南", "1800"]],
      activeCell: "B4",
      sheetTitle: "销售汇总",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ai/sheet-assist");
    expect(JSON.parse(init.body)).toMatchObject({
      prompt: "计算平均值",
      activeCell: "B4",
    });
    expect(res.suggestedFormula).toBe("=AVERAGE(B2:B3)");
  });
});

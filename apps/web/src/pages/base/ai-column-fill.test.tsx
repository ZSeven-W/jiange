import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseRecord, Field } from "@/lib/api";
import { aiSuiteApi } from "@/lib/ai-suite-api";
import {
  AI_FILL_PRESETS,
  BaseAiColumnFillDialog,
  buildBatchFillUpdates,
  extractBaseFillRows,
  formatCellForTargetField,
  type BaseAiFillPreviewRow,
} from "./ai-column-fill";

const sampleFields: Field[] = [
  { id: 1, name: "工单描述", type: "text", position: 1, isPrimary: true },
  { id: 2, name: "摘要", type: "text", position: 2 },
  { id: 3, name: "优先级", type: "select", position: 3, options: ["高", "中", "低"] },
  { id: 4, name: "标签", type: "multi_select", position: 4, options: ["紧急", "安全", "优化"] },
  { id: 5, name: "金额", type: "number", position: 5 },
  { id: 6, name: "附件", type: "attachment", position: 6 },
];

const sampleRecords: BaseRecord[] = [
  { id: 101, baseId: 7, position: 1, cells: { 1: "线上支付接口崩溃阻塞客户下单，需要紧急修复", 5: 5000 } },
  { id: 102, baseId: 7, position: 2, cells: { 1: "后续迭代优化移动端深色主题细节", 5: 1000 } },
  { id: 103, baseId: 7, position: 3, cells: { 1: "   ", 5: 0 } },
];

describe("BaseAiColumnFillDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders FeishuSelect pickers (zero native select), presets, preview table, and action buttons", () => {
    const initialPreview: BaseAiFillPreviewRow[] = [
      { recordId: 101, sourceText: "线上支付接口崩溃阻塞客户下单", generatedValue: "高" },
      { recordId: 102, sourceText: "后续迭代优化移动端深色主题细节", generatedValue: "低" },
    ];
    const html = renderToStaticMarkup(
      <BaseAiColumnFillDialog
        baseId={7}
        fields={sampleFields}
        records={sampleRecords}
        onClose={() => {}}
        onApplied={() => {}}
        initialPreview={initialPreview}
        initialMode="local"
      />,
    );

    // Strictly zero native <select> elements
    expect(html).not.toMatch(/<select[\s>]/i);

    expect(html).toContain("data-base-ai-fill-dialog");
    expect(html).toContain("AI 批量填充列");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("data-ai-fill-source-field");
    expect(html).toContain("data-ai-fill-target-field");
    expect(html).toContain("data-ai-fill-preset");
    for (const preset of AI_FILL_PRESETS) {
      expect(html).toContain(preset.label);
    }
    // Target field options include only text / select / multi_select (excludes number & attachment)
    expect(html).toContain("1:工单描述|2:摘要|3:优先级|4:标签");
    expect(html).not.toContain("6:附件");

    expect(html).toContain("data-ai-fill-generate");
    expect(html).toContain("生成预览");
    expect(html).toContain("data-ai-fill-preview");
    expect(html).toContain("原内容");
    expect(html).toContain("AI 生成结果");
    expect(html).toContain('data-ai-fill-row-check="101"');
    expect(html).toContain('data-ai-fill-row-check="102"');
    expect(html).toContain("本地智能引擎");
    expect(html).toContain("data-ai-fill-apply");
    expect(html).toContain("批量写入表格");
  });

  it("excludes readonly target fields and displays guidance when no editable target field exists", () => {
    const html = renderToStaticMarkup(
      <BaseAiColumnFillDialog
        baseId={7}
        fields={[{ id: 1, name: "编号", type: "number", position: 1 }]}
        records={sampleRecords}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );
    expect(html).toContain("当前数据表缺少可编辑的文本、单选或多选列");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("extracts non-empty source rows and enforces the 50-row cap", () => {
    const extracted = extractBaseFillRows(sampleRecords, sampleFields[0]);
    expect(extracted).toHaveLength(2);
    expect(extracted[0]).toEqual({ recordId: 101, text: "线上支付接口崩溃阻塞客户下单，需要紧急修复" });

    const manyRecords: BaseRecord[] = Array.from({ length: 65 }, (_, i) => ({
      id: i + 1,
      baseId: 7,
      position: i + 1,
      cells: { 1: `记录内容 #${i + 1}` },
    }));
    const capped = extractBaseFillRows(manyRecords, sampleFields[0]);
    expect(capped).toHaveLength(50);
    expect(capped[49].recordId).toBe(50);
  });

  it("formats text, select, and multi_select batch update payloads accurately for checked rows only", () => {
    const textField = sampleFields[1];
    const selectField = sampleFields[2];
    const multiField = sampleFields[3];

    expect(formatCellForTargetField("  简洁摘要  ", textField)).toBe("简洁摘要");
    expect(formatCellForTargetField("高", selectField)).toBe("高");
    expect(formatCellForTargetField("未知等级", selectField)).toBe("高");
    expect(formatCellForTargetField("紧急, 安全、不存在", multiField)).toEqual(["紧急", "安全"]);

    const preview: BaseAiFillPreviewRow[] = [
      { recordId: 101, sourceText: "A", generatedValue: "紧急, 安全" },
      { recordId: 102, sourceText: "B", generatedValue: "优化" },
    ];
    const updates = buildBatchFillUpdates(preview, new Set([101]), multiField);
    expect(updates).toEqual([
      { id: 101, cells: { "4": ["紧急", "安全"] } },
    ]);
  });

  it("posts batch fill request to /api/ai/base-fill", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ recordId: 101, value: "高" }],
        mode: "local",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await aiSuiteApi.baseFill({
      baseId: 7,
      preset: "classify",
      sourceFieldName: "工单描述",
      targetFieldType: "select",
      options: ["高", "中", "低"],
      rows: [{ recordId: 101, text: "紧急崩溃" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ai/base-fill");
    expect(JSON.parse(init.body)).toMatchObject({
      baseId: 7,
      preset: "classify",
      targetFieldType: "select",
    });
    expect(res.results).toEqual([{ recordId: 101, value: "高" }]);
  });
});

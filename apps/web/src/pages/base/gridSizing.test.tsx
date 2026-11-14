import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BaseRecord, Field } from "@/lib/api";
import { Grid } from "./Grid";

describe("virtualized row sizing", () => {
  it("keeps the footer separate from real rows in editable and read-only grids", () => {
    const fields: Field[] = [{ id: 1, name: "任务", type: "text", position: 1, isPrimary: true }];
    const records: BaseRecord[] = [{ id: 7, baseId: 1, position: 1, cells: { 1: "首条" } }];
    for (const canEdit of [true, false]) {
      const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Grid baseId={1} canEdit={canEdit} fields={fields} records={records} members={[]} onMutate={() => {}} /></QueryClientProvider>);
      expect(html).toMatch(/<tr aria-hidden="true" data-grid-bottom-spacer="true"/);
      expect(html).toContain("首条");
      expect(html).toContain("1 条记录");
      expect(html.includes('aria-label="新增一行"')).toBe(canEdit);
    }
  });
  it("marks the primary field independently of the visible field index", () => {
    const fields: Field[] = [
      { id: 2, name: "主标题", type: "text", position: 2, isPrimary: true },
      { id: 3, name: "状态", type: "text", position: 3 },
    ];
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Grid baseId={1} canEdit fields={fields} allFields={fields} records={[]} members={[]} onMutate={() => {}} /></QueryClientProvider>);
    expect(html).toContain('aria-label="主字段"');
    expect(html).toMatch(/draggable="false"[^>]*data-th="2"/);
    expect(html).toMatch(/draggable="true"[^>]*data-th="3"/);
  });
  it("keeps rich cell contents in a fixed-height display box without dropping values", () => {
    const fields: Field[] = [
      { id: 1, name: "多选", type: "multi_select", options: ["甲", "乙", "丙"], position: 1 },
      { id: 2, name: "关联", type: "link", position: 2 },
      { id: 3, name: "附件", type: "attachment", position: 3 },
    ];
    const records: BaseRecord[] = [{ id: 7, baseId: 1, position: 1, cells: {
      1: ["甲", "乙", "丙"], 2: ["事项一", "事项二"],
      3: [{ id: 5, name: "报告.pdf", mime: "application/pdf", size: 10 }, { id: 6, name: "笔记.txt", mime: "text/plain", size: 10 }],
    } }];
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Grid baseId={1} canEdit={false} fields={fields} records={records} members={[]} onMutate={() => {}} /></QueryClientProvider>);
    expect((html.match(/data-grid-cell-content/g) ?? [])).toHaveLength(3);
    // 每个富内容单元格都在固定高盒子中（行号列也复用 h-[31px]，故 ≥3）
    expect((html.match(/h-\[31px\]/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("甲");
    expect(html).toContain("事项二");
    expect(html).toContain("笔记.txt");
  });
});

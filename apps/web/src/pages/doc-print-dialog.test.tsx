import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildPrintCommentsThreads,
  buildPrintPageCss,
  DEFAULT_PRINT_SETTINGS,
  DocPrintDialog,
} from "./doc-print-dialog";
import type { Comment } from "@/lib/api";

function makeComment(overrides: Partial<Comment> & { id: number; body: string }): Comment {
  return {
    docId: 10,
    userId: 1,
    userName: "林架构",
    block: "1:2",
    startChar: "",
    endChar: "",
    quote: "",
    resolved: false,
    createdAt: "2026-11-20T05:00:00Z",
    updatedAt: "2026-11-20T05:00:00Z",
    ...overrides,
  };
}

describe("DocPrintDialog & print helpers", () => {
  it("generates accurate @page CSS rules for paper size, orientation, and margins", () => {
    expect(buildPrintPageCss(DEFAULT_PRINT_SETTINGS)).toBe("@page { size: A4 portrait; margin: 18mm 16mm; }");
    expect(
      buildPrintPageCss({
        ...DEFAULT_PRINT_SETTINGS,
        paper: "letter",
        orientation: "landscape",
        margins: "narrow",
      }),
    ).toBe("@page { size: Letter landscape; margin: 10mm 10mm; }");
    expect(
      buildPrintPageCss({
        ...DEFAULT_PRINT_SETTINGS,
        paper: "a4",
        orientation: "portrait",
        margins: "wide",
      }),
    ).toBe("@page { size: A4 portrait; margin: 24mm 24mm; }");
  });

  it("groups flat comments into root threads with ordered replies", () => {
    const threads = buildPrintCommentsThreads([
      makeComment({ id: 1, body: "建议补充压测数据", quote: "系统吞吐量" }),
      makeComment({ id: 2, parentId: 1, userName: "周产品", body: "已安排周三执行" }),
      makeComment({ id: 3, body: "时间表确认无误", resolved: true }),
      makeComment({ id: 4, parentId: 1, userName: "林架构", body: "收到" }),
    ]);
    expect(threads).toHaveLength(2);
    expect(threads[0].root.id).toBe(1);
    expect(threads[0].replies.map((r) => r.id)).toEqual([2, 4]);
    expect(threads[1].root.id).toBe(3);
    expect(threads[1].root.resolved).toBe(true);
    expect(threads[1].replies).toHaveLength(0);
  });

  it("renders settings controls and live preview reflecting header, footer, and comments appendix", () => {
    const html = renderToStaticMarkup(
      <DocPrintDialog
        title="Q4 架构评审纪要"
        settings={{
          paper: "a4",
          orientation: "landscape",
          margins: "narrow",
          showHeader: true,
          headerText: "Q4 评审 · 内部受控",
          showFooter: true,
          footerText: "鉴格云文档导出",
          includeComments: true,
        }}
        onChange={() => {}}
        previewLines={[
          { kind: "heading", text: "一、核心结论" },
          { kind: "paragraph", text: "完成持久化引用索引与多跳图谱闭环。" },
          { kind: "table", text: "表格：关键指标对比" },
        ]}
        commentCount={3}
        defaultHeaderText="Q4 架构评审纪要"
        defaultFooterText=""
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain("data-doc-print-dialog");
    expect(html).toContain("data-print-paper=\"a4\"");
    expect(html).toContain("data-print-orientation=\"landscape\"");
    expect(html).toContain("data-print-margin=\"narrow\"");
    expect(html).toContain("data-print-preview-header");
    expect(html).toContain("Q4 评审 · 内部受控");
    expect(html).toContain("data-print-preview-footer");
    expect(html).toContain("鉴格云文档导出");
    expect(html).toContain("data-print-preview-comments");
    expect(html).toContain("评论附录（3 条线程）");
    expect(html).toContain("data-doc-print-confirm");
  });
});

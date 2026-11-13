import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocMeta } from "@/lib/api";
import { DocumentInfoDialog } from "./DocumentInfoDialog";

const meta: DocMeta = { id: 1, workspaceId: 1, parentId: null, title: "文档", icon: "", creatorId: 1, creatorName: "小简", createdAt: "2026-11-13T04:00:00Z", updatedAt: "2026-11-13T05:00:00Z" };

describe("document info dialog", () => {
  it("shows verified data and marks unavailable metrics rather than claiming zero", () => {
    const html = renderToStaticMarkup(<DocumentInfoDialog meta={meta} stats={{ characters: 7, nonWhitespace: 5 }} comments={null} synced={false} allowCopy={false} allowPrint={false} onClose={() => {}} />);
    expect(html).toContain("小简");
    expect(html).toContain("正文字符（不含空白）");
    expect(html).toContain("访问记录");
    expect(html).toContain("操作记录");
    expect(html).toContain("当前数据不可用");
    expect(html).toContain("文档尚未同步完成");
    expect(html).toContain('data-document-print-restricted="true"');
  });
});

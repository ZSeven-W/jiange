import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { DocView } from "@/lib/api";
vi.mock("@/components/DocumentCover", () => ({ DocumentCover: ({ children }: { children: (value: { hasCover: boolean }) => ReactNode }) => children({ hasCover: false }) }));
vi.mock("./ReadOnlyDoc", () => ({ ReadOnlyDoc: () => <div>只读正文</div> }));
import { DocumentPresentation } from "./DocumentPresentation";

const view: DocView = { blocks: [] };
const noop = () => {};
describe("document presentation", () => {
  it("shows a read-only document and available comments within an accessible view", () => {
    const html = renderToStaticMarkup(<DocumentPresentation id={1} userId={2} title="协作方案" icon="📌" view={view} synced allowCopy allowPrint commentsOpen={false} onComments={noop} onRevalidate={noop} onClose={noop}><span>评论内容</span></DocumentPresentation>);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="文档演示模式"');
    expect(html).toContain("协作方案");
    expect(html).toContain("只读正文");
    expect(html).toContain("打开评论");
    expect(html).toContain("评论内容");
    expect(html).not.toContain("contenteditable=\"true\"");
  });
  it("marks print restrictions and warns when content is not synced", () => {
    const html = renderToStaticMarkup(<DocumentPresentation id={1} userId={2} title="" view={view} synced={false} allowCopy={false} allowPrint={false} commentsOpen={false} onRevalidate={noop} onClose={noop}/>);
    expect(html).toContain('data-document-print-restricted="true"');
    expect(html).toContain("文档尚未同步完成");
    expect(html).toContain("未命名文档");
    expect(html).not.toContain("打开评论");
  });
});

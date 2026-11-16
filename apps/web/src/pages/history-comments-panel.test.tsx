import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Comment } from "@/lib/api";
import { HistoryCommentsPanel } from "./history-comments-panel";

const root: Comment = { id: 1, docId: 7, userId: 2, userName: "小周", block: "1:1", startChar: "", endChar: "", quote: "引用", body: "已解决的评论", resolved: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
function render(comments: Comment[], canSubmit = true) {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><HistoryCommentsPanel id={7} userId={1} session={1} comments={comments} members={[]} canSubmit={canSubmit} allowCopy={false} allowPrint={false} onClose={() => {}} onAccessDenied={() => {}} onPolicyDenied={() => {}} /></QueryClientProvider>);
}
describe("history comments", () => {
  it("shows resolved roots and their replies without unrelated active threads", () => {
    const html = render([root, { ...root, id: 2, parentId: 1, body: "回复内容", quote: "", resolved: false }, { ...root, id: 3, body: "未解决的评论", resolved: false }]);
    expect(html).toContain("已解决的评论");
    expect(html).toContain("回复内容");
    expect(html).not.toContain("未解决的评论");
    expect(html).toContain("重新打开");
    expect(html).toContain('data-document-print-restricted="true"');
  });
  it("offers an empty state and disables reopen without permission", () => {
    expect(render([])).toContain("在这可查看所有已解决的评论");
    expect(render([root], false)).toMatch(/disabled=""[^>]*>重新打开/);
  });
});

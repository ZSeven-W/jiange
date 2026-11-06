import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommentsPanel } from "./CommentsPanel";
import type { Comment } from "@/lib/api";

const time = "2026-01-01T00:00:00Z";
const thread: Comment = { id: 1, docId: 7, userId: 2, userName: "对方", block: "", startChar: "", endChar: "", quote: "被引用的内容", body: "一条评论", resolved: false, createdAt: time, updatedAt: time };
const reply: Comment = { ...thread, id: 2, userId: 1, userName: "我", parentId: 1, body: "我的回复", quote: "" };

function renderPanel(canEdit: boolean, canManage: boolean) {
  const client = new QueryClient();
  client.setQueryData(["comments", 7], [thread, reply]);
  client.setQueryData(["docmembers", 7], []);
  return renderToStaticMarkup(<QueryClientProvider client={client}><CommentsPanel id={7} meId={1} canEdit={canEdit} canManage={canManage} draft={null} onDraftSent={() => {}} activeThread={null} onActivate={() => {}} onClose={() => {}} /></QueryClientProvider>);
}

describe("comment permissions", () => {
  it("shows comments to viewers without offering write actions, including on their own replies", () => {
    const html = renderPanel(false, false);
    expect(html).toContain("一条评论");
    expect(html).toContain("我的回复");
    expect(html).not.toContain("data-comment-composer");
    expect(html).not.toContain(">删除</button>");
    expect(html).not.toContain(">解决</button>");
  });

  it("allows editors to comment and delete only their own replies", () => {
    const html = renderPanel(true, false);
    expect(html).toContain("data-comment-composer");
    expect(html).toContain(">回复</button>");
    expect(html).toContain(">解决</button>");
    expect((html.match(/>删除<\/button>/g) ?? [])).toHaveLength(1);
  });

  it("lets document managers delete other members' comments too", () => {
    const html = renderPanel(true, true);
    expect((html.match(/>删除<\/button>/g) ?? [])).toHaveLength(2);
  });
});

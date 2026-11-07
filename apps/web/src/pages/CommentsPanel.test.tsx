import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommentsPanel, focusCommentDraft, notifyCommentAccessError, sameCommentAnchor } from "./CommentsPanel";
import { commentListKey, commentMembersKey, CommentDraftJournal, CommentRecoveryGate, matchesCommentTarget, mayExportCommentDraftData, mergeRecoveredCommentDrafts, newCommentSession, redactCommentDraftQuote } from "./commentAccess";
import { ApiError, type Comment } from "@/lib/api";

const time = "2026-01-01T00:00:00Z";
const thread: Comment = { id: 1, docId: 7, userId: 2, userName: "对方", block: "", startChar: "", endChar: "", quote: "被引用的内容", body: "一条评论", resolved: false, createdAt: time, updatedAt: time };
const reply: Comment = { ...thread, id: 2, userId: 1, userName: "我", parentId: 1, body: "我的回复", quote: "" };

function renderPanel(canEdit: boolean, canManage: boolean) {
  const client = new QueryClient();
  client.setQueryData(commentListKey(7, 1, 1), [thread, reply]);
  client.setQueryData(commentMembersKey(7, 1, 1), []);
  return renderToStaticMarkup(<QueryClientProvider client={client}><CommentsPanel id={7} meId={1} session={1} canEdit={canEdit} canManage={canManage} draft={null} onDraftSent={() => {}} activeThread={null} onActivate={() => {}} onClose={() => {}} onAccessDenied={() => {}} onDismissRecovery={() => {}} onSnapshot={() => {}} onComposerSuspended={() => {}} /></QueryClientProvider>);
}

describe("comment permissions", () => {
  it("redacts protected quotes and only permits export with current verified access", () => {
    const anchor = { block: "1:1", startChar: "1:2", endChar: "1:3", quote: "受保护的原文" };
    const record = { text: "我自己写的评论", draft: anchor };
    expect(redactCommentDraftQuote(record, false)).toEqual({ text: record.text, draft: { ...anchor, quote: "" } });
    expect(record.draft.quote).toBe("受保护的原文");
    expect(redactCommentDraftQuote(record, true)).toEqual(record);
    expect(mayExportCommentDraftData({ copyProtected: true, role: "edit" }, true, true)).toBe(false);
    expect(mayExportCommentDraftData({ copyProtected: true, role: "manage" }, true, true)).toBe(true);
    expect(mayExportCommentDraftData({ copyProtected: false, role: "edit" }, true, true)).toBe(true);
    expect(mayExportCommentDraftData({ copyProtected: false, role: "manage" }, false, true)).toBe(false);
    expect(mayExportCommentDraftData({ copyProtected: false, role: "manage" }, true, false)).toBe(false);
    expect(mayExportCommentDraftData(undefined, true, true)).toBe(false);
    const client = new QueryClient();
    client.setQueryData(commentListKey(7, 1, 1), []);
    client.setQueryData(commentMembersKey(7, 1, 1), []);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><CommentsPanel id={7} meId={1} session={1} canEdit canManage={false} draft={null} onDraftSent={() => {}} activeThread={null} onActivate={() => {}} onClose={() => {}} onAccessDenied={() => {}} onDismissRecovery={() => {}} onSnapshot={() => {}} onComposerSuspended={() => {}} recovery={[redactCommentDraftQuote(record, false)]} /></QueryClientProvider>);
    expect(html).toContain("我自己写的评论");
    expect(html).not.toContain("受保护的原文");
  });
  it("escalates authorization failures but preserves other errors for retry", () => {
    const denied = vi.fn();
    for (const status of [401, 403, 404]) expect(notifyCommentAccessError(new ApiError(status, "denied", "denied"), denied)).toBe(true);
    expect(denied).toHaveBeenCalledTimes(3);
    expect(notifyCommentAccessError(new ApiError(503, "error", "temporary"), denied)).toBe(false);
    expect(notifyCommentAccessError(new TypeError("offline"), denied)).toBe(false);
    expect(denied).toHaveBeenCalledTimes(3);
  });
  it("isolates cached comments and members by user and access session", () => {
    const session = newCommentSession(), next = newCommentSession();
    expect(commentListKey(7, 1, session)).not.toEqual(commentListKey(7, 1, next));
    expect(commentListKey(7, 1, session)).not.toEqual(commentListKey(7, 2, session));
    expect(commentMembersKey(7, 1, session)).not.toEqual(commentMembersKey(7, 2, session));
    expect(matchesCommentTarget({ doc: 7, user: 1, session }, 7, 1, session)).toBe(true);
    expect(matchesCommentTarget({ doc: 7, user: 1, session }, 7, 1, next)).toBe(false);
    expect(matchesCommentTarget({ doc: 7, user: 1, session }, 7, 2, session)).toBe(false);
  });

  it("bounds repeated denial recovery and allows retry after success or user action", () => {
    const gate = new CommentRecoveryGate();
    expect(gate.begin()).toBe(true);
    for (let i = 0; i < 10; i++) expect(gate.begin()).toBe(false);
    gate.reset();
    expect(gate.begin()).toBe(true);
    expect(gate.begin()).toBe(false);
  });

  it("retains independent comment and reply drafts without crossing accounts or documents", () => {
    const journal = new CommentDraftJournal();
    const anchor = { block: "1:1", startChar: "1:2", endChar: "1:3", quote: "原位置" };
    journal.save(7, 1, { text: "正文草稿", draft: anchor });
    journal.save(7, 1, { text: "回复草稿", draft: null, parentId: 42 });
    journal.save(7, 2, { text: "其他账号", draft: null });
    journal.save(8, 1, { text: "其他文档", draft: null });
    expect(journal.list(7, 1)).toEqual([{ text: "正文草稿", draft: anchor }, { text: "回复草稿", draft: null, parentId: 42 }]);
    expect(journal.list(7, 2)).toEqual([{ text: "其他账号", draft: null }]);
    journal.save(7, 1, { text: "", draft: null, parentId: 42 });
    expect(journal.list(7, 1)).toEqual([{ text: "正文草稿", draft: anchor }]);
    journal.clear(7, 1);
    expect(journal.list(7, 1)).toEqual([]);
    expect(journal.list(7, 2)).toHaveLength(1);
  });

  it("keeps previously frozen drafts when a composer is reused and deduplicates repeated freezes", () => {
    const journal = new CommentDraftJournal();
    const a = { text: "草稿 A", draft: null };
    const b = { text: "草稿 B", draft: null };
    const reply = { text: "回复", draft: null, parentId: 42 };
    journal.save(7, 1, a);
    let recovery = journal.freeze(7, 1);
    journal.save(7, 1, b);
    journal.save(7, 1, reply);
    recovery = journal.freeze(7, 1);
    recovery = journal.freeze(7, 1);
    expect(recovery).toEqual([a, b, reply]);
    expect(journal.recovered(7, 2)).toEqual([]);
    expect(journal.recovered(7, 1)).toEqual([a, b, reply]);
    journal.save(7, 1, { text: "", draft: null });
    expect(recovery).toEqual([a, b, reply]);
    journal.dismiss(7, 1);
    expect(journal.recovered(7, 1)).toEqual([]);
    expect(mergeRecoveredCommentDrafts([a], [a, b])).toEqual([a, b]);
  });

  it("detects a changed selection before reusing unsent text", () => {
    const anchor = { block: "1:1", startChar: "1:2", endChar: "1:3", quote: "原位置" };
    expect(sameCommentAnchor(anchor, { ...anchor })).toBe(true);
    expect(sameCommentAnchor(anchor, { ...anchor, endChar: "1:4" })).toBe(false);
    expect(sameCommentAnchor(anchor, null)).toBe(false);
    expect(sameCommentAnchor(null, null)).toBe(true);
  });

  it("hides cached comments if revalidation fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    const key = commentListKey(7, 1, 44);
    client.setQueryData(key, [thread]);
    client.setQueryData(commentMembersKey(7, 1, 44), []);
    await client.fetchQuery({ queryKey: key, queryFn: async () => { throw new Error("access revoked"); }, staleTime: 0 }).catch(() => {});
    // TanStack retains stale data in an error state; it must never render it.
    expect(client.getQueryData(key)).toEqual([thread]);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><CommentsPanel id={7} meId={1} session={44} canEdit canManage draft={null} onDraftSent={() => {}} activeThread={null} onActivate={() => {}} onClose={() => {}} onAccessDenied={() => {}} onDismissRecovery={() => {}} onSnapshot={() => {}} onComposerSuspended={() => {}} /></QueryClientProvider>);
    expect(html).toContain("评论加载失败");
    expect(html).not.toContain("一条评论");
    expect(html).not.toContain("被引用的内容");
  });
  it("focuses a new selection even when the composer is already mounted", () => {
    const focus = vi.fn(), scrollIntoView = vi.fn();
    const input = { focus, scrollIntoView, disabled: false } as unknown as HTMLTextAreaElement;
    const draft = { block: "1:1", startChar: "1:2", endChar: "1:3", quote: "目标" };
    const fallbackFocus = vi.fn(), fallbackScroll = vi.fn();
    const fallback = { focus: fallbackFocus, scrollIntoView: fallbackScroll } as unknown as HTMLElement;
    focusCommentDraft(input, fallback, draft, false);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focusCommentDraft(input, fallback, null, false);
    focusCommentDraft(input, fallback, draft, true);
    focusCommentDraft(null, fallback, draft, false);
    focusCommentDraft(null, null, draft, false);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(fallbackFocus).toHaveBeenCalledTimes(2);
    expect(fallbackFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(fallbackScroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

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

import { describe, expect, it, vi } from "vitest";
import { CommentAttemptStore, matchesUnresolvedDraft } from "./commentAttempts";
import { CommentAttemptAccountChanged, CommentAttemptDocumentDenied, CommentAttemptsUnavailable, commentAttemptPayload, queryCommentAttempt, requireCommentAttempts, sendCommentAttempt } from "./commentAttemptApi";
import { mustRedactCommentAttemptQuote } from "./commentAccess";
import { recoverOwnCommentText } from "./CommentAttemptRecovery";

class StorageMock implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
const id = "0123456789abcdef0123456789abcdef";
const payload = { body: "评论", mentions: [9], block: "1:1", startChar: "1:2", endChar: "1:3", quote: "引用" };

describe("durable comment attempts", () => {
  it("persists the immutable request before use and scopes recovery to account and document", () => {
    const storage = new StorageMock(), store = new CommentAttemptStore({ storage, random: () => id }, 7, 2);
    const source = { ...payload, mentions: [9] }, attempt = store.prepare(source);
    source.mentions.push(10);
    expect(attempt.payload.mentions).toEqual([9]);
    expect(new CommentAttemptStore({ storage, random: () => id }, 7, 2).list().attempts).toEqual([attempt]);
    expect(new CommentAttemptStore({ storage, random: () => id }, 7, 3).list().attempts).toEqual([]);
    expect(new CommentAttemptStore({ storage, random: () => id }, 8, 2).list().attempts).toEqual([]);
    expect(() => store.prepare(payload)).toThrow("already exists");
  });

  it("keeps unknown and rejected requests, and never rebuilds them from changed mentions", async () => {
    const storage = new StorageMock(), store = new CommentAttemptStore({ storage, random: () => id }, 7, 2);
    const attempt = store.prepare(payload), send = vi.fn().mockRejectedValue(new TypeError("offline"));
    await expect(store.run(attempt, () => send(attempt.payload))).rejects.toThrow("offline");
    expect(store.list().attempts).toEqual([attempt]);
    expect(matchesUnresolvedDraft(attempt, { ...payload, mentions: [11], quote: "" })).toBe(true);
    expect(matchesUnresolvedDraft(attempt, { ...payload, body: "新草稿" })).toBe(false);
    expect(send).toHaveBeenCalledWith(payload);
  });

  it("clears only a confirmed own request and never erases another tab without locks", async () => {
    const storage = new StorageMock(), owner = new CommentAttemptStore({ storage, random: () => id }, 7, 2);
    const attempt = owner.prepare(payload);
    const other = new CommentAttemptStore({ storage, random: () => id }, 7, 2);
    expect(await other.run(attempt, async () => "ok")).toEqual({ value: "ok", cleaned: false });
    expect(owner.list().attempts).toHaveLength(1);
    expect(await owner.run(attempt, async () => "ok")).toEqual({ value: "ok", cleaned: true });
    expect(owner.list().attempts).toEqual([]);
  });

  it("refuses to send when persistence is unavailable or an attempt was altered", async () => {
    const storage = new StorageMock(), store = new CommentAttemptStore({ storage, random: () => id }, 7, 2);
    vi.spyOn(storage, "setItem").mockImplementationOnce(() => { throw new Error("quota"); });
    expect(() => store.prepare(payload)).toThrow("quota");
    expect(store.list().attempts).toEqual([]);
    const attempt = store.prepare(payload), send = vi.fn();
    storage.setItem(storage.key(0)!, "{}");
    await expect(store.run(attempt, send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(store.list().damaged).toBe(1);
  });

  it("never persists protected quoted text", () => {
    expect(commentAttemptPayload("评论", [9], undefined, payload, false)).toEqual({ body: "评论", mentions: [9], block: "1:1", startChar: "1:2", endChar: "1:3" });
  });
  it("rejects input the server cannot preserve before creating a request", () => {
    expect(() => commentAttemptPayload("x\ud800", [], undefined, null, false)).toThrow("无效字符");
    expect(() => commentAttemptPayload("😀".repeat(2001), [], undefined, null, false)).toThrow("2000");
    expect(() => commentAttemptPayload("正文", Array.from({ length: 21 }, (_, i) => i + 1), undefined, null, false)).toThrow("20 人");
    expect(() => commentAttemptPayload("😀", [], undefined, null, false)).not.toThrow();
  });
  it("redacts a protected quote without creating a different retry payload", async () => {
    const storage = new StorageMock(), store = new CommentAttemptStore({ storage, random: () => id }, 7, 2);
    store.prepare(payload);
    expect(await store.redactQuotes()).toBe(true);
    expect(storage.getItem(storage.key(0)!)!).not.toContain("引用");
    const redacted = store.list().attempts[0];
    expect(redacted.redacted).toBe(true);
    await expect(sendCommentAttempt(redacted)).rejects.toThrow("只能查询");
    const old = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ mutationId: id, docId: 7, userId: 2, commentId: 0, state: "unknown" }), { status: 200 })) as typeof fetch;
      expect(await queryCommentAttempt(redacted)).toEqual({ state: "unknown" });
      expect(store.list().attempts).toHaveLength(1);
    } finally { globalThis.fetch = old; }
  });
  it("does not rewrite another live tab's protected quote without a lock", async () => {
    const storage = new StorageMock(), owner = new CommentAttemptStore({ storage, random: () => id }, 7, 2);
    owner.prepare(payload);
    const other = new CommentAttemptStore({ storage, random: () => id }, 7, 2);
    expect(await other.redactQuotes()).toBe(false);
    expect(owner.list().attempts[0].payload.quote).toBe("引用");
    expect(await owner.redactQuotes()).toBe(true);
  });
  it("keeps a pending immutable quote through initial loading and temporary failure", async () => {
    const storage = new StorageMock(), store = new CommentAttemptStore({ storage, random: () => id }, 7, 2);
    const attempt = store.prepare(payload);
    // This is the state on a fresh DocPage before its first metadata request.
    expect(mustRedactCommentAttemptQuote(undefined, false, false, false)).toBe(false);
    expect(mustRedactCommentAttemptQuote({ role: "edit", copyMinRole: "view", downloadMinRole: "view", permissionsRevision: 1 }, false, false, false)).toBe(false);
    expect(store.list().attempts[0]).toEqual(attempt);
    expect(mustRedactCommentAttemptQuote({ role: "edit", copyMinRole: "view", downloadMinRole: "view", permissionsRevision: 1 }, true, false, false)).toBe(false);
    expect(mustRedactCommentAttemptQuote({ role: "edit", copyMinRole: "manage", downloadMinRole: "view", permissionsRevision: 2 }, true, false, false)).toBe(true);
    expect(mustRedactCommentAttemptQuote(undefined, false, true, false)).toBe(true);
    expect(await store.redactQuotes()).toBe(true);
    expect(store.list().attempts[0].redacted).toBe(true);
  });
  it("recovers only the verified account's own text, never the document quote or anchors", async () => {
    const storage = new StorageMock(), store = new CommentAttemptStore({ storage, random: () => id }, 7, 2);
    store.prepare(payload);
    const list = vi.spyOn(store, "list");
    const me = (userId: number) => ({ user: { id: userId, email: "", name: "", createdAt: "" }, workspaces: [] });
    await expect(recoverOwnCommentText(store, 2, async () => me(3))).rejects.toThrow("账号已变化");
    expect(list).not.toHaveBeenCalled();
    expect(await recoverOwnCommentText(store, 2, async () => me(2))).toEqual({ text: [{ mutationId: id, body: "评论" }], damaged: 0 });
    expect(store.list().attempts[0].payload.quote).toBe("引用");
    storage.setItem("jiange:comment-attempt:v1:2:7:damaged", "not-json");
    expect(await recoverOwnCommentText(store, 2, async () => me(2))).toEqual({ text: [{ mutationId: id, body: "评论" }], damaged: 1 });
  });
});

describe("comment attempt protocol", () => {
  it("requires explicit capability rather than falling back to legacy POST", async () => {
    const old = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 })) as typeof fetch;
      await expect(requireCommentAttempts(7, 2)).rejects.toThrow();
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    } finally { globalThis.fetch = old; }
  });
  it("validates receipt scope and 204 proof before confirmation", async () => {
    const old = globalThis.fetch;
    const storage = new StorageMock(), attempt = new CommentAttemptStore({ storage, random: () => id }, 7, 2).prepare(payload);
    try {
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
      await expect(sendCommentAttempt(attempt)).rejects.toThrow("结果未确认");
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 204, headers: { "X-Comment-Result": "committed", "X-Comment-Mutation-Id": id } })) as typeof fetch;
      await expect(sendCommentAttempt(attempt)).resolves.toEqual({ state: "committed" });
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ mutationId: id, docId: 7, userId: 3, commentId: 5, state: "committed" }), { status: 200 })) as typeof fetch;
      await expect(sendCommentAttempt(attempt)).rejects.toThrow("结果未确认");
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ mutationId: id, docId: 7, userId: 2, commentId: 5, state: "deleted" }), { status: 200 })) as typeof fetch;
      await expect(sendCommentAttempt(attempt)).resolves.toEqual({ state: "deleted", commentId: 5 });
    } finally { globalThis.fetch = old; }
  });
  it("binds capability, submission and lookup to the original account", async () => {
    const old = globalThis.fetch;
    const storage = new StorageMock(), attempt = new CommentAttemptStore({ storage, random: () => id }, 7, 2).prepare(payload);
    try {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ version: 1, userId: 3 }), { status: 200 })) as typeof fetch;
      await expect(requireCommentAttempts(7, 2)).rejects.toThrow("账号");
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ mutationId: id, docId: 7, userId: 2, commentId: 5, state: "committed" }), { status: 200 })) as typeof fetch;
      await sendCommentAttempt(attempt);
      const call = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({ mutationId: id, expectedUserId: 2 });
      await queryCommentAttempt(attempt);
      expect(String(vi.mocked(globalThis.fetch).mock.calls[1][0])).toContain("expectedUserId=2");
    } finally { globalThis.fetch = old; }
  });
  it("does not redact an old account attempt after a different account is detected", async () => {
    const old = globalThis.fetch, storage = new StorageMock();
    const original = new CommentAttemptStore({ storage, random: () => id }, 7, 2);
    const attempt = original.prepare(payload);
    try {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "comment_attempt_account_changed" }), { status: 409 })) as typeof fetch;
      await expect(requireCommentAttempts(7, 2)).rejects.toBeInstanceOf(CommentAttemptAccountChanged);
      expect(original.list().attempts[0]).toEqual(attempt);
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ version: 1, userId: 2, canCopyQuote: true }), { status: 200 })) as typeof fetch;
      expect(await requireCommentAttempts(7, 2)).toEqual({ canCopyQuote: true });
      expect(original.list().attempts[0]).toEqual(attempt);
    } finally { globalThis.fetch = old; }
  });
  it("distinguishes a bound document denial from an unknown route", async () => {
    const old = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "comment_attempt_document_denied" }), { status: 403 })) as typeof fetch;
      await expect(requireCommentAttempts(7, 2)).rejects.toBeInstanceOf(CommentAttemptDocumentDenied);
      globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 })) as typeof fetch;
      await expect(requireCommentAttempts(7, 2)).rejects.toBeInstanceOf(CommentAttemptsUnavailable);
    } finally { globalThis.fetch = old; }
  });
});

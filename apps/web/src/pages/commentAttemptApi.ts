import { ApiError, type Comment } from "@/lib/api";
import type { CommentAttempt, CommentAttemptPayload } from "./commentAttempts";

export type CommentAttemptResult = { state: "committed" | "deleted"; commentId?: number };
export class CommentAttemptsUnavailable extends Error {}
export class CommentAttemptAccountChanged extends Error {}
export class CommentAttemptDocumentDenied extends Error {}

function parseReceipt(value: unknown, attempt: CommentAttempt, allowUnknown: boolean): CommentAttemptResult | { state: "unknown" } {
  if (!value || typeof value !== "object") throw new Error("评论响应不完整，结果未确认");
  const result = value as { mutationId?: unknown; docId?: unknown; userId?: unknown; commentId?: unknown; state?: unknown; comment?: Comment };
  if (result.mutationId !== attempt.mutationId || result.docId !== attempt.docId || result.userId !== attempt.userId) throw new Error("评论响应不完整，结果未确认");
  if (allowUnknown && result.state === "unknown" && result.commentId === 0 && !result.comment) return { state: "unknown" };
  if (!Number.isSafeInteger(result.commentId) || (result.commentId as number) < 1 || (result.state !== "committed" && result.state !== "deleted")) throw new Error("评论响应不完整，结果未确认");
  // A successful retry can return the current comment after a later edit. The
  // server checks the original payload hash; only scope and identity must
  // still match the immutable request here.
  if (result.comment && (result.state !== "committed" || result.comment.id !== result.commentId || result.comment.docId !== attempt.docId || result.comment.userId !== attempt.userId)) throw new Error("评论响应不完整，结果未确认");
  return { state: result.state, commentId: result.commentId as number };
}

async function parseError(response: Response): Promise<never> {
  const data = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (data.error === "comment_attempt_account_changed") throw new CommentAttemptAccountChanged("账号已变化，请重新验证。");
  if (data.error === "comment_attempt_document_denied") throw new CommentAttemptDocumentDenied("当前账号无权访问此文档。");
  throw new ApiError(response.status, data.error ?? "error", data.message ?? response.statusText);
}

/** Never silently send to an older, non-idempotent endpoint. */
export async function requireCommentAttempts(docId: number, expectedUserId: number): Promise<{ canCopyQuote: boolean }> {
  const response = await fetch(`/api/docs/${docId}/comment-attempts/capabilities?expectedUserId=${expectedUserId}`, { credentials: "same-origin", cache: "no-store" });
  if (response.status === 404 || response.status === 405) throw new CommentAttemptsUnavailable("服务器不支持安全提交或文档权限已变化，请刷新验证。");
  if (!response.ok) return parseError(response);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || (body as { version?: unknown }).version !== 1 || (body as { userId?: unknown }).userId !== expectedUserId || typeof (body as { canCopyQuote?: unknown }).canCopyQuote !== "boolean") throw new CommentAttemptAccountChanged("服务器未确认当前账号及安全评论协议。");
  return { canCopyQuote: (body as { canCopyQuote: boolean }).canCopyQuote };
}

/** The caller must durably persist the immutable attempt before invoking this. */
export async function sendCommentAttempt(attempt: CommentAttempt): Promise<CommentAttemptResult> {
  if (attempt.redacted) throw new Error("原引用已移除，只能查询提交状态");
  const response = await fetch(`/api/docs/${attempt.docId}/comment-attempts`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...attempt.payload, mutationId: attempt.mutationId, expectedUserId: attempt.userId }),
  });
  if (response.status === 204) {
    const state = response.headers.get("X-Comment-Result");
    if ((state !== "committed" && state !== "deleted") || response.headers.get("X-Comment-Mutation-Id") !== attempt.mutationId) throw new Error("评论响应不完整，结果未确认");
    return { state };
  }
  if (!response.ok) return parseError(response);
  return parseReceipt(await response.json().catch(() => null), attempt, false) as CommentAttemptResult;
}

/** Unknown is not proof that an earlier POST cannot still commit. */
export async function queryCommentAttempt(attempt: CommentAttempt): Promise<CommentAttemptResult | { state: "unknown" }> {
  const response = await fetch(`/api/docs/${attempt.docId}/comment-attempts/${attempt.mutationId}?expectedUserId=${attempt.userId}`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return parseError(response);
  return parseReceipt(await response.json().catch(() => null), attempt, true);
}

/** Avoid persisting a protected document quote in a durable attempt. The
 * character anchors remain intact, so the comment still targets its selection. */
export function commentAttemptPayload(body: string, mentions: number[], parentId: number | undefined, anchor: { block: string; startChar: string; endChar: string; quote: string } | null, mayPersistQuote: boolean): CommentAttemptPayload {
  // Match server bounds before creating a durable attempt. Invalid UTF-16
  // would otherwise be replaced while encoding JSON and silently alter text.
  const fields = [body, ...(anchor ? [anchor.block, anchor.startChar, anchor.endChar, ...(mayPersistQuote ? [anchor.quote] : [])] : [])];
  if (fields.some((s) => /\p{Surrogate}/u.test(s))) throw new Error("评论包含无效字符，请修正后发送。");
  if ([...body].length < 1 || [...body].length > 2000) throw new Error("评论需要 1-2000 字。");
  if (mentions.length > 20) throw new Error("最多提及 20 人。");
  if (anchor && ([...anchor.block].length > 64 || [...anchor.startChar].length > 64 || [...anchor.endChar].length > 64 || mayPersistQuote && [...anchor.quote].length > 500)) throw new Error("评论引用过长，请重新选择。");
  if (parentId) return { body, mentions: [...mentions], parentId };
  return { body, mentions: [...mentions], ...(anchor ? { block: anchor.block, startChar: anchor.startChar, endChar: anchor.endChar, ...(mayPersistQuote ? { quote: anchor.quote } : {}) } : {}) };
}

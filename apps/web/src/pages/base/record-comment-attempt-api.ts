import type { RecordCommentAttempt } from "./record-comment-attempts";

type Receipt = { state: "committed" | "deleted"; commentId: number };
function validate(value: unknown, attempt: RecordCommentAttempt): Receipt {
  if (!value || typeof value !== "object") throw new Error("评论结果未确认");
  const result = value as Record<string, unknown>;
  if (result.mutationId !== attempt.mutationId || result.userId !== attempt.userId || result.baseId !== attempt.baseId || result.recordId !== attempt.recordId || !Number.isSafeInteger(result.commentId) || (result.commentId as number) <= 0 || (result.state !== "committed" && result.state !== "deleted")) throw new Error("评论结果未确认");
  return { state: result.state, commentId: result.commentId as number };
}

export async function requireRecordCommentAttempts(userId: number, baseId: number, recordId: number): Promise<void> {
  const response = await fetch(`/api/bases/${baseId}/records/${recordId}/comment-attempts/capabilities?expectedUserId=${userId}`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("无法确认账号、记录权限或安全评论协议");
  const result: unknown = await response.json().catch(() => null);
  if (!result || typeof result !== "object" || (result as Record<string, unknown>).version !== 1 || (result as Record<string, unknown>).userId !== userId || (result as Record<string, unknown>).baseId !== baseId || (result as Record<string, unknown>).recordId !== recordId) throw new Error("安全评论协议响应无效");
}

export async function sendRecordCommentAttempt(attempt: RecordCommentAttempt): Promise<Receipt> {
  const response = await fetch(`/api/bases/${attempt.baseId}/records/${attempt.recordId}/comment-attempts`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedUserId: attempt.userId, mutationId: attempt.mutationId, body: attempt.body, mentions: attempt.mentions, ...(attempt.parentId === undefined ? {} : { parentId: attempt.parentId }) }),
  });
  if (!response.ok) throw new Error("评论结果未确认");
  return validate(await response.json().catch(() => null), attempt);
}

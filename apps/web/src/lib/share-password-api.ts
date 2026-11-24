import { ApiError } from "@/lib/api";

export interface PutLinkPasswordBody {
  password?: string;
  clear?: boolean;
}

export interface PutLinkPasswordResult {
  hasPassword: boolean;
}

export interface VerifyPublicLinkPasswordResult {
  ok: boolean;
}

export async function putLinkPassword(
  docId: number,
  body: PutLinkPasswordBody,
  userId?: number,
  signal?: AbortSignal,
): Promise<PutLinkPasswordResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userId && userId > 0) headers["X-Jiange-User-Id"] = String(userId);
  const res = await fetch(`/api/docs/${docId}/link-password`, {
    method: "PUT",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText, data);
  return data as PutLinkPasswordResult;
}

export async function verifyPublicLinkPassword(
  token: string,
  password: string,
  signal?: AbortSignal,
): Promise<VerifyPublicLinkPasswordResult> {
  const res = await fetch(`/api/public/${encodeURIComponent(token)}/verify-password`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText, data);
  return data as VerifyPublicLinkPasswordResult;
}

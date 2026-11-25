import { ApiError } from "@/lib/api";

export interface UserSession {
  id: number;
  userId: number;
  userAgent: string;
  ipAddress: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
}

export interface ChangePasswordResponse {
  ok: boolean;
  revokedSessions: number;
}

export interface RevokeOtherSessionsResponse {
  revoked: number;
}

export interface PasswordResetRequestResponse {
  ok: boolean;
  message: string;
}

export interface PasswordResetConfirmResponse {
  ok: boolean;
}

export const MY_SESSIONS_QUERY_KEY = ["me", "sessions"] as const;

async function accountSecurityRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { error?: string }).error ?? "error",
      (data as { message?: string }).message ?? res.statusText,
      data as Record<string, unknown>,
    );
  }
  return data as T;
}

export function changePassword(input: ChangePasswordInput): Promise<ChangePasswordResponse> {
  return accountSecurityRequest<ChangePasswordResponse>("POST", "/api/me/password", input);
}

export async function listMySessions(signal?: AbortSignal): Promise<UserSession[]> {
  const data = await accountSecurityRequest<{ sessions?: UserSession[] }>(
    "GET",
    "/api/me/sessions",
    undefined,
    signal,
  );
  return data.sessions ?? [];
}

export function revokeMySession(sessionId: number): Promise<void> {
  return accountSecurityRequest<void>("DELETE", `/api/me/sessions/${sessionId}`);
}

export function revokeOtherSessions(): Promise<RevokeOtherSessionsResponse> {
  return accountSecurityRequest<RevokeOtherSessionsResponse>("POST", "/api/me/sessions/revoke-others", {});
}

export function requestPasswordReset(email: string): Promise<PasswordResetRequestResponse> {
  return accountSecurityRequest<PasswordResetRequestResponse>("POST", "/api/auth/password-reset/request", {
    email,
  });
}

export function confirmPasswordReset(
  token: string,
  newPassword: string,
): Promise<PasswordResetConfirmResponse> {
  return accountSecurityRequest<PasswordResetConfirmResponse>("POST", "/api/auth/password-reset/confirm", {
    token,
    newPassword,
  });
}

export const accountSecurityApi = {
  changePassword,
  listMySessions,
  revokeMySession,
  revokeOtherSessions,
  requestPasswordReset,
  confirmPasswordReset,
};

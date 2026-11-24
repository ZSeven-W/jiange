import { ApiError, type Me } from "@/lib/api";

export interface MfaStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
  enabledAt: string | null;
}

export interface MfaSetupResponse {
  secret: string;
  otpauthUri: string;
}

export interface MfaEnableResponse {
  enabled: true;
  recoveryCodes: string[];
  recoveryCodesRemaining?: number;
  enabledAt?: string | null;
}

export interface MfaDisableResponse {
  enabled: false;
}

export interface MfaChallengeResponse {
  mfaRequired: true;
  mfaToken: string;
  email: string;
}

export type LoginOrMfaResponse = Me | MfaChallengeResponse;

export const MFA_STATUS_QUERY_KEY = ["me-mfa"] as const;

export function isMfaChallengeResponse(value: unknown): value is MfaChallengeResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { mfaRequired?: unknown }).mfaRequired === true &&
    typeof (value as { mfaToken?: unknown }).mfaToken === "string" &&
    (value as { mfaToken: string }).mfaToken.length > 0
  );
}

async function mfaRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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

export const mfaApi = {
  getStatus: () => mfaRequest<MfaStatus>("GET", "/api/me/mfa"),
  setup: () => mfaRequest<MfaSetupResponse>("POST", "/api/me/mfa/setup", {}),
  enable: (code: string) => mfaRequest<MfaEnableResponse>("POST", "/api/me/mfa/enable", { code }),
  disable: (input: { password?: string; code?: string }) =>
    mfaRequest<MfaDisableResponse>("POST", "/api/me/mfa/disable", input),
  verifyLogin: (mfaToken: string, code: string) =>
    mfaRequest<Me>("POST", "/api/auth/mfa/verify", { mfaToken, code }),
};

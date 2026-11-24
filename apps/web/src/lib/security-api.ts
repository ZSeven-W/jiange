import { ApiError } from "@/lib/api";

export type PATScope = "read" | "write" | "admin";

export interface PersonalAccessToken {
  id: number;
  userId: number;
  name: string;
  tokenPrefix: string;
  scopes: PATScope[];
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
}

export interface CreatePATInput {
  name: string;
  scopes?: PATScope[];
  expiresInDays?: number | null;
}

export interface CreatePATResult {
  token: PersonalAccessToken;
  rawToken: string;
}

async function securityRequest<T>(
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
    throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText, data);
  }
  return data as T;
}

export const patApi = {
  list: async (signal?: AbortSignal): Promise<PersonalAccessToken[]> => {
    const data = await securityRequest<{ tokens?: PersonalAccessToken[] }>(
      "GET",
      "/api/me/tokens",
      undefined,
      signal,
    );
    return data.tokens ?? [];
  },

  create: (input: CreatePATInput): Promise<CreatePATResult> =>
    securityRequest<CreatePATResult>("POST", "/api/me/tokens", input),

  revoke: (tokenId: number): Promise<void> =>
    securityRequest<void>("DELETE", `/api/me/tokens/${tokenId}`),
};

export const securityApi = {
  listPATs: patApi.list,
  createPAT: patApi.create,
  revokePAT: patApi.revoke,
};

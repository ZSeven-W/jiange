import { ApiError } from "@/lib/api";

export type SSOProviderType =
  | "oidc"
  | "oauth2"
  | "saml"
  | "feishu"
  | "wecom"
  | "dingtalk"
  | "github"
  | "google";

export type SSODefaultRole = "member" | "admin";

export interface PublicSSOProvider {
  id: number;
  slug: string;
  name: string;
  providerType: SSOProviderType;
}

export interface SSOProvider {
  id: number;
  workspaceId: number;
  slug: string;
  name: string;
  providerType: SSOProviderType;
  enabled: boolean;
  issuerUrl: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  clientId: string;
  hasClientSecret: boolean;
  secretHint: string;
  scopes: string;
  autoCreateUser: boolean;
  defaultRole: SSODefaultRole;
  allowedDomains: string;
  samlEntityId?: string;
  samlSsoUrl?: string;
  samlIdpCertPem?: string;
  samlSpEntityId?: string;
  samlAttributeEmail?: string;
  samlAttributeName?: string;
  createdBy?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SSOProviderInput {
  slug: string;
  name: string;
  providerType: SSOProviderType;
  enabled: boolean;
  issuerUrl?: string;
  authUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  autoCreateUser: boolean;
  defaultRole: SSODefaultRole;
  allowedDomains?: string;
  samlEntityId?: string;
  samlSsoUrl?: string;
  samlIdpCertPem?: string;
  samlSpEntityId?: string;
  samlAttributeEmail?: string;
  samlAttributeName?: string;
}

export interface SSOProviderPatch {
  slug?: string;
  name?: string;
  providerType?: SSOProviderType;
  enabled?: boolean;
  issuerUrl?: string;
  authUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  clientId?: string;
  clientSecret?: string;
  clearClientSecret?: boolean;
  scopes?: string;
  autoCreateUser?: boolean;
  defaultRole?: SSODefaultRole;
  allowedDomains?: string;
  samlEntityId?: string;
  samlSsoUrl?: string;
  samlIdpCertPem?: string;
  samlSpEntityId?: string;
  samlAttributeEmail?: string;
  samlAttributeName?: string;
}

export interface SSODiscoveryResult {
  issuerUrl: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
}

async function ssoRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers:
      body === undefined
        ? extraHeaders
        : { "Content-Type": "application/json", ...extraHeaders },
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

function ssoBaseOrigin(origin?: string): string {
  const base =
    origin ??
    (typeof window !== "undefined" ? window.location.origin : "https://your-jiange.example");
  return base.replace(/\/+$/, "");
}

export function buildSSOCallbackUrl(slug: string, origin?: string): string {
  const cleanSlug = slug.trim() || "your-slug";
  return `${ssoBaseOrigin(origin)}/api/auth/sso/${encodeURIComponent(cleanSlug)}/callback`;
}

export function buildSAMLMetadataUrl(slug: string, origin?: string): string {
  const cleanSlug = slug.trim() || "your-slug";
  return `${ssoBaseOrigin(origin)}/api/auth/sso/${encodeURIComponent(cleanSlug)}/metadata.xml`;
}

export function buildSAMLAcsUrl(slug: string, origin?: string): string {
  const cleanSlug = slug.trim() || "your-slug";
  return `${ssoBaseOrigin(origin)}/api/auth/sso/${encodeURIComponent(cleanSlug)}/acs`;
}

export function buildSSOStartUrl(slug: string, redirectTo?: string): string {
  const base = `/api/auth/sso/${encodeURIComponent(slug)}/start`;
  if (!redirectTo) return base;
  return `${base}?redirect=${encodeURIComponent(redirectTo)}`;
}

export const ssoApi = {
  listPublicProviders: () =>
    ssoRequest<{ providers: PublicSSOProvider[] }>("GET", "/api/auth/sso/providers").then(
      (r) => r.providers ?? [],
    ),
  listWorkspaceProviders: (wsId: number, userId: number) =>
    ssoRequest<{ providers: SSOProvider[] }>(
      "GET",
      `/api/workspaces/${wsId}/sso/providers`,
      undefined,
      { "X-Jiange-User-Id": String(userId) },
    ).then((r) => r.providers ?? []),
  createProvider: (wsId: number, userId: number, input: SSOProviderInput) =>
    ssoRequest<SSOProvider>(
      "POST",
      `/api/workspaces/${wsId}/sso/providers`,
      input,
      { "X-Jiange-User-Id": String(userId) },
    ),
  updateProvider: (wsId: number, providerId: number, userId: number, patch: SSOProviderPatch) =>
    ssoRequest<SSOProvider>(
      "PATCH",
      `/api/workspaces/${wsId}/sso/providers/${providerId}`,
      patch,
      { "X-Jiange-User-Id": String(userId) },
    ),
  deleteProvider: (wsId: number, providerId: number, userId: number) =>
    ssoRequest<void>(
      "DELETE",
      `/api/workspaces/${wsId}/sso/providers/${providerId}`,
      undefined,
      { "X-Jiange-User-Id": String(userId) },
    ),
  discover: (wsId: number, userId: number, issuerUrl: string) =>
    ssoRequest<SSODiscoveryResult>(
      "POST",
      `/api/workspaces/${wsId}/sso/discover`,
      { issuerUrl },
      { "X-Jiange-User-Id": String(userId) },
    ),
};

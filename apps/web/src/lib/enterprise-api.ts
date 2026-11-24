import { ApiError } from "@/lib/api";

export interface AuditLogEntry {
  id: number;
  workspaceId: number;
  actorId: number;
  actorName: string;
  actorEmail: string;
  action: string;
  resourceType: string;
  resourceId: number;
  resourceTitle: string;
  detail: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
}

export interface AuditLogQuery {
  action?: string;
  resourceType?: string;
  actorId?: number;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogPage {
  items: AuditLogEntry[];
  total: number;
  actions: string[];
}

export type DlpAction = "warn" | "block";

export interface WorkspaceSecurityPolicy {
  workspaceId: number;
  watermarkEnabled: boolean;
  watermarkText: string;
  watermarkShowUser: boolean;
  watermarkShowEmail: boolean;
  watermarkShowDate: boolean;
  watermarkOpacity: number;
  dlpEnabled?: boolean;
  dlpKeywords?: string[];
  dlpAction?: DlpAction;
  dlpBlockPublicShare?: boolean;
  retentionDays?: number;
  updatedBy: number;
  updatedAt: string;
}

export interface WorkspaceSecurityPolicyPatch {
  watermarkEnabled?: boolean;
  watermarkText?: string;
  watermarkShowUser?: boolean;
  watermarkShowEmail?: boolean;
  watermarkShowDate?: boolean;
  watermarkOpacity?: number;
  dlpEnabled?: boolean;
  dlpKeywords?: string[];
  dlpAction?: DlpAction;
  dlpBlockPublicShare?: boolean;
  retentionDays?: number;
}

export interface DlpMatch {
  rule: string;
  match: string;
  snippet: string;
}

export interface DlpCheckPayload {
  text: string;
  keywords?: string[];
  action?: DlpAction;
}

export interface DlpCheckResult {
  matched: boolean;
  action: DlpAction;
  matches: DlpMatch[];
}

async function enterpriseRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? extraHeaders : { "Content-Type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText, data);
  return data as T;
}

function userHeaders(userId?: number): Record<string, string> | undefined {
  return userId && userId > 0 ? { "X-Jiange-User-Id": String(userId) } : undefined;
}

function buildAuditQueryString(query?: AuditLogQuery): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.action?.trim()) params.set("action", query.action.trim());
  if (query.resourceType?.trim()) params.set("resourceType", query.resourceType.trim());
  if (query.actorId && query.actorId > 0) params.set("actorId", String(query.actorId));
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.from?.trim()) params.set("from", query.from.trim());
  if (query.to?.trim()) params.set("to", query.to.trim());
  if (typeof query.limit === "number" && query.limit >= 0) params.set("limit", String(query.limit));
  if (typeof query.offset === "number" && query.offset >= 0) params.set("offset", String(query.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const enterpriseApi = {
  listAuditLogs: (wsId: number, query?: AuditLogQuery, userId?: number, signal?: AbortSignal) =>
    enterpriseRequest<AuditLogPage>(
      "GET",
      `/api/workspaces/${wsId}/audit-logs${buildAuditQueryString(query)}`,
      undefined,
      signal,
      userHeaders(userId),
    ),

  auditLogsExportUrl: (wsId: number, query?: Omit<AuditLogQuery, "limit" | "offset">) =>
    `/api/workspaces/${wsId}/audit-logs/export${buildAuditQueryString(query)}`,

  exportAuditLogsCsv: async (
    wsId: number,
    query?: Omit<AuditLogQuery, "limit" | "offset">,
    userId?: number,
  ): Promise<{ blob: Blob; filename: string }> => {
    const url = enterpriseApi.auditLogsExportUrl(wsId, query);
    const res = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: userHeaders(userId),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText, data);
    }
    const disp = res.headers.get("Content-Disposition") ?? "";
    const match = /filename="?([^"]+)"?/i.exec(disp);
    const filename = match?.[1] || `audit-logs-ws-${wsId}.csv`;
    const blob = await res.blob();
    return { blob, filename };
  },

  getSecurityPolicy: (wsId: number, userId?: number, signal?: AbortSignal) =>
    enterpriseRequest<WorkspaceSecurityPolicy>(
      "GET",
      `/api/workspaces/${wsId}/security-policy`,
      undefined,
      signal,
      userHeaders(userId),
    ),

  updateSecurityPolicy: (wsId: number, patch: WorkspaceSecurityPolicyPatch, userId?: number) =>
    enterpriseRequest<WorkspaceSecurityPolicy>(
      "PUT",
      `/api/workspaces/${wsId}/security-policy`,
      patch,
      undefined,
      userHeaders(userId),
    ),

  checkDlp: (wsId: number, payload: DlpCheckPayload, userId?: number) =>
    enterpriseRequest<DlpCheckResult>(
      "POST",
      `/api/workspaces/${wsId}/dlp/check`,
      payload,
      undefined,
      userHeaders(userId),
    ),
};

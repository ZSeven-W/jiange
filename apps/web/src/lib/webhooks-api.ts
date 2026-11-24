import { ApiError } from "@/lib/api";

export type WebhookEventType =
  | "doc.created"
  | "doc.deleted"
  | "share.updated"
  | "base.record_mutated"
  | "sheet.cells_updated"
  | "slides.version_created"
  | "webhook.test";

export const SUBSCRIBABLE_WEBHOOK_EVENTS: readonly WebhookEventType[] = [
  "doc.created",
  "doc.deleted",
  "share.updated",
  "base.record_mutated",
  "sheet.cells_updated",
  "slides.version_created",
] as const;

export const MAX_WEBHOOKS_PER_WORKSPACE = 25;

export interface WorkspaceWebhook {
  id: number;
  workspaceId: number;
  name: string;
  url: string;
  hasSecret: boolean;
  secretHint: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdBy?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: number;
  webhookId: number;
  workspaceId: number;
  eventType: WebhookEventType | string;
  payload: Record<string, unknown>;
  statusCode: number;
  responseBody: string;
  attempt: number;
  success: boolean;
  errorMsg: string;
  createdAt: string;
}

export interface WorkspaceWebhookInput {
  name: string;
  url: string;
  secret?: string;
  events: WebhookEventType[];
  enabled?: boolean;
}

export interface WorkspaceWebhookPatch {
  name?: string;
  url?: string;
  secret?: string;
  regenerateSecret?: boolean;
  events?: WebhookEventType[];
  enabled?: boolean;
}

export interface CreateWebhookResult {
  webhook: WorkspaceWebhook;
  signingSecret: string;
}

export interface UpdateWebhookResult {
  webhook: WorkspaceWebhook;
  signingSecret?: string;
}

export interface TestWebhookResult {
  delivery: WebhookDelivery;
  latencyMs?: number;
}

async function webhookRequest<T>(
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

export const webhooksApi = {
  list: (wsId: number, userId: number) =>
    webhookRequest<{ webhooks: WorkspaceWebhook[] }>(
      "GET",
      `/api/workspaces/${wsId}/webhooks`,
      undefined,
      { "X-Jiange-User-Id": String(userId) },
    ).then((r) => r.webhooks ?? []),

  create: (wsId: number, userId: number, input: WorkspaceWebhookInput) =>
    webhookRequest<CreateWebhookResult>(
      "POST",
      `/api/workspaces/${wsId}/webhooks`,
      input,
      { "X-Jiange-User-Id": String(userId) },
    ),

  update: (wsId: number, webhookId: number, userId: number, patch: WorkspaceWebhookPatch) =>
    webhookRequest<UpdateWebhookResult>(
      "PATCH",
      `/api/workspaces/${wsId}/webhooks/${webhookId}`,
      patch,
      { "X-Jiange-User-Id": String(userId) },
    ),

  remove: (wsId: number, webhookId: number, userId: number) =>
    webhookRequest<void>(
      "DELETE",
      `/api/workspaces/${wsId}/webhooks/${webhookId}`,
      undefined,
      { "X-Jiange-User-Id": String(userId) },
    ),

  test: (wsId: number, webhookId: number, userId: number) =>
    webhookRequest<TestWebhookResult>(
      "POST",
      `/api/workspaces/${wsId}/webhooks/${webhookId}/test`,
      {},
      { "X-Jiange-User-Id": String(userId) },
    ),

  listDeliveries: (wsId: number, webhookId: number, userId: number, limit?: number) => {
    const qs = limit && limit > 0 ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return webhookRequest<{ deliveries: WebhookDelivery[] }>(
      "GET",
      `/api/workspaces/${wsId}/webhooks/${webhookId}/deliveries${qs}`,
      undefined,
      { "X-Jiange-User-Id": String(userId) },
    ).then((r) => r.deliveries ?? []);
  },
};

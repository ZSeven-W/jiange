import { ApiError } from "@/lib/api";

export type NotificationChannelKind =
  | "smtp"
  | "feishu_bot"
  | "dingtalk_bot"
  | "wecom_bot"
  | "slack_bot";

export type NotificationChannelEvent =
  | "mention"
  | "comment_reply"
  | "automation"
  | "share_updated";

export const NOTIFICATION_CHANNEL_KINDS: readonly NotificationChannelKind[] = [
  "smtp",
  "feishu_bot",
  "dingtalk_bot",
  "wecom_bot",
  "slack_bot",
] as const;

export const NOTIFICATION_CHANNEL_EVENTS: readonly NotificationChannelEvent[] = [
  "mention",
  "comment_reply",
  "automation",
  "share_updated",
] as const;

export const MAX_NOTIFICATION_CHANNELS_PER_WORKSPACE = 20;

export interface SMTPChannelConfigInput {
  host: string;
  port: number;
  username?: string;
  password?: string;
  from: string;
  to: string[];
  useTLS?: boolean;
}

export interface BotChannelConfigInput {
  webhookUrl: string;
  secret?: string;
}

export type NotificationChannelConfigInput = SMTPChannelConfigInput | BotChannelConfigInput;

export interface NotificationChannel {
  id: number;
  workspaceId: number;
  name: string;
  kind: NotificationChannelKind;
  configHint: string;
  events: NotificationChannelEvent[];
  enabled: boolean;
  lastStatus: string;
  lastError: string;
  lastSentAt?: string;
  createdBy?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNotificationChannelInput {
  name: string;
  kind: NotificationChannelKind;
  config: NotificationChannelConfigInput;
  events: NotificationChannelEvent[];
  enabled?: boolean;
}

export interface UpdateNotificationChannelInput {
  name?: string;
  kind?: NotificationChannelKind;
  config?: NotificationChannelConfigInput;
  events?: NotificationChannelEvent[];
  enabled?: boolean;
}

export interface TestNotificationChannelResult {
  ok: boolean;
  status: string;
  error: string;
  latencyMs: number;
  sentAt: string;
  channel: NotificationChannel;
}

async function channelRequest<T>(
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

export const notificationChannelsApi = {
  list: (wsId: number, userId: number) =>
    channelRequest<{ channels: NotificationChannel[] }>(
      "GET",
      `/api/workspaces/${wsId}/notification-channels`,
      undefined,
      { "X-Jiange-User-Id": String(userId) },
    ).then((r) => r.channels ?? []),

  create: (wsId: number, userId: number, input: CreateNotificationChannelInput) =>
    channelRequest<{ channel: NotificationChannel }>(
      "POST",
      `/api/workspaces/${wsId}/notification-channels`,
      input,
      { "X-Jiange-User-Id": String(userId) },
    ).then((r) => r.channel),

  update: (
    wsId: number,
    channelId: number,
    userId: number,
    patch: UpdateNotificationChannelInput,
  ) =>
    channelRequest<{ channel: NotificationChannel }>(
      "PATCH",
      `/api/workspaces/${wsId}/notification-channels/${channelId}`,
      patch,
      { "X-Jiange-User-Id": String(userId) },
    ).then((r) => r.channel),

  remove: (wsId: number, channelId: number, userId: number) =>
    channelRequest<void>(
      "DELETE",
      `/api/workspaces/${wsId}/notification-channels/${channelId}`,
      undefined,
      { "X-Jiange-User-Id": String(userId) },
    ),

  test: (wsId: number, channelId: number, userId: number) =>
    channelRequest<TestNotificationChannelResult>(
      "POST",
      `/api/workspaces/${wsId}/notification-channels/${channelId}/test`,
      {},
      { "X-Jiange-User-Id": String(userId) },
    ),
};

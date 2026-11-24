import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellRing,
  Bot,
  CheckCircle2,
  Clock,
  Lock,
  Mail,
  Pencil,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  MAX_NOTIFICATION_CHANNELS_PER_WORKSPACE,
  NOTIFICATION_CHANNEL_EVENTS,
  NOTIFICATION_CHANNEL_KINDS,
  notificationChannelsApi,
  type NotificationChannel,
  type NotificationChannelConfigInput,
  type NotificationChannelEvent,
  type NotificationChannelKind,
} from "@/lib/notification-channels-api";
import { FeishuSelect } from "@/components/feishu-select";
import { ask } from "@/components/ui/ask";
import { useI18n, type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface NotificationChannelTestSummary {
  ok: boolean;
  status: string;
  error: string;
  latencyMs: number;
  sentAt: string;
}

export function getChannelKindLabel(kind: NotificationChannelKind | string, t: TFunc): string {
  switch (kind) {
    case "smtp":
      return t("邮件 SMTP");
    case "feishu_bot":
      return t("飞书群机器人");
    case "dingtalk_bot":
      return t("钉钉群机器人");
    case "wecom_bot":
      return t("企业微信机器人");
    case "slack_bot":
      return t("Slack Webhook");
    default:
      return kind;
  }
}

export function getNotificationEventLabel(event: NotificationChannelEvent | string, t: TFunc): string {
  switch (event) {
    case "mention":
      return t("被 @提及");
    case "comment_reply":
      return t("评论回复");
    case "automation":
      return t("多维表自动化触发");
    case "share_updated":
      return t("分享权限变更");
    default:
      return event;
  }
}

export function getNotificationEventDescription(
  event: NotificationChannelEvent,
  t: TFunc,
): string {
  switch (event) {
    case "mention":
      return t("成员在文档评论中被 @提及时即时推送");
    case "comment_reply":
      return t("文档评论收到新回复时自动推送提醒");
    case "automation":
      return t("多维表自动化流程触发执行时同步推送");
    case "share_updated":
      return t("文档协作者权限或分享配置变更时推送");
  }
}

function botWebhookPlaceholder(kind: NotificationChannelKind): string {
  switch (kind) {
    case "feishu_bot":
      return "https://open.feishu.cn/open-apis/bot/v2/hook/...";
    case "dingtalk_bot":
      return "https://oapi.dingtalk.com/robot/send?access_token=...";
    case "wecom_bot":
      return "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...";
    case "slack_bot":
      return "https://hooks.slack.com/services/T00000000/B00000000/...";
    default:
      return "https://...";
  }
}

function kindSupportsSecret(kind: NotificationChannelKind): boolean {
  return kind === "feishu_bot" || kind === "dingtalk_bot";
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function parseRecipientsList(raw: string): string[] {
  return raw
    .split(/[,，;\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface ChannelFormState {
  name: string;
  kind: NotificationChannelKind;
  // SMTP fields
  smtpHost: string;
  smtpPort: string;
  smtpUsername: string;
  smtpPassword: string;
  smtpFrom: string;
  smtpTo: string;
  smtpUseTLS: boolean;
  // Bot webhook fields
  webhookUrl: string;
  secret: string;
  // Common fields
  events: NotificationChannelEvent[];
  enabled: boolean;
}

function emptyChannelForm(kind: NotificationChannelKind = "feishu_bot"): ChannelFormState {
  return {
    name: "",
    kind,
    smtpHost: "",
    smtpPort: "587",
    smtpUsername: "",
    smtpPassword: "",
    smtpFrom: "",
    smtpTo: "",
    smtpUseTLS: true,
    webhookUrl: "",
    secret: "",
    events: ["mention", "comment_reply", "automation"],
    enabled: true,
  };
}

function formFromChannel(ch: NotificationChannel): ChannelFormState {
  return {
    ...emptyChannelForm(ch.kind),
    name: ch.name,
    kind: ch.kind,
    events: ch.events.length > 0 ? [...ch.events] : [],
    enabled: ch.enabled,
  };
}

export function OrgNotificationsPanel({
  workspaceId,
  userId,
  canAdmin,
  initialEditorOpen = false,
  initialEditingChannel = null,
  initialKind,
  initialTestResults,
}: {
  workspaceId: number;
  userId: number;
  canAdmin: boolean;
  initialEditorOpen?: boolean;
  initialEditingChannel?: NotificationChannel | null;
  initialKind?: NotificationChannelKind;
  initialTestResults?: Record<number, NotificationChannelTestSummary>;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();

  const [editorOpen, setEditorOpen] = useState(
    initialEditorOpen || Boolean(initialEditingChannel),
  );
  const [editing, setEditing] = useState<NotificationChannel | null>(initialEditingChannel);
  const [form, setForm] = useState<ChannelFormState>(() =>
    initialEditingChannel
      ? formFromChannel(initialEditingChannel)
      : emptyChannelForm(initialKind ?? "feishu_bot"),
  );
  const [formError, setFormError] = useState("");

  const [testResults, setTestResults] = useState<Record<number, NotificationChannelTestSummary>>(
    () => initialTestResults ?? {},
  );
  const [testingId, setTestingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const queryKey = ["workspace-notification-channels", workspaceId, userId];
  const channelsQuery = useQuery({
    queryKey,
    queryFn: () => notificationChannelsApi.list(workspaceId, userId),
    enabled: canAdmin && workspaceId > 0,
  });
  const channels = channelsQuery.data ?? [];

  useEffect(() => {
    if (!editorOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditorOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editorOpen]);

  const withFeedback = async (fn: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else if (e instanceof Error) setError(e.message);
      else setError(t("操作失败，请检查后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const openCreateModal = () => {
    setEditing(null);
    setForm(emptyChannelForm("feishu_bot"));
    setFormError("");
    setEditorOpen(true);
  };

  const openEditModal = (ch: NotificationChannel) => {
    setEditing(ch);
    setForm(formFromChannel(ch));
    setFormError("");
    setEditorOpen(true);
  };

  const toggleEvent = (ev: NotificationChannelEvent) => {
    setForm((prev) => {
      const exists = prev.events.includes(ev);
      return {
        ...prev,
        events: exists ? prev.events.filter((x) => x !== ev) : [...prev.events, ev],
      };
    });
  };

  const buildConfigInput = (isEditSameKind: boolean): { config?: NotificationChannelConfigInput; err?: string } => {
    if (form.kind === "smtp") {
      const host = form.smtpHost.trim();
      const port = Number.parseInt(form.smtpPort.trim(), 10);
      const from = form.smtpFrom.trim();
      const to = parseRecipientsList(form.smtpTo);
      const username = form.smtpUsername.trim();
      const password = form.smtpPassword;
      const anyFilled = Boolean(host || from || to.length > 0 || username || password);
      if (isEditSameKind && !anyFilled) {
        return {};
      }
      if (!host) return { err: t("请填写 SMTP 服务器地址") };
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        return { err: t("SMTP 端口需为 1-65535 之间的整数") };
      }
      if (!from) return { err: t("请填写发件人邮箱地址") };
      if (to.length === 0) return { err: t("请至少填写一个收件人邮箱地址") };
      return {
        config: {
          host,
          port,
          username: username || undefined,
          password: password || undefined,
          from,
          to,
          useTLS: form.smtpUseTLS,
        },
      };
    }

    const webhookUrl = form.webhookUrl.trim();
    const secret = form.secret.trim();
    if (isEditSameKind && !webhookUrl && !secret) {
      return {};
    }
    if (!webhookUrl && !isEditSameKind) {
      return { err: t("请填写机器人 Webhook 地址") };
    }
    return {
      config: {
        webhookUrl,
        ...(kindSupportsSecret(form.kind) && secret ? { secret } : {}),
      },
    };
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFormError("");

    const name = form.name.trim();
    if (!name) {
      setFormError(t("请填写通知渠道名称"));
      return;
    }
    if (form.events.length === 0) {
      setFormError(t("请至少勾选一个订阅事件"));
      return;
    }
    const isEditSameKind = editing !== null && editing.kind === form.kind;
    const { config, err } = buildConfigInput(isEditSameKind);
    if (err) {
      setFormError(err);
      return;
    }

    setBusy(true);
    try {
      if (editing) {
        await notificationChannelsApi.update(workspaceId, editing.id, userId, {
          name,
          kind: form.kind,
          ...(config ? { config } : {}),
          events: form.events,
          enabled: form.enabled,
        });
        setNotice(t("通知渠道已更新"));
      } else {
        if (!config) {
          setFormError(t("请完整填写渠道连接配置"));
          return;
        }
        await notificationChannelsApi.create(workspaceId, userId, {
          name,
          kind: form.kind,
          config,
          events: form.events,
          enabled: form.enabled,
        });
        setNotice(t("通知渠道已创建"));
      }
      await qc.invalidateQueries({ queryKey });
      setEditorOpen(false);
    } catch (submitErr) {
      if (submitErr instanceof ApiError) setFormError(submitErr.message);
      else if (submitErr instanceof Error) setFormError(submitErr.message);
      else setFormError(t("操作失败，请检查后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const handleTestChannel = async (ch: NotificationChannel) => {
    if (testingId !== null) return;
    setTestingId(ch.id);
    setError("");
    setNotice("");
    const started = performance.now();
    try {
      const res = await notificationChannelsApi.test(workspaceId, ch.id, userId);
      const elapsed =
        typeof res.latencyMs === "number" && res.latencyMs >= 0
          ? res.latencyMs
          : Math.max(1, Math.round(performance.now() - started));
      setTestResults((prev) => ({
        ...prev,
        [ch.id]: {
          ok: res.ok,
          status: res.status,
          error: res.error,
          latencyMs: elapsed,
          sentAt: res.sentAt,
        },
      }));
      await qc.invalidateQueries({ queryKey });
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else if (e instanceof Error) setError(e.message);
      else setError(t("发送测试失败，请稍后重试。"));
    } finally {
      setTestingId(null);
    }
  };

  if (!canAdmin) {
    return (
      <section className="rounded-lg border bg-surface p-6 text-center" data-org-notifications-panel>
        <ShieldAlert size={22} className="mx-auto mb-2 text-subtle" />
        <p className="text-[14px] font-medium">{t("仅空间所有者或管理员可管理外部通知渠道")}</p>
        <p className="mt-1 text-[12px] text-subtle">
          {t("支持配置 SMTP 邮件与飞书、钉钉、企业微信、Slack 群机器人，将 @提及、评论回复与自动化事件同步推送到团队常用工具。")}
        </p>
      </section>
    );
  }

  const fieldCls =
    "mt-1 h-9 w-full rounded-md border bg-surface px-2.5 text-[13px] outline-none focus:border-primary";
  const atLimit = channels.length >= MAX_NOTIFICATION_CHANNELS_PER_WORKSPACE;
  const kindOptions = NOTIFICATION_CHANNEL_KINDS.map((k) => ({
    value: k,
    label: getChannelKindLabel(k, t),
  }));

  return (
    <div className="space-y-4" data-org-notifications-panel>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-[13px] text-primary"
        >
          {notice}
        </p>
      )}

      <section className="rounded-lg border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">
              <BellRing size={16} className="text-primary" />
              {t("外部通知渠道")}
              <span className="rounded bg-sidebar px-1.5 py-0.5 text-[11px] font-normal text-subtle">
                {channels.length} / {MAX_NOTIFICATION_CHANNELS_PER_WORKSPACE}
              </span>
            </h2>
            <p className="mt-0.5 text-[12px] text-subtle">
              {t("配置企业邮箱（SMTP）及飞书、钉钉、企业微信、Slack 群机器人，凭据采用 AES-256-GCM 加密存储，不以明文返回。")}
            </p>
          </div>
          <button
            type="button"
            disabled={busy || atLimit}
            onClick={openCreateModal}
            data-notif-channel-create-btn
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={14} />
            {t("新建通知渠道")}
          </button>
        </div>

        <div className="mt-4 space-y-2.5" data-notif-channel-list>
          {channelsQuery.isPending ? (
            <p className="py-6 text-center text-[13px] text-subtle">{t("正在加载通知渠道…")}</p>
          ) : channels.length === 0 ? (
            <div className="rounded-md border border-dashed py-8 text-center">
              <BellRing size={20} className="mx-auto mb-2 text-subtle" />
              <p className="text-[13px] font-medium text-foreground">{t("尚未配置外部通知渠道")}</p>
              <p className="mt-1 text-[12px] text-subtle">
                {t("点击右上角「新建通知渠道」，接入邮件 SMTP 或群机器人，第一时间获取重要协作动态。")}
              </p>
            </div>
          ) : (
            channels.map((ch) => {
              const testRes = testResults[ch.id];
              const isTesting = testingId === ch.id;
              const hasPersistedStatus = Boolean(ch.lastStatus);
              return (
                <div
                  key={ch.id}
                  data-notif-channel-card={ch.id}
                  className="rounded-lg border bg-surface p-3.5 transition-colors hover:border-primary/30"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[14px] font-semibold text-foreground">
                          {ch.name}
                        </span>
                        <span
                          data-notif-channel-kind={ch.kind}
                          className="inline-flex items-center gap-1 rounded border bg-sidebar/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                        >
                          {ch.kind === "smtp" ? <Mail size={11} /> : <Bot size={11} />}
                          {getChannelKindLabel(ch.kind, t)}
                        </span>
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[11px]",
                            ch.enabled ? "bg-primary/10 text-primary" : "bg-sidebar text-subtle",
                          )}
                        >
                          {ch.enabled ? t("已启用") : t("已停用")}
                        </span>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border bg-sidebar/40 px-2.5 py-1.5">
                        <Lock size={12} className="shrink-0 text-subtle" />
                        <code
                          data-notif-channel-hint={ch.id}
                          className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground"
                        >
                          {ch.configHint || "••••"}
                        </code>
                      </div>

                      <div
                        className="mt-2 flex flex-wrap items-center gap-1.5"
                        data-notif-channel-events={ch.id}
                      >
                        {ch.events.map((ev) => (
                          <span
                            key={ev}
                            title={ev}
                            className="rounded-full border bg-sidebar/40 px-2 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {getNotificationEventLabel(ev, t)}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={ch.enabled}
                        aria-label={ch.enabled ? t("停用") : t("启用")}
                        data-notif-channel-toggle={ch.id}
                        disabled={busy}
                        onClick={() =>
                          void withFeedback(async () => {
                            await notificationChannelsApi.update(workspaceId, ch.id, userId, {
                              enabled: !ch.enabled,
                            });
                            await qc.invalidateQueries({ queryKey });
                            return ch.enabled ? t("已停用该通知渠道") : t("已启用该通知渠道");
                          })
                        }
                        className={cn(
                          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50",
                          ch.enabled ? "bg-primary" : "bg-[#cfd3da] dark:bg-white/20",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-block size-4 rounded-full bg-white shadow transition-transform",
                            ch.enabled ? "translate-x-4.5" : "translate-x-0.5",
                          )}
                        />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        data-notif-channel-edit-btn={ch.id}
                        onClick={() => openEditModal(ch)}
                        className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[12px] hover:bg-hover disabled:opacity-50"
                      >
                        <Pencil size={11} />
                        {t("编辑")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={t("删除")}
                        data-notif-channel-delete-btn={ch.id}
                        onClick={() =>
                          void withFeedback(async () => {
                            const ok = await ask(
                              t("删除通知渠道「{name}」？", { name: ch.name }),
                              t("删除后将停止向该渠道推送空间通知，此操作无法撤销。"),
                            );
                            if (!ok) return;
                            await notificationChannelsApi.remove(workspaceId, ch.id, userId);
                            await qc.invalidateQueries({ queryKey });
                            return t("通知渠道已删除");
                          })
                        }
                        className="grid size-7 place-items-center rounded border text-subtle hover:bg-destructive/5 hover:text-destructive disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Secondary toolbar: test trigger + inline delivery result badge */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2.5">
                    <button
                      type="button"
                      disabled={isTesting}
                      data-notif-channel-test-btn={ch.id}
                      onClick={() => void handleTestChannel(ch)}
                      className="inline-flex h-7 items-center gap-1 rounded border bg-surface px-2.5 text-[12px] font-medium text-foreground hover:bg-hover disabled:opacity-50"
                    >
                      <Send size={11} className="text-primary" />
                      {isTesting ? t("测试发送中…") : t("发送测试")}
                    </button>

                    {testRes ? (
                      <div
                        data-notif-channel-test-result={ch.id}
                        data-delivery-status={testRes.ok ? "ok" : "error"}
                        className={cn(
                          "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
                          testRes.ok
                            ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                            : "border-destructive/30 bg-destructive/5 text-destructive",
                        )}
                      >
                        {testRes.ok ? (
                          <CheckCircle2 size={12} className="shrink-0" />
                        ) : (
                          <XCircle size={12} className="shrink-0" />
                        )}
                        <span className="font-medium whitespace-nowrap">
                          {testRes.ok ? t("发送成功") : t("发送失败")}
                        </span>
                        <span className="font-mono whitespace-nowrap opacity-80">
                          {testRes.latencyMs} ms
                        </span>
                        {!testRes.ok && testRes.error && (
                          <span className="truncate opacity-90" title={testRes.error}>
                            · {testRes.error}
                          </span>
                        )}
                      </div>
                    ) : hasPersistedStatus ? (
                      <div
                        data-notif-channel-last-delivery={ch.id}
                        data-delivery-status={ch.lastStatus === "ok" ? "ok" : "error"}
                        className={cn(
                          "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
                          ch.lastStatus === "ok"
                            ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                            : "border-destructive/30 bg-destructive/5 text-destructive",
                        )}
                      >
                        {ch.lastStatus === "ok" ? (
                          <CheckCircle2 size={12} className="shrink-0" />
                        ) : (
                          <XCircle size={12} className="shrink-0" />
                        )}
                        <span className="font-medium whitespace-nowrap">
                          {ch.lastStatus === "ok" ? t("最近投递成功") : t("最近投递失败")}
                        </span>
                        {ch.lastSentAt && (
                          <span className="inline-flex items-center gap-1 font-mono whitespace-nowrap opacity-80">
                            <Clock size={10} />
                            {formatTimestamp(ch.lastSentAt)}
                          </span>
                        )}
                        {ch.lastStatus !== "ok" && ch.lastError && (
                          <span className="truncate opacity-90" title={ch.lastError}>
                            · {ch.lastError}
                          </span>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {editorOpen && (
        <div
          className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-black/30 p-4"
          onMouseDown={() => setEditorOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editing ? t("编辑通知渠道") : t("新建通知渠道")}
            data-notif-channel-modal
            className="my-auto w-full max-w-[580px] rounded-xl border bg-surface p-5 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b pb-3">
              <div className="flex items-center gap-2">
                <BellRing size={18} className="text-primary" />
                <h3 className="text-[16px] font-semibold">
                  {editing ? t("编辑通知渠道") : t("新建通知渠道")}
                </h3>
              </div>
              <button
                type="button"
                aria-label={t("关闭")}
                onClick={() => setEditorOpen(false)}
                className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-3.5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-[12px] font-medium">
                  {t("渠道名称")} *
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder={t("如：产品研发飞书群 / 运维邮箱")}
                    data-notif-channel-name-input
                    className={fieldCls}
                  />
                </label>

                <div className="block text-[12px] font-medium">
                  <span>{t("渠道类型")} *</span>
                  <div className="mt-1">
                    <FeishuSelect
                      value={form.kind}
                      options={kindOptions}
                      onChange={(val) =>
                        setForm((f) => ({
                          ...f,
                          kind: val as NotificationChannelKind,
                        }))
                      }
                      ariaLabel={t("渠道类型")}
                      className="h-9 w-full border px-2.5"
                      dataAttr={{ "data-notif-channel-kind-select": true }}
                    />
                  </div>
                </div>
              </div>

              {editing && editing.kind === form.kind && (
                <p className="rounded-md border bg-sidebar/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                  {t("当前已保存加密配置（{hint}）；以下连接参数留空将保持原有配置不变。", {
                    hint: editing.configHint || "••••",
                  })}
                </p>
              )}

              {form.kind === "smtp" ? (
                <div className="space-y-3 rounded-lg border bg-sidebar/20 p-3" data-notif-smtp-fields>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <label className="block text-[12px] font-medium sm:col-span-2">
                      {t("SMTP 服务器地址")} {!editing && "*"}
                      <input
                        type="text"
                        required={!editing || editing.kind !== "smtp"}
                        value={form.smtpHost}
                        onChange={(e) => setForm((f) => ({ ...f, smtpHost: e.target.value }))}
                        placeholder="smtp.example.com"
                        data-notif-smtp-host-input
                        className={cn(fieldCls, "font-mono")}
                      />
                    </label>
                    <label className="block text-[12px] font-medium">
                      {t("端口")} {!editing && "*"}
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        required={!editing || editing.kind !== "smtp"}
                        value={form.smtpPort}
                        onChange={(e) => setForm((f) => ({ ...f, smtpPort: e.target.value }))}
                        placeholder="587"
                        data-notif-smtp-port-input
                        className={cn(fieldCls, "font-mono")}
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block text-[12px] font-medium">
                      {t("SMTP 用户名（可选）")}
                      <input
                        type="text"
                        value={form.smtpUsername}
                        onChange={(e) => setForm((f) => ({ ...f, smtpUsername: e.target.value }))}
                        placeholder="notifier@example.com"
                        data-notif-smtp-user-input
                        className={fieldCls}
                      />
                    </label>
                    <label className="block text-[12px] font-medium">
                      {t("SMTP 密码 / 授权码")}
                      <input
                        type="password"
                        autoComplete="off"
                        value={form.smtpPassword}
                        onChange={(e) => setForm((f) => ({ ...f, smtpPassword: e.target.value }))}
                        placeholder={
                          editing?.kind === "smtp" ? t("留空保持原密码不变") : t("输入邮箱授权码或密码")
                        }
                        data-notif-smtp-pass-input
                        className={fieldCls}
                      />
                    </label>
                  </div>

                  <label className="block text-[12px] font-medium">
                    {t("发件人邮箱")} {!editing && "*"}
                    <input
                      type="email"
                      required={!editing || editing.kind !== "smtp"}
                      value={form.smtpFrom}
                      onChange={(e) => setForm((f) => ({ ...f, smtpFrom: e.target.value }))}
                      placeholder="noreply@example.com"
                      data-notif-smtp-from-input
                      className={fieldCls}
                    />
                  </label>

                  <label className="block text-[12px] font-medium">
                    {t("收件人邮箱（多个地址用逗号或换行分隔）")} {!editing && "*"}
                    <textarea
                      rows={2}
                      required={!editing || editing.kind !== "smtp"}
                      value={form.smtpTo}
                      onChange={(e) => setForm((f) => ({ ...f, smtpTo: e.target.value }))}
                      placeholder="alice@example.com, bob@example.com"
                      data-notif-smtp-to-input
                      className="mt-1 w-full rounded-md border bg-surface px-2.5 py-2 font-mono text-[12px] outline-none focus:border-primary"
                    />
                  </label>

                  <label className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
                    <input
                      type="checkbox"
                      checked={form.smtpUseTLS}
                      onChange={(e) => setForm((f) => ({ ...f, smtpUseTLS: e.target.checked }))}
                      data-notif-smtp-tls-checkbox
                    />
                    {t("启用 TLS / STARTTLS 加密传输（端口 465 自动使用隐式 TLS）")}
                  </label>
                </div>
              ) : (
                <div className="space-y-3 rounded-lg border bg-sidebar/20 p-3" data-notif-bot-fields>
                  <label className="block text-[12px] font-medium">
                    {t("机器人 Webhook 地址")} {!editing && "*"}
                    <input
                      type="url"
                      required={!editing || editing.kind !== form.kind}
                      value={form.webhookUrl}
                      onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
                      placeholder={botWebhookPlaceholder(form.kind)}
                      data-notif-bot-url-input
                      className={cn(fieldCls, "font-mono")}
                    />
                  </label>

                  {kindSupportsSecret(form.kind) && (
                    <label className="block text-[12px] font-medium">
                      {t("加签密钥（可选，HMAC-SHA256）")}
                      <input
                        type="password"
                        autoComplete="off"
                        value={form.secret}
                        onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                        placeholder={
                          editing?.kind === form.kind
                            ? t("留空保持原有加签密钥不变")
                            : t("如机器人开启了签名校验，请填入 Secret")
                        }
                        data-notif-bot-secret-input
                        className={fieldCls}
                      />
                    </label>
                  )}
                </div>
              )}

              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-foreground">
                    {t("订阅事件")} *
                  </span>
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => ({ ...f, events: [...NOTIFICATION_CHANNEL_EVENTS] }))
                      }
                      className="text-primary hover:underline"
                    >
                      {t("全选")}
                    </button>
                    <span className="text-subtle">·</span>
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, events: [] }))}
                      className="text-subtle hover:text-foreground"
                    >
                      {t("清空")}
                    </button>
                  </div>
                </div>

                <div
                  className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2"
                  data-notif-channel-event-checkboxes
                >
                  {NOTIFICATION_CHANNEL_EVENTS.map((ev) => {
                    const checked = form.events.includes(ev);
                    return (
                      <label
                        key={ev}
                        className={cn(
                          "flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition-colors",
                          checked
                            ? "border-primary/50 bg-primary/5"
                            : "bg-sidebar/20 hover:border-primary/30",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleEvent(ev)}
                          data-notif-channel-event-checkbox={ev}
                          className="mt-0.5 shrink-0"
                        />
                        <div className="min-w-0">
                          <div className="text-[12px] font-medium text-foreground">
                            {getNotificationEventLabel(ev, t)}
                          </div>
                          <p className="mt-0.5 text-[11px] text-subtle">
                            {getNotificationEventDescription(ev, t)}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <label className="flex cursor-pointer items-center gap-2 rounded-lg border bg-sidebar/30 px-3 py-2 text-[12px] text-foreground">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                  data-notif-channel-enabled-checkbox
                />
                {t("启用该通知渠道并接收空间推送")}
              </label>

              {formError && (
                <p role="alert" className="text-[12px] text-destructive">
                  {formError}
                </p>
              )}

              <div className="flex justify-end gap-2 border-t pt-3">
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="h-8 rounded-md border px-3 text-[13px] hover:bg-hover"
                >
                  {t("取消")}
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  data-notif-channel-submit-btn
                  className="h-8 rounded-md bg-primary px-4 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? t("保存中…") : t("保存")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  History,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  Trash2,
  Webhook,
  X,
  XCircle,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  MAX_WEBHOOKS_PER_WORKSPACE,
  SUBSCRIBABLE_WEBHOOK_EVENTS,
  webhooksApi,
  type WebhookDelivery,
  type WebhookEventType,
  type WorkspaceWebhook,
} from "@/lib/webhooks-api";
import { ask } from "@/components/ui/ask";
import { useI18n, type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface WebhookEventOption {
  type: WebhookEventType;
}

export const WEBHOOK_EVENT_OPTIONS: readonly WebhookEventOption[] = [
  { type: "doc.created" },
  { type: "doc.deleted" },
  { type: "share.updated" },
  { type: "base.record_mutated" },
  { type: "sheet.cells_updated" },
  { type: "slides.version_created" },
] as const;

export function getWebhookEventLabel(eventType: string, t: TFunc): string {
  switch (eventType) {
    case "doc.created":
      return t("文档创建");
    case "doc.deleted":
      return t("文档删除");
    case "share.updated":
      return t("权限与分享变更");
    case "base.record_mutated":
      return t("多维表记录变更");
    case "sheet.cells_updated":
      return t("电子表格编辑");
    case "slides.version_created":
      return t("幻灯片版本创建");
    case "webhook.test":
      return t("测试事件");
    default:
      return eventType;
  }
}

export function getWebhookEventDescription(eventType: WebhookEventType, t: TFunc): string {
  switch (eventType) {
    case "doc.created":
      return t("新建文档、表格、多维表或演示文稿时触发");
    case "doc.deleted":
      return t("文档移入回收站或彻底删除时触发");
    case "share.updated":
      return t("协作者权限、公开链接或继承策略变更时触发");
    case "base.record_mutated":
      return t("多维表新增、更新或删除记录时触发");
    case "sheet.cells_updated":
      return t("电子表格单元格内容更新时触发");
    case "slides.version_created":
      return t("演示文稿保存新版本快照时触发");
    case "webhook.test":
      return t("管理员手动发送的连通性测试事件");
  }
}

export function formatWebhookSecretHint(secretHint: string): string {
  const clean = secretHint.trim();
  if (!clean) return "****";
  if (clean.startsWith("****")) return clean;
  return `****${clean}`;
}

function formatDeliveryTime(iso: string): string {
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

export interface WebhookTestSummary {
  delivery: WebhookDelivery;
  latencyMs: number;
}

export interface CreatedWebhookSecretBanner {
  webhookName: string;
  secret: string;
}

interface WebhookFormState {
  name: string;
  url: string;
  secret: string;
  regenerateSecret: boolean;
  events: WebhookEventType[];
  enabled: boolean;
}

function emptyWebhookForm(): WebhookFormState {
  return {
    name: "",
    url: "",
    secret: "",
    regenerateSecret: false,
    events: ["doc.created", "doc.deleted"],
    enabled: true,
  };
}

function formFromWebhook(wh: WorkspaceWebhook): WebhookFormState {
  return {
    name: wh.name,
    url: wh.url,
    secret: "",
    regenerateSecret: false,
    events: wh.events.length > 0 ? [...wh.events] : [],
    enabled: wh.enabled,
  };
}

function WebhookDeliveriesDrawer({
  workspaceId,
  webhookId,
  userId,
}: {
  workspaceId: number;
  webhookId: number;
  userId: number;
}) {
  const { t } = useI18n();
  const queryKey = ["workspace-webhook-deliveries", workspaceId, webhookId, userId];
  const deliveriesQuery = useQuery({
    queryKey,
    queryFn: () => webhooksApi.listDeliveries(workspaceId, webhookId, userId, 30),
    enabled: workspaceId > 0 && webhookId > 0,
  });
  const deliveries = deliveriesQuery.data ?? [];

  return (
    <div
      data-webhook-deliveries-drawer={webhookId}
      className="mt-3 rounded-md border bg-sidebar/30 p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
          <History size={13} className="text-primary" />
          <span>{t("投递记录")}</span>
          <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] font-normal text-subtle">
            {t("最近 {n} 条", { n: deliveries.length })}
          </span>
        </div>
        <button
          type="button"
          disabled={deliveriesQuery.isFetching}
          onClick={() => void deliveriesQuery.refetch()}
          data-webhook-deliveries-refresh={webhookId}
          className="inline-flex h-6 items-center gap-1 rounded border bg-surface px-2 text-[11px] text-muted-foreground hover:bg-hover disabled:opacity-50"
        >
          <RefreshCw size={11} className={deliveriesQuery.isFetching ? "animate-spin" : ""} />
          {t("刷新")}
        </button>
      </div>

      {deliveriesQuery.isPending ? (
        <p className="py-4 text-center text-[12px] text-subtle">{t("正在加载投递记录…")}</p>
      ) : deliveriesQuery.isError ? (
        <p role="alert" className="py-3 text-center text-[12px] text-destructive">
          {deliveriesQuery.error instanceof Error
            ? deliveriesQuery.error.message
            : t("加载投递记录失败")}
        </p>
      ) : deliveries.length === 0 ? (
        <p className="py-4 text-center text-[12px] text-subtle">
          {t("暂无投递记录，点击「发送测试事件」即可立即验证回调端点。")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]" data-webhook-deliveries-table={webhookId}>
            <thead>
              <tr className="border-b text-[11px] text-subtle">
                <th className="py-1.5 pr-3 font-medium">{t("事件")}</th>
                <th className="py-1.5 pr-3 font-medium">{t("状态")}</th>
                <th className="py-1.5 pr-3 font-medium">{t("尝试次数")}</th>
                <th className="py-1.5 pr-3 font-medium">{t("投递时间")}</th>
                <th className="py-1.5 font-medium">{t("响应与错误")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {deliveries.map((d) => (
                <tr key={d.id} data-webhook-delivery-row={d.id} className="align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-foreground">
                      {getWebhookEventLabel(d.eventType, t)}
                    </div>
                    <code className="font-mono text-[10px] text-subtle">{d.eventType}</code>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <span
                      data-delivery-status={d.success ? "success" : "failed"}
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
                        d.success
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : "bg-destructive/10 text-destructive",
                      )}
                    >
                      {d.success ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                      {d.statusCode > 0 ? `HTTP ${d.statusCode}` : t("请求失败")}
                    </span>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                    {t("第 {n} 次", { n: d.attempt })}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap font-mono text-[11px] text-subtle">
                    {formatDeliveryTime(d.createdAt)}
                  </td>
                  <td className="max-w-[260px] py-2">
                    {d.errorMsg && (
                      <p className="truncate text-[11px] text-destructive" title={d.errorMsg}>
                        {d.errorMsg}
                      </p>
                    )}
                    {d.responseBody ? (
                      <code
                        className="mt-0.5 block truncate rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                        title={d.responseBody}
                      >
                        {d.responseBody}
                      </code>
                    ) : !d.errorMsg ? (
                      <span className="text-[11px] text-subtle">—</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function OrgWebhooksPanel({
  workspaceId,
  userId,
  canAdmin,
  initialEditorOpen = false,
  initialEditingWebhook = null,
  initialCreatedSecret = null,
  initialExpandedWebhookId = null,
  initialTestResults,
}: {
  workspaceId: number;
  userId: number;
  canAdmin: boolean;
  initialEditorOpen?: boolean;
  initialEditingWebhook?: WorkspaceWebhook | null;
  initialCreatedSecret?: CreatedWebhookSecretBanner | null;
  initialExpandedWebhookId?: number | null;
  initialTestResults?: Record<number, WebhookTestSummary>;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();

  const [editorOpen, setEditorOpen] = useState(
    initialEditorOpen || Boolean(initialEditingWebhook),
  );
  const [editing, setEditing] = useState<WorkspaceWebhook | null>(initialEditingWebhook);
  const [form, setForm] = useState<WebhookFormState>(() =>
    initialEditingWebhook ? formFromWebhook(initialEditingWebhook) : emptyWebhookForm(),
  );
  const [formError, setFormError] = useState("");

  const [createdSecret, setCreatedSecret] = useState<CreatedWebhookSecretBanner | null>(
    initialCreatedSecret,
  );
  const [expandedWebhookId, setExpandedWebhookId] = useState<number | null>(
    initialExpandedWebhookId,
  );
  const [testResults, setTestResults] = useState<Record<number, WebhookTestSummary>>(
    () => initialTestResults ?? {},
  );
  const [testingId, setTestingId] = useState<number | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copiedKey, setCopiedKey] = useState("");

  const webhooksQueryKey = ["workspace-webhooks", workspaceId, userId];

  const webhooksQuery = useQuery({
    queryKey: webhooksQueryKey,
    queryFn: () => webhooksApi.list(workspaceId, userId),
    enabled: canAdmin && workspaceId > 0,
  });

  const webhooks = webhooksQuery.data ?? [];

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

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((cur) => (cur === key ? "" : cur));
      }, 2000);
    } catch {
      setCopiedKey("");
    }
  };

  const openCreateModal = () => {
    setEditing(null);
    setForm(emptyWebhookForm());
    setFormError("");
    setEditorOpen(true);
  };

  const openEditModal = (wh: WorkspaceWebhook) => {
    setEditing(wh);
    setForm(formFromWebhook(wh));
    setFormError("");
    setEditorOpen(true);
  };

  const toggleFormEvent = (ev: WebhookEventType) => {
    setForm((prev) => {
      const exists = prev.events.includes(ev);
      const nextEvents = exists
        ? prev.events.filter((x) => x !== ev)
        : [...prev.events, ev];
      return { ...prev, events: nextEvents };
    });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFormError("");
    const name = form.name.trim();
    const url = form.url.trim();
    if (!name || !url) {
      setFormError(t("请完整填写 Webhook 名称与回调地址"));
      return;
    }
    if (form.events.length === 0) {
      setFormError(t("请至少勾选一个订阅事件"));
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        const res = await webhooksApi.update(workspaceId, editing.id, userId, {
          name,
          url,
          events: form.events,
          enabled: form.enabled,
          ...(form.regenerateSecret
            ? { regenerateSecret: true }
            : form.secret.trim()
              ? { secret: form.secret.trim() }
              : {}),
        });
        if (res.signingSecret) {
          setCreatedSecret({ webhookName: res.webhook.name, secret: res.signingSecret });
        }
        setNotice(t("Webhook 配置已更新"));
      } else {
        const res = await webhooksApi.create(workspaceId, userId, {
          name,
          url,
          events: form.events,
          enabled: form.enabled,
          ...(form.secret.trim() ? { secret: form.secret.trim() } : {}),
        });
        if (res.signingSecret) {
          setCreatedSecret({ webhookName: res.webhook.name, secret: res.signingSecret });
        }
        setNotice(t("Webhook 已创建"));
      }
      await qc.invalidateQueries({ queryKey: webhooksQueryKey });
      setEditorOpen(false);
    } catch (err) {
      if (err instanceof ApiError) setFormError(err.message);
      else if (err instanceof Error) setFormError(err.message);
      else setFormError(t("操作失败，请检查后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const handleTestWebhook = async (wh: WorkspaceWebhook) => {
    if (testingId !== null) return;
    setTestingId(wh.id);
    setError("");
    setNotice("");
    const started = performance.now();
    try {
      const res = await webhooksApi.test(workspaceId, wh.id, userId);
      const elapsed =
        typeof res.latencyMs === "number" && res.latencyMs >= 0
          ? res.latencyMs
          : Math.max(1, Math.round(performance.now() - started));
      setTestResults((prev) => ({
        ...prev,
        [wh.id]: { delivery: res.delivery, latencyMs: elapsed },
      }));
      await qc.invalidateQueries({
        queryKey: ["workspace-webhook-deliveries", workspaceId, wh.id, userId],
      });
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else if (e instanceof Error) setError(e.message);
      else setError(t("发送测试事件失败，请稍后重试。"));
    } finally {
      setTestingId(null);
    }
  };

  if (!canAdmin) {
    return (
      <section className="rounded-lg border bg-surface p-6 text-center" data-org-webhooks-panel>
        <ShieldAlert size={22} className="mx-auto mb-2 text-subtle" />
        <p className="text-[14px] font-medium">{t("仅空间所有者或管理员可配置空间事件 Webhook")}</p>
        <p className="mt-1 text-[12px] text-subtle">
          {t("支持订阅文档、权限分享、多维表、电子表格与幻灯片等空间事件，并通过 HMAC-SHA256 签名实时推送至外部系统。")}
        </p>
      </section>
    );
  }

  const fieldCls =
    "mt-1 h-9 w-full rounded-md border bg-surface px-2.5 text-[13px] outline-none focus:border-primary";
  const atLimit = webhooks.length >= MAX_WEBHOOKS_PER_WORKSPACE;

  return (
    <div className="space-y-4" data-org-webhooks-panel>
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

      {createdSecret && (
        <div
          role="status"
          data-webhook-secret-banner
          className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3.5"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                <KeyRound size={14} className="text-amber-600 dark:text-amber-400" />
                {t("签名密钥已生成：{name}", { name: createdSecret.webhookName })}
              </p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {t("该签名密钥仅展示一次，请立即复制并妥善保存，用于校验 X-Jiange-Signature（HMAC-SHA256）请求头。")}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border bg-surface px-2.5 py-1.5">
                <code
                  data-webhook-signing-secret
                  className="min-w-0 flex-1 break-all font-mono text-[12px] text-foreground select-all"
                >
                  {createdSecret.secret}
                </code>
                <button
                  type="button"
                  data-webhook-copy-secret
                  onClick={() => void handleCopy("created-secret", createdSecret.secret)}
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded border bg-surface px-2.5 text-[12px] hover:bg-hover"
                >
                  {copiedKey === "created-secret" ? (
                    <Check size={12} className="text-primary" />
                  ) : (
                    <Copy size={12} />
                  )}
                  {copiedKey === "created-secret" ? t("已复制") : t("复制密钥")}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setCreatedSecret(null)}
              aria-label={t("关闭")}
              className="grid size-7 shrink-0 place-items-center rounded text-subtle hover:bg-hover"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      <section className="rounded-lg border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">
              <Webhook size={16} className="text-primary" />
              {t("空间事件 Webhook")}
              <span className="rounded bg-sidebar px-1.5 py-0.5 text-[11px] font-normal text-subtle">
                {webhooks.length} / {MAX_WEBHOOKS_PER_WORKSPACE}
              </span>
            </h2>
            <p className="mt-0.5 text-[12px] text-subtle">
              {t("订阅空间内的业务变更事件，服务端将以 HMAC-SHA256 签名异步推送 JSON 载荷，并记录最近投递审计日志。")}
            </p>
          </div>
          <button
            type="button"
            disabled={busy || atLimit}
            onClick={openCreateModal}
            data-webhook-create-btn
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={14} />
            {t("新建 Webhook")}
          </button>
        </div>

        <div className="mt-4 space-y-2.5" data-webhook-list>
          {webhooksQuery.isPending ? (
            <p className="py-6 text-center text-[13px] text-subtle">{t("正在加载 Webhook 列表…")}</p>
          ) : webhooks.length === 0 ? (
            <div className="rounded-md border border-dashed py-8 text-center">
              <Webhook size={20} className="mx-auto mb-2 text-subtle" />
              <p className="text-[13px] font-medium text-foreground">{t("尚未配置空间事件 Webhook")}</p>
              <p className="mt-1 text-[12px] text-subtle">
                {t("点击右上角「新建 Webhook」，填入 HTTPS 接收地址并选择需要监听的空间事件。")}
              </p>
            </div>
          ) : (
            webhooks.map((wh) => {
              const expanded = expandedWebhookId === wh.id;
              const testRes = testResults[wh.id];
              const isTesting = testingId === wh.id;
              return (
                <div
                  key={wh.id}
                  data-webhook-card={wh.id}
                  className="rounded-lg border bg-surface p-3.5 transition-colors hover:border-primary/30"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[14px] font-semibold text-foreground">
                          {wh.name}
                        </span>
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[11px]",
                            wh.enabled ? "bg-primary/10 text-primary" : "bg-sidebar text-subtle",
                          )}
                        >
                          {wh.enabled ? t("已启用") : t("已停用")}
                        </span>
                        {wh.hasSecret && (
                          <span
                            data-webhook-secret-hint={wh.id}
                            className="inline-flex items-center gap-1 rounded border bg-sidebar/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                          >
                            <KeyRound size={10} />
                            {formatWebhookSecretHint(wh.secretHint)}
                          </span>
                        )}
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border bg-sidebar/40 px-2.5 py-1.5">
                        <Link2 size={12} className="shrink-0 text-subtle" />
                        <code
                          data-webhook-url={wh.id}
                          className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground select-all"
                        >
                          {wh.url}
                        </code>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-1.5" data-webhook-events={wh.id}>
                        {wh.events.map((ev) => (
                          <span
                            key={ev}
                            title={ev}
                            className="rounded-full border bg-sidebar/40 px-2 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {getWebhookEventLabel(ev, t)}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={wh.enabled}
                        aria-label={wh.enabled ? t("停用") : t("启用")}
                        data-webhook-toggle={wh.id}
                        disabled={busy}
                        onClick={() =>
                          void withFeedback(async () => {
                            await webhooksApi.update(workspaceId, wh.id, userId, {
                              enabled: !wh.enabled,
                            });
                            await qc.invalidateQueries({ queryKey: webhooksQueryKey });
                            return wh.enabled ? t("已停用该 Webhook") : t("已启用该 Webhook");
                          })
                        }
                        className={cn(
                          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50",
                          wh.enabled ? "bg-primary" : "bg-[#cfd3da] dark:bg-white/20",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-block size-4 rounded-full bg-white shadow transition-transform",
                            wh.enabled ? "translate-x-4.5" : "translate-x-0.5",
                          )}
                        />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        data-webhook-edit-btn={wh.id}
                        onClick={() => openEditModal(wh)}
                        className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[12px] hover:bg-hover disabled:opacity-50"
                      >
                        <Pencil size={11} />
                        {t("编辑")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={t("删除")}
                        data-webhook-delete-btn={wh.id}
                        onClick={() =>
                          void withFeedback(async () => {
                            const ok = await ask(
                              t("删除 Webhook「{name}」？", { name: wh.name }),
                              t("删除后将停止事件推送并清除该 Webhook 的历史投递记录。"),
                            );
                            if (!ok) return;
                            await webhooksApi.remove(workspaceId, wh.id, userId);
                            if (expandedWebhookId === wh.id) setExpandedWebhookId(null);
                            await qc.invalidateQueries({ queryKey: webhooksQueryKey });
                            return t("Webhook 已删除");
                          })
                        }
                        className="grid size-7 place-items-center rounded border text-subtle hover:bg-destructive/5 hover:text-destructive disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Secondary toolbar: test trigger + inline result + delivery audit drawer */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2.5">
                    <button
                      type="button"
                      disabled={isTesting}
                      data-webhook-test-btn={wh.id}
                      onClick={() => void handleTestWebhook(wh)}
                      className="inline-flex h-7 items-center gap-1 rounded border bg-surface px-2.5 text-[12px] font-medium text-foreground hover:bg-hover disabled:opacity-50"
                    >
                      <Send size={11} className="text-primary" />
                      {isTesting ? t("测试发送中…") : t("发送测试事件")}
                    </button>

                    <button
                      type="button"
                      data-webhook-deliveries-btn={wh.id}
                      aria-expanded={expanded}
                      onClick={() => setExpandedWebhookId(expanded ? null : wh.id)}
                      className={cn(
                        "inline-flex h-7 items-center gap-1 rounded border px-2.5 text-[12px] hover:bg-hover",
                        expanded
                          ? "border-primary/40 bg-primary/5 text-primary"
                          : "bg-surface text-muted-foreground",
                      )}
                    >
                      <History size={11} />
                      {t("投递记录")}
                      {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>

                    {testRes && (
                      <div
                        data-webhook-test-result={wh.id}
                        className={cn(
                          "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
                          testRes.delivery.success
                            ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                            : "border-destructive/30 bg-destructive/5 text-destructive",
                        )}
                      >
                        {testRes.delivery.success ? (
                          <CheckCircle2 size={12} className="shrink-0" />
                        ) : (
                          <XCircle size={12} className="shrink-0" />
                        )}
                        <span className="font-medium whitespace-nowrap">
                          {testRes.delivery.statusCode > 0
                            ? `HTTP ${testRes.delivery.statusCode}`
                            : t("请求失败")}
                        </span>
                        <span className="font-mono whitespace-nowrap opacity-80">
                          {testRes.latencyMs} ms
                        </span>
                        {!testRes.delivery.success && testRes.delivery.errorMsg && (
                          <span className="truncate opacity-90" title={testRes.delivery.errorMsg}>
                            · {testRes.delivery.errorMsg}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {expanded && (
                    <WebhookDeliveriesDrawer
                      workspaceId={workspaceId}
                      webhookId={wh.id}
                      userId={userId}
                    />
                  )}
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
            aria-label={editing ? t("编辑 Webhook") : t("新建 Webhook")}
            data-webhook-modal
            className="my-auto w-full max-w-[560px] rounded-xl border bg-surface p-5 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b pb-3">
              <div className="flex items-center gap-2">
                <Webhook size={18} className="text-primary" />
                <h3 className="text-[16px] font-semibold">
                  {editing ? t("编辑 Webhook") : t("新建 Webhook")}
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
              <label className="block text-[12px] font-medium">
                {t("Webhook 名称")} *
                <input
                  type="text"
                  required
                  maxLength={80}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t("如：企业文档同步机器人 / CI 通知")}
                  data-webhook-name-input
                  className={fieldCls}
                />
              </label>

              <label className="block text-[12px] font-medium">
                {t("接收地址（HTTPS URL）")} *
                <input
                  type="url"
                  required
                  value={form.url}
                  onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                  placeholder="https://hooks.example.com/jiange"
                  data-webhook-url-input
                  className={cn(fieldCls, "font-mono")}
                />
              </label>

              <div>
                <label className="block text-[12px] font-medium">
                  {t("签名密钥（可选）")}
                  <input
                    type="password"
                    autoComplete="off"
                    disabled={editing !== null && form.regenerateSecret}
                    value={form.secret}
                    onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                    placeholder={
                      editing?.hasSecret
                        ? t("已配置（{hint}），留空保持不变", {
                            hint: formatWebhookSecretHint(editing.secretHint),
                          })
                        : t("留空将自动生成 32 字节随机签名密钥（推荐）")
                    }
                    data-webhook-secret-input
                    className={cn(fieldCls, "disabled:opacity-50")}
                  />
                </label>
                {editing && (
                  <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={form.regenerateSecret}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          regenerateSecret: e.target.checked,
                          secret: e.target.checked ? "" : f.secret,
                        }))
                      }
                      data-webhook-regenerate-secret
                    />
                    {t("重新生成新的随机签名密钥（保存后仅展示一次）")}
                  </label>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-foreground">
                    {t("订阅事件")} *
                  </span>
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => ({ ...f, events: [...SUBSCRIBABLE_WEBHOOK_EVENTS] }))
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
                  data-webhook-event-checkboxes
                >
                  {WEBHOOK_EVENT_OPTIONS.map((opt) => {
                    const checked = form.events.includes(opt.type);
                    return (
                      <label
                        key={opt.type}
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
                          onChange={() => toggleFormEvent(opt.type)}
                          data-webhook-event-checkbox={opt.type}
                          className="mt-0.5 shrink-0"
                        />
                        <div className="min-w-0">
                          <div className="text-[12px] font-medium text-foreground">
                            {getWebhookEventLabel(opt.type, t)}
                          </div>
                          <code className="block font-mono text-[10px] text-primary/80">
                            {opt.type}
                          </code>
                          <p className="mt-0.5 text-[11px] text-subtle">
                            {getWebhookEventDescription(opt.type, t)}
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
                  data-webhook-enabled-checkbox
                />
                {t("启用该 Webhook 并接收空间事件推送")}
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
                  data-webhook-submit-btn
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

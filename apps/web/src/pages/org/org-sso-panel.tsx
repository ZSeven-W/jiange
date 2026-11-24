import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  buildSSOCallbackUrl,
  ssoApi,
  type SSODefaultRole,
  type SSOProvider,
  type SSOProviderType,
} from "@/lib/sso-api";
import { ask } from "@/components/ui/ask";
import { FeishuSelect } from "@/components/feishu-select";
import { useI18n, type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface SSOProviderPreset {
  type: SSOProviderType;
  slugSuggestion: string;
  nameSuggestion: string;
  issuerUrl: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
}

export const SSO_PROVIDER_PRESETS: readonly SSOProviderPreset[] = [
  {
    type: "oidc",
    slugSuggestion: "corp-oidc",
    nameSuggestion: "企业 OIDC",
    issuerUrl: "",
    authUrl: "",
    tokenUrl: "",
    userinfoUrl: "",
    scopes: "openid email profile",
  },
  {
    type: "feishu",
    slugSuggestion: "feishu",
    nameSuggestion: "飞书 SSO",
    issuerUrl: "https://open.feishu.cn",
    authUrl: "https://open.feishu.cn/open-apis/authen/v1/authorize",
    tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
    userinfoUrl: "https://open.feishu.cn/open-apis/authen/v1/user_info",
    scopes: "contact:user.email:readonly",
  },
  {
    type: "wecom",
    slugSuggestion: "wecom",
    nameSuggestion: "企业微信",
    issuerUrl: "",
    authUrl: "https://open.weixin.qq.com/connect/oauth2/authorize",
    tokenUrl: "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
    userinfoUrl: "https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo",
    scopes: "snsapi_privateinfo",
  },
  {
    type: "dingtalk",
    slugSuggestion: "dingtalk",
    nameSuggestion: "钉钉",
    issuerUrl: "",
    authUrl: "https://login.dingtalk.com/oauth2/auth",
    tokenUrl: "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
    userinfoUrl: "https://api.dingtalk.com/v1.0/contact/users/me",
    scopes: "openid corpid",
  },
  {
    type: "google",
    slugSuggestion: "google",
    nameSuggestion: "Google",
    issuerUrl: "https://accounts.google.com",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: "openid email profile",
  },
  {
    type: "github",
    slugSuggestion: "github",
    nameSuggestion: "GitHub",
    issuerUrl: "",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userinfoUrl: "https://api.github.com/user",
    scopes: "read:user user:email",
  },
];

export function getSSOProviderTypeLabel(type: SSOProviderType, t: TFunc): string {
  switch (type) {
    case "oidc":
      return t("通用 OIDC");
    case "oauth2":
      return "OAuth 2.0";
    case "feishu":
      return t("飞书 SSO");
    case "wecom":
      return t("企业微信");
    case "dingtalk":
      return t("钉钉");
    case "google":
      return "Google";
    case "github":
      return "GitHub";
    default:
      return t("通用 OIDC");
  }
}

interface SSOFormState {
  providerType: SSOProviderType;
  name: string;
  slug: string;
  enabled: boolean;
  issuerUrl: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  allowedDomains: string;
  autoCreateUser: boolean;
  defaultRole: SSODefaultRole;
}

function emptyFormState(): SSOFormState {
  return {
    providerType: "oidc",
    name: "",
    slug: "",
    enabled: true,
    issuerUrl: "",
    authUrl: "",
    tokenUrl: "",
    userinfoUrl: "",
    clientId: "",
    clientSecret: "",
    scopes: "openid email profile",
    allowedDomains: "",
    autoCreateUser: true,
    defaultRole: "member",
  };
}

function formStateFromProvider(p: SSOProvider): SSOFormState {
  return {
    providerType: p.providerType,
    name: p.name,
    slug: p.slug,
    enabled: p.enabled,
    issuerUrl: p.issuerUrl,
    authUrl: p.authUrl,
    tokenUrl: p.tokenUrl,
    userinfoUrl: p.userinfoUrl,
    clientId: p.clientId,
    clientSecret: "",
    scopes: p.scopes || "openid email profile",
    allowedDomains: p.allowedDomains,
    autoCreateUser: p.autoCreateUser,
    defaultRole: p.defaultRole === "admin" ? "admin" : "member",
  };
}

export function OrgSSOPanel({
  workspaceId,
  userId,
  canAdmin,
  initialEditorOpen = false,
  initialEditingProvider = null,
}: {
  workspaceId: number;
  userId: number;
  canAdmin: boolean;
  initialEditorOpen?: boolean;
  initialEditingProvider?: SSOProvider | null;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();

  const [editorOpen, setEditorOpen] = useState(initialEditorOpen || Boolean(initialEditingProvider));
  const [editing, setEditing] = useState<SSOProvider | null>(initialEditingProvider);
  const [form, setForm] = useState<SSOFormState>(() =>
    initialEditingProvider ? formStateFromProvider(initialEditingProvider) : emptyFormState(),
  );
  const [discovering, setDiscovering] = useState(false);
  const [formError, setFormError] = useState("");
  const [formNotice, setFormNotice] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copiedKey, setCopiedKey] = useState<string>("");

  const ssoQueryKey = ["workspace-sso-providers", workspaceId, userId];

  const providersQuery = useQuery({
    queryKey: ssoQueryKey,
    queryFn: () => ssoApi.listWorkspaceProviders(workspaceId, userId),
    enabled: canAdmin && workspaceId > 0,
  });

  const providers = providersQuery.data ?? [];

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
    setForm(emptyFormState());
    setFormError("");
    setFormNotice("");
    setEditorOpen(true);
  };

  const openEditModal = (p: SSOProvider) => {
    setEditing(p);
    setForm(formStateFromProvider(p));
    setFormError("");
    setFormNotice("");
    setEditorOpen(true);
  };

  const applyPreset = (preset: SSOProviderPreset) => {
    setForm((prev) => ({
      ...prev,
      providerType: preset.type,
      name: prev.name.trim() ? prev.name : preset.nameSuggestion,
      slug: prev.slug.trim() ? prev.slug : preset.slugSuggestion,
      issuerUrl: preset.issuerUrl,
      authUrl: preset.authUrl,
      tokenUrl: preset.tokenUrl,
      userinfoUrl: preset.userinfoUrl,
      scopes: preset.scopes,
    }));
    setFormError("");
    setFormNotice("");
  };

  const handleDiscover = async () => {
    const issuer = form.issuerUrl.trim();
    if (!issuer) {
      setFormError(t("请先填写 Issuer 地址再执行自动发现"));
      return;
    }
    setDiscovering(true);
    setFormError("");
    setFormNotice("");
    try {
      const discovered = await ssoApi.discover(workspaceId, userId, issuer);
      setForm((prev) => ({
        ...prev,
        issuerUrl: discovered.issuerUrl || prev.issuerUrl,
        authUrl: discovered.authUrl || prev.authUrl,
        tokenUrl: discovered.tokenUrl || prev.tokenUrl,
        userinfoUrl: discovered.userinfoUrl || prev.userinfoUrl,
        scopes: discovered.scopes || prev.scopes,
      }));
      setFormNotice(t("已完成 OIDC 自动发现并填充端点配置"));
    } catch (e) {
      if (e instanceof ApiError) setFormError(e.message);
      else if (e instanceof Error) setFormError(e.message);
      else setFormError(t("OIDC 自动发现失败，请检查 Issuer 地址"));
    } finally {
      setDiscovering(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFormError("");
    setFormNotice("");
    if (!form.name.trim() || !form.slug.trim() || !form.authUrl.trim() || !form.tokenUrl.trim() || !form.clientId.trim()) {
      setFormError(t("请完整填写名称、标识、授权地址、令牌地址与 Client ID"));
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await ssoApi.updateProvider(workspaceId, editing.id, userId, {
          name: form.name.trim(),
          slug: form.slug.trim().toLowerCase(),
          providerType: form.providerType,
          enabled: form.enabled,
          issuerUrl: form.issuerUrl.trim(),
          authUrl: form.authUrl.trim(),
          tokenUrl: form.tokenUrl.trim(),
          userinfoUrl: form.userinfoUrl.trim(),
          clientId: form.clientId.trim(),
          ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}),
          scopes: form.scopes.trim(),
          allowedDomains: form.allowedDomains.trim(),
          autoCreateUser: form.autoCreateUser,
          defaultRole: form.defaultRole,
        });
        setNotice(t("SSO 配置已更新"));
      } else {
        await ssoApi.createProvider(workspaceId, userId, {
          name: form.name.trim(),
          slug: form.slug.trim().toLowerCase(),
          providerType: form.providerType,
          enabled: form.enabled,
          issuerUrl: form.issuerUrl.trim(),
          authUrl: form.authUrl.trim(),
          tokenUrl: form.tokenUrl.trim(),
          userinfoUrl: form.userinfoUrl.trim(),
          clientId: form.clientId.trim(),
          ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}),
          scopes: form.scopes.trim(),
          allowedDomains: form.allowedDomains.trim(),
          autoCreateUser: form.autoCreateUser,
          defaultRole: form.defaultRole,
        });
        setNotice(t("SSO 提供商已创建"));
      }
      await qc.invalidateQueries({ queryKey: ssoQueryKey });
      await qc.invalidateQueries({ queryKey: ["public-sso-providers"] });
      setEditorOpen(false);
    } catch (err) {
      if (err instanceof ApiError) setFormError(err.message);
      else if (err instanceof Error) setFormError(err.message);
      else setFormError(t("操作失败，请检查后重试。"));
    } finally {
      setBusy(false);
    }
  };

  if (!canAdmin) {
    return (
      <section className="rounded-lg border bg-surface p-6 text-center" data-org-sso-panel>
        <ShieldAlert size={22} className="mx-auto mb-2 text-subtle" />
        <p className="text-[14px] font-medium">{t("仅空间所有者或管理员可配置企业单点登录（SSO）")}</p>
        <p className="mt-1 text-[12px] text-subtle">
          {t("支持对接标准 OIDC / OAuth 2.0、飞书、企业微信、钉钉、Google 与 GitHub，实现统一身份认证与首次登录自动入驻。")}
        </p>
      </section>
    );
  }

  const fieldCls =
    "mt-1 h-9 w-full rounded-md border bg-surface px-2.5 text-[13px] outline-none focus:border-primary";

  return (
    <div className="space-y-4" data-org-sso-panel>
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
              <ShieldCheck size={16} className="text-primary" />
              {t("企业单点登录（SSO）")}
            </h2>
            <p className="mt-0.5 text-[12px] text-subtle">
              {t("配置 OIDC / OAuth 2.0 身份提供商后，成员可直接在登录页通过企业账号一键登录并加入当前空间。")}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={openCreateModal}
            data-sso-create-btn
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={14} />
            {t("新建 SSO 提供商")}
          </button>
        </div>

        <div className="mt-4 space-y-2.5" data-sso-provider-list>
          {providersQuery.isPending ? (
            <p className="py-6 text-center text-[13px] text-subtle">{t("正在加载 SSO 配置…")}</p>
          ) : providers.length === 0 ? (
            <div className="rounded-md border border-dashed py-8 text-center">
              <KeyRound size={20} className="mx-auto mb-2 text-subtle" />
              <p className="text-[13px] font-medium text-foreground">{t("尚未配置企业单点登录提供商")}</p>
              <p className="mt-1 text-[12px] text-subtle">
                {t("点击右上角「新建 SSO 提供商」，支持一键 OIDC 自动发现或预设模板快速接入。")}
              </p>
            </div>
          ) : (
            providers.map((p) => {
              const callbackUrl = buildSSOCallbackUrl(p.slug);
              const copyKey = `card-${p.id}`;
              const copied = copiedKey === copyKey;
              return (
                <div
                  key={p.id}
                  data-sso-provider-card={p.slug}
                  className="rounded-lg border bg-surface p-3.5 transition-colors hover:border-primary/30"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[14px] font-semibold text-foreground">{p.name}</span>
                        <span className="rounded bg-sidebar px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {getSSOProviderTypeLabel(p.providerType, t)}
                        </span>
                        <code className="rounded border bg-sidebar/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                          {p.slug}
                        </code>
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[11px]",
                            p.enabled ? "bg-primary/10 text-primary" : "bg-sidebar text-subtle",
                          )}
                        >
                          {p.enabled ? t("已启用") : t("已停用")}
                        </span>
                        <span className="rounded border px-1.5 py-0.5 text-[11px] text-subtle">
                          {p.autoCreateUser ? t("自动创建账号") : t("仅匹配已有账号")}
                        </span>
                        <span className="rounded border px-1.5 py-0.5 text-[11px] text-subtle">
                          {t("默认角色")}：{p.defaultRole === "admin" ? t("管理员") : t("普通成员")}
                        </span>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border bg-sidebar/40 px-2.5 py-1.5">
                        <Link2 size={12} className="shrink-0 text-subtle" />
                        <span className="shrink-0 text-[11px] text-subtle">{t("回调地址")}</span>
                        <code
                          data-sso-callback-url={p.slug}
                          className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground select-all"
                        >
                          {callbackUrl}
                        </code>
                        <button
                          type="button"
                          data-sso-copy-callback={p.slug}
                          onClick={() => void handleCopy(copyKey, callbackUrl)}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded border bg-surface px-2 text-[11px] hover:bg-hover"
                        >
                          {copied ? <Check size={11} className="text-primary" /> : <Copy size={11} />}
                          {copied ? t("已复制") : t("复制")}
                        </button>
                      </div>

                      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-subtle">
                        <span>
                          Client ID: <code className="font-mono text-muted-foreground">{p.clientId}</code>
                        </span>
                        <span>
                          {p.hasClientSecret
                            ? t("密钥已保存（末四位 {hint}）", { hint: p.secretHint || "****" })
                            : t("未配置密钥")}
                        </span>
                        {p.allowedDomains && (
                          <span>
                            {t("允许域名")}：{p.allowedDomains}
                          </span>
                        )}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={p.enabled}
                        aria-label={p.enabled ? t("停用") : t("启用")}
                        data-sso-toggle={p.slug}
                        disabled={busy}
                        onClick={() =>
                          void withFeedback(async () => {
                            await ssoApi.updateProvider(workspaceId, p.id, userId, { enabled: !p.enabled });
                            await qc.invalidateQueries({ queryKey: ssoQueryKey });
                            await qc.invalidateQueries({ queryKey: ["public-sso-providers"] });
                            return p.enabled ? t("已停用该 SSO 登录方式") : t("已启用该 SSO 登录方式");
                          })
                        }
                        className={cn(
                          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50",
                          p.enabled ? "bg-primary" : "bg-[#cfd3da] dark:bg-white/20",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-block size-4 rounded-full bg-white shadow transition-transform",
                            p.enabled ? "translate-x-4.5" : "translate-x-0.5",
                          )}
                        />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        data-sso-edit={p.slug}
                        onClick={() => openEditModal(p)}
                        className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[12px] hover:bg-hover disabled:opacity-50"
                      >
                        <Pencil size={11} />
                        {t("编辑")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={t("删除")}
                        data-sso-delete={p.slug}
                        onClick={() =>
                          void withFeedback(async () => {
                            const ok = await ask(
                              t("删除 SSO 提供商「{name}」？", { name: p.name }),
                              t("删除后成员将无法再通过该方式登录，已创建的本地账号不受影响。"),
                            );
                            if (!ok) return;
                            await ssoApi.deleteProvider(workspaceId, p.id, userId);
                            await qc.invalidateQueries({ queryKey: ssoQueryKey });
                            await qc.invalidateQueries({ queryKey: ["public-sso-providers"] });
                            return t("SSO 提供商已删除");
                          })
                        }
                        className="grid size-7 place-items-center rounded border text-subtle hover:bg-destructive/5 hover:text-destructive disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
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
            aria-label={editing ? t("编辑 SSO 提供商") : t("新建 SSO 提供商")}
            data-sso-modal
            className="my-auto w-full max-w-[580px] rounded-xl border bg-surface p-5 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={18} className="text-primary" />
                <h3 className="text-[16px] font-semibold">
                  {editing ? t("编辑 SSO 提供商") : t("新建 SSO 提供商")}
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
              {/* Quick provider presets */}
              <div>
                <p className="text-[12px] font-medium text-muted-foreground">{t("快捷模板预设")}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5" data-sso-presets>
                  {SSO_PROVIDER_PRESETS.map((preset) => (
                    <button
                      key={preset.type}
                      type="button"
                      data-sso-preset={preset.type}
                      onClick={() => applyPreset(preset)}
                      className={cn(
                        "h-7 rounded-full border px-2.5 text-[12px] transition-colors hover:border-primary hover:text-primary",
                        form.providerType === preset.type
                          ? "border-primary bg-primary/5 font-medium text-primary"
                          : "text-muted-foreground",
                      )}
                    >
                      {getSSOProviderTypeLabel(preset.type, t)}
                    </button>
                  ))}
                </div>
              </div>

              {/* OIDC Discovery */}
              <div className="rounded-lg border bg-sidebar/40 p-3">
                <label className="block text-[12px] font-medium text-foreground">
                  {t("Issuer 地址（可选，支持 OIDC 自动发现）")}
                </label>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="url"
                    value={form.issuerUrl}
                    onChange={(e) => setForm((f) => ({ ...f, issuerUrl: e.target.value }))}
                    placeholder="https://accounts.google.com"
                    data-sso-issuer-input
                    className="h-9 min-w-0 flex-1 rounded-md border bg-surface px-2.5 text-[13px] outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    disabled={discovering || !form.issuerUrl.trim()}
                    onClick={() => void handleDiscover()}
                    data-sso-discover-btn
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border bg-surface px-3 text-[12px] font-medium text-primary hover:bg-hover disabled:opacity-50"
                  >
                    <Sparkles size={13} />
                    {discovering ? t("发现中…") : t("OIDC 自动发现")}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-[12px] font-medium">
                  {t("显示名称")} *
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder={t("如：公司 Okta / 飞书企业登录")}
                    data-sso-name-input
                    className={fieldCls}
                  />
                </label>
                <label className="block text-[12px] font-medium">
                  {t("唯一标识（Slug）")} *
                  <input
                    type="text"
                    required
                    value={form.slug}
                    onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }))}
                    placeholder="corp-oidc"
                    data-sso-slug-input
                    className={cn(fieldCls, "font-mono")}
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-sidebar/40 px-2.5 py-1.5 text-[11px]">
                <span className="shrink-0 text-subtle">{t("回调地址")}：</span>
                <code className="min-w-0 flex-1 truncate font-mono text-foreground select-all">
                  {buildSSOCallbackUrl(form.slug)}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopy("modal-cb", buildSSOCallbackUrl(form.slug))}
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded border bg-surface px-2 text-[11px] hover:bg-hover"
                >
                  {copiedKey === "modal-cb" ? <Check size={11} className="text-primary" /> : <Copy size={11} />}
                  {copiedKey === "modal-cb" ? t("已复制") : t("复制")}
                </button>
              </div>

              <div className="space-y-2.5">
                <label className="block text-[12px] font-medium">
                  {t("授权地址（Auth URL）")} *
                  <input
                    type="url"
                    required
                    value={form.authUrl}
                    onChange={(e) => setForm((f) => ({ ...f, authUrl: e.target.value }))}
                    placeholder="https://idp.example.com/oauth2/authorize"
                    data-sso-auth-url-input
                    className={fieldCls}
                  />
                </label>
                <label className="block text-[12px] font-medium">
                  {t("令牌地址（Token URL）")} *
                  <input
                    type="url"
                    required
                    value={form.tokenUrl}
                    onChange={(e) => setForm((f) => ({ ...f, tokenUrl: e.target.value }))}
                    placeholder="https://idp.example.com/oauth2/token"
                    data-sso-token-url-input
                    className={fieldCls}
                  />
                </label>
                <label className="block text-[12px] font-medium">
                  {t("用户信息地址（Userinfo URL）")}
                  <input
                    type="url"
                    value={form.userinfoUrl}
                    onChange={(e) => setForm((f) => ({ ...f, userinfoUrl: e.target.value }))}
                    placeholder="https://idp.example.com/oauth2/userinfo"
                    data-sso-userinfo-url-input
                    className={fieldCls}
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-[12px] font-medium">
                  Client ID *
                  <input
                    type="text"
                    required
                    value={form.clientId}
                    onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
                    placeholder="your-client-id"
                    data-sso-client-id-input
                    className={cn(fieldCls, "font-mono")}
                  />
                </label>
                <label className="block text-[12px] font-medium">
                  Client Secret
                  <input
                    type="password"
                    autoComplete="off"
                    value={form.clientSecret}
                    onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))}
                    placeholder={
                      editing?.hasClientSecret
                        ? t("已保存（末四位 {hint}），留空则保持不变", { hint: editing.secretHint || "****" })
                        : t("填写 Client Secret（可选，PKCE 客户端可留空）")
                    }
                    data-sso-client-secret-input
                    className={fieldCls}
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-[12px] font-medium">
                  Scopes
                  <input
                    type="text"
                    value={form.scopes}
                    onChange={(e) => setForm((f) => ({ ...f, scopes: e.target.value }))}
                    placeholder="openid email profile"
                    data-sso-scopes-input
                    className={cn(fieldCls, "font-mono")}
                  />
                </label>
                <label className="block text-[12px] font-medium">
                  {t("允许登录的邮箱域名")}
                  <input
                    type="text"
                    value={form.allowedDomains}
                    onChange={(e) => setForm((f) => ({ ...f, allowedDomains: e.target.value }))}
                    placeholder="company.com, sub.company.com"
                    data-sso-domains-input
                    className={fieldCls}
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 items-center gap-3 rounded-lg border bg-sidebar/30 p-3 sm:grid-cols-2">
                <div>
                  <span className="block text-[12px] font-medium text-foreground">{t("新成员默认空间角色")}</span>
                  <div className="mt-1.5">
                    <FeishuSelect
                      ariaLabel={t("新成员默认空间角色")}
                      value={form.defaultRole}
                      options={[
                        { value: "member", label: t("普通成员") },
                        { value: "admin", label: t("管理员") },
                      ]}
                      onChange={(val) => setForm((f) => ({ ...f, defaultRole: val as SSODefaultRole }))}
                      dataAttr={{ "data-sso-default-role-select": true }}
                      className="h-9 w-full border bg-surface px-2.5 text-[13px]"
                      menuMinWidth={160}
                    />
                  </div>
                </div>
                <div className="space-y-2 pt-1">
                  <label className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
                    <input
                      type="checkbox"
                      checked={form.autoCreateUser}
                      onChange={(e) => setForm((f) => ({ ...f, autoCreateUser: e.target.checked }))}
                      data-sso-auto-create
                    />
                    {t("首次登录自动创建账号并加入空间")}
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                      data-sso-enabled
                    />
                    {t("在登录页展示并启用该方式")}
                  </label>
                </div>
              </div>

              {formError && (
                <p role="alert" className="text-[12px] text-destructive">
                  {formError}
                </p>
              )}
              {formNotice && (
                <p role="status" className="text-[12px] text-primary">
                  {formNotice}
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
                  data-sso-submit-btn
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

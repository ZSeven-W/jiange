import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Me } from "@/lib/api";
import { confirmPasswordReset, requestPasswordReset } from "@/lib/account-security-api";
import { isMfaChallengeResponse, mfaApi, type LoginOrMfaResponse } from "@/lib/mfa-api";
import { isWebAuthnSupported, loginWithPasskey } from "@/lib/passkey-api";
import { buildSSOStartUrl, ssoApi } from "@/lib/sso-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/brand";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  FileText,
  Fingerprint,
  KeyRound,
  Mail,
  ShieldCheck,
  Sparkles,
  Table2,
  X,
} from "lucide-react";
import { finishLogin } from "@/lib/session-cache";
import { useI18n, type TFunc } from "@/lib/i18n";
import { LocaleToggle } from "@/components/locale-toggle";

export type LoginViewMode = "login" | "register" | "forgot" | "reset";

export function readSSOErrorFromLocation(search: string, hash: string): string {
  const fromSearch = new URLSearchParams(search).get("sso_error")?.trim();
  if (fromSearch) return fromSearch;
  const qIdx = hash.indexOf("?");
  if (qIdx >= 0) {
    const fromHash = new URLSearchParams(hash.slice(qIdx + 1)).get("sso_error")?.trim();
    if (fromHash) return fromHash;
  }
  return "";
}

export function readResetTokenFromLocation(search: string, hash: string): string {
  const fromSearch = new URLSearchParams(search).get("reset_token")?.trim();
  if (fromSearch) return fromSearch;
  const qIdx = hash.indexOf("?");
  if (qIdx >= 0) {
    const fromHash = new URLSearchParams(hash.slice(qIdx + 1)).get("reset_token")?.trim();
    if (fromHash) return fromHash;
  }
  return "";
}

/**
 * Normalize `#/login` (and `#/login?...`) back to `#/` after successful auth so
 * authenticated users are never left stranded on the login hash URL.
 */
export function normalizePostLoginHash(): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash || "";
  if (/^#\/login(?:$|[/?#])/i.test(hash)) {
    try {
      window.history.replaceState(null, "", "#/");
    } catch {
      window.location.hash = "#/";
    }
  }
}

export function formatSSOErrorMessage(code: string, t: TFunc): string {
  switch (code) {
    case "access_denied":
      return t("已取消企业单点登录授权");
    case "invalid_state":
      return t("登录状态已过期或无效，请重新发起单点登录");
    case "provider_disabled":
      return t("该企业单点登录方式未启用或已被移除");
    case "domain_not_allowed":
      return t("当前企业邮箱域名未被授权登录此空间");
    case "user_not_provisioned":
      return t("当前账号尚未开通访问权限，请联系管理员");
    case "nonce_mismatch":
    case "invalid_id_token":
    case "token_expired":
    case "subject_mismatch":
      return t("身份令牌校验失败，请重试登录");
    case "token_exchange_failed":
    case "userinfo_failed":
    case "identity_missing":
      return t("无法从企业身份提供商获取用户信息，请联系管理员检查配置");
    default:
      return t("企业单点登录失败（{reason}），请稍后重试", { reason: code });
  }
}

export interface LoginMFAChallenge {
  mfaToken: string;
  email?: string;
}

export function LoginPage({
  initialSSOError,
  initialMFAChallenge = null,
  initialPasskeySupported,
  initialMode,
  initialResetToken,
}: {
  initialSSOError?: string;
  initialMFAChallenge?: LoginMFAChallenge | null;
  initialPasskeySupported?: boolean;
  initialMode?: LoginViewMode;
  initialResetToken?: string;
} = {}) {
  const { t } = useI18n();
  const passkeySupported = initialPasskeySupported ?? isWebAuthnSupported();
  const detectedResetToken =
    initialResetToken !== undefined
      ? initialResetToken.trim()
      : typeof window === "undefined"
        ? ""
        : readResetTokenFromLocation(window.location.search, window.location.hash);

  const [mode, setMode] = useState<LoginViewMode>(() => {
    if (initialMode) return initialMode;
    if (detectedResetToken) return "reset";
    return "login";
  });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [resetToken, setResetToken] = useState(detectedResetToken);
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [resetValidationError, setResetValidationError] = useState("");
  const [resetRequestSentMsg, setResetRequestSentMsg] = useState("");
  const [resetSuccessBanner, setResetSuccessBanner] = useState("");
  const [mfaChallenge, setMfaChallenge] = useState<LoginMFAChallenge | null>(initialMFAChallenge);
  const [mfaCode, setMfaCode] = useState("");
  const [ssoError, setSSOError] = useState<string>(() => {
    if (initialSSOError !== undefined) return initialSSOError.trim();
    if (typeof window === "undefined") return "";
    return readSSOErrorFromLocation(window.location.search, window.location.hash);
  });
  const qc = useQueryClient();

  const completeAuth = (me: Me) => {
    normalizePostLoginHash();
    void finishLogin(qc, me);
  };

  const ssoQuery = useQuery({
    queryKey: ["public-sso-providers"],
    queryFn: ssoApi.listPublicProviders,
    retry: false,
    staleTime: 60_000,
  });
  const ssoProviders = ssoQuery.data ?? [];

  const mfaVerify = useMutation({
    mutationFn: () => {
      if (!mfaChallenge) {
        return Promise.reject(new Error(t("二步验证会话已失效，请重新登录")));
      }
      return mfaApi.verifyLogin(mfaChallenge.mfaToken, mfaCode.trim());
    },
    onSuccess: (me: Me) => {
      completeAuth(me);
    },
  });

  const passkeyLogin = useMutation({
    mutationFn: () => loginWithPasskey(email.trim() || undefined),
    onSuccess: (me: Me) => {
      completeAuth(me);
    },
  });

  const m = useMutation({
    mutationFn: (): Promise<LoginOrMfaResponse> =>
      mode === "login"
        ? (api.login(email, password) as Promise<LoginOrMfaResponse>)
        : api.register(email, name, password),
    onSuccess: (res) => {
      if (isMfaChallengeResponse(res)) {
        setMfaChallenge({ mfaToken: res.mfaToken, email: res.email || email.trim() });
        setMfaCode("");
        mfaVerify.reset();
        return;
      }
      completeAuth(res);
    },
  });

  const forgotMutation = useMutation({
    mutationFn: () => requestPasswordReset(email.trim()),
    onSuccess: (res) => {
      setResetRequestSentMsg(
        res.message || t("如果该邮箱已注册，我们已发送密码重置邮件，请查收收件箱"),
      );
    },
  });

  const resetConfirmMutation = useMutation({
    mutationFn: () => confirmPasswordReset(resetToken.trim(), resetNewPassword),
    onSuccess: () => {
      setResetToken("");
      setResetNewPassword("");
      setResetConfirmPassword("");
      setResetValidationError("");
      setPassword("");
      setResetSuccessBanner(t("密码已重置，请使用新密码登录"));
      if (typeof window !== "undefined" && /^#\/login\?/i.test(window.location.hash)) {
        try {
          window.history.replaceState(null, "", "#/login");
        } catch {
          // Ignore history replace errors in restricted environments
        }
      }
      setMode("login");
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setResetSuccessBanner("");
    m.mutate();
  };
  const submitMFA = (e: FormEvent) => {
    e.preventDefault();
    if (!mfaCode.trim() || mfaVerify.isPending) return;
    mfaVerify.mutate();
  };
  const submitForgot = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || forgotMutation.isPending) return;
    setResetRequestSentMsg("");
    forgotMutation.mutate();
  };
  const submitResetConfirm = (e: FormEvent) => {
    e.preventDefault();
    if (resetConfirmMutation.isPending) return;
    setResetValidationError("");
    if (!resetToken.trim()) {
      setResetValidationError(t("请输入重置口令"));
      return;
    }
    if (resetNewPassword.length < 8 || resetNewPassword.length > 256) {
      setResetValidationError(t("新密码长度需为 8–256 个字符"));
      return;
    }
    if (resetNewPassword !== resetConfirmPassword) {
      setResetValidationError(t("两次输入的新密码不一致"));
      return;
    }
    resetConfirmMutation.mutate();
  };
  const backToPasswordLogin = () => {
    setMfaChallenge(null);
    setMfaCode("");
    setResetValidationError("");
    setResetRequestSentMsg("");
    mfaVerify.reset();
    forgotMutation.reset();
    resetConfirmMutation.reset();
    m.reset();
    passkeyLogin.reset();
    setMode("login");
  };

  const login = mode === "login";
  return (
    <div className="flex min-h-full bg-surface">
      <aside className="relative hidden min-h-[620px] w-[48%] flex-col overflow-hidden bg-[#f2f5fc] px-12 py-10 lg:flex dark:bg-[#1b2230]">
        <Logo />
        <div className="relative z-10 my-auto max-w-[470px] pb-12">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[12px] font-medium text-primary shadow-sm dark:bg-white/10"><Sparkles size={13} /> {t("一起把想法变成成果")}</span>
          <h1 className="mt-6 text-[38px] font-semibold leading-[1.3] tracking-tight">{t("好想法，")}<br />{t("从协作开始。")}</h1>
          <p className="mt-4 text-[15px] leading-7 text-muted-foreground">{t("用文档记录灵感，用多维表格整理工作。")}<br />{t("让每一次协作都清晰、高效。")}</p>
          <div aria-hidden className="relative mt-12 h-[220px] max-w-[410px]">
            <div className="absolute inset-x-0 top-0 h-[195px] rotate-[-3deg] rounded-2xl border border-white bg-white/80 p-6 shadow-[0_18px_60px_rgba(50,76,130,0.12)] dark:border-white/10 dark:bg-[#252c39]">
              <div className="flex items-center gap-2 text-[12px] font-medium text-primary"><FileText size={16} /> {t("项目协作空间")}</div>
              <div className="mt-5 h-3 w-2/3 rounded-full bg-[#dce6fa] dark:bg-white/15" /><div className="mt-3 h-2 w-full rounded-full bg-[#edf1f8] dark:bg-white/10" /><div className="mt-2 h-2 w-5/6 rounded-full bg-[#edf1f8] dark:bg-white/10" />
              <div className="mt-5 flex items-center gap-2 text-[12px] text-muted-foreground"><span className="grid size-5 place-items-center rounded-full bg-[#d9f4e6] text-[#31a56b]"><Check size={12} /></span> {t("想法和进展，都在一处")}</div>
            </div>
            <div className="absolute -right-4 bottom-0 flex items-center gap-3 rounded-xl border border-white bg-white px-4 py-3 shadow-[0_10px_35px_rgba(50,76,130,0.14)] dark:border-white/10 dark:bg-[#30394a]"><span className="grid size-9 place-items-center rounded-lg bg-[#f0ebff] text-[#7657d8]"><Table2 size={18} /></span><span className="text-[12px] font-medium">{t("把工作整理得井井有条")}</span></div>
          </div>
        </div>
        <p className="text-[12px] text-subtle">{t("Jiange · 开源、可自部署的协作空间")}</p>
        <div aria-hidden className="pointer-events-none absolute -right-32 -top-32 size-96 rounded-full bg-[#dfe9ff]/60 blur-3xl" />
      </aside>
      <main className="flex flex-1 items-center justify-center px-7 py-12">
        {mfaChallenge ? (
          <form onSubmit={submitMFA} className="w-full max-w-[360px]" data-mfa-challenge-form>
            <div className="mb-10 flex items-start justify-between lg:hidden"><Logo /><LocaleToggle /></div>
            <div className="mb-6 hidden justify-end lg:flex"><LocaleToggle /></div>
            <div className="inline-flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <ShieldCheck size={22} />
            </div>
            <h2 className="mt-4 text-[24px] font-semibold tracking-tight">{t("二步验证（MFA）")}</h2>
            <p className="mt-2 text-[14px] leading-6 text-muted-foreground">
              {t("请输入身份验证器 App 中的 6 位动态码，或输入一次性备用恢复码完成登录")}
            </p>
            {mfaChallenge.email && (
              <div className="mt-3 inline-flex max-w-full items-center rounded-full border border-border bg-hover/60 px-3 py-1 text-[12px] text-muted-foreground">
                <span className="truncate">{mfaChallenge.email}</span>
              </div>
            )}
            <div className="mt-6 space-y-4">
              <Field id="mfa-code" label={t("动态验证码 / 备用恢复码")}>
                <Input
                  id="mfa-code"
                  type="text"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder={t("6 位动态码或恢复码")}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  className="h-11 font-mono text-center text-[16px] tracking-[0.2em]"
                  data-mfa-code-input
                />
              </Field>
            </div>
            {mfaVerify.error && (
              <p role="alert" className="mt-3 text-[13px] text-destructive">
                {(mfaVerify.error as Error).message}
              </p>
            )}
            <Button
              type="submit"
              className="mt-7 h-11 w-full"
              disabled={mfaVerify.isPending || !mfaCode.trim()}
              data-mfa-submit-btn
            >
              {mfaVerify.isPending ? t("验证中…") : t("验证并登录")}
            </Button>
            <button
              type="button"
              onClick={backToPasswordLogin}
              data-mfa-back-btn
              className="mt-4 flex h-10 w-full items-center justify-center gap-1.5 rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              <ArrowLeft size={14} />
              {t("返回账号登录")}
            </button>
          </form>
        ) : mode === "forgot" ? (
          <form onSubmit={submitForgot} className="w-full max-w-[360px]" data-password-reset-request-form>
            <div className="mb-10 flex items-start justify-between lg:hidden"><Logo /><LocaleToggle /></div>
            <div className="mb-6 hidden justify-end lg:flex"><LocaleToggle /></div>
            <div className="inline-flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Mail size={22} />
            </div>
            <h2 className="mt-4 text-[24px] font-semibold tracking-tight">{t("找回密码")}</h2>
            <p className="mt-2 text-[14px] leading-6 text-muted-foreground">
              {t("输入账号注册邮箱，我们将向您发送密码重置邮件")}
            </p>
            {resetRequestSentMsg && (
              <div
                role="status"
                data-password-reset-sent-banner
                className="mt-5 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-[13px] text-emerald-700 dark:text-emerald-300"
              >
                <Check size={16} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1 leading-5">{resetRequestSentMsg}</span>
              </div>
            )}
            <div className="mt-6 space-y-4">
              <Field id="reset-email" label={t("注册邮箱")}>
                <Input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11"
                  data-reset-email-input
                />
              </Field>
            </div>
            {forgotMutation.error && (
              <p role="alert" className="mt-3 text-[13px] text-destructive">
                {(forgotMutation.error as Error).message}
              </p>
            )}
            <Button
              type="submit"
              className="mt-7 h-11 w-full"
              disabled={forgotMutation.isPending || !email.trim()}
              data-reset-request-submit-btn
            >
              {forgotMutation.isPending ? t("发送中…") : t("发送重置邮件")}
            </Button>
            <button
              type="button"
              onClick={() => {
                setResetValidationError("");
                resetConfirmMutation.reset();
                setMode("reset");
              }}
              data-goto-reset-confirm-btn
              className="mt-3 flex h-10 w-full items-center justify-center rounded-md border border-border bg-surface text-[13px] font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-hover"
            >
              {t("已有重置口令？立即重设")}
            </button>
            <button
              type="button"
              onClick={backToPasswordLogin}
              data-reset-back-btn
              className="mt-2 flex h-10 w-full items-center justify-center gap-1.5 rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              <ArrowLeft size={14} />
              {t("返回账号登录")}
            </button>
          </form>
        ) : mode === "reset" ? (
          <form onSubmit={submitResetConfirm} className="w-full max-w-[360px]" data-password-reset-confirm-form>
            <div className="mb-10 flex items-start justify-between lg:hidden"><Logo /><LocaleToggle /></div>
            <div className="mb-6 hidden justify-end lg:flex"><LocaleToggle /></div>
            <div className="inline-flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <KeyRound size={22} />
            </div>
            <h2 className="mt-4 text-[24px] font-semibold tracking-tight">{t("重设登录密码")}</h2>
            <p className="mt-2 text-[14px] leading-6 text-muted-foreground">
              {t("输入邮件中的重置口令并设置新密码，重设后所有已登录设备需重新登录")}
            </p>
            <div className="mt-6 space-y-4">
              <Field id="reset-token" label={t("重置口令")}>
                <Input
                  id="reset-token"
                  type="text"
                  autoComplete="one-time-code"
                  placeholder={t("粘贴邮件中的重置口令")}
                  value={resetToken}
                  onChange={(e) => setResetToken(e.target.value)}
                  className="h-11 font-mono text-[13px]"
                  data-reset-token-input
                />
              </Field>
              <Field id="reset-new-password" label={t("新密码")}>
                <Input
                  id="reset-new-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t("至少 8 位")}
                  value={resetNewPassword}
                  onChange={(e) => setResetNewPassword(e.target.value)}
                  className="h-11"
                  data-reset-new-password-input
                />
              </Field>
              <Field id="reset-confirm-password" label={t("确认新密码")}>
                <Input
                  id="reset-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t("再次输入新密码")}
                  value={resetConfirmPassword}
                  onChange={(e) => setResetConfirmPassword(e.target.value)}
                  className="h-11"
                  data-reset-confirm-password-input
                />
              </Field>
            </div>
            {(resetValidationError || resetConfirmMutation.error) && (
              <p role="alert" className="mt-3 text-[13px] text-destructive">
                {resetValidationError || (resetConfirmMutation.error as Error).message}
              </p>
            )}
            <Button
              type="submit"
              className="mt-7 h-11 w-full"
              disabled={resetConfirmMutation.isPending}
              data-reset-confirm-submit-btn
            >
              {resetConfirmMutation.isPending ? t("重设中…") : t("确认重设密码")}
            </Button>
            <button
              type="button"
              onClick={backToPasswordLogin}
              data-reset-back-btn
              className="mt-4 flex h-10 w-full items-center justify-center gap-1.5 rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              <ArrowLeft size={14} />
              {t("返回账号登录")}
            </button>
          </form>
        ) : (
        <form onSubmit={submit} className="w-full max-w-[360px]">
          <div className="mb-10 flex items-start justify-between lg:hidden"><Logo /><LocaleToggle /></div>
          <div className="mb-6 hidden justify-end lg:flex"><LocaleToggle /></div>
          <h2 className="text-[26px] font-semibold tracking-tight">{login ? t("欢迎回来") : t("创建你的账号")}</h2>
          <p className="mt-2 text-[14px] text-muted-foreground">{login ? t("登录 Jiange，继续你的工作") : t("加入 Jiange，开始记录和协作")}</p>
          {resetSuccessBanner && (
            <div
              role="status"
              data-password-reset-success-banner
              className="mt-5 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-[13px] text-emerald-700 dark:text-emerald-300"
            >
              <Check size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 leading-5">{resetSuccessBanner}</span>
              <button
                type="button"
                aria-label={t("关闭")}
                onClick={() => setResetSuccessBanner("")}
                className="shrink-0 rounded p-0.5 opacity-70 hover:bg-emerald-500/15 hover:opacity-100"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {ssoError && (
            <div
              role="alert"
              data-sso-error-banner
              className="mt-5 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[13px] text-destructive"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 leading-5">{formatSSOErrorMessage(ssoError, t)}</span>
              <button
                type="button"
                aria-label={t("关闭")}
                onClick={() => setSSOError("")}
                className="shrink-0 rounded p-0.5 text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
              >
                <X size={14} />
              </button>
            </div>
          )}
          <div className="mt-8 space-y-5">
            <Field id="email" label={t("邮箱")}><Input id="email" type="email" autoComplete="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className="h-11" /></Field>
            {!login && <Field id="name" label={t("名字")}><Input id="name" autoComplete="name" placeholder={t("你的名字")} value={name} onChange={(e) => setName(e.target.value)} className="h-11" /></Field>}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="password" className="text-[13px] font-medium">{t("密码")}</Label>
                {login && (
                  <button
                    type="button"
                    data-forgot-password-btn
                    onClick={() => {
                      m.reset();
                      passkeyLogin.reset();
                      forgotMutation.reset();
                      setResetRequestSentMsg("");
                      setResetSuccessBanner("");
                      setMode("forgot");
                    }}
                    className="text-[12px] font-medium text-primary hover:underline"
                  >
                    {t("忘记密码？")}
                  </button>
                )}
              </div>
              <Input id="password" type="password" autoComplete={login ? "current-password" : "new-password"} placeholder={login ? t("输入密码") : t("至少 8 位")} value={password} onChange={(e) => setPassword(e.target.value)} className="h-11" />
            </div>
          </div>
          {m.error && <p role="alert" className="mt-3 text-[13px] text-destructive">{(m.error as Error).message}</p>}
          {passkeyLogin.error && (
            <p role="alert" data-passkey-login-error className="mt-3 text-[13px] text-destructive">
              {(passkeyLogin.error as Error).name === "NotAllowedError" ||
              (passkeyLogin.error as Error).name === "AbortError"
                ? t("通行密钥操作已取消或超时，请重试")
                : (passkeyLogin.error as Error).message}
            </p>
          )}
          <Button type="submit" className="mt-7 h-11 w-full" disabled={m.isPending || passkeyLogin.isPending}>{m.isPending ? t("请稍候…") : login ? t("登录") : t("注册并进入")}</Button>
          {login && passkeySupported && (
            <button
              type="button"
              data-passkey-login-btn
              disabled={m.isPending || passkeyLogin.isPending}
              onClick={() => {
                m.reset();
                passkeyLogin.mutate();
              }}
              className="mt-3 flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-border bg-surface px-4 text-[14px] font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Fingerprint size={16} className="shrink-0 text-primary" />
              <span>{passkeyLogin.isPending ? t("正在验证通行密钥…") : t("使用通行密钥（Passkey）登录")}</span>
            </button>
          )}
          {ssoProviders.length > 0 && (
            <div className="mt-6" data-sso-login-section>
              <div className="relative flex items-center justify-center">
                <span className="h-px flex-1 bg-border" />
                <span className="px-3 text-[12px] text-subtle">{t("或使用企业单点登录")}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <div className="mt-4 space-y-2.5">
                {ssoProviders.map((provider) => (
                  <a
                    key={provider.id}
                    href={buildSSOStartUrl(provider.slug)}
                    data-sso-provider={provider.slug}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface px-4 text-[14px] font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-hover"
                  >
                    <ShieldCheck size={16} className="shrink-0 text-primary" />
                    <span className="truncate">{t("使用 {name} 登录", { name: provider.name })}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
          <p className="mt-7 text-center text-[13px] text-muted-foreground">{login ? t("还没有账号？") : t("已有账号？")}<button type="button" className="ml-1 font-medium text-primary hover:underline" onClick={() => { setMode(login ? "register" : "login"); setResetSuccessBanner(""); m.reset(); passkeyLogin.reset(); }}>{login ? t("免费注册") : t("去登录")}</button></p>
        </form>
        )}
      </main>
    </div>
  );
}
function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label htmlFor={id} className="text-[13px] font-medium">{label}</Label>{children}</div>;
}

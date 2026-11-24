import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Shield,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  MFA_STATUS_QUERY_KEY,
  mfaApi,
  type MfaSetupResponse,
  type MfaStatus,
} from "@/lib/mfa-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface MfaSettingsProps {
  className?: string;
  initialSetup?: MfaSetupResponse | null;
  initialRecoveryCodes?: string[] | null;
  initialDisableOpen?: boolean;
  initialDisableMethod?: "password" | "code";
}

export function formatTotpSecret(secret: string): string {
  const clean = secret.replace(/[\s-]+/g, "").toUpperCase();
  return clean.replace(/(.{4})(?=.)/g, "$1 ");
}

export function MfaSettings({
  className,
  initialSetup = null,
  initialRecoveryCodes = null,
  initialDisableOpen = false,
  initialDisableMethod = "password",
}: MfaSettingsProps = {}) {
  const { t } = useI18n();
  const qc = useQueryClient();

  const statusQuery = useQuery<MfaStatus>({
    queryKey: MFA_STATUS_QUERY_KEY,
    queryFn: mfaApi.getStatus,
    retry: false,
  });

  const [setupData, setSetupData] = useState<MfaSetupResponse | null>(initialSetup);
  const [verifyCode, setVerifyCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(initialRecoveryCodes);
  const [disableOpen, setDisableOpen] = useState(initialDisableOpen);
  const [disableMethod, setDisableMethod] = useState<"password" | "code">(initialDisableMethod);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [busy, setBusy] = useState<"" | "setup" | "enable" | "disable">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copiedKey, setCopiedKey] = useState<"" | "secret" | "uri" | "codes">("");

  useEffect(() => {
    if (!copiedKey) return;
    const timer = window.setTimeout(() => setCopiedKey(""), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedKey]);

  const status = statusQuery.data;
  const enabled = status?.enabled ?? false;
  const remaining = status?.recoveryCodesRemaining ?? 0;

  const copyText = async (text: string, kind: "secret" | "uri" | "codes") => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedKey(kind);
    } catch {
      setError(t("复制失败，请手动选中复制"));
    }
  };

  const handleStartSetup = async () => {
    if (busy) return;
    setBusy("setup");
    setError("");
    setNotice("");
    try {
      const next = await mfaApi.setup();
      setSetupData(next);
      setVerifyCode("");
      setRecoveryCodes(null);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : t("初始化二步验证失败，请稍后重试"));
    } finally {
      setBusy("");
    }
  };

  const handleEnableSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !verifyCode.trim()) return;
    setBusy("enable");
    setError("");
    setNotice("");
    try {
      const res = await mfaApi.enable(verifyCode.trim());
      setRecoveryCodes(res.recoveryCodes);
      setSetupData(null);
      setVerifyCode("");
      qc.setQueryData<MfaStatus>(MFA_STATUS_QUERY_KEY, {
        enabled: true,
        recoveryCodesRemaining: res.recoveryCodesRemaining ?? res.recoveryCodes.length,
        enabledAt: res.enabledAt ?? new Date().toISOString(),
      });
      setNotice(t("二步验证已开启，请妥善保存一次性恢复码"));
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : t("验证码校验失败，请重试"));
    } finally {
      setBusy("");
    }
  };

  const handleDisableSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const payload =
      disableMethod === "password"
        ? { password: disablePassword }
        : { code: disableCode.trim() };
    if (disableMethod === "password" && !disablePassword) return;
    if (disableMethod === "code" && !disableCode.trim()) return;

    setBusy("disable");
    setError("");
    setNotice("");
    try {
      await mfaApi.disable(payload);
      setDisableOpen(false);
      setDisablePassword("");
      setDisableCode("");
      setRecoveryCodes(null);
      qc.setQueryData<MfaStatus>(MFA_STATUS_QUERY_KEY, {
        enabled: false,
        recoveryCodesRemaining: 0,
        enabledAt: null,
      });
      setNotice(t("已关闭二步验证"));
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : t("关闭二步验证失败，请重试"));
    } finally {
      setBusy("");
    }
  };

  return (
    <section
      data-mfa-settings
      className={cn(
        "rounded-xl border border-border bg-surface p-5 shadow-xs",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg",
              enabled
                ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                : "bg-primary/10 text-primary",
            )}
          >
            {enabled ? <ShieldCheck size={20} /> : <Shield size={20} />}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold text-foreground">
                {t("二步验证（MFA）")}
              </h3>
              <span
                data-mfa-status-badge
                data-mfa-enabled={enabled ? "true" : "false"}
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                  enabled
                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-border bg-hover text-muted-foreground",
                )}
              >
                {enabled ? t("已开启二步验证") : t("未开启")}
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
              {t("使用身份验证器 App 生成 6 位动态验证码，在登录时提供额外安全保护。")}
            </p>
            {enabled && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-subtle">
                <span
                  data-mfa-recovery-remaining
                  className={cn(
                    "inline-flex items-center gap-1",
                    remaining <= 2 && "font-medium text-amber-600 dark:text-amber-400",
                  )}
                >
                  <KeyRound size={13} />
                  {t("剩余备用恢复码：{n} 个", { n: remaining })}
                </span>
                {status?.enabledAt && (
                  <span>
                    {t("开启时间：{time}", {
                      time: status.enabledAt.slice(0, 10),
                    })}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!enabled && !setupData && (
            <Button
              type="button"
              size="sm"
              disabled={busy !== "" || statusQuery.isLoading}
              onClick={() => void handleStartSetup()}
              data-mfa-start-setup
            >
              {busy === "setup" ? t("正在生成密钥…") : t("开启二步验证")}
            </Button>
          )}
          {enabled && !disableOpen && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive"
              onClick={() => {
                setDisableOpen(true);
                setError("");
                setNotice("");
              }}
              data-mfa-open-disable
            >
              <ShieldOff size={14} />
              {t("关闭二步验证")}
            </Button>
          )}
        </div>
      </div>

      {statusQuery.isError && (
        <p role="alert" className="mt-3 text-[12px] text-destructive">
          {t("无法获取二步验证状态，请刷新页面重试。")}
        </p>
      )}
      {error && (
        <p
          role="alert"
          data-mfa-error
          className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-[12px] text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          data-mfa-notice
          className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/8 px-3 py-2 text-[12px] text-emerald-700 dark:text-emerald-300"
        >
          {notice}
        </p>
      )}

      {!enabled && setupData && (
        <div
          data-mfa-setup-panel
          className="mt-4 rounded-xl border border-border bg-hover/40 p-4"
        >
          <div className="grid gap-5 md:grid-cols-[auto_1fr]">
            <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-white p-3">
              <QRCodeSVG
                value={setupData.otpauthUri}
                size={148}
                level="M"
                marginSize={2}
                role="img"
                aria-label={t("身份验证器二维码")}
              />
              <span className="mt-2 text-[11px] text-neutral-500">
                {t("使用验证器 App 扫码绑定")}
              </span>
            </div>

            <div className="min-w-0 space-y-3.5">
              <div>
                <p className="text-[12px] font-medium text-foreground">
                  {t("1. 手动输入密钥（Base32）")}
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <code
                    data-mfa-secret-key
                    className="min-w-0 flex-1 break-all rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[13px] tracking-wider text-foreground"
                  >
                    {formatTotpSecret(setupData.secret)}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copyText(setupData.secret, "secret")}
                    data-mfa-copy-secret
                  >
                    {copiedKey === "secret" ? <Check size={14} /> : <Copy size={14} />}
                    {copiedKey === "secret" ? t("已复制") : t("复制")}
                  </Button>
                </div>
              </div>

              <div>
                <p className="text-[12px] font-medium text-foreground">
                  {t("2. 或复制 otpauth 配置链接")}
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <code
                    data-mfa-otpauth-uri
                    className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] text-muted-foreground"
                    title={setupData.otpauthUri}
                  >
                    {setupData.otpauthUri}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copyText(setupData.otpauthUri, "uri")}
                    data-mfa-copy-uri
                  >
                    {copiedKey === "uri" ? <Check size={14} /> : <Copy size={14} />}
                    {copiedKey === "uri" ? t("已复制") : t("复制链接")}
                  </Button>
                </div>
              </div>

              <form onSubmit={handleEnableSubmit} className="pt-1">
                <Label htmlFor="mfa-enable-code" className="text-[12px] font-medium">
                  {t("3. 输入验证器显示的 6 位动态码以完成启用")}
                </Label>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Input
                    id="mfa-enable-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                    className="h-9 w-44 font-mono text-center tracking-[0.2em]"
                    data-mfa-enable-code-input
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={busy !== "" || !verifyCode.trim()}
                    data-mfa-confirm-enable
                  >
                    {busy === "enable" ? t("验证中…") : t("验证并开启")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== ""}
                    onClick={() => {
                      setSetupData(null);
                      setVerifyCode("");
                      setError("");
                    }}
                  >
                    {t("取消")}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {recoveryCodes && recoveryCodes.length > 0 && (
        <div
          data-mfa-recovery-codes-panel
          className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/6 p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <h4 className="text-[13px] font-semibold text-foreground">
                  {t("一次性备用恢复码（仅展示一次）")}
                </h4>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {t("当无法访问身份验证器时，可使用任意一条恢复码登录。每条恢复码仅可使用一次，关闭后将不再显示。")}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copyText(recoveryCodes.join("\n"), "codes")}
              data-mfa-copy-all-recovery
            >
              {copiedKey === "codes" ? <Check size={14} /> : <Copy size={14} />}
              {copiedKey === "codes" ? t("已复制全部") : t("复制全部恢复码")}
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {recoveryCodes.map((code) => (
              <code
                key={code}
                data-mfa-recovery-code
                className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-center font-mono text-[13px] font-medium tracking-wider text-foreground"
              >
                {code}
              </code>
            ))}
          </div>

          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRecoveryCodes(null)}
              data-mfa-dismiss-recovery
            >
              {t("我已妥善保存")}
            </Button>
          </div>
        </div>
      )}

      {enabled && disableOpen && (
        <form
          onSubmit={handleDisableSubmit}
          data-mfa-disable-panel
          className="mt-4 rounded-xl border border-destructive/25 bg-destructive/4 p-4"
        >
          <h4 className="text-[13px] font-semibold text-foreground">
            {t("验证身份以关闭二步验证")}
          </h4>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t("关闭后登录将不再要求 6 位动态码，现有恢复码也会立即失效。")}
          </p>

          <div
            role="radiogroup"
            aria-label={t("验证方式")}
            className="mt-3 inline-flex rounded-lg bg-hover p-0.5 text-[12px]"
          >
            {(
              [
                ["password", t("使用当前密码")],
                ["code", t("使用动态码或恢复码")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={disableMethod === value}
                onClick={() => {
                  setDisableMethod(value);
                  setError("");
                }}
                data-mfa-disable-method={value}
                className={cn(
                  "h-7 rounded-md px-3 transition-colors",
                  disableMethod === value
                    ? "bg-surface font-medium text-primary shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {disableMethod === "password" ? (
              <Input
                type="password"
                autoComplete="current-password"
                placeholder={t("输入当前登录密码")}
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
                className="h-9 max-w-[260px]"
                data-mfa-disable-password-input
              />
            ) : (
              <Input
                type="text"
                autoComplete="one-time-code"
                placeholder={t("6 位动态码或恢复码")}
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                className="h-9 max-w-[260px] font-mono tracking-wider"
                data-mfa-disable-code-input
              />
            )}
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="border-destructive/40 bg-destructive text-white hover:bg-destructive/90 hover:text-white"
              disabled={
                busy !== "" ||
                (disableMethod === "password" ? !disablePassword : !disableCode.trim())
              }
              data-mfa-confirm-disable
            >
              {busy === "disable" ? t("关闭中…") : t("确认关闭")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== ""}
              onClick={() => {
                setDisableOpen(false);
                setDisablePassword("");
                setDisableCode("");
                setError("");
              }}
            >
              {t("取消")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
